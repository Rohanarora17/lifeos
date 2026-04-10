# Voice Pipeline Design — Production PTT with ElevenLabs Streaming

**Date:** 2026-04-11
**Status:** Approved
**Scope:** Chrome extension PTT flow, server-side voice pipeline, overlay UI

---

## Goal

Replace the current one-shot PTT pipeline (record → send blob → get MP3 back → play) with a streaming pipeline that feels like talking to a real AI buddy. The guardian starts speaking within ~150ms of the first LLM token — not after the full response is generated.

---

## Interaction Model

**Toggle PTT** — press hotkey once to start recording, press again to stop and send. The entire recording from press-to-press is one audio blob, sent as a single transcript. No per-word sends.

The hotkey (`Cmd+Shift+Space`) is already wired via `chrome.commands`. No change to the hotkey mechanism.

---

## Pipeline Architecture

```
[hotkey press #1]
  → offscreen.js: start MediaRecorder (WebM/Opus, 100ms chunks)
  → guardian.js overlay: recording state (red dot + waveform + timer)

[hotkey press #2]
  → offscreen.js: stop MediaRecorder → assemble full WebM blob → POST to /api/voice/push-to-talk

Server (/api/voice/push-to-talk):
  Step 1: ElevenLabs Scribe   POST /v1/speech-to-text
            → full transcript (~0.5–1s)
            fallback: Groq Whisper if Scribe fails or key missing

  Step 2: processGuardianVoiceCommand → responseText (existing logic, ~0.3–0.8s)
            Guardian responses are <60 words by spec — full text available fast.

  Step 3: ElevenLabs TTS WebSocket
            wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
            → full responseText sent immediately as one message
            → audio chunks arrive back ~150ms after send (eleven_flash_v2_5)

  Step 4: Chunked HTTP response
            → audio chunks piped back to extension as they arrive
            → Content-Type: audio/mpeg (MP3) or audio/pcm
            → X-Transcript header on first chunk

Extension (offscreen.js):
  → reads response.body as ReadableStream
  → accumulates chunks into audio segments
  → decodes via AudioContext.decodeAudioData
  → plays each segment as it arrives (queued, no overlap)
  → sends PTT_SPEAKING message to background when first chunk plays
  → sends PTT_DONE when stream ends

guardian.js overlay:
  recording state  → speaking state (on PTT_SPEAKING)
  speaking state   → dismissed (on PTT_DONE + audio ended)
```

---

## ElevenLabs API Details

### STT — Scribe
```
POST https://api.elevenlabs.io/v1/speech-to-text
Header: xi-api-key: {ELEVENLABS_API_KEY}
Body (multipart):
  audio: <WebM blob>
  model_id: scribe_v1

Response:
  { "text": "...", "language_code": "en", "language_probability": 0.99 }
```

### TTS — WebSocket streaming input
```
WSS: wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
     ?model_id=eleven_flash_v2_5
     &output_format=mp3_44100_128

Send (JSON per token chunk):
  { "text": "<token>", "try_trigger_generation": true }

Send (flush at end):
  { "text": "", "flush": true }

Receive:
  { "audio": "<base64 mp3 chunk>", "isFinal": false }
  { "audio": "<base64 mp3 chunk>", "isFinal": true }
```

### Fallback STT — Groq Whisper
```
POST https://api.groq.com/openai/v1/audio/transcriptions
Header: Authorization: Bearer {GROQ_API_KEY}
Body (multipart):
  file: <WebM blob>
  model: whisper-large-v3-turbo
  response_format: json
```

---

## Server Route Changes (`/api/voice/push-to-talk`)

Replace current flow with:

```typescript
// 1. Transcribe with Scribe (fallback to Groq)
const transcript = await transcribeWithScribe(audio)
                ?? await transcribeWithGroq(audio);
if (!transcript || transcript.split(/\s+/).length < 3)
  return { empty: true };

// 2. Process guardian intent (existing logic, unchanged)
const result = await processGuardianVoiceCommand({ transcript, sessionId });
const responseText = result.responseText ?? result.spokenResponse ?? result.response;
if (!responseText) return NextResponse.json({ success: true, transcript });

// 3. Stream TTS via ElevenLabs WebSocket → chunked HTTP response
return streamElevenLabsTts(responseText, transcript);
```

