use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct LiveHighlightsStore {
    generation: u64,
    highlights: Option<LiveHighlights>,
}

impl LiveHighlightsStore {
    fn clear(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.highlights = None;
    }

    fn when_current(&mut self, generation: u64, publish: impl FnOnce(&mut Self)) -> bool {
        if generation != self.generation {
            return false;
        }
        publish(self);
        true
    }
}

pub type LiveHighlightsState = Arc<Mutex<LiveHighlightsStore>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveHighlightItem {
    pub text: String,
    pub confidence: f64,
    pub source_quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTaskItem {
    pub title: String,
    pub assignee: Option<String>,
    pub priority: String,
    pub source_quote: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveHighlights {
    pub decisions: Vec<LiveHighlightItem>,
    pub next_steps: Vec<LiveHighlightItem>,
    pub observations: Vec<LiveHighlightItem>,
    pub tasks: Vec<LiveTaskItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeLiveRequest {
    pub expected_owner: crate::auth_bridge::SessionIdentity,
    pub transcript_chunk: String,
    pub chunk_seq: u32,
    pub previous_highlights: Option<LiveHighlights>,
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeLiveResponse {
    pub chunk_seq: u32,
    pub highlights: LiveHighlights,
    pub processing_millis: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAnalysisTelemetry {
    pub chunk_seq: u32,
    pub latency_ms: u64,
    pub success: bool,
    pub items_count: usize,
}

fn authorized_live_token(
    token: Result<String, String>,
    expected_owner: &crate::auth_bridge::SessionIdentity,
) -> Result<String, String> {
    let jwt = token.map_err(|_| {
        "SESSION_UNAVAILABLE: Entre na conta original para retomar a análise ao vivo.".to_string()
    })?;
    crate::auth_bridge::ensure_session_owner(&jwt, expected_owner)?;
    Ok(jwt)
}

fn emit_analysis_error(app: &AppHandle, message: &str) {
    let _ = app.emit(
        "live-analysis-error",
        serde_json::json!({ "message": message }),
    );
}

fn report_failure(
    app: &AppHandle,
    state: &LiveHighlightsState,
    generation: u64,
    chunk_seq: u32,
    latency_ms: u64,
    message: &str,
) {
    if let Ok(mut current) = state.lock() {
        current.when_current(generation, |_| {
            emit_analysis_error(app, message);
            let _ = app.emit(
                "live-analysis-telemetry",
                &LiveAnalysisTelemetry {
                    chunk_seq,
                    latency_ms,
                    success: false,
                    items_count: 0,
                },
            );
        });
    }
}

#[tauri::command]
pub async fn analyze_live(
    window: tauri::Window,
    app_handle: AppHandle,
    state: State<'_, LiveHighlightsState>,
    request: AnalyzeLiveRequest,
) -> Result<(), String> {
    crate::commands::ensure_local_window(&window)?;
    let generation = state.lock().map_err(|e| e.to_string())?.generation;

    // Token comes from the web session (nora_access cookie in the main webview), not the keychain —
    // login now happens inside the main window that loads nora.systems.
    let access_token = match authorized_live_token(
        crate::auth_bridge::web_session_jwt(&app_handle),
        &request.expected_owner,
    ) {
        Ok(jwt) => jwt,
        Err(message) => {
            report_failure(
                &app_handle,
                &state,
                generation,
                request.chunk_seq,
                0,
                &message,
            );
            return Err(message);
        }
    };

    let backend_url = crate::api_base_url();

    let mut body = serde_json::json!({
        "transcriptChunk": request.transcript_chunk,
        "language": request.language.unwrap_or_else(|| "pt-BR".to_string()),
    });

    if let Some(prev) = &request.previous_highlights {
        match serde_json::to_value(prev) {
            Ok(value) => {
                body.as_object_mut()
                    .map(|o| o.insert("previousHighlights".to_string(), value));
            }
            Err(e) => {
                eprintln!(
                    "[live_analysis] failed to serialize previousHighlights: {}",
                    e
                );
            }
        }
    }

    // Signals the start of the analysis to the UI (overlay spinner). The end comes via
    // "live-analysis" (success) or via the telemetry with success:false (failure).
    if !state
        .lock()
        .map_err(|e| e.to_string())?
        .when_current(generation, |_| {
            let _ = app_handle.emit("live-analysis-start", request.chunk_seq);
        })
    {
        return Ok(());
    }

    let start = std::time::Instant::now();

    let result = crate::http_proxy::http_client()
        .post(format!("{}/meetings/live-analyze", backend_url))
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let latency_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(response) => {
            let status = response.status();
            if !status.is_success() {
                eprintln!("[live_analysis] worker returned {}", status);

                let message = if status.as_u16() == 401 || status.as_u16() == 403 {
                    "SESSION_UNAVAILABLE: Entre na conta original com permissão para retomar a análise ao vivo."
                } else {
                    "A análise ao vivo falhou. Tentaremos novamente; a transcrição continua."
                };
                report_failure(
                    &app_handle,
                    &state,
                    generation,
                    request.chunk_seq,
                    latency_ms,
                    message,
                );
                return Err(format!(
                    "Live analysis failed ({}): {}",
                    status.as_u16(),
                    message
                ));
            }

            let resp_body: serde_json::Value = match response.json().await {
                Ok(body) => body,
                Err(_) => {
                    let message =
                        "A análise ao vivo falhou. Tentaremos novamente; a transcrição continua.";
                    report_failure(
                        &app_handle,
                        &state,
                        generation,
                        request.chunk_seq,
                        latency_ms,
                        message,
                    );
                    return Err(message.to_string());
                }
            };

            let highlights = parse_highlights_from_response(&resp_body);

            let items_count = highlights.decisions.len()
                + highlights.next_steps.len()
                + highlights.observations.len()
                + highlights.tasks.len();

            let mut current = state.lock().map_err(|e| e.to_string())?;
            current.when_current(generation, |current| {
                current.highlights = Some(highlights.clone());
                let _ = app_handle.emit(
                    "live-analysis",
                    &AnalyzeLiveResponse {
                        chunk_seq: request.chunk_seq,
                        highlights: highlights.clone(),
                        processing_millis: latency_ms,
                    },
                );

                let _ = app_handle.emit(
                    "live-analysis-telemetry",
                    &LiveAnalysisTelemetry {
                        chunk_seq: request.chunk_seq,
                        latency_ms,
                        success: true,
                        items_count,
                    },
                );
            });

            Ok(())
        }
        Err(e) => {
            eprintln!("[live_analysis] request failed: {}", e);

            let message =
                "Sem conexão para analisar ao vivo. Tentaremos novamente; a transcrição continua.";
            report_failure(
                &app_handle,
                &state,
                generation,
                request.chunk_seq,
                latency_ms,
                message,
            );
            Err(message.to_string())
        }
    }
}

fn parse_highlights_from_response(value: &serde_json::Value) -> LiveHighlights {
    fn parse_items(val: &serde_json::Value) -> Vec<LiveHighlightItem> {
        val.as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        Some(LiveHighlightItem {
                            text: item.get("text")?.as_str()?.to_string(),
                            confidence: item.get("confidence")?.as_f64().unwrap_or(0.0),
                            source_quote: item.get("sourceQuote")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn parse_tasks(val: &serde_json::Value) -> Vec<LiveTaskItem> {
        val.as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        Some(LiveTaskItem {
                            title: item.get("title")?.as_str()?.to_string(),
                            assignee: item
                                .get("assignee")
                                .and_then(|v| v.as_str())
                                .map(String::from),
                            priority: item.get("priority")?.as_str()?.to_string(),
                            source_quote: item.get("sourceQuote")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    LiveHighlights {
        decisions: parse_items(value.get("decisions").unwrap_or(&serde_json::Value::Null)),
        next_steps: parse_items(value.get("nextSteps").unwrap_or(&serde_json::Value::Null)),
        observations: parse_items(
            value
                .get("observations")
                .unwrap_or(&serde_json::Value::Null),
        ),
        tasks: parse_tasks(value.get("tasks").unwrap_or(&serde_json::Value::Null)),
    }
}

#[tauri::command]
pub fn toggle_overlay(app_handle: AppHandle, show: bool) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("overlay") {
        if show {
            let _ = window.show();
            // Kills the DWM ghost outline (same as the dock) now that the
            // overlay is visible and has an HWND.
            #[cfg(target_os = "windows")]
            crate::windows::remove_window_border(&window);
            // Do NOT call set_focus here: it stole the focus of the foreground app
            // (Meet/Zoom). Explicit focus is handled by focus_overlay_window
            // when the user clicks to open the overlay (dock-bar). Audit #26.

            // If stealth mode is active, apply it to the overlay now that it became visible.
            // The dock goes through the same helper in `windows::toggle_dock` — it used to be
            // an inline copy here and no copy at all there (audit #10).
            #[cfg(target_os = "windows")]
            crate::stealth_mode::reapply_stealth(&app_handle, &window);
        } else {
            let _ = window.hide();
        }
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

#[tauri::command]
pub fn clear_live_highlights(
    app_handle: AppHandle,
    state: State<'_, LiveHighlightsState>,
) -> Result<(), String> {
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.clear();
        let _ = app_handle.emit("clear-highlights", ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

    fn owner() -> crate::auth_bridge::SessionIdentity {
        crate::auth_bridge::SessionIdentity {
            user_id: "11111111-1111-4111-8111-111111111111".into(),
            tenant_id: "22222222-2222-4222-8222-222222222222".into(),
        }
    }

    fn token(identity: &crate::auth_bridge::SessionIdentity) -> String {
        let payload = serde_json::json!({"sub": identity.user_id, "tenantId": identity.tenant_id});
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    }

    #[test]
    fn clearing_the_session_prevents_old_responses_and_errors_from_publishing() {
        let mut state = LiveHighlightsStore::default();
        let old_generation = state.generation;
        state.clear();
        assert!(!state.when_current(old_generation, |_| panic!("old response must not publish")));
        assert!(state.highlights.is_none());
        let current_generation = state.generation;
        let mut published = false;
        assert!(state.when_current(current_generation, |current| {
            current.highlights = Some(LiveHighlights::default());
            published = true;
        }));
        assert!(published);
        assert!(state.highlights.is_some());
    }

    #[test]
    fn live_request_requires_the_original_account() {
        let mut request =
            serde_json::json!({"transcriptChunk": "Synthetic transcript", "chunkSeq": 1});
        assert!(serde_json::from_value::<AnalyzeLiveRequest>(request.clone()).is_err());
        request["expectedOwner"] = serde_json::to_value(owner()).unwrap();
        assert!(serde_json::from_value::<AnalyzeLiveRequest>(request).is_ok());
    }

    #[test]
    fn live_authorization_returns_the_same_checked_bearer_and_refuses_account_changes() {
        let original = owner();
        let jwt = token(&original);
        assert_eq!(
            authorized_live_token(Ok(jwt.clone()), &original).unwrap(),
            jwt
        );
        let different = "33333333-3333-4333-8333-333333333333";
        for identity in [
            crate::auth_bridge::SessionIdentity {
                user_id: different.into(),
                ..original.clone()
            },
            crate::auth_bridge::SessionIdentity {
                tenant_id: different.into(),
                ..original.clone()
            },
        ] {
            assert!(authorized_live_token(Ok(token(&identity)), &original)
                .unwrap_err()
                .starts_with("ACCOUNT_MISMATCH"));
        }
        assert!(
            authorized_live_token(Err("Cookie read failed".into()), &original)
                .unwrap_err()
                .starts_with("SESSION_UNAVAILABLE")
        );
    }
}
