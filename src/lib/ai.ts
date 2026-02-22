import { GoogleGenerativeAI } from '@google/generative-ai';
import { getSetting } from './db';
import { Category, Subcategory, classifyByRules, CategoryResult } from './categories';
import { buildBehaviorContext, getSmartNudgeContext } from './behavior';

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI | null {
    const apiKey = getSetting('gemini_api_key');
    if (!apiKey) return null;
    if (!genAI) {
        genAI = new GoogleGenerativeAI(apiKey);
    }
    return genAI;
}

export async function classifyActivityBatch(activities: any[]): Promise<(CategoryResult & { reasoning?: string })[]> {
    const results: (CategoryResult & { reasoning?: string })[] = new Array(activities.length);
    const toClassifyIndices: number[] = [];
    const itemsToClassify: any[] = [];

    // First pass: local rules and caching
    for (let i = 0; i < activities.length; i++) {
        const act = activities[i];

        // Try rule-based first
        const ruleResult = classifyByRules(act.url, act.title || '');
        if (ruleResult && ruleResult.confidence === 'high') {
            results[i] = ruleResult;
            continue;
        }

        // Check recent cache (last 24 hours) for this specific domain or video
        const cacheResult = lookupRecentClassification(act.url, act.domain, act.youtube_video_id);
        if (cacheResult) {
            results[i] = cacheResult;
            continue;
        }

        // Add to AI classification queue
        toClassifyIndices.push(i);
        itemsToClassify.push({
            id: i,
            url: act.url,
            title: act.title || '',
            domain: act.domain,
            youtube_channel: act.youtube_channel || null
        });
    }

    if (itemsToClassify.length === 0) {
        return results;
    }

    // Second pass: Send unknown batch to Gemini
    const ai = getGenAI();
    if (!ai) {
        for (const idx of toClassifyIndices) {
            results[idx] = { category: 'neutral', subcategory: 'other', confidence: 'low', reasoning: 'AI not configured' };
        }
        return results;
    }

    try {
        const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

        // Chunk sizes to prevent hitting output token limits (e.g. max 15 per prompt)
        const CHUNK_SIZE = 15;
        for (let i = 0; i < itemsToClassify.length; i += CHUNK_SIZE) {
            const chunk = itemsToClassify.slice(i, i + CHUNK_SIZE);
            const prompt = `Classify these browsing activities for a productivity tracker. Respond ONLY with a valid JSON ARRAY of objects, matching the exact input order. Do not use markdown blocks.
            
INPUT:
${JSON.stringify(chunk, null, 2)}

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
                        results[originalIdx] = {
                            category: parsed.category as Category,
                            subcategory: parsed.subcategory as Subcategory,
                            confidence: parsed.confidence || 'medium',
                            reasoning: parsed.reasoning
                        };
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
        const { getDb } = require('./db');
        const db = getDb();

        let query = `
            SELECT category, subcategory, ai_classification 
            FROM activities 
            WHERE 
        `;
        let params: string[] = [];

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
        const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const behaviorContext = buildBehaviorContext();
        const prompt = `Generate a concise, motivating daily productivity report. Use emojis. Be encouraging but honest about distractions. Keep it under 200 words.

${behaviorContext}

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
        const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const behaviorContext = buildBehaviorContext();
        const prompt = `Generate a brief, energizing morning briefing. Use emojis. Keep it under 150 words. Be motivating!

${behaviorContext}

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
            const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const nudgeContext = getSmartNudgeContext();
            const behaviorContext = buildBehaviorContext();
            const prompt = `A user has been on ${currentDomain} for ${minutesOnSite} minutes. Page title: "${currentTitle}". 
Should they be nudged to get back to work? Consider if this could be productive (tutorials, research, learning) or a distraction.

${behaviorContext}
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
