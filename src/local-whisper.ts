// Main-thread side of local Whisper: decode the chunk WAV, hand it to the
// worker, map the result to the Deepgram word shape. No key, no backend call.
import { fmtBytes } from "./clip";
import { fmtTime, wavToFloat32, wordsFromWhisper, type Word } from "./transcript";

const RATE = 16000;
let worker: Worker | null = null;
let nextId = 1;

type Msg =
  | { id: number; type: "download"; loaded: number; total: number }
  | { id: number; type: "transcribing" }
  | { id: number; type: "done"; chunks: { text: string; timestamp: [number | null, number | null] }[] }
  | { id: number; type: "error"; error: string };

/**
 * Transcribe one mic-chunk WAV (16 kHz mono s16, from extractMicWav) on-device.
 * `onStatus(message, fraction)` reports model download and inference progress.
 */
export async function transcribeLocal(
  wav: ArrayBuffer,
  model: string,
  offset: number,
  onStatus: (msg: string, fraction: number) => void,
): Promise<Word[]> {
  const { samples, sampleRate } = wavToFloat32(wav);
  if (sampleRate !== RATE) throw new Error(`local Whisper needs 16 kHz audio, got ${sampleRate} Hz`);
  worker ??= new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  const id = nextId++;
  const name = model.replace(/^.*\//, "");
  const seconds = samples.length / RATE;
  return new Promise<Word[]>((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      clearInterval(timer);
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
    };
    const onMsg = (ev: MessageEvent<Msg>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === "download") {
        const pct = m.total ? m.loaded / m.total : 0;
        onStatus(`Downloading ${name} (first use) ${fmtBytes(m.loaded)}${m.total ? ` / ${fmtBytes(m.total)}` : ""}`, pct * 0.2);
      } else if (m.type === "transcribing") {
        // No per-window progress from the pipeline: show elapsed time instead.
        const t0 = performance.now();
        const tick = () => onStatus(`Transcribing on-device with ${name} — ${fmtTime((performance.now() - t0) / 1000)} elapsed for ${fmtTime(seconds)} of audio`, 0.2);
        tick();
        timer = setInterval(tick, 1000);
      } else if (m.type === "done") {
        finish();
        resolve(wordsFromWhisper(m.chunks, offset));
      } else {
        finish();
        reject(new Error(`local Whisper: ${m.error}`));
      }
    };
    const onErr = (ev: ErrorEvent) => {
      finish();
      worker = null; // a crashed worker is rebuilt on retry
      reject(new Error(`local Whisper worker failed: ${ev.message || "unknown error"}`));
    };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    onStatus(`Loading ${name}`, 0);
    w.postMessage({ id, samples, model }, [samples.buffer]);
  });
}
