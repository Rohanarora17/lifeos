import { GoogleGenerativeAI } from '@google/generative-ai';
import { getSetting, getDb } from './db';
import { Category, Subcategory, classifyByRules, CategoryResult } from './categories';
import { buildBehaviorContext, getSmartNudgeContext, buildGoalsContext } from './behavior';

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI | null {
    const apiKey = getSetting('gemini_api_key');
    if (!apiKey) return null;
    if (!genAI) {
        genAI = new GoogleGenerativeAI(apiKey);
    }
    return genAI;
}

// Helper to extract YouTube video ID
function extractYouTubeVideoId(url: string): string | null {
    const videoIdMatch = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    return videoIdMatch ? videoIdMatch[1] : null;
}

export async function classifyActivityBatch(activities: any[]): Promise<(CategoryResult & { reasoning?: string })[]> {
    const results: (CategoryResult & { reasoning?: string })[] = new Array(activities.length);
    const toClassifyIndices: number[] = [];
    const itemsToClassify: { id: number, url: string, domain: string, title?: string, youtube_channel?: string | null }[] = [];
    const missingDomains = new Set<string>();

    const db = getDb();

    // 1. Initial pass: Check DB caches and rules
    for (let i = 0; i < activities.length; i++) {
        const act = activities[i];
        const { url, domain, title } = act;

        // Try rule-based first
        const ruleResult = classifyByRules(url, title || '');
        if (ruleResult && ruleResult.confidence === 'high') {
            results[i] = ruleResult;
            continue;
        }

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
                youtube_channel: act.youtube_channel
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
        const model = ai.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: "You are a precise productivity classification engine."
        });

        // Batch into chunks to avoid prompt limits
        const CHUNK_SIZE = 50;
        for (let i = 0; i < itemsToClassify.length; i += CHUNK_SIZE) {
            const chunk = itemsToClassify.slice(i, i + CHUNK_SIZE);
            const _db = getDb();
            const goalsContext = typeof buildGoalsContext === 'function' ? buildGoalsContext() : '';

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
${memoryContext}

OUTPUT FORMAT (JSON ARRAY):
[
  {
    "id": <input id>,
    "category": "productive|neutral|distraction", 
    "subcategory": "coding|documentation|research|learning|youtube-educational|youtube-entertainment|youtube-music|social-media|news|shopping|gaming|entertainment|communication|productivity-tool|finance|other", 
    "confidence": "high|medium|low",
    "reasoning": "Brief 1-sentence explanation of why"
  }
]

RULES:
- YouTube tutorials, courses, tech talks, coding, educational content → productive / youtube-educational
- YouTube entertainment, vlogs, random browsing → distraction / youtube-entertainment
- YouTube gaming livestreams (e.g., CS:GO, Valorant), unless explicitly educational → distraction / gaming
- YouTube music/ambient/study beats → neutral / youtube-music
- Coding sites, docs, learning platforms → productive
- Social media (Twitter, Instagram, Reddit casual) → distraction
- Reddit programming/tech subreddits → productive / research
- News sites → neutral / news`;

            const result = await model.generateContent(prompt);
            const text = result.response.text().trim();
            const jsonMatch = text.match(/\[[\s\S]*\]/);

            if (jsonMatch) {
                const parsedArray = JSON.parse(jsonMatch[0]);
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
            } else {
                throw new Error("Invalid format returned by AI");
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
        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const behaviorContext = buildBehaviorContext();
        const goalsContext = buildGoalsContext();
        const prompt = `Generate a concise, motivating daily productivity report. Use emojis. Be encouraging but honest about distractions. Keep it under 200 words.

${behaviorContext}
${goalsContext}

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

Use the behavioral profile above to personalize this report. Reference their patterns, progress, and known triggers. Compare today to their usual behavior. Format as a clean report with sections.`;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
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
        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const behaviorContext = buildBehaviorContext();
        const goalsContext = buildGoalsContext();
        const prompt = `Generate a brief, energizing morning briefing. Use emojis. Keep it under 150 words. Be motivating!

${behaviorContext}
${goalsContext}

Date: ${date}
Calendar events today:
${data.calendarEvents.length > 0 ? data.calendarEvents.map(e => `- ${e.title} (${e.start_time} - ${e.end_time})`).join('\n') : '- No meetings scheduled'}

Pending tasks:
${data.pendingTasks.map(t => `- [${t.status}] ${t.title}`).join('\n')}

Yesterday's score: ${data.yesterdayScore}/100
Current streak: ${data.streak} days
Yesterday's distraction time: ${data.yesterdayDistractionMinutes} minutes

Use the behavioral profile to personalize this briefing. Reference their typical patterns and known strengths/weaknesses. Include a motivating message tailored to their motivation style.`;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (err) {
        console.error('AI morning brief failed:', err);
        return buildFallbackMorningBrief(date, data);
    }
}

export async function shouldNudge(url: string, currentDomain: string, minutesOnSite: number, currentTitle: string, videoId?: string | null): Promise<{ shouldNudge: boolean; message: string }> {
    const threshold = parseInt(getSetting('nudge_threshold_minutes') || '15');

    if (minutesOnSite < threshold) {
        return { shouldNudge: false, message: '' };
    }

    // Quick check using rules
    const ruleResult = classifyByRules(url || `https://${currentDomain}`, currentTitle);
    if (ruleResult && ruleResult.category === 'productive') {
        return { shouldNudge: false, message: '' };
    }

    if (ruleResult && ruleResult.category === 'distraction') {
        return {
            shouldNudge: true,
            message: `⚠️ You've been on ${currentDomain} for ${minutesOnSite} minutes. Time to refocus!`,
        };
    }

    // Check cache to save tokens
    const cachedResult = lookupRecentClassification(url, currentDomain, videoId);
    if (cachedResult) {
        if (cachedResult.category === 'productive') {
            return { shouldNudge: false, message: '' };
        }
        if (cachedResult.category === 'distraction') {
            return {
                shouldNudge: true,
                message: `⚠️ ${cachedResult.reasoning || `You've been distracted on ${currentDomain}`}. (${minutesOnSite}min elapsed)`,
            };
        }
    }

    // For YouTube and ambiguous sites, use AI
    const ai = getGenAI();
    if (ai && (currentDomain.includes('youtube') || !ruleResult)) {
        try {
            const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const nudgeContext = getSmartNudgeContext();
            const behaviorContext = buildBehaviorContext();
            const goalsContext = buildGoalsContext();
            const prompt = `A user has been on ${currentDomain} for ${minutesOnSite} minutes. Page title: "${currentTitle}". 
Should they be nudged to get back to work? Consider if this could be productive (tutorials, research, learning) or a distraction.

${behaviorContext}
${goalsContext}
${nudgeContext}

Use their behavioral profile to decide. If this site matches their known distraction patterns, be more assertive. If they're usually productive at this hour, a gentle reminder is enough.
Respond with ONLY JSON: {"nudge": true/false, "reason": "brief, personalized reason referencing their patterns"}`;

            const result = await model.generateContent(prompt);
            const text = result.response.text().trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.nudge) {
                    return {
                        shouldNudge: true,
                        message: `⚠️ ${parsed.reason} (${minutesOnSite}min on ${currentDomain})`,
                    };
                }
                return { shouldNudge: false, message: '' };
            }
        } catch (err) {
            console.error('AI nudge check failed:', err);
        }
    }

    // Fallback: nudge if over threshold and not clearly productive
    if (minutesOnSite >= threshold && (!ruleResult || ruleResult.category !== 'productive')) {
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
