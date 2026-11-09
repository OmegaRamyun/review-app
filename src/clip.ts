// U6 Compress-clip: the Compression Protocol presets, ported from Clip Sizer's
// hardware (WebCodecs + Mediabunny) engine (~/workspace/clip-sizer/index.html,
// v44). Pure math only — no Mediabunny import, so it unit-tests under node.
// Values are Clip Sizer's code constants (not its README prose, which lags);
// NOTES.md records them.

/** Discord: 19 MB budget, 19.9 MB hard cap (Discord's limit is 20 MB). */
export const DISCORD_TARGET = 19e6;
export const DISCORD_CAP = 19.9e6;
/** 4chan: 4.09 MB budget, 4 MiB hard cap (4,194,304 B). */
export const CHAN_TARGET = 4.09e6;
export const CHAN_CAP = 4194304;
export const AUDIO_KBPS = 128;
export const FPS = 30;
/** VP9 key frame interval in seconds (Clip Sizer: `keyFrameInterval: 20`). */
export const CHAN_KEYFRAME_S = 20;
export const DISCORD_MIN_KBPS = 80;
export const CHAN_MIN_KBPS = 70;
/** Capped outputs re-encode at most this many times when the file lands over its cap. */
export const MAX_RETRIES = 2;
/** Past this, the 4chan budget starves (Clip Sizer's confirm threshold). */
export const STARVE_WARN_S = 45;
/** 2:20 = X's limit; Shorts 3:00, Reels 3:00 for reach, TikTok 10:00. */
export const SOCIALS_MAX_LEN = 140;
/** [below this kb/s, max long-side px]; else the output's own cap. Clip Sizer "Mixed" (thresholdScale 1). */
export const RES_TIERS: readonly [number, number][] = [[180, 360], [350, 480], [650, 720]];

export const SOCIAL_SHAPES = [
  { id: "horizontal", label: "Horizontal", w: 1920, h: 1080, kbps: 8000 },
  { id: "vertical", label: "Vertical", w: 1080, h: 1920, kbps: 8000 },
  { id: "square", label: "Square", w: 1080, h: 1080, kbps: 8000 },
] as const;

/** How a Socials shape is filled from a frame of another shape. Discord/4chan always keep the clip's shape. */
export type BgMode = "fit" | "fill" | "gradient";

export const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
export const evenDown = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
export const evenRound = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Vertical frames: the fitted clip's centre sits 40% down (eye-gaze height); others centred. */
export const gazeY = (tw: number, th: number, sh: number) =>
  tw < th ? Math.max(0, evenDown(0.4 * th - sh / 2)) : evenDown((th - sh) / 2);

/** Resolution tier from available video bitrate, never upscaling. */
export function dimensionsFor(maxKbps: number, w: number, h: number, cap: number): [number, number] {
  let maxDim = cap;
  for (const [kbps, dim] of RES_TIERS) {
    if (maxKbps < kbps) {
      maxDim = dim;
      break;
    }
  }
  maxDim = Math.min(maxDim, cap);
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return [even(w * scale), even(h * scale)];
}

/** 4chan frame rule: long side aimed at 1280, floored at 960 when the source is ≥960 on its long side. */
export function chanClamp(w: number, h: number, srcW: number, srcH: number): [number, number] {
  const m = Math.max(w, h);
  if (m <= 0) return [w, h];
  if (m > 1280) {
    const k = 1280 / m;
    return [evenRound(w * k), evenRound(h * k)];
  }
  if (m < 960 && Math.max(srcW, srcH) >= 960) {
    const k = 960 / m;
    return [evenRound(w * k), evenRound(h * k)];
  }
  return [w, h];
}

export interface Budget {
  discordVideo: number;
  chanVideo: number;
  dw: number;
  dh: number;
  cw: number;
  ch: number;
}

/** Clip Sizer's `estimate()`: spread each size budget over the clip length. */
export function budget(duration: number, srcW: number, srcH: number): Budget {
  const d = Math.max(duration, 0.1);
  const discordTotal = (DISCORD_TARGET * 8) / d / 1000;
  const discordVideo = Math.max(DISCORD_MIN_KBPS, Math.floor((discordTotal - AUDIO_KBPS) * 0.94));
  const chanVideo = Math.max(CHAN_MIN_KBPS, Math.floor(((CHAN_TARGET * 8) / d / 1000) * 0.97));
  const [dw, dh] = dimensionsFor(discordVideo, srcW, srcH, 1080);
  const [cw, ch] = chanClamp(...dimensionsFor(chanVideo, srcW, srcH, 1280), srcW, srcH);
  return { discordVideo, chanVideo, dw, dh, cw, ch };
}

export interface ClipJob {
  id: string;
  label: string;
  /** File-name suffix, e.g. "Discord". */
  file: string;
  ext: "mp4" | "webm";
  codec: "avc" | "vp9";
  width: number;
  height: number;
  kbps: number;
  minKbps: number;
  /** Hard size cap in bytes; null = no cap, single attempt. */
  cap: number | null;
  /** H.264 outputs run CBR (Clip Sizer's hardware path); VP9 runs the default (VBR) mode. */
  constantBitrate: boolean;
  /** AAC 128k stereo game audio, or muted. */
  audio: boolean;
  keyFrameInterval?: number;
  mode: BgMode;
}

