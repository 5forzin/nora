//! Cloud STT over the provider's realtime WebSocket, one connection per track (ADR 0039/0045).
//!
//! Replaces the sliding-window re-decode loop of the local engine with real streaming: audio goes
//! up as it is captured and partials come back as they are produced. Models without server VAD
//! need client commits at speech pauses and a final flush before the recording can be saved.
//!
//! ============================================================================
//! THE CLOCK, AND WHY IT COUNTS RECEIVED AUDIO RATHER THAN SENT AUDIO
//! ============================================================================
//! `TranscriptEvent::offset_ms` is absolute against the start of the track's recording and MUST be
//! monotonic non-decreasing (`stt.rs`). The provider's events carry no such clock: they describe an
//! utterance, not a position in our recording. So the position is ours to keep.
//!
//! It is kept as `samples RECEIVED from capture / TARGET_SAMPLE_RATE`, not samples successfully
//! sent. The difference matters exactly once, and it is the case this module has to survive: while
//! the socket is down, audio keeps arriving and is discarded. A clock made of sent audio would
//! stall for the length of the outage and every later offset would sit that far in the past. This
//! is the same invariant the local engine kept with its `AudioMsg::Gap` — the clock advances
//! through the hole, because the hole is part of the recording.
//!
//! To keep that true the reconnect path DRAINS the audio channel instead of letting it back up,
//! which also keeps capture from silently dropping on a full channel.
//!
//! ============================================================================
//! WHAT A DROPPED SESSION COSTS, STATED PLAINLY
//! ============================================================================
//! ADR 0035 celebrated killing the mid-meeting credential expiry; ADR 0039 brings it back as the
//! normal case rather than the edge case. When the connection dies we ask the backend for a NEW
//! session (the credential is not renewable), reconnect, and continue the offset counter where it
//! was. **The audio captured during the gap is gone, so there is a hole in the transcript.** That
//! follows the rule already written in `stt.rs` — real time is worth more than completeness — but
//! a hole is worse than a dropped sample, so it is announced on `stt-error`, which the overlay
//! renders as a visible toast (`overlay.tsx`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
};

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::stt::{speaker_id_for_track, SttBackend, TranscriptEvent, TARGET_SAMPLE_RATE};
use crate::stt_token::{self, RealtimeSession};

mod google;

/// Consecutive failed connection attempts before the track gives up for good.
///
/// Bounded on purpose. An unbounded retry against a provider that is refusing us is a loop that
/// spends the user's session budget and their battery while the overlay says nothing new.
///
/// CONSECUTIVE is the load-bearing word, and `record_failure` is what makes it true. The counter
/// used to only ever grow, so five transient drops spread across a two-hour meeting — Wi-Fi
/// wobbling, the provider closing an idle session — silenced the track for the rest of it while
/// the recording carried on as if nothing had happened.
const MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// First backoff step; doubles up to `MAX_BACKOFF`.
const BASE_BACKOFF: Duration = Duration::from_millis(800);
const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// Slack of the channel between `audio_capture` and this task. 100 chunks of ~100 ms.
const AUDIO_QUEUE_CHUNKS: usize = 100;
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

// ============================================================================
// Public handle
// ============================================================================

pub struct CloudSttHandle {
    session_id: String,
    audio_tx: mpsc::Sender<Vec<i16>>,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<Result<(), String>>>,
    stop_timeout: Duration,
}

impl Drop for CloudSttHandle {
    fn drop(&mut self) {
        // Same defence the local handle had: if the Vec of backends is cleared without going
        // through stop() (panic, logout, abrupt close), the signal still goes out and the socket
        // is closed instead of streaming a meeting nobody is recording any more.
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl SttBackend for CloudSttHandle {
    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn audio_tx(&self) -> mpsc::Sender<Vec<i16>> {
        self.audio_tx.clone()
    }

    fn stop(mut self: Box<Self>) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        let task = self.task.take();
        let stop_timeout = self.stop_timeout;
        Box::pin(async move {
            if let Some(mut task) = task {
                match tokio::time::timeout(stop_timeout, &mut task).await {
                    Ok(result) => result.map_err(|e| format!("Transcription task failed: {e}"))?,
                    Err(_) => {
                        task.abort();
                        Err("Timed out finalizing the transcription.".to_string())
                    }
                }
            } else {
                Ok(())
            }
        })
    }
}

impl CloudSttHandle {
    /// Brings up cloud transcription for ONE track.
    ///
    /// The first session is minted BEFORE returning, so a missing credential, a denied permission
    /// or an unreachable API fails while the user is still looking at the record button — rather
    /// than five minutes into a meeting that turns out to have no transcript. This is the same
    /// choice the local engine made when it blocked on loading the model.
    pub async fn start(
        app: AppHandle,
        language: String,
        track_label: String,
        expected_owner: crate::auth_bridge::SessionIdentity,
    ) -> Result<Self, String> {
        let session = stt_token::fetch_session(&app, &language, &expected_owner)
            .await
            .map_err(|e| e.to_string())?;

        connection_request(&session).map_err(str::to_string)?;

        if session.provider == "openai" && session.sample_rate != TARGET_SAMPLE_RATE {
            // Not fatal: what we actually stream is declared to the provider on connect, so the
            // truth is preserved either way. It IS worth shouting about, because the two numbers
            // drifting apart is a misconfiguration whose only other symptom is a transcript that
            // reads like nonsense.
            eprintln!(
                "[stt_cloud] backend asked for {} Hz, capture produces {} Hz — streaming {} Hz \
                 and telling the provider so",
                session.sample_rate, TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE
            );
        }

        let session_id = uuid::Uuid::new_v4().to_string();
        let stop_timeout = if session.provider == "google" {
            Duration::from_secs(25)
        } else {
            STOP_TIMEOUT
        };
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<i16>>(AUDIO_QUEUE_CHUNKS);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();

        let task_app = app.clone();
        let task_session_id = session_id.clone();
        let task = tokio::spawn(async move {
            run(
                task_app,
                task_session_id,
                track_label,
                language,
                expected_owner,
                session,
                audio_rx,
                stop_rx,
            )
            .await
        });

        Ok(Self {
            session_id,
            audio_tx,
            stop_tx: Some(stop_tx),
            task: Some(task),
            stop_timeout,
        })
    }
}

// ============================================================================
// Track clock
// ============================================================================

/// Absolute position in the track's recording, derived from the audio that reached this task.
///
/// Shared as an atomic because the two halves of the connection touch it: the writer advances it
/// as PCM arrives, and the reader reads it when the provider finalises an utterance.
#[derive(Clone, Default)]
struct TrackClock {
    samples: Arc<AtomicU64>,
}

impl TrackClock {
    fn advance(&self, samples: usize) {
        self.samples.fetch_add(samples as u64, Ordering::Relaxed);
    }

