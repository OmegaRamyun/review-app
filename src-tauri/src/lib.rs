mod deepgram;
mod media;

use deepgram::Word;
use media::MediaState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const KEYRING_SERVICE: &str = "app.reviewapp.desktop";
const KEYRING_USER_DEEPGRAM: &str = "deepgram";

// ---------- media ----------

#[derive(Serialize)]
struct MediaInfo {
    path: String,
    size_bytes: u64,
}

/// Register a dropped/picked file for the `media://` scheme. Metadata only —
/// the file is never read here (multi-GB OBS recordings).
#[tauri::command]
fn open_media(path: String, state: State<'_, MediaState>) -> Result<MediaInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    state.allowed.lock().map_err(|e| e.to_string())?.insert(p);
    Ok(MediaInfo { path, size_bytes: meta.len() })
}

// ---------- sessions ----------

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions"))
}

fn session_file(app: &AppHandle, id: &str, name: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid session id".into());
    }
    if !valid_name(name) {
        return Err("invalid file name".into());
    }
    Ok(sessions_root(app)?.join(id).join(name))
}

/// Write via temp file + rename so a crash never leaves a half-written file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<String, String> {
    let dir = path.parent().ok_or("no parent dir")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension().and_then(|e| e.to_str()).map(|e| format!("{e}.")).unwrap_or_default()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_session_file(app: AppHandle, id: String, name: String, contents: String) -> Result<String, String> {
    write_atomic(&session_file(&app, &id, &name)?, contents.as_bytes())
}

#[tauri::command]
fn load_session_file(app: AppHandle, id: String, name: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(session_file(&app, &id, &name)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Raw-body IPC: `invoke("save_session_bytes", bytes, { headers: { "x-session", "x-name" } })`.
/// Used for mic WAV chunks and point screenshots (JPEG).
#[tauri::command]
fn save_session_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |k: &str| -> Result<String, String> {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("missing header {k}"))
    };
    let (id, name) = (header("x-session")?, header("x-name")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw binary body".into());
    };
    write_atomic(&session_file(&app, &id, &name)?, bytes)
}

/// Raw bytes back to the webview (screenshot thumbnails → Blob URL). Small
/// files only; the recording itself is never read this way.
#[tauri::command]
fn load_session_bytes(app: AppHandle, id: String, name: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(session_file(&app, &id, &name)?)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Remove one file from a session folder (a deleted point's screenshot).
/// Missing is not an error.
#[tauri::command]
fn delete_session_file(app: AppHandle, id: String, name: String) -> Result<(), String> {
    match std::fs::remove_file(session_file(&app, &id, &name)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- Deepgram key (OS keychain) ----------

fn deepgram_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_DEEPGRAM).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_deepgram_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("key is empty".into());
    }
    deepgram_entry()?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
fn has_deepgram_key() -> Result<bool, String> {
    match deepgram_entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_deepgram_key() -> Result<(), String> {
    match deepgram_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- transcription ----------

#[tauri::command]
async fn transcribe_chunk(
    app: AppHandle,
    audio_path: String,
    model: String,
    offset_s: f64,
) -> Result<Vec<Word>, String> {
    let root = sessions_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::fs::canonicalize(&root).map_err(|_| "no sessions directory yet".to_string())?;
        let audio = std::fs::canonicalize(&audio_path).map_err(|e| format!("audio file: {e}"))?;
        if !audio.starts_with(&root) || !audio.is_file() {
            return Err("audio_path must be a file inside the sessions directory".into());
        }
        let key = match deepgram_entry()?.get_password() {
            Ok(k) => k,
            Err(keyring::Error::NoEntry) => return Err("no Deepgram key set".into()),
            Err(e) => return Err(format!("keychain: {e}")),
        };
        let bytes = std::fs::read(&audio).map_err(|e| format!("audio file: {e}"))?;
        let mut words = deepgram::send(deepgram::API_BASE, &key, bytes, &model)?;
        for w in &mut words {
            w.start += offset_s;
            w.end += offset_s;
        }
        Ok(words)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- app ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MediaState::default())
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let range = request
                    .headers()
                    .get(tauri::http::header::RANGE)
                    .and_then(|v| v.to_str().ok());
                let r = media::handle(
                    &app.state::<MediaState>(),
                    request.uri().path(),
                    request.method().as_str(),
                    range,
                );
                let mut b = tauri::http::Response::builder().status(r.status);
                for (k, v) in &r.headers {
                    b = b.header(*k, v);
                }
                match b.body(r.body) {
                    Ok(resp) => responder.respond(resp),
                    Err(_) => responder.respond(
                        tauri::http::Response::builder().status(500).body(Vec::new()).unwrap(),
                    ),
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_media,
            save_session_file,
            load_session_file,
            save_session_bytes,
            load_session_bytes,
            delete_session_file,
            set_deepgram_key,
            has_deepgram_key,
            clear_deepgram_key,
            transcribe_chunk
        ])
        .run(tauri::generate_context!())
        .expect("error while running Review App");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_and_name_validation() {
        assert!(valid_id("abc_DEF-123"));
        assert!(valid_id(&"a".repeat(64)));
        for bad in ["", "a/b", "..", "a b", "ü", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(valid_name("mic-000.wav"));
        assert!(valid_name("transcript.json"));
        assert!(valid_name("shot-p0007-1762600000000.jpg"));
        for bad in ["", ".hidden", "..", "../x", "a/b", "a\\b", "C:x", &"a".repeat(65)] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn atomic_write_replaces() {
        let dir = std::env::temp_dir().join(format!("ra-atomic-{}", std::process::id()));
        let p = dir.join("s1").join("points.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
