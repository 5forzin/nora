use super::*;
use base64::Engine as _;
use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

fn session() -> RealtimeSession {
    RealtimeSession {
        client_secret: "ephemeral_secret".to_string(),
        expires_at: "2099-01-01T00:00:00Z".to_string(),
        websocket_url: "wss://provider.example/realtime".to_string(),
        provider: "google".to_string(),
        model: "gemini-3.5-transcribe-live".to_string(),
        language: "pt-BR".to_string(),
        audio_format: "audio/pcm".to_string(),
        sample_rate: SAMPLE_RATE,
    }
}

async fn pair() -> (
    WebSocketStream<tokio::io::DuplexStream>,
    WebSocketStream<tokio::io::DuplexStream>,
) {
    let (client, server) = tokio::io::duplex(262_144);
    (
        WebSocketStream::from_raw_socket(client, Role::Client, None).await,
        WebSocketStream::from_raw_socket(server, Role::Server, None).await,
    )
}

async fn frame(server: &mut WebSocketStream<tokio::io::DuplexStream>) -> serde_json::Value {
    let Message::Text(text) = server.next().await.unwrap().unwrap() else {
        panic!("expected a JSON frame");
    };
    serde_json::from_str(&text).unwrap()
}

async fn setup(server: &mut WebSocketStream<tokio::io::DuplexStream>) {
    assert!(frame(server).await.get("setup").is_some());
    server
        .send(Message::Text(r#"{"setupComplete":{}}"#.into()))
        .await
        .unwrap();
}

async fn text(server: &mut WebSocketStream<tokio::io::DuplexStream>, value: &str) {
    server
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

#[test]
fn setup_selects_transcription_text_and_bcp47_without_the_credential() {
    let payload = setup_payload(&session());
    let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(value["setup"]["model"], "models/gemini-3.5-transcribe-live");
    assert_eq!(
        value["setup"]["generationConfig"]["responseModalities"],
        serde_json::json!(["TEXT"])
    );
    assert_eq!(
        value["setup"]["inputAudioTranscription"]["languageCodes"],
        serde_json::json!(["pt-BR"])
    );
    assert!(!payload.contains("ephemeral_secret"));
    assert!(value["setup"].get("systemInstruction").is_none());
}

#[test]
fn previews_replace_and_only_input_transcription_creates_final_text() {
    assert_eq!(
        decode(r#"{"serverContent":{"interimInputTranscription":{"text":"Good"}}}"#).events,
        vec![Interpreted::Partial("Good".to_string())]
    );
    assert_eq!(
        decode(r#"{"serverContent":{"interimInputTranscription":{"text":"Good morning"}}}"#).events,
        vec![Interpreted::Partial("Good morning".to_string())]
    );
    assert_eq!(
        decode(r#"{"serverContent":{"inputTranscription":{"text":" Good morning "}}}"#).events,
        vec![Interpreted::Final("Good morning".to_string())]
    );
    for message in [
        r#"{"serverContent":{"modelTurn":{"parts":[{"text":"Never include this"}]},"outputTranscription":{"text":"Never include this either"}}}"#,
        "not JSON",
        "{}",
    ] {
        assert!(decode(message).events.is_empty());
    }
    let failure = decode(r#"{"error":{"message":"secret and transcript"}}"#);
    assert!(failure.failed);
    assert!(!format!("{:?}", failure.events).contains("secret"));
    assert!(!format!("{:?}", failure.events).contains("and transcript"));
}

fn encode_partitioned(input: &[i16], partition: usize) -> Vec<Vec<i16>> {
    let mut encoder = PcmEncoder::new().unwrap();
    let mut output = Vec::new();
    for samples in input.chunks(partition) {
        output.extend(encoder.push(samples).unwrap());
    }
    output.extend(encoder.finish().unwrap());
    output
}

#[test]
fn resampling_preserves_tone_duration_and_tail_independently_of_packet_boundaries() {
    let input: Vec<i16> = (0..24_037)
        .map(|index| {
            ((index as f32 * 1_000.0 * std::f32::consts::TAU / 24_000.0).sin() * 12_000.0) as i16
        })
        .collect();
    let output = encode_partitioned(&input, 97);
    assert_eq!(output, encode_partitioned(&input, 2_400));
    assert!(output
        .iter()
        .take(output.len() - 1)
        .all(|chunk| chunk.len() == CHUNK_SAMPLES));
    assert!(output.last().unwrap().len() < CHUNK_SAMPLES);
    let samples: Vec<i16> = output.into_iter().flatten().collect();
    assert_eq!(samples.len(), input.len() * 2 / 3);
    let crossings = samples
        .windows(2)
        .filter(|pair| (pair[0] >= 0) != (pair[1] >= 0))
        .count();
    assert!(
        (1_950..=2_100).contains(&crossings),
        "tone pitch changed: {crossings} crossings"
    );
    assert!(samples[samples.len() - 20..]
        .iter()
        .any(|sample| sample.abs() > 1_000));
    let payload: serde_json::Value = serde_json::from_str(&audio_payload(&[0x0102, -2])).unwrap();
    assert_eq!(
        payload["realtimeInput"]["audio"]["mimeType"],
        "audio/pcm;rate=16000"
    );
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(payload["realtimeInput"]["audio"]["data"].as_str().unwrap())
            .unwrap(),
        [2, 1, 254, 255]
    );
}

#[test]
fn empty_and_very_short_input_do_not_invent_audio() {
    assert!(encode_partitioned(&[], 100).is_empty());
    for length in [2, 23, 479, 480, 481] {
        let output = encode_partitioned(&vec![0; length], 11);
        assert_eq!(output.iter().map(Vec::len).sum::<usize>(), length * 2 / 3);
        assert!(output.iter().flatten().all(|sample| *sample == 0));
    }
}

#[tokio::test]
async fn setup_acknowledgment_gates_audio_and_stop_waits_for_both_final_messages() {
    for completion_first in [false, true] {
        let (client, mut server) = pair().await;
        let provider = tokio::spawn(async move {
            assert!(frame(&mut server).await.get("setup").is_some());
            assert!(
                tokio::time::timeout(Duration::from_millis(20), server.next())
                    .await
                    .is_err()
            );
            text(&mut server, r#"{"setupComplete":{}}"#).await;
            let mut bytes = 0;
            loop {
                let message = frame(&mut server).await;
                if let Some(data) = message
                    .pointer("/realtimeInput/audio/data")
                    .and_then(|value| value.as_str())
                {
                    bytes += base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .unwrap()
                        .len();
                }
                if message.pointer("/realtimeInput/audioStreamEnd").is_some() {
                    break;
                }
            }
            assert_eq!(bytes, 2_437 * 2 / 3 * 2);
            text(
                &mut server,
                r#"{"serverContent":{"interimInputTranscription":{"text":"Final"}}}"#,
            )
            .await;
            let final_text = r#"{"serverContent":{"inputTranscription":{"text":"Final words"}}}"#;
            let completed = r#"{"serverContent":{"generationComplete":true}}"#;
            text(
                &mut server,
                if completion_first {
                    completed
                } else {
                    final_text
                },
            )
            .await;
            assert!(
                tokio::time::timeout(Duration::from_millis(20), server.next())
                    .await
                    .is_err()
            );
            text(
                &mut server,
                if completion_first {
                    final_text
                } else {
                    completed
                },
            )
            .await;
            assert!(matches!(server.next().await, Some(Ok(Message::Close(_)))));
        });
        let (audio_tx, mut audio_rx) = mpsc::channel(10);
        audio_tx.send(vec![1_000; 2_437]).await.unwrap();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        let clock = TrackClock::default();
        let mut events = Vec::new();
        let outcome = stream_connected(
            client,
            &session(),
            &clock,
            &mut audio_rx,
            &mut stop_rx,
            |event| events.push(event),
            Duration::from_secs(1),
            INACTIVITY_TIMEOUT,
        )
        .await;
        assert!(matches!(outcome, Outcome::Stopped));
        assert_eq!(clock.now_ms(), 2_437 * 1_000 / 24_000);
        assert_eq!(
            events,
            vec![
                Interpreted::Partial("Final".to_string()),
                Interpreted::Final("Final words".to_string())
            ]
        );
        provider.await.unwrap();
    }
}

#[tokio::test]
async fn missing_wasapi_packets_end_the_audio_stream_without_synthetic_transcripts() {
    let (client, mut server) = pair().await;
    let (stop_tx, mut stop_rx) = oneshot::channel();
    let provider = tokio::spawn(async move {
        setup(&mut server).await;
        let mut audio_samples = 0;
        loop {
            let message = frame(&mut server).await;
            if let Some(data) = message
                .pointer("/realtimeInput/audio/data")
                .and_then(|value| value.as_str())
            {
                audio_samples += base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap()
                    .len()
                    / 2;
            }
            if message.pointer("/realtimeInput/audioStreamEnd").is_some() {
                assert_eq!(audio_samples, 1_600);
                text(&mut server, r#"{"serverContent":{"inputTranscription":{"text":"Remote words"},"generationComplete":true}}"#).await;
                tokio::time::sleep(Duration::from_millis(10)).await;
                stop_tx.send(()).unwrap();
                assert!(matches!(server.next().await, Some(Ok(Message::Close(_)))));
                return;
            }
        }
    });
    let (audio_tx, mut audio_rx) = mpsc::channel(10);
    audio_tx.send(vec![1_000; 2_400]).await.unwrap();
    let mut events = Vec::new();
    let outcome = stream_connected(
        client,
        &session(),
        &TrackClock::default(),
        &mut audio_rx,
        &mut stop_rx,
        |event| events.push(event),
        Duration::from_secs(1),
        Duration::from_millis(20),
    )
    .await;
    assert!(matches!(outcome, Outcome::Stopped));
    assert_eq!(events, vec![Interpreted::Final("Remote words".to_string())]);
    provider.await.unwrap();
}

#[tokio::test]
async fn stop_without_audio_or_with_digital_silence_does_not_wait_for_nonexistent_text() {
    for length in [0, 2_400] {
        let (client, mut server) = pair().await;
        let provider = tokio::spawn(async move {
            if length == 0 {
                assert!(frame(&mut server).await.get("setup").is_some());
                assert!(matches!(server.next().await, Some(Ok(Message::Close(_)))));
                return;
            }
            setup(&mut server).await;
            let mut ended = false;
            while let Some(Ok(message)) = server.next().await {
                match message {
                    Message::Text(value) => {
                        let value: serde_json::Value = serde_json::from_str(&value).unwrap();
                        ended |= value.pointer("/realtimeInput/audioStreamEnd").is_some();
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            assert_eq!(ended, length > 0);
        });
        let (audio_tx, mut audio_rx) = mpsc::channel(10);
        audio_tx.send(vec![0; length]).await.unwrap();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            stream_connected(
                client,
                &session(),
                &TrackClock::default(),
                &mut audio_rx,
                &mut stop_rx,
                |_| panic!("silence emitted transcript"),
                Duration::from_secs(5),
                INACTIVITY_TIMEOUT,
            ),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Outcome::Stopped));
        provider.await.unwrap();
    }
}

#[tokio::test]
async fn pending_preview_times_out_and_provider_close_is_not_a_successful_flush() {
    for close in [false, true] {
        let (client, mut server) = pair().await;
        let provider = tokio::spawn(async move {
            setup(&mut server).await;
            loop {
                if frame(&mut server)
                    .await
                    .pointer("/realtimeInput/audioStreamEnd")
                    .is_some()
                {
                    text(
                        &mut server,
                        r#"{"serverContent":{"interimInputTranscription":{"text":"Unfinished"}}}"#,
                    )
                    .await;
                    if close {
                        server.send(Message::Close(None)).await.unwrap();
                    } else {
                        let _ = server.next().await;
                    }
                    return;
                }
            }
        });
        let (audio_tx, mut audio_rx) = mpsc::channel(10);
        audio_tx.send(vec![1_000; 2_400]).await.unwrap();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        let mut events = Vec::new();
        let outcome = stream_connected(
            client,
            &session(),
            &TrackClock::default(),
            &mut audio_rx,
            &mut stop_rx,
            |event| events.push(event),
            Duration::from_millis(50),
            INACTIVITY_TIMEOUT,
        )
        .await;
        assert!(matches!(outcome, Outcome::FinalizationFailed(_)));
        assert!(events
            .iter()
            .any(|event| matches!(event, Interpreted::Failure(_))));
        provider.await.unwrap();
    }
}

#[tokio::test]
async fn unrecognized_silence_can_finish_at_the_deadline_without_a_false_provider_error() {
    let (client, mut server) = pair().await;
    let provider = tokio::spawn(async move {
        setup(&mut server).await;
        while let Some(Ok(message)) = server.next().await {
            if matches!(message, Message::Close(_)) {
                return;
            }
        }
    });
    let (audio_tx, mut audio_rx) = mpsc::channel(10);
    audio_tx.send(vec![1; 2_400]).await.unwrap();
    drop(audio_tx);
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let outcome = stream_connected(
        client,
        &session(),
        &TrackClock::default(),
        &mut audio_rx,
        &mut stop_rx,
        |_| panic!("no text was received"),
        Duration::from_millis(30),
        INACTIVITY_TIMEOUT,
    )
    .await;
    assert!(matches!(outcome, Outcome::Stopped));
    provider.await.unwrap();
}

#[tokio::test]
async fn stopping_before_setup_acknowledgment_has_a_terminal_deadline() {
    let (client, mut server) = pair().await;
    let provider = tokio::spawn(async move {
        assert!(frame(&mut server).await.get("setup").is_some());
        assert!(!matches!(server.next().await, Some(Ok(Message::Text(_)))));
    });
    let (audio_tx, mut audio_rx) = mpsc::channel(10);
    audio_tx.send(vec![1_000; 2_400]).await.unwrap();
    let (stop_tx, mut stop_rx) = oneshot::channel();
    stop_tx.send(()).unwrap();
    let outcome = stream_connected(
        client,
        &session(),
        &TrackClock::default(),
        &mut audio_rx,
        &mut stop_rx,
        |_| panic!("audio must not be sent before setup acknowledgment"),
        Duration::from_millis(25),
        INACTIVITY_TIMEOUT,
    )
    .await;
    assert!(matches!(outcome, Outcome::FinalizationFailed(_)));
    provider.await.unwrap();
}

#[tokio::test]
async fn binary_json_and_delayed_setup_preserve_a_burst_of_wasapi_packets() {
    let (client, mut server) = pair().await;
    let provider = tokio::spawn(async move {
        assert!(frame(&mut server).await.get("setup").is_some());
        assert!(
            tokio::time::timeout(Duration::from_millis(600), server.next())
                .await
                .is_err()
        );
        server
            .send(Message::Binary(br#"{"setupComplete":{}}"#.to_vec().into()))
            .await
            .unwrap();
        let mut samples = 0;
        loop {
            let message = frame(&mut server).await;
            if let Some(data) = message
                .pointer("/realtimeInput/audio/data")
                .and_then(|value| value.as_str())
            {
                samples += base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap()
                    .len()
                    / 2;
            }
            if message.pointer("/realtimeInput/audioStreamEnd").is_some() {
                break;
            }
        }
        assert_eq!(samples, 64_000);
        for message in [
            br#"{"serverContent":{"interimInputTranscription":{"text":"Buffered"}}}"#.as_slice(),
            br#"{"serverContent":{"generationComplete":true}}"#.as_slice(),
            br#"{"serverContent":{"inputTranscription":{"text":"Buffered words"}}}"#.as_slice(),
        ] {
            server
                .send(Message::Binary(message.to_vec().into()))
                .await
                .unwrap();
        }
        assert!(matches!(server.next().await, Some(Ok(Message::Close(_)))));
    });
    let (audio_tx, mut audio_rx) = mpsc::channel(100);
    let producer = tokio::spawn(async move {
        // Four seconds of WASAPI-sized PCM arrives before the delayed setup reply.
        for _ in 0..200 {
            audio_tx
                .try_send(vec![1_000; 480])
                .expect("setup stopped draining the capture queue");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    });
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let clock = TrackClock::default();
    let mut events = Vec::new();
    let outcome = stream_connected(
        client,
        &session(),
        &clock,
        &mut audio_rx,
        &mut stop_rx,
        |event| events.push(event),
        Duration::from_millis(50),
        INACTIVITY_TIMEOUT,
    )
    .await;
    assert!(matches!(outcome, Outcome::Stopped));
    assert_eq!(clock.now_ms(), 4_000);
    assert_eq!(
        events,
        vec![
            Interpreted::Partial("Buffered".to_string()),
            Interpreted::Final("Buffered words".to_string())
        ]
    );
    producer.await.unwrap();
    provider.await.unwrap();
    assert!(frame_text(&Message::Binary(vec![0xFF].into())).is_none());
}

#[tokio::test]
async fn setup_buffer_overflow_is_explicit_instead_of_dropping_capture_audio() {
    let (client, _server) = pair().await;
    let (audio_tx, mut audio_rx) = mpsc::channel(2);
    audio_tx
        .send(vec![1_000; SETUP_BUFFER_SAMPLES + 1])
        .await
        .unwrap();
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let clock = TrackClock::default();
    let outcome = stream_connected(
        client,
        &session(),
        &clock,
        &mut audio_rx,
        &mut stop_rx,
        |_| {},
        Duration::from_secs(1),
        INACTIVITY_TIMEOUT,
    )
    .await;
    assert!(matches!(outcome, Outcome::Lost { reason, .. } if reason.contains("keep up")));
    assert_eq!(
        clock.now_ms(),
        (SETUP_BUFFER_SAMPLES as u64 + 1) * 1_000 / TARGET_SAMPLE_RATE as u64
    );
}

#[tokio::test]
async fn older_generation_completion_after_audio_end_does_not_truncate_the_last_utterance() {
    let (client, mut server) = pair().await;
    let provider = tokio::spawn(async move {
        setup(&mut server).await;
        loop {
            if frame(&mut server)
                .await
                .pointer("/realtimeInput/audioStreamEnd")
                .is_some()
            {
                break;
            }
        }
        text(&mut server, r#"{"serverContent":{"inputTranscription":{"text":"Earlier words"},"generationComplete":true}}"#).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), server.next())
                .await
                .is_err()
        );
        text(
            &mut server,
            r#"{"serverContent":{"inputTranscription":{"text":"Last words"}}}"#,
        )
        .await;
        assert!(matches!(server.next().await, Some(Ok(Message::Close(_)))));
    });
    let (audio_tx, mut audio_rx) = mpsc::channel(2);
    audio_tx.send(vec![1_000; 2_400]).await.unwrap();
    drop(audio_tx);
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let mut events = Vec::new();
    let outcome = stream_connected(
        client,
        &session(),
        &TrackClock::default(),
        &mut audio_rx,
        &mut stop_rx,
        |event| events.push(event),
        Duration::from_millis(50),
        INACTIVITY_TIMEOUT,
    )
    .await;
    assert!(matches!(outcome, Outcome::Stopped));
    assert_eq!(
        events,
        vec![
            Interpreted::Final("Earlier words".to_string()),
            Interpreted::Final("Last words".to_string())
        ]
    );
    provider.await.unwrap();
}

fn live_fixture_samples(path: &std::ffi::OsStr) -> Vec<i16> {
    let wav = std::fs::read(path).expect("Could not read the live transcription WAV fixture");
    assert!(wav.len() >= 12 && &wav[..4] == b"RIFF" && &wav[8..12] == b"WAVE");
    let mut offset = 12;
    let mut pcm = None;
    let mut matching_format = false;
    while offset + 8 <= wav.len() {
        let size = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start.checked_add(size).expect("Invalid WAV chunk length");
        assert!(end <= wav.len(), "Truncated WAV fixture");
        match &wav[offset..offset + 4] {
            b"fmt " => {
                assert!(size >= 16, "Invalid WAV audio format");
                matching_format = u16::from_le_bytes(wav[start..start + 2].try_into().unwrap())
                    == 1
                    && u16::from_le_bytes(wav[start + 2..start + 4].try_into().unwrap()) == 1
                    && u32::from_le_bytes(wav[start + 4..start + 8].try_into().unwrap())
                        == TARGET_SAMPLE_RATE
                    && u16::from_le_bytes(wav[start + 14..start + 16].try_into().unwrap()) == 16;
            }
            b"data" => pcm = Some(&wav[start..end]),
            _ => {}
        }
        offset = end + size % 2;
    }
    assert!(
        matching_format,
        "Live fixture must be mono PCM16 at 24000 Hz"
    );
    let pcm = pcm.expect("WAV fixture contains no audio");
    assert!(!pcm.is_empty() && pcm.len() % 2 == 0);
    pcm.chunks_exact(2)
        .map(|sample| i16::from_le_bytes(sample.try_into().unwrap()))
        .collect()
}

#[tokio::test]
#[ignore = "Paid provider contract check; requires explicit ephemeral-session and synthetic WAV fixture paths"]
async fn live_google_transcription_flushes_the_24k_capture_fixture() {
    let session_path = std::env::var_os("NORA_STT_LIVE_SESSION_FILE").expect(
        "Set NORA_STT_LIVE_SESSION_FILE to an ephemeral session JSON in private temporary storage",
    );
    let audio_path = std::env::var_os("NORA_STT_LIVE_AUDIO_FILE")
        .expect("Set NORA_STT_LIVE_AUDIO_FILE to the synthetic Portuguese PCM16 mono 24000 Hz WAV");
    let bytes = std::fs::read(session_path).expect("Could not read the ephemeral session file");
    let session: RealtimeSession =
        serde_json::from_slice(&bytes).expect("Could not parse the ephemeral session file");
    assert_eq!(session.provider, "google");
    assert!(
        session.is_usable(),
        "The ephemeral session opening window has expired"
    );
    let request = super::super::connection_request(&session)
        .expect("Invalid Google transcription session configuration");
    let connection = tokio::time::timeout(
        super::super::CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await;
    assert!(
        matches!(connection, Ok(Ok(_))),
        "Google transcription handshake failed"
    );
    let (socket, _) = connection.unwrap().unwrap();
    let samples = live_fixture_samples(&audio_path);
    let expected_ms = samples.len() as u64 * 1_000 / TARGET_SAMPLE_RATE as u64;
    let (audio_tx, mut audio_rx) = mpsc::channel(100);
    let (stop_tx, mut stop_rx) = oneshot::channel();
    let producer = tokio::spawn(async move {
        for chunk in samples.chunks(TARGET_SAMPLE_RATE as usize / 10) {
            if audio_tx.send(chunk.to_vec()).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = stop_tx.send(());
    });
    let clock = TrackClock::default();
    let mut events = Vec::new();
    let outcome = tokio::time::timeout(
        Duration::from_secs(45),
        stream_connected(
            socket,
            &session,
            &clock,
            &mut audio_rx,
            &mut stop_rx,
            |event| events.push(event),
            super::super::FINALIZE_TIMEOUT,
            INACTIVITY_TIMEOUT,
        ),
    )
    .await;
    audio_rx.close();
    producer.abort();
    let _ = producer.await;
    let outcome = outcome.expect("Google transcription exceeded its full fixture budget");
    let failure = match &outcome {
        Outcome::Stopped => "",
        Outcome::Lost { reason, .. } | Outcome::FinalizationFailed(reason) => reason,
    };
    assert!(
        matches!(outcome, Outcome::Stopped),
        "Google transcription failed to flush: {failure}"
    );
    assert_eq!(clock.now_ms(), expected_ms);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Interpreted::Partial(_))),
        "No live transcription preview was received"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Interpreted::Failure(_))),
        "Google reported a transcription failure"
    );
    let transcript = events
        .iter()
        .filter_map(|event| match event {
            Interpreted::Final(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    assert!(
        transcript.contains("piloto") && transcript.contains("sexta"),
        "The final transcript did not contain the synthetic fixture's expected words"
    );
}
