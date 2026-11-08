//! Gemini generateContent (text in, JSON text out). Blocking (ureq); call
//! from a blocking thread. The API key is only ever placed in the
//! `x-goog-api-key` header — never in the URL, returned values, or errors.

use std::time::Duration;

pub const API_BASE: &str = "https://generativelanguage.googleapis.com";
pub const DEFAULT_MODEL: &str = "gemini-2.5-flash";

pub fn generate_url(base: &str, model: &str) -> String {
    let model = model.trim();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.');
    let model = percent_encoding::utf8_percent_encode(model, SEGMENT);
    format!("{}/v1beta/models/{}:generateContent", base.trim_end_matches('/'), model)
}

pub fn request_body(system: &str, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "responseMimeType": "application/json", "temperature": 0.7 }
    })
}

/// Concatenate `candidates[0].content.parts[*].text`.
pub fn parse_text(json: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Gemini response is not JSON: {e}"))?;
    let Some(cand) = v.pointer("/candidates/0") else {
        if let Some(r) = v.pointer("/promptFeedback/blockReason").and_then(|x| x.as_str()) {
            return Err(format!("Gemini blocked the prompt: {r}"));
        }
        return Err("Gemini response has no candidates".into());
    };
    let text: String = cand
        .pointer("/content/parts")
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect()
        })
        .unwrap_or_default();
    if text.is_empty() {
        return match cand.get("finishReason").and_then(|x| x.as_str()) {
            Some(r) if r != "STOP" && r != "MAX_TOKENS" => {
                Err(format!("Gemini returned no text (finishReason {r})"))
            }
            _ => Err("Gemini response has no text".into()),
        };
    }
    Ok(text)
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

/// POST a generateContent request and return the model's text.
pub fn send(base: &str, key: &str, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into();
    let body = serde_json::to_vec(&request_body(system, prompt)).map_err(|e| e.to_string())?;
    let mut resp = agent
        .post(&generate_url(base, model))
        .header("x-goog-api-key", key)
        .header("Content-Type", "application/json")
        .send(&body[..])
        .map_err(|e| {
            let msg = format!("Gemini request failed: {e}");
            if key.is_empty() { msg } else { msg.replace(key, "[redacted]") }
        })?;
    let status = resp.status();
    let body = resp
        .body_mut()
        .with_config()
        .limit(8 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("Gemini response read failed (HTTP {}): {e}", status.as_u16()))?;
    if !status.is_success() {
        // Belt and braces: never echo the key, even if a server reflects it.
        let body = if key.is_empty() { body } else { body.replace(key, "[redacted]") };
        return Err(format!("Gemini HTTP {}: {}", status.as_u16(), truncate(&body, 500)));
    }
    parse_text(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const FIXTURE: &str = r#"{
      "candidates": [{
        "content": {
          "parts": [
            {"text": "{\"title\": \"Jump feels floaty\", "},
            {"text": "\"points\": [\"lower apex hang time\"]}"}
          ],
          "role": "model"
        },
        "finishReason": "STOP",
        "avgLogprobs": -0.21843
      }],
      "usageMetadata": {
        "promptTokenCount": 412,
        "candidatesTokenCount": 27,
        "totalTokenCount": 439,
        "promptTokensDetails": [{"modality": "TEXT", "tokenCount": 412}],
        "thoughtsTokenCount": 118
      },
      "modelVersion": "gemini-2.5-flash",
      "responseId": "q8kNaZ2xKfOz7M8P1a3a-QM"
    }"#;

    const BLOCKED: &str = r#"{
      "promptFeedback": {
        "blockReason": "SAFETY",
        "safetyRatings": [{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "probability": "HIGH"}]
      },
      "usageMetadata": {"promptTokenCount": 9, "totalTokenCount": 9},
      "modelVersion": "gemini-2.5-flash"
    }"#;

    #[test]
    fn url_building() {
        assert_eq!(
            generate_url(API_BASE, ""),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert_eq!(
            generate_url("http://x/", " gemini-2.5-pro "),
            "http://x/v1beta/models/gemini-2.5-pro:generateContent"
        );
        assert_eq!(generate_url("http://x", "a/b?c"), "http://x/v1beta/models/a%2Fb%3Fc:generateContent");
    }

    #[test]
    fn parses_fixture() {
        assert_eq!(
            parse_text(FIXTURE).unwrap(),
            r#"{"title": "Jump feels floaty", "points": ["lower apex hang time"]}"#
        );
    }

    #[test]
    fn parses_blocked_and_garbage() {
        let e = parse_text(BLOCKED).unwrap_err();
        assert!(e.contains("SAFETY"), "{e}");
        let e = parse_text(r#"{"candidates":[{"finishReason":"RECITATION","content":{"parts":[]}}]}"#)
            .unwrap_err();
        assert!(e.contains("RECITATION"), "{e}");
        assert!(parse_text("not json").is_err());
        assert!(parse_text("{}").is_err());
        assert!(parse_text(r#"{"candidates":[{"finishReason":"STOP"}]}"#).is_err());
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
        let text = send(&base, "testkey", "", "You are terse.", "Summarize: jump floaty").unwrap();
        let c = h.join().unwrap();
        let hdr = |k: &str| c.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());

        let mut parts = c.request_line.split_whitespace();
        assert_eq!(parts.next(), Some("POST"));
        assert_eq!(parts.next(), Some("/v1beta/models/gemini-2.5-flash:generateContent"));
        assert!(!c.request_line.contains("testkey"));
        assert_eq!(hdr("x-goog-api-key"), Some("testkey"));
        assert_eq!(hdr("content-type"), Some("application/json"));
        let sent: serde_json::Value = serde_json::from_slice(&c.body).unwrap();
        assert_eq!(sent.pointer("/systemInstruction/parts/0/text"), Some(&"You are terse.".into()));
        assert_eq!(sent.pointer("/contents/0/role"), Some(&"user".into()));
        assert_eq!(sent.pointer("/contents/0/parts/0/text"), Some(&"Summarize: jump floaty".into()));
        assert_eq!(
            sent.pointer("/generationConfig/responseMimeType"),
            Some(&"application/json".into())
        );
        assert!(text.starts_with(r#"{"title""#), "{text}");
    }

    #[test]
    fn send_errors_report_status_not_key() {
        let key = "AIzaSy-sekrit-key-123";
        for (status, code) in [("400 Bad Request", "400"), ("403 Forbidden", "403")] {
            let (base, h) = mock_server(
                status,
                format!(
                    r#"{{"error":{{"code":{code},"message":"API key not valid: {key}","status":"INVALID_ARGUMENT"}}}}"#
                ),
            );
            let err = send(&base, key, "gemini-2.5-flash", "s", "p").unwrap_err();
            h.join().unwrap();
            eprintln!("[gemini] {code} error string: {err}");
            assert!(err.contains(code), "{err}");
            assert!(err.contains("[redacted]"), "{err}");
            assert!(!err.contains(key), "{err}");
        }
    }
}
