import { NextResponse } from 'next/server';
import { parseLockInIntent } from '@/lib/intent-engine';
import { startGuardianSession, setImmediateBlockDomains, applyUserClassificationFeedback } from '@/lib/guardian-runtime';
import { getConflictingEvents, isCalendarConfigured } from '@/lib/google-calendar';
import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_FLASH } from '@/lib/models';

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
        SELECT domain FROM activities
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

    const result = await generateWithFallback(ai, { model: MODEL_FLASH, contents: prompt });
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
    };

    let parsedIntent: any = null;
    if (transcript) {
      parsedIntent = await parseLockInIntent(transcript);
      if (parsedIntent?.clarificationNeeded && !parsedIntent?.parameters?.topic) {
        return NextResponse.json({ success: true, clarification: parsedIntent.clarificationNeeded });
      }

      startInput = {
        ...startInput,
        topic: startInput.topic || parsedIntent?.parameters?.topic,
        durationMinutes: startInput.durationMinutes || parsedIntent?.parameters?.durationMinutes || 60,
        mood: startInput.mood || parsedIntent?.parameters?.mood || null,
        source: 'voice',
        sessionContext: startInput.sessionContext || transcript, // full utterance carries nuance
      };
    }

    // Calendar conflict check
    let calendarWarning: string | null = null;
    let calendarConflicts: Array<{ title: string; start: string; end: string }> = [];
    if (isCalendarConfigured() && startInput.durationMinutes) {
      try {
        const sessionStart = new Date();
        const sessionEnd = new Date(sessionStart.getTime() + startInput.durationMinutes * 60_000);
        const conflicts = await getConflictingEvents(sessionStart, sessionEnd);
        if (conflicts.length > 0) {
          calendarConflicts = conflicts;
          const t = new Date(conflicts[0].start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          calendarWarning = `Calendar conflict: "${conflicts[0].title}" starts at ${t}. Consider a shorter sprint.`;
        }
      } catch { /* non-fatal */ }
    }

    const session = startGuardianSession(startInput);

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

    return NextResponse.json({ success: true, session: { ...session, immediateBlockDomains }, parsedIntent, calendarWarning, calendarConflicts });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
