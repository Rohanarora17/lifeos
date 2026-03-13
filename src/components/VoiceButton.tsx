'use client';

import React, { useState, useRef } from 'react';

export default function VoiceButton({ onTranscript }: { onTranscript?: (text: string) => void }) {
    const [isListening, setIsListening] = useState(false);
    const recognitionRef = useRef<any>(null);

    const toggleListen = () => {
        if (isListening) {
            recognitionRef.current?.stop();
            setIsListening(false);
            return;
        }

        if (!('webkitSpeechRecognition' in window)) {
            alert('Speech recognition not supported in this browser. Use Chrome.');
            return;
        }

        const SpeechRecognition = (window as any).webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;

        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => setIsListening(true);
        recognition.onresult = async (event: any) => {
            const transcript = event.results[0][0].transcript;

            if (onTranscript) {
                onTranscript(transcript);
            } else {
                // Default action: POST to /api/jarvis/intent
                try {
                    await fetch('/api/jarvis/intent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ transcript })
                    });
                } catch (e) { console.error('Intent failed', e); }
            }
        };
        recognition.onerror = () => setIsListening(false);
        recognition.onend = () => setIsListening(false);

        recognition.start();
    };

    return (
        <button
            onClick={toggleListen}
            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${isListening ? 'bg-red-500 animate-pulse shadow-[0_0_30px_rgba(239,68,68,0.5)]' : 'bg-blue-600 hover:bg-blue-500 shadow-lg'}`}
        >
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
        </button>
    );
}