/** Discord + 4chan always; the three Socials shapes when `socials`. Rendered in order, one at a time. */
export function planClip(duration: number, srcW: number, srcH: number, socials: boolean, mode: BgMode): ClipJob[] {
  const b = budget(duration, srcW, srcH);
  const jobs: ClipJob[] = [
    {
      id: "discord", label: "Discord", file: "Discord", ext: "mp4", codec: "avc", width: b.dw, height: b.dh,
      kbps: b.discordVideo, minKbps: DISCORD_MIN_KBPS, cap: DISCORD_CAP, constantBitrate: true, audio: true, mode: "fit",
    },
    {
      id: "chan", label: "4chan", file: "4chan", ext: "webm", codec: "vp9", width: b.cw, height: b.ch,
      kbps: b.chanVideo, minKbps: CHAN_MIN_KBPS, cap: CHAN_CAP, constantBitrate: false, audio: false,
      keyFrameInterval: CHAN_KEYFRAME_S, mode: "fit",
    },
  ];
  if (socials) {
    for (const s of SOCIAL_SHAPES) {
      jobs.push({
        id: s.id, label: s.label, file: s.label, ext: "mp4", codec: "avc", width: s.w, height: s.h,
        kbps: s.kbps, minKbps: s.kbps, cap: null, constantBitrate: true, audio: true, mode,
      });
    }
  }
  return jobs;
}

/** Next attempt's bitrate after a file landed `size` bytes over `cap` (Clip Sizer: ×cap/size×0.95, floored). */
export function retryKbps(kbps: number, size: number, cap: number, minKbps: number): number {
  return Math.max(minKbps, Math.floor(kbps * (cap / size) * 0.95));
}

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Where the source frame goes in a `tw`×`th` output. `src` is the sub-rectangle
 * of the source to draw (Fill crops it), `dst` where it lands; `bars` = the
 * frame has uncovered area (black for Fit, the gradient for Gradient).
 */
export function layout(mode: BgMode, sw: number, sh: number, tw: number, th: number): { src: Rect; dst: Rect; bars: boolean } {
  if (mode === "fill") {
    const A = tw / th;
    let aw: number, ah: number;
    if (sw / sh > A) {
      ah = evenDown(sh);
      aw = Math.min(evenDown(sw), evenRound(ah * A));
    } else {
      aw = evenDown(sw);
      ah = Math.min(evenDown(sh), evenRound(aw / A));
    }
    return {
      src: { x: evenDown((sw - aw) / 2), y: evenDown((sh - ah) / 2), w: aw, h: ah },
      dst: { x: 0, y: 0, w: tw, h: th },
      bars: false,
    };
  }
  const k = Math.min(tw / sw, th / sh);
  const dw = Math.min(tw, evenRound(sw * k));
  const dh = Math.min(th, evenRound(sh * k));
  const bars = dw !== tw || dh !== th;
  return {
    src: { x: 0, y: 0, w: sw, h: sh },
    dst: bars ? { x: evenDown((tw - dw) / 2), y: gazeY(tw, th, dh), w: dw, h: dh } : { x: 0, y: 0, w: tw, h: th },
    bars,
  };
}

/** Gradient mode: per-channel median of sampled average colours, darkened into [top, bottom] stops. */
export const FALLBACK_GRADIENT: [string, string] = ["#0c0d11", "#232733"];
export function gradientFrom(samples: [number, number, number][]): [string, string] {
  if (!samples.length) return FALLBACK_GRADIENT;
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const m = [0, 1, 2].map((i) => med(samples.map((c) => c[i])));
  const hx = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return ["#" + m.map((x) => hx(x * 0.45)).join(""), "#" + m.map((x) => hx(x * 0.75)).join("")];
}

/** 2px outline colour just outside the video: the lighter stop, blended 30% toward white. */
export function outlineColor(g: [string, string]): string {
  const rgb = (h: string) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const sum = (h: string) => rgb(h).reduce((a, b) => a + b, 0);
  const base = sum(g[0]) >= sum(g[1]) ? g[0] : g[1];
  return "#" + rgb(base).map((c) => Math.min(255, Math.round(c + (255 - c) * 0.3)).toString(16).padStart(2, "0")).join("");
}

/** `1m02.5` — a range stamp that is safe in a session file name. */
export function stamp(t: number): string {
  const d = Math.round(Math.max(0, t) * 10) / 10;
  const m = Math.floor(d / 60);
  return `${m}m${(d - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** Session-folder file name, e.g. `clip_1m02.5-1m20.0_Discord.mp4` (≤64 chars of [A-Za-z0-9._-]). */
export function clipFileName(start: number, end: number, job: Pick<ClipJob, "file" | "ext">): string {
  return `clip_${stamp(start)}-${stamp(end)}_${job.file}.${job.ext}`;
}

/** Validate a marked range against the recording. Returns an error message or null. */
export function rangeError(start: number | null, end: number | null, duration: number): string | null {
  if (start === null || end === null) return "Mark both In and Out first.";
  if (!(end > start)) return "Out must be after In.";
  if (end - start < 0.5) return "The clip must be at least half a second long.";
  if (duration > 0 && start >= duration) return "In is past the end of the recording.";
  return null;
}

/** Plain-language length warnings (never blocks: Clip Sizer never re-trims for you). */
export function lengthWarnings(duration: number, socials: boolean): string[] {
  const w: string[] = [];
  if (duration > STARVE_WARN_S) w.push(`Over ${STARVE_WARN_S}s the 4chan file starves and turns blocky — trim shorter for a clean one.`);
  if (socials && duration > SOCIALS_MAX_LEN + 1e-6)
    w.push("Over the 2:20 X limit for the Socials pack (X 2:20, Shorts 3:00, Reels 3:00 for reach, TikTok 10:00).");
  return w;
}

export const fmtBytes = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + " MB" : (n / 1e3).toFixed(0) + " KB");

/** Game-audio track for the clip: Track 1 unless that is the mic, else the first non-mic track; null = none. */
export function gameTrack(trackCount: number, micTrack: number): number | null {
  for (let n = 1; n <= trackCount; n++) if (n !== micTrack) return n;
  return null;
}
