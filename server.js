import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import { XMLParser } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";
import { GoogleGenAI } from "@google/genai";
import { differenceCiede2000 } from "culori";
import express from "express";
import multer from "multer";
import sharp from "sharp";

import {
  RGBA_CHANNELS,
  assertRgbaPixelBuffer,
  buildSubjectMask,
  runAutomaticColorExtractions
} from "./color-extraction-helpers.js";
import {
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
} from "./batch-processing.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const ANIMALS_DIR = configuredPath("SHEDD_ANIMALS_DIR", path.join(ROOT_DIR, "animals"));
const DATA_DIR = configuredPath("SHEDD_DATA_DIR", path.join(ROOT_DIR, "data"));
const MASKS_DIR = path.join(DATA_DIR, "masks");
const BATCH_TMP_DIR = path.join(DATA_DIR, "tmp", "batches");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CACHE_FILE = path.join(DATA_DIR, "color-cache.json");
const BATCH_JOBS_FILE = path.join(DATA_DIR, "batch-jobs.json");
const FULL_METADATA_CSV_FILE = path.join(ROOT_DIR, "Shedd_Go_AltText_Drafts.csv");
const FULL_METADATA_XLSX_FILE = path.join(ROOT_DIR, "Shedd_Go_AltText_Drafts.xlsx");
const SAMPLE_METADATA_CSV_FILE = path.join(ROOT_DIR, "Shedd_Go_AltText_Demo_Sample.csv");
const SAMPLE_METADATA_XLSX_FILE = path.join(ROOT_DIR, "Shedd_Go_AltText_Demo_Sample.xlsx");
const METADATA_FILE = [
  FULL_METADATA_CSV_FILE,
  FULL_METADATA_XLSX_FILE,
  SAMPLE_METADATA_CSV_FILE,
  SAMPLE_METADATA_XLSX_FILE
].find((filePath) => fsSync.existsSync(filePath)) || SAMPLE_METADATA_XLSX_FILE;
const SCHEMA_FILE = path.join(ROOT_DIR, "color-assignment.schema.json");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const CODEX_COLOR_MODEL = process.env.CODEX_COLOR_MODEL || "gpt-5.3-codex-spark";
const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER || "fast";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "low";
const USE_CODEX_COLOR_ASSIGNMENT = process.env.USE_CODEX_COLOR_ASSIGNMENT === "1";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const CACHE_VERSION = 2;
const DEFAULT_THRESHOLD = 18;
const DEFAULT_PROCESS_MODEL = "gemini-lite";
const PROCESS_MODELS = {
  "gemini-lite": {
    label: "Cheap",
    apiModel: "gemini-3.1-flash-lite-image",
    estimatedOutputCostUsd: 0.0336
  },
  "gemini-flash": {
    label: "Better",
    apiModel: "gemini-3.1-flash-image",
    estimatedOutputCostUsd: 0.067
  }
};
const ALLOWED_PROCESS_MODELS = new Set(Object.keys(PROCESS_MODELS));
const BATCH_JOB_VERSION = 1;
const BATCH_GROUP_SIZE = clampInteger(process.env.GEMINI_BATCH_GROUP_SIZE, 1, 200, 100);
const BATCH_MONITOR_INTERVAL_MS = clampInteger(process.env.GEMINI_BATCH_POLL_MS, 10_000, 300_000, 30_000);
const BATCH_MAX_RETRIES = clampInteger(process.env.GEMINI_BATCH_MAX_RETRIES, 1, 20, 5);
const BATCH_RETRY_BASE_MS = clampInteger(process.env.GEMINI_BATCH_RETRY_MS, 10, 300_000, 5_000);
const BATCH_MAX_INPUT_BYTES = clampInteger(process.env.GEMINI_BATCH_MAX_FILE_MB, 1, 1_900, 1_800) * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const HEX_RE = /^#[0-9A-F]{6}$/;
const colorDistance = differenceCiede2000();
const xlsxXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false
});
let geminiClient = null;
let batchMonitor = null;
const activeBatchTasks = new Map();
let batchStoreQueue = Promise.resolve();
let cacheMutationQueue = Promise.resolve();
let metadataCache = {
  filePath: null,
  mtimeMs: null,
  byFilename: new Map(),
  rowCount: 0
};

const BACKGROUND_REMOVAL_PROMPT = [
  "Remove the background from this animal, coral, fish, reptile, or invertebrate image.",
  "Return one transparent PNG cutout of only the visible organism.",
  "Preserve the full organism exactly: all branches, fins, tentacles, legs, hair, shell, texture, markings, translucency, and natural color.",
  "Do not crop the organism. Leave a small transparent margin around the complete subject.",
  "Do not blur, smooth, relight, recolor, stylize, simplify, add shadows, or reconstruct missing detail.",
  "Remove only non-organism background such as water, rock, sand, substrate, aquarium glass, scenery, labels, shadows, backdrops, or watermark text.",
  "The area outside the organism must be a flat pure #FFFFFF background with no gray reconstruction, shadows, texture, or scenery."
].join(" ");

await ensureRuntimeFiles();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, ANIMALS_DIR),
    filename: (_req, file, callback) => callback(null, uniqueUploadName(file.originalname, file.mimetype))
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 50
  },
  fileFilter: (_req, file, callback) => {
    const ext = extensionForUpload(file.originalname, file.mimetype);
    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(new Error("Only JPG, PNG, WebP, and AVIF images are supported."));
      return;
    }
    callback(null, true);
  }
});

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use("/animals", express.static(ANIMALS_DIR));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use(express.static(PUBLIC_DIR));

