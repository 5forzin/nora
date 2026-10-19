use std::collections::VecDeque;
use std::time::Duration;

use audioadapter_buffers::owned::InterleavedOwned;
use futures_util::{SinkExt, StreamExt};
use rubato::{Fft, FixedSync, Resampler};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::{encode_pcm16, lost, Interpreted, Outcome, TrackClock};
use crate::stt::TARGET_SAMPLE_RATE;
use crate::stt_token::RealtimeSession;

pub(super) const SAMPLE_RATE: u32 = 16_000;
pub(super) const INACTIVITY_TIMEOUT: Duration = Duration::from_millis(700);
const SETUP_TIMEOUT: Duration = Duration::from_secs(8);
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const CHUNK_SAMPLES: usize = SAMPLE_RATE as usize / 10;
const SETUP_BUFFER_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * SETUP_TIMEOUT.as_secs() as usize;

fn setup_payload(session: &RealtimeSession) -> String {
    let model = if session.model.starts_with("models/") {
        session.model.clone()
    } else {
        format!("models/{}", session.model)
    };
    serde_json::json!({
        "setup": {
            "model": model,
            "generationConfig": { "responseModalities": ["TEXT"] },
            "inputAudioTranscription": { "languageCodes": [session.language] },
        }
    })
    .to_string()
}

fn audio_payload(samples: &[i16]) -> String {
    serde_json::json!({
        "realtimeInput": {
            "audio": {
                "data": encode_pcm16(samples),
                "mimeType": "audio/pcm;rate=16000",
            }
        }
    })
    .to_string()
}

const AUDIO_END: &str = r#"{"realtimeInput":{"audioStreamEnd":true}}"#;

// Keep the capture clock at 24 kHz. Delay is removed once and the final FFT tail is
// drained, so splitting the same capture into different packets cannot change its audio.
struct PcmEncoder {
    resampler: Fft<f32>,
    input: VecDeque<f32>,
    output: VecDeque<i16>,
    delay: usize,
    received: usize,
    produced: usize,
}

impl PcmEncoder {
    fn new() -> Result<Self, String> {
        let resampler = Fft::<f32>::new(
            TARGET_SAMPLE_RATE as usize,
            SAMPLE_RATE as usize,
            TARGET_SAMPLE_RATE as usize / 50,
            1,
            FixedSync::Input,
        )
        .map_err(|_| "Could not initialize transcription audio conversion.".to_string())?;
        let delay = resampler.output_delay();
        Ok(Self {
            resampler,
            input: VecDeque::new(),
            output: VecDeque::new(),
            delay,
            received: 0,
            produced: 0,
        })
    }

    fn push(&mut self, samples: &[i16]) -> Result<Vec<Vec<i16>>, String> {
        self.received += samples.len();
        self.input
            .extend(samples.iter().map(|sample| *sample as f32 / 32768.0));
        while self.input.len() >= self.resampler.input_frames_next() {
            self.process_block()?;
        }
        Ok(self.chunks(false))
    }

    fn process_block(&mut self) -> Result<(), String> {
        let count = self.resampler.input_frames_next();
        let mut block: Vec<f32> = self.input.drain(..count.min(self.input.len())).collect();
        block.resize(count, 0.0);
        let input = InterleavedOwned::new_from(block, 1, count)
            .map_err(|_| "Could not prepare transcription audio.".to_string())?;
        let output = self
            .resampler
            .process(&input, None)
            .map_err(|_| "Could not convert transcription audio.".to_string())?
            .take_data();
        let skip = self.delay.min(output.len());
        self.delay -= skip;
        self.produced += output.len() - skip;
        self.output.extend(
            output[skip..]
                .iter()
                .map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16),
        );
        Ok(())
    }

    fn finish(&mut self) -> Result<Vec<Vec<i16>>, String> {
        let expected = self.received * SAMPLE_RATE as usize / TARGET_SAMPLE_RATE as usize;
        let already_sent = self.produced - self.output.len();
        while self.produced < expected {
            self.process_block()?;
        }
        self.output.truncate(expected - already_sent);
        Ok(self.chunks(true))
    }

    fn chunks(&mut self, include_tail: bool) -> Vec<Vec<i16>> {
        let mut chunks = Vec::new();
        while self.output.len() >= CHUNK_SAMPLES || (include_tail && !self.output.is_empty()) {
            let count = CHUNK_SAMPLES.min(self.output.len());
            chunks.push(self.output.drain(..count).collect());
        }
        chunks
    }
}

