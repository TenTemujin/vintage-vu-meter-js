use serde::Serialize;
use tauri::ipc::Channel;

/// One available audio render (output) device.
#[derive(Clone, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

/// A single level update streamed to the frontend while capturing.
#[derive(Clone, Serialize)]
pub struct LevelPayload {
    pub db: f32,
}

#[cfg(windows)]
mod backend {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use tauri::ipc::Channel;
    use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode};

    use super::{DeviceInfo, LevelPayload};

    const MIN_DB: f32 = -60.0;

    pub struct CaptureHandle {
        stop_flag: Arc<AtomicBool>,
        join_handle: JoinHandle<()>,
    }

    #[derive(Default)]
    pub struct AudioState(pub std::sync::Mutex<Option<CaptureHandle>>);

    pub fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
        let _ = initialize_mta();
        let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;

        let default_id = enumerator
            .get_default_device(&Direction::Render)
            .and_then(|d| d.get_id())
            .ok();

        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(|e| e.to_string())?;

        let mut devices = Vec::new();
        for device in &collection {
            let device = device.map_err(|e| e.to_string())?;
            let id = device.get_id().map_err(|e| e.to_string())?;
            let name = device.get_friendlyname().map_err(|e| e.to_string())?;
            let is_default = default_id.as_deref() == Some(id.as_str());
            devices.push(DeviceInfo { id, name, is_default });
        }
        Ok(devices)
    }

    pub fn stop_capture(state: &AudioState) -> Result<(), String> {
        if let Some(handle) = state.0.lock().unwrap().take() {
            handle.stop_flag.store(true, Ordering::Relaxed);
            let _ = handle.join_handle.join();
        }
        Ok(())
    }

    pub fn start_capture(
        state: &AudioState,
        device_id: Option<String>,
        on_event: Channel<LevelPayload>,
    ) -> Result<(), String> {
        stop_capture(state)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop_flag = stop_flag.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        let join_handle = thread::Builder::new()
            .name("vu-capture".into())
            .spawn(move || {
                if let Err(err) = capture_loop(device_id, &thread_stop_flag, &on_event, &ready_tx)
                {
                    let _ = ready_tx.send(Err(err));
                }
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {
                *state.0.lock().unwrap() = Some(CaptureHandle {
                    stop_flag,
                    join_handle,
                });
                Ok(())
            }
            Ok(Err(err)) => {
                let _ = join_handle.join();
                Err(err)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::Relaxed);
                let _ = join_handle.join();
                Err("timed out starting audio capture".to_string())
            }
        }
    }

    fn find_device(device_id: &Option<String>) -> Result<wasapi::Device, String> {
        let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
        match device_id {
            Some(id) => {
                let collection = enumerator
                    .get_device_collection(&Direction::Render)
                    .map_err(|e| e.to_string())?;
                for device in &collection {
                    let device = device.map_err(|e| e.to_string())?;
                    if device.get_id().map_err(|e| e.to_string())? == *id {
                        return Ok(device);
                    }
                }
                Err("selected audio device was not found".to_string())
            }
            None => enumerator
                .get_default_device(&Direction::Render)
                .map_err(|e| e.to_string()),
        }
    }

    /// Opens `device_id` (or the default render device) in WASAPI loopback mode and
    /// streams computed dBFS levels over `channel` until `stop_flag` is set.
    fn capture_loop(
        device_id: Option<String>,
        stop_flag: &AtomicBool,
        channel: &Channel<LevelPayload>,
        ready_tx: &mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let _ = initialize_mta();

        let device = find_device(&device_id)?;
        let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;

        // Loopback capture must use the endpoint's own mix format — WASAPI's
        // shared-mode stream converter (AUTOCONVERTPCM) is not reliably applied
        // to loopback streams, so requesting an arbitrary format (e.g. forcing
        // stereo/48kHz on a device actually running 5.1/44.1kHz, common on TV/
        // HDMI outputs) can "succeed" while silently delivering near-silent or
        // garbage samples instead of erroring.
        let mix_format = audio_client.get_mixformat().map_err(|e| e.to_string())?;
        let blockalign = mix_format.get_blockalign() as usize;
        let channels = mix_format.get_nchannels() as usize;
        let bits_per_sample = mix_format.get_bitspersample();
        let is_float = matches!(mix_format.get_subformat(), Ok(SampleType::Float));

        let (_, min_time) = audio_client.get_device_period().map_err(|e| e.to_string())?;
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_time,
        };

        // The device itself was opened from the Render collection; passing
        // Direction::Capture here is what makes wasapi-rs set AUDCLNT_STREAMFLAGS_LOOPBACK,
        // which is what actually puts a render device's client into loopback capture mode.
        audio_client
            .initialize_client(&mix_format, &Direction::Capture, &mode)
            .map_err(|e| format!("failed to open audio device for loopback: {e}"))?;

        let event_handle = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|e| e.to_string())?;
        let buffer_frame_count = audio_client.get_buffer_size().map_err(|e| e.to_string())? as usize;
        let mut sample_queue: VecDeque<u8> =
            VecDeque::with_capacity(blockalign * (buffer_frame_count * 4 + 4096));

        audio_client.start_stream().map_err(|e| e.to_string())?;
        let _ = ready_tx.send(Ok(()));

        while !stop_flag.load(Ordering::Relaxed) {
            capture_client
                .read_from_device_to_deque(&mut sample_queue)
                .map_err(|e| e.to_string())?;

            if !sample_queue.is_empty() {
                let usable_frames = sample_queue.len() / blockalign;
                let usable_bytes = usable_frames * blockalign;
                if usable_bytes > 0 {
                    let chunk: Vec<u8> = sample_queue.drain(..usable_bytes).collect();
                    if let Some(db) = level_from_pcm(&chunk, channels, bits_per_sample, is_float) {
                        let _ = channel.send(LevelPayload { db });
                    }
                }
            }

            if event_handle.wait_for_event(1000).is_err() {
                break;
            }
        }

        let _ = audio_client.stop_stream();
        Ok(())
    }

    /// Computes an RMS level in dBFS from interleaved little-endian PCM, using
    /// whatever sample layout the endpoint's mix format actually reports
    /// (almost always 32-bit float on modern Windows, but not guaranteed).
    fn level_from_pcm(bytes: &[u8], channels: usize, bits_per_sample: u16, is_float: bool) -> Option<f32> {
        let bytes_per_sample = (bits_per_sample / 8) as usize;
        let frame_bytes = bytes_per_sample * channels;
        if channels == 0 || bytes_per_sample == 0 || bytes.len() < frame_bytes {
            return None;
        }

        let mut sum_squares = 0f64;
        let mut n = 0usize;
        for frame in bytes.chunks_exact(frame_bytes) {
            for sample_bytes in frame.chunks_exact(bytes_per_sample) {
                let sample = match (is_float, bytes_per_sample) {
                    (true, 4) => f32::from_le_bytes([
                        sample_bytes[0],
                        sample_bytes[1],
                        sample_bytes[2],
                        sample_bytes[3],
                    ]) as f64,
                    (false, 2) => i16::from_le_bytes([sample_bytes[0], sample_bytes[1]]) as f64
                        / i16::MAX as f64,
                    (false, 3) => {
                        let v = ((sample_bytes[0] as i32)
                            | (sample_bytes[1] as i32) << 8
                            | (sample_bytes[2] as i32) << 16)
                            << 8
                            >> 8; // sign-extend 24-bit
                        v as f64 / (1i32 << 23) as f64
                    }
                    (false, 4) => i32::from_le_bytes([
                        sample_bytes[0],
                        sample_bytes[1],
                        sample_bytes[2],
                        sample_bytes[3],
                    ]) as f64
                        / i32::MAX as f64,
                    _ => continue,
                };
                sum_squares += sample * sample;
                n += 1;
            }
        }

        if n == 0 {
            return None;
        }

        let rms = (sum_squares / n as f64).sqrt() as f32;
        let db = if rms > 0.0 {
            (20.0 * rms.log10()).max(MIN_DB)
        } else {
            MIN_DB
        };
        Some(db)
    }
}

#[cfg(not(windows))]
mod backend {
    use tauri::ipc::Channel;

    use super::{DeviceInfo, LevelPayload};

    #[derive(Default)]
    pub struct AudioState;

    pub fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
        Err("system audio capture is only implemented on Windows".to_string())
    }

    pub fn stop_capture(_state: &AudioState) -> Result<(), String> {
        Ok(())
    }

    pub fn start_capture(
        _state: &AudioState,
        _device_id: Option<String>,
        _on_event: Channel<LevelPayload>,
    ) -> Result<(), String> {
        Err("system audio capture is only implemented on Windows".to_string())
    }
}

pub use backend::AudioState;

#[tauri::command]
pub fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
    backend::list_output_devices()
}

#[tauri::command]
pub fn start_capture(
    state: tauri::State<AudioState>,
    device_id: Option<String>,
    on_event: Channel<LevelPayload>,
) -> Result<(), String> {
    backend::start_capture(&state, device_id, on_event)
}

#[tauri::command]
pub fn stop_capture(state: tauri::State<AudioState>) -> Result<(), String> {
    backend::stop_capture(&state)
}
