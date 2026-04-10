import { NextResponse } from 'next/server';

function getWhisperCppUrl() {
    return (process.env.WHISPER_CPP_URL || '').trim();
}

function getWhisperCppMode() {
    return process.env.WHISPER_CPP_MODE === 'openai' ? 'openai' : 'native';
}

async function forwardToWhisperCpp(audio: Blob | File) {
    const whisperUrl = getWhisperCppUrl();
    const upstreamFormData = new FormData();
    const filename = audio instanceof File && audio.name ? audio.name : 'speech.webm';
    const file = audio instanceof File ? audio : new File([audio], filename, { type: audio.type || 'audio/webm' });

    upstreamFormData.set('file', file, file.name);
    upstreamFormData.set('audio', file, file.name);

    if (getWhisperCppMode() === 'openai') {
        upstreamFormData.set('model', process.env.WHISPER_CPP_OPENAI_MODEL || 'whisper-1');
        upstreamFormData.set('response_format', 'json');
    } else {
        upstreamFormData.set('response-format', 'json');
        if (process.env.WHISPER_CPP_LANGUAGE) {
            upstreamFormData.set('language', process.env.WHISPER_CPP_LANGUAGE);
        }
        if (process.env.WHISPER_CPP_TRANSLATE === '1' || process.env.WHISPER_CPP_TRANSLATE === 'true') {
            upstreamFormData.set('translate', 'true');
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.WHISPER_CPP_TIMEOUT_MS || '60000'));

    // Add Authorization header for external APIs (Groq, OpenAI)
    const headers: Record<string, string> = {};
    if (process.env.GROQ_API_KEY && whisperUrl.includes('groq.com')) {
        headers['Authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
    } else if (process.env.OPENAI_API_KEY && whisperUrl.includes('openai.com')) {
        headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
    }

    try {
        const upstream = await fetch(whisperUrl, {
            method: 'POST',
            body: upstreamFormData,
            headers,
            signal: controller.signal,
        });

        const text = await upstream.text();
        let data: Record<string, unknown> = {};
        try {
            data = text ? JSON.parse(text) as Record<string, unknown> : {};
        } catch {
            data = { text };
        }

        if (!upstream.ok) {
            return NextResponse.json(
                {
                    error: typeof data.error === 'string' ? data.error : `whisper.cpp upstream returned ${upstream.status}`,
                    upstreamStatus: upstream.status,
                    raw: data,
                },
                { status: 502 }
            );
        }

        return NextResponse.json({
            transcript:
                (typeof data.transcript === 'string' && data.transcript) ||
                (typeof data.text === 'string' && data.text) ||
                '',
            confidence: typeof data.confidence === 'number' ? data.confidence : 0,
            mode: 'whisper.cpp',
            raw: data,
        });
    } finally {
        clearTimeout(timeout);
    }
}

export async function POST(req: Request) {
    try {
        const contentType = req.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            const body = await req.json();
            if (typeof body.transcript === 'string' && body.transcript.trim()) {
                return NextResponse.json({
                    transcript: body.transcript.trim(),
                    confidence: typeof body.confidence === 'number' ? body.confidence : 1,
                    mode: 'passthrough',
                });
            }
            return NextResponse.json({ error: 'Missing transcript' }, { status: 400 });
        }

        const formData = await req.formData();
        const audio = formData.get('audio');

        if (!audio) {
            return NextResponse.json({ error: 'Missing audio blob' }, { status: 400 });
        }

        const whisperUrl = getWhisperCppUrl();
        if (whisperUrl) {
            if (!(audio instanceof Blob)) {
                return NextResponse.json({ error: 'Audio payload must be a blob or file' }, { status: 400 });
            }

            return forwardToWhisperCpp(audio);
        }

        return NextResponse.json({
            transcript: "Let's lock in on advanced typescript for 60 minutes",
            confidence: 0.99,
            mode: 'stub',
        });
    } catch (error) {
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}

export async function GET() {
    return NextResponse.json({
        configured: Boolean(getWhisperCppUrl()),
        mode: getWhisperCppUrl() ? 'whisper.cpp' : 'stub',
        whisperUrl: getWhisperCppUrl() || null,
        whisperMode: getWhisperCppMode(),
        language: process.env.WHISPER_CPP_LANGUAGE || null,
    });
}
