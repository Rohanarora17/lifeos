import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI } from '@/lib/ai';
import { buildBehaviorContext, buildGoalsContext } from '@/lib/behavior';

// POST: Start or complete a focus session
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action } = body;

        const db = getDb();

        if (action === 'start') {
            const { goalId, goalTitle, taskId, taskTitle, durationMinutes } = body;

            // End any existing active session
            db.prepare(`UPDATE focus_sessions SET status = 'abandoned', ended_at = datetime('now') WHERE status = 'active'`).run();

            const result = db.prepare(`
                INSERT INTO focus_sessions (goal_id, goal_title, task_id, task_title, started_at, duration_minutes, status)
                VALUES (?, ?, ?, ?, datetime('now'), ?, 'active')
            `).run(goalId || null, goalTitle || null, taskId || null, taskTitle || null, durationMinutes || 60);

            return NextResponse.json({
                success: true,
                sessionId: result.lastInsertRowid,
            }, { status: 201 });
        }

        if (action === 'complete') {
            const {
                sessionId,
                activities,       // Array of { url, domain, title, category, duration_seconds }
                blockedCount,
                overrideCount,
                actualDurationSeconds,
            } = body;

            // Calculate time breakdowns from activities
            let productiveSeconds = 0;
            let distractionSeconds = 0;
            let neutralSeconds = 0;
            const domainTime: Record<string, { seconds: number; category: string }> = {};

            if (Array.isArray(activities)) {
                for (const a of activities) {
                    const dur = a.duration_seconds || 0;
                    if (a.category === 'productive') productiveSeconds += dur;
                    else if (a.category === 'distraction') distractionSeconds += dur;
                    else neutralSeconds += dur;

                    if (a.domain) {
                        if (!domainTime[a.domain]) {
                            domainTime[a.domain] = { seconds: 0, category: a.category || 'neutral' };
                        }
                        domainTime[a.domain].seconds += dur;
                    }
                }
            }

            const topDomains = Object.entries(domainTime)
                .map(([domain, data]) => ({ domain, minutes: Math.round(data.seconds / 60), category: data.category }))
                .sort((a, b) => b.minutes - a.minutes)
                .slice(0, 10);

            // Get session info for report context
            const session = db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(sessionId) as any;
            if (!session) {
                return NextResponse.json({ error: 'Session not found' }, { status: 404 });
            }

            // Generate AI deep analysis report
            let aiReport = '';
            try {
                aiReport = await generateFocusReport({
                    goalTitle: session.goal_title,
                    taskTitle: session.task_title,
                    durationMinutes: session.duration_minutes,
                    actualDurationSeconds: actualDurationSeconds || 0,
                    productiveSeconds,
                    distractionSeconds,
                    neutralSeconds,
                    topDomains,
                    blockedCount: blockedCount || 0,
                    overrideCount: overrideCount || 0,
                    activities: activities || [],
                });
            } catch (e) {
                console.error('[FocusSession] AI report generation failed:', e);
                aiReport = buildFallbackReport({
                    goalTitle: session.goal_title,
                    taskTitle: session.task_title,
                    actualDurationSeconds,
                    productiveSeconds,
                    distractionSeconds,
                    topDomains,
                    blockedCount,
                    overrideCount,
                });
            }

            // Update session record
            db.prepare(`
                UPDATE focus_sessions SET
                    ended_at = datetime('now'),
                    actual_duration_seconds = ?,
                    productive_seconds = ?,
                    distraction_seconds = ?,
                    neutral_seconds = ?,
                    tabs_opened = ?,
                    tabs_blocked = ?,
                    tabs_overridden = ?,
                    top_domains = ?,
                    ai_report = ?,
                    status = 'completed'
                WHERE id = ?
            `).run(
                actualDurationSeconds || 0,
                productiveSeconds,
                distractionSeconds,
                neutralSeconds,
                Array.isArray(activities) ? activities.length : 0,
                blockedCount || 0,
                overrideCount || 0,
                JSON.stringify(topDomains),
                aiReport,
                sessionId
            );

            return NextResponse.json({
                success: true,
                report: aiReport,
                stats: {
                    productiveSeconds,
                    distractionSeconds,
                    neutralSeconds,
                    topDomains,
                    blockedCount,
                    overrideCount,
                }
            });
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } catch (error) {
        console.error('Focus Session API Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// GET: Fetch recent focus session reports
export async function GET() {
    try {
        const db = getDb();
        const sessions = db.prepare(`
            SELECT id, goal_title, task_title, started_at, ended_at, duration_minutes,
                   actual_duration_seconds, productive_seconds, distraction_seconds,
                   neutral_seconds, tabs_opened, tabs_blocked, tabs_overridden,
                   top_domains, ai_report, status
            FROM focus_sessions
            ORDER BY created_at DESC
            LIMIT 20
        `).all();

        return NextResponse.json({ sessions });
    } catch (error) {
        console.error('Focus Session GET Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// Generate deep analysis report using Gemini Pro
async function generateFocusReport(data: {
    goalTitle: string | null;
    taskTitle: string | null;
    durationMinutes: number;
    actualDurationSeconds: number;
    productiveSeconds: number;
    distractionSeconds: number;
    neutralSeconds: number;
    topDomains: { domain: string; minutes: number; category: string }[];
    blockedCount: number;
    overrideCount: number;
    activities: any[];
}): Promise<string> {
    const ai = getGenAI();
    if (!ai) return buildFallbackReport(data);

    const behaviorContext = buildBehaviorContext();
    const goalsContext = buildGoalsContext();

    const totalMinutes = Math.round(data.actualDurationSeconds / 60);
    const prodMinutes = Math.round(data.productiveSeconds / 60);
    const distMinutes = Math.round(data.distractionSeconds / 60);
    const focusRatio = data.actualDurationSeconds > 0
        ? Math.round((data.productiveSeconds / data.actualDurationSeconds) * 100)
        : 0;

    // Build activity timeline
    const timeline = data.activities.slice(0, 30).map((a: any) => {
        const dur = a.duration_seconds || 0;
        return `- [${a.category || 'neutral'}] ${a.domain} (${dur}s) — "${a.title || 'untitled'}"`;
    }).join('\n');

    const prompt = `You are an elite productivity coach generating a post-focus-session deep analysis report. Be insightful, specific, and actionable. Use emojis. Use markdown formatting.

${behaviorContext}
${goalsContext}

## SESSION DATA
- Goal: ${data.goalTitle || 'No specific goal'}
- Task: ${data.taskTitle || 'No specific task'}
- Planned Duration: ${data.durationMinutes} minutes
- Actual Duration: ${totalMinutes} minutes
- Productive Time: ${prodMinutes} minutes (${focusRatio}%)
- Distraction Time: ${distMinutes} minutes
- Tabs Opened: ${data.activities.length}
- Distractions Blocked: ${data.blockedCount}
- Overrides Used: ${data.overrideCount}

## TOP SITES BY TIME
${data.topDomains.map(d => `- ${d.domain}: ${d.minutes}min (${d.category})`).join('\n')}

## ACTIVITY TIMELINE (most recent)
${timeline}

## INSTRUCTIONS
Generate a comprehensive focus session report with these sections:

1. **Session Score** — A score out of 100 based on focus ratio, distraction resistance, and task alignment. Be fair but honest.

2. **Performance Summary** — 2-3 sentences on how the session went overall. Compare productive time to planned duration.

3. **Focus Pattern Analysis** — Analyze the browsing timeline. Were there distraction bursts? Long productive streaks? Context-switching patterns?

4. **Distraction Analysis** — Which sites were distractions? Were overrides justified? What patterns emerged?

5. **Productivity Insights** — What worked well? Which sites contributed to the goal? Were there unexpected productive behaviors?

6. **Recommendations** — 2-3 specific, actionable suggestions for the next focus session. Reference the user's behavioral profile.

Keep the total report under 400 words. Be specific to this session's data — no generic advice.`;

    const result = await ai.models.generateContent({
        model: 'gemini-pro-latest',
        contents: prompt,
    });

    return (result.text || '').trim();
}

// Fallback report when AI is unavailable
function buildFallbackReport(data: any): string {
    const totalMin = Math.round((data.actualDurationSeconds || 0) / 60);
    const prodMin = Math.round((data.productiveSeconds || 0) / 60);
    const distMin = Math.round((data.distractionSeconds || 0) / 60);
    const focusRatio = data.actualDurationSeconds > 0
        ? Math.round((data.productiveSeconds / data.actualDurationSeconds) * 100)
        : 0;

    return `# Focus Session Report

## ${data.goalTitle || 'General Focus'} ${data.taskTitle ? `— ${data.taskTitle}` : ''}

**Duration:** ${totalMin} minutes
**Focus Rate:** ${focusRatio}%

| Metric | Value |
|--------|-------|
| ✅ Productive | ${prodMin} min |
| ❌ Distracted | ${distMin} min |
| 🛑 Blocked | ${data.blockedCount || 0} distractions |
| 🔓 Overrides | ${data.overrideCount || 0} |

### Top Sites
${(data.topDomains || []).slice(0, 5).map((d: any) => `- **${d.domain}**: ${d.minutes}min (${d.category})`).join('\n')}

*AI analysis unavailable — enable Gemini API key for deep insights.*`;
}
