import { NextResponse } from 'next/server';

// Tier B Whisper fallback endpoint. 
// Uses local whisper or a proxy. Currently stubs to a demonstration.
export async function POST(req: Request) {
    // STUB: Real whisper.cpp integration goes here in future.
    // LifeOS Tier A relies on Web Speech API in the browser.
    return NextResponse.json({ transcript: "Let's lock in on advanced typescript for 60 minutes", confidence: 0.99 });
}
