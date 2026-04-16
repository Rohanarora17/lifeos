# Voice Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot PTT pipeline with an ElevenLabs Scribe (STT) + streaming TTS pipeline and a WhatsApp-style overlay with recording, processing, speaking, and idle states.

**Architecture:** Extension sends full audio blob on toggle → server transcribes with ElevenLabs Scribe (Groq fallback) → processes guardian intent → calls ElevenLabs `/stream` TTS endpoint → pipes chunked audio back to extension as a streaming HTTP response → extension collects chunks, signals `PTT_SPEAKING` on first chunk, plays full audio via WebAudio, auto-dismisses overlay.

**Tech Stack:** ElevenLabs Scribe API, ElevenLabs TTS `/stream` HTTP endpoint (`eleven_flash_v2_5`), Next.js streaming `Response`, Chrome extension `ReadableStream` reader, WebAudio API, CSS keyframe animations.

---

## File Map

| File | What changes |
|------|-------------|
| `src/app/api/voice/push-to-talk/route.ts` | Replace `transcribeAudio` with Scribe+Groq fallback; replace `synthesizeSpeech` with `streamElevenLabsTts` that returns a piped `ReadableStream` |
| `extension/offscreen.js` | Replace `res.arrayBuffer()` with streaming reader; send `PTT_SPEAKING` on first chunk; send `PTT_DONE` after audio finishes |
| `extension/background.js` | Handle new `PTT_SPEAKING` message → `broadcastPttState('speaking', ...)` |
| `extension/guardian.js` | Rebuild PTT overlay with 4 states: recording (waveform + timer), processing (spinner), speaking (wave bars), idle (hidden) |

---

## Task 1: ElevenLabs Scribe STT with Groq fallback

**Files:**
- Modify: `src/app/api/voice/push-to-talk/route.ts`

Replace the existing `transcribeAudio` function entirely.

- [ ] **Step 1: Replace `transcribeAudio` in `push-to-talk/route.ts`**

Open `src/app/api/voice/push-to-talk/route.ts`. Replace everything from the top import down through the closing `}` of `transcribeAudio` with:

```typescript
import { NextResponse } from 'next/server';
import { processGuardianVoiceCommand } from '@/lib/guardian-voice';

// ── STT: ElevenLabs Scribe (primary) ─────────────────────────────────────────

async function transcribeWithScribe(audio: Blob): Promise<string | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY || '';
    if (!apiKey) return null;

    const form = new FormData();
    form.set('audio', new File([audio], 'speech.webm', { type: audio.type || 'audio/webm' }));
    form.set('model_id', 'scribe_v1');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: { 'xi-api-key': apiKey },
            body: form,
            signal: controller.signal,
        });
        const data = await res.json() as { text?: string; error?: unknown };
        if (!res.ok) {
            console.error(`[PTT] Scribe error ${res.status}:`, JSON.stringify(data));
            return null;
        }
        return data.text || null;
    } catch (err) {
        console.error('[PTT] Scribe request failed:', err);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// ── STT: Groq Whisper (fallback) ──────────────────────────────────────────────

async function transcribeWithGroq(audio: Blob): Promise<string | null> {
    const apiKey = process.env.GROQ_API_KEY || '';
    const whisperUrl = (process.env.WHISPER_CPP_URL || '').trim();
    if (!apiKey || !whisperUrl) return null;

    const form = new FormData();
    form.set('file', new File([audio], 'speech.webm', { type: audio.type || 'audio/webm' }));
    form.set('model', process.env.WHISPER_CPP_OPENAI_MODEL || 'whisper-large-v3-turbo');
    form.set('response_format', 'json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(whisperUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: form,
            signal: controller.signal,
        });
        const data = await res.json() as { text?: string; error?: unknown };
        if (!res.ok) {
            console.error(`[PTT] Groq error ${res.status}:`, JSON.stringify(data));
            return null;
        }
        return data.text || null;
    } catch (err) {
        console.error('[PTT] Groq request failed:', err);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function transcribeAudio(audio: Blob): Promise<string | null> {
    const transcript = await transcribeWithScribe(audio);
    if (transcript) {
        console.log('[PTT] Scribe transcript:', transcript);
        return transcript;
    }
    console.warn('[PTT] Scribe failed or not configured — trying Groq fallback');
    const fallback = await transcribeWithGroq(audio);
    if (fallback) console.log('[PTT] Groq fallback transcript:', fallback);
    return fallback;
}
```

