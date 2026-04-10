import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

interface DaemonPayload {
  timestamp: string;
  frontmost_app: string;
  window_title: string;
  idle_seconds: number;
  machine_state: 'active' | 'idle';
  audio_playing: boolean;
  running_apps: string[];
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    // Extension screenshot: multipart form with JPEG blob
    if (contentType.includes('multipart/form-data')) {
      return handleExtensionScreenshot(request);
    }

    // Mac Mini daemon: JSON payload
    const payload = await request.json() as DaemonPayload;
    const db = getDb();

    const category = classifyApp(payload.frontmost_app, payload.window_title, payload.idle_seconds);

    db.prepare(`
      INSERT INTO screen_observations
        (observed_at, source, app, window_title, activity, category, attention_quality, productive_for_goals, confidence)
      VALUES
        (?, 'daemon', ?, ?, ?, ?, ?, 0, 0.7)
    `).run(
      payload.timestamp,
      payload.frontmost_app,
      payload.window_title,
      `${payload.frontmost_app}: ${payload.window_title}`.slice(0, 200),
      category,
      payload.idle_seconds > 300 ? 'idle' : 'focused',
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Daemon Ingest] Error:', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

async function handleExtensionScreenshot(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const screenshotBlob = form.get('screenshot') as Blob | null;
    const source = (form.get('source') as string | null) || 'extension_screenshot';

    // macbook_daemon: has app/title metadata + optional screenshot
    if (source === 'macbook_daemon') {
      const app = (form.get('app') as string | null) || '';
      const title = (form.get('title') as string | null) || '';
      const idleSeconds = parseInt((form.get('idle_seconds') as string | null) || '0', 10);
      const sessionId = (form.get('sessionId') as string | null);

      if (screenshotBlob && screenshotBlob.size > 0) {
        // Full screenshot + Gemini Vision analysis
        void analyzeExtensionScreenshot(screenshotBlob, app, title, sessionId, 'macbook_daemon');
      } else {
        // No screenshot — store app/title as a lightweight observation
        const { getDb } = await import('@/lib/db');
        const db = getDb();
        const category = classifyApp(app, title, idleSeconds);
        db.prepare(`
          INSERT INTO screen_observations
            (observed_at, source, app, window_title, activity, category, attention_quality, productive_for_goals, confidence)
          VALUES (datetime('now','localtime'), 'macbook_daemon', ?, ?, ?, ?, ?, 0, 0.6)
        `).run(app, title, `${app}: ${title}`.slice(0, 200), category, idleSeconds > 300 ? 'idle' : 'focused');
      }
      return NextResponse.json({ ok: true });
    }

    // Extension screenshot (browser tab capture)
    if (!screenshotBlob) {
      return NextResponse.json({ error: 'Missing screenshot' }, { status: 400 });
    }
    const url = (form.get('url') as string | null) || '';
    const title = (form.get('title') as string | null) || '';
    const sessionId = (form.get('sessionId') as string | null);

    void analyzeExtensionScreenshot(screenshotBlob, url, title, sessionId, source);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Extension Screenshot] Error:', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

async function analyzeExtensionScreenshot(blob: Blob, url: string, title: string, sessionId: string | null, source = 'extension_screenshot') {
  try {
    const { captureAndAnalyzeBuffer } = await import('@/lib/screenshot-pipeline');
    const imageBuffer = Buffer.from(await blob.arrayBuffer());
    await captureAndAnalyzeBuffer(imageBuffer, { url, title, sessionId, source });
  } catch (err) {
    console.error('[Extension Screenshot] Analysis failed:', err);
  }
}

function classifyApp(app: string, windowTitle: string, idleSeconds: number): string {
  if (idleSeconds > 300) return 'idle';

  const appLower = app.toLowerCase();
  const titleLower = windowTitle.toLowerCase();

  if (['code', 'cursor', 'xcode', 'intellij', 'pycharm', 'webstorm'].some(a => appLower.includes(a))) return 'deep_work';
  if (['terminal', 'iterm', 'warp'].some(a => appLower.includes(a))) return 'deep_work';
  if (appLower.includes('youtube') || titleLower.includes('youtube')) return 'distraction';
  if (['instagram', 'twitter', 'tiktok', 'reddit'].some(a => appLower.includes(a) || titleLower.includes(a))) return 'distraction';
  if (['slack', 'teams', 'zoom', 'facetime', 'discord'].some(a => appLower.includes(a))) return 'communication';
  if (['mail', 'outlook'].some(a => appLower.includes(a))) return 'shallow_work';
  if (appLower.includes('chrome') || appLower.includes('safari') || appLower.includes('brave') || appLower.includes('firefox')) return 'consumption';

  return 'shallow_work';
}
