import { NextResponse } from 'next/server';

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export async function POST(req: Request) {
    try {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 503 });
        }

        const { text, voiceId } = await req.json() as { text: string; voiceId?: string };
        if (!text?.trim()) {
            return NextResponse.json({ error: 'Missing text' }, { status: 400 });
        }

        const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

        const response = await fetch(`${ELEVENLABS_API_URL}/${voice}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: text.trim(),
                model_id: 'eleven_turbo_v2_5',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true,
                },
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            console.error('[TTS] ElevenLabs error:', response.status, err);
            return NextResponse.json({ error: `ElevenLabs returned ${response.status}` }, { status: 502 });
        }

        const audioBuffer = await response.arrayBuffer();
        return new Response(audioBuffer, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': String(audioBuffer.byteLength),
                'Cache-Control': 'no-store',
            },
        });
    } catch (err) {
        console.error('[TTS] route error:', err);
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const text = searchParams.get('text');
    if (!text) return NextResponse.json({ error: 'Missing text param' }, { status: 400 });

    return POST(new Request(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    }));
}
