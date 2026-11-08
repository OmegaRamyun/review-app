//! Cloudflare Pages direct upload (the same HTTP flow `wrangler pages deploy`
//! uses, no wrangler/Node). Blocking (ureq); call from a blocking thread.
//!
//! 1. `GET  /accounts/{a}/pages/projects/{p}` → `subdomain` (404 → create the
//!    project with `POST /accounts/{a}/pages/projects`).
//! 2. `GET  /accounts/{a}/pages/projects/{p}/upload-token` → short-lived JWT.
//! 3. `POST /pages/assets/check-missing` (JWT) → hashes the server lacks.
//! 4. `POST /pages/assets/upload` (JWT) → only the missing files, base64, batched.
//! 5. `POST /pages/assets/upsert-hashes` (JWT) → every hash in the manifest.
//! 6. `POST /accounts/{a}/pages/projects/{p}/deployments` (multipart `manifest`
//!    = `{"/path": hash}`) → production deployment.
//!
//! The API token and the JWT only ever go in the `Authorization` header —
//! never in URLs, returned values, or errors.

use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const API_BASE: &str = "https://api.cloudflare.com/client/v4";
const PRODUCTION_BRANCH: &str = "main";
/// Pages limits: 25 MiB per file, 20,000 files per deployment.
const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
/// Per upload request (wrangler's bucket caps).
const BUCKET_BYTES: usize = 40 * 1024 * 1024;
const BUCKET_FILES: usize = 2_000;

pub struct SiteFile {
    /// URL path, e.g. "/hookshot/index.html".
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub struct Deployed {
    /// The project's stable address, e.g. "https://reviews.pages.dev".
    pub site_url: String,
    /// This deployment's unique preview URL.
    pub deployment_url: String,
    /// How many files actually had to be uploaded (the rest were already there).
    pub uploaded: usize,
}

/// Collect every file under `root` as site files, skipping `skip` (root-level
/// names that stay local) and atomic-write leftovers (`*.tmp`).
pub fn collect(root: &Path, skip: &[&str]) -> Result<Vec<SiteFile>, String> {
    fn walk(dir: &Path, prefix: &str, skip: &[&str], out: &mut Vec<SiteFile>) -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.ends_with(".tmp") || (prefix.is_empty() && skip.contains(&name.as_str())) {
                continue;
            }
            let path = format!("{prefix}/{name}");
            let ft = e.file_type().map_err(|e| e.to_string())?;
            if ft.is_dir() {
                walk(&e.path(), &path, skip, out)?;
            } else if ft.is_file() {
                let bytes = std::fs::read(e.path()).map_err(|e| format!("{path}: {e}"))?;
                out.push(SiteFile { path, bytes });
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, "", skip, &mut out)?;
    Ok(out)
}

pub fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") | Some("htm") => "text/html",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("json") => "application/json",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Asset key exactly as wrangler computes it (deploy-helpers `hash.ts`):
/// `blake3(base64(content) + extension-without-dot).hex()[..32]`. A key that
/// doesn't match is accepted silently and the asset then 404s, so this must
/// stay byte-identical to wrangler.
pub fn asset_hash(path: &str, bytes: &[u8]) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let mut h = blake3::Hasher::new();
    h.update(base64(bytes).as_bytes());
    h.update(ext.as_bytes());
    h.finalize().to_hex()[..32].to_string()
}

fn redact(s: &str, secrets: &[&str]) -> String {
    let mut s = s.to_string();
    for k in secrets.iter().filter(|k| !k.is_empty()) {
        s = s.replace(k, "[redacted]");
    }
    s
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

/// One API call → (HTTP status, parsed JSON envelope). Errors never carry secrets.
struct Api<'a> {
    base: &'a str,
    token: &'a str,
    agent: ureq::Agent,
    jwt: String,
}

enum Auth {
    Token,
    Jwt,
}

