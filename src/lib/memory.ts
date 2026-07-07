/**
 * LifeOS Memory Layer — Core Engine
 * 
 * 4-tier memory architecture:
 *   Working  → in-process state + mem_working snapshots
 *   Episodic → mem_episodes (structured event log)
 *   Semantic → mem_facts   (distilled facts with decay scoring)
 *   Procedural → mem_procedures (coaching macros)
 * 
 * No LLM calls in this module — pure data layer.
 * LLM-powered extraction lives in memory-extractor.ts (Phase 2).
 */

import { getDb } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EpisodeSource = 'guardian' | 'voice' | 'chat' | 'browse' | 'manual' | 'native_copilot';

export interface MemEpisode {
    id: number;
    source: EpisodeSource;
    summary: string;
    raw_context: string | null;
    importance: number;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
}

export type FactCategory = 'preference' | 'pattern' | 'habit' | 'identity' | 'goal' | 'mood' | 'constraint';
export type FactStatus = 'active' | 'unverified' | 'superseded';

export interface MemFact {
    id: number;
    category: FactCategory;
    topic: string;
    content: string;
    confidence: number;
    importance: number;
    status: FactStatus;
    half_life_days: number;
    source: string;
    source_episode_ids: string; // JSON array
    confirmed_count: number;
    last_confirmed: string;
    last_accessed: string;
    access_count: number;
    superseded_by: number | null;
    created_at: string;
}

export interface ScoredFact extends MemFact {
    effectiveScore: number;
}

export type ProcedureStatus = 'pending' | 'active' | 'archived';

export interface MemProcedure {
    id: number;
    name: string;
    trigger_pattern: string; // JSON
    action_template: string; // JSON
    status: ProcedureStatus;
    version: number;
    superseded_by: number | null;
    success_count: number;
    failure_count: number;
    last_used: string | null;
    created_at: string;
}

export type CognitiveState = 'IDLE' | 'FOCUSED' | 'DISTRACTED' | 'OVERLOADED' | 'RECOVERY';

