#!/usr/bin/env node
// Log rotation — runs nightly via launchd or cron.
// Keeps the last N MB of each log file; archives older content to logs/archive/.
// Safe to run while the server is writing — truncates in-place so launchd
// file descriptors stay valid.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS_DIR = path.join(PROJECT_DIR, 'logs');
const ARCHIVE_DIR = path.join(LOGS_DIR, 'archive');
const MAX_SIZE_BYTES = Number(process.env.LOG_MAX_MB || '10') * 1024 * 1024; // 10 MB default
const KEEP_ARCHIVES = Number(process.env.LOG_KEEP_ARCHIVES || '7'); // keep 7 days

const LOG_FILES = ['server.log', 'server-error.log', 'daemon.log', 'daemon-error.log'];

if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);

for (const file of LOG_FILES) {
  const filePath = path.join(LOGS_DIR, file);
  if (!fs.existsSync(filePath)) continue;

  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_SIZE_BYTES) {
    console.log(`[rotate] ${file}: ${kb(stat.size)}KB — no rotation needed`);
    continue;
  }

  // Archive the current log
  const archiveName = `${file}.${stamp}`;
  const archivePath = path.join(ARCHIVE_DIR, archiveName);
  fs.copyFileSync(filePath, archivePath);

  // Truncate in-place (launchd keeps the fd open — rename+recreate would break it)
  fs.truncateSync(filePath, 0);

  console.log(`[rotate] ${file}: rotated ${kb(stat.size)}KB → archive/${archiveName}`);
}

// Prune old archives — delete anything older than KEEP_ARCHIVES days
const cutoff = Date.now() - KEEP_ARCHIVES * 24 * 60 * 60 * 1000;
let pruned = 0;
for (const f of fs.readdirSync(ARCHIVE_DIR)) {
  const p = path.join(ARCHIVE_DIR, f);
  if (fs.statSync(p).mtimeMs < cutoff) {
    fs.unlinkSync(p);
    pruned++;
  }
}
if (pruned) console.log(`[rotate] pruned ${pruned} archive(s) older than ${KEEP_ARCHIVES} days`);
console.log('[rotate] done');

function kb(bytes) { return Math.round(bytes / 1024); }