app.get("/api/animals", async (_req, res, next) => {
  try {
    res.json({ animals: await getPublicAnimals() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/upload", upload.array("images"), async (req, res, next) => {
  try {
    const animals = await getAnimalRecords();
    const uploadedPaths = new Set((req.files || []).map((file) => normalizeRelPath(path.relative(ANIMALS_DIR, file.path))));
    const uploaded = animals.filter((animal) => uploadedPaths.has(animal.sourceRelPath)).map(toPublicAnimal);

    res.json({
      animals: animals.map(toPublicAnimal),
      uploaded
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/process", async (req, res, next) => {
  try {
    const requestedIds = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    const processModel = normalizeProcessModel(req.body?.model);
    if (!GEMINI_API_KEY) {
      res.status(400).json({ error: "Set GEMINI_API_KEY before processing images with Gemini." });
      return;
    }

    const records = await getAnimalRecords();
    const targets = requestedIds
      ? records.filter((animal) => requestedIds.has(animal.id))
      : records.filter((animal) => animal.status !== "processed" && !isActiveBatchStatus(animal.batchStatus));

    if (requestedIds && targets.length !== requestedIds.size) {
      res.status(404).json({ error: "One or more animal ids were not found." });
      return;
    }

    if (targets.some((animal) => isActiveBatchStatus(animal.batchStatus))) {
      res.status(409).json({ error: "One or more selected animals are already in an active batch." });
      return;
    }

    for (const animal of targets) {
      const entry = await processAnimal(animal, processModel);
      await mutateCache((cache) => {
        replaceProcessedCacheEntry(cache, animal.id, entry);
      });
    }

    res.json({
      animals: (await getAnimalRecords()).map(toPublicAnimal),
      processed: targets.length,
      model: processModel
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/process-batches", async (_req, res, next) => {
  try {
    // Schedule due work, but do not make a status poll wait for uploads or imports.
    await resumeBatchJobs();
    const store = await readBatchJobs();
    const batches = Object.values(store.jobs)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(summarizeBatchJob);
    res.json({
      batches,
      animals: (await getAnimalRecords()).map(toPublicAnimal)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/process-batches", async (req, res, next) => {
  try {
    if (!GEMINI_API_KEY) {
      res.status(400).json({ error: "Set GEMINI_API_KEY before submitting a Gemini batch." });
      return;
    }

    const requestedIds = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    const processModel = normalizeProcessModel(req.body?.model);
    const records = await getAnimalRecords();
    const targets = requestedIds
      ? records.filter((animal) => requestedIds.has(animal.id))
      : records.filter((animal) => animal.status !== "processed" && !isActiveBatchStatus(animal.batchStatus));

    if (requestedIds && targets.length !== requestedIds.size) {
      res.status(404).json({ error: "One or more animal ids were not found." });
      return;
    }

    const alreadyQueued = targets.filter((animal) => isActiveBatchStatus(animal.batchStatus));
    if (alreadyQueued.length > 0) {
      res.status(409).json({ error: "One or more selected animals are already in an active batch." });
      return;
    }

    if (targets.length === 0) {
      res.status(400).json({ error: "There are no images available for batch processing." });
      return;
    }

    const job = createLocalBatchJob(targets, processModel);
    await mutateBatchJobs((store) => {
      store.jobs[job.id] = job;
    });
    await markAnimalsForBatch(targets, job.id);
    queueBatchTask(job.id, () => submitLocalBatchJob(job.id));

    res.status(202).json({
      batch: summarizeBatchJob(job),
      animals: (await getAnimalRecords()).map(toPublicAnimal)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/process-batches/:id", async (req, res, next) => {
  try {
    const jobId = String(req.params.id);
    const initialStore = await readBatchJobs();
    if (!initialStore.jobs[jobId]) {
      res.status(404).json({ error: "Batch job was not found." });
      return;
    }

    const nextRetryAt = Date.parse(initialStore.jobs[jobId].nextRetryAt || "");
    const retryReady = !Number.isFinite(nextRetryAt) || nextRetryAt <= Date.now();
    if (!activeBatchTasks.has(jobId) && retryReady) {
      const initialJob = initialStore.jobs[jobId];
      await queueBatchTask(jobId, () => (
        initialJob.cancelRequested
          ? cancelLocalBatchJob(jobId)
          : hasUnsubmittedBatchGroups(initialJob) ? submitLocalBatchJob(jobId) : refreshLocalBatchJob(jobId)
      ));
    }
    const store = await readBatchJobs();
    res.json({
      batch: summarizeBatchJob(store.jobs[jobId]),
      animals: (await getAnimalRecords()).map(toPublicAnimal)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/process-batches/:id/cancel", async (req, res, next) => {
  try {
    const jobId = String(req.params.id);
    const initialStore = await readBatchJobs();
    const initialJob = initialStore.jobs[jobId];
    if (!initialJob) {
      res.status(404).json({ error: "Batch job was not found." });
      return;
    }
    if (["succeeded", "partial", "failed", "cancelled"].includes(initialJob.state)) {
      res.json({ batch: summarizeBatchJob(initialJob) });
      return;
    }

    await mutateBatchJobs((store) => {
      const job = store.jobs[jobId];
      if (job) {
        job.cancelRequested = true;
        job.updatedAt = new Date().toISOString();
      }
    });
    if (activeBatchTasks.has(jobId)) {
      await activeBatchTasks.get(jobId);
    }
    await queueBatchTask(jobId, () => cancelLocalBatchJob(jobId));
    const store = await readBatchJobs();
    const job = store.jobs[jobId];
    res.json({ batch: summarizeBatchJob(job) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/recolor", async (req, res, next) => {
  try {
    const requestedIds = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    const records = await getAnimalRecords();
    const targets = requestedIds
      ? records.filter((animal) => requestedIds.has(animal.id))
      : records.filter((animal) => animal.status === "processed" && animal.maskPath);

    if (requestedIds && targets.length !== requestedIds.size) {
      res.status(404).json({ error: "One or more animal ids were not found." });
      return;
    }

    for (const animal of targets) {
      await recolorAnimal(animal);
    }

    res.json({
      animals: (await getAnimalRecords()).map(toPublicAnimal),
      recolored: targets.length
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/colors/:id", async (req, res, next) => {
  try {
    const colors = normalizeColorList(req.body?.colors).slice(0, 8);
    if (colors.length === 0) {
      res.status(400).json({ error: "Save at least one searchable color." });
      return;
    }

    const records = await getAnimalRecords();
    const animal = records.find((record) => record.id === String(req.params.id));
    if (!animal) {
      res.status(404).json({ error: "Animal id was not found." });
      return;
    }

    if (!animal.maskPath) {
      res.status(400).json({ error: "Process this animal before editing its colors." });
      return;
    }

    await mutateCache((cache) => {
      const existingEntry = cache.animals[animal.id] || {};
      cache.animals[animal.id] = {
        ...existingEntry,
        sourceRelPath: animal.sourceRelPath,
        sourceHash: animal.sourceHash,
        maskRelPath: animal.maskRelPath || existingEntry.maskRelPath,
        colors,
        colorSource: "manual",
        status: "processed",
        error: null,
        updatedAt: new Date().toISOString()
      };
    });

    res.json({
      animals: (await getAnimalRecords()).map(toPublicAnimal),
      colors
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/quality/:id", async (req, res, next) => {
  try {
    const reviewState = normalizeQualityReview(req.body?.reviewState);
    const records = await getAnimalRecords();
    const animal = records.find((record) => record.id === String(req.params.id));
    if (!animal) {
      res.status(404).json({ error: "Animal id was not found." });
      return;
    }

    await mutateCache((cache) => {
      const existingEntry = cache.animals[animal.id] || {};
      cache.animals[animal.id] = {
        ...existingEntry,
        sourceRelPath: animal.sourceRelPath,
        sourceHash: animal.sourceHash,
        qualityReview: reviewState,
        updatedAt: new Date().toISOString()
      };
      if (!reviewState) {
        delete cache.animals[animal.id].qualityReview;
      }
    });

    res.json({
      animals: (await getAnimalRecords()).map(toPublicAnimal)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/search", async (req, res, next) => {
  try {
    const selectedColor = normalizeHex(req.body?.color);
    if (!selectedColor) {
      res.status(400).json({ error: "Search color must be a #RRGGBB hex value." });
      return;
    }

    const threshold = normalizeThreshold(req.body?.threshold);
    const animals = await getAnimalRecords();
    const matches = animals
      .filter((animal) => animal.status === "processed" && animal.colors.length > 0)
      .map((animal) => closestAnimalMatch(animal, selectedColor))
      .filter((match) => match.distance <= threshold)
      .sort((a, b) => a.distance - b.distance || a.animal.name.localeCompare(b.animal.name))
      .map((match) => ({
        ...toPublicAnimal(match.animal),
        closestColor: match.closestColor,
        distance: match.distance,
        accuracy: matchAccuracy(match.distance)
      }));

    res.json({
      color: selectedColor,
      threshold,
      matches
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = error instanceof multer.MulterError ? 400 : 500;
  res.status(statusCode).json({ error: error.message || "Server error." });
});

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, HOST, () => {
    console.log(`Animal Color Search running at http://${HOST}:${PORT}`);
    startBatchMonitor();
  });
}

async function ensureRuntimeFiles() {
  await fs.mkdir(ANIMALS_DIR, { recursive: true });
  await fs.mkdir(MASKS_DIR, { recursive: true });
  await fs.mkdir(BATCH_TMP_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (!fsSync.existsSync(CACHE_FILE)) {
    await writeCache({ version: CACHE_VERSION, animals: {} });
  }

  if (!fsSync.existsSync(BATCH_JOBS_FILE)) {
    await writeBatchJobs({ version: BATCH_JOB_VERSION, jobs: {} });
  }
}

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: CACHE_VERSION,
      animals: parsed && typeof parsed.animals === "object" && parsed.animals ? parsed.animals : {}
    };
  } catch {
    return { version: CACHE_VERSION, animals: {} };
  }
}

async function writeCache(cache) {
  const payload = JSON.stringify({ version: CACHE_VERSION, animals: cache.animals || {} }, null, 2);
  await writeJsonAtomic(CACHE_FILE, `${payload}\n`);
}

async function readBatchJobs() {
  try {
    const raw = await fs.readFile(BATCH_JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: BATCH_JOB_VERSION,
      jobs: parsed && typeof parsed.jobs === "object" && parsed.jobs ? parsed.jobs : {}
    };
  } catch {
    return { version: BATCH_JOB_VERSION, jobs: {} };
  }
}

async function writeBatchJobs(store) {
  const payload = JSON.stringify({ version: BATCH_JOB_VERSION, jobs: store.jobs || {} }, null, 2);
  await writeJsonAtomic(BATCH_JOBS_FILE, `${payload}\n`);
}

function mutateBatchJobs(mutator) {
  const operation = batchStoreQueue.then(async () => {
    const store = await readBatchJobs();
    const result = await mutator(store);
    await writeBatchJobs(store);
    return result;
  });
  batchStoreQueue = operation.catch(() => {});
  return operation;
}

function mutateCache(mutator) {
  const operation = cacheMutationQueue.then(async () => {
    const cache = await readCache();
    const result = await mutator(cache);
    await writeCache(cache);
    return result;
  });
  cacheMutationQueue = operation.catch(() => {});
  return operation;
}

async function writeJsonAtomic(filePath, payload) {
  const tempFile = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tempFile, payload, "utf8");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(tempFile, filePath);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code) || attempt === 5) {
        await fs.rm(tempFile, { force: true });
        throw error;
      }
      await delay(80 * (attempt + 1));
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getMetadataIndex() {
  try {
    const stats = await fs.stat(METADATA_FILE);
    if (metadataCache.filePath === METADATA_FILE && metadataCache.mtimeMs === stats.mtimeMs) {
      return metadataCache;
    }

    const metadataFile = await fs.readFile(METADATA_FILE);
    const parsedIndex = path.extname(METADATA_FILE).toLowerCase() === ".csv"
      ? parseMetadataCsv(metadataFile.toString("utf8"))
      : parseMetadataXlsx(metadataFile);

    metadataCache = {
      filePath: METADATA_FILE,
      mtimeMs: stats.mtimeMs,
      ...parsedIndex
    };
    return metadataCache;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read Shedd metadata file: ${error.message}`);
    }

    metadataCache = {
      filePath: null,
      mtimeMs: null,
      byFilename: new Map(),
      rowCount: 0
    };
    return metadataCache;
  }
}

function parseMetadataXlsx(workbook) {
  const unzipped = unzipSync(new Uint8Array(workbook));
  const sharedStrings = parseSharedStrings(unzipped["xl/sharedStrings.xml"]);
  const sheet = parseXlsxXml(unzipped["xl/worksheets/sheet1.xml"]);
  const rows = toArray(sheet?.worksheet?.sheetData?.row);
  return buildMetadataIndex(rows.slice(1).map((row) => xlsxRowValues(row, sharedStrings)));
}

function parseMetadataCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    return buildMetadataIndex([]);
  }

  const headers = csvMetadataHeaders(rows[0]);
  if (headers.originalFilename === undefined) {
    throw new Error("CSV metadata must include an Original filename or filename column.");
  }

  const values = rows.slice(1).map((row) => ({
    A: csvValue(row, headers.resourceId),
    B: csvValue(row, headers.attribution),
    C: csvValue(row, headers.scientificName),
    D: csvValue(row, headers.originalFilename),
    E: csvValue(row, headers.altTextDraft),
    F: csvValue(row, headers.reviewed)
  }));
  return buildMetadataIndex(values);
}

function buildMetadataIndex(rows) {
  const byFilename = new Map();
  let rowCount = 0;

  for (const values of rows) {
    const originalFilename = cleanMetadataValue(values.D);
    if (!originalFilename) {
      continue;
    }

    const filename = path.basename(originalFilename);
    rowCount += 1;
    byFilename.set(filename.toLowerCase(), {
      resourceId: cleanMetadataValue(values.A),
      attribution: cleanMetadataValue(values.B),
      scientificName: cleanScientificName(values.C),
      originalFilename: filename,
      altTextDraft: cleanMetadataValue(values.E),
      reviewed: parseReviewedFlag(values.F)
    });
  }

  return { byFilename, rowCount };
}

function parseCsvRows(csvText) {
  const text = String(csvText || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const finishRow = () => {
    row.push(field);
    if (row.some((value) => value !== "")) {
      rows.push(row);
    }
    row = [];
    field = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      finishRow();
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new Error("CSV metadata contains an unterminated quoted field.");
  }
  if (field.length > 0 || row.length > 0) {
    finishRow();
  }

  return rows;
}

function csvMetadataHeaders(headerRow) {
  const aliases = {
    resourceId: ["resourceid", "resourceids", "id"],
    attribution: ["attribution", "credit", "credits"],
    scientificName: ["scientificname", "scientific"],
    originalFilename: ["originalfilename", "filename", "sourcefilename", "sourcefile", "imagefilename"],
    altTextDraft: ["alttextdraft", "alttext", "imagedescription", "description"],
    reviewed: ["reviewed", "reviewstatus", "reviewedstatus"]
  };
  const normalizedHeaders = headerRow.map(normalizeCsvHeader);
  const indices = {};

  for (const [field, names] of Object.entries(aliases)) {
    const index = normalizedHeaders.findIndex((header) => names.includes(header));
    if (index >= 0) {
      indices[field] = index;
    }
  }

  return indices;
}

function normalizeCsvHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function csvValue(row, index) {
  return index === undefined ? "" : row[index] || "";
}

function metadataForSourceFilename(metadataIndex, sourceFilename) {
  const filename = path.basename(String(sourceFilename || ""));
  const candidates = [filename];
  const currentExtension = path.extname(filename);
  const currentStem = currentExtension ? filename.slice(0, -currentExtension.length) : filename;
  const originalStem = currentStem.replace(/-\d{10,}-[0-9a-f]{8}$/i, "");

  if (originalStem !== currentStem) {
    candidates.push(`${originalStem}${currentExtension}`);
    if (ALLOWED_EXTENSIONS.has(path.extname(originalStem).toLowerCase())) {
      candidates.push(originalStem);
    }
  }

  for (const candidate of candidates) {
    const metadata = metadataIndex.byFilename.get(candidate.toLowerCase());
    if (metadata) {
      return metadata;
    }
  }

  return null;
}

function parseSharedStrings(sharedStringsBuffer) {
  const parsed = parseXlsxXml(sharedStringsBuffer);
  return toArray(parsed?.sst?.si).map((item) => sharedStringText(item));
}

function parseXlsxXml(buffer) {
  if (!buffer) {
    return {};
  }

  return xlsxXmlParser.parse(strFromU8(buffer));
}

function sharedStringText(item) {
  if (item === null || item === undefined) {
    return "";
  }

  if (typeof item === "string") {
    return item;
  }

  if (item.t !== undefined) {
    return cellText(item.t);
  }

  return toArray(item.r).map((part) => cellText(part?.t)).join("");
}

function xlsxRowValues(row, sharedStrings) {
  const values = {};
  for (const cell of toArray(row?.c)) {
    const column = String(cell?.r || "").replace(/\d/g, "");
    if (!column) {
      continue;
    }

    const rawValue = cell?.v ?? cell?.is?.t ?? "";
    values[column] = cell?.t === "s"
      ? sharedStrings[Number(rawValue)] || ""
      : cellText(rawValue);
  }

  return values;
}

function cellText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return cellText(value["#text"] ?? value.text ?? "");
  }

  return String(value);
}

function cleanMetadataValue(value) {
  const cleaned = cellText(value).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function cleanScientificName(value) {
  const cleaned = cleanMetadataValue(value);
  if (!cleaned) {
    return null;
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function parseReviewedFlag(value) {
  const normalized = cellText(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "reviewed"].includes(normalized);
}

function toArray(value) {
  if (value === null || value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

async function getPublicAnimals() {
  return (await getAnimalRecords()).map(toPublicAnimal);
}

async function getAnimalRecords() {
  const cache = await readCache();
  const metadataIndex = await getMetadataIndex();
  const files = await listAnimalFiles(ANIMALS_DIR);
  const records = [];

  for (const sourcePath of files) {
    const sourceRelPath = normalizeRelPath(path.relative(ANIMALS_DIR, sourcePath));
    const originalFilename = path.basename(sourceRelPath);
    const metadata = metadataForSourceFilename(metadataIndex, originalFilename);
    const sourceHash = await hashFile(sourcePath);
    const id = animalId(sourceRelPath);
    const cacheEntry = cache.animals[id];
    const cacheCurrent = Boolean(cacheEntry && cacheEntry.sourceRelPath === sourceRelPath && cacheEntry.sourceHash === sourceHash);
    const maskPath = cacheCurrent && cacheEntry.maskRelPath
      ? path.join(ROOT_DIR, cacheEntry.maskRelPath)
      : null;
    const hasMaskFile = Boolean(maskPath && fsSync.existsSync(maskPath));
    const colors = cacheCurrent ? normalizeColorList(cacheEntry.colors) : [];
    const status = cacheCurrent ? cacheEntry.status || "unprocessed" : "unprocessed";

    records.push({
      id,
      name: nameFromRelPath(sourceRelPath),
      displayName: displayNameFromRelPath(metadata?.originalFilename || sourceRelPath),
      metadata,
      sourcePath,
      sourceRelPath,
      sourceHash,
      originalUrl: `/animals/${urlPath(sourceRelPath)}?v=${sourceHash.slice(0, 10)}`,
      maskPath: hasMaskFile ? maskPath : null,
      maskRelPath: hasMaskFile ? normalizeRelPath(path.relative(ROOT_DIR, maskPath)) : null,
      colors,
      status: status === "processed" && colors.length === 0 ? "error" : status,
      error: cacheCurrent ? cacheEntry.error || null : null,
      updatedAt: cacheCurrent ? cacheEntry.updatedAt || null : null,
      backgroundModel: cacheCurrent ? cacheEntry.backgroundModel || null : null,
      processingProvider: cacheCurrent ? cacheEntry.processingProvider || null : null,
      colorSource: cacheCurrent ? cacheEntry.colorSource || null : null,
      estimatedCostUsd: cacheCurrent && Number.isFinite(Number(cacheEntry.estimatedCostUsd))
        ? Number(cacheEntry.estimatedCostUsd)
        : null,
      transparency: cacheCurrent ? cacheEntry.transparency || null : null,
      batchJobId: cacheCurrent ? cacheEntry.batchJobId || null : null,
      batchStatus: cacheCurrent ? cacheEntry.batchStatus || null : null,
      batchError: cacheCurrent ? cacheEntry.batchError || null : null,
      quality: evaluateAnimalQuality({
        colors,
        status: status === "processed" && colors.length === 0 ? "error" : status,
        metadata,
        reviewState: cacheCurrent ? cacheEntry.qualityReview || null : null
      })
    });
  }

  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

async function listAnimalFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listAnimalFiles(fullPath));
      continue;
    }

    if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function createLocalBatchJob(targets, processModel) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const groups = [];
  for (let index = 0; index < targets.length; index += BATCH_GROUP_SIZE) {
    const animals = targets.slice(index, index + BATCH_GROUP_SIZE);
    groups.push(createBatchGroup(id, groups.length, animals.map((animal) => animal.id)));
  }

  return {
    id,
    model: processModel,
    state: "preparing",
    animalIds: targets.map((animal) => animal.id),
    sourceHashes: Object.fromEntries(targets.map((animal) => [animal.id, animal.sourceHash])),
    groups,
    createdAt: now,
    updatedAt: now,
    consecutiveErrors: 0,
    nextRetryAt: null,
    lastTransientError: null,
    error: null
  };
}

function createBatchGroup(jobId, index, animalIds) {
  return {
    index,
    animalIds: animalIds.map(String),
    providerDisplayName: providerBatchDisplayName(jobId, index),
    providerJobName: null,
    providerInputFileName: null,
    providerCreateAttemptedAt: null,
    providerOutputFileName: null,
    providerState: null,
    imported: false,
    importedCount: 0,
    failedCount: 0,
    error: null
  };
}

function isActiveBatchStatus(status) {
  return ["queued", "preparing", "submitted", "running", "importing"].includes(String(status || ""));
}

function hasUnsubmittedBatchGroups(job) {
  return Array.isArray(job?.groups) && job.groups.some((group) => !group.providerJobName && !group.error);
}

async function markAnimalsForBatch(animals, jobId) {
  await mutateCache((cache) => {
    for (const animal of animals) {
      const existing = cache.animals[animal.id] || {};
      cache.animals[animal.id] = {
        ...existing,
        sourceRelPath: animal.sourceRelPath,
        sourceHash: animal.sourceHash,
        batchJobId: jobId,
        batchStatus: "queued",
        batchError: null,
        updatedAt: new Date().toISOString()
      };
    }
  });
}

async function setAnimalBatchState(animalIds, jobId, batchStatus, error = null) {
  const ids = new Set(animalIds.map(String));
  await mutateCache((cache) => {
    for (const [animalId, entry] of Object.entries(cache.animals)) {
      if (!ids.has(animalId) || entry.batchJobId !== jobId) {
        continue;
      }
      entry.batchStatus = batchStatus;
      entry.batchError = error;
      entry.updatedAt = new Date().toISOString();
    }
  });
}

function queueBatchTask(jobId, task) {
  if (activeBatchTasks.has(jobId)) {
    return activeBatchTasks.get(jobId);
  }

  const operation = Promise.resolve()
    .then(task)
    .then(async (result) => {
      await mutateBatchJobs((store) => {
        const job = store.jobs[jobId];
        if (!job) {
          return;
        }
        job.consecutiveErrors = 0;
        job.nextRetryAt = null;
        job.lastTransientError = null;
      });
      return result;
    })
    .catch(async (error) => {
      console.error(`Batch ${jobId} failed: ${error.message}`);
      const failure = await mutateBatchJobs((store) => {
        const job = store.jobs[jobId];
        if (!job || job.state === "cancelled") {
          return null;
        }

        const message = error.message || "Batch processing failed.";
        const attempt = Number(job.consecutiveErrors || 0) + 1;
        const canRetry = isRetryableBatchError(error) && attempt < BATCH_MAX_RETRIES;
        job.consecutiveErrors = attempt;
        job.updatedAt = new Date().toISOString();

        if (canRetry) {
          const retryDelay = Math.min(BATCH_RETRY_BASE_MS * (2 ** (attempt - 1)), 300_000);
          job.nextRetryAt = new Date(Date.now() + retryDelay).toISOString();
          job.lastTransientError = `Temporary batch error; retry ${attempt}/${BATCH_MAX_RETRIES - 1}: ${message}`;
          return { terminal: false, animalIds: [] };
        }

        const animalIds = outstandingBatchAnimalIds(job);
        for (const group of job.groups) {
          if (!group.imported && !group.error) {
            group.error = message;
            group.failedCount = group.animalIds.length;
          }
        }
        job.state = "failed";
        job.nextRetryAt = null;
        job.lastTransientError = null;
        job.error = message;
        return { terminal: true, animalIds, message };
      });

      if (failure?.terminal && failure.animalIds.length > 0) {
        await setAnimalBatchState(failure.animalIds, jobId, "error", failure.message);
      }
    })
    .finally(() => {
      activeBatchTasks.delete(jobId);
    });
  activeBatchTasks.set(jobId, operation);
  return operation;
}

async function submitLocalBatchJob(jobId) {
  const store = await readBatchJobs();
  const job = store.jobs[jobId];
  if (!job || job.state === "cancelled") {
    return;
  }

  const records = await getAnimalRecords();
  const recordsById = new Map(records.map((animal) => [animal.id, animal]));
  const client = getGeminiClient();
  const modelConfig = PROCESS_MODELS[job.model] || PROCESS_MODELS[DEFAULT_PROCESS_MODEL];
  const pendingGroups = job.groups.filter((group) => !group.providerJobName && !group.error);
  const providerJobsByDisplayName = pendingGroups.length > 0
    ? await listProviderBatchesByDisplayName(client)
    : new Map();

  for (let groupIndex = 0; groupIndex < job.groups.length; groupIndex += 1) {
    const group = job.groups[groupIndex];
    if (await isBatchCancellationRequested(job.id)) {
      break;
    }
    if (group.providerJobName || group.error) {
      continue;
    }

    const displayName = group.providerDisplayName || providerBatchDisplayName(job.id, group.index);
    const batchFilePath = path.join(BATCH_TMP_DIR, `${job.id}-${group.index}.jsonl`);
    try {
      const recoveredJob = providerJobsByDisplayName.get(displayName);
      if (recoveredJob) {
        await attachProviderBatchJob(job, group, recoveredJob, group.providerInputFileName);
        await setAnimalBatchState(group.animalIds, job.id, "submitted");
        continue;
      }

      if (group.providerCreateAttemptedAt) {
        const uncertainError = new Error(
          `Gemini has not listed the earlier create attempt for ${displayName} yet; waiting instead of risking a duplicate submission.`
        );
        uncertainError.code = "BATCH_CREATE_UNCERTAIN";
        throw uncertainError;
      }

      let providerInputFileName = group.providerInputFileName;
      if (!providerInputFileName) {
        const splitGroup = await writeBatchGroupJsonl(job, group, recordsById, batchFilePath);
        if (splitGroup) {
          job.groups.push(splitGroup);
        }

        const uploadedFile = await client.files.upload({
          file: batchFilePath,
          config: {
            mimeType: "application/jsonl",
            displayName: `shedd-${job.id}-${group.index}`
          }
        });
        providerInputFileName = uploadedFile.name;
        if (!providerInputFileName) {
          throw new PermanentBatchError("Gemini did not return a name for the uploaded batch input file.");
        }

        await mutateBatchJobs((latestStore) => {
          const latestJob = latestStore.jobs[job.id];
          const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
          if (latestGroup) {
            latestGroup.providerDisplayName = displayName;
            latestGroup.providerInputFileName = providerInputFileName;
            latestJob.updatedAt = new Date().toISOString();
          }
        });
      }

      if (await isBatchCancellationRequested(job.id)) {
        break;
      }

      const createAttemptedAt = new Date().toISOString();
      await mutateBatchJobs((latestStore) => {
        const latestJob = latestStore.jobs[job.id];
        const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
        if (!latestGroup) {
          throw new PermanentBatchError("The local batch group disappeared before provider submission.");
        }
        latestGroup.providerCreateAttemptedAt = createAttemptedAt;
        latestJob.updatedAt = createAttemptedAt;
      });
      group.providerCreateAttemptedAt = createAttemptedAt;

      const providerJob = await client.batches.create({
        model: modelConfig.apiModel,
        src: providerInputFileName,
        config: {
          displayName
        }
      });
      providerJobsByDisplayName.set(displayName, providerJob);
      await attachProviderBatchJob(job, group, providerJob, providerInputFileName);
      await setAnimalBatchState(group.animalIds, job.id, "submitted");
    } catch (error) {
      if (isRetryableBatchError(error)) {
        throw error;
      }

      await mutateBatchJobs((latestStore) => {
        const latestJob = latestStore.jobs[job.id];
        const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
        if (latestGroup) {
          latestGroup.error = error.message || "Gemini batch submission failed.";
          latestGroup.failedCount = latestGroup.animalIds.length;
          latestJob.updatedAt = new Date().toISOString();
        }
      });
      await setAnimalBatchState(group.animalIds, job.id, "error", error.message);
    } finally {
      await fs.rm(batchFilePath, { force: true });
    }
  }

  if (!await isBatchCancellationRequested(job.id)) {
    await finalizeLocalBatchState(job.id);
  }
}

async function isBatchCancellationRequested(jobId) {
  const store = await readBatchJobs();
  return Boolean(store.jobs[jobId]?.cancelRequested);
}

async function listProviderBatchesByDisplayName(client) {
  const jobsByDisplayName = new Map();
  const pager = await client.batches.list({ config: { pageSize: 100 } });
  for await (const providerJob of pager) {
    const displayName = String(providerJob?.displayName || "").trim();
    if (!displayName) {
      continue;
    }

    const existing = jobsByDisplayName.get(displayName);
    if (!existing || String(providerJob.updateTime || providerJob.createTime || "") > String(existing.updateTime || existing.createTime || "")) {
      jobsByDisplayName.set(displayName, providerJob);
    }
  }
  return jobsByDisplayName;
}

async function attachProviderBatchJob(job, group, providerJob, providerInputFileName) {
  if (!providerJob?.name) {
    throw new PermanentBatchError("Gemini returned a batch job without a provider name.");
  }

  await mutateBatchJobs((latestStore) => {
    const latestJob = latestStore.jobs[job.id];
    const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
    if (!latestGroup) {
      return;
    }
    latestGroup.providerDisplayName = group.providerDisplayName || providerBatchDisplayName(job.id, group.index);
    latestGroup.providerInputFileName = providerInputFileName || providerJob.src?.fileName || latestGroup.providerInputFileName;
    latestGroup.providerJobName = providerJob.name;
    latestGroup.providerState = providerStateName(providerJob.state);
    latestJob.state = "submitted";
    latestJob.updatedAt = new Date().toISOString();
  });
}

async function writeBatchGroupJsonl(job, group, recordsById, batchFilePath) {
  const fileHandle = await fs.open(batchFilePath, "w");
  const includedIds = [];
  let writtenBytes = 0;
  let splitGroup = null;

  try {
    for (let index = 0; index < group.animalIds.length; index += 1) {
      const animalId = group.animalIds[index];
      const animal = recordsById.get(animalId);
      if (!animal || animal.sourceHash !== job.sourceHashes[animalId]) {
        throw new PermanentBatchError(`Source image ${animalId} changed or is no longer available.`);
      }

      const normalizedImage = await normalizeImageForGemini(animal.sourcePath);
      const metadata = await sharp(normalizedImage).metadata();
      const line = `${JSON.stringify(buildGeminiBatchRequest({
        key: animal.id,
        prompt: BACKGROUND_REMOVAL_PROMPT,
        imageBase64: normalizedImage.toString("base64"),
        aspectRatio: closestAspectRatio(metadata.width || 1, metadata.height || 1)
      }))}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > BATCH_MAX_INPUT_BYTES) {
        throw new PermanentBatchError(`Image ${animal.id} is too large for one Gemini batch input file.`);
      }

      if (writtenBytes + lineBytes > BATCH_MAX_INPUT_BYTES && includedIds.length > 0) {
        const remainingIds = group.animalIds.slice(index);
        splitGroup = await splitLocalBatchGroup(job, group, includedIds, remainingIds);
        group.animalIds = [...includedIds];
        break;
      }

      await fileHandle.write(line, null, "utf8");
      includedIds.push(animal.id);
      writtenBytes += lineBytes;
    }
  } finally {
    await fileHandle.close();
  }

  return splitGroup;
}

async function splitLocalBatchGroup(job, group, includedIds, remainingIds) {
  const nextIndex = Math.max(-1, ...job.groups.map((candidate) => Number(candidate.index))) + 1;
  const splitGroup = createBatchGroup(job.id, nextIndex, remainingIds);
  await mutateBatchJobs((store) => {
    const latestJob = store.jobs[job.id];
    const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
    if (!latestJob || !latestGroup) {
      throw new PermanentBatchError("The local batch group disappeared while its input file was being prepared.");
    }
    latestGroup.animalIds = [...includedIds];
    latestJob.groups.push(splitGroup);
    latestJob.updatedAt = new Date().toISOString();
  });
  return splitGroup;
}

async function refreshLocalBatchJob(jobId) {
  const store = await readBatchJobs();
  const job = store.jobs[jobId];
  if (!job || ["succeeded", "partial", "failed", "cancelled"].includes(job.state)) {
    return;
  }

  if (hasUnsubmittedBatchGroups(job)) {
    await submitLocalBatchJob(jobId);
    return;
  }

  const client = getGeminiClient();
  for (const group of job.groups) {
    if (!group.providerJobName || group.imported || group.error) {
      continue;
    }

    const providerJob = await client.batches.get({ name: group.providerJobName });
    const providerState = providerStateName(providerJob.state);
    await mutateBatchJobs((latestStore) => {
      const latestJob = latestStore.jobs[job.id];
      const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
      if (latestGroup) {
        latestGroup.providerState = providerState;
        latestGroup.providerOutputFileName = providerJob.dest?.fileName || latestGroup.providerOutputFileName;
        latestJob.state = providerState === PROVIDER_SUCCESS_STATE ? "importing" : "running";
        latestJob.updatedAt = new Date().toISOString();
      }
    });

    if (providerState === PROVIDER_SUCCESS_STATE) {
      await setAnimalBatchState(group.animalIds, job.id, "importing");
      await importBatchGroup(job.id, group.index, providerJob);
    } else if (isProviderFailureState(providerState)) {
      const message = batchErrorMessage(providerJob.error || `Gemini batch ended with ${providerState}.`);
      await mutateBatchJobs((latestStore) => {
        const latestJob = latestStore.jobs[job.id];
        const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
        if (latestGroup) {
          latestGroup.error = message;
          latestGroup.failedCount = latestGroup.animalIds.length;
          latestJob.updatedAt = new Date().toISOString();
        }
      });
      await setAnimalBatchState(group.animalIds, job.id, "error", message);
    } else {
      const animalState = providerState === "JOB_STATE_PENDING" ? "submitted" : "running";
      await setAnimalBatchState(group.animalIds, job.id, animalState);
    }
  }

  await finalizeLocalBatchState(job.id);
}

async function importBatchGroup(jobId, groupIndex, providerJob) {
  const store = await readBatchJobs();
  const job = store.jobs[jobId];
  const group = job?.groups?.find((candidate) => candidate.index === groupIndex);
  if (!job || !group || group.imported) {
    return;
  }

  const outputFileName = providerJob.dest?.fileName || group.providerOutputFileName;
  if (!outputFileName) {
    throw new Error("Completed Gemini batch did not provide a result file.");
  }

  const resultPath = path.join(BATCH_TMP_DIR, `${job.id}-${group.index}-results.jsonl`);
  const client = getGeminiClient();
  await client.files.download({ file: outputFileName, downloadPath: resultPath });

  let importedCount = 0;
  let failedCount = 0;
  try {
    const entries = parseGeminiBatchResults(await fs.readFile(resultPath, "utf8"));
    const resultKeys = new Set();
    const records = await getAnimalRecords();
    const recordsById = new Map(records.map((animal) => [animal.id, animal]));

    for (const entry of entries) {
      const result = imageResultFromBatchEntry(entry);
      if (!result.key || !group.animalIds.includes(result.key)) {
        failedCount += 1;
        continue;
      }
      resultKeys.add(result.key);

      const animal = recordsById.get(result.key);
      if (!animal || animal.sourceHash !== job.sourceHashes[result.key]) {
        failedCount += 1;
        await setAnimalBatchState([result.key], job.id, "error", "The source image changed before its batch result was imported.");
        continue;
      }

      if (result.error) {
        failedCount += 1;
        await setAnimalBatchState([result.key], job.id, "error", result.error);
        continue;
      }

      try {
        const cacheEntry = await createBatchProcessedEntry(animal, job.model, result.buffer);
        await mutateCache((cache) => {
          replaceProcessedCacheEntry(cache, animal.id, cacheEntry);
        });
        importedCount += 1;
      } catch (error) {
        failedCount += 1;
        await setAnimalBatchState([result.key], job.id, "error", error.message);
      }
    }

    for (const missingId of group.animalIds.filter((animalId) => !resultKeys.has(animalId))) {
      failedCount += 1;
      await setAnimalBatchState([missingId], job.id, "error", "Gemini batch did not return a result for this image.");
    }
  } finally {
    await fs.rm(resultPath, { force: true });
  }

  await mutateBatchJobs((latestStore) => {
    const latestJob = latestStore.jobs[job.id];
    const latestGroup = latestJob?.groups?.find((candidate) => candidate.index === group.index);
    if (latestGroup) {
      latestGroup.providerOutputFileName = outputFileName;
      latestGroup.imported = true;
      latestGroup.importedCount = importedCount;
      latestGroup.failedCount = failedCount;
      latestJob.updatedAt = new Date().toISOString();
    }
  });
}

async function createBatchProcessedEntry(animal, processModel, generatedImage) {
  const modelConfig = PROCESS_MODELS[processModel] || PROCESS_MODELS[DEFAULT_PROCESS_MODEL];
  const normalizedImage = await normalizeImageForGemini(animal.sourcePath);
  const cutout = await prepareCutoutForStorage(generatedImage, normalizedImage);
  const maskPath = path.join(MASKS_DIR, maskFilename(animal.sourceRelPath));
  const maskRelPath = normalizeRelPath(path.relative(ROOT_DIR, maskPath));
  await fs.writeFile(maskPath, cutout.buffer);
  const colors = await assignSearchableColors(animal.sourcePath, maskPath, cutout.buffer);

  return {
    sourceRelPath: animal.sourceRelPath,
    sourceHash: animal.sourceHash,
    maskRelPath,
    backgroundModel: processModel,
    backgroundModelName: modelConfig.apiModel,
    processingProvider: "gemini-batch",
    estimatedCostUsd: modelConfig.estimatedOutputCostUsd / 2,
    transparency: cutout.transparency,
    colors,
    colorSource: "auto",
    status: "processed",
    error: null,
    updatedAt: new Date().toISOString()
  };
}

async function finalizeLocalBatchState(jobId) {
  await mutateBatchJobs((store) => {
    const job = store.jobs[jobId];
    if (!job || job.state === "cancelled") {
      return;
    }

    const finished = job.groups.every((group) => group.imported || group.error);
    const anySubmitted = job.groups.some((group) => group.providerJobName);
    const anyImporting = job.groups.some((group) => group.providerState === PROVIDER_SUCCESS_STATE && !group.imported && !group.error);
    const anyRunning = job.groups.some((group) => !group.imported && !group.error && ![null, "JOB_STATE_PENDING"].includes(group.providerState));
    const imported = job.groups.reduce((sum, group) => sum + Number(group.importedCount || 0), 0);
    const failed = job.groups.reduce((sum, group) => sum + Number(group.failedCount || 0), 0);
    if (finished) {
      job.state = failed === 0 ? "succeeded" : imported > 0 ? "partial" : "failed";
      job.error = failed > 0 ? `${failed} image${failed === 1 ? "" : "s"} failed during batch processing.` : null;
    } else if (anyImporting) {
      job.state = "importing";
    } else if (anyRunning) {
      job.state = "running";
    } else if (anySubmitted) {
      job.state = "submitted";
    } else {
      job.state = "failed";
      job.error = job.error || "No Gemini batch groups were submitted.";
    }
    job.updatedAt = new Date().toISOString();
  });
}

async function cancelLocalBatchJob(jobId) {
  const store = await readBatchJobs();
  let job = store.jobs[jobId];
  if (!job || ["succeeded", "partial", "failed", "cancelled"].includes(job.state)) {
    return;
  }

  const client = getGeminiClient();
  const uncertainGroups = job.groups.filter((group) => (
    !group.providerJobName && group.providerCreateAttemptedAt && !group.error
  ));
  if (uncertainGroups.length > 0) {
    const providerJobsByDisplayName = await listProviderBatchesByDisplayName(client);
    for (const group of uncertainGroups) {
      const displayName = group.providerDisplayName || providerBatchDisplayName(job.id, group.index);
      const recoveredJob = providerJobsByDisplayName.get(displayName);
      if (recoveredJob) {
        await attachProviderBatchJob(job, group, recoveredJob, group.providerInputFileName);
      }
    }

    job = (await readBatchJobs()).jobs[jobId];
    if (job.groups.some((group) => !group.providerJobName && group.providerCreateAttemptedAt && !group.error)) {
      const uncertainError = new Error(
        "A Gemini create attempt is still being reconciled; cancellation will retry without submitting more work."
      );
      uncertainError.code = "BATCH_CREATE_UNCERTAIN";
      throw uncertainError;
    }
  }

  const cancellationErrors = [];
  for (const group of job.groups) {
    if (group.providerJobName && !isProviderTerminalState(group.providerState)) {
      try {
        const providerJob = await client.batches.get({ name: group.providerJobName });
        const providerState = providerStateName(providerJob.state);
        await mutateBatchJobs((latestStore) => {
          const latestGroup = latestStore.jobs[jobId]?.groups?.find((candidate) => candidate.index === group.index);
          if (latestGroup) {
            latestGroup.providerState = providerState;
          }
        });
        if (!isProviderTerminalState(providerState)) {
          await client.batches.cancel({ name: group.providerJobName });
        }
      } catch (error) {
        cancellationErrors.push(error);
      }
    }
  }
  if (cancellationErrors.length > 0) {
    throw cancellationErrors[0];
  }

  await mutateBatchJobs((latestStore) => {
    const latestJob = latestStore.jobs[jobId];
    if (latestJob) {
      latestJob.state = "cancelled";
      latestJob.cancelRequested = false;
      latestJob.error = null;
      latestJob.updatedAt = new Date().toISOString();
    }
  });
  await setAnimalBatchState(job.animalIds, job.id, "cancelled", "Batch processing was cancelled.");
}

async function resumeBatchJobs({ waitForTasks = false } = {}) {
  if (!GEMINI_API_KEY) {
    return [];
  }

  const store = await readBatchJobs();
  const tasks = [];
  for (const job of Object.values(store.jobs)) {
    const retryAt = Date.parse(job.nextRetryAt || "");
    if (
      ["preparing", "submitted", "running", "importing"].includes(job.state)
      && (!Number.isFinite(retryAt) || retryAt <= Date.now())
    ) {
      tasks.push(queueBatchTask(job.id, () => (
        job.cancelRequested
          ? cancelLocalBatchJob(job.id)
          : hasUnsubmittedBatchGroups(job) ? submitLocalBatchJob(job.id) : refreshLocalBatchJob(job.id)
      )));
    }
  }
  if (waitForTasks) {
    await Promise.all(tasks);
  }
  return tasks;
}

function replaceProcessedCacheEntry(cache, animalId, entry) {
  cache.animals[animalId] = {
    ...(cache.animals[animalId] || {}),
    ...entry
  };
  delete cache.animals[animalId].batchJobId;
  delete cache.animals[animalId].batchStatus;
  delete cache.animals[animalId].batchError;
}

function startBatchMonitor() {
  if (!GEMINI_API_KEY || batchMonitor) {
    return;
  }

  resumeBatchJobs().catch((error) => console.error(`Could not resume Gemini batches: ${error.message}`));
  batchMonitor = setInterval(() => {
    resumeBatchJobs().catch((error) => console.error(`Could not refresh Gemini batches: ${error.message}`));
  }, BATCH_MONITOR_INTERVAL_MS);
  batchMonitor.unref();
}

async function normalizeImageForGemini(sourcePath) {
  return sharp(sourcePath)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function processAnimal(animal, processModel = DEFAULT_PROCESS_MODEL) {
  const modelConfig = PROCESS_MODELS[processModel] || PROCESS_MODELS[DEFAULT_PROCESS_MODEL];
  const maskFileName = maskFilename(animal.sourceRelPath);
  const maskPath = path.join(MASKS_DIR, maskFileName);
  const maskRelPath = normalizeRelPath(path.relative(ROOT_DIR, maskPath));
  const baseEntry = {
    sourceRelPath: animal.sourceRelPath,
    sourceHash: animal.sourceHash,
    maskRelPath,
    backgroundModel: processModel,
    backgroundModelName: modelConfig.apiModel,
    processingProvider: "gemini",
    estimatedCostUsd: modelConfig.estimatedOutputCostUsd,
    transparency: null,
    colors: [],
    status: "processing",
    updatedAt: new Date().toISOString()
  };

  try {
    const normalizedImage = await normalizeImageForGemini(animal.sourcePath);

    const cutout = await removeBackgroundWithGemini(normalizedImage, processModel);
    await fs.writeFile(maskPath, cutout.buffer);
    const colors = await assignSearchableColors(animal.sourcePath, maskPath, cutout.buffer);
    return {
      ...baseEntry,
      estimatedCostUsd: cutout.estimatedCostUsd,
      transparency: cutout.transparency,
      colors,
      colorSource: "auto",
      status: "processed",
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...baseEntry,
      status: "error",
      error: error.message || "Processing failed.",
      updatedAt: new Date().toISOString()
    };
  }
}

async function recolorAnimal(animal) {
  if (!animal.maskPath || !fsSync.existsSync(animal.maskPath)) {
    throw new Error(`${animal.name} does not have a mask to recolor.`);
  }

  const maskBuffer = await fs.readFile(animal.maskPath);
  const colors = await assignSearchableColors(animal.sourcePath, animal.maskPath, maskBuffer);
  await mutateCache((cache) => {
    const existingEntry = cache.animals[animal.id] || {};
    cache.animals[animal.id] = {
      ...existingEntry,
      sourceRelPath: animal.sourceRelPath,
      sourceHash: animal.sourceHash,
      maskRelPath: animal.maskRelPath || existingEntry.maskRelPath,
      colors,
      colorSource: "auto",
      status: "processed",
      error: null,
      updatedAt: new Date().toISOString()
    };
    delete cache.animals[animal.id].qualityReview;
  });
}

async function removeBackgroundWithGemini(imageBuffer, processModel) {
  const modelConfig = PROCESS_MODELS[processModel] || PROCESS_MODELS[DEFAULT_PROCESS_MODEL];
  const metadata = await sharp(imageBuffer).metadata();
  const client = getGeminiClient();

  const interaction = await client.interactions.create({
    model: modelConfig.apiModel,
    input: [
      { type: "text", text: BACKGROUND_REMOVAL_PROMPT },
      {
        type: "image",
        mime_type: "image/png",
        data: imageBuffer.toString("base64")
      }
    ],
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: closestAspectRatio(metadata.width || 1, metadata.height || 1),
      image_size: "1K"
    }
  });

  const outputImage = interaction.output_image;
  const geminiBuffer = await imageContentToBuffer(outputImage);
  const cutout = await prepareCutoutForStorage(geminiBuffer, imageBuffer);

  return {
    ...cutout,
    estimatedCostUsd: modelConfig.estimatedOutputCostUsd
  };
}

function getGeminiClient() {
  if (!GEMINI_API_KEY) {
    throw new Error("Set GEMINI_API_KEY before processing images with Gemini.");
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }

  return geminiClient;
}

async function imageContentToBuffer(imageContent) {
  if (imageContent?.data) {
    return Buffer.from(imageContent.data, "base64");
  }

  if (imageContent?.uri) {
    const response = await fetch(imageContent.uri);
    if (!response.ok) {
      throw new Error(`Gemini returned an image URI that could not be fetched: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Gemini did not return an editable image result.");
}

async function prepareCutoutForStorage(imageBuffer, sourceImageBuffer = null) {
  const pngBuffer = await sharp(imageBuffer)
    .rotate()
    .ensureAlpha()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const analysis = await analyzeCutoutPixels(pngBuffer);

  if (analysis.transparentRatio > 0.01) {
    return {
      buffer: pngBuffer,
      transparency: "native-transparent"
    };
  }

  if (analysis.whiteEdgeRatio > 0.45) {
    const postProcessed = await removeWhiteEdgeMatte(pngBuffer, sourceImageBuffer);
    if (postProcessed) {
      return {
        buffer: postProcessed,
        transparency: "post-processed-white-edge"
      };
    }

    return {
      buffer: pngBuffer,
      transparency: "white-matte"
    };
  }

  return {
    buffer: pngBuffer,
    transparency: "opaque-output"
  };
}

async function analyzeCutoutPixels(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .resize({ width: 220, height: 220, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertRgbaPixelBuffer(data, info, "Cutout analysis image");
  const pixels = info.width * info.height;
  let transparentPixels = 0;
  let borderPixels = 0;
  let whiteBorderPixels = 0;

  for (let offset = 0, index = 0; offset < data.length; offset += RGBA_CHANNELS, index += 1) {
    const x = index % info.width;
    const y = Math.floor(index / info.width);
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const alpha = data[offset + 3];

    if (alpha < 245) {
      transparentPixels += 1;
    }

    if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) {
      borderPixels += 1;
      if (isStrictWhitePixel(r, g, b)) {
        whiteBorderPixels += 1;
      }
    }
  }

  return {
    transparentRatio: pixels > 0 ? transparentPixels / pixels : 0,
    whiteEdgeRatio: borderPixels > 0 ? whiteBorderPixels / borderPixels : 0
  };
}

async function removeWhiteEdgeMatte(imageBuffer, sourceImageBuffer = null) {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertRgbaPixelBuffer(data, info, "White matte removal image");
  const source = sourceImageBuffer
    ? await sharp(sourceImageBuffer)
      .rotate()
      .resize({ width: info.width, height: info.height, fit: "fill" })
      .flatten({ background: "#FFFFFF" })
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true })
    : null;
  const totalPixels = info.width * info.height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let read = 0;
  let write = 0;
  let alphaPixels = 0;

  const trySeed = (x, y) => {
    const index = y * info.width + x;
    if (visited[index]) {
      return;
    }

    const offset = index * RGBA_CHANNELS;
    if (!isStrictWhitePixel(data[offset], data[offset + 1], data[offset + 2])) {
      return;
    }

    visited[index] = 1;
    queue[write] = index;
    write += 1;
  };

  for (let x = 0; x < info.width; x += 1) {
    trySeed(x, 0);
    trySeed(x, info.height - 1);
  }

  for (let y = 1; y < info.height - 1; y += 1) {
    trySeed(0, y);
    trySeed(info.width - 1, y);
  }

  while (read < write) {
    const index = queue[read];
    read += 1;
    const offset = index * RGBA_CHANNELS;
    data[offset + 3] = 0;
    alphaPixels += 1;

    const x = index % info.width;
    const y = Math.floor(index / info.width);
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < info.width - 1 ? index + 1 : -1,
      y > 0 ? index - info.width : -1,
      y < info.height - 1 ? index + info.width : -1
    ];

    for (const neighbor of neighbors) {
      if (neighbor < 0 || visited[neighbor]) {
        continue;
      }

      const neighborOffset = neighbor * RGBA_CHANNELS;
      if (!isStrictWhitePixel(data[neighborOffset], data[neighborOffset + 1], data[neighborOffset + 2])) {
        continue;
      }

      visited[neighbor] = 1;
      queue[write] = neighbor;
      write += 1;
    }
  }

  if (source) {
    for (let index = 0; index < totalPixels; index += 1) {
      const offset = index * RGBA_CHANNELS;
      if (data[offset + 3] === 0 || !isLikelyWhiteMattePixel(data[offset], data[offset + 1], data[offset + 2])) {
        continue;
      }

      const sourceOffset = index * source.info.channels;
      if (isSourceWhiteDetail(
        source.data[sourceOffset],
        source.data[sourceOffset + 1],
        source.data[sourceOffset + 2]
      )) {
        continue;
      }

      data[offset + 3] = 0;
      alphaPixels += 1;
    }
  }

  const alphaRatio = totalPixels > 0 ? alphaPixels / totalPixels : 0;
  if (alphaRatio < 0.02 || alphaRatio > 0.965) {
    return null;
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels
    }
  }).png().toBuffer();
}

function isSourceWhiteDetail(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 180 && max - min <= 70;
}

async function assignSearchableColors(sourceImagePath, maskImagePath, maskBuffer) {
  const extraction = await runAutomaticColorExtractions({
    extractCutoutColors: () => extractSearchableColorsFromCutout(maskBuffer),
    extractOriginalColors: () => extractSearchableColors(sourceImagePath, maskBuffer),
    reconcileColors: reconcileAutomaticColorLists
  });
  const localColors = extraction.colors;

  for (const error of extraction.errors) {
    console.warn(`Automatic color extraction source failed: ${error?.message || error}`);
  }

  if (!USE_CODEX_COLOR_ASSIGNMENT) {
    if (localColors.length > 0) {
      return localColors;
    }
    throw new AggregateError(extraction.errors, "Local color extraction found no searchable colors.");
  }

  try {
    const codexColors = await assignColorsWithCodex(maskImagePath);
    const reconciled = reconcileColorLists(codexColors, localColors);
    if (reconciled.length > 0) {
      return reconciled;
    }
  } catch (error) {
    if (localColors.length === 0) {
      throw error;
    }
  }

  if (localColors.length === 0) {
    throw new Error("No searchable colors were found.");
  }

  return localColors;
}

function reconcileAutomaticColorLists(originalColors, cutoutColors) {
  const normalizedOriginal = normalizeColorList(originalColors);
  const normalizedCutout = normalizeColorList(cutoutColors);

  if (normalizedOriginal.length === 0) {
    return normalizedCutout.slice(0, 4);
  }
  if (normalizedCutout.length === 0) {
    return normalizedOriginal.slice(0, 4);
  }

  const groundedOriginal = normalizedOriginal.filter((originalColor) => (
    normalizedCutout.some((cutoutColor) => colorDistance(originalColor, cutoutColor) <= 24)
  ));

  if (groundedOriginal.length < 2 && normalizedCutout.length >= 2) {
    return normalizedCutout.slice(0, 4);
  }
  if (groundedOriginal.length >= 3) {
    return groundedOriginal.slice(0, 4);
  }

  return normalizeColorList([...groundedOriginal, ...normalizedCutout]).slice(0, 4);
}

async function extractSearchableColors(sourceImagePath, maskBuffer) {
  const { data: maskData, info: maskInfo } = await sharp(maskBuffer)
    .ensureAlpha()
    .resize({ width: 420, height: 420, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: sourceData, info: sourceInfo } = await sharp(sourceImagePath)
    .rotate()
    .ensureAlpha()
    .resize(maskInfo.width, maskInfo.height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertRgbaPixelBuffer(maskData, maskInfo, "Color extraction mask");
  assertRgbaPixelBuffer(sourceData, sourceInfo, "Color extraction source image");

  const totalPixels = maskInfo.width * maskInfo.height;
  const { subjectMask, subjectPixels } = buildSubjectMask(
    maskData,
    maskInfo,
    isLikelyWhiteMattePixel
  );

  const refinedMask = refineSubjectMask(subjectMask, maskInfo.width, maskInfo.height);
  const refinedPixels = countMaskPixels(refinedMask);
  const sampleMask = refinedPixels >= Math.max(250, subjectPixels * 0.22) ? refinedMask : subjectMask;
  const buckets = new Map();
  let visiblePixels = 0;

  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    if (!sampleMask[pixel]) {
      continue;
    }

    const offset = pixel * RGBA_CHANNELS;
    const alpha = sourceData[offset + 3];
    if (alpha < 80) {
      continue;
    }

    addColorBucket(buckets, sourceData[offset], sourceData[offset + 1], sourceData[offset + 2]);
    visiblePixels += 1;
  }

  return chooseSearchableColorsFromBuckets(buckets, visiblePixels, { suppressArtifacts: true });
}

async function extractSearchableColorsFromCutout(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .resize({ width: 420, height: 420, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertRgbaPixelBuffer(data, info, "Cutout color extraction image");
  const buckets = new Map();
  const totalPixels = info.width * info.height;
  let transparentPixels = 0;
  let visiblePixels = 0;

  for (let offset = 0; offset < data.length; offset += RGBA_CHANNELS) {
    if (data[offset + 3] < 80) {
      transparentPixels += 1;
    }
  }

  const transparentShare = totalPixels > 0 ? transparentPixels / totalPixels : 0;
  const skipWhiteMatte = transparentShare < 0.01;

  for (let offset = 0; offset < data.length; offset += RGBA_CHANNELS) {
    const alpha = data[offset + 3];
    if (alpha < 80) {
      continue;
    }

    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    if (skipWhiteMatte && isLikelyWhiteMattePixel(r, g, b)) {
      continue;
    }

    addColorBucket(buckets, r, g, b);
    visiblePixels += 1;
  }

  return chooseSearchableColorsFromBuckets(buckets, visiblePixels, { suppressArtifacts: transparentShare >= 0.01 });
}

function addColorBucket(buckets, r, g, b) {
  const key = `${Math.floor(r / 24)}:${Math.floor(g / 24)}:${Math.floor(b / 24)}`;
  const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
  bucket.count += 1;
  bucket.r += r;
  bucket.g += g;
  bucket.b += b;
  buckets.set(key, bucket);
}

function chooseSearchableColorsFromBuckets(buckets, visiblePixels, options = {}) {
  if (visiblePixels === 0) {
    return [];
  }

  const mappedCandidates = Array.from(buckets.values())
    .map((bucket) => {
      const r = bucket.r / bucket.count;
      const g = bucket.g / bucket.count;
      const b = bucket.b / bucket.count;
      const hsv = rgbToHsv(r, g, b);
      const share = bucket.count / visiblePixels;
      const whiteMatte = isLikelyWhiteMattePixel(r, g, b);
      return {
        hex: rgbToHex(r, g, b),
        count: bucket.count,
        share,
        saturation: hsv.s,
        value: hsv.v,
        hue: hsv.h,
        coolFamily: coolFamilyForHue(hsv.h),
        whiteMatte,
        score: bucket.count * (0.64 + hsv.s * 0.36),
        salienceScore: share * hsv.s * Math.sqrt(Math.max(0.05, hsv.v))
      };
    });
  const hasChromaticCandidate = mappedCandidates.some((candidate) => (
    candidate.share >= 0.006 && candidate.saturation >= 0.24 && candidate.value >= 0.20
  ));
  const candidates = mappedCandidates
    .filter((candidate) => {
      if (options.suppressArtifacts && candidate.whiteMatte && hasChromaticCandidate && candidate.share < 0.09) {
        return false;
      }
      if (hasChromaticCandidate && candidate.value < 0.06 && candidate.share < 0.08) {
        return false;
      }
      if (hasChromaticCandidate && candidate.value < 0.18 && candidate.saturation < 0.55 && candidate.share < 0.12) {
        return false;
      }
      if (hasChromaticCandidate && candidate.value < 0.16 && candidate.saturation < 0.25 && candidate.share < 0.07) {
        return false;
      }
      if (candidate.share >= 0.035) {
        return true;
      }
      if (candidate.share >= 0.016 && candidate.saturation >= 0.35) {
        return true;
      }
      if (candidate.share >= 0.0045 && candidate.saturation >= 0.62 && candidate.value >= 0.30) {
        return true;
      }
      if (candidate.share >= 0.008 && candidate.saturation >= 0.16 && candidate.value >= 0.45) {
        return true;
      }
      return candidate.share >= 0.011 && candidate.saturation >= 0.28 && candidate.score >= visiblePixels * 0.0075;
    })
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const selectedCandidates = [];
  const coolFamilyCandidates = findCoolFamilyRescueCandidates(mappedCandidates, visiblePixels);
  const addCandidate = (candidate, minDistance = 10) => {
    if (selected.some((color) => colorDistance(color, candidate.hex) < minDistance)) {
      return false;
    }
    const darkCount = selectedCandidates.filter((item) => item.value < 0.20).length;
    if (darkCount >= 1 && candidate.value < 0.20) {
      return false;
    }
    const neutralCount = selectedCandidates.filter((item) => item.saturation < 0.16).length;
    if (hasChromaticCandidate && neutralCount >= 1 && candidate.saturation < 0.16) {
      return false;
    }
    const whiteCount = selectedCandidates.filter((item) => item.whiteMatte).length;
    if (whiteCount >= 1 && candidate.whiteMatte) {
      return false;
    }

    selected.push(candidate.hex);
    selectedCandidates.push(candidate);
    return true;
  };

  const initialSelectionLimit = Math.max(1, 4 - Math.min(coolFamilyCandidates.length, 3));
  for (const candidate of candidates) {
    addCandidate(candidate);
    if (selected.length === initialSelectionLimit) {
      break;
    }
  }

  for (const familyCandidate of coolFamilyCandidates) {
    if (selected.length >= 4) {
      break;
    }
    if (selectedCandidates.some((candidate) => candidate.coolFamily === familyCandidate.family)) {
      continue;
    }
    addCandidate(familyCandidate.bestCandidate, 8);
  }

  const diverseCandidates = candidates
    .filter((candidate) => (
      candidate.share >= 0.006
      && candidate.saturation >= 0.18
      && candidate.value >= 0.25
      && selectedCandidates.every((selectedCandidate) => (
        selectedCandidate.saturation < 0.18 || hueDistance(selectedCandidate.hue, candidate.hue) >= 38
      ))
    ))
    .sort((a, b) => b.salienceScore - a.salienceScore);

  for (const candidate of diverseCandidates) {
    if (selected.length >= 4) {
      break;
    }
    addCandidate(candidate, 8);
  }

  const salientCandidates = candidates
    .filter((candidate) => candidate.saturation >= 0.65 && candidate.value >= 0.32 && candidate.share >= 0.0045)
    .sort((a, b) => b.salienceScore - a.salienceScore);

  for (const candidate of salientCandidates) {
    if (selected.length >= 4) {
      break;
    }
    addCandidate(candidate, 8);
  }

  for (const candidate of candidates) {
    if (selected.length >= 4) {
      break;
    }
    addCandidate(candidate);
  }

  if (selected.length === 0 && candidates[0]) {
    selected.push(candidates[0].hex);
  }

  return selected;
}

function coolFamilyForHue(hue) {
  if (hue >= 165 && hue < 195) {
    return "teal";
  }
  if (hue >= 195 && hue < 255) {
    return "blue";
  }
  if (hue >= 255 && hue < 300) {
    return "purple";
  }
  return null;
}

function findCoolFamilyRescueCandidates(mappedCandidates, visiblePixels) {
  const families = new Map();

  for (const candidate of mappedCandidates) {
    if (
      !candidate.coolFamily
      || candidate.whiteMatte
      || candidate.saturation < 0.35
      || candidate.value < 0.20
    ) {
      continue;
    }

    const familyCandidate = families.get(candidate.coolFamily) || {
      family: candidate.coolFamily,
      count: 0,
      bestCandidate: null
    };

    familyCandidate.count += candidate.count;
    if (!familyCandidate.bestCandidate || candidate.salienceScore > familyCandidate.bestCandidate.salienceScore) {
      familyCandidate.bestCandidate = candidate;
    }
    families.set(candidate.coolFamily, familyCandidate);
  }

  return Array.from(families.values())
    .map((familyCandidate) => ({
      ...familyCandidate,
      share: familyCandidate.count / visiblePixels
    }))
    .filter((familyCandidate) => (
      familyCandidate.share >= 0.08
      && familyCandidate.bestCandidate
      && familyCandidate.bestCandidate.share >= 0.001
    ))
    .sort((a, b) => b.share - a.share);
}

function refineSubjectMask(subjectMask, width, height) {
  const refined = new Uint8Array(subjectMask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!subjectMask[index]) {
        continue;
      }

      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            continue;
          }
          if (subjectMask[ny * width + nx]) {
            neighbors += 1;
          }
        }
      }

      if (neighbors >= 5) {
        refined[index] = 1;
      }
    }
  }
  return refined;
}

function countMaskPixels(mask) {
  let count = 0;
  for (const value of mask) {
    count += value ? 1 : 0;
  }
  return count;
}

function hueDistance(hueA, hueB) {
  const delta = Math.abs(hueA - hueB) % 360;
  return Math.min(delta, 360 - delta);
}

function reconcileColorLists(codexColors, localColors) {
  const normalizedCodex = normalizeColorList(codexColors);
  const normalizedLocal = normalizeColorList(localColors);

  if (normalizedLocal.length === 0) {
    return normalizedCodex.slice(0, 4);
  }

  const groundedCodex = normalizedCodex.filter((codexColor) => (
    normalizedLocal.some((localColor) => colorDistance(codexColor, localColor) <= 22)
  ));

  return normalizeColorList([...groundedCodex, ...normalizedLocal]).slice(0, 4);
}

async function assignColorsWithCodex(imagePath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "animal-color-search-"));
  const outputFile = path.join(tempDir, "colors.json");
  const prompt = [
    "Analyze the attached background-removed animal image.",
    "Return only JSON matching the provided schema.",
    "Assign only colors a normal user would reasonably search for when looking for this animal.",
    "Exclude the transparent/background area, shadows, highlights, lighting artifacts, eyes, claws, teeth, tiny markings, and other accent colors unless they are genuinely dominant and meaningful for search.",
    "Use 1 to 4 uppercase #RRGGBB hex values. Prefer fewer colors when one or two describe the animal well."
  ].join(" ");

  try {
    const result = await runCommand("codex", [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-m",
      CODEX_COLOR_MODEL,
      "-c",
      `service_tier="${CODEX_SERVICE_TIER}"`,
      "-c",
      `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      "--image",
      imagePath,
      "--output-schema",
      SCHEMA_FILE,
      "-o",
      outputFile,
      "-"
    ], {
      cwd: ROOT_DIR,
      stdin: `${prompt}\n`,
      timeoutMs: 300000
    });

    const raw = fsSync.existsSync(outputFile)
      ? await fs.readFile(outputFile, "utf8")
      : result.stdout;
    return parseColorResponse(raw);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const spawnCommand = process.platform === "win32" && command === "codex" ? "cmd.exe" : command;
    const spawnArgs = process.platform === "win32" && command === "codex" ? ["/d", "/c", "codex.cmd", ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Codex color assignment timed out."));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Codex color assignment failed: ${trimOutput(stderr || stdout)}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function parseColorResponse(raw) {
  const text = String(raw || "").trim();
  const jsonText = text.startsWith("{") ? text : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonText);
  const colors = normalizeColorList(parsed.colors);

  if (colors.length === 0) {
    throw new Error("Codex returned no valid searchable colors.");
  }

  return colors.slice(0, 4);
}

function closestAnimalMatch(animal, selectedColor) {
  let closestColor = animal.colors[0];
  let distance = Number.POSITIVE_INFINITY;

  for (const color of animal.colors) {
    const currentDistance = colorDistance(selectedColor, color);
    if (currentDistance < distance) {
      closestColor = color;
      distance = currentDistance;
    }
  }

  return { animal, closestColor, distance };
}

function componentToHex(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();
}

function rgbToHex(r, g, b) {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function rgbToHsv(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === red) {
      h = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      h = 60 * ((blue - red) / delta + 2);
    } else {
      h = 60 * ((red - green) / delta + 4);
    }
  }

  return {
    h: (h + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max
  };
}

function isStrictWhitePixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 244 && max - min <= 18;
}

function isLikelyWhiteMattePixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 232 && max - min <= 28;
}

function closestAspectRatio(width, height) {
  const target = width / height;
  const ratios = [
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["5:4", 5 / 4],
    ["4:5", 4 / 5]
  ];

  return ratios
    .map(([label, ratio]) => ({ label, delta: Math.abs(ratio - target) }))
    .sort((a, b) => a.delta - b.delta)[0].label;
}

function matchAccuracy(distance) {
  if (!Number.isFinite(distance)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(100 - distance)));
}

function toPublicAnimal(animal) {
  const publicAnimal = {
    id: animal.id,
    name: animal.name,
    displayName: animal.displayName,
    metadata: animal.metadata,
    quality: animal.quality,
    originalUrl: animal.originalUrl,
    hasMask: Boolean(animal.maskPath),
    colors: animal.colors,
    status: animal.status,
    backgroundModel: animal.backgroundModel,
    processingProvider: animal.processingProvider,
    colorSource: animal.colorSource,
    estimatedCostUsd: animal.estimatedCostUsd,
    transparency: animal.transparency,
    batchJobId: animal.batchJobId,
    batchStatus: animal.batchStatus
  };

  if (animal.error) {
    publicAnimal.error = animal.error;
  }

  if (animal.batchError) {
    publicAnimal.batchError = animal.batchError;
  }

  return publicAnimal;
}

function normalizeColorList(colors) {
  if (!Array.isArray(colors)) {
    return [];
  }

  const normalized = [];
  for (const color of colors) {
    const hex = normalizeHex(color);
    if (hex && !normalized.includes(hex)) {
      normalized.push(hex);
    }
  }

  return normalized;
}

function normalizeHex(value) {
  const color = String(value || "").trim().toUpperCase();
  return HEX_RE.test(color) ? color : null;
}

function normalizeThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_THRESHOLD;
  }
  return Math.max(0, Math.min(100, number));
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function normalizeProcessModel(value) {
  const model = String(value || "").trim().toLowerCase();
  return ALLOWED_PROCESS_MODELS.has(model) ? model : DEFAULT_PROCESS_MODEL;
}

function normalizeQualityReview(value) {
  const reviewState = String(value || "").trim().toLowerCase();
  return reviewState === "reviewed" ? "reviewed" : null;
}

function animalId(sourceRelPath) {
  return crypto.createHash("sha1").update(sourceRelPath).digest("hex").slice(0, 16);
}

function maskFilename(sourceRelPath) {
  return `${nameFromRelPath(sourceRelPath)}-mask.png`;
}

function nameFromRelPath(sourceRelPath) {
  const parsed = path.parse(sourceRelPath);
  return parsed.name || sourceRelPath;
}

function displayNameFromRelPath(sourceRelPath) {
  const stem = nameFromRelPath(sourceRelPath)
    .replace(/GettyImages[-_\d]*/gi, "")
    .replace(/[-_]+$/g, "");
  const parts = stem.split("_").filter(Boolean);
  const label = parts.length > 1 ? parts.slice(1).join(" ") : parts.join(" ");
  return titleCase(segmentKnownWords(label || stem));
}

function segmentKnownWords(value) {
  const words = [
    "surgeonfish", "staghorn", "brazilian", "philippine", "blueberry", "mountain", "western",
    "honeycomb", "sergeant", "powder", "orange", "shoulder", "mustard", "doctor", "convict",
    "achilles", "doughnut", "pacific", "yellow", "rimmed", "slimer", "false", "coral",
    "gorgonian", "tarantula", "horned", "dragon", "lizard", "turtle", "cowfish", "surgeon", "tang",
    "flamboyant", "triggerfish", "cuttlefish", "clownfish", "clown", "major", "starry", "white",
    "knee", "brown", "blue", "gold", "pond", "fish", "cup"
  ].sort((a, b) => b.length - a.length);

  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => segmentToken(token, words));
}

function segmentToken(token, words) {
  const lower = token.toLowerCase();
  if (!/^[a-z]+$/i.test(token) || lower.length <= 5) {
    return [token];
  }

  const segmented = [];
  let index = 0;
  while (index < lower.length) {
    const match = words.find((word) => lower.startsWith(word, index));
    if (!match) {
      return [token];
    }
    segmented.push(match);
    index += match.length;
  }
  return segmented;
}

function titleCase(words) {
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function evaluateAnimalQuality({ colors, status, metadata, reviewState = null }) {
  const expectedColors = extractExpectedColorFamilies(metadata?.altTextDraft);
  if (status !== "processed" || expectedColors.length === 0) {
    return {
      status: "unscored",
      reasons: [],
      expectedColors
    };
  }

  const storedFamilies = new Set(colors.flatMap((color) => colorFamiliesForHex(color)));
  const reasons = [];
  for (const expectedColor of expectedColors) {
    if (!storedFamilies.has(expectedColor)) {
      reasons.push(`expected ${expectedColor} from alt text`);
    }
  }

  const hasWhite = storedFamilies.has("white");
  const whiteWasExpected = expectedColors.some((color) => ["white", "gray"].includes(color));
  if (hasWhite && !whiteWasExpected) {
    reasons.push("possible matte white");
  }

  if (colors.length >= 3 && paletteLooksLowDiversity(colors)) {
    reasons.push("low color diversity");
  }

  if (reviewState === "reviewed" && reasons.length > 0) {
    return {
      status: "reviewed",
      reasons,
      expectedColors,
      reviewState
    };
  }

  return {
    status: reasons.length > 0 ? "check" : "confident",
    reasons,
    expectedColors,
    reviewState
  };
}

function extractExpectedColorFamilies(altText) {
  const text = String(altText || "").toLowerCase();
  if (!text) {
    return [];
  }

  const definitions = [
    ["black", /\bblack\b/g],
    ["white", /\bwhite\b/g],
    ["gray", /\bgr[ae]y\b|\bsilver(?:y)?\b/g],
    ["brown", /\bbrown\b|\btan\b|\bgold(?:en)?\b|\byellow-brown\b|\bkhaki\b/g],
    ["yellow", /\byellow\b|\bgold(?:en)?\b/g],
    ["orange", /\borange\b/g],
    ["red", /\bred\b/g],
    ["pink", /\bpink\b/g],
    ["purple", /\bpurple\b|\bviolet\b|\blavender\b/g],
    ["blue", /\bblue\b/g],
    ["teal", /\bteal\b|\bturquoise\b|\baqua\b|\bcyan\b/g],
    ["green", /\bgreen\b|\bolive\b/g]
  ];

  const families = [];
  for (const [family, pattern] of definitions) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (isRequiredAltTextColor(text, match.index || 0, family) && !families.includes(family)) {
        families.push(family);
      }
    }
  }

  return families;
}

function isRequiredAltTextColor(text, index, family) {
  const before = text.slice(Math.max(0, index - 24), index);
  const after = text.slice(index, Math.min(text.length, index + 44));
  const context = `${before}${after}`;

  if (/\b(vertical|horizontal|bold|evenly spaced)\s+(?:dark\s+)?stripes?\b/.test(after)) {
    return true;
  }

  if (/\b(shape|patch|patches|spots?|bands?|edges?|edging|stripe along|face|mask|tail|fins?|dorsal|anal|pectoral|knees?|mouth|mark|marks)\b/.test(after)) {
    return false;
  }

  if (/\b(body|fish|coral|lizard|turtle|tarantula|branches?|arms?|shell|disk|ridges?|folds?)\b/.test(after)) {
    return true;
  }

  if (/\b(thin|small|tiny|distinct|subtle|pale|light)\b/.test(context) && ["white", "black", "yellow", "gray"].includes(family)) {
    return false;
  }

  return true;
}

function colorFamiliesForHex(color) {
  const hex = normalizeHex(color);
  if (!hex) {
    return [];
  }

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const { h, s, v } = rgbToHsv(r, g, b);
  const families = new Set();

  if (v <= 0.28) {
    families.add("black");
  }
  if (v >= 0.92 && s <= 0.16) {
    families.add("white");
  }
  if (s <= 0.24 && v > 0.12 && v < 0.94) {
    families.add("gray");
  }

  if (s <= 0.12) {
    return Array.from(families);
  }

  if (h < 15 || h >= 345) {
    families.add("red");
  } else if (h < 45) {
    families.add("orange");
  } else if (h < 70) {
    families.add("yellow");
  } else if (h < 165) {
    families.add("green");
  } else if (h < 195) {
    families.add("teal");
  } else if (h < 255) {
    families.add("blue");
  } else if (h < 300) {
    families.add("purple");
  } else {
    families.add("pink");
  }

  if (h >= 15 && h < 58 && s >= 0.14 && v <= 0.62) {
    families.add("brown");
  }

  if (h >= 30 && h < 68 && s >= 0.28 && v > 0.62) {
    families.add("yellow");
  }

  if (h >= 58 && h < 82 && s >= 0.25) {
    families.add("green");
  }

  return Array.from(families);
}

function distanceBetweenHex(colorA, colorB) {
  const distance = colorDistance(colorA, colorB);
  return Number.isFinite(distance) ? distance : 100;
}

function paletteLooksLowDiversity(colors) {
  const uniqueFamilies = new Set(colors.flatMap((color) => colorFamiliesForHex(color)));
  if (uniqueFamilies.size > 1) {
    return false;
  }

  const uniqueColors = normalizeColorList(colors);
  if (uniqueColors.length < 3) {
    return false;
  }

  const maxDistance = uniqueColors.reduce((maxDistance, color, index) => {
    const remaining = uniqueColors.slice(index + 1);
    return Math.max(maxDistance, ...remaining.map((nextColor) => distanceBetweenHex(color, nextColor)));
  }, 0);

  return maxDistance < 9;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function extensionForUpload(originalName, mimeType) {
  const originalExt = path.extname(originalName || "").toLowerCase();
  if (ALLOWED_EXTENSIONS.has(originalExt)) {
    return originalExt;
  }

  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    default:
      return originalExt;
  }
}

function uniqueUploadName(originalName, mimeType) {
  const ext = extensionForUpload(originalName, mimeType);
  const baseName = path.basename(originalName || "animal", path.extname(originalName || ""));
  const safeBase = baseName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "animal";
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return `${safeBase}-${suffix}${ext}`;
}

function configuredPath(environmentVariable, fallbackPath) {
  const configured = String(process.env[environmentVariable] || "").trim();
  return configured ? path.resolve(configured) : fallbackPath;
}

function normalizeRelPath(value) {
  return value.split(path.sep).join("/");
}

function urlPath(value) {
  return normalizeRelPath(value).split("/").map(encodeURIComponent).join("/");
}

function trimOutput(value) {
  const text = String(value || "").trim();
  return text.length > 800 ? `${text.slice(0, 800)}...` : text;
}

function setGeminiClientForTesting(client) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Gemini client injection is only available when NODE_ENV=test.");
  }
  geminiClient = client;
}

async function runBatchMonitorOnceForTesting() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Direct batch monitor execution is only available when NODE_ENV=test.");
  }
  return resumeBatchJobs({ waitForTasks: true });
}

export {
  app,
  assignSearchableColors,
  parseMetadataCsv,
  removeWhiteEdgeMatte,
  runBatchMonitorOnceForTesting,
  setGeminiClientForTesting
};
