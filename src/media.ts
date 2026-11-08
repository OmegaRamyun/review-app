// Media access by PATH, never by FileReader. The Rust `media` URI scheme serves
// byte ranges of the dropped file (see src-tauri/src/media.rs); Mediabunny's
// UrlSource and the <video> element both read through it with Range requests,
// so only the bytes actually needed ever cross into the webview.
import { convertFileSrc } from "@tauri-apps/api/core";
import { ALL_FORMATS, BufferTarget, Conversion, Input, Output, UrlSource, WavOutputFormat } from "mediabunny";

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
