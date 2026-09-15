// src/lib/open-loops.ts
// Weekly open loops audit: surface incomplete goals/projects, one actionable suggestion each

import { getDb } from './db';
import { sendTelegram } from './telegram';
import { getIntelligenceContext } from './intelligence';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import { daysSinceInHistory, getHistoryStartDate, isInCurrentHistory } from './history-epoch';
import { shouldSuppressRoutineCoaching } from './coaching-state';

export interface OpenLoop {
  type: 'goal' | 'task' | 'topic';
  title: string;
  lastTouchedDaysAgo: number;
  lastFocusScore?: number;
  lastElapsedMinutes?: number;
  sessionCount: number;
  status: string;
}

/**
 * Query all open loops: goals/tasks engaged in last 30 days but not completed.
 */
export function getOpenLoops(): OpenLoop[] {
  const db = getDb();
  const loops: OpenLoop[] = [];
  const historyStart = getHistoryStartDate();

  // Goals engaged in this history run, idle 3+ days (no pre-epoch guilt)
  const goals = db.prepare(`
    SELECT
      g.title,
      g.active,
      g.created_at,
      g.updated_at,
      MAX(s.completed_at) as last_session_at,
      COUNT(s.session_id) as session_count,
      AVG(s.final_focus_score) as avg_score,
      AVG(s.elapsed_minutes) as avg_minutes
    FROM goals g
    LEFT JOIN guardian_session_summaries s ON s.target_title LIKE '%' || g.title || '%'
      AND date(COALESCE(s.completed_at, s.started_at), 'localtime') >= ?
    WHERE g.active = 1
    GROUP BY g.id
    HAVING session_count > 0
    ORDER BY last_session_at ASC
  `).all(historyStart) as Array<{
    title: string; active: number; created_at: string; updated_at: string;
    last_session_at: string; session_count: number;
    avg_score: number; avg_minutes: number;
  }>;

  for (const g of goals) {
    if (!g.last_session_at) continue;
    if (!isInCurrentHistory({
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      lastTouchedAt: g.last_session_at,
    })) continue;
    const daysAgo = daysSinceInHistory(g.last_session_at);
    if (daysAgo !== null && daysAgo >= 3) {
      loops.push({
        type: 'goal',
        title: g.title,
        lastTouchedDaysAgo: daysAgo,
        lastFocusScore: g.avg_score != null ? Math.round(g.avg_score) : undefined,
        lastElapsedMinutes: g.avg_minutes != null ? Math.round(g.avg_minutes) : undefined,
        sessionCount: g.session_count,
        status: 'active',
      });
    }
  }

  // Tasks that are in-progress in this history run
  const tasks = db.prepare(`
    SELECT
      t.title,
      t.status,
      t.created_at,
      t.updated_at,
      (julianday('now') - julianday(t.updated_at)) as days_since_update
    FROM tasks t
    WHERE t.status IN ('doing', 'today', 'this_week', 'next')
      AND date(COALESCE(t.updated_at, t.created_at)) >= ?
    ORDER BY days_since_update DESC
    LIMIT 10
  `).all(historyStart) as Array<{
    title: string; status: string; created_at: string; updated_at: string; days_since_update: number;
  }>;

  for (const t of tasks) {
    if (!isInCurrentHistory({ createdAt: t.created_at, updatedAt: t.updated_at })) continue;
    const daysAgo = daysSinceInHistory(t.updated_at ?? t.created_at);
    if (daysAgo !== null && daysAgo >= 5) {
      loops.push({
        type: 'task',
        title: t.title,
        lastTouchedDaysAgo: daysAgo,
        sessionCount: 0,
        status: t.status,
      });
    }
  }

  return loops.sort((a, b) => b.lastTouchedDaysAgo - a.lastTouchedDaysAgo).slice(0, 8);
}

/**
 * Build and send the weekly open loops message.
 */