#[derive(Default)]
struct Decoded {
    setup_complete: bool,
    final_transcription: bool,
    interim: bool,
    failed: bool,
    events: Vec<Interpreted>,
}

fn decode(text: &str) -> Decoded {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Decoded::default();
    };
    if value.get("error").is_some() {
        let code = value
            .pointer("/error/code")
            .and_then(|value| value.as_u64())
            .map(|code| format!(" (code {code})"))
            .unwrap_or_default();
        return Decoded {
            failed: true,
            events: vec![Interpreted::Failure(format!(
                "The transcription provider rejected the session{code}."
            ))],
            ..Decoded::default()
        };
    }
    let mut decoded = Decoded {
        setup_complete: value.get("setupComplete").is_some(),
        ..Decoded::default()
    };
    if let Some(text) = value
        .pointer("/serverContent/interimInputTranscription/text")
        .and_then(|value| value.as_str())
    {
        if !text.trim().is_empty() {
            decoded.interim = true;
            decoded.events.push(Interpreted::Partial(text.to_string()));
        }
    }
    if let Some(text) = value
        .pointer("/serverContent/inputTranscription/text")
        .and_then(|value| value.as_str())
    {
        decoded.final_transcription = true;
        if !text.trim().is_empty() {
            decoded
                .events
                .push(Interpreted::Final(text.trim().to_string()));
        }
    }
    decoded
}

fn frame_text(message: &Message) -> Option<&str> {
    match message {
        Message::Text(text) => Some(text.as_str()),
        Message::Binary(bytes) => std::str::from_utf8(bytes).ok(),
        _ => None,
    }
}

async fn send<S>(
    write: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<S>, Message>,
    payload: String,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match tokio::time::timeout(WRITE_TIMEOUT, write.send(Message::Text(payload.into()))).await {
        Ok(Ok(())) => Ok(()),
        _ => Err("Could not send audio to the transcription provider.".to_string()),
    }
}

async fn send_audio<S>(
    write: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<S>, Message>,
    encoder: &mut PcmEncoder,
    samples: &[i16],
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    for chunk in encoder.push(samples)? {
        send(write, audio_payload(&chunk)).await?;
    }
    Ok(())
}

