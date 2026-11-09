mod claude;
mod cloudflare;
mod deepgram;
mod gemini;
mod media;
mod openai;

use deepgram::Word;
use media::MediaState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const KEYRING_SERVICE: &str = "app.reviewapp.desktop";
const KEYRING_USER_DEEPGRAM: &str = "deepgram";
const KEYRING_USER_GEMINI: &str = "gemini";
const KEYRING_USER_CLAUDE: &str = "claude";
const KEYRING_USER_OPENAI: &str = "openai";
const KEYRING_USER_OPENAI_COMPAT: &str = "openai_compat";
const KEYRING_USER_CLOUDFLARE: &str = "cloudflare";
/// Upper bound on system + prompt sent to the AI draft provider, in bytes.
const AI_MAX_INPUT_BYTES: usize = 200_000;

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

#[derive(Serialize, Debug)]
struct SessionSummary {
    id: String,
    /// Raw session.json.
    session: String,
    /// Raw points.json, if present.
    points: Option<String>,
    /// Raw review.json, if present.
    review: Option<String>,
    /// transcript.txt exists (written only when transcription completes).
    transcribed: bool,
    /// transcript.json exists (never read here: can be large).
    partial_transcript: bool,
    /// session.json's `recording_path` is an existing file.
    recording_exists: bool,
}

fn read_optional(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// One summary per valid-id dir with a readable session.json. Missing root → empty.
fn list_sessions_in(root: &Path) -> Result<Vec<SessionSummary>, String> {
    let entries = match std::fs::read_dir(root) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let id = entry.file_name().to_string_lossy().into_owned();
        let dir = entry.path();
        if !valid_id(&id) || !dir.is_dir() {
            continue;
        }
        let Ok(session) = std::fs::read_to_string(dir.join("session.json")) else {
            continue;
        };
        let recording_exists = serde_json::from_str::<serde_json::Value>(&session)
            .ok()
            .and_then(|v| v.get("recording_path")?.as_str().map(|p| Path::new(p).is_file()))
            .unwrap_or(false);
        out.push(SessionSummary {
            points: read_optional(&dir.join("points.json")),
            review: read_optional(&dir.join("review.json")),
            transcribed: dir.join("transcript.txt").is_file(),
            partial_transcript: dir.join("transcript.json").is_file(),
            recording_exists,
            session,
            id,
        });
    }
    Ok(out)
}

