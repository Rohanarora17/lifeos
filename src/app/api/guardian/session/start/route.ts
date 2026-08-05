import { NextResponse } from 'next/server';
import { parseLockInIntent } from '@/lib/intent-engine';
import { startGuardianSession, setImmediateBlockDomains, applyUserClassificationFeedback } from '@/lib/guardian-runtime';
import { getConflictingEvents, isCalendarConfigured } from '@/lib/google-calendar';
import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_PRO } from '@/lib/models';
import { getAdaptiveSessionMinuteDecision } from '@/lib/adaptive-command-defaults';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { VisionClientUnavailableError } from '@/lib/guardian-client-status';
import { lifeosDateKey } from '@/lib/timezone';

interface PlannedSessionStartMatch {
  id: string;
  title: string;
  durationMinutes: number;
  sessionType: string;
  ruleJson: string;
  plannedStart: string;
  rewardXp: number;
  rewardCoins: number;
}

function todayIst(): string {
  return lifeosDateKey();
}

function tokenScore(candidate: string, query: string): number {
  const queryTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3);
  if (queryTokens.length === 0) return 0;
  const candidateText = candidate.toLowerCase();
  return queryTokens.reduce((score, token) => score + (candidateText.includes(token) ? 1 : 0), 0);
}

function parseRulePreview(ruleJson: string): { guidance?: string; tools?: string[]; rewardReason?: string } {
  try {
    const parsed = JSON.parse(ruleJson);
    return typeof parsed === 'object' && parsed ? parsed as { guidance?: string; tools?: string[]; rewardReason?: string } : {};
  } catch {
    return {};
  }
}

function findPlannedSessionForStart(topic: string | undefined): PlannedSessionStartMatch | null {
  const cleanTopic = topic?.trim();
  if (!cleanTopic) return null;

  try {
    const rows = getDb().prepare(`
      SELECT
        pfs.id,
        pfs.title,
        pfs.duration_minutes as durationMinutes,
        pfs.session_type as sessionType,
        pfs.rule_json as ruleJson,
        pfs.planned_start as plannedStart,
        pfs.reward_xp as rewardXp,
        pfs.reward_coins as rewardCoins
      FROM planned_focus_sessions pfs
      JOIN daily_plans dp ON dp.id = pfs.plan_id
      WHERE dp.plan_date = ?
        AND pfs.status IN ('planned', 'started')
      ORDER BY ABS(strftime('%s', pfs.planned_start) - strftime('%s', 'now')) ASC
      LIMIT 12
    `).all(todayIst()) as PlannedSessionStartMatch[];

    return rows
      .map(row => ({ row, score: tokenScore(row.title, cleanTopic) }))
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.row ?? null;
  } catch {
    return null;
  }
}

function plannedSessionContext(match: PlannedSessionStartMatch): string {
  const rule = parseRulePreview(match.ruleJson);
  const pieces = [
    `Matched today's planned ${match.sessionType.replaceAll('_', ' ')} block.`,
    rule.guidance,
    rule.tools?.length ? `Tools expected: ${rule.tools.slice(0, 4).join(', ')}.` : null,
    `Planned reward: ${match.rewardXp} XP / ${match.rewardCoins} coins.`,
    rule.rewardReason,
  ].filter(Boolean);
  return pieces.join(' ');
}

/**
 * Derives which domains to immediately block for this session.
 * Reads from the user's actual activity history + domain_categories knowledge,
 * then asks AI to filter out any domain that serves the session goal.
 * Lives here (not in a separate module) because it's a session-start concern.
 */