async fn end_audio<S>(
    write: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<S>, Message>,
    encoder: &mut PcmEncoder,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    for chunk in encoder.finish()? {
        send(write, audio_payload(&chunk)).await?;
    }
    send(write, AUDIO_END.to_string()).await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn stream_connected<S, F>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    session: &RealtimeSession,
    clock: &TrackClock,
    audio_rx: &mut mpsc::Receiver<Vec<i16>>,
    stop_rx: &mut oneshot::Receiver<()>,
    mut emit: F,
    finalize_timeout: Duration,
    inactivity_timeout: Duration,
) -> Outcome
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: FnMut(Interpreted),
{
    let (mut write, mut read) = socket.split();
    if send(&mut write, setup_payload(session)).await.is_err() {
        return lost("could not configure the transcription session");
    }
    let mut encoder = match PcmEncoder::new() {
        Ok(encoder) => encoder,
        Err(message) => return lost(message),
    };
    let mut ready = false;
    let mut finishing = false;
    let mut input_finished = false;
    let mut stream_active = false;
    let mut had_audio = false;
    let mut had_nonzero_audio = false;
    let mut progressed = false;
    let mut interim_pending = false;
    let mut draining = false;
    let mut last_audio_end = None;
    let mut setup_audio = Vec::new();
    let deadline = tokio::time::sleep(SETUP_TIMEOUT);
    let inactivity = tokio::time::sleep(inactivity_timeout);
    tokio::pin!(deadline, inactivity);

    loop {
        if ready && input_finished && stream_active {
            if let Err(message) = end_audio(&mut write, &mut encoder).await {
                return Outcome::FinalizationFailed(message);
            }
            stream_active = false;
            last_audio_end = Some(tokio::time::Instant::now());
        }
        if input_finished && !had_nonzero_audio && (ready || !had_audio) {
            let _ = write.send(Message::Close(None)).await;
            return Outcome::Stopped;
        }
        if ready && input_finished && !draining {
            draining = true;
            deadline
                .as_mut()
                .reset(last_audio_end.unwrap_or_else(tokio::time::Instant::now) + finalize_timeout);
        }
        tokio::select! {
            _ = &mut *stop_rx, if !finishing => {
                finishing = true;
                audio_rx.close();
            }
            _ = &mut deadline, if !ready || draining => {
                if !ready {
                    return if finishing {
                        Outcome::FinalizationFailed("Transcription session setup timed out before audio could be finalized.".to_string())
                    } else {
                        lost("transcription session setup timed out")
                    };
                }
                // Completion frames have no input sequence ID and transcription is independently
                // ordered. Drain the full budget after the final audio end instead of mistaking
                // a preceding utterance's generationComplete for acknowledgment of the tail.
                if input_finished && !interim_pending {
                    let _ = write.send(Message::Close(None)).await;
                    return Outcome::Stopped;
                }
                let message = "Timed out waiting for the final transcript. The last words may be missing.".to_string();
                emit(Interpreted::Failure(message.clone()));
                return Outcome::FinalizationFailed(message);
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(message)) if frame_text(&message).is_some() => {
                        let decoded = decode(frame_text(&message).unwrap());
                        if decoded.setup_complete && !ready {
                            ready = true;
                            if let Err(message) = send_audio(&mut write, &mut encoder, &setup_audio).await {
                                return if finishing { Outcome::FinalizationFailed(message) } else { lost(message) };
                            }
                            setup_audio.clear();
                            inactivity.as_mut().reset(tokio::time::Instant::now() + inactivity_timeout);
                        }
                        if decoded.interim {
                            interim_pending = true;
                        }
                        if decoded.final_transcription {
                            interim_pending = false;
                        }
                        for event in decoded.events {
                            if matches!(event, Interpreted::Partial(_) | Interpreted::Final(_)) {
                                progressed = true;
                            }
                            emit(event);
                        }
                        if decoded.failed {
                            return if finishing {
                                Outcome::FinalizationFailed("The provider rejected transcription during finalization.".to_string())
                            } else {
                                Outcome::Lost { reason: "the provider rejected transcription".to_string(), progressed }
                            };
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.map(|frame| u16::from(frame.code));
                        let reason = match code {
                            Some(code) => format!("the transcription provider closed the connection (code {code})"),
                            None => "the transcription provider closed the connection".to_string(),
                        };
                        if finishing {
                            let message = format!("Final transcription was interrupted: {reason}.");
                            emit(Interpreted::Failure(message.clone()));
                            return Outcome::FinalizationFailed(message);
                        }
                        return Outcome::Lost { reason, progressed };
                    }
                    Some(Err(_)) | None => {
                        if finishing {
                            let message = "The provider closed before transcription finalization completed.".to_string();
                            emit(Interpreted::Failure(message.clone()));
                            return Outcome::FinalizationFailed(message);
                        }
                        return Outcome::Lost { reason: "the transcription provider closed the connection".to_string(), progressed };
                    }
                    Some(Ok(_)) => {}
                }
            }
            chunk = audio_rx.recv(), if !input_finished => {
                let samples = match chunk {
                    Some(samples) if samples.is_empty() => continue,
                    Some(samples) => samples,
                    None => {
                        if !finishing {
                            finishing = true;
                        }
                        input_finished = true;
                        continue;
                    }
                };
                clock.advance(samples.len());
                had_audio = true;
                had_nonzero_audio |= samples.iter().any(|sample| *sample != 0);
                stream_active = true;
                inactivity.as_mut().reset(tokio::time::Instant::now() + inactivity_timeout);
                if !ready {
                    if setup_audio.len() + samples.len() > SETUP_BUFFER_SAMPLES {
                        let message = "Transcription setup could not keep up with captured audio.".to_string();
                        return if finishing { Outcome::FinalizationFailed(message) } else { lost(message) };
                    }
                    setup_audio.extend_from_slice(&samples);
                    continue;
                }
                if let Err(message) = send_audio(&mut write, &mut encoder, &samples).await {
                    return if finishing { Outcome::FinalizationFailed(message) } else { Outcome::Lost { reason: message, progressed } };
                }
            }
            _ = &mut inactivity, if ready && stream_active && !input_finished && !finishing => {
                // A WASAPI track can stop producing packets altogether when playback ends.
                // Explicitly flush that gap; adding synthetic transcript text would hide it.
                if let Err(message) = end_audio(&mut write, &mut encoder).await {
                    return Outcome::Lost { reason: message, progressed };
                }
                last_audio_end = Some(tokio::time::Instant::now());
                encoder = match PcmEncoder::new() {
                    Ok(encoder) => encoder,
                    Err(message) => return lost(message),
                };
                stream_active = false;
            }
        }
    }
}

#[cfg(test)]
mod tests;
