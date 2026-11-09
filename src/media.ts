// Media access by PATH, never by FileReader. The Rust `media` URI scheme serves
// byte ranges of the dropped file (see src-tauri/src/media.rs); Mediabunny's
// UrlSource and the <video> element both read through it with Range requests,
// so only the bytes actually needed ever cross into the webview.
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ALL_FORMATS, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output, Quality, UrlSource,
  WavOutputFormat, WebMOutputFormat, canEncodeAudio, canEncodeVideo, type VideoSample,
} from "mediabunny";
import { AUDIO_KBPS, FPS, MAX_RETRIES, layout, outlineColor, retryKbps, type ClipJob } from "./clip";

export function mediaUrl(absPath: string): string {
  return convertFileSrc(absPath, "media");
}

export interface AudioTrackInfo {
  /** 1-based, matches OBS's "Track N" numbering for its audio tracks. */
  number: number;
  name: string | null;
  codec: string | null;
  channels: number;
  sampleRate: number;
}

export interface Probe {
  input: Input;
  duration: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audio: AudioTrackInfo[];
}

export async function probe(absPath: string): Promise<Probe> {
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(mediaUrl(absPath)) });
  const [duration, video, tracks] = await Promise.all([
    input.computeDuration(),
    input.getPrimaryVideoTrack(),
    input.getAudioTracks(),
  ]);
  const audio: AudioTrackInfo[] = [];
  for (const [i, t] of tracks.entries()) {
    audio.push({
      number: i + 1,
      name: await t.getName(),
      codec: await t.getCodec(),
      channels: await t.getNumberOfChannels(),
      sampleRate: await t.getSampleRate(),
    });
  }
  return {
    input,
    duration,
    width: video ? await video.getDisplayWidth() : null,
    height: video ? await video.getDisplayHeight() : null,
    videoCodec: video ? await video.getCodec() : null,
    audio,
  };
}

/** Deepgram-friendly speech audio: mono (stereo doubles billable minutes), 16 kHz, 16-bit PCM WAV. */
export const MIC_SAMPLE_RATE = 16000;

/**
 * Extract audio track `micNumber` (1-based) over [start, end) as a mono WAV.
 * Video and every other audio track are discarded; only packets in range are
 * read. Timestamps in the output start at 0, so the caller adds `start` back.
 */
export async function extractMicWav(
  input: Input,
  micNumber: number,
  start: number,
  end: number,
  onProgress?: (p: number) => void,
): Promise<ArrayBuffer> {
  const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output,
    video: { discard: true },
    audio: (_track, n) =>
      n === micNumber
        ? { numberOfChannels: 1, sampleRate: MIC_SAMPLE_RATE, codec: "pcm-s16" }
        : { discard: true },
    trim: { start, end },
    showWarnings: false,
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => d.reason).join(", ");
    throw new Error(`cannot extract mic track ${micNumber}: ${why || "no usable audio track"}`);
  }
  if (onProgress) conversion.onProgress = onProgress;
  await conversion.execute();
  const buf = (output.target as BufferTarget).buffer;
  if (!buf) throw new Error("mic extraction produced no data");
  return buf;
}

/** Screenshot JPEG quality, per DESIGN.md. */
export const SHOT_QUALITY = 0.85;

async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality: SHOT_QUALITY });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/jpeg", SHOT_QUALITY),
  );
}

/**
 * Grab the frame at the video's current time as a JPEG, full source resolution.
 * Primary: canvas drawImage(video) → toBlob (the <video> is crossOrigin
 * "anonymous" and the media scheme sends ACAO *, so the canvas is not tainted).
 * Fallback (no decoded frame yet, tainted canvas, or a blank draw): decode the
 * frame with Mediabunny from the original file at the same timestamp.
 */
export async function grabFrame(
  video: HTMLVideoElement,
  input: Input | null,
): Promise<{ blob: Blob; time: number; via: "video" | "mediabunny" }> {
  const time = video.currentTime;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    try {
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d")!.drawImage(video, 0, 0);
      return { blob: await canvasToJpeg(c), time, via: "video" };
    } catch {
      // fall through to Mediabunny
    }
  }
  if (!input) throw new Error("no decoded video frame and no Mediabunny input to fall back on");
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("recording has no video track");
  const wrapped = await new CanvasSink(track, { poolSize: 0 }).getCanvas(time);
  if (!wrapped) throw new Error(`no video frame at ${time.toFixed(2)} s`);
  return { blob: await canvasToJpeg(wrapped.canvas), time: wrapped.timestamp, via: "mediabunny" };
}

// ---------- U6 compress-clip (Compression Protocol presets, see clip.ts) ----------

