import { ChildProcess, spawn } from 'child_process';
import { emitGuardianRuntimeEvent, setPendingSpeech } from './guardian-bus';

interface SpeechRequest {
    text: string;
    tone: string;
    sessionId: string;
}

interface TtsAdapter {
    name: string;
    speak: (request: SpeechRequest) => ChildProcess | null;
    stop: () => void;
}

const globalTTS = global as unknown as {
    speechQueue: SpeechRequest[];
    isSpeaking: boolean;
    currentProcess: ChildProcess | null;
};

export const speechQueue = globalTTS.speechQueue || [];
export let isSpeaking = globalTTS.isSpeaking || false;
export let currentProcess = globalTTS.currentProcess || null;
const speechSuppressions = new Map<string, number>();

if (process.env.NODE_ENV !== 'production') {
    globalTTS.speechQueue = speechQueue;
    globalTTS.isSpeaking = isSpeaking;
    globalTTS.currentProcess = currentProcess;
}

export async function speak(sessionId: string, text: string, priority: 'normal' | 'urgent' = 'normal', tone: string = 'neutral') {
    if (isSpeechSuppressed(sessionId)) return;
    if (priority === 'urgent') {
        if (currentProcess) {
            currentProcess.kill('SIGTERM');
            currentProcess = null;
        }
        isSpeaking = false;
        speechQueue.unshift({ text, tone, sessionId });
    } else {
        if (speechQueue.length >= 2) speechQueue.shift();
        speechQueue.push({ text, tone, sessionId });
    }

    processQueue();
}

export function suppressSpeechForRequest(sessionId: string) {
    speechSuppressions.set(sessionId, (speechSuppressions.get(sessionId) || 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = (speechSuppressions.get(sessionId) || 1) - 1;
        if (remaining <= 0) speechSuppressions.delete(sessionId);
        else speechSuppressions.set(sessionId, remaining);
    };
}

export function isSpeechSuppressed(sessionId: string) {
    return (speechSuppressions.get(sessionId) || 0) > 0;
}

function getTtsAdapter(): TtsAdapter {
    const provider = (process.env.LIFEOS_TTS_PROVIDER || 'say').toLowerCase();
    const voice = process.env.LIFEOS_TTS_VOICE || 'Daniel';

    return {
        name: provider,
        speak(request: SpeechRequest) {
            if (provider === 'disabled' || process.platform !== 'darwin') {
                return null;
            }
            return spawn('say', ['-v', voice, request.text]);
        },
        stop() {
            if (currentProcess) {
                currentProcess.kill('SIGTERM');
                currentProcess = null;
            }
        },
    };
}

function getElevenLabsAdapter(): TtsAdapter {
    return {
        name: 'elevenlabs',
        speak(request: SpeechRequest) {
            // Emit SSE tts_speak event — extension fetches /api/voice/tts and plays on MacBook
            setImmediate(() => {
                emitGuardianRuntimeEvent(request.sessionId, {
                    type: 'tts_speak',
                    text: request.text,
                    tone: request.tone,
                    provider: 'elevenlabs',
                });
            });
            // Also queue for dashboard Web Speech API (dashboard sessions poll state, not SSE).
            setPendingSpeech(request.sessionId, request.text);
            // ElevenLabs is async/SSE-driven — no child process to track
            return null;
        },
        stop() {
            // No-op: extension handles its own playback stop
        },
    };
}

function processQueue() {
    if (isSpeaking || speechQueue.length === 0) return;

    isSpeaking = true;
    const request = speechQueue.shift()!;
    const provider = (process.env.LIFEOS_TTS_PROVIDER || 'say').toLowerCase();
    const adapter = provider === 'elevenlabs' ? getElevenLabsAdapter() : getTtsAdapter();

    emitGuardianRuntimeEvent(request.sessionId, {
        type: 'jarvis_speech',
        text: request.text,
        tone: request.tone,
        provider: adapter.name,
    });

    emitGuardianRuntimeEvent(request.sessionId, {
        type: 'guardian_speech_start',
        tone: request.tone,
        provider: adapter.name,
    });

    currentProcess = adapter.speak(request);
    if (!currentProcess) {
        isSpeaking = false;
        emitGuardianRuntimeEvent(request.sessionId, {
            type: 'guardian_speech_end',
            tone: request.tone,
            provider: adapter.name,
        });
        return;
    }

    let finished = false;
    const finishSpeech = () => {
        if (finished) return;
        finished = true;
        isSpeaking = false;
        currentProcess = null;
        emitGuardianRuntimeEvent(request.sessionId, {
            type: 'guardian_speech_end',
            tone: request.tone,
            provider: adapter.name,
        });
        // slight pause between speeches
        setTimeout(() => processQueue(), 1000);
    };
    currentProcess.on('error', (error) => {
        console.warn(`[TTS] ${adapter.name} playback unavailable: ${error.message}`);
        finishSpeech();
    });
    currentProcess.on('close', finishSpeech);
}

export function stopAllSpeech() {
    getTtsAdapter().stop();
    speechQueue.length = 0;
    isSpeaking = false;
}
