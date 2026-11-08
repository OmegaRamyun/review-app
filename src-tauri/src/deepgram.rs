//! Deepgram prerecorded transcription. Blocking (ureq); call from a blocking
//! thread. The API key is only ever placed in the Authorization header —
//! it never appears in returned values or error strings.

use serde::Serialize;
use std::time::Duration;

pub const API_BASE: &str = "https://api.deepgram.com";
pub const DEFAULT_MODEL: &str = "nova-3";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Word {
    pub word: String,
    pub punctuated_word: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
}

pub fn listen_url(base: &str, model: &str) -> String {
    let model = model.trim();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    const QUERY: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.');
    let model = percent_encoding::utf8_percent_encode(model, QUERY);
    format!(
        "{}/v1/listen?model={}&smart_format=true&punctuate=true",
        base.trim_end_matches('/'),
        model
    )
}

/// Extract `results.channels[0].alternatives[0].words[]`, shifting times by
/// `offset_s` (the chunk's position in the full recording).
pub fn parse_words(json: &str, offset_s: f64) -> Result<Vec<Word>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Deepgram response is not JSON: {e}"))?;
    let words = v
        .pointer("/results/channels/0/alternatives/0/words")
        .and_then(|w| w.as_array())
        .ok_or("Deepgram response has no results.channels[0].alternatives[0].words")?;
    words
        .iter()
        .map(|w| {
            let word = w
                .get("word")
                .and_then(|x| x.as_str())
                .ok_or("word entry missing 'word'")?
                .to_string();
            let num = |k: &str| w.get(k).and_then(|x| x.as_f64());
            Ok(Word {
                punctuated_word: w
                    .get("punctuated_word")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| word.clone()),
                start: num("start").ok_or("word entry missing 'start'")? + offset_s,
                end: num("end").ok_or("word entry missing 'end'")? + offset_s,
                confidence: num("confidence").unwrap_or(0.0),
                word,
            })
        })
        .collect()
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

/// POST raw WAV bytes to `<base>/v1/listen` and parse the words (offset 0).
pub fn send(base: &str, key: &str, audio: Vec<u8>, model: &str) -> Result<Vec<Word>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(Duration::from_secs(15 * 60)))
        .build()
        .into();
    let mut resp = agent
        .post(&listen_url(base, model))
        .header("Authorization", &format!("Token {key}"))
        .header("Content-Type", "audio/wav")
        .send(&audio[..])
        .map_err(|e| format!("Deepgram request failed: {e}"))?;
    let status = resp.status();
    let body = resp
        .body_mut()
        .with_config()
        .limit(256 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("Deepgram response read failed (HTTP {}): {e}", status.as_u16()))?;
    if !status.is_success() {
        // Belt and braces: never echo the key, even if a server reflects it.
        let body = if key.is_empty() { body } else { body.replace(key, "[redacted]") };
        return Err(format!("Deepgram HTTP {}: {}", status.as_u16(), truncate(&body, 500)));
    }
    parse_words(&body, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const FIXTURE: &str = r#"{
      "metadata": {
        "transaction_key": "deprecated",
        "request_id": "5e4e3c3b-1a2b-4c5d-9e8f-0123456789ab",
        "sha256": "3b2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f",
        "created": "2026-11-08T21:14:03.512Z",
        "duration": 4.25,
        "channels": 1,
        "models": ["2187e11a-3532-4498-b076-81fa530bdd49"],
        "model_info": {
          "2187e11a-3532-4498-b076-81fa530bdd49": {
            "name": "general-nova-3", "version": "2024-12-20.0", "arch": "nova-3"
          }
        }
      },
      "results": {
        "channels": [{
          "alternatives": [{
            "transcript": "Okay, the jump feels floaty.",
            "confidence": 0.9951172,
            "words": [
              {"word": "okay", "start": 0.08, "end": 0.48, "confidence": 0.99, "punctuated_word": "Okay,"},
              {"word": "the", "start": 0.64, "end": 0.8, "confidence": 0.998},
              {"word": "jump", "start": 0.8, "end": 1.12, "confidence": 0.997, "punctuated_word": "jump"},
              {"word": "feels", "start": 1.12, "end": 1.44, "confidence": 0.995, "punctuated_word": "feels"},
              {"word": "floaty", "start": 1.44, "end": 1.92, "confidence": 0.912, "punctuated_word": "floaty."}
            ],
            "paragraphs": {
              "transcript": "\nOkay, the jump feels floaty.",
              "paragraphs": [{"sentences": [{"text": "Okay, the jump feels floaty.", "start": 0.08, "end": 1.92}],
                "num_words": 5, "start": 0.08, "end": 1.92}]
            }
          }]
        }]
      }
    }"#;

    #[test]
    fn url_building() {
        assert_eq!(
            listen_url("https://api.deepgram.com", ""),
            "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true"
        );
        assert!(listen_url("http://x/", " nova-2 ").starts_with("http://x/v1/listen?model=nova-2&"));
        assert!(listen_url("http://x", "a&b=c").contains("model=a%26b%3Dc&"));
    }

    #[test]
    fn parses_fixture_with_offset() {
        let w = parse_words(FIXTURE, 900.0).unwrap();
        assert_eq!(w.len(), 5);
        assert_eq!(w[0].word, "okay");
        assert_eq!(w[0].punctuated_word, "Okay,");
        assert!((w[0].start - 900.08).abs() < 1e-9);
        assert!((w[4].end - 901.92).abs() < 1e-9);
        assert_eq!(w[1].punctuated_word, "the"); // fallback to word
        assert!((w[4].confidence - 0.912).abs() < 1e-9);
        assert!(parse_words("{\"results\":{}}", 0.0).is_err());
        assert!(parse_words("not json", 0.0).is_err());
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

    #[test]
    fn send_end_to_end_against_mock() {
        let (base, h) = mock_server("200 OK", FIXTURE.to_string());
        let audio: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        let words = send(&base, "testkey", audio.clone(), "").unwrap();
        let c = h.join().unwrap();
        let hdr = |k: &str| c.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());

        let mut parts = c.request_line.split_whitespace();
        assert_eq!(parts.next(), Some("POST"));
        let target = parts.next().unwrap();
        let (path, query) = target.split_once('?').unwrap();
        assert_eq!(path, "/v1/listen");
        let model = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("model="))
            .map(|m| percent_encoding::percent_decode_str(m).decode_utf8_lossy().into_owned());
        assert_eq!(model.as_deref(), Some("nova-3"));
        assert!(query.contains("smart_format=true") && query.contains("punctuate=true"));
        assert_eq!(hdr("authorization"), Some("Token testkey"));
        assert_eq!(hdr("content-type"), Some("audio/wav"));
        assert_eq!(c.body, audio);
        assert_eq!(words.len(), 5);
        assert_eq!(words[4].punctuated_word, "floaty.");
    }

    #[test]
    fn send_401_reports_status_not_key() {
        let key = "sekrit-key-123";
        let (base, h) = mock_server(
            "401 Unauthorized",
            format!(r#"{{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials. token={key}"}}"#),
        );
        let err = send(&base, key, vec![1, 2, 3], "nova-3").unwrap_err();
        h.join().unwrap();
        eprintln!("[deepgram] 401 error string: {err}");
        assert!(err.contains("401"), "{err}");
        assert!(err.contains("INVALID_AUTH"), "{err}");
        assert!(!err.contains(key), "{err}");
    }
}
