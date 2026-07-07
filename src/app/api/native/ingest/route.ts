import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getActiveGuardianSession, tickGuardianSession } from '@/lib/guardian-runtime';
import { touchIntelligence } from '@/lib/intelligence';
import { recordExplicitFeedbackLearning, type ExplicitFeedback } from '@/lib/feedback-learning';
import type { NativeIngestPayload } from '@/lib/focus-copilot-types';
import type { GuardianEvent } from '@/lib/guardian-types';

function clampConfidence(value: unknown): number {
  return Math.max(0, Math.min(1, typeof value === 'number' ? value : 0.7));
}

function classifyNativeApp(app = '', title = '', fallback?: NativeIngestPayload['category']) {
  if (fallback) return fallback;
  const appLower = app.toLowerCase();
  const titleLower = title.toLowerCase();
  if (['cursor', 'code', 'xcode', 'intellij', 'pycharm', 'webstorm', 'terminal', 'iterm', 'warp'].some((token) => appLower.includes(token))) return 'deep_work';
  if (['preview', 'zotero', 'skim', 'books'].some((token) => appLower.includes(token))) return 'deep_work';
  if (['slack', 'discord', 'teams', 'zoom', 'facetime'].some((token) => appLower.includes(token))) return 'communication';
  if (['youtube', 'netflix', 'instagram', 'twitter', 'x.com', 'reddit', 'tiktok'].some((token) => appLower.includes(token) || titleLower.includes(token))) return 'distraction';
  if (['chrome', 'safari', 'brave', 'firefox', 'arc'].some((token) => appLower.includes(token))) return 'consumption';
  return 'shallow_work';
}

