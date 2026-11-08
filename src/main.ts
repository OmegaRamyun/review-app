// U1 core loop: Import → Transcribe → Scrub. The recording is only ever
// addressed by absolute path (drag-drop) and read through the `media` scheme.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { extractMicWav, mediaUrl, probe, type Probe } from "./media";
import {
  chunkRanges, costCents, defaultMicTrack, fmtTime, groupLines, lineAt, type Line, type Word,
} from "./transcript";

interface MediaInfo { path: string; size_bytes: number }

interface Session {
  id: string;
  title: string;
  recording_path: string;
  date: string;
  mode: "full" | "rapid";
  mic_track: number;
}

interface TranscriptFile {
  model: string;
  duration: number;
  chunks: { start: number; end: number; audio_path: string }[];
  words: Word[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LS_MIC = "ra.micTrack";
const LS_MODEL = "ra.deepgramModel";

// ---------- settings ----------
const modelInput = $<HTMLInputElement>("dg-model");
modelInput.value = localStorage.getItem(LS_MODEL) ?? "";
modelInput.addEventListener("change", () => localStorage.setItem(LS_MODEL, modelInput.value.trim()));
const model = () => modelInput.value.trim() || "nova-3";

async function refreshKeyStatus() {
  const has = await invoke<boolean>("has_deepgram_key").catch(() => false);
  $("dg-status").textContent = has ? "key stored in OS keychain" : "no key stored";
  if (!has) $<HTMLDetailsElement>("settings").open = true;
}
$("dg-save").addEventListener("click", async () => {
  const el = $<HTMLInputElement>("dg-key");
  try {
    await invoke("set_deepgram_key", { key: el.value });
    el.value = "";
  } catch (e) {
    $("dg-status").textContent = String(e);
    return;
  }
  void refreshKeyStatus();
});
$("dg-clear").addEventListener("click", async () => {
  await invoke("clear_deepgram_key").catch(() => {});
  void refreshKeyStatus();
});
void refreshKeyStatus();

// ---------- screens ----------
function show(name: "import" | "transcribe" | "scrub") {
  for (const s of ["import", "transcribe", "scrub"]) $(`screen-${s}`).hidden = s !== name;
}

// ---------- 1. Import ----------
let media: MediaInfo | null = null;
let probed: Probe | null = null;

async function onDrop(paths: string[]) {
  $("import-error").textContent = "";
  $("import-info").hidden = true;
  const path = paths[0];
  if (!path) return;
  try {
    probed?.input.dispose();
    probed = null;
    media = await invoke<MediaInfo>("open_media", { path });
    probed = await probe(media.path);
  } catch (e) {
    $("import-error").textContent = `Could not read ${path}\n${String(e)}`;
    return;
  }
  const p = probed;
  $("i-name").textContent = media.path.split(/[\\/]/).pop() ?? media.path;
  $("i-path").textContent = media.path;
  $("i-size").textContent = `${(media.size_bytes / 1e9).toFixed(2)} GB`;
  $("i-dur").textContent = fmtTime(p.duration);
  $("i-res").textContent = p.width ? `${p.width}×${p.height} (${p.videoCodec ?? "?"})` : "no video track";
  const remembered = Number(localStorage.getItem(LS_MIC)) || null;
  const def = defaultMicTrack(p.audio.length, remembered);
  const box = $("i-tracks");
  box.replaceChildren();
  if (!p.audio.length) box.textContent = "No audio tracks found.";
  for (const t of p.audio) {
    const label = document.createElement("label");
    label.style.display = "block";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "mic";
    radio.value = String(t.number);
    radio.checked = t.number === def;
    radio.addEventListener("change", () => localStorage.setItem(LS_MIC, radio.value));
    label.append(radio, ` Track ${t.number}${t.name ? ` “${t.name}”` : ""} — ${t.codec ?? "?"}, ${t.channels} ch, ${t.sampleRate} Hz`);
    box.append(label);
  }
  $<HTMLButtonElement>("b-transcribe").disabled = !p.audio.length;
  $("import-info").hidden = false;
}

const dropEl = $("drop");
void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "over" || p.type === "enter") dropEl.classList.add("over");
  else dropEl.classList.remove("over");
  if (p.type === "drop") void onDrop(p.paths);
});

// ---------- 2. Transcribe ----------
let session: Session | null = null;
let transcript: TranscriptFile | null = null;