- [ ] **Step 2: Verify the app still builds**

```bash
cd /path/to/lifeos && npm run build 2>&1 | tail -20
```
Expected: no TypeScript errors on `push-to-talk/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/voice/push-to-talk/route.ts
git commit -m "feat(voice): replace STT with ElevenLabs Scribe + Groq fallback"
```

---

## Task 2: ElevenLabs streaming TTS + piped response

**Files:**
- Modify: `src/app/api/voice/push-to-talk/route.ts`

Replace `synthesizeSpeech` with a streaming version that pipes ElevenLabs audio chunks directly back to the extension.

- [ ] **Step 1: Replace `synthesizeSpeech` with `streamElevenLabsTts`**

In `push-to-talk/route.ts`, delete the existing `synthesizeSpeech` function and add:

```typescript
// ── TTS: ElevenLabs streaming (returns piped ReadableStream) ──────────────────

async function streamElevenLabsTts(text: string): Promise<ReadableStream<Uint8Array> | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY || '';
    const voice  = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
    if (!apiKey) return null;

    // eleven_flash_v2_5 is the lowest-latency model (~75-150ms TTFB).
    // Fall back to eleven_turbo_v2_5 if flash is unavailable on your plan.
    const model = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

    try {
        const res = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: text.trim(),
                    model_id: model,
                    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
                    output_format: 'mp3_44100_128',
                }),
            }
        );
        if (!res.ok || !res.body) {
            console.error(`[PTT] ElevenLabs TTS error ${res.status}`);
            return null;
        }
        return res.body;
    } catch (err) {
        console.error('[PTT] ElevenLabs TTS request failed:', err);
        return null;
    }
}
```

- [ ] **Step 2: Update the POST handler to use streaming response**

In the `POST` function, replace the section after `const result = await processGuardianVoiceCommand(...)` through the end of the handler with:

```typescript
        const result = await processGuardianVoiceCommand({ transcript, sessionId });

        const responseText: string | undefined =
            (result as { spokenResponse?: string; responseText?: string; response?: string }).spokenResponse ||
            (result as { spokenResponse?: string; responseText?: string; response?: string }).responseText ||
            (result as { spokenResponse?: string; responseText?: string; response?: string }).response;

        if (responseText) {
            const audioStream = await streamElevenLabsTts(responseText);
            if (audioStream) {
                return new Response(audioStream, {
                    headers: {
                        'Content-Type': 'audio/mpeg',
                        'X-Transcript': encodeURIComponent(transcript),
                        'X-Response-Text': encodeURIComponent(responseText),
                        'Cache-Control': 'no-store',
                    },
                });
            }
        }

        return NextResponse.json({ success: true, transcript });
    } catch (error) {
        console.error('[PTT] Error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | tail -20
```
Expected: clean build.

- [ ] **Step 4: Manual smoke test**

Start the server (`npm run dev`), send a test request:
```bash
curl -X POST http://localhost:3000/api/voice/push-to-talk \
  -H "Content-Type: application/json" \
  -d '{"transcript":"what is my focus score right now"}' \
  --output /tmp/test-response.mp3 -v 2>&1 | grep -E "< HTTP|Content-Type|X-Transcript"
```
Expected: `HTTP/1.1 200`, `Content-Type: audio/mpeg`, `x-transcript: ...`

Play to verify: `afplay /tmp/test-response.mp3`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/voice/push-to-talk/route.ts
git commit -m "feat(voice): stream ElevenLabs TTS audio back to extension"
```

---

## Task 3: Extension streaming audio reader + PTT_SPEAKING

**Files:**
- Modify: `extension/offscreen.js`

Replace the current `sendAudio` response-handling block with a streaming reader that signals `PTT_SPEAKING` on the first chunk and `PTT_DONE` after playback.

- [ ] **Step 1: Replace the response-handling block inside `sendAudio`**

In `extension/offscreen.js`, find this block (starting after the `const res = await fetch(...)` call):

```javascript
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('audio/mpeg')) {
      // Server returned ElevenLabs MP3 directly — play it
      const transcript = decodeURIComponent(res.headers.get('x-transcript') || '');
      const responseText = decodeURIComponent(res.headers.get('x-response-text') || '');
      console.log(`[Offscreen] Transcript: "${transcript}", Response: "${responseText}"`);

      const audioBuffer = await res.arrayBuffer();
      await playArrayBuffer(audioBuffer);
      chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript, responseText });
    } else {
      const data = await res.json();
      if (data.empty || !data.transcript) {
        // Silence or inaudible — show friendly overlay message
        console.log('[Offscreen] Empty transcript (silence or too quiet)');
        chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript: '', responseText: '' });
        return;
      }
      console.log('[Offscreen] PTT response:', data);
      chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript: data.transcript });
    }