impl<'a> Api<'a> {
    fn new(base: &'a str, token: &'a str) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_global(Some(Duration::from_secs(300)))
            .build()
            .into();
        Api { base: base.trim_end_matches('/'), token, agent, jwt: String::new() }
    }

    fn call(&self, what: &str, method: &str, path: &str, auth: Auth, body: Option<(&str, Vec<u8>)>) -> Result<(u16, Value), String> {
        let secrets = [self.token, self.jwt.as_str()];
        let url = format!("{}{}", self.base, path);
        let bearer = format!("Bearer {}", match auth { Auth::Token => self.token, Auth::Jwt => &self.jwt });
        let result = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("Authorization", &bearer).call(),
            (_, Some((ct, bytes))) => self
                .agent
                .post(&url)
                .header("Authorization", &bearer)
                .header("Content-Type", ct)
                .send(&bytes[..]),
            (_, None) => self.agent.post(&url).header("Authorization", &bearer).send_empty(),
        };
        let mut resp = result.map_err(|e| redact(&format!("Cloudflare {what} failed: {e}"), &secrets))?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| format!("Cloudflare {what}: response read failed (HTTP {status}): {e}"))?;
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let ok = (200..300).contains(&status) && v.get("success").and_then(Value::as_bool) != Some(false);
        if ok || status == 404 {
            return Ok((status, v)); // 404: the caller decides (project missing)
        }
        Err(redact(&format!("Cloudflare {what}: HTTP {status}: {}", api_errors(&v, &text)), &secrets))
    }
}

/// "code: message; …" from the `{success, errors:[{code,message}]}` envelope, else the raw body.
pub fn api_errors(v: &Value, raw: &str) -> String {
    let msgs: Vec<String> = v
        .get("errors")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|e| {
                    let code = e.get("code").map(|c| c.to_string()).unwrap_or_default();
                    let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
                    format!("{code}: {msg}")
                })
                .collect()
        })
        .unwrap_or_default();
    if msgs.is_empty() { truncate(raw, 400) } else { msgs.join("; ") }
}

