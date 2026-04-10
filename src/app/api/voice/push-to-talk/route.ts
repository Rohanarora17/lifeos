import { NextResponse } from 'next/server';
import { processGuardianVoiceCommand } from '@/lib/guardian-voice';

async function transcribeAudio(audio: Blob): Promise<string | null> {
    const whisperUrl = (process.env.WHISPER_CPP_URL || '').trim();
    if (!whisperUrl) return null;

    const filename = 'speech.webm';
    const file = new File([audio], filename, { type: audio.type || 'audio/webm' });

    const form = new FormData();
    form.set('file', file, filename);
    form.set('model', process.env.WHISPER_CPP_OPENAI_MODEL || 'whisper-large-v3-turbo');
    form.set('response_format', 'json');

    const headers: Record<string, string> = {};
    if (process.env.GROQ_API_KEY && whisperUrl.includes('groq.com')) {
        headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
    } else if (process.env.OPENAI_API_KEY && whisperUrl.includes('openai.com')) {
        headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(whisperUrl, { method: 'POST', body: form, headers, signal: controller.signal });
        const data = await res.json() as { text?: string; transcript?: string };
        return data.text || data.transcript || null;
    } finally {
        clearTimeout(timeout);
    }
}

async function synthesizeSpeech(text: string): Promise<ArrayBuffer | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return null;

    const voice = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
    try {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text.trim(),
                model_id: 'eleven_turbo_v2_5',
                voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
            }),
        });
        if (!res.ok) return null;
        return res.arrayBuffer();
    } catch {
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

            console.log(`[PTT] Received audio: ${audio.size} bytes, type: ${audio.type}`);
            const t = await transcribeAudio(audio);
            if (!t?.trim()) {
                // Empty transcription = silence or header-only blob. Return 200 with empty
                // transcript so the client can show a friendly message instead of an error.
                return NextResponse.json({ transcript: '', empty: true });
            }
            transcript = t.trim();
            console.log(`[PTT] Transcript: "${transcript}"`);
        } else {
            // JSON with pre-transcribed text (legacy / dashboard)
            const body = await req.json() as { transcript?: string; sessionId?: string };
            transcript = body.transcript;
            sessionId = body.sessionId;
        }

        if (!transcript) {
            return NextResponse.json({ error: 'Missing transcript' }, { status: 400 });
        }

        const result = await processGuardianVoiceCommand({ transcript, sessionId });

        // Synthesize response audio if guardian produced a spoken response
        const responseText: string | undefined =
            (result as { spokenResponse?: string; responseText?: string; response?: string }).spokenResponse ||
            (result as { spokenResponse?: string; responseText?: string; response?: string }).responseText ||
            (result as { spokenResponse?: string; responseText?: string; response?: string }).response;

        if (responseText) {
            const audioBuffer = await synthesizeSpeech(responseText);
            if (audioBuffer) {
                // Return MP3 directly — extension plays it on MacBook speakers
                return new Response(audioBuffer, {
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
