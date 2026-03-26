import { GoogleGenAI } from '@google/genai';
import { getSetting, getDb } from './db';
import { Category, Subcategory, CategoryResult } from './categories';
import { getSmartNudgeContext } from './behavior';
import { getIntelligenceContext } from './intelligence';
import { MODEL_PRO, MODEL_FLASH } from './models';

let genAI: GoogleGenAI | null = null;

export function getGenAI(): GoogleGenAI | null {
    if (!genAI) {
        const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || getSetting('gemini_api_key');
        const projectId = process.env.GCP_PROJECT_ID || getSetting('gcp_project_id');
        const location = process.env.GCP_LOCATION || getSetting('gcp_location') || 'us-central1';

        console.log(`[getGenAI] hasApiKey: ${!!apiKey}, projectId: ${projectId || 'none'}`);

        if (apiKey) {
            // Standard Gemini Developer API (works with GCP API keys and AI Studio keys).
            // Gemini 3 models are available on this path.
            // NOTE: Vertex AI (aiplatform.googleapis.com) does NOT accept API keys —
            //       it requires OAuth2 / Application Default Credentials (service account).
            //       Only use Vertex AI mode when no API key is present (ADC path).
            genAI = new GoogleGenAI({ apiKey });
        } else if (projectId) {
            // Vertex AI mode via Application Default Credentials (no API key).
            // Requires: gcloud auth application-default login OR a service account.
            // @ts-ignore
            genAI = new GoogleGenAI({ vertexai: { project: projectId, location } });
        } else {
            console.log('[getGenAI] No credentials found — returning null');
            return null;
        }
    }
    return genAI;
}

// Stable fallback when preview models are overloaded (503)
const FALLBACK_FLASH = 'gemini-2.5-flash';
const FALLBACK_PRO = 'gemini-2.5-pro';

/**
 * Returns true for errors that mean "model overloaded / unreachable" —
 * covers HTTP 503, UNAVAILABLE status, and undici HeadersTimeoutError
 * (the server accepted the TCP connection but never sent response headers).
 */
function isOverloadedError(err: any): boolean {
    return (
        err?.status === 503 ||
        err?.message?.includes('503') ||
        err?.message?.includes('UNAVAILABLE') ||
        err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        err?.cause?.message?.includes('Headers Timeout') ||
        err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err?.cause?.code === 'UND_ERR_SOCKET'
    );
}

function fallbackModel(originalModel: string): string {
    return originalModel.includes('pro') ? FALLBACK_PRO : FALLBACK_FLASH;
}

/**
 * Wrapper around ai.models.generateContent that automatically retries
 * once with a stable fallback model when a 503 / UNAVAILABLE error or
 * a headers timeout is returned (preview models under high demand).
 */
export async function generateWithFallback(
    ai: GoogleGenAI,
    params: Parameters<GoogleGenAI['models']['generateContent']>[0]
): ReturnType<GoogleGenAI['models']['generateContent']> {
    try {
        return await ai.models.generateContent(params);
    } catch (err: any) {
        if (!isOverloadedError(err)) throw err;
        const originalModel = typeof params.model === 'string' ? params.model : '';
        const fallback = fallbackModel(originalModel);
        console.warn(`[AI] ${originalModel} overloaded/timeout — falling back to ${fallback}`);
        return await ai.models.generateContent({ ...params, model: fallback });
    }
}

/**
 * Streaming variant of generateWithFallback — retries with stable model on 503.
 */
export async function generateStreamWithFallback(
    ai: GoogleGenAI,
    params: Parameters<GoogleGenAI['models']['generateContentStream']>[0]
): ReturnType<GoogleGenAI['models']['generateContentStream']> {
    try {
        return await ai.models.generateContentStream(params);
    } catch (err: any) {
        if (!isOverloadedError(err)) throw err;
        const originalModel = typeof params.model === 'string' ? params.model : '';
        const fallback = fallbackModel(originalModel);
        console.warn(`[AI] ${originalModel} overloaded/timeout — stream falling back to ${fallback}`);
        return await ai.models.generateContentStream({ ...params, model: fallback });
    }
}

// Helper to extract YouTube video ID
function extractYouTubeVideoId(url: string): string | null {
    const videoIdMatch = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    return videoIdMatch ? videoIdMatch[1] : null;
}

