use crate::audio_capture::{AudioCapture, CaptureSinks, RecordingStatus};
use crate::stt::SttBackend;
use crate::SidecarState;
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub type CaptureState = Arc<Mutex<AudioCapture>>;

/// The windows whose content this repository wrote.
///
/// `main` is deliberately absent. It loads `https://nora.systems/dashboard`, so everything
/// running in it is remote content — a stored XSS, a compromised third-party script, anything a
/// corporate proxy decides to inject — and the commands below start recordings, read the log
/// directory and sign requests with the user's session. The `updater-remote` capability that
/// window carries says "Minimal scope: only updater + restart"; this is the sentence that makes
/// the claim true from the command's own side rather than trusting the ACL to be the only lock
/// on the door (audit #8). `lib.rs` already used the same `window.label()` test to decide which
/// window closing quits the app.
const LOCAL_WINDOWS: &[&str] = &["overlay", "dock"];

pub(crate) fn is_local_window(label: &str) -> bool {
    LOCAL_WINDOWS.contains(&label)
}

/// Rejects a command that did not come from one of the application's own windows.
pub fn ensure_local_window(window: &tauri::Window) -> Result<(), String> {
    if is_local_window(window.label()) {
        Ok(())
    } else {
        Err(format!(
            "command not available to the '{}' window",
            window.label()
        ))
    }
}

/// Brings up ONE STT backend for a track.
///
/// The event contract for the front end is `transcript` with a `TranscriptEvent`
/// payload, and it is what any backend has to keep emitting. There is one: the
/// cloud client, which fetches a short-lived session credential from the NORA API
/// and then streams straight to the provider (ADR 0039/0045). The `match` over
/// `SttBackendKind` that used to live here went with the enum — see `stt.rs`.
///
/// Failing here fails `start_recording`, on purpose: a recording that turns out
/// to have no transcript is worse than a record button that refuses.
async fn start_stt_backend(
    app_handle: &AppHandle,
    language: &str,
    track_label: &str,
    expected_owner: &crate::auth_bridge::SessionIdentity,
) -> Result<Box<dyn SttBackend>, String> {
    let handle = crate::stt_cloud::CloudSttHandle::start(
        app_handle.clone(),
        language.to_string(),
        track_label.to_string(),
        expected_owner.clone(),
    )
    .await?;
    Ok(Box::new(handle))
}

/// Best-effort file logger for the recording flow.
///
/// In release the binary runs with `windows_subsystem = "windows"`, no console —
/// so `eprintln!` vanishes and the user gets no signal at all when "I click
/// start and nothing happens". This function appends a line to
/// `<app_log_dir>/desktop.log` with a simple timestamp.
///
/// RULE: it can NEVER make the caller fail. Any IO/path resolution error is
/// silently ignored (the recording matters more than the log).
fn log_line(app_handle: &AppHandle, msg: &str) {
    use std::io::Write;

    // Simple relative timestamp: seconds since the UNIX epoch. We do not need
    // a formatted wall-clock — only order + delta between lines for debugging.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    // Resolve the log dir; if it fails, give up silently.
    let Ok(dir) = app_handle.path().app_log_dir() else {
        return;
    };
    // Create the dir best-effort; ignore the error (the open below will simply fail).
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("desktop.log");

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        // Ignore write error — best-effort.
        let _ = writeln!(file, "[{:.3}] {}", ts, msg);
    }
}

#[tauri::command]
pub fn list_audio_devices(window: tauri::Window) -> Result<Vec<String>, String> {
    ensure_local_window(&window)?;
    AudioCapture::list_devices()
}

/// `systemAudioDevice` used to be a field here.
///
/// The UI offered a list of output devices, this struct carried the choice, `AudioCapture::start`
/// interpolated it into the status label, and `SystemAudioCapture::start` named the parameter
/// `_source` and ignored it — the loopback records the default render endpoint and nothing else.
/// The field is gone rather than plumbed through, because the list the UI populated it from was
/// of INPUT devices: there was no correct choice for the capture to honour (audit #14). Serde
/// ignores unknown fields, so an older front end sending it still starts a recording.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    pub expected_owner: crate::auth_bridge::SessionIdentity,
    pub device_name: Option<String>,
    pub language: Option<String>,
    #[serde(default = "capture_microphone_by_default")]
    pub capture_microphone: bool,
    pub capture_system_audio: Option<bool>,
}

