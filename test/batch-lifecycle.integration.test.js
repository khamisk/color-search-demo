import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

function asyncPager(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    }
  };
}

class FakeGeminiBatchClient {
  constructor(resultImage) {
    this.resultImage = resultImage;
    this.inputs = new Map();
    this.jobs = [];
    this.createCalls = 0;
    this.cancelledNames = [];
    this.failedGets = new Set();
    this.throwAfterCreateOnce = false;
    this.files = {
      upload: async ({ file }) => {
        const lines = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean);
        const keys = lines.map((line) => JSON.parse(line).key);
        const name = `files/fake-input-${this.inputs.size + 1}`;
        this.inputs.set(name, keys);
        return { name };
      },
      download: async ({ file, downloadPath }) => {
        const job = this.jobs.find((candidate) => candidate.dest?.fileName === file);
        assert.ok(job, `fake output file ${file} should belong to a provider job`);
        const jsonl = job.keys.map((key) => JSON.stringify({
          key,
          response: {
            candidates: [{
              content: {
                parts: [{
                  inlineData: {
                    mimeType: "image/png",
                    data: this.resultImage.toString("base64")
                  }
                }]
              }
            }]
          }
        })).join("\n");
        await fs.writeFile(downloadPath, `${jsonl}\n`, "utf8");
      }
    };
    this.batches = {
      list: async () => asyncPager([...this.jobs]),
      create: async ({ src, config }) => {
        this.createCalls += 1;
        const name = `batches/fake-${this.createCalls}`;
        const job = {
          name,
          displayName: config.displayName,
          state: "JOB_STATE_PENDING",
          src: { fileName: src },
          dest: { fileName: `files/fake-output-${this.createCalls}` },
          keys: [...(this.inputs.get(src) || [])],
          createTime: new Date(Date.now() + this.createCalls).toISOString(),
          updateTime: new Date(Date.now() + this.createCalls).toISOString()
        };
        this.jobs.push(job);
        if (this.throwAfterCreateOnce) {
          this.throwAfterCreateOnce = false;
          throw Object.assign(new Error("create response was lost"), { status: 503 });
        }
        return { ...job };
      },
      get: async ({ name }) => {
        if (this.failedGets.has(name)) {
          throw Object.assign(new Error("temporary provider outage"), { status: 503 });
        }
        const job = this.jobs.find((candidate) => candidate.name === name);
        assert.ok(job, `fake provider job ${name} should exist`);
        return { ...job };
      },
      cancel: async ({ name }) => {
        const job = this.jobs.find((candidate) => candidate.name === name);
        assert.ok(job, `fake provider job ${name} should exist`);
        job.state = "JOB_STATE_CANCELLED";
        job.updateTime = new Date().toISOString();
        this.cancelledNames.push(name);
      }
    };
  }

  succeed(name) {
    const job = this.jobs.find((candidate) => candidate.name === name);
    assert.ok(job, `fake provider job ${name} should exist`);
    job.state = "JOB_STATE_SUCCEEDED";
    job.updateTime = new Date().toISOString();
  }
}

async function createAnimal(directory, filename, color) {
  await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { ...color, alpha: 1 }
    }
  }).png().toFile(path.join(directory, filename));
}

