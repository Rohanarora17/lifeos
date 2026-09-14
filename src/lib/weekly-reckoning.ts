// src/lib/weekly-reckoning.ts
// Sunday evening weekly reckoning: honest data summary + one non-negotiable question

import { getDb, setSetting } from './db';
import { sendTelegram } from './telegram';
import { getIntelligenceContext } from './intelligence';
import { shouldSuppressRoutineCoaching } from './coaching-state';

export async function sendWeeklyReckoning(): Promise<void> {
  try {
    const coachingGate = shouldSuppressRoutineCoaching('weekly_reckoning');
    if (coachingGate.suppress) {
      console.log(`[WeeklyReckoning] ${coachingGate.reason}`);
      return;
    }
    const db = getDb();
    const now = new Date();

    // Week start = last Monday
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now.getTime() - daysToMonday * 86400000).toISOString().slice(0, 10);
    const weekEnd = now.toISOString().slice(0, 10);

    // Sessions this week
    const sessions = db.prepare(`
      SELECT target_title, elapsed_minutes, final_focus_score AS focus_score, completed_at
      FROM guardian_session_summaries
      WHERE date(completed_at) >= ?
      ORDER BY completed_at ASC
    `).all(weekStart) as Array<{ target_title: string; elapsed_minutes: number; focus_score: number; completed_at: string }>;

    // Days laptop was opened (from screen observations)
    const laptopDays = (db.prepare(`
      SELECT COUNT(DISTINCT date(observed_at)) as count
      FROM screen_observations
      WHERE date(observed_at) >= ? AND date(observed_at) <= ?
    `).get(weekStart, weekEnd) as { count: number }).count;

    // Average first-open time
    const firstOpens = db.prepare(`
      SELECT date(observed_at) as day, MIN(time(observed_at)) as first_open
      FROM screen_observations
      WHERE date(observed_at) >= ? AND date(observed_at) <= ?
      AND source IN ('screenshot','daemon')
      GROUP BY day
    `).all(weekStart, weekEnd) as Array<{ day: string; first_open: string }>;

    const avgFirstOpenHour = firstOpens.length > 0
      ? firstOpens.reduce((sum, r) => sum + parseInt(r.first_open.slice(0, 2)), 0) / firstOpens.length
      : null;

    // Screen time categories this week
    const screenCats = db.prepare(`
      SELECT category, ROUND(SUM(duration_seconds)/3600.0, 1) as hours
      FROM effective_activities
      WHERE date(started_at) >= ?
      GROUP BY category
      ORDER BY hours DESC
    `).all(weekStart) as Array<{ category: string; hours: number }>;

    // Phone screen time
    const phoneST = db.prepare(`
      SELECT
        COALESCE(SUM(instagram_minutes), 0) as instagram_total,
        COALESCE(SUM(total_minutes), 0) as phone_total,
        COALESCE(AVG(pickup_count), 0) as avg_pickups
      FROM phone_screen_time
      WHERE report_date >= ? AND report_type = 'evening'
    `).get(weekStart) as { instagram_total: number; phone_total: number; avg_pickups: number };

    // Goal progress
    const goals = db.prepare(`
      SELECT title, health_status, progress_value
      FROM goals WHERE active = 1 LIMIT 8
    `).all() as Array<{ title: string; health_status: string; progress_value: number }>;


    // Last week's open question
    const lastReckoning = db.prepare(`
      SELECT open_question, response_text FROM weekly_reckonings
      ORDER BY created_at DESC LIMIT 1
    `).get() as { open_question: string; response_text: string | null } | undefined;

    // Evening reflections this week
    const reflections = db.prepare(`
      SELECT raw_transcript FROM daily_checkins
      WHERE checkin_date >= ? AND checkin_type = 'evening'
      ORDER BY checkin_date DESC LIMIT 7
    `).all(weekStart) as Array<{ raw_transcript: string }>;

    // Build session summary by topic
    const sessionsByTopic: Record<string, { sessions: number; totalMins: number; avgScore: number }> = {};
    for (const s of sessions) {
      const key = s.target_title;
      if (!sessionsByTopic[key]) sessionsByTopic[key] = { sessions: 0, totalMins: 0, avgScore: 0 };
      sessionsByTopic[key].sessions++;
      sessionsByTopic[key].totalMins += s.elapsed_minutes;
      sessionsByTopic[key].avgScore = Math.round(
        (sessionsByTopic[key].avgScore * (sessionsByTopic[key].sessions - 1) + s.focus_score) / sessionsByTopic[key].sessions
      );
    }

    const deepWorkHours = screenCats.find(c => c.category === 'deep_work')?.hours || 0;
    const distractionHours = screenCats.find(c => c.category === 'distraction')?.hours || 0;

    const dataContext = [
      `WEEK: ${weekStart} to ${weekEnd}`,
      ``,
      `LAPTOP:`,
      `- Opened: ${laptopDays}/7 days`,
      avgFirstOpenHour != null
        ? `- Average first-open time: ${Math.floor(avgFirstOpenHour)}:${String(Math.round((avgFirstOpenHour % 1) * 60)).padStart(2, '0')}`
        : '',
      `- Deep work hours: ${deepWorkHours}h`,
      `- Distraction hours: ${distractionHours}h`,
      ``,
      `PHONE:`,
      phoneST.phone_total > 0
        ? `- Instagram total: ${Math.round(phoneST.instagram_total)}m`
        : '- No phone data this week',
      ``,
      `GOALS:`,
      ...goals.map(g => {
        const icon = g.health_status === 'on_track' ? '✓' : g.health_status === 'at_risk' ? '⚠' : '✗';
        const topicSessions = sessionsByTopic[g.title];
        const sessionNote = topicSessions ? `, ${topicSessions.sessions} sessions` : ', 0 sessions';
        const pct = g.progress_value != null ? ` (${Math.round(g.progress_value)}%)` : '';
        return `${icon} ${g.title}${pct}${sessionNote}`;
      }),
      ``,
      `SESSIONS THIS WEEK:`,
      ...Object.entries(sessionsByTopic).map(([topic, data]) =>
        `- ${topic}: ${data.sessions} sessions, ${data.totalMins}m total, avg score ${data.avgScore}`
      ),
      ``,
      `EVENING REFLECTIONS (excerpts):`,
      ...reflections.slice(0, 3).map(r => `"${r.raw_transcript?.slice(0, 150) || '(none)'}"`),
      ``,
      lastReckoning?.open_question ? `LAST WEEK'S OPEN QUESTION: "${lastReckoning.open_question}"` : '',
      lastReckoning?.response_text
        ? `ANSWER RECEIVED: "${lastReckoning.response_text.slice(0, 200)}"`
        : lastReckoning?.open_question ? 'NO ANSWER RECEIVED.' : '',
    ].filter(Boolean).join('\n');

    const intelligenceContext = getIntelligenceContext({ maxInsights: 2 });

    let cognitiveBlock = '';
    let cognitiveQuestion: string | null = null;
    try {
      const { computeCognitiveTraits, formatCognitiveTraitsForPrompt, selectWeeklyCognitiveQuestion } =
        await import('./cognitive-traits');
      const traits = computeCognitiveTraits({ windowDays: 45 });
      cognitiveBlock = formatCognitiveTraitsForPrompt(traits, 5);
      cognitiveQuestion = selectWeeklyCognitiveQuestion(traits);
    } catch {
      /* cognitive map is optional for reckoning */
    }

    const prompt = `You are Rohan's personal guardian writing his weekly reckoning. Be honest. Be specific. Use actual data.

Intelligence profile:
${intelligenceContext}

Cognitive self-map (pressure wiring / voluntary starts / activation):
${cognitiveBlock || 'Not enough cognitive trait data yet.'}

This week's data:
${dataContext}

Write the weekly reckoning in this EXACT format (no deviations):

WEEK OF [date range]

REALITY:
[4-6 bullet points of the hardest, most specific facts from the data. No softening. Numbers only. If pressure-dependency or voluntary-start metrics are available, include them.]

GOALS:
[one line per active goal with ✓/✗ and one specific observation]

PATTERN THIS WEEK:
[2-3 sentences identifying the most important behavioral pattern — must reference specific days, times, or events from the data. Prefer pressure-dependency / avoidance / activation patterns when the cognitive map supports them.]

ONE QUESTION I'M NOT MOVING ON FROM:
${cognitiveQuestion
  ? `Prefer this cognitive question unless the week's data makes a more specific crisis unavoidable:\n"${cognitiveQuestion}"`
  : '[One direct question about the most important unresolved pattern or avoidance. Make it specific enough that it requires a real answer, not a general one.]'}

