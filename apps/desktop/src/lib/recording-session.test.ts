import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecordingController, createRecordingSession, type SaveRecordingResult } from "./recording-session.ts";
import type { TranscriptLine } from "./recording-types.ts";

function line(text: string): TranscriptLine {
  return { id: text, text, isFinal: true, speaker: null, speakerId: "SPEAKER_01", track: "system", timestamp: 0 };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("saving after stop includes the final event received during provider drain", async () => {
  const session = createRecordingSession();
  const drain = deferred();
  const saved: ReturnType<typeof session.read>[] = [];
  const notifications: SaveRecordingResult[] = [];
  const busy: boolean[] = [];
  session.start(1000);
  const save = async () => {
    saved.push(session.read(99000));
    return { ok: true as const, meetingId: "meeting-1" };
  };
  const controller = createRecordingController({
    stop: async () => { session.stop(6000); await drain.promise; },
    save,
    discard: () => session.reset(),
    notify: async (result) => { notifications.push(result); },
    busy: (value) => { busy.push(value); },
  });

  const stopped = controller.stopAndSave();
  assert.equal(saved.length, 0);
  // The save callback predates this final transcript, as it does in a React render.
  session.append(line("The deadline is Friday."));
  session.rename("SPEAKER_01", "Director");
  drain.resolve();
  await stopped;

  assert.deepEqual(saved[0].lines.map((entry) => entry.text), ["The deadline is Friday."]);
  assert.deepEqual(saved[0].names, { SPEAKER_01: "Director" });
  assert.equal(saved[0].startedAt, new Date(1000).toISOString());
  assert.equal(saved[0].endedAt, new Date(6000).toISOString());
  assert.equal(saved[0].duration, 5);
  assert.deepEqual(notifications, [{ ok: true, meetingId: "meeting-1" }]);
  assert.deepEqual(busy, [true, false]);
});

test("dock and overlay stop or cancel commands cannot duplicate a pending save", async () => {
  const drain = deferred();
  let stops = 0;
  let saves = 0;
  let discards = 0;
  const controller = createRecordingController({
    stop: async () => { stops++; await drain.promise; },
    save: async () => { saves++; return { ok: true }; },
    discard: () => { discards++; },
    notify: async () => {},
    busy: () => {},
  });
  const first = controller.stopAndSave();
  await controller.stopAndSave();
  await controller.cancel();
  assert.equal(stops, 1);
  assert.equal(saves, 0);
  drain.resolve();
  await first;
  assert.equal(saves, 1);
  assert.equal(discards, 0);
});

test("a failed stop reports failure without uploading an incomplete transcript", async () => {
  const notifications: SaveRecordingResult[] = [];
  const busy: boolean[] = [];
  let saves = 0;
  const controller = createRecordingController({
    stop: async () => { throw new Error("Provider finalization timed out"); },
    save: async () => { saves++; return { ok: true }; },
    discard: () => assert.fail("must preserve the failed recording"),
    notify: async (result) => { notifications.push(result); },
    busy: (value) => { busy.push(value); },
  });
  await controller.stopAndSave();
  assert.equal(saves, 0);
  assert.deepEqual(notifications, [{ ok: false, error: "Provider finalization timed out" }]);
  assert.deepEqual(busy, [true, false]);
});

test("cancel waits for the last event then clears it without uploading", async () => {
  const session = createRecordingSession();
  const drain = deferred();
  session.start(1000);
  session.append(line("Discard this meeting."));
  session.rename("SPEAKER_01", "Previous name");
  const notifications: SaveRecordingResult[] = [];
  const controller = createRecordingController({
    stop: async () => { session.stop(3000); await drain.promise; },
    save: async () => assert.fail("cancel must not upload"),
    discard: () => session.reset(),
    notify: async (result) => { notifications.push(result); },
    busy: () => {},
  });
  const cancelled = controller.cancel();
  session.append(line("Last discarded sentence."));
  drain.resolve();
  await cancelled;
  session.start(10000);
  session.append(line("A new meeting."));
  session.stop(12000);
  assert.deepEqual(session.read().lines.map((entry) => entry.text), ["A new meeting."]);
  assert.deepEqual(session.read().names, {});
  assert.equal(session.read().duration, 2);
  assert.equal(session.read().startedAt, new Date(10000).toISOString());
  assert.deepEqual(notifications, [{ ok: true }]);
});

test("a new recording resets timestamps and speaker names after a saved session", () => {
  const session = createRecordingSession();
  const speakerName = session.speakerName;
  session.start(1000);
  session.append(line("First session."));
  session.rename("SPEAKER_01", "Director");
  assert.equal(speakerName("SPEAKER_01", null, "system"), "Director");
  session.stop(2000);
  session.stop(8000);
  assert.equal(session.read().duration, 1);
  session.reset();
  session.start(10000);
  session.start(11000);
  session.append(line("Second session."));
  session.stop(13000);
  assert.deepEqual(session.read().lines.map((entry) => entry.text), ["Second session."]);
  assert.equal(speakerName("SPEAKER_01", null, "system"), "SPEAKER_01");
  assert.equal(session.read().duration, 3);
});

test("an upload failure is returned to the overlay and releases the controls", async () => {
  const busy: boolean[] = [];
  const notifications: SaveRecordingResult[] = [];
  const controller = createRecordingController({
    stop: async () => {},
    save: async () => ({ ok: false, error: "Upload unavailable" }),
    discard: () => assert.fail("failed uploads must be retained"),
    notify: async (result) => { notifications.push(result); },
    busy: (value) => { busy.push(value); },
  });
  await controller.stopAndSave();
  assert.deepEqual(notifications, [{ ok: false, error: "Upload unavailable" }]);
  assert.deepEqual(busy, [true, false]);
});
