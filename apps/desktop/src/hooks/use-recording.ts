import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RecordingStatus } from "@/lib/recording-types";
import { uploadTranscript } from "@/lib/meetings";
import { savePendingMeeting, removePendingMeeting, getPendingMeetings, getUnownedMeetings, exportUnownedMeetings, resumeFailedMeetings, retryPendingMeetings, type PendingMeeting } from "@/lib/pending-meetings";
import { isSessionIdentity, type SessionIdentity } from "@/lib/session-identity";
import { isPermanentUploadError } from "@/lib/upload-errors";
import { createRecordingSession } from "@/lib/recording-session";
import { useRecordingContext } from "./use-recording-context";
import { useLiveHighlights, useLiveAnalysisTrigger } from "./use-live-highlights";

interface UseRecordingOptions {
  language?: string;
  captureSystemAudio?: boolean;
  captureMicrophone?: boolean;
}

/** Payload of the "capture-error" event emitted by audio_capture.rs / system_audio.rs. */
interface CaptureErrorPayload {
  track: string;
  message: string;
}

/**
 * pt-BR copy for a capture that stopped. The Rust side sends the technical reason in English
 * (it goes to the console and to support); what the user reads has to say which half of the
 * meeting they are losing, because that is the part they can act on — plug the headset back in,
 * or accept a recording without the remote participants.
 */
function captureErrorMessage(track: string): string {
  return track === "system"
    ? "Não foi possível capturar o áudio do sistema. Apenas o seu microfone está sendo gravado."
    : "A captura do microfone parou (dispositivo removido ou indisponível). A gravação foi interrompida.";
}

/** Builds the transcript with a [speaker] prefix per line. Shared between
 *  saveMeeting and fullTranscript (they were identical). Desktop audit #90. */
function buildTranscript(
  lines: { text: string; speaker: string | null; speakerId: string | null; track: string }[],
  getSpeakerName: (speakerId: string | null, speaker: string | null, track?: string) => string | null,
): string {
  return lines
    .map((l) => {
      const speakerName = getSpeakerName(l.speakerId, l.speaker, l.track);
      return (speakerName ? `[${speakerName}] ` : "") + l.text;
    })
    .join("\n");
}

