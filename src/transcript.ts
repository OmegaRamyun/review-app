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