export async function classifyActivityBatch(activities: any[]): Promise<(CategoryResult & { reasoning?: string })[]> {
    const results: (CategoryResult & { reasoning?: string })[] = new Array(activities.length);
    const toClassifyIndices: number[] = [];
    const itemsToClassify: { id: number, url: string, domain: string, title?: string, youtube_channel?: string | null, meta_description?: string, h1_text?: string }[] = [];
    const missingDomains = new Set<string>();

    const db = getDb();

    // 1. Initial pass: Check domain cache and recent activity
    for (let i = 0; i < activities.length; i++) {
        const act = activities[i];
        const { url, domain } = act;

        const isYouTube = domain.includes('youtube.com');
        let isCached = false;

        // 2. Check persistent Domain Cache for standard websites
        if (!isYouTube) {
            try {
                const cachedDomain = db.prepare('SELECT category, subcategory, confidence, ai_reasoning FROM domain_categories WHERE domain = ?').get(domain) as any;
                if (cachedDomain && cachedDomain.confidence >= 0.7) {
                    results[i] = {
                        category: cachedDomain.category,
                        subcategory: cachedDomain.subcategory,
                        confidence: cachedDomain.confidence < 0.8 ? 'medium' : 'high',
                        reasoning: cachedDomain.ai_reasoning || 'Cached domain classification'
                    };
                    isCached = true;
                }
            } catch (e) { /* ignore sqlite errors if migration hasn't run yet */ }
        }

        // 3. Check recent exact-URL cache (especially for YouTube videos)
        if (!isCached && url) {
            const cached = lookupRecentClassification(url, domain, isYouTube ? extractYouTubeVideoId(url) : null);
            if (cached) {
                results[i] = cached;
                isCached = true;
            }
        }

        if (!isCached) {
            toClassifyIndices.push(i);
            missingDomains.add(domain);
            itemsToClassify.push({
                id: i,
                url: act.url,
                domain: act.domain,
                title: act.title,
                youtube_channel: act.youtube_channel,
                meta_description: act.meta_description,
                h1_text: act.h1_text
            });
        }
    }

    if (toClassifyIndices.length === 0) {
        return results;
    }

    // AI Classification pass (Only for missing items)
    const ai = getGenAI();
    if (!ai) {
        // Fallback if no AI setup
        for (const idx of toClassifyIndices) {
            results[idx] = { category: 'neutral', subcategory: 'other', confidence: 'low', reasoning: 'No AI key configured' };
        }
        return results;
    }

    try {
        // Process in chunks to avoid prompt limits
        const CHUNK_SIZE = 50;
        for (let i = 0; i < itemsToClassify.length; i += CHUNK_SIZE) {
            const chunk = itemsToClassify.slice(i, i + CHUNK_SIZE);
            const _db = getDb();
            const goalsContext = getIntelligenceContext({ maxInsights: 0, includeToday: false });

            // Build active tasks context for context-aware classification
            let taskContext = '';
            try {
                const activeTasks = _db.prepare(`
                    SELECT title, status FROM tasks
                    WHERE status IN ('todo', 'doing')
                    ORDER BY status DESC
                `).all() as { title: string; status: string }[];
                if (activeTasks.length > 0) {
                    taskContext = "\nUSER'S ACTIVE TASKS (use these to determine if browsing is task-related):\n" +
                        activeTasks.map(t => `- [${t.status.toUpperCase()}] ${t.title}`).join('\n');
                }
            } catch { /* tasks table may not exist yet */ }

            // Get behavioral memory context
            let memoryContext = '';
            try {
                const memories = _db.prepare('SELECT content FROM behavioral_memory WHERE memory_type = "categorization_rule"').all() as { content: string }[];
                if (memories.length > 0) {
                    memoryContext = "\nUSER MANUAL OVERRIDES (CRITICAL - ALWAYS FOLLOW THESE):\n" +
                        memories.map(m => `- ${m.content}`).join('\n');
                }
            } catch (e) { }

            const prompt = `Classify these browsing activities for a productivity tracker. Respond ONLY with a valid JSON ARRAY of objects, matching the exact input order. Do not use markdown blocks.
            
INPUT:
${JSON.stringify(chunk, null, 2)}

${goalsContext}
${taskContext}
${memoryContext}

OUTPUT FORMAT: Return a JSON array matching this schema:
[
  {
    "id": <input id as number>,
    "category": "productive|neutral|distraction", 
    "subcategory": "coding|documentation|research|learning|youtube-educational|youtube-entertainment|youtube-music|social-media|news|shopping|gaming|entertainment|communication|productivity-tool|finance|other", 
    "confidence": "high|medium|low",
    "reasoning": "Brief 1-sentence explanation of why"
  }
]

RULES:
- If a site is generically productive (coding sites, docs, educational platforms like Wikipedia or Khan Academy), classify it as productive EVEN IF it does not perfectly match the active tasks.
- Use Active Tasks primarily to determine if ambiguous sites (YouTube, Reddit, blogs) are currently productive/on-topic or are distractions.
- YouTube tutorials, courses, tech talks, coding, educational content → productive / youtube-educational
- YouTube entertainment, vlogs, random browsing → distraction / youtube-entertainment
- YouTube gaming livestreams (e.g., CS:GO, Valorant), unless explicitly educational → distraction / gaming
- YouTube music/ambient/study beats → neutral / youtube-music
- Coding sites, docs, learning platforms → productive
- Social media (Twitter, Instagram, Reddit casual) → distraction
- Reddit programming/tech subreddits → productive / research
- News sites → neutral / news`;

            const result = await generateWithFallback(ai, {
                model: MODEL_FLASH,
                contents: prompt,
                config: {
                    systemInstruction: "You are a precise productivity classification engine.",
                    responseMimeType: 'application/json'
                }
            });
            const text = (result.text || '').trim();
            const parsedArray = JSON.parse(text);

            for (const parsed of parsedArray) {
                const originalIdx = parsed.id;
                if (originalIdx !== undefined && originalIdx < results.length) {
                    const aiResult = {
                        category: parsed.category as Category,
                        subcategory: parsed.subcategory as Subcategory,
                        confidence: parsed.confidence || 'medium',
                        reasoning: parsed.reasoning
                    };
                    results[originalIdx] = aiResult;

                    // 4. Update the Domain Cache for future use
                    const act = activities[originalIdx];
                    if (act && !act.domain.includes('youtube.com')) {
                        try {
                            const confScore = aiResult.confidence === 'high' ? 0.9 : (aiResult.confidence === 'medium' ? 0.7 : 0.4);
                            db.prepare(`
                                    INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
                                    VALUES (?, ?, ?, ?, ?)
                                    ON CONFLICT(domain) DO UPDATE SET
                                        category = ?, subcategory = ?, confidence = ?, ai_reasoning = ?, updated_at = datetime('now')
                                `).run(
                                act.domain, aiResult.category, aiResult.subcategory, confScore, aiResult.reasoning,
                                aiResult.category, aiResult.subcategory, confScore, aiResult.reasoning
                            );
                        } catch (e) { /* ignore */ }
                    }
                }
            }
        }
    } catch (err) {
        console.error('Batch AI classification failed:', err);
    }

    // Fill any remaining failures with fallback
    for (const idx of toClassifyIndices) {
        if (!results[idx]) {
            results[idx] = { category: 'neutral', subcategory: 'other', confidence: 'low', reasoning: 'Classification failed' };
        }
    }

    return results;
}
export async function classifyActivity(url: string, title: string, domain: string, youtubeChannel?: string): Promise<CategoryResult & { reasoning?: string }> {
    const results = await classifyActivityBatch([{ url, title, domain, youtube_channel: youtubeChannel }]);
    return results[0];
}

