import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeminiBatchRequest,
  imageResultFromBatchEntry,
  parseGeminiBatchResults,
  summarizeBatchJob
} from "../batch-processing.js";

test("batch requests preserve the animal id and request an image at the source aspect ratio", () => {
  const request = buildGeminiBatchRequest({
    key: "animal-123",
    prompt: "Remove the background.",
    imageBase64: "aW1hZ2U=",
    aspectRatio: "4:3"
  });

  assert.equal(request.key, "animal-123");
  assert.equal(request.request.contents[0].parts[0].text, "Remove the background.");
  assert.equal(request.request.contents[0].parts[1].inlineData.data, "aW1hZ2U=");
  assert.deepEqual(request.request.generationConfig.responseModalities, ["IMAGE"]);
  assert.equal(request.request.generationConfig.imageConfig.aspectRatio, "4:3");
  assert.equal(request.request.generationConfig.imageConfig.imageSize, "1K");
});

test("batch result parser keeps keyed image responses and per-image errors", () => {
  const jsonl = [
    JSON.stringify({
      key: "animal-1",
      response: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "cG5n" } }] } }]
      }
    }),
    JSON.stringify({ key: "animal-2", error: { message: "blocked" } })
  ].join("\n");

  const entries = parseGeminiBatchResults(jsonl);
  const image = imageResultFromBatchEntry(entries[0]);
  const failure = imageResultFromBatchEntry(entries[1]);

  assert.equal(entries.length, 2);
  assert.equal(image.key, "animal-1");
  assert.equal(image.buffer.toString("utf8"), "png");
  assert.equal(image.mimeType, "image/png");
  assert.equal(failure.key, "animal-2");
  assert.equal(failure.error, "blocked");
});

test("batch summaries report real imported and failed counts", () => {
  const summary = summarizeBatchJob({
    id: "local-job",
    model: "gemini-lite",
    state: "partial",
    animalIds: ["a", "b", "c"],
    groups: [
      { imported: true, importedCount: 2, failedCount: 0, providerState: "JOB_STATE_SUCCEEDED" },
      { imported: true, importedCount: 0, failedCount: 1, providerState: "JOB_STATE_SUCCEEDED" }
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T01:00:00.000Z"
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.imported, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.completedGroups, 2);
});

test("invalid JSONL reports the failing line", () => {
  assert.throws(
    () => parseGeminiBatchResults('{"key":"ok"}\nnot-json'),
    /line 2 is invalid JSON/
  );
});
