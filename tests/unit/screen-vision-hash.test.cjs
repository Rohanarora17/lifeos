'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-screen-vision-hash-');
const {
  computeImageHash,
  decideVisionAnalysis,
  getChangeMagnitude,
  hammingDistance,
} = env.requireLib('screen-vision.ts');

async function jpegFromRaw(data, width, height, quality) {
  return (await sharp(data, {
    raw: { width, height, channels: 3 },
  }).jpeg({ quality }).toBuffer()).toString('base64');
}

describe('screen vision perceptual hashing', () => {
  it('hashes decoded pixels rather than JPEG encoding bytes', async () => {
    const pixels = Buffer.alloc(16 * 16 * 3);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const offset = (y * 16 + x) * 3;
        const value = x < 8 ? 20 : 230;
        pixels.fill(value, offset, offset + 3);
      }
    }

    const lowQuality = await jpegFromRaw(pixels, 16, 16, 35);
    const highQuality = await jpegFromRaw(pixels, 16, 16, 95);
    const lowHash = await computeImageHash(lowQuality);
    const highHash = await computeImageHash(highQuality);

    assert.equal(getChangeMagnitude(lowHash, highHash), 'none');
  });

  it('detects a materially different pixel layout', async () => {
    const vertical = Buffer.alloc(16 * 16 * 3);
    const horizontal = Buffer.alloc(16 * 16 * 3);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        vertical.fill(x < 8 ? 20 : 230, (y * 16 + x) * 3, (y * 16 + x) * 3 + 3);
        horizontal.fill(y < 8 ? 20 : 230, (y * 16 + x) * 3, (y * 16 + x) * 3 + 3);
      }
    }

    const verticalHash = await computeImageHash(await jpegFromRaw(vertical, 16, 16, 90));
    const horizontalHash = await computeImageHash(await jpegFromRaw(horizontal, 16, 16, 90));

    assert.ok(hammingDistance(verticalHash, horizontalHash) >= 24);
  });

  it('detects small text-like pixel changes without treating a static frame as changed', async () => {
    const first = Buffer.alloc(64 * 64 * 3, 245);
    const second = Buffer.from(first);
    for (let y = 20; y < 24; y++) {
      for (let x = 8; x < 42; x++) {
        second.fill(20, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
      }
    }

    const firstHash = await computeImageHash(await jpegFromRaw(first, 64, 64, 90));
    const secondHash = await computeImageHash(await jpegFromRaw(second, 64, 64, 90));

    assert.equal(getChangeMagnitude(firstHash, firstHash), 'none');
    assert.notEqual(getChangeMagnitude(secondHash, firstHash), 'none');
  });

  it('analyzes metadata changes and suppresses rapid same-window jitter', () => {
    const metadataChange = decideVisionAnalysis({
      pixelChange: 'none',
      previousApp: 'Google Chrome',
      previousWindowTitle: 'Document A',
      appInFocus: 'Google Chrome',
      windowTitle: 'Document B',
      lastAnalyzedAt: 1_000,
      now: 1_500,
    });
    assert.equal(metadataChange.analyze, true);
    assert.equal(metadataChange.reason, 'metadata_changed');

    const rapidJitter = decideVisionAnalysis({
      pixelChange: 'minor',
      previousApp: 'Google Chrome',
      previousWindowTitle: 'Document A',
      appInFocus: 'Google Chrome',
      windowTitle: 'Document A',
      lastAnalyzedAt: 1_000,
      now: 1_500,
    });
    assert.equal(rapidJitter.analyze, false);
    assert.equal(rapidJitter.reason, 'rapid_duplicate');
  });
});