export interface WorkingMemorySnapshot {
    sessionId: string | null;
    cognitiveState: CognitiveState;
    focusScore: number;
    cognitiveLoad: number;
    activeFactIds: number[];
    timestamp: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default half-life by category (days) */
const CATEGORY_HALF_LIFE: Record<FactCategory, number> = {
    mood: 1,         // volatile — decays in hours/days
    pattern: 7,      // session-level patterns — weekly refresh
    preference: 30,  // preferences drift slowly
    habit: 60,       // habits are semi-stable
    constraint: 90,  // constraints change rarely
    goal: 365,       // goals are long-lived
    identity: 3650,  // near-infinite — identity is durable
};

// ─── Episodic Memory ──────────────────────────────────────────────────────────

/**
 * Insert a new episode into episodic memory.
 */
export function insertEpisode(
    source: EpisodeSource,
    summary: string,
    opts?: {
        rawContext?: Record<string, unknown>;
        importance?: number;
        startedAt?: string;
        endedAt?: string;
    }
): number {
    const db = getDb();
    const result = db.prepare(`
    INSERT INTO mem_episodes (source, summary, raw_context, importance, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
        source,
        summary,
        opts?.rawContext ? JSON.stringify(opts.rawContext) : null,
        opts?.importance ?? 0.5,
        opts?.startedAt ?? null,
        opts?.endedAt ?? null,
    );
    return Number(result.lastInsertRowid);
}

/**
 * Query recent episodes, optionally filtered by source.
 */
export function queryRecentEpisodes(opts?: {
    source?: EpisodeSource;
    hours?: number;
    limit?: number;
}): MemEpisode[] {
    const db = getDb();
    const hours = opts?.hours ?? 24;
    const limit = opts?.limit ?? 20;

    if (opts?.source) {
        return db.prepare(`
      SELECT * FROM mem_episodes
      WHERE source = ? AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(opts.source, `-${hours} hours`, limit) as MemEpisode[];
    }

    return db.prepare(`
    SELECT * FROM mem_episodes
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(`-${hours} hours`, limit) as MemEpisode[];
}

/**
 * Get episodes by IDs (for source auditing).
 */
export function getEpisodesByIds(ids: number[]): MemEpisode[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(
        `SELECT * FROM mem_episodes WHERE id IN (${placeholders}) ORDER BY created_at DESC`
    ).all(...ids) as MemEpisode[];
}

// ─── Semantic Memory (Facts) ──────────────────────────────────────────────────

/**
 * Compute the effective score of a fact using temporal decay + access frequency.
 * 
 * Formula: importance × e^(-ageDays / halfLifeDays) + 0.3 × log(1 + accessCount)
 * Pinned identity facts get near-zero decay due to high half_life_days.
 */
function computeEffectiveScore(fact: MemFact): number {
    const now = Date.now();
    const lastConfirmed = new Date(fact.last_confirmed).getTime();
    const ageDays = (now - lastConfirmed) / (1000 * 60 * 60 * 24);
    const halfLife = fact.half_life_days || CATEGORY_HALF_LIFE[fact.category] || 14;

    const decayMultiplier = Math.exp(-ageDays / halfLife);
    const frequencyBoost = 0.3 * Math.log(1 + fact.access_count);

    return fact.importance * decayMultiplier + frequencyBoost;
}

/**
 * Insert a new semantic fact. Defaults to 'unverified' status.
 * Returns the new fact ID.
 */
export function insertFact(opts: {
    category: FactCategory;
    topic: string;
    content: string;
    confidence?: number;
    importance?: number;
    source?: string;
    sourceEpisodeIds?: number[];
    status?: FactStatus;
}): number {
    const db = getDb();
    const halfLife = CATEGORY_HALF_LIFE[opts.category] || 14;

    const result = db.prepare(`
    INSERT INTO mem_facts (category, topic, content, confidence, importance, status,
      half_life_days, source, source_episode_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        opts.category,
        opts.topic,
        opts.content,
        opts.confidence ?? 0.7,
        opts.importance ?? 0.5,
        opts.status ?? 'unverified',
        halfLife,
        opts.source ?? 'inferred',
        JSON.stringify(opts.sourceEpisodeIds ?? []),
    );
    return Number(result.lastInsertRowid);
}

/**
 * Update an existing fact's content and merge source episodes.
 * Used for Mem0-style UPDATE operations.
 */
export function updateFact(
    id: number,
    updates: {
        content?: string;
        confidence?: number;
        importance?: number;
        mergeEpisodeIds?: number[];
        status?: FactStatus;
    }
): void {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM mem_facts WHERE id = ?').get(id) as MemFact | undefined;
    if (!existing) return;

    // Merge episode IDs
    let episodeIds: number[] = [];
    try { episodeIds = JSON.parse(existing.source_episode_ids); } catch { }
    if (updates.mergeEpisodeIds) {
        const merged = new Set([...episodeIds, ...updates.mergeEpisodeIds]);
        episodeIds = [...merged];
    }

    db.prepare(`
    UPDATE mem_facts SET
      content = COALESCE(?, content),
      confidence = COALESCE(?, confidence),
      importance = COALESCE(?, importance),
      status = COALESCE(?, status),
      source_episode_ids = ?,
      confirmed_count = confirmed_count + 1,
      last_confirmed = datetime('now')
    WHERE id = ?
  `).run(
        updates.content ?? null,
        updates.confidence ?? null,
        updates.importance ?? null,
        updates.status ?? null,
        JSON.stringify(episodeIds),
        id,
    );

    // Auto-promote: unverified facts seen ≥2 times graduate to active without manual review
    const updated = db.prepare('SELECT confirmed_count, status FROM mem_facts WHERE id = ?').get(id) as { confirmed_count: number; status: string } | undefined;
    if (updated && updated.status === 'unverified' && updated.confirmed_count >= 2) {
        db.prepare("UPDATE mem_facts SET status = 'active' WHERE id = ?").run(id);
    }
}

/**
 * Supersede a fact (mark old as superseded, insert new version).
 * Used for Mem0-style DELETE (contradiction) operations.
 */
export function supersedeFact(oldId: number, newContent: string, newEpisodeIds?: number[]): number {
    const db = getDb();
    const old = db.prepare('SELECT * FROM mem_facts WHERE id = ?').get(oldId) as MemFact | undefined;
    if (!old) return -1;

    // Insert replacement
    const newId = insertFact({
        category: old.category as FactCategory,
        topic: old.topic,
        content: newContent,
        confidence: old.confidence,
        importance: old.importance,
        source: old.source,
        sourceEpisodeIds: newEpisodeIds,
        status: 'unverified',
    });

    // Mark old as superseded
    db.prepare(`
    UPDATE mem_facts SET status = 'superseded', superseded_by = ? WHERE id = ?
  `).run(newId, oldId);

    return newId;
}

/**
 * Query semantic facts with temporal decay scoring.
 * Returns facts ordered by effectiveScore descending.
 */
export function queryRelevantFacts(opts?: {
    category?: FactCategory;
    status?: FactStatus;
    limit?: number;
    minScore?: number;
}): ScoredFact[] {
    const db = getDb();
    const status = opts?.status ?? 'active';
    const limit = opts?.limit ?? 20;

    let rows: MemFact[];
    if (opts?.category) {
        rows = db.prepare(`
      SELECT * FROM mem_facts WHERE status = ? AND category = ?
      ORDER BY importance DESC LIMIT ?
    `).all(status, opts.category, limit * 2) as MemFact[];
    } else {
        rows = db.prepare(`
      SELECT * FROM mem_facts WHERE status = ?
      ORDER BY importance DESC LIMIT ?
    `).all(status, limit * 2) as MemFact[];
    }

    // Score and sort
    const scored: ScoredFact[] = rows.map(f => ({
        ...f,
        effectiveScore: computeEffectiveScore(f),
    }));

    scored.sort((a, b) => b.effectiveScore - a.effectiveScore);

    // Touch access_count for returned facts
    const topFacts = scored.slice(0, limit).filter(f => f.effectiveScore >= (opts?.minScore ?? 0));
    if (topFacts.length > 0) {
        const ids = topFacts.map(f => f.id);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`
      UPDATE mem_facts SET access_count = access_count + 1, last_accessed = datetime('now')
      WHERE id IN (${placeholders})
    `).run(...ids);
    }

    return topFacts;
}

/**
 * Get all facts (for Memory Inspector UI), no side-effects.
 */
export function getAllFacts(opts?: { includeSuperseded?: boolean }): ScoredFact[] {
    const db = getDb();
    const rows = opts?.includeSuperseded
        ? db.prepare('SELECT * FROM mem_facts ORDER BY created_at DESC').all() as MemFact[]
        : db.prepare("SELECT * FROM mem_facts WHERE status != 'superseded' ORDER BY created_at DESC").all() as MemFact[];

    return rows.map(f => ({
        ...f,
        effectiveScore: computeEffectiveScore(f),
    }));
}

/**
 * Delete a fact permanently (right-to-be-forgotten).
 */
export function deleteFact(id: number): void {
    getDb().prepare('DELETE FROM mem_facts WHERE id = ?').run(id);
}

/**
 * Find facts by category + topic (for conflict resolution in Phase 2).
 */
export function findFactsByTopic(category: FactCategory, topic: string): ScoredFact[] {
    const db = getDb();
    const rows = db.prepare(`
    SELECT * FROM mem_facts
    WHERE category = ? AND topic = ? AND status != 'superseded'
    ORDER BY importance DESC LIMIT 10
  `).all(category, topic) as MemFact[];

    return rows.map(f => ({
        ...f,
        effectiveScore: computeEffectiveScore(f),
    }));
}

// ─── Procedural Memory ────────────────────────────────────────────────────────

/**
 * Insert a new coaching procedure.
 */
export function insertProcedure(opts: {
    name: string;
    triggerPattern: Record<string, unknown>;
    actionTemplate: Record<string, unknown>;
}): number {
    const db = getDb();
    const result = db.prepare(`
    INSERT INTO mem_procedures (name, trigger_pattern, action_template)
    VALUES (?, ?, ?)
  `).run(
        opts.name,
        JSON.stringify(opts.triggerPattern),
        JSON.stringify(opts.actionTemplate),
    );
    return Number(result.lastInsertRowid);
}

/**
 * Record the outcome of a procedure invocation.
 * Graduates pending → active after 2+ successes.
 */
export function recordProcedureOutcome(id: number, success: boolean): void {
    const db = getDb();

    if (success) {
        db.prepare(`
      UPDATE mem_procedures SET
        success_count = success_count + 1,
        last_used = datetime('now')
      WHERE id = ?
    `).run(id);
    } else {
        db.prepare(`
      UPDATE mem_procedures SET
        failure_count = failure_count + 1,
        last_used = datetime('now')
      WHERE id = ?
    `).run(id);
    }

    // Graduate pending → active after ≥2 successes
    const proc = db.prepare('SELECT * FROM mem_procedures WHERE id = ?').get(id) as MemProcedure | undefined;
    if (proc && proc.status === 'pending' && proc.success_count >= 2) {
        db.prepare("UPDATE mem_procedures SET status = 'active' WHERE id = ?").run(id);
    }
}

/**
 * Get active procedures (for injection into agent context).
 */
export function getActiveProcedures(): MemProcedure[] {
    return getDb().prepare(`
    SELECT * FROM mem_procedures WHERE status = 'active'
    ORDER BY success_count DESC
  `).all() as MemProcedure[];
}

/**
 * Get all procedures (for Memory Inspector UI).
 */
export function getAllProcedures(): MemProcedure[] {
    return getDb().prepare(`
    SELECT * FROM mem_procedures WHERE status != 'archived'
    ORDER BY created_at DESC
  `).all() as MemProcedure[];
}

/**
 * Get procedure success rate over the last N uses.
 */
export function getProcedureSuccessRate(id: number): number {
    const proc = getDb().prepare('SELECT * FROM mem_procedures WHERE id = ?').get(id) as MemProcedure | undefined;
    if (!proc) return 0;
    const total = proc.success_count + proc.failure_count;
    if (total === 0) return 0;
    return proc.success_count / total;
}

// ─── Working Memory ───────────────────────────────────────────────────────────

/** In-process working memory state (not persisted until snapshot) */
let _workingMemory: WorkingMemorySnapshot = {
    sessionId: null,
    cognitiveState: 'IDLE',
    focusScore: 100,
    cognitiveLoad: 0,
    activeFactIds: [],
    timestamp: Date.now(),
};

/**
 * Get current working memory state.
 */
export function getWorkingMemory(): WorkingMemorySnapshot {
    return { ..._workingMemory };
}

/**
 * Update working memory (called on each guardian tick).
 */
export function updateWorkingMemory(updates: Partial<WorkingMemorySnapshot>): void {
    _workingMemory = {
        ..._workingMemory,
        ...updates,
        timestamp: Date.now(),
    };
}

/**
 * Persist a working memory snapshot to DB (audit trail).
 */
export function snapshotWorkingMemory(): void {
    const db = getDb();
    const wm = _workingMemory;
    db.prepare(`
    INSERT INTO mem_working (session_id, cognitive_state, focus_score, cognitive_load, active_facts)
    VALUES (?, ?, ?, ?, ?)
  `).run(
        wm.sessionId,
        wm.cognitiveState,
        wm.focusScore,
        wm.cognitiveLoad,
        JSON.stringify(wm.activeFactIds),
    );
}

/**
 * Reset working memory (on session end).
 */
export function resetWorkingMemory(): void {
    _workingMemory = {
        sessionId: null,
        cognitiveState: 'IDLE',
        focusScore: 100,
        cognitiveLoad: 0,
        activeFactIds: [],
        timestamp: Date.now(),
    };
}

// ─── Memory Summary (for LLM context injection) ──────────────────────────────

/**
 * Build a compact memory context string for injection into LLM prompts.
 * Returns the top-N active semantic facts formatted for the system prompt.
 */
export function getMemoryContext(maxFacts: number = 8): string {
    const facts = queryRelevantFacts({ status: 'active', limit: maxFacts });
    if (facts.length === 0) return '';

    const lines: string[] = ['[User Memory — Semantic Facts]'];
    for (const f of facts) {
        lines.push(`• [${f.category}/${f.topic}] ${f.content} (confidence: ${f.confidence.toFixed(2)}, score: ${f.effectiveScore.toFixed(2)})`);
    }

    const procedures = getActiveProcedures();
    if (procedures.length > 0) {
        lines.push('');
        lines.push('[Active Coaching Procedures]');
        for (const p of procedures.slice(0, 5)) {
            const rate = (p.success_count / Math.max(1, p.success_count + p.failure_count) * 100).toFixed(0);
            lines.push(`• ${p.name}: ${rate}% success rate (${p.success_count + p.failure_count} uses)`);
        }
    }

    return lines.join('\n');
}

// ─── Embedding Storage & Semantic Search ─────────────────────────────────────

/**
 * Persist an embedding vector for a fact (called after background generation).
 */
export function storeEmbedding(factId: number, vector: number[]): void {
  getDb().prepare('UPDATE mem_facts SET embedding = ? WHERE id = ?')
    .run(JSON.stringify(vector), factId);
}

/**
 * Full-text search over mem_facts using SQLite FTS5.
 * Fast for any table size. Falls through to score-ordered query if FTS5 unavailable.
 */
export function searchFactsByText(query: string, limit: number = 10): ScoredFact[] {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT f.* FROM mem_facts f
      JOIN mem_facts_fts fts ON f.id = fts.rowid
      WHERE mem_facts_fts MATCH ? AND f.status != 'superseded'
      ORDER BY bm25(mem_facts_fts)
      LIMIT ?
    `).all(query, limit) as MemFact[];

    return rows.map(f => ({ ...f, effectiveScore: computeEffectiveScore(f) }));
  } catch {
    // FTS5 not available or query syntax error — fall back to importance order
    return queryRelevantFacts({ limit });
  }
}

/**
 * Cosine-similarity search over mem_facts using stored embeddings.
 * Used when mem_facts has >5 000 entries and FTS ranking isn't enough.
 * Falls back to searchFactsByText if embeddings aren't present.
 */
export function semanticSearchFacts(queryVector: number[], limit: number = 10): ScoredFact[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM mem_facts WHERE status != 'superseded' AND embedding IS NOT NULL"
  ).all() as (MemFact & { embedding: string })[];

  if (rows.length === 0) return queryRelevantFacts({ limit });

  // Compute cosine similarity in-process
  const qNorm = Math.sqrt(queryVector.reduce((s, v) => s + v * v, 0));

  const scored = rows.map(row => {
    let vec: number[];
    try { vec = JSON.parse(row.embedding); } catch { return null; }

    let dot = 0;
    let dNorm = 0;
    for (let i = 0; i < queryVector.length && i < vec.length; i++) {
      dot += queryVector[i] * vec[i];
      dNorm += vec[i] * vec[i];
    }
    const similarity = qNorm > 0 && dNorm > 0 ? dot / (qNorm * Math.sqrt(dNorm)) : 0;
    return { ...row, effectiveScore: similarity } as ScoredFact;
  }).filter(Boolean) as ScoredFact[];

  scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
  return scored.slice(0, limit);
}

/**
 * Return total count of non-superseded facts — used to decide
 * whether to use FTS5 or semantic (embedding) search.
 */
export function getFactCount(): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM mem_facts WHERE status != 'superseded'"
  ).get() as { cnt: number };
  return row.cnt;
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Purge unverified facts older than 14 days (confidence decay).
 * Called during nightly consolidation.
 */
export function purgeStaleUnverifiedFacts(maxAgeDays: number = 14): number {
    const result = getDb().prepare(`
    DELETE FROM mem_facts
    WHERE status = 'unverified' AND created_at < datetime('now', ?)
  `).run(`-${maxAgeDays} days`);
    return result.changes;
}

/**
 * Get memory layer stats (for dashboard).
 */
export function getMemoryStats(): {
    episodes: number;
    activeFacts: number;
    unverifiedFacts: number;
    activeProcedures: number;
    workingSnapshots: number;
} {
    const db = getDb();
    const episodes = (db.prepare('SELECT COUNT(*) as cnt FROM mem_episodes').get() as { cnt: number }).cnt;
    const activeFacts = (db.prepare("SELECT COUNT(*) as cnt FROM mem_facts WHERE status = 'active'").get() as { cnt: number }).cnt;
    const unverifiedFacts = (db.prepare("SELECT COUNT(*) as cnt FROM mem_facts WHERE status = 'unverified'").get() as { cnt: number }).cnt;
    const activeProcedures = (db.prepare("SELECT COUNT(*) as cnt FROM mem_procedures WHERE status = 'active'").get() as { cnt: number }).cnt;
    const workingSnapshots = (db.prepare('SELECT COUNT(*) as cnt FROM mem_working').get() as { cnt: number }).cnt;

    return { episodes, activeFacts, unverifiedFacts, activeProcedures, workingSnapshots };
}