function lookupRecentClassification(url: string, domain: string, youtubeVideoId?: string | null): (CategoryResult & { reasoning?: string }) | null {
    try {
        const db = getDb();

        let query = `
            SELECT category, subcategory, ai_classification 
            FROM activities 
            WHERE 
        `;
        const params: string[] = [];

        if (youtubeVideoId) {
            query += `youtube_video_id = ? AND started_at > datetime('now', '-7 days')`;
            params.push(youtubeVideoId);
        } else {
            query += `domain = ? AND started_at > datetime('now', '-24 hours') AND url = ?`;
            params.push(domain, url);
        }

        query += ` ORDER BY started_at DESC LIMIT 1`;

        const row = db.prepare(query).get(...params) as any;
        if (row && row.ai_classification) {
            const parsed = JSON.parse(row.ai_classification);
            if (parsed && parsed.category) {
                return {
                    category: row.category as Category,
                    subcategory: row.subcategory as Subcategory,
                    confidence: parsed.confidence || 'high',
                    reasoning: parsed.reasoning || 'Cached from earlier visit'
                };
            }
        }
    } catch (e) {
        // ignore db errors
    }
    return null;
}

export async function generateDailySummary(date: string, stats: {
    productiveMinutes: number;
    distractionMinutes: number;
    neutralMinutes: number;
    tasksCompleted: number;
    totalTasks: number;
    habitsCompleted: number;
    totalHabits: number;
    topDomains: { domain: string; minutes: number; category: string }[];
    commits: number;
    score: number;
    xp: number;
}): Promise<string> {
    const ai = getGenAI();
    if (!ai) {
        return buildFallbackSummary(date, stats);
    }

    try {
        const userContext = getIntelligenceContext({ maxInsights: 4, includeToday: true });

        // Phase 9: Inject habit completion data for holistic daily feedback
        let habitContext = '';
        try {
            const db = getDb();
            const habits = db.prepare(`
                SELECT h.name, h.icon,
                    (SELECT COUNT(*) FROM habit_checkins hc WHERE hc.habit_id = h.id AND hc.completed = 1 AND hc.date = ?) as done_today
                FROM habits h WHERE h.archived = 0
            `).all(date) as { name: string; icon: string; done_today: number }[];
            if (habits.length > 0) {
                const completed = habits.filter(h => h.done_today > 0);
                const missed = habits.filter(h => h.done_today === 0);
                habitContext = `\n\nHABIT TRACKER (${completed.length}/${habits.length} completed today):`;
                if (completed.length > 0) habitContext += `\n✅ Completed: ${completed.map(h => `${h.icon} ${h.name}`).join(', ')}`;
                if (missed.length > 0) habitContext += `\n❌ Missed: ${missed.map(h => `${h.icon} ${h.name}`).join(', ')}`;
            }
        } catch { /* ignore */ }

        const prompt = `Generate a concise, motivating daily productivity report. Use emojis. Be encouraging but honest about distractions. Keep it under 200 words.

${userContext}
${habitContext}

Date: ${date}
Productive time: ${Math.round(stats.productiveMinutes / 60)}h ${stats.productiveMinutes % 60}m
Distraction time: ${Math.round(stats.distractionMinutes / 60)}h ${stats.distractionMinutes % 60}m
Neutral time: ${Math.round(stats.neutralMinutes / 60)}h ${stats.neutralMinutes % 60}m
Tasks completed: ${stats.tasksCompleted}/${stats.totalTasks}
Habits completed: ${stats.habitsCompleted}/${stats.totalHabits}
GitHub commits: ${stats.commits}
Accountability score: ${stats.score}/100
XP earned: ${stats.xp}

Top sites by time:
${stats.topDomains.map(d => `- ${d.domain}: ${d.minutes}min (${d.category})`).join('\n')}

Use the behavioral profile above to personalize this report. Reference their patterns, habit streaks, and known triggers. If habits were missed, give specific encouragement. Compare today to their usual behavior. Format as a clean report with sections.`;

        // PRO: Deep synthesis and behavior reasoning
        const result = await generateWithFallback(ai, {
            model: MODEL_PRO,
            contents: prompt
        });
        return (result.text || '').trim();
    } catch (err) {
        console.error('AI summary failed:', err);
        return buildFallbackSummary(date, stats);
    }
}