#[tauri::command]
async fn list_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let root = sessions_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_sessions_in(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// Native multi-file open dialog; absolute paths, empty on cancel.
#[tauri::command]
async fn pick_recordings(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        // Parented to the calling window so it is modal and stays on top (Windows).
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Pick recordings")
            .add_filter("Recordings", &["mkv", "mp4", "mov", "webm"])
            .add_filter("All files", &["*"])
            .blocking_pick_files();
        let Some(files) = picked else {
            return Ok(Vec::new());
        };
        files
            .into_iter()
            .map(|f| {
                f.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- site export (local folder = the publish source + manual-upload fallback) ----------
// Layout under app data: site/index.html, site/reviews.json (local-only index of
// entries; never uploaded), site/<slug>/index.html, site/<slug>/shots/<jpg>.

const SITE_ENTRIES: &str = "reviews.json";

fn site_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("site"))
}

fn valid_slug(slug: &str) -> bool {
    (1..=64).contains(&slug.len())
        && slug.as_bytes()[0] != b'-'
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Serialize)]
struct ExportResult {
    /// The site folder (drag this into Cloudflare's dashboard upload for a manual publish).
    site_dir: String,
    /// This review's folder inside it.
    review_dir: String,
}

/// Write one review into the site folder: page + its screenshots (copied from the
/// session folder), refresh the front page and the entries list. Screenshots no
/// longer referenced by the page are removed from the review's `shots/`.
fn export_into(
    site: &Path,
    session_dir: &Path,
    slug: &str,
    html: &str,
    shots: &[String],
    index_html: &str,
    entries_json: &str,
) -> Result<ExportResult, String> {
    if !valid_slug(slug) {
        return Err("invalid slug".into());
    }
    if let Some(bad) = shots.iter().find(|n| !valid_name(n)) {
        return Err(format!("invalid screenshot name {bad:?}"));
    }
    serde_json::from_str::<serde_json::Value>(entries_json).map_err(|e| format!("entries: {e}"))?;
    let dir = site.join(slug);
    let shots_dir = dir.join("shots");
    std::fs::create_dir_all(&shots_dir).map_err(|e| e.to_string())?;
    for name in shots {
        let src = session_dir.join(name);
        std::fs::copy(&src, shots_dir.join(name)).map_err(|e| format!("screenshot {name}: {e}"))?;
    }
    for entry in std::fs::read_dir(&shots_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !shots.contains(&name) && entry.path().is_file() {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    write_atomic(&dir.join("index.html"), html.as_bytes())?;
    write_atomic(&site.join("index.html"), index_html.as_bytes())?;
    write_atomic(&site.join(SITE_ENTRIES), entries_json.as_bytes())?;
    Ok(ExportResult {
        site_dir: site.to_string_lossy().into_owned(),
        review_dir: dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn load_site_entries(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(site_root(&app)?.join(SITE_ENTRIES)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn export_review(
    app: AppHandle,
    id: String,
    slug: String,
    html: String,
    shots: Vec<String>,
    index_html: String,
    entries_json: String,
) -> Result<ExportResult, String> {
    if !valid_id(&id) {
        return Err("invalid session id".into());
    }
    let session_dir = sessions_root(&app)?.join(&id);
    export_into(&site_root(&app)?, &session_dir, &slug, &html, &shots, &index_html, &entries_json)
}

#[derive(Serialize)]
struct PublishResult {
    site_url: String,
    deployment_url: String,
    uploaded: usize,
}

/// Upload the whole local site folder as a new production deployment. Only ever
/// runs on the user's explicit click; the loop tests it against a mock server.
#[tauri::command]
async fn publish_site(app: AppHandle, account_id: String, project: String) -> Result<PublishResult, String> {
    let site = site_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let token = get_key(KEYRING_USER_CLOUDFLARE, "Cloudflare")?;
        let files = cloudflare::collect(&site, &[SITE_ENTRIES]).map_err(|e| format!("site folder: {e}"))?;
        let d = cloudflare::deploy(cloudflare::API_BASE, &token, account_id.trim(), project.trim(), &files)?;
        Ok(PublishResult { site_url: d.site_url, deployment_url: d.deployment_url, uploaded: d.uploaded })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- API keys (OS keychain) ----------
// Keys are write-only from the webview: set / has / clear, never get.

fn key_entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| e.to_string())
}

fn set_key(user: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("key is empty".into());
    }
    key_entry(user)?.set_password(key).map_err(|e| e.to_string())
}

fn has_key(user: &str) -> Result<bool, String> {
    match key_entry(user)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn clear_key(user: &str) -> Result<(), String> {
    match key_entry(user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read a key for a backend call; `label` names the service in the error.
fn get_key(user: &str, label: &str) -> Result<String, String> {
    match key_entry(user)?.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) => Err(format!("no {label} key set")),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

#[tauri::command]
fn set_deepgram_key(key: String) -> Result<(), String> {
    set_key(KEYRING_USER_DEEPGRAM, &key)
}

#[tauri::command]
fn has_deepgram_key() -> Result<bool, String> {
    has_key(KEYRING_USER_DEEPGRAM)
}

#[tauri::command]
fn clear_deepgram_key() -> Result<(), String> {
    clear_key(KEYRING_USER_DEEPGRAM)
}

#[tauri::command]
fn set_gemini_key(key: String) -> Result<(), String> {
    set_key(KEYRING_USER_GEMINI, &key)
}

#[tauri::command]
fn has_gemini_key() -> Result<bool, String> {
    has_key(KEYRING_USER_GEMINI)
}

#[tauri::command]
fn clear_gemini_key() -> Result<(), String> {
    clear_key(KEYRING_USER_GEMINI)
}

#[tauri::command]
fn set_claude_key(key: String) -> Result<(), String> {
    set_key(KEYRING_USER_CLAUDE, &key)
}

#[tauri::command]
fn has_claude_key() -> Result<bool, String> {
    has_key(KEYRING_USER_CLAUDE)
}

#[tauri::command]
fn clear_claude_key() -> Result<(), String> {
    clear_key(KEYRING_USER_CLAUDE)
}

#[tauri::command]
fn set_openai_key(key: String) -> Result<(), String> {
    set_key(KEYRING_USER_OPENAI, &key)
}

#[tauri::command]
fn has_openai_key() -> Result<bool, String> {
    has_key(KEYRING_USER_OPENAI)
}

#[tauri::command]
fn clear_openai_key() -> Result<(), String> {
    clear_key(KEYRING_USER_OPENAI)
}

#[tauri::command]
fn set_openai_compat_key(key: String) -> Result<(), String> {
    set_key(KEYRING_USER_OPENAI_COMPAT, &key)
}

#[tauri::command]
fn has_openai_compat_key() -> Result<bool, String> {
    has_key(KEYRING_USER_OPENAI_COMPAT)
}

#[tauri::command]
fn clear_openai_compat_key() -> Result<(), String> {
    clear_key(KEYRING_USER_OPENAI_COMPAT)
}

#[tauri::command]
fn set_cloudflare_key(key: String) -> Result<(), String> {
    set_key(KEYRING_USER_CLOUDFLARE, &key)
}

#[tauri::command]
fn has_cloudflare_key() -> Result<bool, String> {
    has_key(KEYRING_USER_CLOUDFLARE)
}

#[tauri::command]
fn clear_cloudflare_key() -> Result<(), String> {
    clear_key(KEYRING_USER_CLOUDFLARE)
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
        let key = get_key(KEYRING_USER_DEEPGRAM, "Deepgram")?;
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

// ---------- AI drafting ----------
// One command for every provider; the frontend passes the provider the user
// picked in Settings. `base_url` is only used by "openai_compat".

fn check_ai_input(system: &str, prompt: &str) -> Result<(), String> {
    let n = system.len() + prompt.len();
    if n > AI_MAX_INPUT_BYTES {
        return Err(format!(
            "prompt too large: {n} bytes (limit {AI_MAX_INPUT_BYTES})"
        ));
    }
    Ok(())
}

/// Returns the model's raw text (a JSON string; the frontend parses it).
#[tauri::command]
async fn ai_draft(
    provider: String,
    model: String,
    base_url: String,
    system: String,
    prompt: String,
) -> Result<String, String> {
    check_ai_input(&system, &prompt)?;
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "claude" => {
            let key = get_key(KEYRING_USER_CLAUDE, "Claude")?;
            claude::send(claude::API_BASE, &key, &model, &system, &prompt)
        }
        "openai" => {
            let key = get_key(KEYRING_USER_OPENAI, "OpenAI")?;
            openai::send(openai::API_BASE, &key, &model, &system, &prompt)
        }
        "openai_compat" => {
            let base = base_url.trim();
            if base.is_empty() {
                return Err(
                    "OpenAI Compatible needs a base URL (e.g. https://nano-gpt.com/api/v1)".into(),
                );
            }
            if !(base.starts_with("http://") || base.starts_with("https://")) {
                return Err("base URL must start with http:// or https://".into());
            }
            let key = get_key(KEYRING_USER_OPENAI_COMPAT, "OpenAI Compatible")?;
            openai::send(base, &key, &model, &system, &prompt)
        }
        _ => {
            let key = get_key(KEYRING_USER_GEMINI, "Gemini")?;
            gemini::send(gemini::API_BASE, &key, &model, &system, &prompt)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- app ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            list_sessions,
            pick_recordings,
            set_deepgram_key,
            has_deepgram_key,
            clear_deepgram_key,
            transcribe_chunk,
            set_gemini_key,
            has_gemini_key,
            clear_gemini_key,
            set_claude_key,
            has_claude_key,
            clear_claude_key,
            set_openai_key,
            has_openai_key,
            clear_openai_key,
            set_openai_compat_key,
            has_openai_compat_key,
            clear_openai_compat_key,
            ai_draft,
            set_cloudflare_key,
            has_cloudflare_key,
            clear_cloudflare_key,
            load_site_entries,
            export_review,
            publish_site
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
    fn ai_input_cap() {
        assert!(check_ai_input("s", "p").is_ok());
        let half = "a".repeat(AI_MAX_INPUT_BYTES / 2);
        assert!(check_ai_input(&half, &half).is_ok());
        let e = check_ai_input(&half, &format!("{half}x")).unwrap_err();
        assert!(e.contains("too large"), "{e}");
    }

    #[test]
    fn export_writes_page_shots_and_prunes() {
        let root = std::env::temp_dir().join(format!("ra-export-{}", std::process::id()));
        let (site, sess) = (root.join("site"), root.join("sessions").join("s1"));
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::write(sess.join("shot-p0001-1.jpg"), b"jpg1").unwrap();
        std::fs::write(sess.join("shot-p0002-2.jpg"), b"jpg2").unwrap();
        let shots = vec!["shot-p0001-1.jpg".to_string(), "shot-p0002-2.jpg".to_string()];
        let r = export_into(&site, &sess, "hookshot", "<p>a</p>", &shots, "<p>idx</p>", r#"{"entries":[]}"#).unwrap();
        assert!(r.review_dir.ends_with("hookshot"));
        assert_eq!(std::fs::read(site.join("hookshot/shots/shot-p0002-2.jpg")).unwrap(), b"jpg2");
        assert_eq!(std::fs::read_to_string(site.join("index.html")).unwrap(), "<p>idx</p>");
        // Re-export without the second shot: it is pruned from the site.
        export_into(&site, &sess, "hookshot", "<p>b</p>", &shots[..1], "<p>idx</p>", "{}").unwrap();
        assert!(!site.join("hookshot/shots/shot-p0002-2.jpg").exists());
        assert_eq!(std::fs::read_to_string(site.join("hookshot/index.html")).unwrap(), "<p>b</p>");
        for (slug, shot) in [("../x", "a.jpg"), ("-x", "a.jpg"), ("Caps", "a.jpg"), ("ok", "../a.jpg")] {
            assert!(export_into(&site, &sess, slug, "", &[shot.to_string()], "", "{}").is_err(), "{slug} {shot}");
        }
        assert!(export_into(&site, &sess, "ok", "", &[], "", "not json").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_sessions_scans_valid_dirs() {
        let root = std::env::temp_dir().join(format!("ra-list-{}", std::process::id()));
        let sessions = root.join("sessions");
        let rec = root.join("rec.mkv");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(&rec, b"mkv").unwrap();

        let full = sessions.join("full_1");
        std::fs::create_dir_all(&full).unwrap();
        let full_session = serde_json::json!({ "recording_path": rec.to_string_lossy() }).to_string();
        std::fs::write(full.join("session.json"), &full_session).unwrap();
        std::fs::write(full.join("points.json"), "[1]").unwrap();
        std::fs::write(full.join("review.json"), "{\"r\":1}").unwrap();
        std::fs::write(full.join("transcript.txt"), "hi").unwrap();
        std::fs::write(full.join("transcript.json"), "[]").unwrap();

        let bare = sessions.join("bare-2");
        std::fs::create_dir_all(&bare).unwrap();
        let missing = root.join("gone.mkv");
        let bare_session = serde_json::json!({ "recording_path": missing.to_string_lossy() }).to_string();
        std::fs::write(bare.join("session.json"), &bare_session).unwrap();

        let bad = sessions.join("bad name");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("session.json"), "{}").unwrap();
        std::fs::create_dir_all(sessions.join("empty3")).unwrap();
        std::fs::write(sessions.join("stray.json"), "{}").unwrap();

        let mut list = list_sessions_in(&sessions).unwrap();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(list.len(), 2, "{list:?}");
        let (b, f) = (&list[0], &list[1]);
        assert_eq!(f.id, "full_1");
        assert_eq!(f.session, full_session);
        assert_eq!(f.points.as_deref(), Some("[1]"));
        assert_eq!(f.review.as_deref(), Some("{\"r\":1}"));
        assert!(f.transcribed && f.partial_transcript && f.recording_exists);
        assert_eq!(b.id, "bare-2");
        assert_eq!(b.session, bare_session);
        assert!(b.points.is_none() && b.review.is_none());
        assert!(!b.transcribed && !b.partial_transcript && !b.recording_exists);

        // Unparseable session.json still lists, with recording_exists = false.
        std::fs::write(bare.join("session.json"), "not json").unwrap();
        let list = list_sessions_in(&sessions).unwrap();
        assert!(list.iter().any(|s| s.id == "bare-2" && !s.recording_exists));

        let v = serde_json::to_value(&list[0]).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["id", "partial_transcript", "points", "recording_exists", "review", "session", "transcribed"]
        );

        assert!(list_sessions_in(&root.join("nope")).unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
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
