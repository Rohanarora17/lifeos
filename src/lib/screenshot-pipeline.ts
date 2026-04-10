// src/lib/screenshot-pipeline.ts
// Always-on screenshot pipeline: capture → Gemini Vision → store description → delete image

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDb } from './db';
import { getActiveGuardianSession } from './guardian-runtime';

const execAsync = promisify(exec);

// ─── Privacy Safeguards ──────────────────────────────────────────────────────

// Window titles that indicate password fields or sensitive content — skip these
const SENSITIVE_TITLE_PATTERNS = [
  /password/i,
  /1password/i,
  /keychain/i,
  /bitwarden/i,
  /lastpass/i,
  /ssh/i,
  /private key/i,
];

let paused = false;
let lastCaptureAt = 0;
const MIN_INTERVAL_MS = 55 * 1000; // 55 seconds minimum between captures

export function pauseScreenshots(): void {
  paused = true;
  console.log('[Screenshot] Pipeline paused.');
}

export function resumeScreenshots(): void {
  paused = false;
  console.log('[Screenshot] Pipeline resumed.');
}

export function isScreenshotsPaused(): boolean {
  return paused;
}

// ─── Core Capture + Analyze ──────────────────────────────────────────────────

export async function captureAndAnalyze(): Promise<void> {
  if (paused) return;

  // Rate limit: never capture faster than MIN_INTERVAL_MS
  const now = Date.now();
  if (now - lastCaptureAt < MIN_INTERVAL_MS) return;
  lastCaptureAt = now;

  // Only run during waking hours (7am - 11pm local time)
  const hour = new Date().getHours();
  if (hour < 7 || hour >= 23) return;

  const imagePath = path.join(os.tmpdir(), `lifeos_screen_${Date.now()}.jpg`);

  try {
    // Capture screenshot (JPEG, quality 50 — enough for analysis, smaller payload)
    await execAsync(`/usr/sbin/screencapture -x -t jpg "${imagePath}"`);

    if (!fs.existsSync(imagePath)) {
      console.error('[Screenshot] screencapture produced no file');
      return;
    }

    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');

    // Delete immediately — raw image never persists beyond this point
    fs.unlinkSync(imagePath);

    // Analyze with Gemini Vision
    const description = await analyzeWithGemini(base64Image);
    if (!description) return;

    // Store description
    await storeObservation(description);

  } catch (err) {
    // Always clean up the image file even on error
    if (fs.existsSync(imagePath)) {
      try { fs.unlinkSync(imagePath); } catch {}
    }
    console.error('[Screenshot] captureAndAnalyze failed:', err);
  }
}

// ─── Gemini Vision Analysis ──────────────────────────────────────────────────

interface ScreenAnalysis {
  activity: string;
  category: 'deep_work' | 'shallow_work' | 'communication' | 'consumption' | 'distraction' | 'idle';
  app: string;
  content_type: string;
  attention_quality: 'focused' | 'browsing' | 'consuming' | 'distracted' | 'idle';
  specific_content: string;
  productive_for_goals: boolean;
  confidence: number;
}