fn capture_microphone_by_default() -> bool {
    true
}

impl StartRecordingRequest {
    fn validate_sources(&self) -> Result<(), String> {
        if !self.capture_microphone && !self.capture_system_audio.unwrap_or(false) {
            return Err("Select at least one audio source".into());
        }
        Ok(())
    }
}

async fn stop_unused_backend(app: &AppHandle, backend: Option<Box<dyn SttBackend>>) {
    if let Some(backend) = backend {
        if let Err(error) = backend.stop().await {
            log_line(app, &format!("Unused STT session cleanup failed: {error}"));
        }
    }
}

fn take_backend_by_session_id(
    backends: &mut Vec<Box<dyn SttBackend>>,
    session_id: &str,
) -> Option<Box<dyn SttBackend>> {
    backends
        .iter()
        .position(|backend| backend.session_id() == session_id)
        .map(|index| backends.remove(index))
}

fn stop_failed_backend(app: AppHandle, state: SidecarState, session_id: &str) {
    let backend = match state.lock() {
        Ok(mut backends) => take_backend_by_session_id(&mut backends, session_id),
        Err(error) => {
            log_line(
                &app,
                &format!("Failed to lock STT sessions for cleanup: {error}"),
            );
            None
        }
    };
    if backend.is_some() {
        // This runs on the WASAPI thread. Its join must include STT finalization, so
        // a subsequent stop/save cannot finish before the last transcript arrives.
        tauri::async_runtime::block_on(stop_unused_backend(&app, backend));
    }
}

