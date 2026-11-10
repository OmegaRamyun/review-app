//! OpenAI-compatible audio transcription (`/audio/transcriptions`, the shape
//! OpenAI and Groq both serve). Blocking (ureq); call from a blocking thread.
//! Multipart upload of one WAV chunk, `response_format=verbose_json` with
//! `timestamp_granularities[]=word`, parsed into the same `Word` shape
//! deepgram.rs produces. The API key is only ever placed in the
//! `Authorization` header — never in the URL, returned values, or errors.

use crate::deepgram::Word;
use std::time::Duration;

pub const OPENAI_BASE: &str = "https://api.openai.com/v1";
pub const GROQ_BASE: &str = "https://api.groq.com/openai/v1";
/// OpenAI: only whisper-1 returns word timestamps (the gpt-4o*-transcribe
/// models accept json/text only), so it is the default.
pub const OPENAI_DEFAULT_MODEL: &str = "whisper-1";
pub const GROQ_DEFAULT_MODEL: &str = "whisper-large-v3-turbo";

pub fn transcriptions_url(base: &str) -> String {
    format!("{}/audio/transcriptions", base.trim_end_matches('/'))
}

/// Build a multipart/form-data body. Returns (content-type header, body).
pub fn multipart_body(model: &str, audio: &[u8]) -> (String, Vec<u8>) {
    // Fixed boundary is fine: WAV bytes containing it would only matter if a
    // full CRLF--boundary line appeared inside the audio; make it long and odd.
    const B: &str = "----reviewapp-7f3a9c1e5b2d4086a1c3e5f7091b2d4f";
    let mut body = Vec::with_capacity(audio.len() + 1024);
    let field = |body: &mut Vec<u8>, name: &str, value: &str| {
        body.extend_from_slice(
            format!("--{B}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    };
    field(&mut body, "model", model);
    field(&mut body, "response_format", "verbose_json");
    field(&mut body, "timestamp_granularities[]", "word");
    body.extend_from_slice(
        format!(
            "--{B}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"chunk.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{B}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={B}"), body)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '\''
}

/// verbose_json `words[]` carry bare words; recover punctuation/casing from
/// the full `text` by walking it in order. A word that cannot be found keeps
/// its bare form (and the cursor stays put), so a mismatch never cascades.
fn punctuate(text: &str, words: &[String]) -> Vec<String> {
    let lower: Vec<char> = text.chars().flat_map(|c| c.to_lowercase()).collect();
    let orig: Vec<char> = text.chars().collect();
    // to_lowercase can change length for a few scripts; only align when it doesn't.
    if lower.len() != orig.len() {
        return words.to_vec();
    }
    let mut cur = 0usize;
    words
        .iter()
        .map(|w| {
            let needle: Vec<char> = w.trim().chars().flat_map(|c| c.to_lowercase()).collect();
            if needle.is_empty() {
                return w.clone();
            }
            // Search a bounded window ahead so a hallucinated word can't jump far.
            let limit = (cur + 200 + needle.len()).min(lower.len());
            let found = (cur..limit.saturating_sub(needle.len() - 1)).find(|&i| {
                lower[i..i + needle.len()] == needle[..]
                    && (i == 0 || !is_word_char(orig[i - 1]))
            });
            let Some(i) = found else {
                return w.trim().to_string();
            };
            let mut end = i + needle.len();
            while end < orig.len() && !orig[end].is_whitespace() && !is_word_char(orig[end]) {
                end += 1;
            }
            let mut start = i;
            while start > cur && !orig[start - 1].is_whitespace() && !is_word_char(orig[start - 1]) {
                start -= 1;
            }
            cur = end;
            orig[start..end].iter().collect()
        })
        .collect()
}

/// verbose_json → words, shifted by `offset_s`. `label` names the provider in errors.
pub fn parse_words(json: &str, offset_s: f64, label: &str) -> Result<Vec<Word>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("{label} response is not JSON: {e}"))?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(format!("{label} API error: {msg}"));
    }
    let arr = v
        .get("words")
        .and_then(|w| w.as_array())
        .ok_or_else(|| format!("{label} response has no word timestamps (words[]); does this model support timestamp_granularities=word?"))?;
    let mut bare = Vec::with_capacity(arr.len());
    let mut times = Vec::with_capacity(arr.len());
    for w in arr {
        let word = w.get("word").and_then(|x| x.as_str()).ok_or("word entry missing 'word'")?;
        let num = |k: &str| w.get(k).and_then(|x| x.as_f64());
        let start = num("start").ok_or("word entry missing 'start'")?;
        let end = num("end").ok_or("word entry missing 'end'")?;
        bare.push(word.trim().to_string());
        times.push((start, end));
    }
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let punct = punctuate(text, &bare);
    Ok(bare
        .into_iter()
        .zip(punct)
        .zip(times)
        .filter(|((w, _), _)| !w.is_empty())
        .map(|((word, punctuated_word), (start, end))| Word {
            word: word.to_lowercase(),
            punctuated_word,
            start: start + offset_s,
            end: end + offset_s,
            // verbose_json carries no per-word confidence (deepgram.rs uses 0.0 for missing too).
            confidence: 0.0,
        })
        .collect())
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

/// Upload one WAV chunk to `<base>/audio/transcriptions` and parse the words (offset 0).
pub fn send(
    base: &str,
    key: &str,
    audio: Vec<u8>,
    model: &str,
    default_model: &str,
    label: &str,
) -> Result<Vec<Word>, String> {
    let model = model.trim();
    let model = if model.is_empty() { default_model } else { model };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(Duration::from_secs(15 * 60)))
        .build()
        .into();
    let (content_type, body) = multipart_body(model, &audio);
    drop(audio);
    let redact = |s: String| if key.is_empty() { s } else { s.replace(key, "[redacted]") };
    let mut resp = agent
        .post(&transcriptions_url(base))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", &content_type)
        .send(&body[..])
        .map_err(|e| redact(format!("{label} request failed: {e}")))?;
    let status = resp.status();
    let body = resp
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("{label} response read failed (HTTP {}): {e}", status.as_u16()))?;
    if !status.is_success() {
        // Belt and braces: never echo the key, even if a server reflects it.
        return Err(format!("{label} HTTP {}: {}", status.as_u16(), truncate(&redact(body), 500)));
    }
    parse_words(&body, 0.0, label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const FIXTURE: &str = r#"{
      "task": "transcribe",
      "language": "english",
      "duration": 4.25,
      "text": "Okay, the jump feels floaty. Don't ship it.",
      "words": [
        {"word": "Okay", "start": 0.08, "end": 0.48},
        {"word": "the", "start": 0.64, "end": 0.8},
        {"word": "jump", "start": 0.8, "end": 1.12},
        {"word": "feels", "start": 1.12, "end": 1.44},
        {"word": "floaty", "start": 1.44, "end": 1.92},
        {"word": "Don't", "start": 2.1, "end": 2.4},
        {"word": "ship", "start": 2.4, "end": 2.7},
        {"word": "it", "start": 2.7, "end": 2.9}
      ],
      "segments": [{"id": 0, "start": 0.0, "end": 4.25, "text": "Okay, the jump feels floaty. Don't ship it."}],
      "x_groq": {"id": "req_01"}
    }"#;

    #[test]
    fn url_building() {
        assert_eq!(transcriptions_url(OPENAI_BASE), "https://api.openai.com/v1/audio/transcriptions");
        assert_eq!(transcriptions_url("https://api.groq.com/openai/v1/"), "https://api.groq.com/openai/v1/audio/transcriptions");
    }

    #[test]
    fn parses_fixture_with_offset_and_punctuation() {
        let w = parse_words(FIXTURE, 900.0, "Groq").unwrap();
        assert_eq!(w.len(), 8);
        assert_eq!(w[0].word, "okay");
        assert_eq!(w[0].punctuated_word, "Okay,");
        assert_eq!(w[1].punctuated_word, "the");
        assert_eq!(w[4].punctuated_word, "floaty.");
        assert_eq!(w[5].punctuated_word, "Don't");
        assert_eq!(w[7].punctuated_word, "it.");
        assert!((w[0].start - 900.08).abs() < 1e-9);
        assert!((w[7].end - 902.9).abs() < 1e-9);
    }

    #[test]
    fn punctuation_survives_mismatch() {
        // A word missing from text keeps its bare form; later words still align.
        let p = punctuate("Hello, world. Bye!", &["hello".into(), "zzz".into(), "world".into(), "bye".into()]);
        assert_eq!(p, ["Hello,", "zzz", "world.", "Bye!"]);
        // No text at all: bare words.
        assert_eq!(punctuate("", &["a".into()]), ["a"]);
        // Substring inside a longer word is not a match ("he" in "the").
        assert_eq!(punctuate("the he.", &["he".into()]), ["he."]);
    }

    #[test]
    fn parses_error_and_garbage() {
        let e = parse_words(r#"{"error":{"message":"Invalid API Key","type":"invalid_request_error"}}"#, 0.0, "Groq")
            .unwrap_err();
        assert!(e.contains("Groq API error: Invalid API Key"), "{e}");
        // json response_format (no words[]) — e.g. a gpt-4o-*-transcribe model.
        let e = parse_words(r#"{"text":"hi"}"#, 0.0, "OpenAI").unwrap_err();
        assert!(e.contains("no word timestamps"), "{e}");
        assert!(parse_words("not json", 0.0, "OpenAI").is_err());
        assert!(parse_words(r#"{"words":[{"word":"a"}]}"#, 0.0, "OpenAI").is_err());
        assert!(parse_words(r#"{"words":[]}"#, 0.0, "OpenAI").unwrap().is_empty());
    }

    struct Captured {
        request_line: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    /// One-shot HTTP/1.1 server on 127.0.0.1; returns (base_url, join handle).
    fn mock_server(status: &'static str, reply: String) -> (String, std::thread::JoinHandle<Captured>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut r = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            r.read_line(&mut request_line).unwrap();
            let mut headers = Vec::new();
            loop {
                let mut l = String::new();
                r.read_line(&mut l).unwrap();
                let l = l.trim_end();
                if l.is_empty() {
                    break;
                }
                let (k, v) = l.split_once(':').unwrap();
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
            let n: usize = headers
                .iter()
                .find(|(k, _)| k == "content-length")
                .map(|(_, v)| v.parse().unwrap())
                .unwrap_or(0);
            let mut body = vec![0u8; n];
            r.read_exact(&mut body).unwrap();
            let mut w = stream;
            write!(
                w,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            )
            .unwrap();
            w.flush().unwrap();
            Captured { request_line: request_line.trim_end().to_string(), headers, body }
        });
        (base, h)
    }

    /// Split a multipart body into (name, filename, content-type, data) parts.
    fn parts(content_type: &str, body: &[u8]) -> Vec<(String, Option<String>, Option<String>, Vec<u8>)> {
        let boundary = content_type.split("boundary=").nth(1).unwrap();
        let delim = format!("\r\n--{boundary}").into_bytes();
        // Prepend CRLF so the first delimiter matches like the rest.
        let mut buf = b"\r\n".to_vec();
        buf.extend_from_slice(body);
        let mut out = Vec::new();
        let find = |hay: &[u8], from: usize| hay[from..].windows(delim.len()).position(|w| w == &delim[..]).map(|p| p + from);
        let mut cur = find(&buf, 0).unwrap();
        loop {
            let mut pos = cur + delim.len();
            if buf[pos..].starts_with(b"--") {
                break;
            }
            pos += 2; // CRLF after boundary
            let next = find(&buf, pos).unwrap();
            let part = &buf[pos..next];
            let hdr_end = part.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let hdrs = String::from_utf8(part[..hdr_end].to_vec()).unwrap();
            let data = part[hdr_end + 4..].to_vec();
            let attr = |k: &str| hdrs.split(&format!("{k}=\"")).nth(1).map(|s| s.split('"').next().unwrap().to_string());
            let ctype = hdrs.lines().find_map(|l| l.strip_prefix("Content-Type: ").map(str::to_string));
            out.push((attr("name").unwrap(), attr("filename"), ctype, data));
            cur = next;
        }
        out
    }

    #[test]
    fn send_end_to_end_against_mock() {
        let (base, h) = mock_server("200 OK", FIXTURE.to_string());
        // Audio containing CRLF and dashes, to prove the framing holds.
        let mut audio: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        audio.extend_from_slice(b"\r\n--not-the-boundary\r\n");
        let words = send(&base, "testkey", audio.clone(), "", GROQ_DEFAULT_MODEL, "Groq").unwrap();
        let c = h.join().unwrap();
        let hdr = |k: &str| c.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());

        let mut rl = c.request_line.split_whitespace();
        assert_eq!(rl.next(), Some("POST"));
        assert_eq!(rl.next(), Some("/audio/transcriptions"));
        assert!(!c.request_line.contains("testkey"));
        assert_eq!(hdr("authorization"), Some("Bearer testkey"));
        let ct = hdr("content-type").unwrap();
        assert!(ct.starts_with("multipart/form-data; boundary="), "{ct}");
        let p = parts(ct, &c.body);
        let get = |n: &str| p.iter().find(|x| x.0 == n).unwrap();
        assert_eq!(get("model").3, b"whisper-large-v3-turbo");
        assert_eq!(get("response_format").3, b"verbose_json");
        assert_eq!(get("timestamp_granularities[]").3, b"word");
        let f = get("file");
        assert_eq!(f.1.as_deref(), Some("chunk.wav"));
        assert_eq!(f.2.as_deref(), Some("audio/wav"));
        assert_eq!(f.3, audio);
        assert!(!String::from_utf8_lossy(&c.body).contains("testkey"));
        assert_eq!(words.len(), 8);
        assert_eq!(words[4].punctuated_word, "floaty.");
    }

    #[test]
    fn send_uses_given_model() {
        let (base, h) = mock_server("200 OK", FIXTURE.to_string());
        send(&base, "k", vec![1, 2, 3], " whisper-1 ", OPENAI_DEFAULT_MODEL, "OpenAI").unwrap();
        let c = h.join().unwrap();
        let ct = c.headers.iter().find(|(n, _)| n == "content-type").unwrap().1.clone();
        let p = parts(&ct, &c.body);
        assert_eq!(p.iter().find(|x| x.0 == "model").unwrap().3, b"whisper-1");
    }

    #[test]
    fn send_errors_report_status_not_key() {
        let key = "gsk_sekrit-key-123";
        let (base, h) = mock_server(
            "401 Unauthorized",
            format!(r#"{{"error":{{"message":"Invalid API Key: {key}","type":"invalid_request_error"}}}}"#),
        );
        let err = send(&base, key, vec![1, 2, 3], "", GROQ_DEFAULT_MODEL, "Groq").unwrap_err();
        h.join().unwrap();
        eprintln!("[whisper_api] 401 error string: {err}");
        assert!(err.starts_with("Groq HTTP 401"), "{err}");
        assert!(err.contains("[redacted]"), "{err}");
        assert!(!err.contains(key), "{err}");
    }
}