    fn now_ms(&self) -> u64 {
        samples_to_ms(self.samples.load(Ordering::Relaxed))
    }
}

fn samples_to_ms(samples: u64) -> u64 {
    samples * 1_000 / TARGET_SAMPLE_RATE as u64
}

// ============================================================================
// Connection lifecycle
// ============================================================================

/// Why a connection ended.
enum Outcome {
    /// `stop()` was called, or capture closed the channel. Terminal.
    Stopped,
    FinalizationFailed(String),
    /// The socket died. Reconnectable, with a reason for the user.
    ///
    /// `progressed` says whether this connection had delivered any transcript before dying. It
    /// is what separates a run of failures from a working session that happened to drop — see
    /// [`record_failure`].
    Lost {
        reason: String,
        progressed: bool,
    },
}

/// A connection lost before it ever produced anything.
fn lost(reason: impl Into<String>) -> Outcome {
    Outcome::Lost {
        reason: reason.into(),
        progressed: false,
    }
}

/// The consecutive-failure budget after one lost connection.
///
/// A connection that delivered transcript before dying PROVES the credential, the provider and
/// the network all work, so whatever run of failures preceded it is over: this failure is the
/// first of a new run rather than the fifth of an old one. Without that reset the counter was
/// cumulative, contradicting the name of [`MAX_CONSECUTIVE_FAILURES`], its doc-comment, and a
/// backoff that grows per attempt.
fn record_failure(consecutive: u32, progressed: bool) -> u32 {
    if progressed {
        1
    } else {
        consecutive + 1
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    app: AppHandle,
    session_id: String,
    track: String,
    language: String,
    expected_owner: crate::auth_bridge::SessionIdentity,
    first_session: RealtimeSession,
    mut audio_rx: mpsc::Receiver<Vec<i16>>,
    mut stop_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let clock = TrackClock::default();
    // Lives OUTSIDE the connection loop: this is what makes a reconnection continue the
    // transcript's clock instead of restarting it at zero.
    let mut last_final_end_ms: u64 = 0;

    let mut pending = Some(first_session);
    let mut consecutive_failures: u32 = 0;

    loop {
        let session = match pending.take() {
            Some(s) => s,
            None => match stt_token::fetch_session(&app, &language, &expected_owner).await {
                Ok(s) => s,
                Err(e) => {
                    consecutive_failures = record_failure(consecutive_failures, false);
                    emit_error(&app, &session_id, &track, e.code, &e.message);
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        emit_gave_up(&app, &session_id, &track);
                        return Err(
                            "Transcription stopped after repeated connection failures.".to_string()
                        );
                    }
                    if !backoff(&mut audio_rx, &clock, &mut stop_rx, consecutive_failures).await {
                        return Ok(());
                    }
                    continue;
                }
            },
        };

        let outcome = stream_one_session(
            &app,
            &session_id,
            &track,
            &session,
            &clock,
            &mut last_final_end_ms,
            &mut audio_rx,
            &mut stop_rx,
        )
        .await;

        match outcome {
            Outcome::Stopped => return Ok(()),
            Outcome::FinalizationFailed(reason) => return Err(reason),
            Outcome::Lost { reason, progressed } => {
                consecutive_failures = record_failure(consecutive_failures, progressed);
                emit_error(
                    &app,
                    &session_id,
                    &track,
                    "STT_SESSION_LOST",
                    &format!(
                        "Transcription dropped and is reconnecting ({}). What is said in the \
                         meantime will be missing from the transcript.",
                        reason
                    ),
                );
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    emit_gave_up(&app, &session_id, &track);
                    return Err(
                        "Transcription stopped after repeated connection failures.".to_string()
                    );
                }
                if !backoff(&mut audio_rx, &clock, &mut stop_rx, consecutive_failures).await {
                    return Ok(());
                }
            }
        }
    }
}

