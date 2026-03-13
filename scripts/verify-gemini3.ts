/**
 * verify-gemini3.ts
 * Tests all Gemini 3 model calls that were upgraded in LifeOS.
 * Run with: npx tsx scripts/verify-gemini3.ts
 */

import { GoogleGenAI } from '@google/genai';
import * as path from 'path';
import * as fs from 'fs';

// Manually parse .env file (no dotenv dep needed)
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) process.env[key] = val;
    }
}

const MODEL_PRO = 'gemini-3.1-pro-preview';
const MODEL_FLASH = 'gemini-3-flash-preview';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

if (!GEMINI_API_KEY && !GCP_PROJECT_ID) {
    console.error('❌ No GEMINI_API_KEY/API_KEY or GCP_PROJECT_ID found in .env');
    process.exit(1);
}

// Mirror exactly the same priority logic as the fixed getGenAI() in ai.ts:
// - API key present → standard Gemini Developer API (works with GCP API keys)
// - No API key but project ID → Vertex AI via Application Default Credentials
let ai: GoogleGenAI;
if (GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log('[init] Using standard Gemini Developer API (API key)');
} else {
    const location = process.env.GCP_LOCATION || 'us-central1';
    // @ts-ignore
    ai = new GoogleGenAI({ vertexai: { project: GCP_PROJECT_ID, location } });
    console.log(`[init] Using Vertex AI ADC — project: ${GCP_PROJECT_ID}`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type TestResult = {
    name: string;
    model: 'PRO' | 'FLASH';
    modelId: string;
    passed: boolean;
    latencyMs: number;
    output?: string;
    error?: string;
};

const results: TestResult[] = [];

async function runTest(
    name: string,
    modelType: 'PRO' | 'FLASH',
    fn: (model: string) => Promise<string>
): Promise<void> {
    const modelId = modelType === 'PRO' ? MODEL_PRO : MODEL_FLASH;
    const start = Date.now();
    try {
        const output = await fn(modelId);
        const latencyMs = Date.now() - start;
        const preview = output.slice(0, 120).replace(/\n/g, ' ');
        console.log(`  ✅ [${modelType} / ${latencyMs}ms] ${name}`);
        console.log(`     └─ ${preview}...`);
        results.push({ name, model: modelType, modelId, passed: true, latencyMs, output: preview });
    } catch (err: any) {
        const latencyMs = Date.now() - start;
        console.error(`  ❌ [${modelType} / ${latencyMs}ms] ${name}`);
        console.error(`     └─ ${err.message}`);
        results.push({ name, model: modelType, modelId, passed: false, latencyMs, error: err.message });
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  LifeOS — Gemini 3 Model Verification');
    console.log('═══════════════════════════════════════════════════════════\n');

    // ── 1. Flash: Activity Classification (ai.ts → classifyActivityBatch)
    await runTest('Activity Classification (Flash)', 'FLASH', async (model) => {
        const prompt = `Classify these activities as productive/distraction/neutral with subcategory. Return JSON array.
Activities:
[
  {"id":0,"url":"https://github.com/vercel/next.js","domain":"github.com","title":"Next.js Repository"},
  {"id":1,"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","domain":"youtube.com","title":"Rick Astley - Never Gonna Give You Up"},
  {"id":2,"url":"https://stackoverflow.com/questions/12345","domain":"stackoverflow.com","title":"How to fix React useState bug"}
]
Return format: [{"id":0,"category":"productive","subcategory":"coding","confidence":"high"},...]`;

        const result = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });
        const text = result.text || '';
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('Expected array of 3');
        if (!parsed[0].category) throw new Error('Missing category field');
        return JSON.stringify(parsed, null, 2);
    });

    // ── 2. Flash: Nudge Decision (ai.ts → shouldNudge)
    await runTest('Nudge Decision (Flash)', 'FLASH', async (model) => {
        const prompt = `A user has been on twitter.com for 15 minutes. Page title: "Twitter / Home". 
Should they be nudged to get back to work? They have an active goal: "Ship LifeOS v2.0 by end of month".
Respond with ONLY JSON: {"nudge": true/false, "reason": "brief personalized reason"}`;

        const result = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });
        const text = result.text || '';
        const parsed = JSON.parse(text);
        if (parsed.nudge === undefined) throw new Error('Missing nudge field');
        if (!parsed.reason) throw new Error('Missing reason field');
        return JSON.stringify(parsed);
    });

    // ── 3. Flash: Distraction Evaluation (extension/evaluate/route.ts)
    await runTest('Distraction Evaluation (Flash)', 'FLASH', async (model) => {
        const prompt = `You are a strict but fair productivity AI. The user is in an ACTIVE FOCUS SESSION.
FOCUS TARGET: Goal: "Complete ML assignment"
The user just opened: URL: "https://instagram.com" Title: "Instagram"
Return JSON: { "isDistraction": boolean, "reason": "1-sentence explanation", "confidence": 0.0 to 1.0 }`;

        const result = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });
        const parsed = JSON.parse(result.text || '');
        if (parsed.isDistraction === undefined) throw new Error('Missing isDistraction field');
        if (parsed.confidence === undefined) throw new Error('Missing confidence field');
        return JSON.stringify(parsed);
    });

    // ── 4. Flash: Task Extraction (extension/tasks/route.ts)
    await runTest('Task Extraction from Text (Flash)', 'FLASH', async (model) => {
        const prompt = `You are an AI Task Extractor. The user highlighted text on a webpage:
Webpage Title: "CS229 Machine Learning - Week 5 Notes"
URL: "https://cs229.stanford.edu/notes/week5.pdf"
Highlighted Text: "Implement gradient descent for logistic regression and test on the MNIST dataset"
Extract an actionable task. Return JSON:
{ "title": "Short actionable task title", "description": "Context", "priority": "low"|"medium"|"high"|"critical", "goal_id": null }`;

        const result = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });
        const parsed = JSON.parse(result.text || '');
        if (!parsed.title) throw new Error('Missing title field');
        if (!parsed.priority) throw new Error('Missing priority field');
        return JSON.stringify(parsed);
    });

    // ── 5. Flash: NL → SQL Translation (chat/route.ts)
    await runTest('NL to SQL Translation (Flash)', 'FLASH', async (model) => {
        const schema = `TABLE activities (id, url, domain, title, category, duration_seconds, started_at)
TABLE tasks (id, title, status, priority, completed_at)
TABLE habits (id, name, icon, current_streak)`;

        const prompt = `You are an expert SQL translation layer for an SQLite database.
Schema: ${schema}
Convert to SQL: "How many hours did I spend on productive sites today?"
Return ONLY the raw SQL query, no markdown.`;

        const result = await ai.models.generateContent({ model, contents: prompt });
        const sql = (result.text || '').trim();
        if (!sql.toUpperCase().includes('SELECT')) throw new Error('Response is not a SELECT query');
        return sql;
    });

    // ── 6. Pro: Daily Summary (ai.ts → generateDailySummary)
    await runTest('Daily Summary Generation (Pro)', 'PRO', async (model) => {
        const prompt = `You are a productivity coach. Generate a brief daily summary for this data:
Date: 2026-03-13
Productive time: 4h 23m
Distraction time: 47m  
Tasks completed: 3/5
Habits done: 4/6
GitHub commits: 2
Top sites: github.com (2h), stackoverflow.com (1h), youtube.com (47m)
Write a 3-sentence personalized summary.`;

        const result = await ai.models.generateContent({ model, contents: prompt });
        const text = result.text || '';
        if (text.length < 50) throw new Error('Summary too short');
        return text;
    });

    // ── 7. Pro: Morning Brief (ai.ts → generateMorningBrief)
    await runTest('Morning Brief Generation (Pro)', 'PRO', async (model) => {
        const prompt = `You are an elite productivity coach writing a morning briefing.
User profile: Developer working on LifeOS. Chronotype: early bird. Streak: 12 days.
Pending tasks: Fix auth bug (critical), Write tests, Deploy to staging.
Yesterday's score: 72/100.
Generate a 2-sentence motivational morning brief with an implementation intention.`;

        const result = await ai.models.generateContent({ model, contents: prompt });
        const text = result.text || '';
        if (text.length < 50) throw new Error('Brief too short');
        return text;
    });

    // ── 8. Pro: Chat Answer Synthesis (chat/route.ts)
    await runTest('Chat Answer Synthesis (Pro)', 'PRO', async (model) => {
        const prompt = `You are LifeOS, the user's personal assistant.
The user asked: "How did I do on my habits this week?"
The database returned this raw JSON data:
[{"name":"Morning Run","streak":4,"completed_this_week":5},{"name":"Read 30 min","streak":2,"completed_this_week":3},{"name":"No Phone Before 8am","streak":0,"completed_this_week":1}]
Provide a concise, conversational answer. Do not show them the raw JSON.`;

        const result = await ai.models.generateContent({ model, contents: prompt });
        const text = result.text || '';
        if (text.length < 30) throw new Error('Answer too short');
        return text;
    });

    // ── 9. Pro: Focus Session Report (focus-session/route.ts)
    await runTest('Focus Session Report (Pro)', 'PRO', async (model) => {
        const prompt = `Generate a brief focus session report (2-3 sentences max):
Goal: Study Machine Learning — Chapter 3
Duration: 45 minutes actual / 60 planned
Productive: 32 min, Distracted: 13 min (YouTube, Instagram)
Distractions blocked: 3, Overrides: 1
Rate this session out of 10 and give one actionable tip.`;

        const result = await ai.models.generateContent({ model, contents: prompt });
        const text = result.text || '';
        if (text.length < 30) throw new Error('Report too short');
        return text;
    });

    // ── 10. Pro: Behavioral Deep Analysis (behavior.ts)
    await runTest('Behavioral Deep Analysis (Pro)', 'PRO', async (model) => {
        const prompt = `Analyze this user's behavioral data and return JSON with insights and a personality_summary.
Data: 
- Average focus session: 47 min
- Peak productive hours: 9am-12pm
- Distraction trigger: YouTube after lunch (2pm-3pm)
- Habit streak: Morning Run (7 days), Reading (2 days)
- Task completion rate: 65%

Return JSON: {"personality_summary": "2 sentences", "insights": [{"category": "focus", "insight": "observation", "tip": "advice", "severity": "info"}]}`;

        const result = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });
        const parsed = JSON.parse(result.text || '');
        if (!parsed.personality_summary) throw new Error('Missing personality_summary');
        if (!Array.isArray(parsed.insights)) throw new Error('Missing insights array');
        return JSON.stringify({ summary_preview: parsed.personality_summary.slice(0, 80), insight_count: parsed.insights.length });
    });

    // ── 11. Pro: Deep Correlation Analysis (ai_analytics.ts)
    await runTest('Deep Correlation Analysis (Pro)', 'PRO', async (model) => {
        const prompt = `You are a behavioral data scientist. Find hidden patterns in this 7-day matrix:
Date | ProdMins | DistractMins | Tasks | Habits
2026-03-07 | 180 | 45 | 3 | [Morning Run, Read]
2026-03-08 | 90 | 120 | 1 | []
2026-03-09 | 210 | 30 | 5 | [Morning Run, Read, Meditation]
2026-03-10 | 85 | 95 | 1 | []
2026-03-11 | 195 | 40 | 4 | [Morning Run, Read]
2026-03-12 | 200 | 35 | 4 | [Morning Run, Meditation]
2026-03-13 | 170 | 50 | 3 | [Morning Run]

Return a JSON array of 2 insights: [{"type": "correlation"|"warning"|"praise", "insight": "specific data-driven finding"}]`;

        const result = await ai.models.generateContent({ model, contents: prompt });
        const text = result.text || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array in response');
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed) || parsed.length < 1) throw new Error('Expected array with insights');
        return JSON.stringify(parsed);
    });

    // ── 12. Pro: Photo Proof Verification (proof/route.ts) — text only simulation
    await runTest('Photo Proof Verification (Pro) — simulated', 'PRO', async (model) => {
        const prompt = `You are a strict AI verification agent.
The user claims to have completed their habit: "Morning Run".
EXIF metadata from their uploaded photo: {"GPSLatitude": 37.77, "GPSLongitude": -122.42, "DateTime": "2026:03:13 07:23:14", "Make": "Apple", "Model": "iPhone 15"}
The image description (simulated): A person in running gear outdoors on a path, morning light, fitness watch visible.
Does this verify the habit? Return JSON: {"verified": boolean, "reason": "explanation"}`;

        const result = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });
        const parsed = JSON.parse(result.text || '');
        if (parsed.verified === undefined) throw new Error('Missing verified field');
        if (!parsed.reason) throw new Error('Missing reason field');
        return JSON.stringify(parsed);
    });

    // ─── Summary ──────────────────────────────────────────────────────────────

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');

    const passed = results.filter(r => r.passed);
    const failed = results.filter(r => !r.passed);
    const flashResults = results.filter(r => r.model === 'FLASH');
    const proResults = results.filter(r => r.model === 'PRO');

    console.log(`  Total: ${results.length} tests | ✅ ${passed.length} passed | ❌ ${failed.length} failed`);
    console.log(`  Flash avg latency: ${Math.round(flashResults.filter(r => r.passed).reduce((s, r) => s + r.latencyMs, 0) / Math.max(flashResults.filter(r => r.passed).length, 1))}ms`);
    console.log(`  Pro avg latency:   ${Math.round(proResults.filter(r => r.passed).reduce((s, r) => s + r.latencyMs, 0) / Math.max(proResults.filter(r => r.passed).length, 1))}ms`);

    if (failed.length > 0) {
        console.log('\n  ❌ Failed tests:');
        failed.forEach(r => console.log(`     • ${r.name}: ${r.error}`));
    }

    console.log('\n  Per-test breakdown:');
    results.forEach(r => {
        const status = r.passed ? '✅' : '❌';
        console.log(`  ${status} ${r.model.padEnd(5)} ${r.latencyMs.toString().padStart(5)}ms  ${r.name}`);
    });

    console.log('\n═══════════════════════════════════════════════════════════\n');

    // Write results to file for reference
    fs.writeFileSync(
        path.join(__dirname, 'gemini3-verification-results.json'),
        JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
    );
    console.log('  Results saved to scripts/gemini3-verification-results.json\n');

    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
