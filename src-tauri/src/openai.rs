//! OpenAI-compatible chat completions (text in, JSON text out). Blocking
//! (ureq); call from a blocking thread. Works for api.openai.com and any
//! OpenAI-compatible base URL (NanoGPT, OpenRouter, a local server…).
//! The API key is only ever placed in the `Authorization` header — never in
//! the URL, returned values, or errors.

use std::time::Duration;

pub const API_BASE: &str = "https://api.openai.com/v1";
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";

pub fn completions_url(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

pub fn request_body(model: &str, system: &str, prompt: &str) -> serde_json::Value {
    let model = model.trim();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.7
    })
}

/// `choices[0].message.content`.
pub fn parse_text(json: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("OpenAI response is not JSON: {e}"))?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(format!("OpenAI API error: {msg}"));
    }
    let text = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return Err("OpenAI response has no text".into());
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

/// POST a chat completions request and return the model's text.
pub fn send(base: &str, key: &str, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into();
    let body = serde_json::to_vec(&request_body(model, system, prompt)).map_err(|e| e.to_string())?;
    let mut resp = agent
        .post(&completions_url(base))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(&body[..])
        .map_err(|e| {
            let msg = format!("OpenAI request failed: {e}");
            if key.is_empty() { msg } else { msg.replace(key, "[redacted]") }
        })?;
    let status = resp.status();
    let body = resp
        .body_mut()
        .with_config()
        .limit(8 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("OpenAI response read failed (HTTP {}): {e}", status.as_u16()))?;
    if !status.is_success() {
        // Belt and braces: never echo the key, even if a server reflects it.
        let body = if key.is_empty() { body } else { body.replace(key, "[redacted]") };
        return Err(format!("OpenAI HTTP {}: {}", status.as_u16(), truncate(&body, 500)));
    }
    parse_text(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const FIXTURE: &str = r#"{
      "id": "chatcmpl-123",
      "choices": [{
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "{\"sections\": {\"feel\": \"Jump feels floaty\"}}"
        },
        "finish_reason": "stop"
      }],
      "usage": {"prompt_tokens": 412, "completion_tokens": 27, "total_tokens": 439}
    }"#;

    #[test]
    fn url_building() {
        assert_eq!(completions_url(API_BASE), "https://api.openai.com/v1/chat/completions");
        assert_eq!(completions_url("https://nano-gpt.com/api/v1/"), "https://nano-gpt.com/api/v1/chat/completions");
    }

    #[test]
    fn parses_fixture() {
        assert_eq!(
            parse_text(FIXTURE).unwrap(),
            r#"{"sections": {"feel": "Jump feels floaty"}}"#
        );
    }

    #[test]
    fn parses_error_and_garbage() {
        let e = parse_text(r#"{"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}"#)
            .unwrap_err();
        assert!(e.contains("Incorrect API key"), "{e}");
        assert!(parse_text("not json").is_err());
        assert!(parse_text("{}").is_err());
        assert!(parse_text(r#"{"choices": []}"#).is_err());
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
        assert_eq!(parts.next(), Some("/chat/completions"));
        assert!(!c.request_line.contains("testkey"));
        assert_eq!(hdr("authorization"), Some("Bearer testkey"));
        assert_eq!(hdr("content-type"), Some("application/json"));
        let sent: serde_json::Value = serde_json::from_slice(&c.body).unwrap();
        assert_eq!(sent.pointer("/model"), Some(&"gpt-4o-mini".into()));
        assert_eq!(sent.pointer("/messages/0/role"), Some(&"system".into()));
        assert_eq!(sent.pointer("/messages/0/content"), Some(&"You are terse.".into()));
        assert_eq!(sent.pointer("/messages/1/content"), Some(&"Summarize: jump floaty".into()));
        assert_eq!(sent.pointer("/response_format/type"), Some(&"json_object".into()));
        assert!(text.starts_with(r#"{"sections""#), "{text}");
    }

    #[test]
    fn send_errors_report_status_not_key() {
        let key = "sk-sekrit-key-123";
        let (base, h) = mock_server(
            "401 Unauthorized",
            format!(r#"{{"error":{{"message":"Incorrect API key provided: {key}","type":"invalid_request_error"}}}}"#),
        );
        let err = send(&base, key, "gpt-4o-mini", "s", "p").unwrap_err();
        h.join().unwrap();
        eprintln!("[openai] 401 error string: {err}");
        assert!(err.contains("401"), "{err}");
        assert!(err.contains("[redacted]"), "{err}");
        assert!(!err.contains(key), "{err}");
    }
}