#[tauri::command]
pub async fn start_recording(
    window: tauri::Window,
    app_handle: AppHandle,
    state: State<'_, CaptureState>,
    sidecar_state: State<'_, SidecarState>,
    request: StartRecordingRequest,
) -> Result<RecordingStatus, String> {
    ensure_local_window(&window)?;
    request.validate_sources()?;

    #[cfg(debug_assertions)]
    {
        eprintln!("[commands] start_recording called");
        eprintln!("[commands] device_name: {:?}", request.device_name);
        eprintln!("[commands] language: {:?}", request.language);
        eprintln!(
            "[commands] capture_system_audio: {:?}",
            request.capture_system_audio
        );
    }

    log_line(
        &app_handle,
        &format!(
            "start_recording: begin (device={:?}, lang={:?}, microphone={}, system_audio={:?})",
            request.device_name,
            request.language,
            request.capture_microphone,
            request.capture_system_audio
        ),
    );

    let jwt = crate::auth_bridge::web_session_jwt(&app_handle)
        .map_err(|_| "SESSION_UNAVAILABLE: Entre na janela principal do NORA.".to_string())?;
    crate::auth_bridge::ensure_session_owner(&jwt, &request.expected_owner)?;
    log_line(&app_handle, "start_recording: auth ok");

    let language = request.language.unwrap_or_else(|| "pt-BR".to_string());
    let capture_system = request.capture_system_audio.unwrap_or(false);

    // One backend per track. The `mic` track is the local user; the `system` track is
    // the loopback audio (remote participants). Speaker attribution is PER
    // TRACK — see crate::stt::SYSTEM_SPEAKER_ID.
    let mut mic_sidecar = if request.capture_microphone {
        match start_stt_backend(&app_handle, &language, "mic", &request.expected_owner).await {
            Ok(s) => {
                log_line(&app_handle, "start_recording: stt mic ok");
                Some(s)
            }
            Err(e) => {
                log_line(
                    &app_handle,
                    &format!("start_recording: stt mic ERROR: {}", e),
                );
                return Err(format!("Failed to start mic sidecar: {}", e));
            }
        }
    } else {
        None
    };

    let mut system_sidecar = if capture_system {
        match start_stt_backend(&app_handle, &language, "system", &request.expected_owner).await {
            Ok(s) => {
                log_line(&app_handle, "start_recording: stt system ok");
                Some(s)
            }
            Err(e) => {
                log_line(
                    &app_handle,
                    &format!("start_recording: stt system ERROR: {}", e),
                );
                stop_unused_backend(&app_handle, mic_sidecar).await;
                return Err(format!("Failed to start system sidecar: {}", e));
            }
        }
    } else {
        None
    };

    // A detached bridge queue can still hold audio when stop closes the STT input. Capture
    // writes directly into the queue that STT drains before committing its final turn.
    let sinks = CaptureSinks {
        mic_tx: mic_sidecar.as_ref().map(|sidecar| sidecar.audio_tx()),
        system_tx: system_sidecar.as_ref().map(|sidecar| sidecar.audio_tx()),
    };
    let failed_session_id = system_sidecar
        .as_ref()
        .map(|sidecar| sidecar.session_id().to_string());
    let failure_app = app_handle.clone();
    let failure_sidecars = sidecar_state.inner().clone();

    let capture_result = (|| {
        let capture = state.lock().map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[commands] failed to lock capture state: {}", e);
            e.to_string()
        })?;
        // Stop takes the capture lock first too. Publish both resources together so a
        // concurrent stop cannot finish between starting capture and registering STT.
        let mut sidecars = sidecar_state.lock().map_err(|e| e.to_string())?;

        #[cfg(debug_assertions)]
        eprintln!("[commands] calling capture.start()...");

        let status = capture
            .start(
                app_handle.clone(),
                request.device_name.clone(),
                capture_system,
                sinks,
                move || {
                    if let Some(session_id) = failed_session_id {
                        stop_failed_backend(failure_app, failure_sidecars, &session_id);
                    }
                },
            )
            .map_err(|e| {
                #[cfg(debug_assertions)]
                eprintln!("[commands] capture.start FAILED: {}", e);
                log_line(
                    &app_handle,
                    &format!("start_recording: capture start ERROR: {}", e),
                );
                e
            })?;

        if let Some(sidecar) = mic_sidecar.take() {
            sidecars.push(sidecar);
        }
        if !AudioCapture::is_system_audio_degraded(&status, capture_system) {
            if let Some(sidecar) = system_sidecar.take() {
                sidecars.push(sidecar);
            }
        }
        Ok(status)
    })();
    let status = match capture_result {
        Ok(status) => status,
        Err(error) => {
            stop_unused_backend(&app_handle, mic_sidecar).await;
            stop_unused_backend(&app_handle, system_sidecar).await;
            return Err(error);
        }
    };

    log_line(&app_handle, "start_recording: capture start ok");

    #[cfg(debug_assertions)]
    eprintln!(
        "[commands] capture started ok - mic: {}, system: {:?}, sr: {}",
        status.mic_device, status.system_audio_device, status.sample_rate
    );

    // The system track's transcription session had to be minted BEFORE the capture: a failure
    // there must fail the whole start, while the user is still looking at the record button.
    // If the loopback then did not come up, that session would stay open for the length of the
    // meeting waiting for audio that has no producer — a paid session for a track that will
    // never speak. Close it, and let the recording continue as the mic-only one the status now
    // reports (audit #12). `AudioCapture::start` has already warned the user on "capture-error".
    stop_unused_backend(&app_handle, system_sidecar).await;

    #[cfg(debug_assertions)]
    eprintln!("[commands] start_recording returning ok");
    log_line(
        &app_handle,
        &format!(
            "start_recording: returning ok (mic={}, system={:?}, sr={})",
            status.mic_device, status.system_audio_device, status.sample_rate
        ),
    );
    Ok(status)
}