/// Waits out the backoff while KEEPING THE CLOCK RUNNING.
///
/// Draining rather than sleeping is the whole point: the discarded audio still advances the track
/// clock, so the transcript resumes at the right position instead of the length of the outage
/// behind. Returns false when the caller should stop entirely.
async fn backoff(
    audio_rx: &mut mpsc::Receiver<Vec<i16>>,
    clock: &TrackClock,
    stop_rx: &mut oneshot::Receiver<()>,
    attempt: u32,
) -> bool {
    let delay = BASE_BACKOFF
        .saturating_mul(1u32 << attempt.min(5))
        .min(MAX_BACKOFF);
    let deadline = tokio::time::sleep(delay);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut *stop_rx => return false,
            _ = &mut deadline => return true,
            chunk = audio_rx.recv() => match chunk {
                Some(samples) => clock.advance(samples.len()),
                None => return false,
            },
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_one_session(
    app: &AppHandle,
    session_id: &str,
    track: &str,
    session: &RealtimeSession,
    clock: &TrackClock,
    last_final_end_ms: &mut u64,
    audio_rx: &mut mpsc::Receiver<Vec<i16>>,
    stop_rx: &mut oneshot::Receiver<()>,
) -> Outcome {
    let request = match connection_request(session) {
        Ok(r) => r,
        Err(message) => return lost(message),
    };

    let (socket, _) = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        // Transport errors may carry the request URI or headers. Only the failure class is safe.
        Ok(Err(_)) => return lost("provider handshake failed"),
        Err(_) => return lost("provider handshake timed out"),
    };
    if session.provider == "google" {
        return google::stream_connected(
            socket,
            session,
            clock,
            audio_rx,
            stop_rx,
            |event| emit_transcript(app, session_id, track, clock, last_final_end_ms, event),
            FINALIZE_TIMEOUT,
            google::INACTIVITY_TIMEOUT,
        )
        .await;
    }
    stream_connected(
        socket,
        session,
        clock,
        audio_rx,
        stop_rx,
        |event| emit_transcript(app, session_id, track, clock, last_final_end_ms, event),
        FINALIZE_TIMEOUT,
    )
    .await
}

fn connection_request(
    session: &RealtimeSession,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, &'static str> {
    let endpoint =
        url::Url::parse(&session.websocket_url).map_err(|_| "invalid provider endpoint")?;
    if endpoint.scheme() != "wss"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err("provider endpoint must use wss without embedded credentials");
    }
    let scheme = match session.provider.as_str() {
        "openai" => "Bearer",
        "google" => {
            if endpoint.query().is_some() || endpoint.fragment().is_some() {
                return Err("Google endpoint must not contain a query or fragment");
            }
            if session.sample_rate != google::SAMPLE_RATE || session.audio_format != "audio/pcm" {
                return Err("Google transcription requires mono PCM16 at 16000 Hz");
            }
            "Token"
        }
        _ => return Err("unsupported transcription provider"),
    };
    let mut request = session
        .websocket_url
        .as_str()
        .into_client_request()
        .map_err(|_| "invalid provider endpoint")?;
    let mut authorization = format!("{scheme} {}", session.client_secret)
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
        .map_err(|_| "credential is not a valid header value")?;
    authorization.set_sensitive(true);
    request.headers_mut().insert("Authorization", authorization);
    Ok(request)
}

