//! `media://` scheme: serves byte ranges of allow-listed local files to the
//! webview's <video>/<audio> elements. Never reads a whole file — every
//! response is a seek + bounded read.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Hard cap for any single response body.
pub const MAX_CHUNK: u64 = 16 * 1024 * 1024;
/// Body size for open-ended `bytes=a-` requests (and no-Range requests).
pub const OPEN_CHUNK: u64 = 4 * 1024 * 1024;

/// Paths handed to `open_media`; the scheme serves nothing else.
#[derive(Default)]
pub struct MediaState {
    pub allowed: Mutex<HashSet<PathBuf>>,
}

pub struct MediaResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl MediaResponse {
    fn empty(status: u16, mut headers: Vec<(&'static str, String)>) -> Self {
        headers.push(("Content-Length", "0".into()));
        MediaResponse { status, headers, body: Vec::new() }
    }
}

fn cors() -> Vec<(&'static str, String)> {
    vec![
        ("Access-Control-Allow-Origin", "*".into()),
        (
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges".into(),
        ),
    ]
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mkv") => "video/x-matroska",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Turn the request URI path into a filesystem path.
/// `convertFileSrc(p, "media")` yields `/<encodeURIComponent(p)>`.
pub fn path_from_uri_path(uri_path: &str) -> PathBuf {
    let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
    PathBuf::from(
        percent_encoding::percent_decode_str(raw)
            .decode_utf8_lossy()
            .into_owned(),
    )
}

#[derive(Debug, PartialEq)]
enum Range {
    /// Inclusive [start, end] already clamped and capped.
    Satisfiable(u64, u64),
    Unsatisfiable,
}

/// Resolve a Range header against a file of `len` bytes. A missing or
/// syntactically invalid header is treated as `bytes=0-`. Only the first
/// range of a multi-range request is honoured.
fn resolve_range(header: Option<&str>, len: u64) -> Range {
    let spec = header
        .and_then(|h| h.trim().strip_prefix("bytes="))
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .and_then(|s| s.split_once('-'))
        .and_then(|(a, b)| {
            let (a, b) = (a.trim(), b.trim());
            match (a.is_empty(), b.is_empty()) {
                (false, false) => Some((Some(a.parse::<u64>().ok()?), Some(b.parse::<u64>().ok()?))),
                (false, true) => Some((Some(a.parse::<u64>().ok()?), None)),
                (true, false) => Some((None, Some(b.parse::<u64>().ok()?))),
                (true, true) => None,
            }
        })
        .unwrap_or((Some(0), None));

    let (start, end) = match spec {
        (Some(a), Some(b)) => {
            if a > b || a >= len {
                return Range::Unsatisfiable;
            }
            (a, b.min(len - 1).min(a + MAX_CHUNK - 1))
        }
        (Some(a), None) => {
            if a >= len {
                return Range::Unsatisfiable;
            }
            (a, (len - 1).min(a + OPEN_CHUNK - 1))
        }
        (None, Some(n)) => {
            if n == 0 || len == 0 {
                return Range::Unsatisfiable;
            }
            let a = len - n.min(len);
            (a, (len - 1).min(a + MAX_CHUNK - 1))
        }
        (None, None) => unreachable!(),
    };
    Range::Satisfiable(start, end)
}

/// Pure request handler (no Tauri types) so it can be unit-tested.
pub fn serve(path: &Path, method: &str, range_header: Option<&str>) -> MediaResponse {
    if method.eq_ignore_ascii_case("OPTIONS") {
        return MediaResponse::empty(
            204,
            vec![
                ("Access-Control-Allow-Origin", "*".into()),
                ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS".into()),
                ("Access-Control-Allow-Headers", "Range".into()),
            ],
        );
    }
    let is_head = method.eq_ignore_ascii_case("HEAD");
    if !is_head && !method.eq_ignore_ascii_case("GET") {
        let mut h = cors();
        h.push(("Allow", "GET, HEAD, OPTIONS".into()));
        return MediaResponse::empty(405, h);
    }

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return MediaResponse::empty(404, cors())
        }
        Err(_) => return MediaResponse::empty(500, cors()),
    };
    let len = match file.metadata() {
        Ok(m) if m.is_file() => m.len(),
        _ => return MediaResponse::empty(404, cors()),
    };

    let mut headers = cors();
    headers.push(("Accept-Ranges", "bytes".into()));
    headers.push(("Content-Type", content_type(path).into()));

    if is_head {
        headers.push(("Content-Length", len.to_string()));
        return MediaResponse { status: 200, headers, body: Vec::new() };
    }

