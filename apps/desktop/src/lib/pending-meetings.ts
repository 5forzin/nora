import { isSessionIdentity, sameSessionIdentity, type SessionIdentity } from "./session-identity.ts";
import { isPermanentUploadError, isSessionUploadError } from "./upload-errors.ts";

export interface PendingMeeting {
  id: string;
  owner: SessionIdentity | null;
  status: "pending" | "failed_permanently" | "completed";
  payload: {
    title: string;
    startedAt: string;
    endedAt?: string;
    transcriptFormat: string;
    fileContent: string;
    fileName: string;
    participants?: { displayName: string; email?: string }[];
    tags?: string[];
  };
  createdAt: string;
  retryCount: number;
  lastError?: string;
}

const LEGACY_STORAGE_KEY = "nora-pending-meetings";

function storageKey(owner: SessionIdentity): string {
  if (!isSessionIdentity(owner)) throw new Error("SESSION_UNAVAILABLE: Identidade inválida.");
  return `${LEGACY_STORAGE_KEY}:v2:${owner.tenantId.toLowerCase()}:${owner.userId.toLowerCase()}`;
}

function isPendingMeeting(v: unknown): v is PendingMeeting {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PendingMeeting).id === "string" &&
    typeof (v as PendingMeeting).payload === "object" &&
    (v as PendingMeeting).payload !== null
  );
}

function readQueue(key: string): PendingMeeting[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Validate the shape: localStorage may hold junk from older versions. Audit #108.
    return Array.isArray(parsed) ? parsed.filter(isPendingMeeting) : [];
  } catch {
    return [];
  }
}

export function getPendingMeetings(owner: SessionIdentity): PendingMeeting[] {
  return readQueue(storageKey(owner)).filter((meeting) =>
    isSessionIdentity(meeting.owner) && sameSessionIdentity(meeting.owner, owner));
}

/** Old entries have no trustworthy account identity. Keep them untouched and never auto-upload. */
export function getUnownedMeetings(): PendingMeeting[] {
  return readQueue(LEGACY_STORAGE_KEY);
}

export function exportUnownedMeetings(): string {
  return localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]";
}

export function savePendingMeeting(meeting: PendingMeeting): void {
  const key = meeting.owner ? storageKey(meeting.owner) : LEGACY_STORAGE_KEY;
  const meetings = readQueue(key);
  const existing = meetings.findIndex((m) => m.id === meeting.id);
  if (existing >= 0) {
    meetings[existing] = meeting;
  } else {
    meetings.push(meeting);
  }
  localStorage.setItem(key, JSON.stringify(meetings));
}

export function removePendingMeeting(owner: SessionIdentity, id: string): void {
  const key = storageKey(owner);
  const meetings = readQueue(key).filter((meeting) => meeting.id !== id);
  localStorage.setItem(key, JSON.stringify(meetings));
}

export function getPendingCount(owner: SessionIdentity): number {
  return getPendingMeetings(owner).filter((meeting) => meeting.status === "pending").length;
}

export function resumeFailedMeetings(owner: SessionIdentity): void {
  for (const meeting of getPendingMeetings(owner)) {
    if (meeting.status === "failed_permanently") {
      savePendingMeeting({ ...meeting, status: "pending", retryCount: 0, lastError: undefined });
    }
  }
}

export async function retryPendingMeetings(
  owner: SessionIdentity | null,
  upload: (meeting: PendingMeeting, owner: SessionIdentity) => Promise<unknown>,
  inFlight: Set<string>,
): Promise<void> {
  if (!owner || !isSessionIdentity(owner)) return;
  const pending = getPendingMeetings(owner).filter((meeting) => meeting.status === "pending" && meeting.retryCount < 10);
  await Promise.all(pending.map(async (meeting) => {
    const key = `${storageKey(owner)}:${meeting.id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await upload(meeting, owner);
      removePendingMeeting(owner, meeting.id);
    } catch (error) {
      // Signing out, changing accounts or losing upload permission must not exhaust the queue.
      if (isSessionUploadError(error)) return;
      const retryCount = meeting.retryCount + 1;
      savePendingMeeting({
        ...meeting,
        status: isPermanentUploadError(error) || retryCount >= 10 ? "failed_permanently" : "pending",
        retryCount,
        lastError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.delete(key);
    }
  }));
}
