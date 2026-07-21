import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("search results use metadata for image alt text without visible alt controls", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(
    source,
    /class="result-image-original"[^>]+alt="\$\{escapeHtml\(resultImageAlt\(match\)\)\}"/,
    "result images should use the metadata-backed alt text helper"
  );
  assert.doesNotMatch(source, /data-result-alt-toggle|resultAltControlMarkup|result-alt-panel/);
});