#[tauri::command]
pub async fn stop_recording(
    window: tauri::Window,
    app_handle: AppHandle,
    state: State<'_, CaptureState>,
    sidecar_state: State<'_, SidecarState>,
) -> Result<(), String> {
    ensure_local_window(&window)?;

    #[cfg(debug_assertions)]
    eprintln!("[commands] stop_recording called");

    // Detach this recording's STT before a subsequent start can publish its sessions.
    let sidecars = {
        let capture = state.lock().map_err(|e| e.to_string())?;
        capture.stop(app_handle)?;
        let mut sidecars = sidecar_state.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *sidecars)
    };
    let stops = sidecars.into_iter().map(|sidecar| {
        #[cfg(debug_assertions)]
        eprintln!(
            "[commands] stopping stt session_id={}",
            sidecar.session_id()
        );
        sidecar.stop()
    });
    for result in futures_util::future::join_all(stops).await {
        result?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_recording_status(
    window: tauri::Window,
    state: State<'_, CaptureState>,
) -> Result<RecordingStatus, String> {
    ensure_local_window(&window)?;
    let capture = state.lock().map_err(|e| e.to_string())?;
    Ok(capture.get_status())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeetingRequest {
    pub expected_owner: crate::auth_bridge::SessionIdentity,
    pub idempotency_key: String,
    pub title: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub language: Option<String>,
    pub transcript_format: String,
    pub tags: Option<Vec<String>>,
    pub participants: Option<Vec<UploadParticipant>>,
    pub file_content: String,
    pub file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadParticipant {
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeetingResponse {
    pub meeting_id: String,
    pub processing_status: String,
}

#[tauri::command]
pub fn get_session_identity(
    window: tauri::Window,
    app_handle: AppHandle,
) -> Result<crate::auth_bridge::SessionIdentity, String> {
    ensure_local_window(&window)?;
    let jwt = crate::auth_bridge::web_session_jwt(&app_handle)
        .map_err(|_| "SESSION_UNAVAILABLE: Entre na janela principal do NORA.".to_string())?;
    crate::auth_bridge::session_identity(&jwt)
}

#[tauri::command]
pub async fn upload_meeting(
    window: tauri::Window,
    app_handle: AppHandle,
    request: UploadMeetingRequest,
) -> Result<UploadMeetingResponse, String> {
    ensure_local_window(&window)?;

    let access_token = crate::auth_bridge::web_session_jwt(&app_handle)
        .map_err(|_| "SESSION_UNAVAILABLE: Entre na janela principal do NORA.".to_string())?;
    // Check the same JWT sent below, so changing the main-window login cannot redirect this upload.
    crate::auth_bridge::ensure_session_owner(&access_token, &request.expected_owner)?;
    uuid::Uuid::parse_str(&request.idempotency_key)
        .map_err(|_| "INVALID_IDEMPOTENCY_KEY: Identificador da reunião inválido.".to_string())?;

    let backend_url = crate::api_base_url();

    let metadata = serde_json::json!({
        "title": request.title,
        "startedAt": request.started_at,
        "endedAt": request.ended_at,
        "language": request.language.unwrap_or_else(|| "pt-BR".to_string()),
        "transcriptFormat": request.transcript_format,
        "tags": request.tags.unwrap_or_default(),
        "participants": request.participants.unwrap_or_default().iter().map(|p| {
            serde_json::json!({
                "displayName": p.display_name,
                "email": p.email,
            })
        }).collect::<Vec<_>>(),
    });

    let metadata_bytes = serde_json::to_vec(&metadata)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    let file_bytes = request.file_content.into_bytes();

    let form = reqwest::multipart::Form::new()
        .part(
            "metadata",
            reqwest::multipart::Part::bytes(metadata_bytes)
                .mime_str("application/json")
                .map_err(|e| e.to_string())?,
        )
        .part(
            "file",
            reqwest::multipart::Part::bytes(file_bytes)
                .file_name(request.file_name)
                .mime_str("text/plain")
                .map_err(|e| e.to_string())?,
        );

    let response = crate::http_proxy::http_client()
        .post(format!("{}/meetings", backend_url))
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Idempotency-Key", &request.idempotency_key)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {}", e))?;

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "Upload failed ({}): {}",
            status.as_u16(),
            body_text
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("Failed to parse response: {} — body: {}", e, body_text))?;

    let meeting_id = json["id"]
        .as_str()
        .ok_or_else(|| format!("Upload: backend response missing 'id': {}", body_text))?
        .to_string();
    Ok(UploadMeetingResponse {
        meeting_id,
        processing_status: json["processingStatus"]
            .as_str()
            .unwrap_or("PENDING")
            .to_string(),
    })
}

// `check_system_audio_prerequisites` used to live here and was deleted with the
// Windows-only cut. It branched three ways: the macOS arm reported whether the user had
// installed the BlackHole virtual driver and carried a `supportsScreenCaptureKit` flag for
// an integration nobody was going to write, the Linux arm reported PulseAudio, and the
// Windows arm answered a hardcoded yes — WASAPI loopback is part of the OS and needs no
// driver, no permission prompt and no user setup. Dropping the other two platforms left a
// probe whose every field was a compile-time constant, and both of its callers went at the
// same time: the overlay's "install BlackHole" notice here, and `src/pages/settings.tsx`
// with the local UI (PR #465). Bring it back if there is ever something it can answer "no"
// to.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct TestBackend {
        id: &'static str,
        stopped: Arc<AtomicBool>,
    }

    impl SttBackend for TestBackend {
        fn session_id(&self) -> &str {
            self.id
        }

        fn audio_tx(&self) -> tokio::sync::mpsc::Sender<Vec<i16>> {
            tokio::sync::mpsc::channel(1).0
        }

        fn stop(
            self: Box<Self>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>
        {
            Box::pin(async move {
                self.stopped.store(true, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn failed_system_cleanup_preserves_other_tracks_and_newer_recordings() {
        let mic_stopped = Arc::new(AtomicBool::new(false));
        let failed_stopped = Arc::new(AtomicBool::new(false));
        let newer_stopped = Arc::new(AtomicBool::new(false));
        let mut backends: Vec<Box<dyn SttBackend>> = vec![
            Box::new(TestBackend {
                id: "mic",
                stopped: mic_stopped.clone(),
            }),
            Box::new(TestBackend {
                id: "failed-system",
                stopped: failed_stopped.clone(),
            }),
            Box::new(TestBackend {
                id: "newer-system",
                stopped: newer_stopped.clone(),
            }),
        ];

        take_backend_by_session_id(&mut backends, "failed-system")
            .unwrap()
            .stop()
            .await
            .unwrap();

        assert!(failed_stopped.load(Ordering::SeqCst));
        assert!(!mic_stopped.load(Ordering::SeqCst));
        assert!(!newer_stopped.load(Ordering::SeqCst));
        assert_eq!(backends.len(), 2);
        assert!(take_backend_by_session_id(&mut backends, "failed-system").is_none());
        assert_eq!(backends.len(), 2);
    }

    #[test]
    fn older_recording_requests_keep_the_microphone_enabled() {
        let request: StartRecordingRequest = serde_json::from_value(serde_json::json!({
            "expectedOwner": test_owner(),
            "captureSystemAudio": true
        }))
        .unwrap();
        assert!(request.capture_microphone);
        assert!(request.validate_sources().is_ok());
    }

    #[test]
    fn system_only_recording_does_not_enable_the_microphone() {
        let request: StartRecordingRequest = serde_json::from_value(serde_json::json!({
            "expectedOwner": test_owner(),
            "captureMicrophone": false,
            "captureSystemAudio": true,
            "deviceName": "Unavailable microphone"
        }))
        .unwrap();
        assert!(!request.capture_microphone);
        assert_eq!(request.capture_system_audio, Some(true));
        assert!(request.validate_sources().is_ok());
    }

    #[test]
    fn recording_without_an_audio_source_is_rejected() {
        for body in [
            serde_json::json!({ "expectedOwner": test_owner(), "captureMicrophone": false }),
            serde_json::json!({ "expectedOwner": test_owner(), "captureMicrophone": false, "captureSystemAudio": false }),
        ] {
            let request: StartRecordingRequest = serde_json::from_value(body).unwrap();
            assert_eq!(
                request.validate_sources().unwrap_err(),
                "Select at least one audio source"
            );
        }
    }

    fn test_owner() -> crate::auth_bridge::SessionIdentity {
        crate::auth_bridge::SessionIdentity {
            user_id: "11111111-1111-4111-8111-111111111111".into(),
            tenant_id: "22222222-2222-4222-8222-222222222222".into(),
        }
    }

    #[test]
    fn recording_start_requires_an_explicit_owner() {
        assert!(
            serde_json::from_value::<StartRecordingRequest>(serde_json::json!({
                "captureMicrophone": true
            }))
            .is_err()
        );
    }

    /// The window that loads `https://nora.systems/dashboard` is the one window whose content
    /// this repository did not write. Everything guarded by `ensure_local_window` reaches the
    /// Credential Manager, the user's session or the recording, so the answer for `main` has to
    /// stay no even if the ACL in front of it ever changes (audit #8).
    #[test]
    fn the_remote_window_is_not_a_local_one() {
        assert!(!is_local_window("main"));
    }

    /// The two windows the dock and the overlay actually run in. Getting this wrong the other
    /// way is not a security hole but a dead application: every button in the product invokes
    /// from one of them.
    #[test]
    fn the_applications_own_windows_are_allowed() {
        assert!(is_local_window("overlay"));
        assert!(is_local_window("dock"));
    }

    /// A label that is not in the list at all — an unnamed webview, a window added later — is
    /// refused rather than allowed by default.
    #[test]
    fn an_unknown_label_is_refused() {
        assert!(!is_local_window(""));
        assert!(!is_local_window("overlay2"));
        assert!(!is_local_window("DOCK"));
    }
}