```

Replace it with:

```javascript
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('audio/mpeg') && res.body) {
      const transcript   = decodeURIComponent(res.headers.get('x-transcript') || '');
      const responseText = decodeURIComponent(res.headers.get('x-response-text') || '');
      console.log(`[Offscreen] Streaming audio. Transcript: "${transcript}"`);

      // Collect all audio chunks from the streaming response
      const reader = res.body.getReader();
      const chunks = [];
      let firstChunk = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);

        if (firstChunk) {
          firstChunk = false;
          // Signal speaking state immediately — overlay switches before audio plays
          chrome.runtime.sendMessage({ type: 'PTT_SPEAKING', transcript, responseText });
        }
      }

      // Combine all chunks into one ArrayBuffer and play
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined    = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      await playArrayBuffer(combined.buffer);
      chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript, responseText });

    } else {
      const data = await res.json();
      if (data.empty || !data.transcript) {
        console.log('[Offscreen] Empty transcript (silence or too quiet)');
        chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript: '', responseText: '' });
        return;
      }
      console.log('[Offscreen] PTT response (no audio):', data);
      chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript: data.transcript });
    }
```

- [ ] **Step 2: Commit**

```bash
git add extension/offscreen.js
git commit -m "feat(voice): stream audio chunks from server; signal PTT_SPEAKING on first chunk"
```

---

## Task 4: Background — broadcast PTT_SPEAKING state

**Files:**
- Modify: `extension/background.js`

Add handling for the new `PTT_SPEAKING` message so the overlay can switch to speaking state.

- [ ] **Step 1: Add PTT_SPEAKING handler in background.js**

In `extension/background.js`, find the block:
```javascript
    if (msg.type === 'PTT_DONE') {
        console.log(`[PTT] Done. Transcript: "${msg.transcript}"`);
        broadcastPttState('done', msg.transcript);
```

Add immediately before it:
```javascript
    if (msg.type === 'PTT_SPEAKING') {
        console.log(`[PTT] Speaking. Transcript: "${msg.transcript}"`);
        broadcastPttState('speaking', msg.transcript);
    }
```

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat(voice): broadcast speaking state when TTS audio begins"
```

---

## Task 5: Rebuild PTT overlay — WhatsApp-style with 4 states

**Files:**
- Modify: `extension/guardian.js`

Replace the existing `injectPttOverlay` and `updatePttOverlay` functions entirely with a new implementation that has recording (waveform + timer), processing (spinner), speaking (animated wave bars), and idle states.

- [ ] **Step 1: Find the PTT overlay section in guardian.js**

The section starts at `// ── PTT Floating Overlay` and ends before the next `//` section boundary. It contains `injectPttOverlay()` and `updatePttOverlay()`.

- [ ] **Step 2: Replace the full PTT overlay section**

Replace everything from `// ── PTT Floating Overlay` through the closing `}` of `updatePttOverlay` with:

```javascript
// ── PTT Floating Overlay ─────────────────────────────────────────────────────

let pttTimerInterval = null;
let pttTimerSeconds  = 0;

function injectPttOverlay() {
    if (document.getElementById('lifeos-ptt-overlay')) return;

    const el = document.createElement('div');
    el.id = 'lifeos-ptt-overlay';
    el.innerHTML = `
        <style>
            #lifeos-ptt-overlay {
                position: fixed;
                bottom: 28px;
                left: 50%;
                transform: translateX(-50%) translateY(120px);
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 14px;
                background: rgba(12, 12, 16, 0.94);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 56px;
                padding: 12px 22px 12px 14px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.03);
                font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
                backdrop-filter: blur(24px);
                transition: transform 0.4s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease;
                opacity: 0;
                pointer-events: none;
            }
            #lifeos-ptt-overlay.lifeos-ptt-visible {
                transform: translateX(-50%) translateY(0);
                opacity: 1;
            }

            /* ── Icon circle ── */
            #lifeos-ptt-icon-wrap {
                width: 40px; height: 40px;
                border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
                background: rgba(255,255,255,0.07);
                transition: background 0.25s;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording #lifeos-ptt-icon-wrap {
                background: #dc2626;
                animation: lifeos-ptt-ring-pulse 1.2s ease-in-out infinite;
            }
            #lifeos-ptt-overlay.lifeos-ptt-processing #lifeos-ptt-icon-wrap {
                background: rgba(99,102,241,0.25);
            }
            #lifeos-ptt-overlay.lifeos-ptt-speaking #lifeos-ptt-icon-wrap {
                background: rgba(34,197,94,0.2);
            }
            @keyframes lifeos-ptt-ring-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); }
                50%       { box-shadow: 0 0 0 10px rgba(220,38,38,0); }
            }

            /* ── Icons ── */
            .lifeos-ptt-svg { display: none; }
            #lifeos-ptt-overlay.lifeos-ptt-recording  .lifeos-ptt-svg-mic      { display: block; }
            #lifeos-ptt-overlay.lifeos-ptt-processing .lifeos-ptt-svg-spinner  { display: block; animation: lifeos-ptt-spin 0.8s linear infinite; }
            #lifeos-ptt-overlay.lifeos-ptt-speaking   .lifeos-ptt-svg-wave-ico { display: block; }
            @keyframes lifeos-ptt-spin { to { transform: rotate(360deg); } }

            /* ── Waveform bars (recording + speaking) ── */
            #lifeos-ptt-bars {
                display: none;
                align-items: center;
                gap: 3px;
                height: 24px;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording #lifeos-ptt-bars,
            #lifeos-ptt-overlay.lifeos-ptt-speaking  #lifeos-ptt-bars {
                display: flex;
            }
            .lifeos-ptt-bar {
                width: 3px; border-radius: 3px;
                animation: lifeos-bar-bounce 0.7s ease-in-out infinite alternate;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording .lifeos-ptt-bar { background: rgba(255,255,255,0.7); }
            #lifeos-ptt-overlay.lifeos-ptt-speaking  .lifeos-ptt-bar { background: #22c55e; }
            .lifeos-ptt-bar:nth-child(1) { height: 6px;  animation-delay: 0s;    animation-duration: 0.6s; }
            .lifeos-ptt-bar:nth-child(2) { height: 14px; animation-delay: 0.1s;  animation-duration: 0.5s; }
            .lifeos-ptt-bar:nth-child(3) { height: 22px; animation-delay: 0.2s;  animation-duration: 0.7s; }
            .lifeos-ptt-bar:nth-child(4) { height: 14px; animation-delay: 0.15s; animation-duration: 0.55s; }
            .lifeos-ptt-bar:nth-child(5) { height: 6px;  animation-delay: 0.05s; animation-duration: 0.65s; }
            @keyframes lifeos-bar-bounce {
                from { transform: scaleY(0.3); opacity: 0.6; }
                to   { transform: scaleY(1);   opacity: 1; }
            }

            /* ── Labels ── */
            #lifeos-ptt-label {
                font-size: 13px; font-weight: 500; color: #f3f4f6; line-height: 1.3;
            }
            #lifeos-ptt-timer {
                font-size: 12px; color: #9ca3af; margin-top: 2px; font-variant-numeric: tabular-nums;
            }
        </style>

        <div id="lifeos-ptt-icon-wrap">
            <svg class="lifeos-ptt-svg lifeos-ptt-svg-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3"/>
                <path d="M5 10a7 7 0 0 0 14 0"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
                <line x1="8" y1="22" x2="16" y2="22"/>
            </svg>
            <svg class="lifeos-ptt-svg lifeos-ptt-svg-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2.5" stroke-linecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <svg class="lifeos-ptt-svg lifeos-ptt-svg-wave-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round">
                <path d="M2 12h3M7 6v12M12 3v18M17 6v12M22 12h-3"/>
            </svg>
        </div>

        <div>
            <div id="lifeos-ptt-bars">
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
            </div>
            <div id="lifeos-ptt-label">Listening...</div>
            <div id="lifeos-ptt-timer"></div>
        </div>
    `;
    document.documentElement.appendChild(el);
}

function updatePttOverlay(state, transcript) {
    injectPttOverlay();
    const el       = document.getElementById('lifeos-ptt-overlay');
    const label    = document.getElementById('lifeos-ptt-label');
    const timer    = document.getElementById('lifeos-ptt-timer');
    if (!el || !label || !timer) return;

    // Clear any existing hide timer
    if (el._hideTimeout) { clearTimeout(el._hideTimeout); el._hideTimeout = null; }
    // Clear recording timer
    if (pttTimerInterval) { clearInterval(pttTimerInterval); pttTimerInterval = null; }

    el.classList.remove(
        'lifeos-ptt-visible',
        'lifeos-ptt-recording',
        'lifeos-ptt-processing',
        'lifeos-ptt-speaking'
    );
    timer.textContent = '';

    if (state === 'recording') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-recording');
        label.textContent = 'Listening...';
        timer.textContent = '0:00';
        pttTimerSeconds = 0;
        pttTimerInterval = setInterval(() => {
            pttTimerSeconds++;
            const m = Math.floor(pttTimerSeconds / 60);
            const s = String(pttTimerSeconds % 60).padStart(2, '0');
            const t = document.getElementById('lifeos-ptt-timer');
            if (t) t.textContent = `${m}:${s}`;
        }, 1000);

    } else if (state === 'sending' || state === 'processing') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-processing');
        label.textContent = 'Thinking...';

    } else if (state === 'speaking') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-speaking');
        label.textContent = 'Guardian';

    } else if (state === 'done' || state === 'idle') {
        // Slide out
        el.classList.remove('lifeos-ptt-visible');

    } else if (state === 'permission') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-processing');
        label.textContent = 'Mic permission needed';
        el._hideTimeout = setTimeout(() => {
            el.classList.remove('lifeos-ptt-visible');
        }, 4000);
    }
}
```

