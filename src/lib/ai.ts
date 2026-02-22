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

export async function classifyActivity(url: string, title: string, domain: string, youtubeChannel?: string): Promise<CategoryResult> {
    // Try rule-based first
    const ruleResult = classifyByRules(url, title);
    if (ruleResult && ruleResult.confidence === 'high') {
        return ruleResult;
    }

    // Use AI for ambiguous cases
    const ai = getGenAI();
    if (!ai) {
        return ruleResult || { category: 'neutral' as Category, subcategory: 'other' as Subcategory, confidence: 'low' as const };
    }

    try {
        const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `Classify this browsing activity for a productivity tracker. Respond ONLY with valid JSON, no markdown.

URL: ${url}
Title: ${title}
Domain: ${domain}
${youtubeChannel ? `YouTube Channel: ${youtubeChannel}` : ''}

Respond with exactly this JSON structure:
{"category": "productive|neutral|distraction", "subcategory": "coding|documentation|research|learning|youtube-educational|youtube-entertainment|youtube-music|social-media|news|shopping|gaming|entertainment|communication|productivity-tool|finance|other", "confidence": "high|medium|low"}

Rules:
- YouTube tutorials, courses, tech talks, educational content → productive / youtube-educational
- YouTube entertainment, vlogs, random browsing → distraction / youtube-entertainment
- YouTube music/ambient → neutral / youtube-music
- Coding sites, docs, learning platforms → productive
- Social media (Twitter, Instagram, Reddit casual) → distraction
- Reddit programming/tech subreddits → productive / research
- News sites → neutral / news`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                category: parsed.category as Category,
                subcategory: parsed.subcategory as Subcategory,
                confidence: parsed.confidence || 'medium',
            };
        }
    } catch (err) {
        console.error('AI classification failed:', err);
    }

    return ruleResult || { category: 'neutral' as Category, subcategory: 'other' as Subcategory, confidence: 'low' as const };
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
        const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
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
        const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
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

export async function shouldNudge(currentDomain: string, minutesOnSite: number, currentTitle: string): Promise<{ shouldNudge: boolean; message: string }> {
    const threshold = parseInt(getSetting('nudge_threshold_minutes') || '15');

    if (minutesOnSite < threshold) {
        return { shouldNudge: false, message: '' };
    }

    // Quick check using rules
    const ruleResult = classifyByRules(`https://${currentDomain}`, currentTitle);
    if (ruleResult && ruleResult.category === 'productive') {
        return { shouldNudge: false, message: '' };
    }

    if (ruleResult && ruleResult.category === 'distraction') {
        return {
            shouldNudge: true,
            message: `⚠️ You've been on ${currentDomain} for ${minutesOnSite} minutes. Time to refocus!`,
        };
    }

    // For YouTube and ambiguous sites, use AI
    const ai = getGenAI();
    if (ai && (currentDomain.includes('youtube') || !ruleResult)) {
        try {
            const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
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