Keep total length under 400 words. No filler. No encouragement. Facts and one honest question. Never shame crisis productivity — measure it and ask about rewiring.`;

    const { getGenAI, generateWithFallback } = await import('./ai');
    const { MODEL_PRO } = await import('./models');
    const ai = getGenAI();

    if (!ai) {
      console.error('[WeeklyReckoning] No AI client available');
      return;
    }

    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: prompt,
      config: { temperature: 0.3, maxOutputTokens: 600 },
    });


    const reckoningText = result.text;

    if (!reckoningText) {
      console.error('[WeeklyReckoning] generateWithFallback returned empty text');
      return;
    }

    // Extract the open question
    const questionMatch = reckoningText.match(/ONE QUESTION.*?\n([\s\S]+?)(?:\n\n|\n\[|$)/i);
    const openQuestion = questionMatch ? questionMatch[1].trim() : null;

    // Store in DB
    db.prepare(`
      INSERT INTO weekly_reckonings (week_start, reckoning_text, open_question)
      VALUES (?, ?, ?)
    `).run(weekStart, reckoningText, openQuestion);

    setSetting('pending_weekly_reckoning', 'true');
    setSetting('pending_weekly_reckoning_date', weekStart);

    await sendTelegram(reckoningText, '');

    console.log(`[WeeklyReckoning] Sent for week of ${weekStart}`);

  } catch (err) {
    console.error('[WeeklyReckoning] sendWeeklyReckoning failed:', err);
  }
}

export async function handleWeeklyReckoningResponse(text: string): Promise<void> {
  const db = getDb();

  const lastReckoning = db.prepare(`
    SELECT id, open_question FROM weekly_reckonings
    WHERE response_text IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get() as { id: number; open_question: string } | undefined;

  if (!lastReckoning) return;

  db.prepare(`
    UPDATE weekly_reckonings SET response_text = ?, response_received_at = datetime('now','localtime')
    WHERE id = ?
  `).run(text, lastReckoning.id);

  setSetting('pending_weekly_reckoning', '');

  await sendTelegram(`Recorded. I'll hold the thread.`, 'HTML');

  const { extractMemoryFromCheckin } = await import('./memory-extractor');
  void extractMemoryFromCheckin({
    type: 'evening',
    date: new Date().toISOString().slice(0, 10),
    rawTranscript: `Weekly reckoning response: ${text}`,
  });
}