`streamElevenLabsTts` opens the ElevenLabs TTS WebSocket, sends the full `responseText` as one message with `flush: true`, collects audio chunks, and returns a `Response` with a `ReadableStream` body. Falls back to HTTP `/stream` if WebSocket fails.

The `X-Transcript` response header carries the transcript so the extension can display it.

---

## Extension Changes

### offscreen.js

- `sendAudio()`: switch from `await res.arrayBuffer()` to streaming `res.body` reader
- Process audio in chunks: accumulate ~8KB segments → decode → queue play
- Send `PTT_SPEAKING` message when first chunk starts playing
- Send `PTT_DONE` when stream ends and audio queue drains

### guardian.js overlay

Rebuild the PTT overlay with four states:

| State | Visual | Duration |
|-------|--------|----------|
| `recording` | Red pulsing dot + 5 animated waveform bars + elapsed timer (MM:SS) | Until hotkey press #2 |
| `processing` | Subtle spinner + "Thinking..." in grey | STT + first LLM token |
| `speaking` | 5 green animated wave bars (varying heights) + "Guardian" label | While audio plays |
| `idle` | Slide down out of view | Auto after audio ends |

**Overlay anatomy:**
```
┌─────────────────────────────────────────┐
│  [●] [▁▃▇▅▂]           0:04            │  ← recording
│  [⟳]  Thinking...                       │  ← processing
│  [▁▃▇▅▂]  Guardian                      │  ← speaking
└─────────────────────────────────────────┘
```

- Fixed pill at bottom-center, slides up on appear, slides down on dismiss
- No transcript text shown in speaking state — clean visual only
- Speaking bars animate with CSS `animation-delay` stagger on each bar

---

## Fallback Behavior

| Failure | Behavior |
|---------|----------|
| Scribe fails / no key | Fall through to Groq Whisper |
| Both STT fail | Return `{ empty: true }` — overlay shows "Couldn't hear that" |
| Gemini fails | Return `{ error }` — overlay shows "Something went wrong" |
| ElevenLabs TTS WebSocket fails | Fall back to current ElevenLabs HTTP TTS (`/stream` endpoint) |
| ElevenLabs TTS HTTP fails | Fall back to `say` macOS TTS via existing `tts.ts` |

---

## Env Vars Required

```
ELEVENLABS_API_KEY=...        # already present
ELEVENLABS_VOICE_ID=...       # already present
GROQ_API_KEY=...              # already present, used as STT fallback
# WHISPER_CPP_URL removed from primary path
```

---

## What Does NOT Change

- The `chrome.commands` hotkey registration — no change
- The `guardian-voice.ts` intent parsing and session logic — no change
- The `tts.ts` server-side queue — only invoked as last-resort fallback
- All existing guardian routes, DB schema, and session management

---

## Files Touched

| File | Change |
|------|--------|
| `src/app/api/voice/push-to-talk/route.ts` | Replace STT + TTS with Scribe + streaming WebSocket TTS |
| `src/lib/tts.ts` | Keep as-is (last-resort fallback only) |
| `extension/offscreen.js` | Streaming response reader + PTT_SPEAKING message |
| `extension/guardian.js` | Rebuild PTT overlay with 4 states + waveform animations |
| `extension/background.js` | Handle new `PTT_SPEAKING` message → forward to tab |

---

## Acceptance Criteria

- [ ] Pressing hotkey once starts recording; pressing again sends the full audio as one blob
- [ ] ElevenLabs Scribe transcribes the audio; Groq is used if Scribe fails
- [ ] Guardian responds; TTS audio starts streaming back before full response is generated
- [ ] Extension plays audio chunks as they arrive — no gap between first chunk and playback
- [ ] Overlay shows: recording → processing → speaking → auto-dismiss
- [ ] Speaking overlay shows wave animation for exactly the duration audio plays
- [ ] No concurrent PTT sends — lock held until full audio stream ends
- [ ] If transcript < 3 words: overlay shows "Couldn't hear that", no AI call
- [ ] All three TTS fallbacks work: ElevenLabs WS → ElevenLabs HTTP → say