async function resolveImmediateBlockDomains(targetTitle: string, goalTitle: string | null): Promise<{ blockDomains: string[]; onTopicDomains: string[] }> {
  const ai = getGenAI();

  try {
    const db = getDb();
    const candidates = new Set<string>();

    // User's personal distraction history (strongest signal)
    try {
      const rows = db.prepare(`
        SELECT domain FROM effective_activities
        WHERE category = 'distraction' AND started_at >= datetime('now', '-30 days')
        GROUP BY domain ORDER BY COUNT(*) DESC LIMIT 25
      `).all() as { domain: string }[];
      for (const r of rows) if (r.domain) candidates.add(r.domain);
    } catch { /* activities table may not exist yet */ }

    // Domain knowledge accumulated over time
    try {
      const rows = db.prepare(`
        SELECT domain FROM domain_categories
        WHERE category = 'distraction' AND confidence >= 0.7 LIMIT 25
      `).all() as { domain: string }[];
      for (const r of rows) if (r.domain) candidates.add(r.domain);
    } catch { /* ignore */ }

    // User-taught categorization rules
    let rulesContext = '';
    try {
      const rules = db.prepare(
        `SELECT content FROM behavioral_memory WHERE memory_type = 'categorization_rule' AND superseded = 0`
      ).all() as { content: string }[];
      if (rules.length) rulesContext = '\nUSER RULES (must be respected):\n' + rules.map(r => `- ${r.content}`).join('\n');
    } catch { /* ignore */ }

    const domainList = Array.from(candidates);

    // Context-sensitive domains that need session-aware classification (never blanket-block).
    const contextSensitive = 'youtube.com, youtu.be, vimeo.com, reddit.com, twitter.com, x.com, discord.com, slack.com, twitch.tv, linkedin.com, notion.so, figma.com';

    const prompt = domainList.length === 0
      ? `You are configuring a focus session blocker.
SESSION GOAL: "${targetTitle}"${goalTitle ? `\nGOAL: "${goalTitle}"` : ''}
${rulesContext}
Task 1: List up to 12 distraction website domains to block. Exclude any the user might legitimately need for this goal.
Task 2: From this list of context-sensitive domains, identify which are ON-TOPIC for this session goal: ${contextSensitive}
Respond ONLY with a JSON object (no markdown): {"blockDomains": ["domain1.com", ...], "onTopicDomains": ["youtube.com", ...]}`
      : `You are configuring a focus session blocker.
SESSION GOAL: "${targetTitle}"${goalTitle ? `\nGOAL: "${goalTitle}"` : ''}
${rulesContext}
Task 1: Filter these distraction domains — remove any that could legitimately support this goal (e.g. youtube.com when goal is "Watch lecture"):
CANDIDATE DOMAINS:
${domainList.map(d => `- ${d}`).join('\n')}
Task 2: From this list of context-sensitive domains, identify which are ON-TOPIC for this session goal: ${contextSensitive}
Respond ONLY with a JSON object (no markdown): {"blockDomains": [...filtered from candidates above...], "onTopicDomains": ["youtube.com", ...]}`;

    const result = await generateWithFallback(ai, { model: MODEL_PRO, contents: prompt });
    const text = (result.text ?? '').trim().replace(/```json\n?|\n?```/g, '');
    const parsed = JSON.parse(text) as { blockDomains?: unknown; onTopicDomains?: unknown };
    const blockArr = Array.isArray(parsed.blockDomains)
      ? (parsed.blockDomains as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const onTopicArr = Array.isArray(parsed.onTopicDomains)
      ? (parsed.onTopicDomains as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    // When filtering an existing list, only keep domains from the original candidates.
    const trusted = domainList.length === 0 ? blockArr : blockArr.filter(d => candidates.has(d));
    return { blockDomains: trusted.slice(0, 30), onTopicDomains: onTopicArr };
  } catch { /* non-fatal */ }

  return { blockDomains: [], onTopicDomains: [] };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const transcript = body.transcript as string | undefined;

    let startInput = {
      topic: body.topic as string | undefined,
      goalId: body.goalId as string | null | undefined,
      goalTitle: body.goalTitle as string | null | undefined,
      conceptNodeId: body.conceptNodeId as string | null | undefined,
      conceptNodeName: body.conceptNodeName as string | null | undefined,
      durationMinutes: body.durationMinutes as number | undefined,
      mood: body.mood as 'high' | 'medium' | 'low' | null | undefined,
      source: (body.source as 'voice' | 'dashboard' | 'extension' | 'api' | undefined) || 'api',
      sessionContext: body.sessionContext as string | undefined,
      startRequestId: body.startRequestId as string | undefined,
    };

    let parsedIntent: Awaited<ReturnType<typeof parseLockInIntent>> | null = null;
    if (transcript) {
      parsedIntent = await parseLockInIntent(transcript);
      if (parsedIntent?.clarificationNeeded && !parsedIntent?.parameters?.topic) {
        return NextResponse.json({ success: true, clarification: parsedIntent.clarificationNeeded });
      }

      startInput = {
        ...startInput,
        topic: startInput.topic || parsedIntent?.parameters?.topic,
        durationMinutes: startInput.durationMinutes || parsedIntent?.parameters?.durationMinutes,
        mood: startInput.mood || parsedIntent?.parameters?.mood || null,
        source: 'voice',
        sessionContext: startInput.sessionContext || transcript, // full utterance carries nuance
      };
    }

    const durationWasExplicit = body.durationMinutes !== undefined || parsedIntent?.parameters?.durationMinutes !== undefined;
    const plannedMatch = durationWasExplicit ? null : findPlannedSessionForStart(startInput.topic);
    if (plannedMatch) {
      startInput = {
        ...startInput,
        topic: startInput.topic || plannedMatch.title,
        durationMinutes: plannedMatch.durationMinutes,
        sessionContext: [
          startInput.sessionContext,
          plannedSessionContext(plannedMatch),
        ].filter(Boolean).join('\n\n'),
      };
    }

    const startSnapshot = buildPersonalizationSnapshot({
      surface: 'intervention',
      maxInsights: 2,
      includeThresholds: true,
      includeMemoryFacts: 3,
    });
    const durationDecision = getAdaptiveSessionMinuteDecision(startInput.durationMinutes, startSnapshot);

    // Calendar conflict check
    let calendarWarning: string | null = null;
    let calendarConflicts: Array<{ title: string; start: string; end: string }> = [];
    if (isCalendarConfigured()) {
      try {
        const sessionStart = new Date();
        const sessionEnd = new Date(sessionStart.getTime() + durationDecision.minutes * 60_000);
        const conflicts = await getConflictingEvents(sessionStart, sessionEnd);
        if (conflicts.length > 0) {
          calendarConflicts = conflicts;
          const t = new Date(conflicts[0].start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          calendarWarning = `Calendar conflict: "${conflicts[0].title}" starts at ${t}. ${durationDecision.reason}. Consider a shorter sprint.`;
        }
      } catch { /* non-fatal */ }
    }

    const session = startGuardianSession(startInput);

    if (plannedMatch) {
      try {
        getDb().prepare(`
          UPDATE planned_focus_sessions
          SET status = 'started', updated_at = datetime('now', 'localtime')
          WHERE id = ? AND status = 'planned'
        `).run(plannedMatch.id);
      } catch { /* planned session status is best-effort */ }
    }

    // Compute AI-derived block list — bounded to 2.5s so session start stays fast.
    // Extension uses this for instant local blocking before the first server round-trip.
    let immediateBlockDomains: string[] = [];
    try {
      const resolved = await Promise.race([
        resolveImmediateBlockDomains(session.targetTitle, session.goalTitle ?? null),
        new Promise<{ blockDomains: string[]; onTopicDomains: string[] }>((resolve) =>
          setTimeout(() => resolve({ blockDomains: [], onTopicDomains: [] }), 2500)
        ),
      ]);
      immediateBlockDomains = resolved.blockDomains;
      setImmediateBlockDomains(session.sessionId, immediateBlockDomains);
      // Pre-seed session classification cache so the first tab event to a context-sensitive
      // domain (e.g. YouTube during a lecture session) scores correctly without waiting for
      // the per-event async AI classification.
      for (const domain of resolved.onTopicDomains) {
        applyUserClassificationFeedback(domain, 'on_topic');
      }
    } catch { /* non-fatal */ }

    return NextResponse.json({
      success: true,
      session: { ...session, immediateBlockDomains },
      parsedIntent,
      calendarWarning,
      calendarConflicts,
      plannedSession: plannedMatch ? {
        id: plannedMatch.id,
        title: plannedMatch.title,
        durationMinutes: plannedMatch.durationMinutes,
        sessionType: plannedMatch.sessionType,
      } : null,
    });
  } catch (error) {
    if (error instanceof VisionClientUnavailableError) {
      return NextResponse.json({
        error: error.code,
        message: error.message,
        clientStatus: error.readiness,
        recovery: {
          wakeSupported: error.readiness.wakeSupported,
          retryAfterMs: 1_000,
          timeoutMs: 20_000,
        },
      }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