export async function generateMorningBrief(date: string, data: {
    calendarEvents: { title: string; start_time: string; end_time: string }[];
    pendingTasks: { title: string; status: string }[];
    yesterdayScore: number;
    streak: number;
    yesterdayDistractionMinutes: number;
}): Promise<string> {
    const ai = getGenAI();
    if (!ai) {
        return buildFallbackMorningBrief(date, data);
    }

    try {
        const userContext = getIntelligenceContext({ maxInsights: 3, includeToday: true });
        const prompt = `Generate a brief, energizing morning briefing. Use emojis. Keep it under 150 words. Be motivating!

${userContext}

Date: ${date}
Calendar events today:
${data.calendarEvents.length > 0 ? data.calendarEvents.map(e => `- ${e.title} (${e.start_time} - ${e.end_time})`).join('\n') : '- No meetings scheduled'}

Pending tasks (Zeigarnik Open Loops):
${data.pendingTasks.map(t => `- [${t.status}] ${t.title}`).join('\n')}

Yesterday's score: ${data.yesterdayScore}/100
Current streak: ${data.streak} days
Yesterday's distraction time: ${data.yesterdayDistractionMinutes} minutes

CRITICAL INSTRUCTION: Based on the "Pending tasks", identify the single most important "Open Loop" (Zeigarnik Effect). To help the user close it, you MUST generate an "Implementation Intention" (Peter Gollwitzer's framework) using this exact format:
"🎯 **Action Plan:** If [specific time/calendar event], then I will [specific tiny action to start the task]."

Use the behavioral profile to personalize this briefing. Reference their typical patterns and known strengths/weaknesses. Include a motivating message tailored to their motivation style.`;

        // PRO: Strategic planning and motivation
        const result = await generateWithFallback(ai, {
            model: MODEL_PRO,
            contents: prompt
        });
        return (result.text || '').trim();
    } catch (err) {
        console.error('AI morning brief failed:', err);
        return buildFallbackMorningBrief(date, data);
    }
}

