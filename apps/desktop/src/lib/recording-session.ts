import type { TranscriptLine } from "./recording-types";

/** Synchronous capture state survives React renders while stop waits for final events. */
export function createRecordingSession() {
  let lines: TranscriptLine[] = [];
  let names: Record<string, string> = {};
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  return {
    reset() {
      lines = [];
      names = {};
      startedAt = null;
      endedAt = null;
    },
    start(at = Date.now()) { startedAt ??= at; },
    stop(at = Date.now()) { if (startedAt !== null) endedAt ??= at; },
    append(line: TranscriptLine) { lines.push(line); },
    rename(id: string, name: string) { names[id] = name; },
    speakerName(id: string | null, speaker: string | null, track?: string): string | null {
      if (track === "mic") return "Eu";
      if (!id) return speaker;
      if (id === "UNKNOWN") return "Desconhecido";
      return names[id] || id;
    },
    read(now = Date.now()) {
      const start = startedAt ?? now;
      const end = endedAt ?? now;
      return {
        lines: [...lines],
        names: { ...names },
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(Math.max(start, end)).toISOString(),
        duration: Math.max(0, Math.floor((end - start) / 1000)),
      };
    },
  };
}

export type SaveRecordingResult =
  | { ok: true; meetingId?: string }
  | { ok: false; error: string };

/** Both native windows use this single finalization path. */
export function createRecordingController(actions: {
  stop: () => Promise<void>;
  save: () => Promise<SaveRecordingResult>;
  discard: () => void;
  notify: (result: SaveRecordingResult) => Promise<void>;
  busy: (value: boolean) => void;
}) {
  let busy = false;

  async function finish(save: boolean) {
    if (busy) return;
    busy = true;
    actions.busy(true);
    let result: SaveRecordingResult;
    try {
      await actions.stop();
      if (save) result = await actions.save();
      else {
        actions.discard();
        result = { ok: true };
      }
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      await actions.notify(result);
    } finally {
      busy = false;
      actions.busy(false);
    }
  }

  return { stopAndSave: () => finish(true), cancel: () => finish(false) };
}
