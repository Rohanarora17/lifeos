'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const logsDirectory = path.join(root, 'logs');
const maximumBytes = Number(process.env.LIFEOS_LOG_MAX_BYTES || 50 * 1024 * 1024);
const retainedFiles = Math.max(1, Number(process.env.LIFEOS_LOG_RETAINED_FILES || 5));
const names = ['server.log', 'server-error.log', 'daemon.log', 'daemon-error.log'];

if (!fs.existsSync(logsDirectory)) process.exit(0);

for (const name of names) {
  const current = path.join(logsDirectory, name);
  if (!fs.existsSync(current) || fs.statSync(current).size <= maximumBytes) continue;

  const oldest = `${current}.${retainedFiles}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let index = retainedFiles - 1; index >= 1; index -= 1) {
    const source = `${current}.${index}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${current}.${index + 1}`);
  }
  fs.renameSync(current, `${current}.1`);
  fs.closeSync(fs.openSync(current, 'a', 0o600));
  process.stdout.write(`rotated ${name}\n`);
}