function attentionForCategory(category: string, fallback?: NativeIngestPayload['attentionQuality']) {
  if (fallback) return fallback;
  if (category === 'deep_work' || category === 'shallow_work' || category === 'communication') return 'focused';
  if (category === 'distraction') return 'distracted';
  if (category === 'idle') return 'idle';
  return 'consuming';
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as NativeIngestPayload;
    const activeSession = getActiveGuardianSession();
    const sessionId = body.sessionId || activeSession?.sessionId || null;

    if (body.kind === 'capture_heartbeat') {
      return NextResponse.json({ ok: true, active: !!activeSession, sessionId: activeSession?.sessionId ?? null });
    }

    if (!sessionId || !activeSession || activeSession.sessionId !== sessionId) {
      return NextResponse.json({ ok: false, error: 'No active guardian session for native ingest' }, { status: 409 });
    }

    const db = getDb();

    if (body.kind === 'app_dwell') {
      const durationSeconds = Math.max(0, Math.round(body.durationSeconds ?? 0));
      if (durationSeconds <= 0) {
        return NextResponse.json({ ok: false, error: 'durationSeconds must be positive' }, { status: 400 });
      }

      const app = body.appInFocus || 'Unknown App';
      const title = body.windowTitle || '';
      const category = classifyNativeApp(app, title, body.category);
      const startedAt = body.startedAt || new Date(Date.now() - durationSeconds * 1000).toISOString();
      const inferred = {
        source: 'native_copilot',
        app,
        title,
        sessionId,
        category,
        confidence: body.confidence ?? 0.7,
      };

      db.prepare(`
        INSERT INTO activities
          (url, domain, title, category, subcategory, started_at, duration_seconds, ai_classification, classification_confidence, device_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `native://${encodeURIComponent(app)}`,
        app,
        title || app,
        category === 'deep_work' ? 'productive' : category,
        'native_app',
        startedAt,
        durationSeconds,
        JSON.stringify(inferred),
        'medium',
        'LifeOS Native Copilot',
      );

      const event: GuardianEvent = {
        sessionId,
        type: 'native_context',
        timestamp: Date.now(),
        url: `native://${encodeURIComponent(app)}`,
        domain: `native:${app.toLowerCase()}`,
        title: title || app,
        dwellSeconds: durationSeconds,
        payload: { kind: body.kind, appInFocus: app, windowTitle: title, category, metadata: body.metadata ?? {} },
      };
      await tickGuardianSession(sessionId, event);
      touchIntelligence('native_app_dwell');
      return NextResponse.json({ ok: true, stored: 'activities', category });
    }

    if (body.kind === 'observation_summary' || body.kind === 'sensitivity_skip') {
      const app = body.appInFocus || 'Unknown App';
      const title = body.windowTitle || '';
      const category = body.kind === 'sensitivity_skip' ? 'idle' : classifyNativeApp(app, title, body.category);
      const attention = attentionForCategory(category, body.attentionQuality);
      const activity = body.kind === 'sensitivity_skip'
        ? `Native capture skipped: ${body.reason || 'sensitive context'}`
        : (body.specificContent || `${app}: ${title}`.slice(0, 220));

      db.prepare(`
        INSERT INTO screen_observations
          (observed_at, source, app, window_title, activity, category, content_type, attention_quality,
           specific_content, productive_for_goals, confidence, session_id, raw_description)
        VALUES (datetime('now','localtime'), 'native_copilot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        app,
        title,
        activity,
        category,
        'native_app',
        attention,
        body.specificContent || title || app,
        body.productiveForGoals ? 1 : 0,
        clampConfidence(body.confidence),
        sessionId,
        JSON.stringify({ kind: body.kind, reason: body.reason ?? null, metadata: body.metadata ?? {} }),
      );

      const event: GuardianEvent = {
        sessionId,
        type: 'native_context',
        timestamp: Date.now(),
        url: `native://${encodeURIComponent(app)}`,
        domain: `native:${app.toLowerCase()}`,
        title: title || app,
        payload: { kind: body.kind, appInFocus: app, windowTitle: title, category, attentionQuality: attention, metadata: body.metadata ?? {} },
      };
      await tickGuardianSession(sessionId, event);
      touchIntelligence(body.kind === 'sensitivity_skip' ? 'native_sensitivity_skip' : 'native_screen_observation');
      return NextResponse.json({ ok: true, stored: 'screen_observations', category });
    }

    if (body.kind === 'overlay_feedback') {
      if (!body.feedback) {
        return NextResponse.json({ ok: false, error: 'feedback is required' }, { status: 400 });
      }
      db.prepare(`
        INSERT INTO native_guidance_feedback (outcome_id, session_id, feedback, reason, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).run(body.outcomeId ?? null, sessionId, body.feedback, body.reason ?? null, JSON.stringify(body.metadata ?? {}));

      if (body.outcomeId) {
        db.prepare(`
          UPDATE agent_action_outcomes
          SET helpful = ?, actual_outcome = ?, was_corrected = CASE WHEN ? = 'not_helpful' THEN 1 ELSE was_corrected END
          WHERE id = ?
        `).run(
          body.feedback === 'helpful' ? 1 : body.feedback === 'not_helpful' ? 0 : null,
          JSON.stringify({ feedback: body.feedback, reason: body.reason ?? null, source: 'native_copilot' }),
          body.feedback,
          body.outcomeId,
        );
      }

      recordExplicitFeedbackLearning({
        source: 'native_guidance',
        feedback: body.feedback as ExplicitFeedback,
        reason: body.reason ?? null,
        surface: 'native_overlay',
        momentMode: null,
        subject: typeof body.metadata?.question === 'string' ? body.metadata.question : null,
        outcomeId: body.outcomeId ?? null,
        metadata: body.metadata ?? {},
      });

      touchIntelligence('native_guidance_feedback');
      return NextResponse.json({ ok: true, stored: 'native_guidance_feedback' });
    }

    return NextResponse.json({ ok: false, error: `Unsupported native ingest kind: ${body.kind}` }, { status: 400 });
  } catch (err) {
    console.error('[native/ingest] Error:', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
