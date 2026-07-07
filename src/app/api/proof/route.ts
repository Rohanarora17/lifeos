import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_PRO } from '@/lib/models';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveRewardDecision, type AdaptiveRewardDecision } from '@/lib/adaptive-rewards';
import { recordAdaptiveHabitCheckin } from '@/lib/adaptive-habit-checkin';


export const maxDuration = 60; // Allow 60s for Vision API processing

interface ProofRequestBody {
    habit_id?: number;
    image_base64?: string;
    metadata?: unknown;
    date?: string;
}

interface HabitProofRow {
    name: string;
}

interface VerificationResult {
    verified: boolean;
    reason: string;
    reward?: AdaptiveRewardDecision | null;
    checkin?: ReturnType<typeof recordAdaptiveHabitCheckin> | null;
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as ProofRequestBody;
        const { habit_id, image_base64, metadata, date } = body;

        if (!habit_id || !image_base64) {
            return NextResponse.json({ error: 'Missing habit_id or image' }, { status: 400 });
        }

        const db = getDb();
        const habit = db.prepare('SELECT name FROM habits WHERE id = ?').get(habit_id) as HabitProofRow | undefined;
        if (!habit) return NextResponse.json({ error: 'Habit not found' }, { status: 404 });

        const ai = getGenAI();


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

        const result = await generateWithFallback(ai, {
            model: MODEL_PRO,
            contents: [prompt, imagePart]
        });
        let text = (result.text || '').trim();

        // Remove markdown tags if any
        if (text.startsWith('\`\`\`json')) text = text.substring(7);
        if (text.startsWith('\`\`\`')) text = text.substring(3);
        if (text.endsWith('\`\`\`')) text = text.substring(0, text.length - 3);

        let verificationResult: VerificationResult = { verified: false, reason: 'Failed to parse AI response', reward: null };
        try {
            const parsed = JSON.parse(text.trim()) as Partial<VerificationResult>;
            verificationResult = {
                verified: !!parsed.verified,
                reason: parsed.reason || 'No verification reason returned',
                reward: null,
            };
        } catch {
            console.error('Failed to parse Gemini Vision JSON:', text);
        }

        if (verificationResult.verified) {
            // Reward the user: Log the check-in and award coins
            const checkinDate = date || new Date(Date.now() + 19800000).toISOString().slice(0, 10);

            const checkin = recordAdaptiveHabitCheckin({
                habitId: habit_id,
                date: checkinDate,
                source: 'photo_proof',
                forceComplete: true,
            });
            verificationResult.checkin = checkin;
            if (!checkin.alreadyCompleted && checkin.completed) {
                const rewardSnapshot = buildPersonalizationSnapshot({
                    surface: 'rewards',
                    maxInsights: 2,
                    includeMemoryFacts: 3,
                });
                const reward = getAdaptiveRewardDecision({
                    action: 'photo_proof',
                    baseCoins: 50,
                    subject: `${habit.name} (ID: ${habit_id})`,
                    snapshot: rewardSnapshot,
                });
                try {
                    db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason);
                } catch { }
                verificationResult.reward = reward;
            }
        }

        console.log(`[PhotoProof] Habit: ${habit.name} | Verified: ${verificationResult.verified} | Reason: ${verificationResult.reason}`);

        return NextResponse.json(verificationResult);

    } catch (error: unknown) {
        console.error('Proof API error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        const status = typeof error === 'object' && error !== null && 'status' in error
            ? Number((error as { status?: unknown }).status)
            : undefined;

        // Handle Gemini 503 Overloaded or API Key exhaustions gracefully
        if (status === 503 || message.includes('overloaded')) {
            return NextResponse.json({ verified: false, reason: "Gemini Vision is currently rate-limited or overloaded. Please try again in 1 minute." });
        }

        return NextResponse.json({ verified: false, reason: 'Vision processing failed: ' + message });
    }
}
