#!/usr/bin/env node

import process from 'node:process';
import { GoogleGenAI, Modality } from '@google/genai';

const model =
  process.env.LIVEKIT_GUARDIAN_MODEL || 'gemini-live-2.5-flash';
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
const timeoutMs = Number(process.env.LIFEOS_LIVE_VOICE_TIMEOUT_MS || 12_000);
const firstAudioTargetMs = Number(
  process.env.LIFEOS_LIVE_VOICE_FIRST_AUDIO_TARGET_MS || 1_500
);

if (!project) {
  throw new Error('GOOGLE_CLOUD_PROJECT is required for the Vertex Live canary');
}

const ai = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

let sentAt = 0;
let openedAt = 0;
let firstMessageAt = 0;
let firstAudioAt = 0;
let turnCompleteAt = 0;
let socketError = '';
let responseTimedOut = false;
let finish;
const completed = new Promise((resolve) => {
  finish = resolve;
});

const startedAt = Date.now();
let session;
let connectionTimer;
let responseTimer;

try {
  session = await Promise.race([
    ai.live.connect({
      model,
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onopen() {
          openedAt = Date.now();
        },
        onmessage(message) {
          const now = Date.now();
          if (sentAt && !firstMessageAt) firstMessageAt = now;
          const parts = message?.serverContent?.modelTurn?.parts || [];
          if (
            sentAt &&
            !firstAudioAt &&
            parts.some((part) => part?.inlineData?.data)
          ) {
            firstAudioAt = now;
          }
          if (message?.serverContent?.turnComplete) {
            turnCompleteAt = now;
            finish();
          }
        },
        onerror(event) {
          socketError = String(
            event?.error?.message || event?.message || event
          ).slice(0, 500);
          finish();
        },
        onclose() {},
      },
    }),
    new Promise((_, reject) => {
      connectionTimer = setTimeout(
        () => reject(new Error(`Connection timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
    }),
  ]);
  clearTimeout(connectionTimer);

  sentAt = Date.now();
  session.sendClientContent({
    turns: 'Say only: ready',
    turnComplete: true,
  });

  await Promise.race([
    completed,
    new Promise((resolve) => {
      responseTimer = setTimeout(() => {
        responseTimedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);
  clearTimeout(responseTimer);

  const firstAudioMs = firstAudioAt ? firstAudioAt - sentAt : null;
  const passed =
    !socketError &&
    firstAudioMs !== null &&
    firstAudioMs <= firstAudioTargetMs &&
    Boolean(turnCompleteAt);

  console.log(
    JSON.stringify({
      model,
      status: passed ? 'pass' : 'fail',
      connectedMs: openedAt ? openedAt - startedAt : null,
      firstMessageMs: firstMessageAt ? firstMessageAt - sentAt : null,
      firstAudioMs,
      turnCompleteMs: turnCompleteAt ? turnCompleteAt - sentAt : null,
      firstAudioTargetMs,
      error:
        socketError ||
        (responseTimedOut ? `Response timed out after ${timeoutMs} ms` : null),
    })
  );

  if (!passed) process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({
      model,
      status: 'fail',
      error: String(error?.message || error).slice(0, 500),
    })
  );
  process.exitCode = 1;
} finally {
  clearTimeout(connectionTimer);
  clearTimeout(responseTimer);
  try {
    session?.close();
  } catch {}
}
