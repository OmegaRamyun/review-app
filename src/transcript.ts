// Pure transcript logic: no DOM, no Tauri, no Mediabunny, so `node --test` can
// exercise it directly (see transcript.test.mjs).

/** One Deepgram word, already shifted onto the recording's timeline. */
export interface Word {
  word: string;
  punctuated_word: string;
  start: number;
  end: number;
  confidence: number;
}

/** A clickable transcript line: a run of words. */
export interface Line {
  start: number;
  end: number;
  text: string;
  /** Index of the first word in the session's flat word list. */
  firstWord: number;
}

/** ~18 min chunks: inside DESIGN.md's 15–20 min band, ~35 MB of 16 kHz mono s16 WAV each. */
export const CHUNK_SECONDS = 18 * 60;

/** Split [0, duration) into chunk ranges. A short tail (< 60 s) folds into the previous chunk. */
export function chunkRanges(duration: number, chunk = CHUNK_SECONDS): { start: number; end: number }[] {
  if (!(duration > 0)) return [];
  const out: { start: number; end: number }[] = [];
  for (let s = 0; s < duration; s += chunk) out.push({ start: s, end: Math.min(s + chunk, duration) });
  const last = out[out.length - 1];
  if (out.length > 1 && last.end - last.start < 60) {
    out.pop();
    out[out.length - 1].end = duration;
  }
  return out;
}

/**
 * Group words into lines: break after sentence-ending punctuation, on a pause
 * longer than `gap` seconds, or once a line reaches `maxWords`.
 */
export function groupLines(words: Word[], gap = 1.2, maxWords = 16): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  let count = 0;
  words.forEach((w, i) => {
    const text = w.punctuated_word || w.word;
    if (cur && (w.start - cur.end > gap || count >= maxWords)) {
      lines.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { start: w.start, end: w.end, text, firstWord: i };
      count = 1;
    } else {
      cur.text += " " + text;
      cur.end = w.end;
      count++;
    }
    if (/[.?!]$/.test(text)) {
      lines.push(cur);
      cur = null;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

/** Index of the line playing at time t (last line with start <= t), or -1 before the first. */
export function lineAt(lines: Line[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Default mic track (1-based): the remembered choice if still valid, else Track 2, else the last track. */
export function defaultMicTrack(trackCount: number, remembered: number | null): number {
  if (remembered !== null && remembered >= 1 && remembered <= trackCount) return remembered;
  if (trackCount >= 2) return 2;
  return trackCount;
}

/** Nova-3 prerecorded list price per DESIGN.md (~$0.0043/min; verify in the Deepgram Console). */
export const USD_PER_MINUTE = 0.0043;

export function costCents(seconds: number, usdPerMinute = USD_PER_MINUTE): number {
  return (seconds / 60) * usdPerMinute * 100;
}

export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ---------- transcription providers ----------

export type TrProvider = "deepgram" | "openai" | "groq" | "local";
export const TR_PROVIDERS: readonly TrProvider[] = ["deepgram", "openai", "groq", "local"];

export interface TrProviderMeta {
  /** Display name, used in error text ("Enter your Groq API key…"). */
  name: string;
  defaultModel: string;
  /** Seconds of mic audio per chunk. OpenAI + Groq cap uploads at 25 MB: 12 min of 16 kHz s16 mono ≈ 23 MB. */
  chunkSeconds: number;
  /** List price of the default model, USD per minute (0 = free / on-device). */
  usdPerMinute: number;
  keyLink: string;
  keyLinkText: string;
}

export const TR_META: Record<TrProvider, TrProviderMeta> = {
  deepgram: { name: "Deepgram", defaultModel: "nova-3", chunkSeconds: CHUNK_SECONDS, usdPerMinute: USD_PER_MINUTE, keyLink: "https://console.deepgram.com/", keyLinkText: "get a key ↗" },
  // whisper-1 is OpenAI's only model with word timestamps (gpt-4o*-transcribe return json text only). $0.006/min.
  openai: { name: "OpenAI", defaultModel: "whisper-1", chunkSeconds: 12 * 60, usdPerMinute: 0.006, keyLink: "https://platform.openai.com/api-keys", keyLinkText: "get a key ↗" },
  // whisper-large-v3-turbo: $0.04/hour (Groq bills a 10 s minimum per request).
  groq: { name: "Groq", defaultModel: "whisper-large-v3-turbo", chunkSeconds: 12 * 60, usdPerMinute: 0.04 / 60, keyLink: "https://console.groq.com/keys", keyLinkText: "get a key ↗" },
  local: { name: "Local Whisper", defaultModel: "Xenova/whisper-tiny", chunkSeconds: CHUNK_SECONDS, usdPerMinute: 0, keyLink: "", keyLinkText: "" },
};

export const LOCAL_MODELS: readonly string[] = ["Xenova/whisper-tiny", "Xenova/whisper-base", "Xenova/whisper-small"];

/** Unknown / missing provider strings fall back to Deepgram (the original provider). */
export function trProviderOf(v: string | null | undefined): TrProvider {
  return (TR_PROVIDERS as readonly string[]).includes(v ?? "") ? (v as TrProvider) : "deepgram";
}

/** Local runs only the offered models; anything else (a stale value) becomes the default. */
export function localModelOf(v: string | null | undefined): string {
  return LOCAL_MODELS.includes(v ?? "") ? (v as string) : TR_META.local.defaultModel;
}

/**
 * Keep already-transcribed chunks only for the same provider + model + mic track.
 * transcript.json files written before providers existed have no `provider`: they were Deepgram.
 */
export function canResume(
  saved: { provider?: string; model: string; chunks: unknown[] } | null,
  savedTrack: number,
  provider: TrProvider,
  model: string,
  track: number,
): boolean {
  return !!saved && saved.chunks.length > 0 && savedTrack === track &&
    trProviderOf(saved.provider) === provider && saved.model === model;
}

/** A 16-bit PCM WAV (what extractMicWav writes) → mono Float32 samples in [-1, 1) + its sample rate. */
export function wavToFloat32(buf: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let fmt: { channels: number; rate: number; bits: number; format: number } | null = null;
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === "fmt ") {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`);
      // Mediabunny may write 0 / 0xFFFFFFFF as a streaming placeholder: clamp to what is there.
      const len = Math.min(size === 0 ? Infinity : size, buf.byteLength - body);
      const frames = Math.floor(len / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += v.getInt16(body + (i * fmt.channels + c) * 2, true);
        out[i] = sum / fmt.channels / 32768;
      }
      return { samples: out, sampleRate: fmt.rate };
    }
    o = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

/**
 * transformers.js ASR output with `return_timestamps: "word"` (`chunks: [{ text, timestamp: [start, end] }]`)
 * → the same Word shape Deepgram produces, shifted by `offset` (the chunk's place in the recording).
 * A missing end (the final word of a cut-off window) borrows its start; a missing start is dropped.
 */
export function wordsFromWhisper(
  chunks: { text: string; timestamp: [number | null, number | null] }[],
  offset: number,
): Word[] {
  const out: Word[] = [];
  for (const c of chunks) {
    const punctuated = c.text.trim();
    const [s, e] = c.timestamp;
    if (!punctuated || s === null || !Number.isFinite(s)) continue;
    const end = e !== null && Number.isFinite(e) && e >= s ? e : s;
    const bare = punctuated.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
    out.push({ word: bare || punctuated.toLowerCase(), punctuated_word: punctuated, start: s + offset, end: end + offset, confidence: 0 });
  }
  return out;
}
