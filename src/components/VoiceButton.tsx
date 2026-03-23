'use client';

import React, { useRef, useState } from 'react';

type VoiceButtonState = 'idle' | 'recording' | 'transcribing';
type BrowserSpeechRecognitionResultEvent = Event & {
    results: ArrayLike<ArrayLike<{ transcript: string }>>;
};
type BrowserSpeechRecognition = {
    continuous: boolean;
    interimResults: boolean;
    onstart: (() => void) | null;
    onresult: ((event: BrowserSpeechRecognitionResultEvent) => void | Promise<void>) | null;
    onerror: (() => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
};
type BrowserWindowWithSpeech = Window & typeof globalThis & {
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
};

export default function VoiceButton({
    onTranscript,
    sessionId,
}: {
    onTranscript?: (text: string) => void;
    sessionId?: string | null;
}) {
    const [state, setState] = useState<VoiceButtonState>('idle');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);

    const stopStream = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    };

    const submitTranscript = async (transcript: string) => {
        if (onTranscript) {
            onTranscript(transcript);
            return;
        }

        await fetch('/api/voice/push-to-talk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript, sessionId }),
        });
    };

    const startSpeechRecognitionFallback = () => {
        const browserWindow = window as BrowserWindowWithSpeech;
        if (!browserWindow.webkitSpeechRecognition) {
            alert('Push-to-talk recording is not supported in this browser.');
            return;
        }

        const SpeechRecognition = browserWindow.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;

        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => setState('recording');
        recognition.onresult = async (event: BrowserSpeechRecognitionResultEvent) => {
            const transcript = event.results[0][0].transcript;
            await submitTranscript(transcript);
        };
        recognition.onerror = () => setState('idle');
        recognition.onend = () => setState('idle');

        recognition.start();
    };

    const startRecording = async () => {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
            startSpeechRecognitionFallback();
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];

        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunksRef.current.push(event.data);
            }
        };

        recorder.onstop = async () => {
            setState('transcribing');
            try {
                const audioBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
                const formData = new FormData();
                formData.append('audio', audioBlob, 'push-to-talk.webm');

                const response = await fetch('/api/voice/transcribe', {
                    method: 'POST',
                    body: formData,
                });
                const data = await response.json();
                if (!response.ok || !data?.transcript) {
                    throw new Error(data?.error || 'Voice transcription failed');
                }

                await submitTranscript(data.transcript);
            } catch (error) {
                console.error('Voice transcription failed', error);
            } finally {
                chunksRef.current = [];
                mediaRecorderRef.current = null;
                stopStream();
                setState('idle');
            }
        };

        recorder.start();
        setState('recording');
    };

    const stopRecording = () => {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
            return;
        }

        recognitionRef.current?.stop();
        recognitionRef.current = null;
        stopStream();
        setState('idle');
    };

    const toggleListen = async () => {
        if (state === 'recording') {
            stopRecording();
            return;
        }

        if (state === 'transcribing') {
            return;
        }

        try {
            await startRecording();
        } catch (error) {
            console.error('Voice capture failed', error);
            stopStream();
            setState('idle');
        }
    };

    const isRecording = state === 'recording';
    const isBusy = state === 'transcribing';

    return (
        <button
            onClick={() => {
                void toggleListen();
            }}
            disabled={isBusy}
            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                isRecording
                    ? 'bg-red-500 animate-pulse shadow-[0_0_30px_rgba(239,68,68,0.5)]'
                    : isBusy
                        ? 'bg-amber-500 shadow-[0_0_30px_rgba(245,158,11,0.35)]'
                        : 'bg-blue-600 hover:bg-blue-500 shadow-lg'
            }`}
            title={isRecording ? 'Release to send transcript' : isBusy ? 'Transcribing…' : 'Push to talk'}
        >
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
        </button>
    );
}
