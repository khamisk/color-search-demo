import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRgbaPixelBuffer,
  buildSubjectMask,
  runAutomaticColorExtractions
} from "../color-extraction-helpers.js";

const isLikelyWhiteMattePixel = (r, g, b) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 232 && max - min <= 28;
};

test("automatic extraction starts both sources and reconciles their colors", async () => {
  let cutoutStarted = false;
  let originalStarted = false;
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });

  const extraction = runAutomaticColorExtractions({
    extractCutoutColors: async () => {
      cutoutStarted = true;
      await waiting;
      return ["#112233"];
    },
    extractOriginalColors: async () => {
      originalStarted = true;
      await waiting;
      return ["#445566"];
    },
    reconcileColors: (original, cutout) => [...original, ...cutout]
  });

  await Promise.resolve();
  assert.equal(cutoutStarted, true);
  assert.equal(originalStarted, true);
  release();

  assert.deepEqual(await extraction, {
    colors: ["#445566", "#112233"],
    errors: []
  });
});

test("automatic extraction uses original colors when cutout extraction fails", async () => {
  const failure = new Error("bad cutout");
  const result = await runAutomaticColorExtractions({
    extractCutoutColors: async () => { throw failure; },
    extractOriginalColors: async () => ["#445566"],
    reconcileColors: (original, cutout) => [...original, ...cutout]
  });

  assert.deepEqual(result.colors, ["#445566"]);
  assert.deepEqual(result.errors, [failure]);
});

test("automatic extraction falls back to cutout colors when original extraction fails", async () => {
  const failure = new Error("bad original");
  const result = await runAutomaticColorExtractions({
    extractCutoutColors: async () => ["#112233"],
    extractOriginalColors: async () => { throw failure; },
    reconcileColors: () => assert.fail("reconciliation should not run")
  });

  assert.deepEqual(result.colors, ["#112233"]);
  assert.deepEqual(result.errors, [failure]);
});

test("automatic extraction preserves both failures when neither source can be read", async () => {
  const cutoutFailure = new Error("bad cutout");
  const originalFailure = new Error("bad original");
  const result = await runAutomaticColorExtractions({
    extractCutoutColors: () => { throw cutoutFailure; },
    extractOriginalColors: () => { throw originalFailure; },
    reconcileColors: () => assert.fail("reconciliation should not run")
  });

  assert.deepEqual(result.colors, []);
  assert.deepEqual(result.errors, [cutoutFailure, originalFailure]);
});

test("subject mask uses alpha for transparent cutouts in one image-buffer pass", () => {
  const data = Buffer.from([
    10, 20, 30, 0,
    10, 20, 30, 90,
    255, 255, 255, 100,
    10, 20, 30, 100
  ]);

  const result = buildSubjectMask(data, { width: 4, height: 1, channels: 4 }, isLikelyWhiteMattePixel);

  assert.deepEqual([...result.subjectMask], [0, 0, 1, 1]);
  assert.equal(result.subjectPixels, 2);
});

test("subject mask excludes white matte pixels from opaque cutouts", () => {
  const data = Buffer.from([
    255, 255, 255, 255,
    10, 20, 30, 90,
    240, 240, 240, 255,
    10, 20, 30, 255
  ]);

  const result = buildSubjectMask(data, { width: 4, height: 1, channels: 4 }, isLikelyWhiteMattePixel);

  assert.deepEqual([...result.subjectMask], [0, 1, 0, 1]);
  assert.equal(result.subjectPixels, 2);
});

test("RGBA assertion turns channel regressions into descriptive errors", () => {
  assert.throws(
    () => assertRgbaPixelBuffer(Buffer.alloc(3), { width: 1, height: 1, channels: 3 }, "Test image"),
    /Test image must decode to an RGBA pixel buffer/
  );
});
