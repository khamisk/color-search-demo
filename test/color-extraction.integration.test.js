import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { buildSubjectMask } from "../color-extraction-helpers.js";
import { assignSearchableColors } from "../server.js";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_FILE = path.join(ROOT_DIR, "data", "color-cache.json");
const HEX_COLOR = /^#[0-9A-F]{6}$/;

test("every cached mask has a readable filename linked to its original", async () => {
  const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  const entries = Object.values(cache.animals);

  assert.equal(cache.version, 2);
  assert.equal(entries.length, 26);
  for (const entry of entries) {
    const originalStem = path.parse(entry.sourceRelPath).name;
    assert.equal(entry.maskRelPath, `data/masks/${originalStem}-mask.png`);
    await fs.access(path.join(ROOT_DIR, entry.maskRelPath));
  }
});

function isLikelyWhiteMattePixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 232 && max - min <= 28;
}

function buildLegacySubjectMask(maskData, maskInfo) {
  const totalPixels = maskInfo.width * maskInfo.height;
  const subjectMask = new Uint8Array(totalPixels);
  let transparentPixels = 0;
  let subjectPixels = 0;

  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * maskInfo.channels;
    if (maskData[offset + 3] < 80) {
      transparentPixels += 1;
    }
  }

  const transparentShare = totalPixels > 0 ? transparentPixels / totalPixels : 0;
  const hasAlphaMask = transparentShare >= 0.01;

  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * maskInfo.channels;
    const alpha = maskData[offset + 3];
    const isSubject = hasAlphaMask
      ? alpha >= 96
      : alpha >= 80 && !isLikelyWhiteMattePixel(
        maskData[offset],
        maskData[offset + 1],
        maskData[offset + 2]
      );

    if (isSubject) {
      subjectMask[pixel] = 1;
      subjectPixels += 1;
    }
  }

  return { subjectMask, subjectPixels };
}

test("real processed animals produce valid searchable colors", async (t) => {
  const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  const entries = Object.values(cache.animals).filter((entry) => (
    entry.sourceRelPath && entry.maskRelPath
  ));

  assert.equal(entries.length, 26);

  for (const entry of entries) {
    await t.test(entry.sourceRelPath, async () => {
      const sourcePath = path.join(ROOT_DIR, "animals", entry.sourceRelPath);
      const maskPath = path.join(ROOT_DIR, entry.maskRelPath);
      const maskBuffer = await fs.readFile(maskPath);
      const colors = await assignSearchableColors(sourcePath, maskPath, maskBuffer);

      assert.ok(colors.length >= 1 && colors.length <= 4);
      assert.ok(colors.every((color) => HEX_COLOR.test(color)));
    });
  }
});

test("one-pass mask analysis exactly matches legacy behavior for every processed animal", async () => {
  const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  const entries = Object.values(cache.animals).filter((entry) => entry.maskRelPath);

  for (const entry of entries) {
    const maskPath = path.join(ROOT_DIR, entry.maskRelPath);
    const { data, info } = await sharp(maskPath)
      .ensureAlpha()
      .resize({ width: 420, height: 420, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const legacy = buildLegacySubjectMask(data, info);
    const optimized = buildSubjectMask(data, info, isLikelyWhiteMattePixel);

    assert.equal(optimized.subjectPixels, legacy.subjectPixels, entry.maskRelPath);
    assert.deepEqual(optimized.subjectMask, legacy.subjectMask, entry.maskRelPath);
  }
});

test("real pipeline falls back to cutout colors when the original image is unavailable", async () => {
  const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  const entry = Object.values(cache.animals).find((candidate) => candidate.maskRelPath);
  const maskPath = path.join(ROOT_DIR, entry.maskRelPath);
  const maskBuffer = await fs.readFile(maskPath);
  const missingSourcePath = path.join(ROOT_DIR, "animals", "does-not-exist.png");

  const colors = await assignSearchableColors(missingSourcePath, maskPath, maskBuffer);

  assert.ok(colors.length >= 1 && colors.length <= 4);
  assert.ok(colors.every((color) => HEX_COLOR.test(color)));
});

test("real pipeline reports a controlled error for an unreadable cutout", async () => {
  const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  const entry = Object.values(cache.animals).find((candidate) => candidate.sourceRelPath);
  const sourcePath = path.join(ROOT_DIR, "animals", entry.sourceRelPath);

  await assert.rejects(
    assignSearchableColors(sourcePath, "unreadable-cutout.png", Buffer.from("not an image")),
    /Local color extraction found no searchable colors/
  );
});
