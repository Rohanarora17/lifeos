import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI } from '@/lib/ai';


export const maxDuration = 60; // Allow 60s for Vision API processing

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { habit_id, image_base64, metadata, date } = body;

        if (!habit_id || !image_base64) {
            return NextResponse.json({ error: 'Missing habit_id or image' }, { status: 400 });
        }

        const db = getDb();
        const habit = db.prepare('SELECT name FROM habits WHERE id = ?').get(habit_id) as any;
        if (!habit) return NextResponse.json({ error: 'Habit not found' }, { status: 404 });

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ error: 'AI not configured' }, { status: 500 });


        // Clean base64 string
        const base64Data = image_base64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");

        const prompt = `You are a strict, objective AI verification agent.
The user claims they have completed their habit: "${habit.name}".
They have uploaded this photo as proof.

Below is the extracted EXIF metadata from the image (GPS location, timestamps, etc.):
${JSON.stringify(metadata, null, 2)}

Analyze the image contents AND the metadata. 
1. Does the image visually depict the habit "${habit.name}"?
2. Does the metadata (if available) align with realistic verification? (e.g. if the habit is "Go to gym", does the picture look like a gym?)

Return EXACTLY a JSON object with this schema:
{
  "verified": boolean,
  "reason": "Short explanation of why you accepted or rejected the proof."
}`;

        const imagePart = {
            inlineData: {
                data: base64Data,
                mimeType: image_base64.match(/[^:]\w+\/[\w-+\d.]+(?=;|,)/)?.[0] || 'image/jpeg'
            },
        };

        const result = await ai.models.generateContent({
            model: 'gemini-pro-latest',
            contents: [prompt, imagePart]
        });
        let text = (result.text || '').trim();

        // Remove markdown tags if any
        if (text.startsWith('\`\`\`json')) text = text.substring(7);
        if (text.startsWith('\`\`\`')) text = text.substring(3);
        if (text.endsWith('\`\`\`')) text = text.substring(0, text.length - 3);

        let verificationResult = { verified: false, reason: 'Failed to parse AI response' };
        try {
            verificationResult = JSON.parse(text.trim());
        } catch (e) {
            console.error('Failed to parse Gemini Vision JSON:', text);
        }

        if (verificationResult.verified) {
            // Reward the user: Log the check-in and award coins
            const checkinDate = date || new Date(Date.now() + 19800000).toISOString().slice(0, 10);

            const existing = db.prepare('SELECT id FROM habit_checkins WHERE habit_id = ? AND date = ?').get(habit_id, checkinDate);
            if (!existing) {
                db.prepare('INSERT INTO habit_checkins (habit_id, date, completed, value) VALUES (?, ?, ?, ?)').run(habit_id, checkinDate, 1, 1);
                try {
                    db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(50, `Photo Verified: ${habit.name}`);
                } catch (e) { }
            }
        }

        console.log(`[PhotoProof] Habit: ${habit.name} | Verified: ${verificationResult.verified} | Reason: ${verificationResult.reason}`);

        return NextResponse.json(verificationResult);

    } catch (error: any) {
        console.error('Proof API error:', error);

        // Handle Gemini 503 Overloaded or API Key exhaustions gracefully
        if (error.status === 503 || error.message?.includes('overloaded')) {
            return NextResponse.json({ verified: false, reason: "Gemini Vision is currently rate-limited or overloaded. Please try again in 1 minute." });
        }

        return NextResponse.json({ verified: false, reason: 'Vision processing failed: ' + error.message });
    }
}
