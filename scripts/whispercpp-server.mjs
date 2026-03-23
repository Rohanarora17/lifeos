#!/usr/bin/env node

import { access } from 'node:fs/promises';
import process from 'node:process';
import { spawn } from 'node:child_process';

const DEFAULT_HOST = process.env.WHISPER_CPP_HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.WHISPER_CPP_PORT || '8080';
const DEFAULT_INFERENCE_PATH = process.env.WHISPER_CPP_INFERENCE_PATH || '/inference';
const DEFAULT_MODEL = process.env.WHISPER_CPP_MODEL || '';

function isExecutableError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function ensureFileExists(path) {
  await access(path);
}

async function resolveBinary() {
  const explicit = process.env.WHISPER_CPP_BIN;
  if (explicit) {
    return explicit;
  }

  for (const candidate of ['whisper-server', 'whisper-cpp-server']) {
    try {
      const child = spawn(candidate, ['--help'], { stdio: 'ignore' });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.kill('SIGTERM');
      return candidate;
    } catch (error) {
      if (!isExecutableError(error)) {
        throw error;
      }
    }
  }

  throw new Error(
    'No whisper.cpp server binary found. Set WHISPER_CPP_BIN or install whisper.cpp so `whisper-server` is on PATH.'
  );
}

async function main() {
  if (!DEFAULT_MODEL) {
    throw new Error('Missing WHISPER_CPP_MODEL. Point it at a local GGML model file.');
  }

  await ensureFileExists(DEFAULT_MODEL);
  const binary = await resolveBinary();

  const args = ['-m', DEFAULT_MODEL, '--host', DEFAULT_HOST, '--port', DEFAULT_PORT];

  if (process.env.WHISPER_CPP_THREADS) {
    args.push('--threads', process.env.WHISPER_CPP_THREADS);
  }

  if (process.env.WHISPER_CPP_LANGUAGE) {
    args.push('--language', process.env.WHISPER_CPP_LANGUAGE);
  }

  if (process.env.WHISPER_CPP_TRANSLATE === '1' || process.env.WHISPER_CPP_TRANSLATE === 'true') {
    args.push('--translate');
  }

  console.log(`[whisper.cpp] binary=${binary}`);
  console.log(`[whisper.cpp] model=${DEFAULT_MODEL}`);
  console.log(`[whisper.cpp] listen=http://${DEFAULT_HOST}:${DEFAULT_PORT}${DEFAULT_INFERENCE_PATH}`);
  console.log('[whisper.cpp] point LifeOS at this URL via WHISPER_CPP_URL');

  const child = spawn(binary, args, {
    stdio: 'inherit',
    env: process.env,
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.once('error', (error) => {
    console.error(`[whisper.cpp] failed to start: ${String(error)}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`[whisper.cpp] ${String(error)}`);
  process.exit(1);
});
