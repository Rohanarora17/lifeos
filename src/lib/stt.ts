/**
 * src/lib/stt.ts
 * Shared Speech-to-Text module.
 *
 * Primary:  ElevenLabs Scribe v1 (ELEVENLABS_API_KEY)
 * Fallback: Groq Whisper (GROQ_API_KEY + WHISPER_CPP_URL pointing to api.groq.com)
 *
 * Used by:
 *   - /api/voice/push-to-talk  (real-time PTT)
 *   - /api/telegram/webhook    (voice notes → check-in / general commands)
 */

// ── ElevenLabs Scribe ────────────────────────────────────────────────────────

export async function transcribeWithScribe(
  audio: Blob,
  filename = 'speech.webm'
): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  if (!apiKey) return null;

  const form = new FormData();
  form.set('audio', new File([audio], filename, { type: audio.type || 'audio/webm' }));
  form.set('model_id', 'scribe_v1');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: controller.signal,
    });
    const data = await res.json() as { text?: string; error?: unknown };
    if (!res.ok) {
      console.error(`[STT] Scribe error ${res.status}:`, JSON.stringify(data));
      return null;
    }
    return data.text?.trim() || null;
  } catch (err) {
    console.error('[STT] Scribe request failed:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Groq Whisper fallback ────────────────────────────────────────────────────

export async function transcribeWithGroq(
  audio: Blob,
  filename = 'speech.webm'
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY || '';
  const whisperUrl = (process.env.WHISPER_CPP_URL || '').trim();
  if (!apiKey || !whisperUrl) return null;

  const form = new FormData();
  form.set('file', new File([audio], filename, { type: audio.type || 'audio/webm' }));
  form.set('model', process.env.WHISPER_CPP_OPENAI_MODEL || 'whisper-large-v3-turbo');
  form.set('response_format', 'json');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(whisperUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const data = await res.json() as { text?: string; error?: unknown };
    if (!res.ok) {
      console.error(`[STT] Groq error ${res.status}:`, JSON.stringify(data));
      return null;
    }
    return data.text?.trim() || null;
  } catch (err) {
    console.error('[STT] Groq request failed:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Primary entry point ──────────────────────────────────────────────────────

/**
 * Transcribe a Blob of audio.
 * Tries Scribe first, falls back to Groq Whisper.
 * Returns null if both are unconfigured / fail.
 */
export async function transcribeAudio(
  audio: Blob,
  filename = 'speech.webm'
): Promise<string | null> {
  const scribe = await transcribeWithScribe(audio, filename);
  if (scribe) {
    console.log('[STT] Scribe transcript:', scribe.slice(0, 80));
    return scribe;
  }
  console.warn('[STT] Scribe failed — trying Groq fallback');
  const groq = await transcribeWithGroq(audio, filename);
  if (groq) console.log('[STT] Groq fallback transcript:', groq.slice(0, 80));
  return groq;
}

// ── Download a Telegram voice file and return a Blob ─────────────────────────

/**
 * Download a voice note from Telegram using its file_id.
 * Returns a Blob ready to pass to transcribeAudio().
 */
export async function downloadTelegramVoice(fileId: string): Promise<Blob | null> {
  const tok = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!tok) return null;

  try {
    // Step 1: resolve file_id → file_path
    const metaRes = await fetch(
      `https://api.telegram.org/bot${tok}/getFile?file_id=${fileId}`
    );
    const meta = await metaRes.json() as { ok: boolean; result?: { file_path?: string } };
    if (!meta.ok || !meta.result?.file_path) {
      console.error('[STT] getFile failed:', JSON.stringify(meta));
      return null;
    }

    // Step 2: download the actual audio
    const audioRes = await fetch(
      `https://api.telegram.org/file/bot${tok}/${meta.result.file_path}`
    );
    if (!audioRes.ok) {
      console.error('[STT] Voice download failed:', audioRes.status);
      return null;
    }

    const buf = await audioRes.arrayBuffer();
    // Telegram voice notes are OGG/OPUS
    return new Blob([buf], { type: 'audio/ogg; codecs=opus' });
  } catch (err) {
    console.error('[STT] downloadTelegramVoice error:', err);
    return null;
  }
}