test("batch lifecycle recovers submissions, preserves concurrent cache edits, supports multiple jobs, cancellation, and terminal cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shedd-batch-test-"));
  const animalsDir = path.join(root, "animals");
  const dataDir = path.join(root, "data");
  await fs.mkdir(animalsDir, { recursive: true });
  await createAnimal(animalsDir, "alpha.png", { r: 190, g: 35, b: 45 });

  process.env.NODE_ENV = "test";
  process.env.GEMINI_API_KEY = "fake-test-key";
  process.env.SHEDD_ANIMALS_DIR = animalsDir;
  process.env.SHEDD_DATA_DIR = dataDir;
  process.env.GEMINI_BATCH_MAX_RETRIES = "2";
  process.env.GEMINI_BATCH_RETRY_MS = "10";

  const resultImage = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { r: 190, g: 35, b: 45, alpha: 1 }
    }
  }).png().toBuffer();
  const fakeClient = new FakeGeminiBatchClient(resultImage);
  fakeClient.throwAfterCreateOnce = true;
  const serverModule = await import(`../server.js?batch-lifecycle=${Date.now()}`);
  serverModule.setGeminiClientForTesting(fakeClient);

  const httpServer = serverModule.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  async function requestJson(urlPath, options) {
    const response = await fetch(`${baseUrl}${urlPath}`, options);
    const body = await response.json();
    return { response, body };
  }

  const initialAnimals = (await requestJson("/api/animals")).body.animals;
  const alpha = initialAnimals.find((animal) => animal.name === "alpha");
  assert.ok(alpha);

  const alphaSubmission = await requestJson("/api/process-batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [alpha.id], model: "gemini-lite" })
  });
  assert.equal(alphaSubmission.response.status, 202);
  await serverModule.runBatchMonitorOnceForTesting();
  assert.equal(fakeClient.createCalls, 1);

  const jobsFile = path.join(dataDir, "batch-jobs.json");
  const cacheFile = path.join(dataDir, "color-cache.json");
  const alphaJobId = alphaSubmission.body.batch.id;
  const uncertainStore = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  assert.equal(uncertainStore.jobs[alphaJobId].groups[0].providerJobName, null);
  assert.ok(uncertainStore.jobs[alphaJobId].groups[0].providerCreateAttemptedAt);
  assert.ok(uncertainStore.jobs[alphaJobId].nextRetryAt);

  await new Promise((resolve) => setTimeout(resolve, 15));
  await serverModule.runBatchMonitorOnceForTesting();
  assert.equal(fakeClient.createCalls, 1, "an uncertain create must reconcile instead of issuing a second paid job");

  const crashStore = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  const alphaGroup = crashStore.jobs[alphaJobId].groups[0];
  const alphaProviderName = alphaGroup.providerJobName;
  alphaGroup.providerJobName = null;
  alphaGroup.providerState = null;
  crashStore.jobs[alphaJobId].state = "preparing";
  await fs.writeFile(jobsFile, `${JSON.stringify(crashStore, null, 2)}\n`, "utf8");

  await serverModule.runBatchMonitorOnceForTesting();
  assert.equal(fakeClient.createCalls, 1, "restart reconciliation must not create a duplicate paid provider job");
  const recoveredStore = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  assert.equal(recoveredStore.jobs[alphaJobId].groups[0].providerJobName, alphaProviderName);

  fakeClient.succeed(alphaProviderName);
  await Promise.all([
    serverModule.runBatchMonitorOnceForTesting(),
    requestJson(`/api/quality/${encodeURIComponent(alpha.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewState: "reviewed" })
    })
  ]);
  const importedCache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.equal(importedCache.animals[alpha.id].status, "processed");
  assert.equal(importedCache.animals[alpha.id].processingProvider, "gemini-batch");
  assert.equal(importedCache.animals[alpha.id].qualityReview, "reviewed", "batch import must preserve a concurrent review update");
  assert.equal(importedCache.animals[alpha.id].batchStatus, undefined);

  await createAnimal(animalsDir, "beta.png", { r: 30, g: 100, b: 190 });
  await createAnimal(animalsDir, "gamma.png", { r: 35, g: 170, b: 90 });
  const expandedAnimals = (await requestJson("/api/animals")).body.animals;
  const beta = expandedAnimals.find((animal) => animal.name === "beta");
  const gamma = expandedAnimals.find((animal) => animal.name === "gamma");

  const betaSubmission = await requestJson("/api/process-batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [beta.id], model: "gemini-lite" })
  });
  const gammaSubmission = await requestJson("/api/process-batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [gamma.id], model: "gemini-lite" })
  });
  await serverModule.runBatchMonitorOnceForTesting();

  const activeList = await requestJson("/api/process-batches");
  const activeIds = activeList.body.batches.filter((batch) => ["preparing", "submitted", "running", "importing"].includes(batch.state)).map((batch) => batch.id);
  assert.ok(activeIds.includes(betaSubmission.body.batch.id));
  assert.ok(activeIds.includes(gammaSubmission.body.batch.id));

  const duplicateImmediate = await requestJson("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [gamma.id], model: "gemini-lite" })
  });
  assert.equal(duplicateImmediate.response.status, 409, "immediate processing must not duplicate active batch work");

  const safeProcessAll = await requestJson("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemini-lite" })
  });
  assert.equal(safeProcessAll.response.status, 200);
  assert.equal(safeProcessAll.body.processed, 0, "process-all must exclude animals already assigned to batches");

  await serverModule.runBatchMonitorOnceForTesting();
  const beforeCancelStore = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  const betaJob = beforeCancelStore.jobs[betaSubmission.body.batch.id];
  betaJob.groups[0].providerJobName = null;
  betaJob.groups[0].providerState = null;
  betaJob.state = "preparing";
  await fs.writeFile(jobsFile, `${JSON.stringify(beforeCancelStore, null, 2)}\n`, "utf8");
  const createCallsBeforeCancel = fakeClient.createCalls;

  const cancelled = await requestJson(`/api/process-batches/${encodeURIComponent(betaSubmission.body.batch.id)}/cancel`, {
    method: "POST"
  });
  assert.equal(cancelled.body.batch.state, "cancelled");
  assert.equal(fakeClient.cancelledNames.length, 1);
  assert.equal(fakeClient.createCalls, createCallsBeforeCancel, "cancelling an uncertain create must reconcile without resubmitting");

  const failureStore = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  const gammaProviderName = failureStore.jobs[gammaSubmission.body.batch.id].groups[0].providerJobName;
  fakeClient.failedGets.add(gammaProviderName);
  await serverModule.runBatchMonitorOnceForTesting();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await serverModule.runBatchMonitorOnceForTesting();

  const terminalStore = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  const terminalCache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.equal(terminalStore.jobs[gammaSubmission.body.batch.id].state, "failed");
  assert.equal(terminalStore.jobs[gammaSubmission.body.batch.id].groups[0].failedCount, 1);
  assert.equal(terminalCache.animals[gamma.id].batchStatus, "error", "terminal failures must not leave animals stuck as active");
  assert.match(terminalCache.animals[gamma.id].batchError, /temporary provider outage/);
});
