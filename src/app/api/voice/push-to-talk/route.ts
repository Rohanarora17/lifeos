import { NextResponse } from 'next/server';
import { processGuardianVoiceCommand } from '@/lib/guardian-voice';
import { transcribeAudio } from '@/lib/stt';
import { suppressSpeechForRequest } from '@/lib/tts';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 4_000;

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

export async function POST(req: Request) {
    try {
        const contentType = req.headers.get('content-type') || '';
        let transcript: string | undefined;
        let sessionId: string | undefined;

        if (contentType.includes('multipart/form-data')) {
            // Raw audio blob from extension push-to-talk
            const form = await req.formData();
            const audio = form.get('audio');
            sessionId = (form.get('sessionId') as string | null) ?? undefined;

            if (!(audio instanceof Blob)) {
                return NextResponse.json({ error: 'Missing audio blob' }, { status: 400 });
            }
            if (audio.size > MAX_AUDIO_BYTES) {
                return NextResponse.json({ error: 'Audio payload too large' }, { status: 413 });
            }

            console.log(`[PTT] Received audio: ${audio.size} bytes, type: ${audio.type}`);
            const t = await transcribeAudio(audio);
            if (!t?.trim()) {
                // Empty transcription = silence or header-only blob. Return 200 with empty
                // transcript so the client can show a friendly message instead of an error.
                return NextResponse.json({ transcript: '', empty: true });
            }
            transcript = t.trim();
            console.log(`[PTT] Transcript: "${transcript}"`);

            // Filter ambient noise — Scribe/Groq faithfully transcribes background audio as
            // short phrases ("Thank you", "Okay", "."). Require at least 3 words before
            // passing to the guardian to prevent AI calls + TTS on noise.
            const wordCount = transcript.split(/\s+/).filter(w => /\w/.test(w)).length;
            if (wordCount < 3) {
                console.log(`[PTT] Transcript too short (${wordCount} word(s)) — likely ambient noise, skipping.`);
                return NextResponse.json({ transcript: '', empty: true });
            }
        } else {
            // JSON with pre-transcribed text (legacy / dashboard)
            const body = await req.json() as { transcript?: string; sessionId?: string };
            transcript = body.transcript;
            sessionId = body.sessionId;
        }

        if (!transcript) {
            return NextResponse.json({ error: 'Missing transcript' }, { status: 400 });
        }
        transcript = transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS);

        // The PTT response owns playback on the MacBook. Suppress the separate
        // server/SSE speech path for this request so one answer is not spoken twice.
        const releaseSpeech = suppressSpeechForRequest(sessionId || 'voice-assistant');
        let result;
        try {
            result = await processGuardianVoiceCommand({ transcript, sessionId });
        } finally {
            releaseSpeech();
        }

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

        return NextResponse.json({
            success: true,
            transcript,
            responseText: responseText || '',
            audioAvailable: false,
        });
    } catch (error) {
        console.error('[PTT] Error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
