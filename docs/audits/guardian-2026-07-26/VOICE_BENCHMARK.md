# Real-Device Voice Validation

Date: 2026-07-27  
Device: MacBook Pro native LifeOSCopilot and Mac Mini production API  
Retention: aggregate measurements only; all raw test audio deleted

## Push-to-Talk Evidence

The installed native client had microphone authorization and three enumerated
inputs. The selected system input was a 16 kHz Bluetooth microphone.

Before the signal guard, an effectively silent 8-second recording measured
about -68 dBFS and Groq Whisper returned `Thank you.` This is a confirmed false
transcription from low-signal input.

After adding native metering and a -45 dB average-power threshold:

| Case | Measured level | Native decision | Production STT | Latency |
| --- | ---: | --- | --- | ---: |
| Five seconds of silence | -56.0 dB | Rejected before upload | Not called | n/a |
| Fixed Indian-English phrase | -14.7 dB | Accepted | Exact after `forty five` to `45` normalization | 287 ms |

The same fixed phrase also passed an earlier production replay in 245 ms.
The phrase-level normalized word error rate was 0%, but one phrase is not enough
to claim the required quiet-condition WER target. A multi-phrase set, noise
conditions, short utterances, and concurrent requests remain outstanding.

## Gemini Live Evidence

The Vertex project accepted direct SDK websocket connections for the tested
Live model IDs. Only `gemini-live-2.5-flash` reliably produced native audio in
the response test. The preview `gemini-live-2.5-flash-preview-native-audio-09-2025`
opened five sockets but produced zero messages and zero audio before timeout.

Observed first-audio latency for `gemini-live-2.5-flash`, measured after a text
turn was submitted to an established session:

`820, 1989, 649, 570, 1249, 570, 648, 2109 ms`

- Median: 735 ms
- Runs at or below 1.5 seconds: 6/8
- Nearest-rank p95: 2109 ms
- Required p95: at most 1500 ms
- Result: fail

This canary proves project and model access, websocket setup, and native-audio
generation. It does not prove microphone streaming, LiveKit transport,
interruption cancellation, session reconnection, or production worker health.
Production still has no LiveKit credentials and realtime mode remains disabled.

## Reproduction

```bash
set -a
source .env.local
set +a
npm run verify:vertex-live-voice
```

The canary emits only model, status, and latency metadata. It does not persist
audio, credentials, transcripts, or model response bytes.
