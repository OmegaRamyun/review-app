use serde::Serialize;

#[derive(Serialize)]
struct FileInfo {
    path: String,
    size_bytes: u64,
}

/// Stat a dropped file by its absolute path. Metadata only — the file is
/// never read into memory (multi-GB OBS recordings).
#[tauri::command]
fn stat_file(path: String) -> Result<FileInfo, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    Ok(FileInfo { path, size_bytes: meta.len() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![stat_file])
        .run(tauri::generate_context!())
        .expect("error while running Review App");
}
