import { spawn } from 'child_process';
import { sessionEmitter } from './session-state';

interface SpeechRequest {
    text: string;
    tone: string;
    sessionId: string;
}

const globalTTS = global as unknown as {
    speechQueue: SpeechRequest[];
    isSpeaking: boolean;
    currentProcess: any;
};

export const speechQueue = globalTTS.speechQueue || [];
export let isSpeaking = globalTTS.isSpeaking || false;
export let currentProcess = globalTTS.currentProcess || null;

if (process.env.NODE_ENV !== 'production') {
    globalTTS.speechQueue = speechQueue;
    globalTTS.isSpeaking = isSpeaking;
    globalTTS.currentProcess = currentProcess;
}

export async function speak(sessionId: string, text: string, priority: 'normal' | 'urgent' = 'normal', tone: string = 'neutral') {
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

function processQueue() {
    if (isSpeaking || speechQueue.length === 0) return;

    isSpeaking = true;
    const request = speechQueue.shift()!;

    sessionEmitter.emit('agent_event', request.sessionId, {
        type: 'jarvis_speech',
        text: request.text,
        tone: request.tone
    });

    currentProcess = spawn('say', ['-v', 'Daniel', request.text]);

    currentProcess.on('close', () => {
        isSpeaking = false;
        currentProcess = null;
        // slight pause between speeches
        setTimeout(() => processQueue(), 1000);
    });
}

export function stopAllSpeech() {
    if (currentProcess) {
        currentProcess.kill('SIGTERM');
        currentProcess = null;
    }
    speechQueue.length = 0;
    isSpeaking = false;
}