async fn stream_connected<S, F>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    session: &RealtimeSession,
    clock: &TrackClock,
    audio_rx: &mut mpsc::Receiver<Vec<i16>>,
    stop_rx: &mut oneshot::Receiver<()>,
    mut emit_event: F,
    finalize_timeout: Duration,
) -> Outcome
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: FnMut(Interpreted),
{
    let (mut write, mut read) = socket.split();

    // Declare what we are actually going to send. The backend already configured the session when
    // it minted the credential; this repeats it from the side that knows the truth about the
    // audio, so the two can never disagree about the sample rate.
    let update = session_update_payload(session);
    if let Err(e) = write.send(Message::Text(update.into())).await {
        return lost(format!("could not configure the session: {}", e));
    }

    // Set by the first transcript event this connection delivers. A session that spoke is a
    // session that worked, and `run` uses that to tell one bad night from a run of refusals.
    let mut progressed = false;
    let mut decoder = TranscriptDecoder::default();
    let mut turn = AudioTurn::default();
    let mut manual_commits = true;
    let mut pending_commits = 0usize;
    let mut finishing = false;
    let mut input_finished = false;
    let deadline = tokio::time::sleep(finalize_timeout);
    tokio::pin!(deadline);

    loop {
        if input_finished && pending_commits == 0 && !decoder.has_pending() {
            let _ = write.send(Message::Close(None)).await;
            return Outcome::Stopped;
        }
        tokio::select! {
            _ = &mut *stop_rx, if !finishing => {
                finishing = true;
                audio_rx.close();
                deadline.as_mut().reset(tokio::time::Instant::now() + finalize_timeout);
            }
            _ = &mut deadline, if finishing => {
                let message = "Timed out waiting for the final transcript. The last words may be missing.".to_string();
                emit_event(Interpreted::Failure(message.clone()));
                let _ = write.send(Message::Close(None)).await;
                return Outcome::FinalizationFailed(message);
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            match value["type"].as_str().unwrap_or("") {
                                "session.created" | "session.updated" => {
                                    if let Some(input) = value.pointer("/session/audio/input") {
                                        manual_commits = input.get("turn_detection").is_none_or(|v| v.is_null());
                                    }
                                }
                                "input_audio_buffer.committed" if !manual_commits => turn = AudioTurn::default(),
                                "conversation.item.input_audio_transcription.completed" |
                                "conversation.item.input_audio_transcription.failed" => {
                                    pending_commits = pending_commits.saturating_sub(1);
                                }
                                _ => {}
                            }
                        }
                        for event in decoder.interpret(&text) {
                            if matches!(event, Interpreted::Partial(_) | Interpreted::Final(_)) {
                                progressed = true;
                            }
                            emit_event(event);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        if finishing {
                            let message = "The provider closed before the final transcript arrived.".to_string();
                            emit_event(Interpreted::Failure(message.clone()));
                            return Outcome::FinalizationFailed(message);
                        }
                        return Outcome::Lost {
                            reason: "the provider closed the connection".to_string(),
                            progressed,
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        if finishing {
                            return Outcome::FinalizationFailed(format!("Transcription connection failed during finalization: {e}"));
                        }
                        return Outcome::Lost {
                            reason: format!("socket error: {}", e),
                            progressed,
                        }
                    }
                }
            }
            chunk = audio_rx.recv(), if !input_finished => {
                match chunk {
                    Some(samples) if samples.is_empty() => {}
                    Some(samples) => {
                        clock.advance(samples.len());
                        let payload = append_payload(&samples);
                        if let Err(e) = write.send(Message::Text(payload.into())).await {
                            if finishing {
                                return Outcome::FinalizationFailed(format!("Could not flush the final audio: {e}"));
                            }
                            return Outcome::Lost {
                                reason: format!("could not send audio: {}", e),
                                progressed,
                            };
                        }
                        if turn.push(&samples) && manual_commits {
                            if let Err(e) = write.send(Message::Text(commit_payload().into())).await {
                                if finishing {
                                    return Outcome::FinalizationFailed(format!("Could not commit the final audio: {e}"));
                                }
                                return Outcome::Lost { reason: format!("could not commit audio: {e}"), progressed };
                            }
                            turn = AudioTurn::default();
                            pending_commits += 1;
                        }
                    }
                    // Drain queued capture audio, commit even a trailing short turn, then wait for
                    // completed events. Closing immediately here discards the last spoken words.
                    None => {
                        if !finishing {
                            finishing = true;
                            deadline.as_mut().reset(tokio::time::Instant::now() + finalize_timeout);
                        }
                        input_finished = true;
                        if turn.samples > 0 {
                            let padding = MIN_COMMIT_SAMPLES.saturating_sub(turn.samples);
                            if padding > 0 {
                                let _ = write.send(Message::Text(append_payload(&vec![0; padding]).into())).await;
                            }
                            if let Err(e) = write.send(Message::Text(commit_payload().into())).await {
                                let message = format!("Could not finalize the transcription: {e}");
                                emit_event(Interpreted::Failure(message.clone()));
                                return Outcome::FinalizationFailed(message);
                            }
                            turn = AudioTurn::default();
                            pending_commits += 1;
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// Provider protocol (pure, and therefore tested)
// ============================================================================

const MIN_COMMIT_SAMPLES: usize = TARGET_SAMPLE_RATE as usize / 10;
const PAUSE_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 7 / 10;
const MAX_TURN_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 15;

#[derive(Default)]
struct AudioTurn {
    samples: usize,
    silence: usize,
    heard_speech: bool,
}

impl AudioTurn {
    fn push(&mut self, samples: &[i16]) -> bool {
        self.samples += samples.len();
        // A conservative energy threshold closes ordinary speech pauses. The duration cap also
        // commits quiet speech and continuous background noise instead of buffering indefinitely.
        let energy: f64 = samples.iter().map(|s| (*s as f64).powi(2)).sum();
        if !samples.is_empty() && energy / samples.len() as f64 >= 200.0_f64.powi(2) {
            self.heard_speech = true;
            self.silence = 0;
        } else {
            self.silence += samples.len();
        }
        self.samples >= MAX_TURN_SAMPLES
            || (self.heard_speech
                && self.silence >= PAUSE_SAMPLES
                && self.samples >= MIN_COMMIT_SAMPLES)
    }
}

fn commit_payload() -> &'static str {
    r#"{"type":"input_audio_buffer.commit"}"#
}

/// What one provider event means to us. Anything not listed here is deliberately ignored — the
/// realtime protocol emits a great deal that a transcription client has no use for.
#[derive(Debug, PartialEq)]
enum Interpreted {
    Partial(String),
    Final(String),
    Failure(String),
}

/// `session.update` describing the audio this client actually produces.
///
/// The backend already configured the session when it minted the credential. This repeats the
/// audio half from the side that knows the truth about it, so a stale `nora.stt.openai.sample-rate`
/// on the server cannot make the provider play our PCM at the wrong speed.
///
/// It does not override `turn_detection`. The connection reads the effective server setting and
/// commits locally only when server VAD is off.
fn session_update_payload(session: &RealtimeSession) -> String {
    let mut transcription = serde_json::json!({ "model": session.model });
    if !session.language.is_empty() {
        if session.model.starts_with("gpt-live-transcribe") {
            transcription["languages"] = serde_json::json!([session.language]);
        } else {
            transcription["language"] = serde_json::json!(session.language);
        }
    }
    serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": session.audio_format, "rate": TARGET_SAMPLE_RATE },
                    "transcription": transcription,
                }
            }
        },
    })
    .to_string()
}

