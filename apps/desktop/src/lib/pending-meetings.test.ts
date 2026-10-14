import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  getPendingCount,
  getPendingMeetings,
  removePendingMeeting,
  savePendingMeeting,
  retryPendingMeetings,
  resumeFailedMeetings,
  getUnownedMeetings,
  exportUnownedMeetings,
  type PendingMeeting,
} from "./pending-meetings.ts";

// This queue is the last copy of a meeting that failed to upload. Everything below is about the
// two ways it can lose one: junk in storage taking the whole list down with it, and a save that
// duplicates instead of updating (which is what produced duplicate meetings in the backend).

const ALICE = { userId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222" };
const BOB = { ...ALICE, userId: "33333333-3333-4333-8333-333333333333" };
const OTHER_TENANT = { ...ALICE, tenantId: "44444444-4444-4444-8444-444444444444" };
const LEGACY_KEY = "nora-pending-meetings";
const KEY = `${LEGACY_KEY}:v2:${ALICE.tenantId}:${ALICE.userId}`;

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function storage(): MemoryStorage {
  return (globalThis as { localStorage?: MemoryStorage }).localStorage as MemoryStorage;
}

function meeting(id: string, overrides: Partial<PendingMeeting> = {}): PendingMeeting {
  return {
    id,
    owner: ALICE,
    status: "pending",
    payload: {
      title: "Reunião",
      startedAt: "2026-08-23T10:00:00.000Z",
      transcriptFormat: "TXT",
      fileContent: "[Eu] bom dia",
      fileName: "reuniao.txt",
    },
    createdAt: "2026-08-23T11:00:00.000Z",
    retryCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

test("an empty store yields an empty queue rather than a crash", () => {
  assert.deepEqual(getPendingMeetings(ALICE), []);
  assert.equal(getPendingCount(ALICE), 0);
});

test("saving the same id twice updates the entry instead of queueing it again", () => {
  savePendingMeeting(meeting("a"));
  savePendingMeeting(meeting("a", { retryCount: 3, lastError: "timeout" }));

  const queued = getPendingMeetings(ALICE);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].retryCount, 3);
  assert.equal(queued[0].lastError, "timeout");
});

test("only entries still marked pending are counted for the retry worker", () => {
  savePendingMeeting(meeting("a"));
  savePendingMeeting(meeting("b", { status: "failed_permanently", retryCount: 10 }));
  savePendingMeeting(meeting("c", { status: "completed" }));

  assert.equal(getPendingMeetings(ALICE).length, 3);
  assert.equal(getPendingCount(ALICE), 1);
});

test("removing an entry leaves the rest of the queue alone", () => {
  savePendingMeeting(meeting("a"));
  savePendingMeeting(meeting("b"));
  removePendingMeeting(ALICE, "a");

  assert.deepEqual(
    getPendingMeetings(ALICE).map((m) => m.id),
    ["b"],
  );
});

test("junk in storage is filtered out entry by entry, not by dropping the queue", () => {
  storage().setItem(
    KEY,
    JSON.stringify([{ id: "no-payload" }, meeting("real"), "not even an object", null]),
  );

  const queued = getPendingMeetings(ALICE);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "real");
});

test("storage holding something that is not an array reads as an empty queue", () => {
  storage().setItem(KEY, "{ not json");
  assert.deepEqual(getPendingMeetings(ALICE), []);

  storage().setItem(KEY, JSON.stringify({ id: "a" }));
  assert.deepEqual(getPendingMeetings(ALICE), []);
});

test("queue reads, updates and deletes are scoped to both user and tenant", () => {
  savePendingMeeting(meeting("same-id"));
  savePendingMeeting(meeting("same-id", { owner: BOB, retryCount: 2 }));
  savePendingMeeting(meeting("same-id", { owner: OTHER_TENANT, retryCount: 3 }));
  removePendingMeeting(BOB, "same-id");
  assert.equal(getPendingMeetings(ALICE)[0].retryCount, 0);
  assert.equal(getPendingMeetings(OTHER_TENANT)[0].retryCount, 3);
  assert.deepEqual(getPendingMeetings(BOB), []);
});

test("Alice's queued transcript is never retried with Bob's account or another tenant", async () => {
  savePendingMeeting(meeting("alice"));
  let uploads = 0;
  const upload = async () => { uploads++; };
  await retryPendingMeetings(BOB, upload, new Set());
  await retryPendingMeetings(OTHER_TENANT, upload, new Set());
  assert.equal(uploads, 0);
  assert.equal(getPendingMeetings(ALICE).length, 1);
  await retryPendingMeetings(ALICE, upload, new Set());
  assert.equal(uploads, 1);
  assert.equal(getPendingMeetings(ALICE).length, 0);
});