export function useRecording(options: UseRecordingOptions = {}) {
  const { 
    isRecording, 
    deviceName, 
    sampleRate, 
    transcriptLines,
    partialText: contextPartialText,
    speakerMap,
    setRecordingState,
    addTranscriptLine,
    setPartialText: setContextPartialText,
    renameSpeaker: contextRenameSpeaker,
    clearTranscript
  } = useRecordingContext();
  
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedMeetingId, setSavedMeetingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [unownedCount, setUnownedCount] = useState(0);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const queueBusyRef = useRef(false);
  const recordingOwnerRef = useRef<SessionIdentity | null>(null);
  const preparedMeetingRef = useRef<PendingMeeting | null>(null);
  const savedMeetingRef = useRef<string | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Persistent across re-runs of the retry effect so uploads aren't duplicated
  // if the effect is recreated (desktop audit #87).
  const inFlightIdsRef = useRef<Set<string>>(new Set());

  const { clearHighlights, highlights } = useLiveHighlights();
  const { triggerAnalysis, resetTrigger } = useLiveAnalysisTrigger();

  const session = useRef(createRecordingSession()).current;
  const latestStatusRef = useRef<RecordingStatus | null>(null);
  const captureMicrophoneRef = useRef(true);
  const highlightsRef = useRef(highlights);

  const refreshQueueCounts = useCallback((owner: SessionIdentity | null) => {
    const meetings = owner ? getPendingMeetings(owner) : [];
    setPendingCount(meetings.filter((meeting) => meeting.status === "pending").length);
    setFailedCount(meetings.filter((meeting) => meeting.status === "failed_permanently").length);
    setUnownedCount(getUnownedMeetings().length);
  }, []);

  useEffect(() => {
    highlightsRef.current = highlights;
  }, [highlights]);

  useEffect(() => {
    let cancelled = false;
    const stored: UnlistenFn[] = [];
    const attach = (p: Promise<UnlistenFn>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else stored.push(fn);
      }).catch(() => {});
    };

    attach(
      listen<unknown>("transcript", (event) => {
        const payload = event.payload as {
          text: string;
          isFinal: boolean;
          speaker: string | null;
          speakerId: string | null;
          track: string;
        };

        if (payload.isFinal) {
          const newLine = {
            id: crypto.randomUUID(),
            text: payload.text,
            isFinal: true,
            speaker: payload.speaker,
            speakerId: payload.speakerId,
            track: payload.track,
            timestamp: Date.now(),
          };
          session.append(newLine);
          addTranscriptLine(newLine);
          setContextPartialText("");
        } else {
          setContextPartialText(payload.text);
        }
      }),
    );

    attach(
      listen<RecordingStatus>("recording-status", (event) => {
        const s = event.payload;
        latestStatusRef.current = s;
        if (s.isRecording) session.start();
        else {
          session.stop();
          if (timerRef.current) clearInterval(timerRef.current);
          startTimeRef.current = null;
          setDuration(session.read().duration);
        }
        setRecordingState(s.isRecording, s.micDevice, s.sampleRate);
      }),
    );

    // A capture path that died mid-recording, or a system-audio track that never started.
    // Both used to be silent: the dock kept showing the recording indicator and the timer kept
    // running over silence, and the user found out at upload time (desktop audit #11/#12).
    attach(
      listen<CaptureErrorPayload>("capture-error", (event) => {
        const track = event.payload?.track ?? "mic";
        console.error("[recording] capture error:", track, event.payload?.message);
        setError(track === "system" && !captureMicrophoneRef.current
          ? "A captura do áudio do sistema parou. A gravação foi interrompida."
          : captureErrorMessage(track));
        if (track !== "system") {
          // The mic is the recording. Stop the clock here as well as reverting the status,
          // otherwise the duration keeps climbing over audio nobody is capturing.
          if (timerRef.current) clearInterval(timerRef.current);
          session.stop();
          setDuration(session.read().duration);
          startTimeRef.current = null;
        }
      }),
    );

    const checkStatus = async () => {
      try {
        const status = await invoke<RecordingStatus>("get_recording_status");
        if (status.isRecording) {
          setRecordingState(true, status.micDevice, status.sampleRate);
        }
      } catch (e) {
        console.error("[recording] failed to get status:", e);
      }
    };
    checkStatus();

    return () => {
      cancelled = true;
      stored.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isRecording || transcriptLines.length === 0) return;
    triggerAnalysis(transcriptLines, highlightsRef.current, recordingOwnerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptLines.length, isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => {
      const lines = session.read().lines;
      if (lines.length > 0) {
        triggerAnalysis(lines, highlightsRef.current, recordingOwnerRef.current, true);
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [isRecording, triggerAnalysis]);

  const loadDevices = useCallback(async () => {
    try {
      const list = await invoke<string[]>("list_audio_devices");
      setDevices(list);
    } catch (e) {
      console.error("[recording] failed to list devices:", e);
    }
  }, []);

  const startRecording = useCallback(async (overrides?: {
    deviceName?: string | null;
    captureSystemAudio?: boolean;
    captureMicrophone?: boolean;
    language?: string;
  }) => {
    setError(null);
    session.reset();
    clearTranscript();
    setDuration(0);
    setSavedMeetingId(null);
    setSaveError(null);
    recordingOwnerRef.current = null;
    preparedMeetingRef.current = null;
    savedMeetingRef.current = null;

    const req = {
      deviceName: overrides?.deviceName ?? selectedDevice,
      language: overrides?.language ?? options.language ?? "pt-BR",
      captureSystemAudio:
        overrides?.captureSystemAudio ?? options.captureSystemAudio ?? false,
      captureMicrophone:
        overrides?.captureMicrophone ?? options.captureMicrophone ?? true,
      // No system-audio device travels with this: the WASAPI loopback always captures the
      // Windows default output, and the field the request used to carry was accepted and then
      // dropped by the capture (desktop audit #14).
    };

    if (!req.captureMicrophone && !req.captureSystemAudio) {
      setError("Ative o microfone ou o áudio do sistema para gravar.");
      return;
    }

    try {
      const owner = await invoke<SessionIdentity>("get_session_identity");
      if (!isSessionIdentity(owner)) throw new Error("SESSION_UNAVAILABLE: Entre na janela principal do NORA.");
      recordingOwnerRef.current = owner;
      captureMicrophoneRef.current = req.captureMicrophone;
      latestStatusRef.current = null;
      const result = await invoke<RecordingStatus>("start_recording", { request: { ...req, expectedOwner: owner } });
      // A device can fail while the start command is returning its initial status.
      const current = latestStatusRef.current ?? result;
      setRecordingState(current.isRecording, current.micDevice, current.sampleRate);
      if (!current.isRecording) return;
      session.start();
      startTimeRef.current = Date.parse(session.read().startedAt);
      timerRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);

      clearHighlights();
      invoke("clear_live_highlights").catch(() => {});
      resetTrigger();
      invoke("toggle_overlay", { show: true }).catch((e) =>
        console.error("[recording] failed to open overlay:", e),
      );
    } catch (e) {
      console.error("[recording] start_recording FAILED:", e);
      setError(String(e));
      setRecordingState(false, "", 0);
    }
  }, [selectedDevice, options]);

  const stopRecording = useCallback(async () => {
    session.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    startTimeRef.current = null;
    setDuration(session.read().duration);
    try {
      await invoke("stop_recording");
    } catch (e) {
      console.error("[recording] stop_recording FAILED:", e);
      setError(String(e));
      throw e;
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      startTimeRef.current = null;
      setRecordingState(false, "", 0);
      invoke("toggle_overlay", { show: false }).catch(() => {});
      clearHighlights();
      invoke("clear_live_highlights").catch(() => {});
      resetTrigger();
    }
  }, []);

  const discardRecording = useCallback(() => {
    session.reset();
    recordingOwnerRef.current = null;
    preparedMeetingRef.current = null;
    savedMeetingRef.current = null;
    clearTranscript();
    setDuration(0);
    setSavedMeetingId(null);
    setSaveError(null);
    setError(null);
  }, []);

  const renameSpeaker = useCallback((speakerId: string, newName: string) => {
    session.rename(speakerId, newName);
    contextRenameSpeaker(speakerId, newName);
  }, []);

  const getSpeakerName = useCallback((speakerId: string | null, speaker: string | null, track?: string) => {
    return session.speakerName(speakerId, speaker, track);
  }, []);

  const saveMeeting = useCallback(async (title: string): Promise<
    { ok: true; meetingId: string } | { ok: false; error: string }
  > => {
    if (savedMeetingRef.current) return { ok: true, meetingId: savedMeetingRef.current };
    const snapshot = session.read();
    if (snapshot.lines.length === 0) {
      const msg = "Nenhuma transcrição para salvar";
      setError(msg);
      return { ok: false, error: msg };
    }

    setIsSaving(true);
    setSaveError(null);
    setError(null);

    const transcript = buildTranscript(snapshot.lines, getSpeakerName);

    const participants = Object.entries(snapshot.names).map(([id, name]) => ({
      displayName: name || id,
    }));

    const meetingId = preparedMeetingRef.current?.id ?? crypto.randomUUID();
    const payload = preparedMeetingRef.current?.payload ?? {
      title: title || "Reunião sem título",
      startedAt: snapshot.startedAt,
      transcriptFormat: "TXT" as const,
      fileContent: transcript,
      fileName: `meeting_${meetingId}.txt`,
      endedAt: snapshot.endedAt,
      participants: participants.length > 0 ? participants : undefined,
    };
    // Keep the exact payload and key for every retry, including another save after a timeout.
    const meeting: PendingMeeting = preparedMeetingRef.current ?? {
      id: meetingId,
      owner: recordingOwnerRef.current,
      status: "pending",
      payload,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };
    preparedMeetingRef.current = meeting;

    try {
      if (!meeting.owner) throw new Error("SESSION_UNAVAILABLE: A conta original desta gravação não foi identificada.");
      const result = await uploadTranscript(payload, meeting.owner, meeting.id);
      removePendingMeeting(meeting.owner, meeting.id);
      savedMeetingRef.current = result.meetingId;
      setSavedMeetingId(result.meetingId);
      setSaveError(null);
      refreshQueueCounts(meeting.owner);
      return { ok: true, meetingId: result.meetingId };
    } catch (e) {
      console.error("[recording] save meeting FAILED, queueing locally:", e);
      const msg = e instanceof Error ? e.message : String(e);
      const permanent = isPermanentUploadError(e);
      setSaveError(msg);
      savePendingMeeting({
        ...meeting,
        status: permanent ? "failed_permanently" : "pending",
        lastError: msg,
      });
      refreshQueueCounts(meeting.owner);
      setError(!meeting.owner
        ? "Reunião armazenada sem conta identificada. Exporte a cópia local nas configurações do dock."
        : permanent
          ? "Falha no envio. A cópia local foi preservada."
          : "Reunião armazenada localmente. O envio será retomado na conta original.");
      return { ok: false, error: msg };
    } finally {
      setIsSaving(false);
    }
  }, [getSpeakerName, refreshQueueCounts]);

  const retryQueuedMeetings = useCallback(async (manual = false) => {
    if (queueBusyRef.current) return;
    queueBusyRef.current = true;
    setQueueBusy(true);
    if (manual) setQueueError(null);
    try {
      const owner = await invoke<SessionIdentity>("get_session_identity");
      if (!isSessionIdentity(owner)) throw new Error("SESSION_UNAVAILABLE");
      if (manual) resumeFailedMeetings(owner);
      await retryPendingMeetings(owner,
        async (meeting, identity) => {
          const result = await uploadTranscript(meeting.payload, identity, meeting.id);
          if (meeting.id === preparedMeetingRef.current?.id) {
            savedMeetingRef.current = result.meetingId;
            setSavedMeetingId(result.meetingId);
            setSaveError(null);
            setError(null);
          }
          return result;
        },
        inFlightIdsRef.current);
      refreshQueueCounts(owner);
    } catch {
      refreshQueueCounts(null);
      if (manual) setQueueError("Entre na conta original na janela principal para retomar o envio.");
    } finally {
      queueBusyRef.current = false;
      setQueueBusy(false);
    }
  }, [refreshQueueCounts]);

  useEffect(() => {
    loadDevices().catch((e) => {
      console.error("[recording] failed to load devices on mount:", e);
      setError("Falha ao carregar dispositivos de áudio");
    });

    // Identity is re-read every tick; Rust also checks it immediately before signing each upload.
    void retryQueuedMeetings();
    const retryInterval = setInterval(() => void retryQueuedMeetings(), 30000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      clearInterval(retryInterval);
    };
  }, [loadDevices, retryQueuedMeetings]);

  const fullTranscript = buildTranscript(transcriptLines, getSpeakerName);

  return {
    isRecording,
    deviceName,
    sampleRate,
    transcriptLines,
    partialText: contextPartialText,
    fullTranscript,
    devices,
    selectedDevice,
    setSelectedDevice,
    duration,
    error,
    speakerMap,
    renameSpeaker,
    getSpeakerName,
    isSaving,
    savedMeetingId,
    saveError,
    pendingCount,
    failedCount,
    unownedCount,
    queueBusy,
    queueError,
    retryQueuedMeetings,
    exportUnownedMeetings,
    startRecording,
    stopRecording,
    discardRecording,
    saveMeeting,
    loadDevices,
  };
}
