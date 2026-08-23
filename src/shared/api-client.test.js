import test from "node:test";
import assert from "node:assert/strict";
import { postJson, streamNdjson } from "./api-client.js";

function streamingResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
  };
}

test("JSON client rejects non-success responses with the server message", async () => {
  await assert.rejects(
    postJson("/projects", {}, async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "repoPath 必填" }),
    })),
    /repoPath 必填/,
  );
});

test("NDJSON client preserves events split across chunks and returns done payload", async () => {
  const events = [];
  const result = await streamNdjson(
    "/stream",
    { workId: "WORK-1" },
    (event) => events.push(event),
    async () =>
      streamingResponse([
        '{"type":"text","text":"hel',
        'lo"}\n{"type":"done","req":{"ok":true}}',
      ]),
  );
  assert.deepEqual(events, [{ type: "text", text: "hello" }]);
  assert.deepEqual(result, { ok: true });
});

test("NDJSON client surfaces streamed errors", async () => {
  await assert.rejects(
    streamNdjson("/stream", {}, null, async () =>
      streamingResponse(['{"type":"error","message":"boom"}\n']),
    ),
    /boom/,
  );
});
