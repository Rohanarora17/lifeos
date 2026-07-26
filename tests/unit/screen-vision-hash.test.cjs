'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-screen-vision-hash-');
const {
  computeImageHash,
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

    assert.equal(lowHash, highHash);
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
});