/// One chunk of PCM as the provider's append event: base64 of little-endian i16.
fn append_payload(samples: &[i16]) -> String {
    serde_json::json!({
        "type": "input_audio_buffer.append",
        "audio": encode_pcm16(samples),
    })
    .to_string()
}

/// i16 mono → little-endian bytes → base64. The provider reads PCM16 LE; getting the byte order
/// wrong produces loud noise rather than an error, which is exactly the class of bug the
/// resampler's tone tests exist for.
fn encode_pcm16(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

/// Deltas are incremental, while the UI expects the complete partial for a track. Completions
/// may arrive out of order, so keep each item until earlier committed items have finished.
#[derive(Default)]
struct TranscriptDecoder {
    partials: HashMap<String, String>,
    order: VecDeque<String>,
    completed: HashMap<String, String>,
}

impl TranscriptDecoder {
    fn has_pending(&self) -> bool {
        !self.order.is_empty()
    }

    fn remember(&mut self, id: &str) {
        if !self.order.iter().any(|existing| existing == id) {
            self.order.push_back(id.to_string());
        }
    }

    fn finish(&mut self, id: &str, text: String) -> Vec<Interpreted> {
        self.remember(id);
        self.partials.remove(id);
        self.completed.insert(id.to_string(), text);
        let mut events = Vec::new();
        while let Some(id) = self.order.front() {
            let Some(text) = self.completed.remove(id) else {
                break;
            };
            self.order.pop_front();
            if !text.trim().is_empty() {
                events.push(Interpreted::Final(text.trim().to_string()));
            }
        }
        events
    }

    fn interpret(&mut self, text: &str) -> Vec<Interpreted> {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return Vec::new();
        };
        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let id = value
            .get("item_id")
            .and_then(|v| v.as_str())
            .unwrap_or("current");

        match kind {
            "input_audio_buffer.committed" => {
                self.remember(id);
                Vec::new()
            }
            "conversation.item.input_audio_transcription.delta" => {
                let delta = value.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if delta.is_empty() {
                    Vec::new()
                } else {
                    self.remember(id);
                    let partial = self.partials.entry(id.to_string()).or_default();
                    partial.push_str(delta);
                    vec![Interpreted::Partial(partial.clone())]
                }
            }
            "conversation.item.input_audio_transcription.completed" => {
                let full = value
                    .get("transcript")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                self.finish(id, full.to_string())
            }
            // The provider's own failure frame. Surfaced rather than swallowed: a session that is
            // rejecting our audio otherwise looks exactly like a silent room.
            "error" | "conversation.item.input_audio_transcription.failed" => {
                let message = value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("the transcription provider reported an error");
                let mut events = vec![Interpreted::Failure(message.to_string())];
                if kind == "conversation.item.input_audio_transcription.failed" {
                    events.extend(self.finish(id, String::new()));
                }
                events
            }
            _ => Vec::new(),
        }
    }
}

// ============================================================================
// Emission
// ============================================================================

fn emit_transcript(
    app: &AppHandle,
    session_id: &str,
    track: &str,
    clock: &TrackClock,
    last_final_end_ms: &mut u64,
    event: Interpreted,
) {
    match event {
        Interpreted::Partial(text) => {
            // A partial always reports the start of the uncommitted stretch, never a position
            // inside it: the front overwrites `partials[track]`, so revision is expected, and an
            // offset that crept forward with each delta would scatter one utterance across the
            // timeline.
            emit(
                app,
                TranscriptEvent {
                    session_id: session_id.to_string(),
                    track: track.to_string(),
                    speaker_id: speaker_id_for_track(track),
                    text,
                    is_final: false,
                    offset_ms: *last_final_end_ms,
                    duration_ms: None,
                    confidence: None,
                },
            );
        }
        Interpreted::Final(text) => {
            let offset = *last_final_end_ms;
            // `max` rather than a bare assignment: the clock is read from another task, and the
            // invariant is worth more than the arithmetic.
            let end = clock.now_ms().max(offset);
            *last_final_end_ms = end;
            emit(
                app,
                TranscriptEvent {
                    session_id: session_id.to_string(),
                    track: track.to_string(),
                    speaker_id: speaker_id_for_track(track),
                    text,
                    is_final: true,
                    offset_ms: offset,
                    duration_ms: Some(end - offset),
                    // ALWAYS none. ADR 0035 refused to publish an uncalibrated number in a field
                    // that used to be calibrated, and ADR 0039 §"What comes back" carries that
                    // forward: the vendor changed, the reasoning did not.
                    confidence: None,
                },
            );
        }
        Interpreted::Failure(message) => {
            emit_error(app, session_id, track, "STT_PROVIDER_ERROR", &message);
        }
    }
}

