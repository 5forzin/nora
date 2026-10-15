import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { uploadTranscript } from "./meetings.ts";

const OWNER = { userId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222" };
const KEY = "33333333-3333-4333-8333-333333333333";
const PAYLOAD = {
  title: "Synthetic meeting", startedAt: "2026-10-14T12:00:00Z", endedAt: "2026-10-14T12:01:00Z",
  transcriptFormat: "TXT", fileContent: "Synthetic content", fileName: "meeting.txt",
};

function stubInvoke(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

test("network retries send the original owner, key and exact payload to native upload", async (context) => {
  context.mock.method(console, "warn", () => {});
  const requests: Record<string, unknown>[] = [];
  stubInvoke(async (command, args) => {
    assert.equal(command, "upload_meeting");
    requests.push(args.request as Record<string, unknown>);
    if (requests.length === 1) throw new Error("Timeout after persistence");
    return { meetingId: "existing-meeting", processingStatus: "COMPLETED" };
  });
  const result = await uploadTranscript(PAYLOAD, OWNER, KEY, { initialBackoffMs: 0 });
  assert.deepEqual(result, { meetingId: "existing-meeting" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0].expectedOwner, OWNER);
  assert.equal(requests[0].idempotencyKey, KEY);
  assert.equal(requests[0].fileContent, PAYLOAD.fileContent);
  assert.equal(requests[0].endedAt, PAYLOAD.endedAt);
});

test("account mismatch and missing login do not trigger native upload backoff", async () => {
  for (const error of ["ACCOUNT_MISMATCH", "SESSION_UNAVAILABLE", "Upload failed (401): expired", "Upload failed (401 Unauthorized): expired", "Upload failed (403 Forbidden): denied", "Upload failed (409 Conflict): UPLOAD_ALREADY_REMOVED"]) {
    let calls = 0;
    stubInvoke(async () => { calls++; throw error; });
    await assert.rejects(uploadTranscript(PAYLOAD, OWNER, KEY, { initialBackoffMs: 0 }), (actual) => actual === error);
    assert.equal(calls, 1);
  }
});

test("rate limits remain eligible for backoff", async (context) => {
  context.mock.method(console, "warn", () => {});
  let calls = 0;
  stubInvoke(async () => {
    if (++calls === 1) throw "Upload failed (429 Too Many Requests): limited";
    return { meetingId: "existing-meeting", processingStatus: "PENDING" };
  });
  await uploadTranscript(PAYLOAD, OWNER, KEY, { initialBackoffMs: 0 });
  assert.equal(calls, 2);
});
