import fs from "node:fs";
import { pipeline } from "node:stream/promises";

const expectedDisconnectCodes = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

export async function pipeFileToHttpResponse(
  request,
  response,
  target,
  streamOptions = {},
  { createReadStream = fs.createReadStream } = {},
) {
  const source = createReadStream(target, streamOptions);

  const destroySource = () => {
    if (!source.destroyed) source.destroy();
  };
  const handleResponseClose = () => {
    if (!response.writableEnded) destroySource();
  };

  request.once("aborted", destroySource);
  response.once("close", handleResponseClose);

  try {
    await pipeline(source, response);
    return true;
  } catch (error) {
    if (isExpectedClientDisconnect(error, request, response)) return false;
    throw error;
  } finally {
    request.off("aborted", destroySource);
    response.off("close", handleResponseClose);
    destroySource();
  }
}

export function isExpectedClientDisconnect(error, request, response) {
  return expectedDisconnectCodes.has(error?.code);
}
