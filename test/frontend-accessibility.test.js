import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("search results keep metadata alt text and gate visible ALT controls with one boolean", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(
    source,
    /class="result-image-original"[^>]+alt="\$\{escapeHtml\(resultImageAlt\(match\)\)\}"/,
    "result images should use the metadata-backed alt text helper"
  );
  assert.match(source, /const SHOW_ALT_TEXT_BUTTON = true;/);
  assert.match(source, /if \(!SHOW_ALT_TEXT_BUTTON \|\| !description\)/);
  assert.match(source, /\$\{resultAltControlMarkup\(match\)\}/);
});

test("frontend displays originals and treats subject masks as internal workflow state", async () => {
  const [appSource, serverSource] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8")
  ]);

  assert.match(appSource, /match\.originalUrl/);
  assert.match(appSource, /animal\?\.hasMask/);
  assert.doesNotMatch(appSource, /processedUrl|thumbUrl|maskUrl|preview-image-cutout/);
  assert.match(serverSource, /hasMask: Boolean\(animal\.maskPath\)/);
  assert.doesNotMatch(serverSource, /app\.use\("\/(?:processed|thumbs|masks)"/);
});

test("batch processing is an explicit optional submission mode with multi-job status", async () => {
  const [html, appSource, serverSource] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="processing-mode-select"/);
  assert.match(html, /value="standard" selected/);
  assert.match(html, /value="batch"/);
  assert.match(html, /id="batch-job-list"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(appSource, /requestJson\("\/api\/process-batches"/);
  assert.match(appSource, /activeBatchIds: new Set\(\)/);
  assert.match(appSource, /data-cancel-batch-id/);
  assert.match(appSource, /processDisclosure\.open = true/);
  assert.doesNotMatch(appSource, /activeBatchId: null/);
  assert.match(serverSource, /app\.post\("\/api\/process-batches"/);
  assert.match(serverSource, /processingProvider: "gemini-batch"/);
});
