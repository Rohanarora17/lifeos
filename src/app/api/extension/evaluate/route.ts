import { NextRequest, NextResponse } from 'next/server';
import { getGenAI } from '@/lib/ai';

// Domains that should NEVER be blocked during focus sessions to prevent false positives
const ALWAYS_ALLOW_DOMAINS = new Set([
    // Search engines
    'google.com', 'www.google.com', 'bing.com', 'duckduckgo.com',
    // Code hosting
    'github.com', 'gitlab.com', 'bitbucket.org',
    // Dev Q&A
    'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com',
    // Documentation
    'developer.mozilla.org', 'mdn.io', 'docs.python.org', 'docs.rs',
    'learn.microsoft.com', 'devdocs.io', 'w3schools.com',
    // Reference
    'wikipedia.org', 'en.wikipedia.org',
    // Local development
    'localhost',
    // Productivity tools
    'notion.so', 'docs.google.com', 'drive.google.com', 'sheets.google.com',
    'trello.com', 'linear.app', 'figma.com',
    // AI tools
    'chat.openai.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com',
    'copilot.microsoft.com',
    // Package registries
    'npmjs.com', 'www.npmjs.com', 'pypi.org', 'crates.io',
]);

function isDomainAlwaysAllowed(domain: string): boolean {
    if (ALWAYS_ALLOW_DOMAINS.has(domain)) return true;
    for (const allowed of ALWAYS_ALLOW_DOMAINS) {
        if (domain.endsWith('.' + allowed)) return true;
    }
    return false;
}

// POST: Evaluates if a given URL is a distraction based on the user's active goals
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { url, title, activeGoals, focusMode, focusGoalTitle, focusTaskTitle } = body;

        if (!url) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
        }

        // Extract domain for always-allow check
        let domain = '';
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { }

        // Always-allow domains are never blocked (prevents false positives on docs/search/code)
        if (isDomainAlwaysAllowed(domain)) {
            return NextResponse.json({
                isDistraction: false,
                reason: 'Essential tool — always allowed during focus.',
                confidence: 1.0,
                alwaysAllowed: true,
            });
        }

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ isDistraction: false, reason: 'AI not configured — defaulting to allow', confidence: 0 });

        let prompt: string;

        if (focusMode && (focusGoalTitle || focusTaskTitle)) {
            // FOCUS SESSION MODE: stricter evaluation against the specific task/goal
            prompt = `You are a strict but fair productivity AI embedded in the user's browser. The user is in an ACTIVE FOCUS SESSION.

FOCUS TARGET:
${focusGoalTitle ? `- Goal: "${focusGoalTitle}"` : ''}
${focusTaskTitle ? `- Task: "${focusTaskTitle}"` : ''}

The user just opened a page:
URL: "${url}"
Title: "${title}"

RULES:
1. If this page is DIRECTLY relevant to the focus target (the specific goal or task above), ALLOW it.
2. If this page is a general productivity/development tool that COULD help with the task, ALLOW it. Be generous with tools.
3. If this page is clearly entertainment, social media browsing, or unrelated news, BLOCK it.
4. If you're uncertain whether the page is relevant, ALLOW it. Better to let through than to block something needed.
5. YouTube: block UNLESS the video title/channel suggests educational content directly related to the focus target.
6. Reddit/Twitter/Instagram/TikTok: block unless the specific subreddit/post is clearly about the focus topic.

Return JSON: { "isDistraction": boolean, "reason": "1-sentence supportive explanation", "confidence": 0.0 to 1.0 }
Only set confidence above 0.8 if you're very sure. Below 0.5 means uncertain — we will default to ALLOW.`;
        } else {
            // NORMAL MODE: evaluate against all active goals
            const goalsList = (activeGoals || []).map((g: any) => `- ${g.title}: ${g.description || ''}`).join('\n');

            if (!goalsList) {
                return NextResponse.json({ isDistraction: false, reason: 'No active goals — all browsing allowed.', confidence: 1.0 });
            }

            prompt = `You are a strict but fair productivity AI built into the user's browser.
The user's currently active goals are:
${goalsList}

The user just opened a new tab:
URL: "${url}"
Title: "${title}"

Is this website a distraction from ALL of their active goals?
If the website is a general tool (e.g. Wikipedia, a blog, a coding resource) and it aligns with their goals, allow it.
If the website is a known universal time-sink (e.g. YouTube, Twitter, Instagram, Reddit) AND does not align specifically with their goals, block it.
If they have no active goals, do not block it.

Return JSON: { "isDistraction": boolean, "reason": "1-sentence supportive explanation", "confidence": 0.0 to 1.0 }`;
        }

        const result = await ai.models.generateContent({
            model: 'gemini-flash-latest',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
            }
        });

        const evaluation = JSON.parse(result.text || '{}');

        // In focus mode, only block if confidence is high enough (prevent false positives)
        if (focusMode && evaluation.confidence !== undefined && evaluation.confidence < 0.6) {
            evaluation.isDistraction = false;
            evaluation.reason = `Uncertain (${Math.round(evaluation.confidence * 100)}% confidence) — allowing to prevent false positive.`;
        }

        return NextResponse.json(evaluation);
    } catch (error) {
        console.error('Extension Evaluate API Error:', error);
        // Fail open - don't block if the AI fails
        return NextResponse.json({ isDistraction: false, reason: 'AI Error — Defaulting to Allow', confidence: 0 });
    }
}