test("missing identity pauses the queue without using an attempt", async () => {
  savePendingMeeting(meeting("alice"));
  await retryPendingMeetings(null, async () => { assert.fail("must not upload without an identity"); }, new Set());
  assert.equal(getPendingMeetings(ALICE)[0].retryCount, 0);
});

test("a changed or unavailable session during upload does not exhaust retries", async () => {
  savePendingMeeting(meeting("alice"));
  for (const error of ["ACCOUNT_MISMATCH", "SESSION_UNAVAILABLE", "Upload failed (401): expired", "Upload failed (403): denied", "Upload failed (401 Unauthorized): expired", "Upload failed (403 Forbidden): denied", { status: 401 }]) {
    await retryPendingMeetings(ALICE, async () => { throw error; }, new Set());
    assert.equal(getPendingMeetings(ALICE)[0].retryCount, 0);
    assert.equal(getPendingMeetings(ALICE)[0].status, "pending");
  }
});

test("validation failures and idempotency conflicts stop after the first response", async () => {
  for (const error of ["Upload failed (400 Bad Request): invalid", "Upload failed (409 Conflict): UPLOAD_IDEMPOTENCY_CONFLICT", "Upload failed (409): UPLOAD_ALREADY_REMOVED"]) {
    savePendingMeeting(meeting("alice"));
    let calls = 0;
    const upload = async () => { calls++; throw error; };
    await retryPendingMeetings(ALICE, upload, new Set());
    await retryPendingMeetings(ALICE, upload, new Set());
    assert.equal(calls, 1);
    assert.equal(getPendingMeetings(ALICE)[0].retryCount, 1);
    assert.equal(getPendingMeetings(ALICE)[0].status, "failed_permanently");
  }
});

test("rate limits keep the queued entry eligible for another attempt", async () => {
  savePendingMeeting(meeting("alice"));
  await retryPendingMeetings(ALICE, async () => { throw "Upload failed (429 Too Many Requests): limited"; }, new Set());
  assert.equal(getPendingMeetings(ALICE)[0].retryCount, 1);
  assert.equal(getPendingMeetings(ALICE)[0].status, "pending");
});

test("legacy entries remain exportable but are never assigned to the current account", async () => {
  const old = { ...meeting("legacy") } as Partial<PendingMeeting>;
  delete old.owner;
  const original = JSON.stringify([old]);
  storage().setItem(LEGACY_KEY, original);
  await retryPendingMeetings(ALICE, async () => { assert.fail("legacy entries must stay quarantined"); }, new Set());
  await retryPendingMeetings(BOB, async () => { assert.fail("legacy entries must stay quarantined"); }, new Set());
  assert.equal(getUnownedMeetings().length, 1);
  assert.equal(exportUnownedMeetings(), original);
  assert.equal(storage().getItem(LEGACY_KEY), original);
});

test("network failures stop after ten attempts and only the owner can manually resume", async () => {
  savePendingMeeting(meeting("alice"));
  let uploads = 0;
  for (let index = 0; index < 12; index++) {
    await retryPendingMeetings(ALICE, async () => { uploads++; throw new Error("Network unavailable"); }, new Set());
  }
  assert.equal(uploads, 10);
  assert.equal(getPendingMeetings(ALICE)[0].status, "failed_permanently");
  assert.equal(getPendingCount(ALICE), 0);
  resumeFailedMeetings(BOB);
  assert.equal(getPendingMeetings(ALICE)[0].retryCount, 10);
  resumeFailedMeetings(ALICE);
  assert.equal(getPendingMeetings(ALICE)[0].retryCount, 0);
  await retryPendingMeetings(ALICE, async () => {}, new Set());
  assert.equal(getPendingMeetings(ALICE).length, 0);
});

test("overlapping ticks keep one upload and preserve the same idempotency key and payload", async () => {
  const original = meeting("11111111-1111-4111-8111-555555555555");
  savePendingMeeting(original);
  const inFlight = new Set<string>();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let uploads = 0;
  const upload = async (queued: PendingMeeting) => {
    uploads++;
    assert.deepEqual(queued.payload, original.payload);
    assert.equal(queued.id, original.id);
    await pending;
    throw new Error("Timeout after server persistence");
  };
  const first = retryPendingMeetings(ALICE, upload, inFlight);
  await retryPendingMeetings(ALICE, upload, inFlight);
  release();
  await first;
  assert.equal(uploads, 1);
  await retryPendingMeetings(ALICE, async (queued) => {
    assert.equal(queued.id, original.id);
    assert.deepEqual(queued.payload, original.payload);
  }, inFlight);
  assert.equal(getPendingMeetings(ALICE).length, 0);
});