fn seg(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub fn valid_account_id(a: &str) -> bool {
    a.len() == 32 && a.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Pages project names: lowercase letters, digits, dashes; 1–58 chars; no leading/trailing dash.
pub fn valid_project(p: &str) -> bool {
    (1..=58).contains(&p.len())
        && !p.starts_with('-')
        && !p.ends_with('-')
        && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn multipart(boundary: &str, fields: &[(&str, &str)]) -> Vec<u8> {
    let mut out = String::new();
    for (name, value) in fields {
        out.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"));
    }
    out.push_str(&format!("--{boundary}--\r\n"));
    out.into_bytes()
}

/// Upload `files` as a new production deployment of `project`.
pub fn deploy(base: &str, token: &str, account: &str, project: &str, files: &[SiteFile]) -> Result<Deployed, String> {
    if !valid_account_id(account) {
        return Err("Cloudflare account ID must be 32 hex characters (dashboard → Account home → Account ID)".into());
    }
    if !valid_project(project) {
        return Err("Pages project name: lowercase letters, digits and dashes only".into());
    }
    if files.is_empty() {
        return Err("nothing to publish — export a review first".into());
    }
    if files.len() > MAX_FILES {
        return Err(format!("{} files exceeds the Pages limit of {MAX_FILES}", files.len()));
    }
    if let Some(f) = files.iter().find(|f| f.bytes.len() > MAX_FILE_BYTES) {
        return Err(format!("{} is larger than the 25 MiB Pages file limit", f.path));
    }
    let mut api = Api::new(base, token);
    let proj = format!("/accounts/{}/pages/projects/{}", seg(account), seg(project));

    // 1. project (create on first publish)
    let (status, v) = api.call("project lookup", "GET", &proj, Auth::Token, None)?;
    let v = if status == 404 {
        let body = serde_json::to_vec(&json!({ "name": project, "production_branch": PRODUCTION_BRANCH })).unwrap();
        let (s, v) = api.call(
            "project create",
            "POST",
            &format!("/accounts/{}/pages/projects", seg(account)),
            Auth::Token,
            Some(("application/json", body)),
        )?;
        if s == 404 {
            return Err(format!("Cloudflare project create: HTTP 404: {}", api_errors(&v, "")));
        }
        v
    } else {
        v
    };
    let subdomain = v
        .pointer("/result/subdomain")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{project}.pages.dev"));
    // Deploy to the project's own production branch, so it's a production deployment, not a preview.
    let branch = v
        .pointer("/result/production_branch")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty())
        .unwrap_or(PRODUCTION_BRANCH)
        .to_string();

    // 2. upload JWT
    let (s, v) = api.call("upload token", "GET", &format!("{proj}/upload-token"), Auth::Token, None)?;
    api.jwt = v
        .pointer("/result/jwt")
        .and_then(Value::as_str)
        .filter(|_| s != 404)
        .ok_or("Cloudflare upload token: no jwt in response")?
        .to_string();

    // 3. which assets are missing
    let hashed: Vec<(&SiteFile, String)> = files.iter().map(|f| (f, asset_hash(&f.path, &f.bytes))).collect();
    let mut all: Vec<&str> = hashed.iter().map(|(_, h)| h.as_str()).collect();
    all.sort_unstable();
    all.dedup();
    let body = serde_json::to_vec(&json!({ "hashes": all })).unwrap();
    let (_, v) = api.call("check-missing", "POST", "/pages/assets/check-missing", Auth::Jwt, Some(("application/json", body)))?;
    let missing: std::collections::HashSet<String> = v
        .get("result")
        .and_then(Value::as_array)
        .ok_or("Cloudflare check-missing: unexpected response")?
        .iter()
        .filter_map(|h| h.as_str().map(str::to_string))
        .collect();

    // 4. upload the missing ones, batched
    let mut seen = std::collections::HashSet::new();
    let todo: Vec<&(&SiteFile, String)> = hashed.iter().filter(|(_, h)| missing.contains(h) && seen.insert(h.clone())).collect();
    let mut batch: Vec<Value> = Vec::new();
    let mut batch_bytes = 0usize;
    let flush = |api: &Api, batch: &mut Vec<Value>, batch_bytes: &mut usize| -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let body = serde_json::to_vec(&Value::Array(std::mem::take(batch))).unwrap();
        *batch_bytes = 0;
        api.call("asset upload", "POST", "/pages/assets/upload", Auth::Jwt, Some(("application/json", body)))
            .map(|_| ())
    };
    for (f, h) in &todo {
        let b64 = base64(&f.bytes);
        if !batch.is_empty() && (batch_bytes + b64.len() > BUCKET_BYTES || batch.len() >= BUCKET_FILES) {
            flush(&api, &mut batch, &mut batch_bytes)?;
        }
        batch_bytes += b64.len();
        batch.push(json!({ "key": h, "value": b64, "metadata": { "contentType": content_type(&f.path) }, "base64": true }));
    }
    flush(&api, &mut batch, &mut batch_bytes)?;

    // 5. mark every manifest hash as live
    let body = serde_json::to_vec(&json!({ "hashes": all })).unwrap();
    api.call("upsert-hashes", "POST", "/pages/assets/upsert-hashes", Auth::Jwt, Some(("application/json", body)))?;

    // 6. the deployment itself
    let manifest: serde_json::Map<String, Value> =
        hashed.iter().map(|(f, h)| (f.path.clone(), Value::String(h.clone()))).collect();
    let manifest = serde_json::to_string(&manifest).unwrap();
    let boundary = format!("----ReviewApp{:016x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0));
    let body = multipart(&boundary, &[("manifest", &manifest), ("branch", &branch)]);
    let ct = format!("multipart/form-data; boundary={boundary}");
    let (s, v) = api.call("deployment", "POST", &format!("{proj}/deployments"), Auth::Token, Some((&ct, body)))?;
    if s == 404 {
        return Err(format!("Cloudflare deployment: HTTP 404: {}", api_errors(&v, "")));
    }
    let deployment_url = v.pointer("/result/url").and_then(Value::as_str).unwrap_or("").to_string();
    Ok(Deployed { site_url: format!("https://{subdomain}"), deployment_url, uploaded: todo.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

    #[derive(Debug, Clone)]
    struct Req {
        method: String,
        path: String,
        auth: String,
        content_type: String,
        body: Vec<u8>,
    }

    /// Mock Cloudflare API on 127.0.0.1: `route(&req) -> (status line, json)`.
    /// Serves `n` requests (one per connection), returns them in order.
    fn mock(n: usize, route: impl Fn(&Req) -> (&'static str, String) + Send + 'static) -> (String, std::thread::JoinHandle<Vec<Req>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/client/v4", listener.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..n {
                let (stream, _) = listener.accept().unwrap();
                let mut r = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut it = line.split_whitespace();
                let (method, path) = (it.next().unwrap().to_string(), it.next().unwrap().to_string());
                let (mut len, mut auth, mut ct) = (0usize, String::new(), String::new());
                loop {
                    let mut l = String::new();
                    r.read_line(&mut l).unwrap();
                    let l = l.trim_end();
                    if l.is_empty() {
                        break;
                    }
                    let (k, v) = l.split_once(':').unwrap();
                    match k.trim().to_ascii_lowercase().as_str() {
                        "content-length" => len = v.trim().parse().unwrap(),
                        "authorization" => auth = v.trim().to_string(),
                        "content-type" => ct = v.trim().to_string(),
                        _ => {}
                    }
                }
                let mut body = vec![0u8; len];
                r.read_exact(&mut body).unwrap();
                let req = Req { method, path: path.trim_start_matches("/client/v4").to_string(), auth, content_type: ct, body };
                let (status, reply) = route(&req);
                let mut w = stream;
                write!(w, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
                w.flush().unwrap();
                seen.push(req);
            }
            seen
        });
        (base, h)
    }

    fn ok(result: Value) -> String {
        json!({ "success": true, "errors": [], "messages": [], "result": result }).to_string()
    }

    fn site() -> Vec<SiteFile> {
        vec![
            SiteFile { path: "/index.html".into(), bytes: b"<p>index</p>".to_vec() },
            SiteFile { path: "/hookshot/index.html".into(), bytes: b"<p>review</p>".to_vec() },
            SiteFile { path: "/hookshot/shots/shot-p0001-1.jpg".into(), bytes: vec![0xff, 0xd8, 0xff, 0xe0, 1, 2, 3] },
        ]
    }

    #[test]
    fn base64_and_hash() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
        // Pins the algorithm to BLAKE3: blake3("") = af1349b9f5f9a1a6a0404dea36dcc949…
        assert_eq!(asset_hash("/noext", b""), "af1349b9f5f9a1a6a0404dea36dcc949");
        assert_eq!(asset_hash("/a.b/noext", b""), "af1349b9f5f9a1a6a0404dea36dcc949");
        let h = asset_hash("/a/index.html", b"x");
        assert_eq!(h.len(), 32);
        assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(h, asset_hash("/b/other.html", b"x"), "same content + ext = same key");
        assert_ne!(h, asset_hash("/a/index.htm", b"x"));
        let mut hh = blake3::Hasher::new();
        hh.update(b"eA==html");
        assert_eq!(h, hh.finalize().to_hex()[..32]);
        assert_eq!(content_type("/x/shots/a.JPG"), "image/jpeg");
        assert_eq!(content_type("/index.html"), "text/html");
    }

    #[test]
    fn validation() {
        assert!(valid_account_id(ACCOUNT));
        assert!(!valid_account_id("abc"));
        assert!(valid_project("reviews-2"));
        for bad in ["", "Reviews", "a_b", "-a", "a-", "a/b", &"a".repeat(59)] {
            assert!(!valid_project(bad), "{bad}");
        }
        let e = deploy("http://127.0.0.1:9", "t", "nope", "reviews", &site()).unwrap_err();
        assert!(e.contains("account ID"), "{e}");
        let e = deploy("http://127.0.0.1:9", "t", ACCOUNT, "reviews", &[]).unwrap_err();
        assert!(e.contains("export"), "{e}");
    }

    #[test]
    fn collect_skips_local_only_files() {
        let root = std::env::temp_dir().join(format!("ra-cf-collect-{}", std::process::id()));
        std::fs::create_dir_all(root.join("hookshot/shots")).unwrap();
        std::fs::write(root.join("index.html"), "i").unwrap();
        std::fs::write(root.join("reviews.json"), "{}").unwrap();
        std::fs::write(root.join("hookshot/index.html"), "r").unwrap();
        std::fs::write(root.join("hookshot/index.html.tmp"), "partial").unwrap();
        std::fs::write(root.join("hookshot/shots/a.jpg"), "j").unwrap();
        let paths: Vec<String> = collect(&root, &["reviews.json"]).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(paths, ["/hookshot/index.html", "/hookshot/shots/a.jpg", "/index.html"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Full flow against the mock: existing project, one asset already present.
    #[test]
    fn deploy_end_to_end_against_mock() {
        let files = site();
        let present = asset_hash(&files[2].path, &files[2].bytes);
        let present2 = present.clone();
        let (base, h) = mock(6, move |r| {
            let p = r.path.as_str();
            match (r.method.as_str(), p) {
                ("GET", "/accounts/0123456789abcdef0123456789abcdef/pages/projects/reviews") => {
                    ("200 OK", ok(json!({ "name": "reviews", "subdomain": "reviews-x1.pages.dev", "production_branch": "production" })))
                }
                ("GET", "/accounts/0123456789abcdef0123456789abcdef/pages/projects/reviews/upload-token") => {
                    ("200 OK", ok(json!({ "jwt": "jwt-abc" })))
                }
                ("POST", "/pages/assets/check-missing") => {
                    let v: Value = serde_json::from_slice(&r.body).unwrap();
                    let missing: Vec<&Value> = v["hashes"].as_array().unwrap().iter().filter(|h| h.as_str() != Some(present2.as_str())).collect();
                    ("200 OK", ok(json!(missing)))
                }
                ("POST", "/pages/assets/upload") => ("200 OK", ok(json!({ "successful_key_count": 2, "unsuccessful_keys": [] }))),
                ("POST", "/pages/assets/upsert-hashes") => ("200 OK", ok(json!(null))),
                ("POST", "/accounts/0123456789abcdef0123456789abcdef/pages/projects/reviews/deployments") => {
                    ("200 OK", ok(json!({ "id": "d1", "url": "https://abc123.reviews-x1.pages.dev" })))
                }
                _ => ("404 Not Found", json!({ "success": false, "errors": [{ "code": 7003, "message": "no route" }] }).to_string()),
            }
        });
        let out = deploy(&base, "cf-token-secret", ACCOUNT, "reviews", &files).unwrap();
        let reqs = h.join().unwrap();
        assert_eq!(
            out,
            Deployed {
                site_url: "https://reviews-x1.pages.dev".into(),
                deployment_url: "https://abc123.reviews-x1.pages.dev".into(),
                uploaded: 2,
            }
        );
        let order: Vec<&str> = reqs.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(order[2..5], ["/pages/assets/check-missing", "/pages/assets/upload", "/pages/assets/upsert-hashes"]);
        // API token for the account endpoints, JWT for the asset endpoints; neither in any URL.
        for r in &reqs {
            let want = if r.path.starts_with("/pages/assets") { "Bearer jwt-abc" } else { "Bearer cf-token-secret" };
            assert_eq!(r.auth, want, "{}", r.path);
            assert!(!r.path.contains("secret") && !r.path.contains("jwt"), "{}", r.path);
        }
        // Upload carries only the two missing files, base64 with content types.
        let up: Value = serde_json::from_slice(&reqs[3].body).unwrap();
        let up = up.as_array().unwrap();
        assert_eq!(up.len(), 2);
        assert!(up.iter().all(|e| e["base64"] == true && e["key"].as_str().unwrap().len() == 32));
        assert!(up.iter().any(|e| e["metadata"]["contentType"] == "text/html"));
        assert!(!up.iter().any(|e| e["key"] == present.as_str()));
        // Upsert lists every hash (3 distinct).
        let ups: Value = serde_json::from_slice(&reqs[4].body).unwrap();
        assert_eq!(ups["hashes"].as_array().unwrap().len(), 3);
        // Deployment: multipart with a manifest mapping every path to its hash.
        let d = &reqs[5];
        assert!(d.content_type.starts_with("multipart/form-data; boundary="));
        let body = String::from_utf8(d.body.clone()).unwrap();
        assert!(body.contains("name=\"manifest\""), "{body}");
        assert!(body.contains("name=\"branch\"\r\n\r\nproduction\r\n"), "{body}");
        let start = body.find('{').unwrap();
        let end = body[start..].find("\r\n").unwrap() + start;
        let m: Value = serde_json::from_str(&body[start..end]).unwrap();
        assert_eq!(m["/hookshot/shots/shot-p0001-1.jpg"], present.as_str());
        assert_eq!(m.as_object().unwrap().len(), 3);
    }

    /// First publish: project lookup 404 → project created, then the usual flow.
    #[test]
    fn deploy_creates_missing_project() {
        let (base, h) = mock(6, |r| match (r.method.as_str(), r.path.as_str()) {
            ("GET", p) if p.ends_with("/pages/projects/reviews") => (
                "404 Not Found",
                json!({ "success": false, "errors": [{ "code": 8000007, "message": "Project not found." }] }).to_string(),
            ),
            ("POST", p) if p.ends_with("/pages/projects") => {
                let v: Value = serde_json::from_slice(&r.body).unwrap();
                assert_eq!(v, json!({ "name": "reviews", "production_branch": "main" }));
                ("200 OK", ok(json!({ "name": "reviews", "subdomain": "reviews.pages.dev" })))
            }
            ("GET", p) if p.ends_with("/upload-token") => ("200 OK", ok(json!({ "jwt": "j" }))),
            ("POST", "/pages/assets/check-missing") => ("200 OK", ok(json!([]))),
            ("POST", "/pages/assets/upsert-hashes") => ("200 OK", ok(json!(null))),
            ("POST", p) if p.ends_with("/deployments") => ("200 OK", ok(json!({ "url": "https://d.reviews.pages.dev" }))),
            _ => ("500 Internal Server Error", "{}".into()),
        });
        // check-missing says nothing is missing → no upload call: 6 requests in all.
        let out = deploy(&base, "t", ACCOUNT, "reviews", &site()).unwrap();
        let reqs = h.join().unwrap();
        assert_eq!(out.site_url, "https://reviews.pages.dev");
        assert_eq!(out.uploaded, 0);
        assert!(!reqs.iter().any(|r| r.path == "/pages/assets/upload"));
        let d = String::from_utf8(reqs[5].body.clone()).unwrap();
        assert!(d.contains("name=\"branch\"\r\n\r\nmain\r\n"), "{d}");
    }

    #[test]
    fn errors_carry_api_message_not_token() {
        let token = "cf-SEKRIT-token-123";
        let (base, h) = mock(1, move |_| {
            (
                "403 Forbidden",
                json!({ "success": false, "errors": [{ "code": 10000, "message": format!("Authentication error for {}", "cf-SEKRIT-token-123") }] }).to_string(),
            )
        });
        let e = deploy(&base, token, ACCOUNT, "reviews", &site()).unwrap_err();
        h.join().unwrap();
        eprintln!("[cloudflare] 403 error string: {e}");
        assert!(e.contains("403") && e.contains("10000") && e.contains("Authentication error"), "{e}");
        assert!(!e.contains(token), "{e}");
        assert!(e.contains("[redacted]"), "{e}");
    }
}
