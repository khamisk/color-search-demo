const PROVIDER_SUCCESS_STATE = "JOB_STATE_SUCCEEDED";
const PROVIDER_FAILURE_STATES = new Set([
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED"
]);
const PROVIDER_TERMINAL_STATES = new Set([
  PROVIDER_SUCCESS_STATE,
  ...PROVIDER_FAILURE_STATES
]);

const PERMANENT_PROVIDER_CODES = new Set([
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "FAILED_PRECONDITION"
]);

class PermanentBatchError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PermanentBatchError";
    this.retryable = false;
  }
}

function buildGeminiBatchRequest({ key, prompt, imageBase64, aspectRatio }) {
  return {
    key,
    request: {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/png",
              data: imageBase64
            }
          }
        ]
      }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio,
          imageSize: "1K"
        }
      }
    }
  };
}

function parseGeminiBatchResults(jsonl) {
  return String(jsonl || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Gemini batch result line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function imageResultFromBatchEntry(entry) {
  const key = String(entry?.key || entry?.metadata?.key || "").trim();
  if (!key) {
    return { key: null, error: "Gemini batch result did not include its animal key." };
  }

  if (entry?.error) {
    return {
      key,
      error: batchErrorMessage(entry.error)
    };
  }

  const parts = entry?.response?.candidates?.[0]?.content?.parts;
  const imagePart = Array.isArray(parts)
    ? parts.find((part) => part?.inlineData?.data || part?.inline_data?.data)
    : null;
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) {
    return { key, error: "Gemini batch result did not contain an image." };
  }

  try {
    return {
      key,
      buffer: Buffer.from(inlineData.data, "base64"),
      mimeType: inlineData.mimeType || inlineData.mime_type || "application/octet-stream",
      error: null
    };
  } catch (error) {
    return { key, error: `Gemini batch image could not be decoded: ${error.message}` };
  }
}

function batchErrorMessage(error) {
  if (typeof error === "string") {
    return error;
  }

  return String(error?.message || error?.status || "Gemini batch request failed.");
}

function isRetryableBatchError(error) {
  if (error?.retryable === false) {
    return false;
  }

  const providerCode = String(error?.code || error?.status || "").toUpperCase();
  if (PERMANENT_PROVIDER_CODES.has(providerCode)) {
    return false;
  }

  const status = Number(error?.statusCode || error?.response?.status || error?.status);
  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  return true;
}

function providerBatchDisplayName(jobId, groupIndex) {
  return `shedd-cutouts-${String(jobId)}-${Number(groupIndex)}`;
}

function outstandingBatchAnimalIds(job) {
  const ids = [];
  const seen = new Set();
  for (const group of Array.isArray(job?.groups) ? job.groups : []) {
    if (group?.imported || group?.error) {
      continue;
    }

    for (const animalId of Array.isArray(group?.animalIds) ? group.animalIds : []) {
      const normalizedId = String(animalId);
      if (!seen.has(normalizedId)) {
        seen.add(normalizedId);
        ids.push(normalizedId);
      }
    }
  }
  return ids;
}

function providerStateName(value) {
  if (typeof value === "string") {
    return value;
  }

  return String(value?.name || value || "JOB_STATE_UNSPECIFIED");
}

function isProviderTerminalState(value) {
  return PROVIDER_TERMINAL_STATES.has(providerStateName(value));
}

function isProviderFailureState(value) {
  return PROVIDER_FAILURE_STATES.has(providerStateName(value));
}

function summarizeBatchJob(job) {
  const groups = Array.isArray(job?.groups) ? job.groups : [];
  const total = Array.isArray(job?.animalIds) ? job.animalIds.length : 0;
  const imported = groups.reduce((sum, group) => sum + Number(group.importedCount || 0), 0);
  const failed = groups.reduce((sum, group) => sum + Number(group.failedCount || 0), 0);
  const terminalGroups = groups.filter((group) => (
    group.imported || group.error || isProviderTerminalState(group.providerState)
  )).length;

  return {
    id: job.id,
    model: job.model,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    total,
    imported,
    failed,
    groupCount: groups.length,
    completedGroups: terminalGroups,
    nextRetryAt: job.nextRetryAt || null,
    error: job.error || job.lastTransientError || null
  };
}

export {
  PROVIDER_SUCCESS_STATE,
  PermanentBatchError,
  batchErrorMessage,
  buildGeminiBatchRequest,
  imageResultFromBatchEntry,
  isRetryableBatchError,
  isProviderFailureState,
  isProviderTerminalState,
  outstandingBatchAnimalIds,
  parseGeminiBatchResults,
  providerBatchDisplayName,
  providerStateName,
  summarizeBatchJob
};