    if len == 0 && range_header.is_none() {
        headers.push(("Content-Length", "0".into()));
        return MediaResponse { status: 200, headers, body: Vec::new() };
    }

    let (start, end) = match resolve_range(range_header, len) {
        Range::Satisfiable(s, e) => (s, e),
        Range::Unsatisfiable => {
            headers.push(("Content-Range", format!("bytes */{len}")));
            return MediaResponse::empty(416, headers);
        }
    };

    let want = (end - start + 1) as usize;
    let mut body = vec![0u8; want];
    let read = file
        .seek(SeekFrom::Start(start))
        .and_then(|_| read_up_to(&mut file, &mut body));
    let got = match read {
        Ok(n) => n,
        Err(_) => return MediaResponse::empty(500, cors()),
    };
    body.truncate(got);
    if got == 0 {
        // File shrank under us.
        headers.push(("Content-Range", format!("bytes */{len}")));
        return MediaResponse::empty(416, headers);
    }
    let end = start + got as u64 - 1;
    headers.push(("Content-Range", format!("bytes {start}-{end}/{len}")));
    headers.push(("Content-Length", got.to_string()));
    MediaResponse { status: 206, headers, body }
}

fn read_up_to(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// Scheme entry point: allow-list check, then `serve`.
pub fn handle(state: &MediaState, uri_path: &str, method: &str, range: Option<&str>) -> MediaResponse {
    let path = path_from_uri_path(uri_path);
    if !method.eq_ignore_ascii_case("OPTIONS") {
        let allowed = state.allowed.lock().map(|s| s.contains(&path)).unwrap_or(false);
        if !allowed {
            return MediaResponse::empty(403, cors());
        }
    }
    serve(&path, method, range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Instant;

    fn header<'a>(r: &'a MediaResponse, name: &str) -> Option<&'a str> {
        r.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[cfg(target_os = "linux")]
    fn proc_status_kib(field: &str) -> u64 {
        let s = std::fs::read_to_string("/proc/self/status").unwrap();
        s.lines()
            .find(|l| l.starts_with(field))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap()
    }

    #[test]
    fn range_resolution() {
        let len = 1000;
        assert_eq!(resolve_range(Some("bytes=0-99"), len), Range::Satisfiable(0, 99));
        assert_eq!(resolve_range(Some("bytes=990-2000"), len), Range::Satisfiable(990, 999));
        assert_eq!(resolve_range(Some("bytes=-10"), len), Range::Satisfiable(990, 999));
        assert_eq!(resolve_range(Some("bytes=-5000"), len), Range::Satisfiable(0, 999));
        assert_eq!(resolve_range(Some("bytes=5-"), len), Range::Satisfiable(5, 999));
        assert_eq!(resolve_range(None, len), Range::Satisfiable(0, 999));
        assert_eq!(resolve_range(Some("garbage"), len), Range::Satisfiable(0, 999));
        assert_eq!(resolve_range(Some("bytes=1000-"), len), Range::Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=50-10"), len), Range::Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=-0"), len), Range::Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=0-1,5-9"), len), Range::Satisfiable(0, 1));
    }

    #[test]
    fn uri_path_decoding() {
        assert_eq!(
            path_from_uri_path("/C%3A%5CUsers%5Ccade%5CVideos%5Crun%201.mkv"),
            PathBuf::from("C:\\Users\\cade\\Videos\\run 1.mkv")
        );
        assert_eq!(
            path_from_uri_path("/%2Fhome%2Fx%2Fa.mkv"),
            PathBuf::from("/home/x/a.mkv")
        );
    }

    #[test]
    fn options_head_forbidden() {
        let dir = std::env::temp_dir().join(format!("ra-media-small-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("clip.webm");
        File::create(&p).unwrap().write_all(&[7u8; 1234]).unwrap();

        let o = serve(&p, "OPTIONS", None);
        assert_eq!(o.status, 204);
        assert_eq!(header(&o, "Access-Control-Allow-Headers"), Some("Range"));

        let h = serve(&p, "HEAD", None);
        assert_eq!(h.status, 200);
        assert_eq!(header(&h, "Content-Length"), Some("1234"));
        assert_eq!(header(&h, "Content-Type"), Some("video/webm"));
        assert!(h.body.is_empty());

        let state = MediaState::default();
        let uri = format!(
            "/{}",
            percent_encoding::utf8_percent_encode(
                p.to_str().unwrap(),
                percent_encoding::NON_ALPHANUMERIC
            )
        );
        assert_eq!(handle(&state, &uri, "GET", None).status, 403);
        state.allowed.lock().unwrap().insert(p.clone());
        let g = handle(&state, &uri, "GET", Some("bytes=10-19"));
        assert_eq!(g.status, 206);
        assert_eq!(g.body, vec![7u8; 10]);
        assert_eq!(header(&g, "Content-Range"), Some("bytes 10-19/1234"));
        assert_eq!(serve(&p, "POST", None).status, 405);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sparse_5gib_ranges_stay_small() {
        let dir = std::env::temp_dir().join(format!("ra-media-sparse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("big.mkv");
        let len: u64 = 5 * 1024 * 1024 * 1024;
        {
            let mut f = File::create(&p).unwrap();
            f.set_len(len).unwrap();
            // Mark the tail so we can check we really read from the end.
            f.seek(SeekFrom::Start(len - 4)).unwrap();
            f.write_all(b"TAIL").unwrap();
        }
        eprintln!("[sparse] file {} bytes ({} GiB)", len, len >> 30);

        #[cfg(target_os = "linux")]
        let (rss0, hwm0) = (proc_status_kib("VmRSS:"), proc_status_kib("VmHWM:"));

        // (label, Range header, expected status, expected start, expected body len)
        let cases: Vec<(&str, Option<String>, u16, u64, u64)> = vec![
            ("start bytes=0-1048575", Some("bytes=0-1048575".into()), 206, 0, 1 << 20),
            ("middle bytes=2684354560-2685403135", Some("bytes=2684354560-2685403135".into()), 206, 2684354560, 1 << 20),
            ("middle 100MiB ask (capped 16MiB)", Some("bytes=2684354560-2789212159".into()), 206, 2684354560, MAX_CHUNK),
            ("end bytes=5368709000-", Some("bytes=5368709000-".into()), 206, 5368709000, len - 5368709000),
            ("open-ended mid bytes=1073741824-", Some("bytes=1073741824-".into()), 206, 1073741824, OPEN_CHUNK),
            ("suffix bytes=-4096", Some("bytes=-4096".into()), 206, len - 4096, 4096),
            ("no Range header", None, 206, 0, OPEN_CHUNK),
            ("past EOF bytes=6000000000-", Some("bytes=6000000000-".into()), 416, 0, 0),
        ];

        for (label, range, status, start, blen) in &cases {
            let t = Instant::now();
            let r = serve(&p, "GET", range.as_deref());
            let dt = t.elapsed();
            eprintln!(
                "[sparse] {label}: status {} served {} bytes, Content-Range {:?}, {:.2?}",
                r.status,
                r.body.len(),
                header(&r, "Content-Range"),
                dt
            );
            assert_eq!(r.status, *status, "{label}");
            assert_eq!(r.body.len() as u64, *blen, "{label}");
            assert_eq!(header(&r, "Accept-Ranges"), Some("bytes"));
            assert_eq!(header(&r, "Access-Control-Allow-Origin"), Some("*"));
            assert_eq!(header(&r, "Content-Length"), Some(blen.to_string().as_str()));
            if *status == 206 {
                assert_eq!(header(&r, "Content-Type"), Some("video/x-matroska"));
                let want = format!("bytes {}-{}/{}", start, start + blen - 1, len);
                assert_eq!(header(&r, "Content-Range"), Some(want.as_str()), "{label}");
            } else {
                assert_eq!(header(&r, "Content-Range"), Some(format!("bytes */{len}").as_str()));
            }
            if label.starts_with("end") || label.starts_with("suffix") {
                assert_eq!(&r.body[r.body.len() - 4..], b"TAIL");
            }
        }

        let head = serve(&p, "HEAD", None);
        assert_eq!(head.status, 200);
        assert_eq!(header(&head, "Content-Length"), Some(len.to_string().as_str()));

        #[cfg(target_os = "linux")]
        {
            let (rss1, hwm1) = (proc_status_kib("VmRSS:"), proc_status_kib("VmHWM:"));
            eprintln!(
                "[sparse] VmRSS before {rss0} KiB, after {rss1} KiB, delta {} KiB; VmHWM before {hwm0} KiB, after {hwm1} KiB, peak delta {} KiB",
                rss1 as i64 - rss0 as i64,
                hwm1 as i64 - hwm0 as i64
            );
            assert!((rss1 as i64 - rss0 as i64) < 64 * 1024, "RSS grew too much");
            assert!((hwm1 as i64 - hwm0 as i64) < 64 * 1024, "peak RSS grew too much");
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