- [ ] **Step 3: Reload the extension in Chrome and test visually**

1. Go to `chrome://extensions`
2. Click **Reload** on the LifeOS extension
3. Open any tab
4. Press `Cmd+Shift+Space` → overlay should slide up with pulsing red mic + bouncing waveform bars + timer counting up
5. Press `Cmd+Shift+Space` again → overlay shows spinner + "Thinking..."
6. When audio arrives → overlay shows green wave icon + "Guardian" label + animated bars
7. After audio finishes → overlay slides down and disappears

- [ ] **Step 4: Commit**

```bash
git add extension/guardian.js
git commit -m "feat(voice): WhatsApp-style PTT overlay with recording/processing/speaking/idle states"
```

---

## Task 6: Push and verify end-to-end

- [ ] **Step 1: Push to main**

```bash
git push
```

GitHub Actions will deploy automatically to Mac Mini. Wait ~2–3 minutes.

- [ ] **Step 2: Verify server logs on Mac Mini**

```bash
tail -f ~/lifeos/logs/server.log | grep -E "\[PTT\]"
```

Expected sequence on a PTT cycle:
```
[PTT] Received audio: XXXX bytes, type: audio/webm;codecs=opus
[PTT] Scribe transcript: "lock in for 60 minutes on typescript"
```
(No more per-word separate transcripts)

- [ ] **Step 3: Verify no ElevenLabs model error**

If you see `ElevenLabs TTS error 400` in the logs, the `eleven_flash_v2_5` model may not be on your plan. Add to `.env.local` on Mac Mini:
```
ELEVENLABS_MODEL=eleven_turbo_v2_5
```
Then restart:
```bash
launchctl unload ~/Library/LaunchAgents/com.lifeos.server.plist
launchctl load ~/Library/LaunchAgents/com.lifeos.server.plist
```

- [ ] **Step 4: Full end-to-end acceptance check**

- [ ] Press hotkey once → red overlay appears with bouncing bars + timer
- [ ] Speak a complete sentence ("lock in on TypeScript for 45 minutes")
- [ ] Press hotkey again → spinner + "Thinking..." appears
- [ ] Guardian responds → green wave bars + "Guardian" label
- [ ] Hear the ElevenLabs voice (noticeably better quality than before)
- [ ] Overlay auto-dismisses after audio ends
- [ ] Short background noise (< 3 words) → overlay shows idle, no AI call fired
