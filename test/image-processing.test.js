import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { removeWhiteEdgeMatte } from "../server.js";

const WIDTH = 80;
const HEIGHT = 80;

test("white matte cleanup removes enclosed background without erasing white animal detail", async () => {
  const generated = Buffer.alloc(WIDTH * HEIGHT * 4, 255);
  const source = Buffer.alloc(WIDTH * HEIGHT * 3, 36);

  paint(generated, 4, 20, 20, 60, 60, [70, 90, 110, 255]);
  paint(generated, 4, 30, 30, 37, 37, [255, 255, 255, 255]);
  paint(generated, 4, 46, 30, 53, 37, [255, 255, 255, 255]);
  paint(source, 3, 46, 30, 53, 37, [232, 234, 236]);

  const generatedPng = await sharp(generated, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 }
  }).png().toBuffer();
  const sourcePng = await sharp(source, {
    raw: { width: WIDTH, height: HEIGHT, channels: 3 }
  }).png().toBuffer();

  const cleaned = await removeWhiteEdgeMatte(generatedPng, sourcePng);
  assert.ok(cleaned);

  const { data, info } = await sharp(cleaned).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(alphaAt(data, info, 0, 0), 0, "outer white matte should be transparent");
  assert.equal(alphaAt(data, info, 33, 33), 0, "enclosed background should be transparent");
  assert.equal(alphaAt(data, info, 49, 33), 255, "real white detail should stay opaque");
  assert.equal(alphaAt(data, info, 25, 25), 255, "colored subject pixels should stay opaque");
});

function paint(buffer, channels, left, top, right, bottom, color) {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * WIDTH + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        buffer[offset + channel] = color[channel];
      }
    }
  }
}

function alphaAt(data, info, x, y) {
  return data[(y * info.width + x) * info.channels + 3];
}