async function analyzeWithGemini(base64Image: string): Promise<ScreenAnalysis | null> {
  try {
    // Dynamic import to avoid circular deps
    const { GoogleGenAI } = await import('@google/genai');
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[Screenshot] No Gemini API key');
      return null;
    }

    const genai = new GoogleGenAI({ apiKey });

    const prompt = `Analyze this screenshot and return ONLY a JSON object describing what the person is doing.

Return this exact JSON structure:
{
  "activity": "brief description of what they are doing",
  "category": one of: "deep_work"|"shallow_work"|"communication"|"consumption"|"distraction"|"idle",
  "app": "app name (Chrome, VS Code, etc.)",
  "content_type": "video|code|article|email|social|document|idle|other",
  "attention_quality": "focused"|"browsing"|"consuming"|"distracted"|"idle",
  "specific_content": "specific description: YouTube video title, file name, website, etc.",
  "productive_for_goals": true or false,
  "confidence": 0.0 to 1.0
}

Categories:
- deep_work: writing code, writing documents, reading technical material, focused problem-solving
- shallow_work: email, Slack, calendar, light admin tasks
- communication: video calls, messaging
- consumption: YouTube, Twitter, Instagram, news, Reels, entertainment browsing
- distraction: same as consumption but clearly unrelated to any productive goal
- idle: screen locked, wallpaper, nothing open

Return ONLY the JSON. No markdown, no explanation.`;

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    const contents = [
      {
        role: 'user' as const,
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        ],
      },
    ];

    let lastErr: unknown;
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await genai.models.generateContent({ model, contents });
          const text = result.text?.trim() ?? '';
          const parsed = JSON.parse(text) as ScreenAnalysis;
          return parsed;
        } catch (err: unknown) {
          lastErr = err;
          const msg = String(err);
          const is503 = msg.includes('503') || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('overloaded');
          if (is503 && attempt < 2) {
            const delay = (attempt + 1) * 3000;
            console.warn(`[Screenshot] ${model} 503, retry in ${delay}ms (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          // Non-503 or exhausted retries — try next model
          console.warn(`[Screenshot] ${model} failed: ${msg}`);
          break;
        }
      }
    }
    console.error('[Screenshot] All models failed:', lastErr);
    return null;
  } catch (err) {
    console.error('[Screenshot] Gemini Vision analysis failed:', err);
    return null;
  }
}

// ─── External buffer entry point (extension screenshots) ─────────────────────

interface ExtensionScreenshotContext {
  url?: string;
  title?: string;
  sessionId?: string | null;
  source?: string;
}

export async function captureAndAnalyzeBuffer(
  imageBuffer: Buffer,
  ctx: ExtensionScreenshotContext = {}
): Promise<void> {
  try {
    const base64Image = imageBuffer.toString('base64');
    const description = await analyzeWithGemini(base64Image);
    if (!description) return;
    await storeObservation(description, ctx.sessionId ?? null, ctx.source ?? 'extension_screenshot');
  } catch (err) {
    console.error('[Screenshot] captureAndAnalyzeBuffer failed:', err);
  }
}

// ─── Store Observation ───────────────────────────────────────────────────────

async function storeObservation(
  analysis: ScreenAnalysis,
  overrideSessionId?: string | null,
  source: string = 'screenshot'
): Promise<void> {
  const db = getDb();
  const session = getActiveGuardianSession();
  const sessionId = overrideSessionId !== undefined ? overrideSessionId : (session?.sessionId ?? null);

  db.prepare(`
    INSERT INTO screen_observations
      (observed_at, source, app, activity, category, content_type, attention_quality, specific_content, productive_for_goals, confidence, session_id)
    VALUES
      (datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source,
    analysis.app,
    analysis.activity,
    analysis.category,
    analysis.content_type,
    analysis.attention_quality,
    analysis.specific_content,
    analysis.productive_for_goals ? 1 : 0,
    analysis.confidence,
    sessionId,
  );
}

// ─── Query Helpers (used by continuity guardian) ─────────────────────────────

export interface RecentObservationSummary {
  categoryBreakdown: Record<string, number>; // category → hours
  lastObservedAt: string | null;
  dominantCategory: string | null;
  dominantApp: string | null;
  consecutiveDistractionHours: number;
  specificContents: string[];
}

export function getRecentObservations(lookbackMinutes: number = 180): RecentObservationSummary {
  const db = getDb();
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const rows = db.prepare(`
    SELECT category, app, specific_content, observed_at
    FROM screen_observations
    WHERE observed_at >= ? AND source = 'screenshot'
    ORDER BY observed_at DESC
  `).all(since) as Array<{ category: string; app: string; specific_content: string; observed_at: string }>;

  if (rows.length === 0) {
    return { categoryBreakdown: {}, lastObservedAt: null, dominantCategory: null, dominantApp: null, consecutiveDistractionHours: 0, specificContents: [] };
  }

  // Each observation represents ~1 minute
  const categoryBreakdown: Record<string, number> = {};
  const appCounts: Record<string, number> = {};

  for (const row of rows) {
    categoryBreakdown[row.category] = (categoryBreakdown[row.category] || 0) + 1 / 60; // minutes → hours
    appCounts[row.app] = (appCounts[row.app] || 0) + 1;
  }

  const dominantCategory = Object.entries(categoryBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const dominantApp = Object.entries(appCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Count consecutive distraction hours from most recent
  let consecutiveDistractionMinutes = 0;
  for (const row of rows) {
    if (row.category === 'distraction' || row.category === 'consumption') {
      consecutiveDistractionMinutes++;
    } else {
      break; // Stop at first non-distraction
    }
  }

  const specificContents = [...new Set(rows.slice(0, 10).map(r => r.specific_content).filter(Boolean))];

  return {
    categoryBreakdown: Object.fromEntries(Object.entries(categoryBreakdown).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    lastObservedAt: rows[0]?.observed_at ?? null,
    dominantCategory,
    dominantApp,
    consecutiveDistractionHours: Math.round(consecutiveDistractionMinutes / 60 * 10) / 10,
    specificContents,
  };
}
