// offscreen.js — runs in offscreen document (MV3)
// Handles: microphone capture (MediaRecorder) + audio playback (Web Audio)
// Background service worker can't do either — this is the audio bridge.

// Server URL is passed via message from background.js (which reads it from storage).
// Fallback to localhost for local dev.
let SERVER = 'http://localhost:3000';

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioContext = null;
let recordingStartTime = 0;  // ms timestamp when recording started
const MIN_RECORDING_MS = 500; // minimum duration to capture real audio frames

// ── Message handler from background ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  // Acknowledge immediately for ALL message types — do NOT return true.
  // Keeping the channel open (return true) causes "message channel closed before response"
  // when the background service worker idles. Results are sent back via separate
  // chrome.runtime.sendMessage calls (RECORDING_STARTED, PTT_DONE, PTT_ERROR, etc.).
  sendResponse({ ok: true });

  switch (msg.type) {
    case 'PING':
      break; // ack already sent above

    case 'START_RECORDING':
      // Store the server URL passed from background.js so sendAudio uses the right host
      if (msg.serverUrl) SERVER = msg.serverUrl;
      startRecording(msg.sessionId).catch(e =>
        chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: e.message })
      );
      break;

    case 'STOP_RECORDING':
      stopRecording(msg.sessionId).catch(e =>
        chrome.runtime.sendMessage({ type: 'PTT_ERROR', error: e.message })
      );
      break;

    case 'PLAY_AUDIO_URL':
      playAudioUrl(msg.url).catch(e => console.error('[Offscreen] PLAY_AUDIO_URL failed:', e));
      break;

    case 'PLAY_AUDIO_TEXT':
      playText(msg.text, msg.sessionId).catch(e => console.error('[Offscreen] PLAY_AUDIO_TEXT failed:', e));
      break;
  }
  // No return true — channel is closed immediately after sendResponse above.
});

// ── Recording ─────────────────────────────────────────────────────────────────

async function startRecording(sessionId) {
  if (isRecording) return;

  // Pre-flight mic permission check.
  // Offscreen docs can call getUserMedia but Chrome shows a tiny non-obvious prompt.
  // If permission isn't already granted, tell background to open the popup instead.
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'denied') {
      chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_NEEDED', reason: 'denied' });
      return;
    }
    if (perm.state === 'prompt') {
      // Not yet granted — ask background to open popup for a visible grant flow
      chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_NEEDED', reason: 'prompt' });
      return;
    }
  } catch {
    // permissions API not available — attempt getUserMedia anyway
  }

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
    recordingStartTime = Date.now();

    // Notify background that recording started (for UI indicator)
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
    console.log('[Offscreen] Recording started');
  } catch (err) {
    const name = err?.name || '';
    const message = err?.message || String(err);
    console.error(`[Offscreen] getUserMedia failed: ${name}: ${message}`);
    chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: `${name}: ${message}` });
  }
}

async function stopRecording(sessionId) {
  if (!isRecording || !mediaRecorder) return;

  // Enforce minimum recording duration — a WebM blob with < MIN_RECORDING_MS
  // of audio contains only container headers (< ~200 bytes) and can't be transcribed.
  const elapsed = Date.now() - recordingStartTime;
  if (elapsed < MIN_RECORDING_MS) {
    const wait = MIN_RECORDING_MS - elapsed;
    console.log(`[Offscreen] Recording too short (${elapsed}ms), waiting ${wait}ms more...`);
    await new Promise(r => setTimeout(r, wait));
  }

  isRecording = false;
  mediaRecorder.stop();
  console.log(`[Offscreen] Recording stopped after ${Date.now() - recordingStartTime}ms`);
}

async function sendAudio(sessionId) {
  const blob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
  audioChunks = [];

  const blobSize = blob.size;
  console.log(`[Offscreen] Sending audio (${blobSize} bytes) to ${SERVER}`);
  chrome.runtime.sendMessage({ type: 'PTT_SENDING' });

  // If truly empty (< 50 bytes = only file-level WebM header, no audio cluster at all),
  // there is nothing the server can do with it.
  if (blobSize < 50) {
    console.warn(`[Offscreen] Audio blob empty (${blobSize} bytes) — mic may not have started yet`);
    chrome.runtime.sendMessage({ type: 'PTT_ERROR', error: 'No audio captured — try again' });
    return;
  }

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
      if (data.empty || !data.transcript) {
        // Silence or inaudible — show friendly overlay message
        console.log('[Offscreen] Empty transcript (silence or too quiet)');
        chrome.runtime.sendMessage({ type: 'PTT_DONE', transcript: '', responseText: '' });
        return;
      }
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
