/**
 * LifeOS Memory Extractor — Phase 2
 *
 * LLM-powered extraction layer that reads events and writes to the 4-tier memory.
 * Implements Mem0-style ADD / UPDATE / DELETE / NOOP reconciliation.
 *
 * Triggers:
 *   Session end     → extractMemoryFromSession()
 *   Every 5 voice turns → extractMemoryFromVoice()
 *   Nightly cron    → consolidateFacts()
 */

import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import {
  insertFact,
  updateFact,
  supersedeFact,
  findFactsByTopic,
  insertEpisode,
  queryRelevantFacts,
  searchFactsByText,
  purgeStaleUnverifiedFacts,
  storeEmbedding,
  FactCategory,
  ScoredFact,
} from './memory';
import { getIntelligenceProfile } from './intelligence';
import { getDb } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemoryOp {
  operation: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  category: FactCategory;
  topic: string;
  content: string;
  confidence: number;
  importance: number;
  existingFactId?: number | null;
  reasoning: string;
}

// ─── LLM Extraction ──────────────────────────────────────────────────────────

async function runLLMExtraction(contextText: string, source: string, topicQuery?: string): Promise<MemoryOp[]> {
  const ai = getGenAI();
  if (!ai) return [];

  // Top-scored active facts — always included as baseline
  let existingFacts: ScoredFact[] = queryRelevantFacts({ status: 'active', limit: 25 });

  // Topic-aware FTS5 retrieval: surface facts relevant to the current topic
  // even if they're not in the top-25 by score (e.g. older but contextually relevant)
  if (topicQuery) {
    const topicFacts = searchFactsByText(topicQuery, 15);
    const seen = new Set(existingFacts.map(f => f.id));
    for (const f of topicFacts) {
      if (!seen.has(f.id)) {
        existingFacts.push(f);
        seen.add(f.id);
      }
    }
    existingFacts = existingFacts.slice(0, 40);
  }

  const existingContext = existingFacts.length > 0
    ? existingFacts.map(f => `[ID:${f.id}] [${f.category}/${f.topic}] ${f.content} (conf:${f.confidence.toFixed(2)})`).join('\n')
    : 'No existing facts yet.';

  // Inject UIL narrative so extraction understands current user state and can judge relevance
  const profile = getIntelligenceProfile();
  const narrativeBlock = profile.currentNarrative
    ? `\nCURRENT USER STATE: ${profile.currentNarrative}`
    : '';

  const prompt = `You are a memory extraction engine for a personal AI guardian. Extract semantic facts and reconcile them with existing memory.${narrativeBlock}

EXISTING MEMORY:
${existingContext}

NEW CONTEXT (source: ${source}):
${contextText}

Extract all meaningful, durable facts about the user. For each fact decide:
- ADD: new information not already in memory
- UPDATE: existing fact should be revised (provide existingFactId)
- DELETE: existing fact is clearly wrong/outdated (provide existingFactId)
- NOOP: already captured correctly, skip

Categories: preference | pattern | habit | identity | goal | mood | constraint

Importance guide:
  identity / goal facts → 0.8–1.0
  patterns / constraints → 0.6–0.8
  preferences / habits → 0.4–0.6
  mood (transient) → 0.1–0.3

Only extract facts that are:
1. Specific and actionable, not vague
2. Likely to be useful in future sessions
3. About the user's behavior, preferences, energy, or goals

Return ONLY a JSON array, no markdown:
[{
  "operation": "ADD|UPDATE|DELETE|NOOP",
  "category": "preference|pattern|habit|identity|goal|mood|constraint",
  "topic": "snake_case_topic_key",
  "content": "specific factual statement about the user",
  "confidence": 0.5,
  "importance": 0.5,
  "existingFactId": null,
  "reasoning": "one-line reason for this operation"
}]`;

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const text = (result.text || '').trim();
    const ops = JSON.parse(text) as MemoryOp[];
    return Array.isArray(ops) ? ops : [];
  } catch (err) {
    console.error('[MemoryExtractor] LLM extraction failed:', err);
    return [];
  }
}

// ─── Apply Operations ─────────────────────────────────────────────────────────

