// Local Whisper (transformers.js) off the UI thread. One request at a time:
// { samples: Float32Array (16 kHz mono), model } → { chunks } with word timestamps.
// The model downloads from the Hugging Face Hub on first use and is then served
// from the browser cache (Cache Storage), so later runs work offline.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

env.allowLocalModels = false; // no /models/ path on our origin: go straight to the Hub
env.useBrowserCache = true;

let loaded: { model: string; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

type Req = { id: number; samples: Float32Array; model: string };
type ProgressInfo = { status: string; file?: string; loaded?: number; total?: number; progress?: number };

function load(model: string, id: number) {
  if (loaded?.model !== model) {
    const files = new Map<string, { loaded: number; total: number }>();
    loaded = {
      model,
      pipe: pipeline("automatic-speech-recognition", model, {
        progress_callback: (p: ProgressInfo) => {
          if (p.status !== "progress" || !p.file) return;
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
          let got = 0, total = 0;
          for (const f of files.values()) { got += f.loaded; total += f.total; }
          self.postMessage({ id, type: "download", loaded: got, total });
        },
      }) as Promise<AutomaticSpeechRecognitionPipeline>,
    };
    loaded.pipe.catch(() => { loaded = null; }); // a failed download retries next time
  }
  return loaded.pipe;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, samples, model } = ev.data;
  try {
    const pipe = await load(model, id);
    self.postMessage({ id, type: "transcribing" });
    const out = await pipe(samples, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "english",
      task: "transcribe",
    });
    const res = Array.isArray(out) ? out[0] : out;
    self.postMessage({ id, type: "done", chunks: (res as { chunks?: unknown[] }).chunks ?? [] });
  } catch (e) {
    self.postMessage({ id, type: "error", error: e instanceof Error ? e.message : String(e) });
  }
};
