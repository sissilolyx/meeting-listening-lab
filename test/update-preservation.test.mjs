import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safeUpdate } from "../scripts/safe-update.mjs";

test("safe updates preserve local learning state and reject an unsafe upstream tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-listening-safe-update-"));
  const remote = path.join(root, "remote.git");
  const publisher = path.join(root, "publisher");
  const consumer = path.join(root, "consumer");
  try {
    git(root, ["init", "--bare", remote]);
    await fs.mkdir(publisher);
    git(publisher, ["init", "-b", "main"]);
    git(publisher, ["config", "user.name", "Synthetic Publisher"]);
    git(publisher, ["config", "user.email", "synthetic@example.invalid"]);
    await fs.writeFile(path.join(publisher, ".gitignore"), ".data/\n.models/\n*.local\n", "utf8");
    await fs.writeFile(path.join(publisher, "README.md"), "synthetic version one\n", "utf8");
    git(publisher, ["add", ".gitignore", "README.md"]);
    git(publisher, ["commit", "-m", "synthetic v1"]);
    git(publisher, ["remote", "add", "origin", remote]);
    git(publisher, ["push", "-u", "origin", "main"]);
    git(root, ["clone", "--branch", "main", remote, consumer]);

    const localFiles = new Map([
      [".data/materials/synthetic/material.json", Buffer.from(JSON.stringify({ progress: { "synthetic-unit": { status: "heard" } }, qaHistory: [{ id: "synthetic-question" }] }))],
      [".data/settings.json", Buffer.from(JSON.stringify({ provider: "codex", model: "synthetic-model" }))],
      [".data/learner-profile.json", Buffer.from(JSON.stringify({ version: 2, phraseSignals: [{ text: "blue lantern" }] }))],
      [".models/ggml-small.en.bin", Buffer.from([0, 1, 2, 3, 4, 5])],
      ["secrets.local", Buffer.from("consumer-only synthetic setting\n")],
    ]);
    for (const [relative, contents] of localFiles) {
      const target = path.join(consumer, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    }

    await fs.writeFile(path.join(publisher, "README.md"), "synthetic version two\n", "utf8");
    git(publisher, ["add", "README.md"]);
    git(publisher, ["commit", "-m", "synthetic v2"]);
    git(publisher, ["push"]);

    const updated = await safeUpdate(consumer, { logger: { log() {} } });
    assert.equal(updated.updated, true);
    assert.equal(await fs.readFile(path.join(consumer, "README.md"), "utf8"), "synthetic version two\n");
    for (const [relative, expected] of localFiles) {
      assert.deepEqual(await fs.readFile(path.join(consumer, relative)), expected, `${relative} must remain byte-identical`);
    }

    await fs.mkdir(path.join(publisher, ".data"), { recursive: true });
    await fs.writeFile(path.join(publisher, ".data/settings.json"), "unsafe upstream settings\n", "utf8");
    git(publisher, ["add", "-f", ".data/settings.json"]);
    git(publisher, ["commit", "-m", "synthetic unsafe release"]);
    git(publisher, ["push"]);

    const safeHead = gitText(consumer, ["rev-parse", "HEAD"]);
    await assert.rejects(
      safeUpdate(consumer, { logger: { log() {} } }),
      /远端版本包含不应进入 Git/,
    );
    assert.equal(gitText(consumer, ["rev-parse", "HEAD"]), safeHead);
    assert.deepEqual(await fs.readFile(path.join(consumer, ".data/settings.json")), localFiles.get(".data/settings.json"));

    git(publisher, ["rm", ".data/settings.json"]);
    await fs.writeFile(path.join(publisher, "secrets.local"), "unsafe upstream local setting\n", "utf8");
    git(publisher, ["add", "-f", "secrets.local"]);
    git(publisher, ["commit", "-m", "synthetic unsafe local setting"]);
    git(publisher, ["push"]);

    await assert.rejects(
      safeUpdate(consumer, { logger: { log() {} } }),
      /远端版本包含不应进入 Git/,
    );
    assert.equal(gitText(consumer, ["rev-parse", "HEAD"]), safeHead);
    assert.deepEqual(await fs.readFile(path.join(consumer, "secrets.local")), localFiles.get("secrets.local"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitText(cwd, args) {
  return git(cwd, args).trim();
}
