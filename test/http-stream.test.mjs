import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { isExpectedClientDisconnect, pipeFileToHttpResponse } from "../lib/http-stream.mjs";

test("a destroyed response does not hide an unexpected source-file error", () => {
  assert.equal(isExpectedClientDisconnect(
    Object.assign(new Error("disk read failed"), { code: "EIO" }),
    { aborted: false },
    { destroyed: true },
  ), false);
});

test("a source-file EIO remains visible even after pipeline aborts the request", async (t) => {
  let resolveObservedError;
  const observedError = new Promise((resolve) => {
    resolveObservedError = resolve;
  });
  const server = http.createServer(async (request, response) => {
    response.writeHead(200);
    try {
      await pipeFileToHttpResponse(request, response, "unused", {}, {
        createReadStream() {
          return new Readable({
            read() {
              this.destroy(Object.assign(new Error("disk read failed"), { code: "EIO" }));
            },
          });
        },
      });
    } catch (error) {
      resolveObservedError(error);
    }
  });
  await listen(server);
  t.after(() => closeServer(server));

  const request = http.get(serverAddress(server));
  request.on("error", () => {});
  request.on("response", (response) => response.on("error", () => {}));

  const error = await Promise.race([
    observedError,
    new Promise((_, reject) => setTimeout(() => reject(new Error("EIO was hidden")), 1500)),
  ]);
  request.destroy();
  assert.equal(error.code, "EIO");
});

test("file streams close after the browser aborts a media request", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "listening-http-stream-"));
  const target = path.join(directory, "media.bin");
  await fsp.writeFile(target, Buffer.alloc(4 * 1024 * 1024, 7));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  let source;
  let resolveStream;
  const streamFinished = new Promise((resolve) => {
    resolveStream = resolve;
  });

  const server = http.createServer(async (request, response) => {
    response.writeHead(200, { "Content-Length": 4 * 1024 * 1024 });
    await pipeFileToHttpResponse(request, response, target, {}, {
      createReadStream(file, options) {
        source = fs.createReadStream(file, { ...options, highWaterMark: 16 * 1024 });
        source.once("close", resolveStream);
        return source;
      },
    });
  });
  await listen(server);
  t.after(() => closeServer(server));

  const request = http.get(serverAddress(server));
  await new Promise((resolve, reject) => {
    request.once("response", (response) => {
      response.once("data", () => {
        request.destroy();
        resolve();
      });
      response.once("error", () => {});
    });
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
  });

  await Promise.race([
    streamFinished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("file stream did not close")), 1500)),
  ]);
  assert.equal(source.closed, true);
  assert.equal(source.destroyed, true);
});

test("file streams still deliver complete normal responses", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "listening-http-stream-"));
  const target = path.join(directory, "asset.txt");
  await fsp.writeFile(target, "styled and ready");
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  const server = http.createServer(async (request, response) => {
    response.writeHead(200, { "Content-Length": 16 });
    await pipeFileToHttpResponse(request, response, target);
  });
  await listen(server);
  t.after(() => closeServer(server));

  const body = await new Promise((resolve, reject) => {
    http.get(serverAddress(server), (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.once("error", reject);
    }).once("error", reject);
  });
  assert.equal(body, "styled and ready");
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function serverAddress(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}