fn emit(app: &AppHandle, event: TranscriptEvent) {
    let _ = app.emit("transcript", &event);
}

/// Same envelope the local engine used, so the overlay's listener needs no change.
fn emit_error(app: &AppHandle, session_id: &str, track: &str, code: &str, message: &str) {
    eprintln!("[stt_cloud] track={} {}: {}", track, code, message);
    let _ = app.emit(
        "stt-error",
        &serde_json::json!({
            "v": 1,
            "type": "error",
            "session_id": session_id,
            "code": code,
            "message": message,
        }),
    );
}

fn emit_gave_up(app: &AppHandle, session_id: &str, track: &str) {
    emit_error(
        app,
        session_id,
        track,
        "STT_SESSION_ENDED",
        "Transcription stopped after several failed reconnection attempts. The recording \
         continues, but no new text will appear.",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interpret(text: &str) -> Vec<Interpreted> {
        TranscriptDecoder::default().interpret(text)
    }

    #[test]
    fn pcm16_is_encoded_little_endian() {
        // 0x0102 little-endian is 0x02 0x01; a big-endian encoder yields a different string, and
        // the provider would hear noise rather than refuse the frame.
        let encoded = encode_pcm16(&[0x0102, -2]);
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(raw, vec![0x02, 0x01, 0xFE, 0xFF]);
    }

    #[test]
    fn the_append_frame_carries_the_audio_as_base64() {
        let payload: serde_json::Value = serde_json::from_str(&append_payload(&[1, 2, 3])).unwrap();
        assert_eq!(payload["type"], "input_audio_buffer.append");
        assert_eq!(payload["audio"], encode_pcm16(&[1, 2, 3]));
    }

    /// The client declares the rate it actually produces, not the one the server guessed. This is
    /// what keeps a stale `nora.stt.openai.sample-rate` from turning the meeting into gibberish.
    #[test]
    fn session_update_declares_the_rate_this_client_really_sends() {
        let session = test_session(16_000);
        let payload: serde_json::Value =
            serde_json::from_str(&session_update_payload(&session)).unwrap();
        let input = &payload["session"]["audio"]["input"];

        assert_eq!(payload["type"], "session.update");
        assert_eq!(payload["session"]["type"], "transcription");
        assert_eq!(input["format"]["rate"], TARGET_SAMPLE_RATE);
        assert_eq!(input["format"]["type"], "audio/pcm");
        assert_eq!(input["transcription"]["model"], "gpt-live-transcribe");
        assert_eq!(
            input["transcription"]["languages"],
            serde_json::json!(["pt"])
        );
        assert!(input["transcription"].get("language").is_none());
        assert!(
            input.get("turn_detection").is_none(),
            "turn detection belongs to the server that minted the session"
        );
    }

    #[test]
    fn legacy_models_keep_the_singular_language() {
        let mut session = test_session(TARGET_SAMPLE_RATE);
        session.model = "gpt-4o-mini-transcribe".to_string();
        let payload: serde_json::Value =
            serde_json::from_str(&session_update_payload(&session)).unwrap();
        let transcription = &payload["session"]["audio"]["input"]["transcription"];
        assert_eq!(transcription["language"], "pt");
        assert!(transcription.get("languages").is_none());
    }

    #[test]
    fn partials_accumulate_per_item_and_completed_turns_keep_audio_order() {
        let mut decoder = TranscriptDecoder::default();
        assert_eq!(decoder.interpret(r#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"a","delta":"Good "}"#), vec![Interpreted::Partial("Good ".to_string())]);
        assert_eq!(decoder.interpret(r#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"a","delta":"morning"}"#), vec![Interpreted::Partial("Good morning".to_string())]);
        decoder.interpret(r#"{"type":"input_audio_buffer.committed","item_id":"a"}"#);
        decoder.interpret(r#"{"type":"input_audio_buffer.committed","item_id":"b"}"#);
        assert!(decoder.interpret(r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"b","transcript":"Second turn"}"#).is_empty());
        assert_eq!(decoder.interpret(r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"a","transcript":"Good morning"}"#), vec![Interpreted::Final("Good morning".to_string()), Interpreted::Final("Second turn".to_string())]);
        assert!(!decoder.has_pending());
    }

    #[test]
    fn silent_completed_items_do_not_block_later_transcripts() {
        let mut decoder = TranscriptDecoder::default();
        decoder.interpret(r#"{"type":"input_audio_buffer.committed","item_id":"a"}"#);
        decoder.interpret(r#"{"type":"input_audio_buffer.committed","item_id":"b"}"#);
        decoder.interpret(r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"b","transcript":"Speech"}"#);
        assert_eq!(decoder.interpret(r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"a","transcript":""}"#), vec![Interpreted::Final("Speech".to_string())]);
        assert!(!decoder.has_pending());
    }

    #[test]
    fn audio_turns_commit_on_pauses_and_bound_quiet_or_continuous_audio() {
        let chunk = TARGET_SAMPLE_RATE as usize / 10;
        let mut turn = AudioTurn::default();
        assert!(!turn.push(&vec![1_000; chunk]));
        for _ in 0..6 {
            assert!(!turn.push(&vec![0; chunk]));
        }
        assert!(turn.push(&vec![0; chunk]));
        for level in [0, 1_000] {
            let mut turn = AudioTurn::default();
            for _ in 0..149 {
                assert!(!turn.push(&vec![level; chunk]));
            }
            assert!(turn.push(&vec![level; chunk]));
        }
    }

    #[tokio::test]
    async fn stop_drains_audio_commits_and_waits_for_the_final_transcript() {
        use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};
        let (client_io, server_io) = tokio::io::duplex(65_536);
        let client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        let provider = tokio::spawn(async move {
            let mut audio_bytes = 0;
            while let Some(Ok(Message::Text(text))) = server.next().await {
                let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                match frame["type"].as_str().unwrap() {
                    "input_audio_buffer.append" => {
                        let decoded = base64::engine::general_purpose::STANDARD
                            .decode(frame["audio"].as_str().unwrap())
                            .unwrap();
                        assert!(!decoded.is_empty(), "empty PCM must not reach the provider");
                        audio_bytes += decoded.len();
                    }
                    "input_audio_buffer.commit" => {
                        assert_eq!(audio_bytes, MIN_COMMIT_SAMPLES * 2);
                        server
                            .send(Message::Text(
                                r#"{"type":"input_audio_buffer.committed","item_id":"last"}"#
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        server.send(Message::Text(r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"last","transcript":"Final words"}"#.into())).await.unwrap();
                        return;
                    }
                    _ => {}
                }
            }
            panic!("socket closed before the buffered audio was committed");
        });
        let (audio_tx, mut audio_rx) = mpsc::channel(10);
        audio_tx.send(Vec::new()).await.unwrap();
        audio_tx
            .send(vec![1_000; MIN_COMMIT_SAMPLES / 2])
            .await
            .unwrap();
        audio_tx.send(Vec::new()).await.unwrap();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        let mut events = Vec::new();
        let outcome = stream_connected(
            client,
            &test_session(TARGET_SAMPLE_RATE),
            &TrackClock::default(),
            &mut audio_rx,
            &mut stop_rx,
            |event| events.push(event),
            Duration::from_secs(1),
        )
        .await;
        assert!(matches!(outcome, Outcome::Stopped));
        assert_eq!(events, vec![Interpreted::Final("Final words".to_string())]);
        provider.await.unwrap();
    }

    #[tokio::test]
    async fn empty_audio_chunks_do_not_append_or_commit_a_turn() {
        use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};
        let (client_io, server_io) = tokio::io::duplex(65_536);
        let client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        let provider = tokio::spawn(async move {
            let mut frame_types = Vec::new();
            while let Some(Ok(frame)) = server.next().await {
                match frame {
                    Message::Text(text) => {
                        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                        frame_types.push(frame["type"].as_str().unwrap().to_string());
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            frame_types
        });
        let (audio_tx, mut audio_rx) = mpsc::channel(10);
        audio_tx.send(Vec::new()).await.unwrap();
        audio_tx.send(Vec::new()).await.unwrap();
        drop(audio_tx);
        let (_stop_tx, mut stop_rx) = oneshot::channel();
        let clock = TrackClock::default();
        let mut events = Vec::new();
        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            stream_connected(
                client,
                &test_session(TARGET_SAMPLE_RATE),
                &clock,
                &mut audio_rx,
                &mut stop_rx,
                |event| events.push(event),
                Duration::from_millis(25),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Outcome::Stopped));
        assert_eq!(clock.now_ms(), 0);
        assert!(events.is_empty());
        assert_eq!(provider.await.unwrap(), vec!["session.update"]);
    }

    #[tokio::test]
    async fn stop_has_a_deadline_when_the_provider_never_finishes() {
        use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};
        let (client_io, server_io) = tokio::io::duplex(65_536);
        let client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let _server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        let (audio_tx, mut audio_rx) = mpsc::channel(10);
        audio_tx
            .send(vec![1_000; MIN_COMMIT_SAMPLES])
            .await
            .unwrap();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        let mut events = Vec::new();
        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            stream_connected(
                client,
                &test_session(TARGET_SAMPLE_RATE),
                &TrackClock::default(),
                &mut audio_rx,
                &mut stop_rx,
                |event| events.push(event),
                Duration::from_millis(25),
            ),
        )
        .await
        .unwrap();
        assert!(
            matches!(outcome, Outcome::FinalizationFailed(message) if message.contains("Timed out"))
        );
        assert!(events.iter().any(
            |event| matches!(event, Interpreted::Failure(message) if message.contains("Timed out"))
        ));
    }

    #[test]
    fn a_delta_is_a_partial_and_a_completed_is_a_final() {
        let delta =
            r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"bom "}"#;
        assert_eq!(
            interpret(delta),
            vec![Interpreted::Partial("bom ".to_string())]
        );

        let done = r#"{"type":"conversation.item.input_audio_transcription.completed",
                       "transcript":"  bom dia  "}"#;
        assert_eq!(
            interpret(done),
            vec![Interpreted::Final("bom dia".to_string())]
        );
    }

    #[test]
    fn empty_text_produces_no_event_at_all() {
        let delta = r#"{"type":"conversation.item.input_audio_transcription.delta","delta":""}"#;
        assert!(interpret(delta).is_empty());

        let done = r#"{"type":"conversation.item.input_audio_transcription.completed",
                       "transcript":"   "}"#;
        assert!(interpret(done).is_empty());
    }

    /// A session that is rejecting our audio otherwise looks exactly like a silent room.
    #[test]
    fn a_provider_error_frame_becomes_a_failure() {
        let frame = r#"{"type":"error","error":{"message":"invalid_audio_format"}}"#;
        assert_eq!(
            interpret(frame),
            vec![Interpreted::Failure("invalid_audio_format".to_string())]
        );
    }

    #[test]
    fn unknown_and_malformed_frames_are_ignored_rather_than_fatal() {
        assert!(interpret(r#"{"type":"input_audio_buffer.speech_started"}"#).is_empty());
        assert!(interpret("not json at all").is_empty());
        assert!(interpret("{}").is_empty());
    }

    /// The invariant of `stt.rs`: offsets never go backwards, whatever the clock says.
    #[test]
    fn the_track_clock_is_monotonic_across_a_gap() {
        let clock = TrackClock::default();
        clock.advance(TARGET_SAMPLE_RATE as usize); // one second of audio
        assert_eq!(clock.now_ms(), 1_000);

        // The gap: audio arrives while the socket is down and is discarded, but counted.
        clock.advance(TARGET_SAMPLE_RATE as usize * 2);
        assert_eq!(clock.now_ms(), 3_000);
    }

    /// A final whose clock has not moved must not produce a negative duration or a regressed
    /// offset. `max` is what makes this true, and this test is why it is not a bare assignment.
    #[test]
    fn a_final_never_regresses_the_offset() {
        let clock = TrackClock::default();
        let mut last_final_end_ms = 5_000u64;

        let offset = last_final_end_ms;
        let end = clock.now_ms().max(offset);
        last_final_end_ms = end;

        assert_eq!(offset, 5_000);
        assert_eq!(end, 5_000);
        assert_eq!(last_final_end_ms, 5_000);
    }

    /// The two-hour meeting on a flaky link: every drop is preceded by a connection that
    /// delivered transcript. Those are isolated failures, not a run of them, and the track must
    /// still be transcribing after far more than `MAX_CONSECUTIVE_FAILURES` of them.
    #[test]
    fn drops_spread_between_working_sessions_never_exhaust_the_budget() {
        let mut failures = 0u32;
        for drop_number in 1..=20 {
            failures = record_failure(failures, true);
            assert!(
                failures < MAX_CONSECUTIVE_FAILURES,
                "gave up after {} spaced drops — the counter is cumulative again",
                drop_number
            );
        }
    }

    /// The other half of the same semantics: nothing came back between the attempts, so the
    /// bound still fires. This is the loop the bound exists for.
    #[test]
    fn a_run_of_failures_with_nothing_in_between_still_gives_up() {
        let mut failures = 0u32;
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            failures = record_failure(failures, false);
        }
        assert_eq!(failures, MAX_CONSECUTIVE_FAILURES);
    }

    /// A working session resets the count that came before it rather than merely pausing it.
    #[test]
    fn a_working_session_wipes_the_failures_that_preceded_it() {
        let mut failures = 0u32;
        failures = record_failure(failures, false);
        failures = record_failure(failures, false);
        failures = record_failure(failures, false);
        assert_eq!(failures, 3);

        // The fourth attempt connects and transcribes before dropping.
        failures = record_failure(failures, true);
        assert_eq!(
            failures, 1,
            "the run before the working session must not carry over"
        );
    }

    fn test_session(sample_rate: u32) -> RealtimeSession {
        RealtimeSession {
            client_secret: "ek_test".to_string(),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
            websocket_url: "wss://provider.example/realtime".to_string(),
            provider: "openai".to_string(),
            model: "gpt-live-transcribe".to_string(),
            language: "pt".to_string(),
            audio_format: "audio/pcm".to_string(),
            sample_rate,
        }
    }

    #[test]
    fn provider_authentication_uses_sensitive_headers_without_query_credentials() {
        let openai = test_session(TARGET_SAMPLE_RATE);
        let request = connection_request(&openai).unwrap();
        assert_eq!(request.headers()["Authorization"], "Bearer ek_test");
        assert!(request.headers()["Authorization"].is_sensitive());

        let mut google = test_session(16_000);
        google.provider = "google".to_string();
        let request = connection_request(&google).unwrap();
        assert_eq!(request.headers()["Authorization"], "Token ek_test");
        assert!(request.headers()["Authorization"].is_sensitive());
        assert!(request.uri().query().is_none());
        assert!(!format!("{request:?}").contains("ek_test"));

        google.websocket_url.push_str("?access_token=secret");
        assert!(connection_request(&google).is_err());
    }

    #[test]
    fn unsupported_providers_and_mismatched_google_audio_fail_before_connecting() {
        let mut session = test_session(TARGET_SAMPLE_RATE);
        session.provider = "unknown".to_string();
        assert_eq!(
            connection_request(&session).unwrap_err(),
            "unsupported transcription provider"
        );
        session.provider = "google".to_string();
        assert!(connection_request(&session).is_err());
        session.sample_rate = 16_000;
        assert!(connection_request(&session).is_ok());
        session.audio_format = "audio/wav".to_string();
        assert!(connection_request(&session).is_err());
    }
}