async function applyOps(ops: MemoryOp[], episodeId: number): Promise<number> {
  let applied = 0;
  for (const op of ops) {
    try {
      if (op.operation === 'ADD') {
        const newId = insertFact({
          category: op.category,
          topic: op.topic,
          content: op.content,
          confidence: Math.min(1, Math.max(0, op.confidence)),
          importance: Math.min(1, Math.max(0, op.importance)),
          source: 'extracted',
          sourceEpisodeIds: [episodeId],
          // High-confidence facts (≥0.8) activate immediately; others need a second sighting
          status: op.confidence >= 0.8 ? 'active' : 'unverified',
        });
        // Fire-and-forget embedding generation
        generateAndStoreEmbedding(newId, `${op.topic}: ${op.content}`).catch(() => {});
        applied++;
      } else if (op.operation === 'UPDATE' && op.existingFactId) {
        updateFact(op.existingFactId, {
          content: op.content,
          confidence: Math.min(1, Math.max(0, op.confidence)),
          importance: Math.min(1, Math.max(0, op.importance)),
          mergeEpisodeIds: [episodeId],
          status: 'active',
        });
        applied++;
      } else if (op.operation === 'DELETE' && op.existingFactId) {
        supersedeFact(op.existingFactId, op.content, [episodeId]);
        applied++;
      }
    } catch (err) {
      console.error('[MemoryExtractor] Failed op:', op.operation, op.topic, err);
    }
  }
  return applied;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract memory from a completed guardian session.
 * Called at session end after reflection is persisted.
 */
export async function extractMemoryFromSession(session: {
  sessionId: string;
  topic: string;
  durationMinutes: number;
  focusScore: number;
  domains: string[];
  interventions: number;
  overrides: number;
  reflection?: string | null;
  mood?: string | null;
  startedAt: string;
  endedAt: string;
}): Promise<void> {
  const contextLines = [
    `Guardian session: "${session.topic}"`,
    `Duration: ${session.durationMinutes} min, Focus score: ${session.focusScore}/100`,
    session.mood ? `Mood at start: ${session.mood}` : null,
    `Domains visited: ${session.domains.slice(0, 6).join(', ')}`,
    `Interventions: ${session.interventions}, Override requests: ${session.overrides}`,
    session.reflection ? `Post-session reflection: ${session.reflection}` : null,
  ].filter(Boolean).join('\n');

  const episodeId = insertEpisode(
    'guardian',
    `${session.durationMinutes}min session on "${session.topic}" — focus ${session.focusScore}`,
    {
      rawContext: {
        sessionId: session.sessionId,
        focusScore: session.focusScore,
        durationMinutes: session.durationMinutes,
        interventions: session.interventions,
        overrides: session.overrides,
      },
      importance: Math.min(1, session.focusScore / 100 * 0.7 + 0.3),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    }
  );

  try {
    const ops = await runLLMExtraction(contextLines, 'guardian_session', session.topic);
    const applied = await applyOps(ops, episodeId);
    console.log(`[MemoryExtractor] Session ${session.sessionId}: ${applied}/${ops.length} ops applied`);
  } catch (err) {
    console.error('[MemoryExtractor] Session extraction error:', err);
  }
}

/**
 * Extract memory from recent voice conversation turns.
 * Called every 5 user turns during a session.
 */
export async function extractMemoryFromVoice(
  turns: { role: string; text: string }[],
  sessionId: string
): Promise<void> {
  if (turns.length < 3) return;

  const contextLines = turns
    .slice(-20)
    .map(t => `${t.role === 'user' ? 'User' : 'Guardian'}: ${t.text}`)
    .join('\n');

  const episodeId = insertEpisode(
    'voice',
    `Voice conversation (${turns.length} turns)`,
    {
      rawContext: { sessionId, turnCount: turns.length },
      importance: 0.5,
    }
  );

  // Use last user message as FTS query to surface topic-relevant existing facts
  const lastUserTurn = [...turns].reverse().find(t => t.role === 'user');
  const topicQuery = lastUserTurn ? lastUserTurn.text.slice(0, 80) : undefined;

  try {
    const ops = await runLLMExtraction(contextLines, 'voice_conversation', topicQuery);
    const applied = await applyOps(ops, episodeId);
    console.log(`[MemoryExtractor] Voice ${sessionId}: ${applied}/${ops.length} ops applied`);
  } catch (err) {
    console.error('[MemoryExtractor] Voice extraction error:', err);
  }
}

/**
 * Nightly consolidation: merge duplicate facts, purge stale unverified.
 */
export async function consolidateFacts(): Promise<void> {
  const db = getDb();

  // Find topic groups with multiple active facts
  const duplicates = db.prepare(`
    SELECT category, topic, COUNT(*) as cnt
    FROM mem_facts
    WHERE status = 'active'
    GROUP BY category, topic
    HAVING cnt > 1
  `).all() as { category: string; topic: string; cnt: number }[];

  let merged = 0;
  for (const dup of duplicates.slice(0, 30)) {
    const facts = findFactsByTopic(dup.category as FactCategory, dup.topic);
    if (facts.length < 2) continue;

    // Keep highest effective-score fact, supersede the rest
    const sorted = [...facts].sort((a, b) => b.effectiveScore - a.effectiveScore);
    const [best, ...rest] = sorted;
    for (const old of rest) {
      if (old.id !== best.id) {
        supersedeFact(old.id, best.content);
        merged++;
      }
    }
  }

  const purged = purgeStaleUnverifiedFacts(14);
  console.log(`[MemoryExtractor] Consolidation: merged ${merged}, purged ${purged}`);
}

// ─── Embedding Generation (background, non-blocking) ─────────────────────────

/**
 * Generate a Gemini text-embedding-004 vector for a fact and persist it.
 * Runs in the background — failures are silently ignored.
 */
export async function generateAndStoreEmbedding(factId: number, text: string): Promise<void> {
  const ai = getGenAI();
  if (!ai) return;

  try {
    const result = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: text,
    });
    const vector = result.embeddings?.[0]?.values;
    if (vector && vector.length > 0) {
      storeEmbedding(factId, vector);
    }
  } catch {
    // Embedding failure is non-fatal — fact is still useful without it
  }
}
