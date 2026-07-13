export const RGBA_CHANNELS = 4;

export function assertRgbaPixelBuffer(data, info, context = "Image") {
  const expectedLength = info.width * info.height * RGBA_CHANNELS;
  if (info.channels !== RGBA_CHANNELS || data.length !== expectedLength) {
    throw new Error(`${context} must decode to an RGBA pixel buffer.`);
  }
}

export async function runAutomaticColorExtractions({
  extractCutoutColors,
  extractOriginalColors,
  reconcileColors
}) {
  const [cutoutResult, originalResult] = await Promise.allSettled([
    Promise.resolve().then(extractCutoutColors),
    Promise.resolve().then(extractOriginalColors)
  ]);

  const cutoutColors = cutoutResult.status === "fulfilled" ? cutoutResult.value : [];
  const originalColors = originalResult.status === "fulfilled" ? originalResult.value : [];
  const colors = originalResult.status === "fulfilled"
    ? reconcileColors(originalColors, cutoutColors)
    : cutoutColors;

  return {
    colors,
    errors: [cutoutResult, originalResult]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason)
  };
}

export function buildSubjectMask(maskData, maskInfo, isLikelyWhiteMattePixel) {
  assertRgbaPixelBuffer(maskData, maskInfo, "Color extraction mask");

  const totalPixels = maskInfo.width * maskInfo.height;
  const alphaSubjectMask = new Uint8Array(totalPixels);
  const matteSubjectMask = new Uint8Array(totalPixels);
  let transparentPixels = 0;
  let alphaSubjectPixels = 0;
  let matteSubjectPixels = 0;

  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * RGBA_CHANNELS;
    const alpha = maskData[offset + 3];
    if (alpha < 80) {
      transparentPixels += 1;
      continue;
    }

    if (alpha >= 96) {
      alphaSubjectMask[pixel] = 1;
      alphaSubjectPixels += 1;
    }

    if (!isLikelyWhiteMattePixel(maskData[offset], maskData[offset + 1], maskData[offset + 2])) {
      matteSubjectMask[pixel] = 1;
      matteSubjectPixels += 1;
    }
  }

  const transparentShare = totalPixels > 0 ? transparentPixels / totalPixels : 0;
  const hasAlphaMask = transparentShare >= 0.01;

  return hasAlphaMask
    ? { subjectMask: alphaSubjectMask, subjectPixels: alphaSubjectPixels }
    : { subjectMask: matteSubjectMask, subjectPixels: matteSubjectPixels };
}