function newSessionId(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug = (path.split(/[\\/]/).pop() ?? "rec").replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${stamp}-${slug}`.slice(0, 64);
}

$("b-transcribe").addEventListener("click", async () => {
  if (!media || !probed) return;
  if (!(await invoke<boolean>("has_deepgram_key").catch(() => false))) {
    $("import-error").textContent = "Enter your Deepgram API key in Settings first.";
    $<HTMLDetailsElement>("settings").open = true;
    return;
  }
  const mic = Number(document.querySelector<HTMLInputElement>('input[name="mic"]:checked')?.value ?? 2);
  localStorage.setItem(LS_MIC, String(mic));
  const title = (media.path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
  session = {
    id: newSessionId(media.path), title, recording_path: media.path,
    date: new Date().toISOString(), mode: "full", mic_track: mic,
  };
  await invoke("save_session_file", { id: session.id, name: "session.json", contents: JSON.stringify(session, null, 2) });
  transcript = { model: model(), duration: probed.duration, chunks: [], words: [] };
  show("transcribe");
  void runTranscription();
});
$("t-retry").addEventListener("click", () => void runTranscription());

/** Resumable: chunks already transcribed are kept; a retry restarts at the failed chunk. */
async function runTranscription() {
  if (!session || !probed || !transcript) return;
  const s = session, p = probed, tr = transcript;
  const ranges = chunkRanges(p.duration);
  const status = $("t-status"), bar = $<HTMLProgressElement>("t-bar");
  $("t-error").textContent = "";
  $("t-retry").hidden = true;
  $("t-next").hidden = true;
  try {
    for (let i = tr.chunks.length; i < ranges.length; i++) {
      const r = ranges[i];
      const part = `chunk ${i + 1}/${ranges.length} (${fmtTime(r.start)}–${fmtTime(r.end)})`;
      status.textContent = `Extracting mic audio — ${part}`;
      const wav = await extractMicWav(p.input, s.mic_track, r.start, r.end, (x) => {
        bar.value = (i + x * 0.5) / ranges.length;
      });
      status.textContent = `Uploading + transcribing — ${part}`;
      const audioPath = await invoke<string>("save_audio_chunk", new Uint8Array(wav), {
        headers: { "x-session": s.id, "x-name": `mic-${String(i).padStart(3, "0")}.wav` },
      });
      const words = await invoke<Word[]>("transcribe_chunk", { audioPath, model: tr.model, offsetS: r.start });
      tr.words.push(...words);
      tr.chunks.push({ ...r, audio_path: audioPath });
      bar.value = (i + 1) / ranges.length;
      await invoke("save_session_file", { id: s.id, name: "transcript.json", contents: JSON.stringify(tr) });
    }
  } catch (e) {
    $("t-error").textContent = `Failed: ${String(e)}\nExtracted audio is kept in the session folder; Retry resumes here.`;
    $("t-retry").hidden = false;
    return;
  }
  const text = groupLines(tr.words).map((l) => `[${fmtTime(l.start)}] ${l.text}`).join("\n");
  await invoke("save_session_file", { id: s.id, name: "transcript.txt", contents: text });
  status.textContent = `Done — ${tr.words.length} words, ${fmtTime(p.duration)} of mic audio, ` +
    `≈ ${costCents(p.duration).toFixed(1)}¢ at the ${tr.model} list price.`;
  $("t-next").hidden = false;
}
$("t-next").addEventListener("click", () => {
  if (session && transcript) openScrub(session.recording_path, transcript.words);
});

// ---------- 3. Scrub & point ----------
const video = $<HTMLVideoElement>("video");
let lines: Line[] = [];
let lineEls: HTMLLIElement[] = [];
let active = -1;

function setActive(i: number) {
  if (i === active) return;
  lineEls[active]?.classList.remove("active");
  active = i;
  const el = lineEls[i];
  if (el) {
    el.classList.add("active");
    el.scrollIntoView({ block: "nearest" });
  }
}

/** Seek and resolve once the element has actually landed (`seeked`), per DESIGN.md. */
function seekTo(t: number): Promise<void> {
  return new Promise((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = t;
  });
}

// Highlight follows presented frames (requestVideoFrameCallback), not timeupdate.
function onFrame(_now: DOMHighResTimeStamp, meta: VideoFrameCallbackMetadata) {
  setActive(lineAt(lines, meta.mediaTime));
  $("v-time").textContent = fmtTime(meta.mediaTime);
  video.requestVideoFrameCallback(onFrame);
}

function openScrub(path: string, words: Word[]) {
  lines = groupLines(words);
  const list = $("lines");
  lineEls = lines.map((l) => {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = fmtTime(l.start);
    li.append(time, l.text);
    li.addEventListener("click", async () => {
      // word.start of the line's first word, exactly
      await seekTo(words[l.firstWord].start);
      setActive(lineAt(lines, video.currentTime));
    });
    return li;
  });
  list.replaceChildren(...lineEls);
  active = -1;
  $("v-error").textContent = "";
  video.src = mediaUrl(path);
  video.requestVideoFrameCallback(onFrame);
  show("scrub");
}

video.addEventListener("error", () => {
  $("v-error").textContent =
    `The webview cannot play this file as-is (${video.error?.message || `code ${video.error?.code}`}). ` +
    "The MKV→MP4 remux fallback is not built yet.";
});
$("v-play").addEventListener("click", () => (video.paused ? void video.play() : video.pause()));
$("v-back").addEventListener("click", () => void seekTo(Math.max(0, video.currentTime - 5)));
$("v-fwd").addEventListener("click", () => void seekTo(video.currentTime + 5));
$<HTMLSelectElement>("v-speed").addEventListener("change", (e) => {
  video.playbackRate = Number((e.target as HTMLSelectElement).value);
});
