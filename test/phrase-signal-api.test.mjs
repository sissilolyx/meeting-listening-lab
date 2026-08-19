import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

test("phrase-signal API validates local material context, deduplicates exposure, and records counter-evidence", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-phrase-signals-"));
  const port = await availablePort();
  process.env.LISTENING_DATA_DIR = dataRoot;
  const storage = await import(`../lib/storage.mjs?phrase-signals=${Date.now()}`);
  let server;

  try {
    await storage.ensureStorage();
    const material = await storage.createMaterial({ title: "Synthetic phrase-signal material" });
    material.status = "ready";
    material.sentences = ["one", "two", "three"].map((suffix, index) => ({
      id: `sentence-${suffix}`,
      text: `This is synthetic sentence ${index + 1}.`,
      speaker: "Synthetic Speaker",
      start: index * 3,
      end: index * 3 + 2,
      analysis: {
        spokenFormNotes: [],
        phrases: [
          {
            text: "synthetic alignment pattern",
            meaningZh: "合成对齐表达",
            usageZh: "仅用于 API 测试。",
          },
          {
            text: "synthetic review pattern",
            meaningZh: "合成复习表达",
            usageZh: "仅用于复习反证测试。",
          },
          ...["cached guide pattern", "saved review pattern", "saved question pattern"].map((text) => ({
            text,
            meaningZh: "合成旧记录表达",
            usageZh: "仅用于旧记录反证测试。",
          })),
        ],
      },
    }));
    material.phraseGuides = [{
      id: "phrase-guide-synthetic",
      sentenceId: "sentence-one",
      phraseText: "cached guide pattern",
      sourceSentenceText: material.sentences[0].text,
    }];
    material.reviewItems = [{
      id: "review-synthetic",
      kind: "phrase",
      sentenceId: "sentence-one",
      sourceText: "saved review pattern",
      meaningZh: "合成旧记录表达",
    }];
    material.qaHistory = [{
      id: "qa-synthetic",
      sentenceId: "sentence-one",
      sourceText: "saved question pattern",
      learningTargetText: "saved question pattern",
      question: "合成问题",
      answerZh: "合成答案",
      learningSummaryZh: "合成总结",
      createdAt: new Date(0).toISOString(),
    }];
    await storage.saveMaterial(material);

    server = spawn(process.execPath, ["server.mjs"], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        LISTENING_DATA_DIR: dataRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server);
    const origin = `http://127.0.0.1:${port}`;
    const endpoint = `${origin}/api/learner-profile/phrase-signals`;
    const base = {
      event: "exposed",
      materialId: material.id,
      phraseText: "synthetic alignment pattern",
    };

    const invalidMaterial = await post(endpoint, {
      ...base,
      materialId: "material-missing",
      sentenceId: "sentence-one",
      sessionId: "session-a",
    });
    assert.equal(invalidMaterial.status, 404);

    const invalidSentence = await post(endpoint, {
      ...base,
      sentenceId: "sentence-missing",
      sessionId: "session-a",
    });
    assert.equal(invalidSentence.status, 400);

    const invalidPhrase = await post(endpoint, {
      ...base,
      sentenceId: "sentence-one",
      phraseText: "not an analyzed phrase",
      sessionId: "session-a",
    });
    assert.equal(invalidPhrase.status, 400);

    const invalidSession = await post(endpoint, {
      ...base,
      sentenceId: "sentence-one",
      sessionId: "spaces are rejected",
    });
    assert.equal(invalidSession.status, 400);

    const first = await post(endpoint, {
      ...base,
      sentenceId: "sentence-one",
      sessionId: "session-a",
    });
    const duplicate = await post(endpoint, {
      ...base,
      sentenceId: "sentence-one",
      sessionId: "session-a",
    });
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.signal.exposures.length, 1);

    await post(endpoint, { ...base, sentenceId: "sentence-two", sessionId: "session-a" });
    const inferred = await post(endpoint, { ...base, sentenceId: "sentence-three", sessionId: "session-b" });
    assert.equal(inferred.status, 200);
    assert.equal(inferred.payload.signal.contextCount, 3);
    assert.equal(inferred.payload.signal.sessionCount, 2);
    assert.equal(inferred.payload.signal.implicitEasy, true);

    const profileResponse = await fetch(`${origin}/api/learner-profile`);
    const profilePayload = await profileResponse.json();
    assert.equal(profilePayload.profile.phraseSignals.length, 1);
    assert.equal(profilePayload.profile.phraseSignals[0].implicitEasyAt !== null, true);
    assert.equal(JSON.stringify(profilePayload.profile).includes(material.sentences[0].text), false);

    const blocked = await post(endpoint, {
      event: "guide_opened",
      materialId: material.id,
      sentenceId: "sentence-one",
      phraseText: "synthetic alignment pattern",
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.payload.signal.implicitEasy, false);
    assert.equal(blocked.payload.signal.blocked, true);

    const reviewBase = { ...base, phraseText: "synthetic review pattern" };
    await post(endpoint, { ...reviewBase, sentenceId: "sentence-one", sessionId: "review-session-a" });
    await post(endpoint, { ...reviewBase, sentenceId: "sentence-two", sessionId: "review-session-a" });
    const reviewInferred = await post(endpoint, {
      ...reviewBase,
      sentenceId: "sentence-three",
      sessionId: "review-session-b",
    });
    assert.equal(reviewInferred.payload.signal.implicitEasy, true);

    const reviewResponse = await post(`${origin}/api/materials/${material.id}/review-items`, {
      kind: "phrase",
      sentenceId: "sentence-one",
      sourceText: "synthetic review pattern",
      meaningZh: "合成复习表达",
      usageZh: "仅用于复习反证测试。",
    });
    assert.equal(reviewResponse.status, 200);
    const afterReview = await (await fetch(`${origin}/api/learner-profile`)).json();
    const reviewSignal = afterReview.profile.phraseSignals.find((item) => (
      item.normalizedText === "synthetic review pattern"
    ));
    assert.equal(reviewSignal.implicitEasyAt, null);
    assert.equal(Boolean(reviewSignal.counterEvidence.reviewAddedAt), true);

    for (const [phraseText, evidenceField] of [
      ["cached guide pattern", "guideOpenedAt"],
      ["saved review pattern", "reviewAddedAt"],
      ["saved question pattern", "askedAt"],
    ]) {
      const response = await post(endpoint, {
        ...base,
        phraseText,
        sentenceId: "sentence-one",
        sessionId: `legacy-${evidenceField}`,
      });
      assert.equal(response.status, 200);
      assert.equal(response.payload.signal.blocked, true);
      assert.equal(Boolean(response.payload.signal.counterEvidence[evidenceField]), true);
      assert.equal(response.payload.signal.implicitEasy, false);
    }
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

async function post(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(server) {
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server start timed out: ${output}`)), 5000);
    const collect = (chunk) => {
      output += chunk;
      if (!output.includes("原声精听已启动")) return;
      clearTimeout(timeout);
      resolve();
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before start (${code}): ${output}`));
    });
  });
}
