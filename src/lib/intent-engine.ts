import { getGenAI, generateWithFallback } from './ai';
import { canUseCloudTextReasoning, sanitizeTranscriptForCloud } from './cloud-privacy';
import { MODEL_FLASH } from './models';

export async function parseLockInIntent(transcript: string, _userId: string = 'default') {
    const ai = getGenAI();
    if (!ai || !canUseCloudTextReasoning()) return null;
    const sanitizedTranscript = sanitizeTranscriptForCloud(transcript);

    const prompt = `Parse the following user voice transcript into a structured intent for the LifeOS Guardian. 
Respond ONLY with a valid JSON object. Do not use markdown blocks.

Transcript: "${sanitizedTranscript}"

JSON Schema:
{
  "confidence": <number 0-1 that this is a lock-in request>,
  "action": "lock_in" | "casual_chat" | "system_command",
  "parameters": {
     "topic": "<string, what to study/focus on>",
     "durationMinutes": <number, how long to focus, default 60>,
     "mood": "high" | "neutral" | "low"
  },
  "clarificationNeeded": "<string, if topic or duration is ambiguous, what should Jarvis ask?>"
}`;

    try {
        const result = await generateWithFallback(ai, {
            model: MODEL_FLASH || 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: "You are Jarvis, extracting structured intent from voice transcripts.",
                responseMimeType: 'application/json'
            }
        });

        const text = (result.text || '').trim();
        if (!text) return null;
        return JSON.parse(text);
    } catch (e) {
        console.error('Intent parsing failed', e);
        return null;
    }
}

export async function resolveAmbiguity(transcript: string, candidates: string[]) {
    return candidates[0]; // Stub logic
}