export async function sendOpenLoopsAudit(): Promise<void> {
  try {
    const coachingGate = shouldSuppressRoutineCoaching('open_loops_audit');
    if (coachingGate.suppress) {
      console.log(`[OpenLoops] ${coachingGate.reason}`);
      return;
    }
    const loops = getOpenLoops();

    if (loops.length === 0) {
      console.log('[OpenLoops] No open loops to report this week.');
      return;
    }

    const ai = getGenAI();
    if (!ai) {
      console.error('[OpenLoops] No AI client available');
      return;
    }

    const context = getIntelligenceContext({ maxInsights: 1 });

    const loopsText = loops.map(l => {
      const sessionNote = l.sessionCount > 0
        ? `, ${l.sessionCount} sessions (avg score ${l.lastFocusScore}, avg ${l.lastElapsedMinutes}m)`
        : '';
      return `- ${l.title} — last touched ${l.lastTouchedDaysAgo} days ago${sessionNote}`;
    }).join('\n');

    const prompt = `You are Rohan's guardian writing a weekly open loops audit. Surface unfinished things honestly.

Intelligence profile summary:
${context.slice(0, 400)}

Open loops (things started but not recently touched):
${loopsText}

Write a Telegram message in this format:
1. One sentence header: "X things you started and haven't touched." (use actual count, no softening)
2. For each loop (max 5): one line with the item and ONE specific, actionable suggestion (not motivational — concrete: "open the file", "write one question", "send the email")
3. One final line: "Which one is actually going to get done this week?"

Rules:
- No guilt language ("you failed to", "you should have")
- Just facts and a path forward
- Keep suggestions specific to what you know about the person
- Max 200 words total
- Return ONLY the message text, no explanation`;

    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.4, maxOutputTokens: 400 },
    }, { feature: 'open_loops_audit' });

    const auditText = result.text;
    if (!auditText) {
      console.error('[OpenLoops] generateWithFallback returned empty text');
      return;
    }

    await sendTelegram(auditText, 'HTML');
    console.log(`[OpenLoops] Sent audit for ${loops.length} open loops`);

  } catch (err) {
    console.error('[OpenLoops] sendOpenLoopsAudit failed:', err);
  }
}

/**
 * Build and send the monthly pattern letter (synthesizes 4 weeks of reckonings).
 */
export async function sendMonthlyPatternLetter(): Promise<void> {
  try {
    const coachingGate = shouldSuppressRoutineCoaching('monthly_pattern_letter');
    if (coachingGate.suppress) {
      console.log(`[OpenLoops] ${coachingGate.reason}`);
      return;
    }
    const db = getDb();

    const reckonings = db.prepare(`
      SELECT week_start, reckoning_text, open_question, response_text
      FROM weekly_reckonings
      ORDER BY created_at DESC
      LIMIT 4
    `).all() as Array<{ week_start: string; reckoning_text: string; open_question: string; response_text: string | null }>;

    if (reckonings.length < 2) {
      console.log('[OpenLoops] Not enough reckonings for monthly letter, need at least 2.');
      return;
    }

    const ai = getGenAI();
    if (!ai) {
      console.error('[OpenLoops] No AI client available for monthly letter');
      return;
    }

    const monthStart = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const monthStats = db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) as total_sessions,
        ROUND(AVG(final_focus_score)) as avg_score,
        COUNT(DISTINCT date(completed_at)) as days_with_sessions,
        SUM(elapsed_minutes) as total_minutes
      FROM guardian_session_summaries
      WHERE completed_at >= ?
    `).get(monthStart) as { total_sessions: number; avg_score: number; days_with_sessions: number; total_minutes: number };

    const reckoningsText = reckonings.map((r, i) =>
      `WEEK ${i + 1} (${r.week_start}):\n${r.reckoning_text?.slice(0, 600) || '(no data)'}\n${r.response_text ? `Response: "${r.response_text.slice(0, 200)}"` : '(no response)'}`
    ).join('\n\n---\n\n');

    const prompt = `You are Rohan's guardian writing a monthly pattern letter. This is more personal and analytical than the weekly reckoning.

Last 4 weeks of reckonings and responses:
${reckoningsText}

Month stats:
- Sessions: ${monthStats?.total_sessions ?? 0} total, ${monthStats?.days_with_sessions ?? 0} days active
- Average focus score: ${monthStats?.avg_score ?? 'n/a'}
- Total focus time: ${Math.round((monthStats?.total_minutes ?? 0) / 60)}h

Write a monthly pattern letter that:
1. Names the 1-2 dominant patterns across all 4 weeks (not events, patterns)
2. Notes what changed vs. what stayed the same
3. References specific things Rohan said in his responses (if any)
4. Ends with ONE insight the system has developed about this person that wasn't visible 4 weeks ago
5. No prescriptions, no action items — this is a mirror, not a plan

Max 350 words. Direct. Specific. No filler.`;

    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.4, maxOutputTokens: 700 },
    }, { feature: 'monthly_pattern_letter' });

    const letter = result.text;
    if (!letter) {
      console.error('[OpenLoops] Monthly pattern letter generateWithFallback returned empty text');
      return;
    }

    const header = `📅 <b>Monthly Pattern Letter</b>\n\n`;
    await sendTelegram(header + letter, 'HTML');
    console.log('[OpenLoops] Monthly pattern letter sent.');

  } catch (err) {
    console.error('[OpenLoops] sendMonthlyPatternLetter failed:', err);
  }
}
