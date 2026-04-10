// offscreen.js — runs in offscreen document (MV3)
// Handles: microphone capture (MediaRecorder) + audio playback (Web Audio)
// Background service worker can't do either — this is the audio bridge.

const SERVER = 'http://localhost:3000';

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioContext = null;

// ── Message handler from background ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'START_RECORDING':
      startRecording(msg.sessionId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'STOP_RECORDING':
      stopRecording(msg.sessionId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'PLAY_AUDIO_URL':
      playAudioUrl(msg.url).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'PLAY_AUDIO_TEXT':
      playText(msg.text, msg.sessionId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
      return true;
  }
});

// ── Recording ─────────────────────────────────────────────────────────────────

async function startRecording(sessionId) {
  if (isRecording) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      if (audioChunks.length > 0) {
        sendAudio(sessionId);
      }
    };

    mediaRecorder.start(100); // collect in 100ms chunks
    isRecording = true;

    // Notify background that recording started (for UI indicator)
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
    console.log('[Offscreen] Recording started');
  } catch (err) {
    console.error('[Offscreen] getUserMedia failed:', err);
    chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: err.message });
  }
}

async function stopRecording(sessionId) {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  mediaRecorder.stop();
  console.log('[Offscreen] Recording stopped, sending audio...');
}

async function sendAudio(sessionId) {
  const blob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
  audioChunks = [];

  if (blob.size < 1000) {
    console.warn('[Offscreen] Audio too short, skipping');
    chrome.runtime.sendMessage({ type: 'PTT_ERROR', error: 'Audio too short' });
    return;
  }

  console.log(`[Offscreen] Sending ${blob.size} bytes to server`);
  chrome.runtime.sendMessage({ type: 'PTT_SENDING' });

  const form = new FormData();
  form.append('audio', blob, 'speech.webm');
  if (sessionId) form.append('sessionId', sessionId);

  try {
    const res = await fetch(`${SERVER}/api/voice/push-to-talk`, {
      method: 'POST',
      body: form,
    });

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('audio/mpeg')) {
      // Server returned ElevenLabs MP3 directly — play it
      const transcript = decodeURIComponent(res.headers.get('x-transcript') || '');
      const responseText = decodeURIComponent(res.headers.get('x-response-text') || '');
      console.log(`[Offscreen] Transcript: "${transcript}", Response: "${responseText}"`);

      const audioBuffer = await res.arrayBuffer();
      await playArrayBuffer(audioBuffer);
      chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript, responseText });
    } else {
      const data = await res.json();
      console.log('[Offscreen] PTT response:', data);
      chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript: data.transcript });
    }
  } catch (err) {
    console.error('[Offscreen] Send failed:', err);
    chrome.runtime.sendMessage({ type: 'PTT_ERROR', error: err.message });
  }
}

// ── Audio playback ────────────────────────────────────────────────────────────

async function playAudioUrl(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  await playArrayBuffer(buffer);
}

async function playText(text, sessionId) {
  const res = await fetch(`${SERVER}/api/voice/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error('[Offscreen] TTS fetch failed:', res.status);
    return;
  }
  const buffer = await res.arrayBuffer();
  await playArrayBuffer(buffer);
}

async function playArrayBuffer(buffer) {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  const decoded = await audioContext.decodeAudioData(buffer);
  const source = audioContext.createBufferSource();
  source.buffer = decoded;
  source.connect(audioContext.destination);
  source.start(0);

  return new Promise((resolve) => {
    source.onended = resolve;
  });
}

console.log('[Offscreen] LifeOS audio offscreen document ready');