/** Average colour of a few frames across [start, end), for the Gradient background. */
export async function sampleColors(absPath: string, start: number, end: number): Promise<[number, number, number][]> {
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(mediaUrl(absPath)) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const sink = new CanvasSink(track, { width: 32, height: 32, fit: "fill", poolSize: 1 });
    const out: [number, number, number][] = [];
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const w = await sink.getCanvas(start + f * (end - start));
      if (!w) continue;
      const ctx = (w.canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d", { willReadFrequently: true }) as
        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) continue;
      const px = ctx.getImageData(0, 0, 32, 32).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i]; g += px[i + 1]; b += px[i + 2];
      }
      const n = px.length / 4;
      out.push([r / n, g / n, b / n]);
    }
    return out;
  } catch {
    return [];
  } finally {
    input.dispose();
  }
}

export interface ClipResult { bytes: ArrayBuffer; attempts: number; kbps: number; codecLabel: string }

/**
 * Encode one Compression Protocol output over [start, end) with Mediabunny
 * (WebCodecs). Frames are composited on a canvas (Fit / Fill / Gradient), the
 * game-audio track is AAC 128k stereo CBR (or discarded when muted), and capped
 * outputs retry up to MAX_RETRIES with a scaled-down bitrate — Clip Sizer's
 * hardware engine, minus its FFmpeg.wasm fallback (no FFmpeg in this app).
 */
export async function encodeClip(
  absPath: string,
  job: ClipJob,
  range: { start: number; end: number },
  src: { width: number; height: number },
  audioTrack: number | null,
  gradient: [string, string],
  onProgress?: (p: number, attempt: number) => void,
): Promise<ClipResult> {
  const { width: tw, height: th } = job;
  const codecLabel = job.codec === "vp9" ? "VP9" : "H.264";
  if (!(await canEncodeVideo(job.codec, { width: tw, height: th, bitrate: job.kbps * 1000, frameRate: FPS })))
    throw new Error(`this webview cannot encode ${codecLabel} at ${tw}×${th}`);
  const wantAudio = job.audio && audioTrack !== null;
  if (wantAudio && !(await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_KBPS * 1000 })))
    throw new Error("this webview cannot encode AAC audio");

  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  const { src: s, dst: d, bars } = layout(job.mode, src.width, src.height, tw, th);
  let background: OffscreenCanvas | null = null;
  if (bars && job.mode === "gradient") {
    background = new OffscreenCanvas(tw, th);
    const g = background.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 0, th);
    gr.addColorStop(0, gradient[0]);
    gr.addColorStop(1, gradient[1]);
    g.fillStyle = gr;
    g.fillRect(0, 0, tw, th);
  }
  const outline = outlineColor(gradient);
  const process = (sample: VideoSample) => {
    if (background) ctx.drawImage(background, 0, 0);
    else if (bars) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, tw, th);
    }
    sample.draw(ctx, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
    if (background) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2;
      ctx.strokeRect(d.x - 1, d.y - 1, d.w + 2, d.h + 2);
    }
    return canvas;
  };

  let kbps = job.kbps;
  const maxRetries = job.cap ? MAX_RETRIES : 0;
  for (let attempt = 0; ; attempt++) {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(mediaUrl(absPath)) });
    try {
      const target = new BufferTarget();
      const output = new Output({
        format: job.ext === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: job.codec,
          quality: new Quality({ bitrate: kbps * 1000, ...(job.constantBitrate ? { bitrateMode: "constant" as const } : {}) }),
          frameRate: FPS,
          ...(job.keyFrameInterval ? { keyFrameInterval: job.keyFrameInterval } : {}),
          process,
          processedWidth: tw,
          processedHeight: th,
        },
        audio: (_t, n) =>
          wantAudio && n === audioTrack
            ? { codec: "aac", numberOfChannels: 2, quality: new Quality({ bitrate: AUDIO_KBPS * 1000, bitrateMode: "constant" }) }
            : { discard: true },
        trim: range,
        showWarnings: false,
      });
      if (!conversion.isValid) {
        const why = conversion.discardedTracks.map((x) => x.reason).join(", ");
        throw new Error(`cannot convert: ${why || "no usable video track"}`);
      }
      if (onProgress) conversion.onProgress = (p) => onProgress(p, attempt);
      await conversion.execute();
      const bytes = target.buffer;
      if (!bytes) throw new Error("encode produced no data");
      if (!job.cap || bytes.byteLength <= job.cap || kbps <= job.minKbps || attempt >= maxRetries)
        return { bytes, attempts: attempt + 1, kbps, codecLabel };
      kbps = retryKbps(kbps, bytes.byteLength, job.cap, job.minKbps);
    } finally {
      input.dispose();
    }
  }
}