export async function shouldNudge(url: string, currentDomain: string, minutesOnSite: number, currentTitle: string, videoId?: string | null, focusGoal?: string, thresholdOverride?: number): Promise<{ shouldNudge: boolean; message: string }> {
    const threshold = thresholdOverride || parseInt(getSetting('nudge_threshold_minutes') || '15');

    if (minutesOnSite < threshold) {
        return { shouldNudge: false, message: '' };
    }

    const db = getDb();

    // Phase 9: Calendar-based nudge suppression
    // If user is currently in a scheduled meeting, suppress all nudges
    try {
        const activeMeeting = db.prepare(`
            SELECT title FROM calendar_events
            WHERE datetime('now', 'localtime') BETWEEN start_time AND end_time
            LIMIT 1
        `).get() as { title: string } | undefined;
        if (activeMeeting) {
            return { shouldNudge: false, message: '' };
        }
    } catch { /* calendar table may not exist */ }

    let domainCategory: string | null = null;

    // Quick check using domain cache
    try {
        const cachedDomain = db.prepare('SELECT category, subcategory, ai_reasoning FROM domain_categories WHERE domain = ?').get(currentDomain) as any;
        if (cachedDomain) {
            domainCategory = cachedDomain.category;
            if (cachedDomain.category === 'productive') {
                return { shouldNudge: false, message: '' };
            }
        }
    } catch { /* ignore */ }

    // Check recent activity cache to save tokens
    const cachedResult = lookupRecentClassification(url, currentDomain, videoId);
    if (cachedResult) {
        if (cachedResult.category === 'productive') {
            return { shouldNudge: false, message: '' };
        }
    }

    // --- Phase 7: EMA / CUSUM Anomaly Detection (Yerkes-Dodson) ---
    const isDistraction = domainCategory === 'distraction' || cachedResult?.category === 'distraction';

    if (isDistraction) {
        try {
            // Calculate a baseline score for today (long-term EMA proxy)
            const todayBaseline = db.prepare(`
                SELECT 
                    SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) * 1.0 / 
                    MAX(SUM(duration_seconds), 1) as baseline_ratio
                FROM activities WHERE date(started_at, 'localtime') = date('now')
            `).get() as { baseline_ratio: number };

            // Calculate short-term EMA (last 30 minutes)
            const shortTerm = db.prepare(`
                SELECT 
                    SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) * 1.0 / 
                    MAX(SUM(duration_seconds), 1) as recent_ratio
                FROM activities WHERE started_at > datetime('now', '-30 minutes')
            `).get() as { recent_ratio: number };

            const baseline = todayBaseline?.baseline_ratio || 0.5;
            const recent = shortTerm?.recent_ratio || 0;

            // CUSUM Breach Logic: If recent productivity is significantly worse than baseline
            // and they are currently distracted, trigger an overstimulation/anxiety nudge (Yerkes-Dodson)
            if (recent < baseline - 0.2 && minutesOnSite >= 5) {
                return {
                    shouldNudge: true,
                    message: `⚠️ Focus Anomaly Detected: Your productivity ratio just dropped sharply below your daily baseline. Overstimulated? Try a 5-minute Pomodoro break.`,
                };
            }
        } catch (e) {
            console.error('CUSUM anomaly calculation failed:', e);
        }

        // Standard threshold nudge
        if (minutesOnSite >= threshold) {
            return {
                shouldNudge: true,
                message: `⚠️ ${cachedResult?.reasoning || `You've been distracted on ${currentDomain}`}. (${minutesOnSite}min elapsed)`,
            };
        }
        return { shouldNudge: false, message: '' };
    }

    // For YouTube and ambiguous sites, use AI
    const ai = getGenAI();
    if (ai) {
        try {
            // FLASH: Fast context processing for real-time nudge
            const nudgeContext = getSmartNudgeContext();
            const userContext = getIntelligenceContext({ maxInsights: 2, includeToday: true });

            // Phase 9: Inject active tasks into nudge prompt
            let taskContext = '';
            try {
                const activeTasks = db.prepare(`
                    SELECT title, status FROM tasks
                    WHERE status IN ('todo', 'doing')
                    ORDER BY status DESC
                `).all() as { title: string; status: string }[];
                if (activeTasks.length > 0) {
                    taskContext = "\nUSER'S ACTIVE TASKS (if browsing is related to these, do NOT nudge):\n" +
                        activeTasks.map(t => `- [${t.status.toUpperCase()}] ${t.title}`).join('\n');
                }
            } catch { /* tasks table may not exist */ }

            let intentionsContext = '';
            try {
                const intentions = db.prepare(`SELECT id, if_condition, then_action FROM intentions WHERE active = 1`).all() as any[];
                if (intentions.length > 0) {
                    intentionsContext = "\nUSER'S IMPLEMENTATION INTENTIONS (If one of these 'IF' conditions matches the current situation, you MUST use its 'THEN' action as the nudge reason):\n" +
                        intentions.map(i => `- IF ${i.if_condition}, THEN ${i.then_action} (Intention ID: ${i.id})`).join('\n');
                }
            } catch { /* intentions table may not exist */ }

            // Focus session context
            const focusContext = focusGoal
                ? `\n\n⚠️ FOCUS SESSION ACTIVE: The user is in a focus session for "${focusGoal}". They should NOT be on ${currentDomain} unless it's directly relevant to this goal. Be assertive — they chose to focus.`
                : '';

            const prompt = `A user has been on ${currentDomain} for ${minutesOnSite} minutes. Page title: "${currentTitle}". 
Should they be nudged to get back to work? Consider if this could be productive (tutorials, research, learning) or a distraction.

${userContext}
${taskContext}
${intentionsContext}
${nudgeContext}
${focusContext}

CRITICAL: If the page title or domain is clearly related to one of the user's ACTIVE TASKS, do NOT nudge — they are doing their work.
Use their behavioral profile to decide. If this site matches their known distraction patterns, be more assertive. If they're usually productive at this hour, a gentle reminder is enough.
If an Implementation Intention matches their current distraction (e.g., they are on social media and have an intention for that), use that intention's THEN action as the nudge reason and include the Intention ID.
Respond with ONLY JSON: {"nudge": true/false, "reason": "brief, personalized reason referencing their patterns or an intention", "triggered_intention_id": null_or_number}`;

            const result = await generateWithFallback(ai, {
                model: MODEL_FLASH,
                contents: prompt,
                config: {
                    responseMimeType: 'application/json'
                }
            });
            const text = (result.text || '').trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.nudge) {
                    if (parsed.triggered_intention_id) {
                        try {
                            db.prepare('UPDATE intentions SET times_triggered = times_triggered + 1 WHERE id = ?').run(parsed.triggered_intention_id);
                        } catch { /* ignore */ }
                    }
                    return {
                        shouldNudge: true,
                        message: `⚠️ ${parsed.reason} (${minutesOnSite}min elapsed)`,
                    };
                }
                return { shouldNudge: false, message: '' };
            }
        } catch (err) {
            console.error('AI nudge check failed:', err);
        }
    }

    // Fallback: nudge if over threshold
    if (minutesOnSite >= threshold) {
        return {
            shouldNudge: true,
            message: `⚠️ You've been on ${currentDomain} for ${minutesOnSite} minutes. Time for a break?`,
        };
    }

    return { shouldNudge: false, message: '' };
}

function buildFallbackSummary(date: string, stats: { productiveMinutes: number; distractionMinutes: number; tasksCompleted: number; totalTasks: number; score: number; xp: number }): string {
    return `📊 Daily Report — ${date}\n\n✅ Productive: ${Math.round(stats.productiveMinutes / 60)}h ${stats.productiveMinutes % 60}m\n❌ Distraction: ${Math.round(stats.distractionMinutes / 60)}h ${stats.distractionMinutes % 60}m\n📋 Tasks: ${stats.tasksCompleted}/${stats.totalTasks}\n🏆 Score: ${stats.score}/100 | XP: ${stats.xp}`;
}

function buildFallbackMorningBrief(date: string, data: { pendingTasks: { title: string }[]; streak: number }): string {
    return `🌅 Good morning! — ${date}\n\n📋 ${data.pendingTasks.length} tasks pending\n🔥 Streak: ${data.streak} days\n\nLet's make today count!`;
}
