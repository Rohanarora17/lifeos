# Local `whisper.cpp` Setup

This is the local-first speech-to-text path for LifeOS. Audio stays on your Mac Mini and the app forwards browser recordings to your local `whisper.cpp` server through [src/app/api/voice/transcribe/route.ts](/Users/rohan/.gemini/antigravity/scratch/lifeos/src/app/api/voice/transcribe/route.ts).

## What LifeOS Expects

LifeOS expects a running HTTP server and a configured `WHISPER_CPP_URL`.

Default native setup:

```bash
WHISPER_CPP_URL=http://127.0.0.1:8080/inference
```

The app now sends both `file` and `audio` multipart fields so it can work with common native `whisper.cpp` servers and OpenAI-compatible wrappers.

## Required Environment Variables

Add these to your local shell or `.env`:

```bash
VOICE_MODE=local
WHISPER_CPP_MODEL=/absolute/path/to/ggml-base.en.bin
WHISPER_CPP_URL=http://127.0.0.1:8080/inference
```

Optional:

```bash
WHISPER_CPP_BIN=/absolute/path/to/whisper-server
WHISPER_CPP_HOST=127.0.0.1
WHISPER_CPP_PORT=8080
WHISPER_CPP_LANGUAGE=en
WHISPER_CPP_THREADS=8
WHISPER_CPP_TIMEOUT_MS=60000
WHISPER_CPP_MODE=native
```

If you use an OpenAI-compatible wrapper instead of the native `whisper.cpp` HTTP server:

```bash
WHISPER_CPP_URL=http://127.0.0.1:8080/v1/audio/transcriptions
WHISPER_CPP_MODE=openai
WHISPER_CPP_OPENAI_MODEL=whisper-1
```

## Start The Server

If `whisper-server` is already on your `PATH`, LifeOS can start it directly:

```bash
npm run guardian:stt-local
```

That script:

- checks `WHISPER_CPP_MODEL`
- finds `whisper-server` or `whisper-cpp-server`
- starts the local HTTP server
- prints the exact URL you should use for `WHISPER_CPP_URL`

If your binary is not on `PATH`, set `WHISPER_CPP_BIN` first.

## Install `whisper.cpp`

Install/build `whisper.cpp` from the official repository:

- Repo: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)

You need two things locally:

- a server binary such as `whisper-server`
- a local GGML Whisper model file such as `ggml-base.en.bin`, `ggml-small.en.bin`, or `ggml-medium.en.bin`

If you build from source, make sure the server binary is available locally and that you know the absolute path to the model file.

## Recommended Models

Use these as practical defaults on a Mac Mini:

- `ggml-base.en.bin`: fastest, good for command-style push-to-talk
- `ggml-small.en.bin`: better accuracy, still reasonable latency
- `ggml-medium.en.bin`: better for technical vocabulary, slower

Start with `small.en` if you want a good accuracy/latency tradeoff.

## Verify The Server

1. Start the server.
2. Confirm LifeOS sees it:

```bash
curl http://127.0.0.1:3000/api/voice/transcribe
```

Expected shape:

```json
{
  "configured": true,
  "mode": "whisper.cpp",
  "whisperUrl": "http://127.0.0.1:8080/inference",
  "whisperMode": "native",
  "language": "en"
}
```

3. Test transcription from the app UI with push-to-talk.

## Operational Notes

- Keep `VOICE_MODE=local` if privacy is the priority.
- Default cloud behavior is text-only reasoning. Raw audio stays local unless you explicitly switch to `VOICE_MODE=google-live`.
- `WHISPER_CPP_URL` is only for local STT. It does not enable cloud realtime voice.
- Realtime cloud voice remains a separate opt-in path behind `VOICE_MODE=google-live`.
- If `WHISPER_CPP_URL` is unset, LifeOS falls back to the stub transcription path.

## Troubleshooting

`npm run guardian:stt-local` says binary not found:

- install `whisper.cpp`
- or set `WHISPER_CPP_BIN`

LifeOS returns `502` from `/api/voice/transcribe`:

- check that `WHISPER_CPP_URL` matches the server path
- use `/inference` for the native server
- use `WHISPER_CPP_MODE=openai` only for OpenAI-compatible wrappers

Transcripts are blank or low quality:

- set `WHISPER_CPP_LANGUAGE=en` if your sessions are mostly English
- try a larger local model
- check browser microphone permissions

Latency is too high:

- use a smaller model
- increase `WHISPER_CPP_THREADS`
- keep this on the Mac Mini instead of a remote machine
