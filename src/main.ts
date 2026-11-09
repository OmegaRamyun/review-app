// U1 core loop: Import → Transcribe → Scrub. The recording is only ever
// addressed by absolute path (drag-drop) and read through the `media` scheme.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { encodeClip, extractMicWav, grabFrame, mediaUrl, probe, sampleColors, type Probe } from "./media";
import {
  FALLBACK_GRADIENT, clipFileName, fmtBytes, gameTrack, gradientFrom, lengthWarnings,
  planClip, rangeError, type BgMode,
} from "./clip";
import {
  bucketLabel, bucketsFor, deletePoint, emptyPoints, filterPoints, newPoint, parsePoints, pinnedTimes,
  shotName, updatePoint, type Mode, type Point, type PointsFile,
} from "./points";
import {
  chunkRanges, costCents, defaultMicTrack, fmtTime, groupLines, lineAt, type Line, type Word,
} from "./transcript";
import {
  applyDraft, DRAFT_SYSTEM, draftPrompt, emptyReview, parseDraft, parseReview, pointsIn, renderPage,
  sectionBuckets, unreviewedDrafts, type ReviewFile,
} from "./review";
import {
  chooseSlug, hookLine, itchComment, normalizeSiteBase, parseSiteEntries, renderIndex, reviewUrl, upsertEntry,
} from "./publish";
import {
  enqueue, fileStem, fmtDate, isFinished, newSessionId, nextInQueue, parseQueue, parseSession, pruneQueue,
  searchRows, toRows, type LibraryRow, type Session, type SessionSummary,
} from "./library";

interface MediaInfo { path: string; size_bytes: number }

interface TranscriptFile {
  model: string;
  duration: number;
  chunks: { start: number; end: number; audio_path: string }[];
  words: Word[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LS_MIC = "ra.micTrack";
const LS_MODEL = "ra.deepgramModel";
const LS_GEMINI_MODEL = "ra.geminiModel";
const LS_CF_ACCOUNT = "ra.cfAccount";
const LS_CF_PROJECT = "ra.cfProject";
const LS_CF_SITE = "ra.cfSite";
const LS_QUEUE = "ra.queue";
const LS_EVENT = "ra.event";
const LS_DEMO = "ra.demoDay";

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

// AI draft provider: one keychain slot per provider; the key/model/base-URL
// rows follow the dropdown. Provider choice + per-provider model + base URL
// live in localStorage; keys never leave the OS keychain.
type AiProvider = "gemini" | "claude" | "openai" | "openai_compat";
const LS_AI_PROVIDER = "ra.aiProvider";
const LS_AI_MODEL_PREFIX = "ra.aiModel.";
const LS_AI_BASE = "ra.aiBaseUrl";
const AI_DEFAULT_BASE = "https://nano-gpt.com/api/v1";
const AI_PROVIDERS: Record<AiProvider, { keyLabel: string; modelLabel: string; defaultModel: string; modelPlaceholder: string; keyLink: string; keyLinkText: string }> = {
  gemini: { keyLabel: "Gemini API key", modelLabel: "Gemini model", defaultModel: "gemini-2.5-flash", modelPlaceholder: "gemini-2.5-flash", keyLink: "https://aistudio.google.com/apikey", keyLinkText: "get a key ↗" },
  claude: { keyLabel: "Claude API key", modelLabel: "Claude model", defaultModel: "claude-sonnet-4-5", modelPlaceholder: "claude-sonnet-4-5", keyLink: "https://console.anthropic.com/settings/keys", keyLinkText: "get a key ↗" },
  openai: { keyLabel: "OpenAI API key", modelLabel: "OpenAI model", defaultModel: "gpt-4o-mini", modelPlaceholder: "gpt-4o-mini", keyLink: "https://platform.openai.com/api-keys", keyLinkText: "get a key ↗" },
  openai_compat: { keyLabel: "OpenAI Compatible API key", modelLabel: "Model", defaultModel: "", modelPlaceholder: "e.g. z-ai/glm-5.3-flash-uncensored", keyLink: "https://nano-gpt.com/api", keyLinkText: "NanoGPT API ↗" },
};
const aiProviderSelect = $<HTMLSelectElement>("ai-provider");
const aiModelInput = $<HTMLInputElement>("ai-model");
const aiBaseInput = $<HTMLInputElement>("ai-base");
const aiProvider = (): AiProvider => {
  const v = aiProviderSelect.value;
  return v === "claude" || v === "openai" || v === "openai_compat" ? v : "gemini";
};
const aiModel = () => aiModelInput.value.trim() || AI_PROVIDERS[aiProvider()].defaultModel;
// One-time migration: a model saved under the old Gemini-only key moves over.
if (!localStorage.getItem(LS_AI_MODEL_PREFIX + "gemini")) {
  const old = localStorage.getItem(LS_GEMINI_MODEL);
  if (old) localStorage.setItem(LS_AI_MODEL_PREFIX + "gemini", old);
}
function refreshAiRows() {
  const p = aiProvider();
  const meta = AI_PROVIDERS[p];
  $("ai-key-label").textContent = meta.keyLabel;
  const link = $<HTMLAnchorElement>("ai-key-link");
  link.href = meta.keyLink;
  link.textContent = meta.keyLinkText;
  $("ai-model-label").textContent = meta.modelLabel;
  aiModelInput.placeholder = meta.modelPlaceholder;
  aiModelInput.value = localStorage.getItem(LS_AI_MODEL_PREFIX + p) ?? "";
  $("ai-base-row").hidden = p !== "openai_compat";
  void refreshAiStatus();
}
async function refreshAiStatus() {
  const has = await invoke<boolean>(`has_${aiProvider()}_key`).catch(() => false);
  $("ai-status").textContent = has ? "key stored in OS keychain" : "no key stored";
}
aiProviderSelect.value = localStorage.getItem(LS_AI_PROVIDER) ?? "gemini";
aiProviderSelect.addEventListener("change", () => {
  localStorage.setItem(LS_AI_PROVIDER, aiProvider());
  refreshAiRows();
});
aiModelInput.addEventListener("change", () => localStorage.setItem(LS_AI_MODEL_PREFIX + aiProvider(), aiModelInput.value.trim()));
aiBaseInput.value = localStorage.getItem(LS_AI_BASE) ?? "";
aiBaseInput.addEventListener("change", () => localStorage.setItem(LS_AI_BASE, aiBaseInput.value.trim()));
$("ai-save").addEventListener("click", async () => {
  const el = $<HTMLInputElement>("ai-key");
  try {
    await invoke(`set_${aiProvider()}_key`, { key: el.value });
    el.value = "";
  } catch (e) {
    $("ai-status").textContent = String(e);
    return;
  }
  void refreshAiStatus();
});
$("ai-clear").addEventListener("click", async () => {
  await invoke(`clear_${aiProvider()}_key`).catch(() => {});
  void refreshAiStatus();
});
refreshAiRows();

// ---------- screens ----------
type Screen = "library" | "import" | "transcribe" | "scrub" | "assemble" | "publish";
const SCREENS: readonly Screen[] = ["library", "import", "transcribe", "scrub", "assemble", "publish"];
let current: Screen = "library";
function show(name: Screen) {
  current = name;
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  $("nav-library").hidden = name === "library";
  void refreshQueueBar();
}

// ---------- session state ----------
let session: Session | null = null;
let transcript: TranscriptFile | null = null;
let media: MediaInfo | null = null;
let probed: Probe | null = null;

const sessionJson = (s: Session) => JSON.stringify(s, null, 2);
const saveSessionObj = (s: Session) => invoke("save_session_file", { id: s.id, name: "session.json", contents: sessionJson(s) });

/** Leave the open session: flush the review, stop playback, drop the media handle. */
async function closeSession() {
  if (session) await writeReview();
  video.pause();
  video.removeAttribute("src");
  video.load();
  probed?.input.dispose();
  probed = null;
  media = null;
}

// ---------- 0. Library + demo-day queue ----------
let rows: LibraryRow[] = [];
let queue = parseQueue(localStorage.getItem(LS_QUEUE));
const saveQueue = () => localStorage.setItem(LS_QUEUE, JSON.stringify(queue));
const statusOf = (id: string) => rows.find((r) => r.session.id === id)?.status;

const libEvent = $<HTMLInputElement>("lib-event");
libEvent.value = localStorage.getItem(LS_EVENT) ?? "";
libEvent.addEventListener("change", () => localStorage.setItem(LS_EVENT, libEvent.value.trim()));
const libDemo = $<HTMLInputElement>("lib-demo");
libDemo.checked = localStorage.getItem(LS_DEMO) === "1";
libDemo.addEventListener("change", () => localStorage.setItem(LS_DEMO, libDemo.checked ? "1" : ""));
const libSearch = $<HTMLInputElement>("lib-search");
libSearch.addEventListener("input", () => renderLibrary());

async function refreshLibrary() {
  try {
    rows = toRows(await invoke<SessionSummary[]>("list_sessions"));
  } catch (e) {
    $("lib-error").textContent = `Could not read the sessions folder: ${String(e)}`;
    return;
  }
  const known = new Set(rows.map((r) => r.session.id));
  const pruned = pruneQueue(queue, known);
  if (pruned.length !== queue.length) {
    queue = pruned;
    saveQueue();
  }
  renderLibrary();
  renderQueue();
}

function cell(...kids: (Node | string)[]): HTMLTableCellElement {
  const td = document.createElement("td");
  td.append(...kids);
  return td;
}

/** Inline edit of a session's title/event; keeps the open session's in-memory copy in step. */
function editField(r: LibraryRow, key: "title" | "event", placeholder: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = r.session[key];
  el.placeholder = placeholder;
  el.addEventListener("change", async () => {
    const target = session?.id === r.session.id ? session : r.session;
    target[key] = r.session[key] = el.value.trim();
    try {
      await saveSessionObj(target);
    } catch (e) {
      $("lib-error").textContent = `Could not save session.json: ${String(e)}`;
    }
    renderQueue();
  });
  return el;
}

function renderLibrary() {
  const shown = searchRows(rows, libSearch.value);
  $("lib-count").textContent = `${shown.length} of ${rows.length} session${rows.length === 1 ? "" : "s"}`;
  $("lib-empty").hidden = rows.length > 0;
  $("lib-rows").replaceChildren(...shown.map((r) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("current", r.session.id === session?.id);
    const status = document.createElement("span");
    status.className = `status st-${r.status.replace(/ /g, "-")}`;
    status.textContent = r.status;
    if (r.partial_transcript && r.status === "imported") status.title = "Transcription started; opening resumes it";
    const length = r.session.duration ? fmtTime(r.session.duration) : "—";
    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", () => void openSession(r.session.id));
    const q = document.createElement("button");
    const inQueue = queue.includes(r.session.id);
    q.textContent = inQueue ? "Unqueue" : "Queue";
    q.title = inQueue ? "Remove from the demo-day queue" : "Add to the end of the demo-day queue";
    q.addEventListener("click", () => {
      queue = inQueue ? queue.filter((id) => id !== r.session.id) : enqueue(queue, [r.session.id]);
      saveQueue();
      renderLibrary();
      renderQueue();
    });
    const actions = cell(open, " ", q);
    if (!r.recording_exists) {
      const warn = document.createElement("div");
      warn.className = "error";
      warn.textContent = "recording missing";
      warn.title = r.session.recording_path;
      actions.append(warn);
    }
    tr.append(
      cell(editField(r, "title", "game title")), cell(editField(r, "event", "event")),
      cell(fmtDate(r.session.date)), cell(length), cell(status), cell(String(r.points)), actions,
    );
    return tr;
  }));
}

function renderQueue() {
  const box = $("queue-box");
  box.hidden = queue.length === 0 && !libDemo.checked;
  const done = queue.filter((id) => isFinished(statusOf(id) ?? "imported")).length;
  $("q-summary").textContent = queue.length ? `${done} of ${queue.length} done` : "empty — drop recordings with demo-day mode on, or Queue rows below";
  $("q-list").replaceChildren(...queue.map((id, i) => {
    const r = rows.find((x) => x.session.id === id);
    const li = document.createElement("li");
    li.classList.toggle("current", id === session?.id);
    li.classList.toggle("finished", isFinished(r?.status ?? "imported"));
    const name = document.createElement("button");
    name.className = "linkish";
    name.textContent = r?.session.title || id;
    name.addEventListener("click", () => void openSession(id));
    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]];
      saveQueue();
      renderQueue();
    });
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = "Remove from queue (the session stays in the library)";
    rm.addEventListener("click", () => {
      queue = queue.filter((x) => x !== id);
      saveQueue();
      renderLibrary();
      renderQueue();
    });
    li.append(name, ` — ${r?.status ?? "?"}${r?.session.event ? ` · ${r.session.event}` : ""} `, up, rm);
    return li;
  }));
  const next = nextInQueue(queue, statusOf, session?.id ?? null);
  const b = $<HTMLButtonElement>("q-next");
  b.disabled = !next;
  b.textContent = next ? `Work next: ${rows.find((x) => x.session.id === next)?.session.title || next} →` : "Queue finished";
  $<HTMLButtonElement>("q-clear").disabled = done === 0;
}

/** Header strip while a session is open: queue progress + jump to the next unfinished recording. */
async function refreshQueueBar() {
  const bar = $("queue-bar");
  const inQueue = !!session && queue.includes(session.id) && current !== "library";
  bar.hidden = !inQueue;
  if (!inQueue) return;
  const pos = queue.indexOf(session!.id) + 1;
  $("qb-pos").textContent = `Demo day: ${pos} of ${queue.length}`;
  const next = nextInQueue(queue, statusOf, session?.id ?? null);
  const btn = $<HTMLButtonElement>("qb-next");
  btn.disabled = !next;
  btn.textContent = next ? `Work next: ${rows.find((x) => x.session.id === next)?.session.title || next} →` : "Queue finished";
}

$("q-next").addEventListener("click", () => void workNext());
$("qb-next").addEventListener("click", () => void workNext());
$("q-clear").addEventListener("click", () => {
  queue = queue.filter((id) => !isFinished(statusOf(id) ?? "imported"));
  saveQueue();
  renderLibrary();
  renderQueue();
});

async function workNext() {
  await refreshLibrary(); // statuses change as the current session is worked
  const next = nextInQueue(queue, statusOf, session?.id ?? null);
  if (!next) {
    $("lib-status").textContent = "Every queued recording is done.";
    await openLibrary();
    return;
  }
  await openSession(next);
}

async function openLibrary() {
  await closeSession();
  show("library");
  await refreshLibrary();
}
$("nav-library").addEventListener("click", () => void openLibrary());
void openLibrary();

/** New sessions from dropped/picked recordings: probe each for its length, write session.json. */
async function addRecordings(paths: string[]) {
  if (!paths.length) return;
  const status = $("lib-status"), errors: string[] = [];
  $("lib-error").textContent = "";
  const demo = libDemo.checked;
  const taken = new Set(rows.map((r) => r.session.id));
  const added: string[] = [];
  for (const [i, path] of paths.entries()) {
    status.textContent = `Reading ${i + 1}/${paths.length}: ${fileStem(path)}…`;
    try {
      const info = await invoke<MediaInfo>("open_media", { path });
      const p = await probe(info.path);
      const audio = p.audio.length;
      p.input.dispose();
      const s: Session = {
        id: newSessionId(info.path, new Date(), taken), title: fileStem(info.path), event: libEvent.value.trim(),
        recording_path: info.path, date: new Date().toISOString(), mode: demo ? "rapid" : "full",
        mic_track: defaultMicTrack(audio, Number(localStorage.getItem(LS_MIC)) || null) ?? 2, duration: p.duration,
      };
      await saveSessionObj(s);
      taken.add(s.id);
      added.push(s.id);
    } catch (e) {
      errors.push(`${path}: ${String(e)}`);
    }
  }
  if (demo) {
    queue = enqueue(queue, added);
    saveQueue();
  }
  status.textContent = added.length
    ? `Added ${added.length} session${added.length === 1 ? "" : "s"}${demo ? " to the demo-day queue (rapid mode)" : ""}.`
    : "";
  if (errors.length) $("lib-error").textContent = `Could not import:\n${errors.join("\n")}`;
  await refreshLibrary();
  // A single new recording opens straight away — unless queueing for demo day, or mid-work elsewhere.
  if (!demo && added.length === 1 && (current === "library" || current === "import")) await openSession(added[0]);
  else if (current !== "library") void refreshQueueBar();
}

$("lib-pick").addEventListener("click", async () => {
  try {
    await addRecordings(await invoke<string[]>("pick_recordings"));
  } catch (e) {
    $("lib-error").textContent = `File picker failed: ${String(e)}`;
  }
});

const dropEls = [document.getElementById("lib-drop"), document.getElementById("drop")].filter((el): el is HTMLElement => !!el);
void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  const over = p.type === "over" || p.type === "enter";
  for (const el of dropEls) el.classList.toggle("over", over);
  if (p.type === "drop") void addRecordings(p.paths);
});

function parseTranscript(json: string | null): TranscriptFile | null {
  if (!json) return null;
  try {
    const t = JSON.parse(json) as TranscriptFile;
    return Array.isArray(t.words) && Array.isArray(t.chunks) ? t : null;
  } catch {
    return null;
  }
}

/** Open a session where its work stands: not transcribed → Import (mic pick / resume), else Scrub. */
async function openSession(id: string) {
  await closeSession();
  $("lib-error").textContent = "";
  let s: Session, txt: string | null;
  try {
    const json = await invoke<string | null>("load_session_file", { id, name: "session.json" });
    if (!json) throw new Error("session.json is missing");
    s = parseSession(json, id);
    s.id = id;
    transcript = parseTranscript(await invoke<string | null>("load_session_file", { id, name: "transcript.json" }));
    txt = await invoke<string | null>("load_session_file", { id, name: "transcript.txt" });
  } catch (e) {
    $("lib-error").textContent = `Could not open ${id}: ${String(e)}`;
    show("library");
    return;
  }
  session = s;
  let mediaError = "";
  try {
    media = await invoke<MediaInfo>("open_media", { path: s.recording_path });
    probed = await probe(media.path);
  } catch (e) {
    media = probed = null;
    mediaError = `Recording not readable at ${s.recording_path}\n${String(e)}`;
  }
  if (txt !== null && transcript) {
    await openScrub(s.recording_path, transcript.words, !!media);
    if (mediaError) $("v-error").textContent = `${mediaError}\nPoints and the review still work — Assemble → is below.`;
  } else {
    showImport(mediaError);
  }
}

// ---------- 1. Import (mic track for the open session) ----------
function showImport(error = "") {
  $("import-error").textContent = error;
  $("import-info").hidden = !media || !probed;
  show("import");
  if (!media || !probed || !session) return;
  const p = probed;
  $("i-name").textContent = media.path.split(/[\\/]/).pop() ?? media.path;
  $("i-path").textContent = media.path;
  $("i-size").textContent = `${(media.size_bytes / 1e9).toFixed(2)} GB`;
  $("i-dur").textContent = fmtTime(p.duration);
  $("i-res").textContent = p.width ? `${p.width}×${p.height} (${p.videoCodec ?? "?"})` : "no video track";
  const remembered = Number(localStorage.getItem(LS_MIC)) || null;
  const saved = p.audio.some((t) => t.number === session!.mic_track) ? session.mic_track : null;
  const def = saved ?? defaultMicTrack(p.audio.length, remembered);
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
  const resumable = !!transcript?.chunks.length;
  $<HTMLButtonElement>("b-transcribe").textContent = resumable ? "Resume transcription" : "Transcribe";
  $<HTMLButtonElement>("b-transcribe").disabled = !p.audio.length;
}

// ---------- 2. Transcribe ----------
$("b-transcribe").addEventListener("click", async () => {
  if (!media || !probed || !session) return;
  if (!(await invoke<boolean>("has_deepgram_key").catch(() => false))) {
    $("import-error").textContent = "Enter your Deepgram API key in Settings first.";
    $<HTMLDetailsElement>("settings").open = true;
    return;
  }
  const mic = Number(document.querySelector<HTMLInputElement>('input[name="mic"]:checked')?.value ?? 2);
  localStorage.setItem(LS_MIC, String(mic));
  // Resume only what was transcribed from the same track with the same model; anything else starts over.
  const resume = transcript && transcript.chunks.length && session.mic_track === mic && transcript.model === model();
  session.mic_track = mic;
  session.duration = probed.duration;
  await saveSessionObj(session);
  if (!resume) transcript = { model: model(), duration: probed.duration, chunks: [], words: [] };
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
      const audioPath = await invoke<string>("save_session_bytes", new Uint8Array(wav), {
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
  if (session && transcript) void openScrub(session.recording_path, transcript.words);
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

async function openScrub(path: string, words: Word[], playable = true) {
  lines = groupLines(words);
  const list = $("lines");
  lineEls = lines.map((l, i) => {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = fmtTime(l.start);
    const pin = document.createElement("button");
    pin.className = "pin";
    pin.textContent = "📌";
    pin.title = "Pin this line as a point";
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      startNewPoint(i);
    });
    li.append(pin, time, l.text);
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
  corsRetried = false;
  // crossOrigin so drawImage(video) leaves the canvas untainted (media scheme sends ACAO *).
  video.crossOrigin = "anonymous";
  if (playable) {
    video.src = mediaUrl(path);
    video.requestVideoFrameCallback(onFrame);
  }
  resetClip();
  await loadPoints();
  show("scrub");
}

// ---------- 3c. Compress clip (U6) ----------
let clipIn: number | null = null;
let clipOut: number | null = null;
let clipBusy = false;

function renderClipMarks() {
  $("k-in-t").textContent = clipIn === null ? "–" : fmtTime(clipIn);
  $("k-out-t").textContent = clipOut === null ? "–" : fmtTime(clipOut);
  const err = clipIn !== null && clipOut !== null ? rangeError(clipIn, clipOut, probed?.duration ?? 0) : null;
  const len = clipIn !== null && clipOut !== null && !err ? clipOut - clipIn : null;
  const warn = len === null ? [] : lengthWarnings(len, $<HTMLInputElement>("k-socials").checked);
  if (!clipBusy) $("k-status").textContent = err ?? (len === null ? "" : [`Clip ${len.toFixed(1)} s.`, ...warn].join(" "));
  $<HTMLButtonElement>("k-go").disabled = clipBusy || !probed;
}

function resetClip() {
  if (clipBusy) return;
  clipIn = clipOut = null;
  $("k-files").replaceChildren();
  renderClipMarks();
}

async function compressClip() {
  const err = rangeError(clipIn, clipOut, probed?.duration ?? 0);
  if (err || clipIn === null || clipOut === null) {
    $("k-status").textContent = err ?? "";
    return;
  }
  if (!session || !probed || !media || !probed.width || !probed.height) {
    $("k-status").textContent = "The recording is not readable, so there is nothing to compress.";
    return;
  }
  const id = session.id, path = media.path;
  const start = clipIn, end = Math.min(clipOut, probed.duration || clipOut);
  const src = { width: probed.width, height: probed.height };
  const socials = $<HTMLInputElement>("k-socials").checked;
  const mode = $<HTMLSelectElement>("k-bg").value as BgMode;
  const jobs = planClip(end - start, src.width, src.height, socials, mode);
  const audio = gameTrack(probed.audio.length, session.mic_track);
  clipBusy = true;
  renderClipMarks();
  video.pause();
  const list = $("k-files");
  list.replaceChildren();
  const status = $("k-status");
  try {
    const gradient = socials && mode === "gradient" ? gradientFrom(await sampleColors(path, start, end)) : FALLBACK_GRADIENT;
    let made = 0;
    for (const [i, job] of jobs.entries()) {
      const li = document.createElement("li");
      list.append(li);
      const tag = `${job.label} (${i + 1}/${jobs.length})`;
      try {
        const r = await encodeClip(path, job, { start, end }, src, audio, gradient, (p, attempt) => {
          status.textContent = `${tag}${attempt ? ` — over the cap, retry ${attempt}` : ""}: ${Math.round(p * 100)}%…`;
        });
        const name = clipFileName(start, end, job);
        const saved = await invoke<string>("save_session_bytes", new Uint8Array(r.bytes), {
          headers: { "x-session": id, "x-name": name },
        });
        const size = r.bytes.byteLength;
        const over = job.cap !== null && size > job.cap;
        li.className = over ? "over" : "";
        li.textContent =
          `${job.label}: ${fmtBytes(size)}, ${job.width}×${job.height} ${r.codecLabel} ~${r.kbps} kb/s` +
          (job.audio ? (audio === null ? ", no game-audio track found" : `, AAC 128k (Track ${audio})`) : ", muted") +
          (r.attempts > 1 ? `, ${r.attempts} attempts` : "") +
          (job.cap === null ? "" : over ? ` — OVER the ${fmtBytes(job.cap)} cap; trim shorter.` : ` (under the ${fmtBytes(job.cap)} cap)`) +
          ` → ${saved}`;
        made++;
      } catch (e) {
        li.className = "over";
        li.textContent = `${job.label}: failed — ${String(e)}`;
      }
    }
    status.textContent = `${made} of ${jobs.length} file${jobs.length === 1 ? "" : "s"} written to the session folder.`;
  } finally {
    clipBusy = false;
    $<HTMLButtonElement>("k-go").disabled = !probed;
  }
}

$("k-in").addEventListener("click", () => {
  clipIn = video.currentTime;
  if (clipOut !== null && clipOut <= clipIn) clipOut = null;
  renderClipMarks();
});
$("k-out").addEventListener("click", () => {
  clipOut = video.currentTime;
  if (clipIn !== null && clipIn >= clipOut) clipIn = null;
  renderClipMarks();
});
$("k-in-t").addEventListener("click", () => clipIn !== null && void seekTo(clipIn));
$("k-out-t").addEventListener("click", () => clipOut !== null && void seekTo(clipOut));
$("k-socials").addEventListener("change", renderClipMarks);
$("k-go").addEventListener("click", () => void compressClip());

// ---------- 3b. Points ----------
let points: PointsFile = emptyPoints();
const thumbUrls = new Map<string, string>(); // screenshot file name → blob URL
type DraftShot = { kind: "existing"; name: string; time: number | null } | { kind: "new"; blob: Blob; time: number };
interface Draft { id: string | null; quote: string; time: number; shot: DraftShot | null }
let draft: Draft | null = null;
let draftThumbUrl: string | null = null;
let lastBucket = "";

const sessionId = () => session!.id;
const mode = (): Mode => session?.mode ?? "full";

async function loadPoints() {
  for (const u of thumbUrls.values()) URL.revokeObjectURL(u);
  thumbUrls.clear();
  closeComposer();
  try {
    points = parsePoints(await invoke<string | null>("load_session_file", { id: sessionId(), name: "points.json" }));
  } catch (e) {
    points = emptyPoints();
    $("v-error").textContent = `Could not read points.json: ${String(e)}`;
  }
  $<HTMLSelectElement>("s-mode").value = mode();
  renderBuckets();
  renderPoints();
}

async function savePoints() {
  await invoke("save_session_file", { id: sessionId(), name: "points.json", contents: JSON.stringify(points, null, 2) });
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

/** Bucket picker = the current mode's buckets (plus the edited point's own bucket if it is from the other mode). */
function renderBuckets() {
  const sel = $<HTMLSelectElement>("c-bucket");
  const opts = bucketsFor(mode()).map((b) => option(b.id, b.label));
  const own = draft?.id ? points.points.find((p) => p.id === draft!.id)?.bucket : undefined;
  if (own && !bucketsFor(mode()).some((b) => b.id === own)) opts.push(option(own, bucketLabel(own)));
  const keep = sel.value;
  sel.replaceChildren(...opts);
  sel.value = own ?? (opts.some((o) => o.value === keep) ? keep : lastBucket);
  if (!sel.value) sel.selectedIndex = 0;

  const filter = $<HTMLSelectElement>("p-filter");
  const prev = filter.value;
  const ids = bucketsFor(mode()).map((b) => b.id);
  for (const p of points.points) if (!ids.includes(p.bucket)) ids.push(p.bucket);
  filter.replaceChildren(option("", "All buckets"), ...ids.map((id) => {
    const n = points.points.filter((p) => p.bucket === id).length;
    return option(id, `${bucketLabel(id)}${n ? ` (${n})` : ""}`);
  }));
  filter.value = ids.includes(prev) ? prev : "";
}

async function thumbUrl(name: string): Promise<string> {
  let u = thumbUrls.get(name);
  if (!u) {
    const bytes = await invoke<ArrayBuffer>("load_session_bytes", { id: sessionId(), name });
    u = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    thumbUrls.set(name, u);
  }
  return u;
}

function markPinned() {
  const pinned = pinnedTimes(points.points);
  lines.forEach((l, i) => lineEls[i]?.classList.toggle("pinned", pinned.has(l.start)));
}

function renderPoints() {
  markPinned();
  const shown = filterPoints(points.points, $<HTMLSelectElement>("p-filter").value);
  $("p-count").textContent = `${shown.length} of ${points.points.length} point${points.points.length === 1 ? "" : "s"}`;
  $("p-list").replaceChildren(...shown.map(pointItem));
}

function pointItem(p: Point): HTMLLIElement {
  const li = document.createElement("li");
  li.classList.toggle("editing", draft?.id === p.id);
  const body = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "p-meta";
  const jump = document.createElement("button");
  jump.className = "linkish";
  jump.textContent = fmtTime(p.time);
  jump.title = "Jump to this point's timestamp";
  jump.addEventListener("click", () => void seekTo(p.time));
  const bucket = document.createElement("span");
  bucket.className = "p-bucket";
  bucket.textContent = bucketLabel(p.bucket);
  meta.append(`#${p.order} · `, jump, " · ", bucket);
  const text = document.createElement("div");
  text.textContent = p.text || "(no text yet)";
  const quote = document.createElement("q");
  quote.textContent = p.quote;
  body.append(meta, text, quote);
  if (p.screenshot) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "screenshot";
    img.title = "Jump to the screenshot's frame";
    img.addEventListener("click", () => void seekTo(p.shot_time ?? p.time));
    thumbUrl(p.screenshot).then((u) => (img.src = u), () => (img.alt = "screenshot missing"));
    body.append(img);
  }
  const actions = document.createElement("div");
  actions.className = "p-actions";
  const edit = document.createElement("button");
  edit.textContent = "Edit";
  edit.addEventListener("click", () => editPoint(p));
  const del = document.createElement("button");
  del.textContent = "Delete";
  del.addEventListener("click", () => {
    if (del.dataset.armed) void removePoint(p);
    else {
      del.dataset.armed = "1";
      del.textContent = "Really delete?";
      setTimeout(() => {
        delete del.dataset.armed;
        del.textContent = "Delete";
      }, 3000);
    }
  });
  actions.append(edit, del);
  li.append(body, actions);
  return li;
}

/** Show `src` in the composer. `owned` = a fresh blob URL of an unsaved grab (revoked on replace); otherwise it belongs to thumbUrls. */
function setDraftThumb(src: string | null, owned = false) {
  if (draftThumbUrl) URL.revokeObjectURL(draftThumbUrl);
  draftThumbUrl = owned ? src : null;
  const img = $<HTMLImageElement>("c-thumb");
  img.hidden = !src;
  if (src) img.src = src;
  else img.removeAttribute("src");
  $("c-shot-clear").hidden = !src;
}

function openComposer(d: Draft, text: string) {
  draft = d;
  $("c-empty").hidden = true;
  $("composer").hidden = false;
  $("c-time").textContent = fmtTime(d.time);
  $("c-quote").textContent = d.quote;
  $<HTMLTextAreaElement>("c-text").value = text;
  $("c-status").textContent = "";
  $<HTMLButtonElement>("c-save").textContent = d.id ? "Save changes" : "Save point";
  renderBuckets();
  setDraftThumb(null);
  const shot = d.shot;
  if (shot?.kind === "existing") {
    void thumbUrl(shot.name).then((u) => draft?.shot === shot && setDraftThumb(u), () => {});
  }
  renderPoints();
  $<HTMLTextAreaElement>("c-text").focus();
}

function closeComposer() {
  draft = null;
  setDraftThumb(null);
  $("composer").hidden = true;
  $("c-empty").hidden = false;
}

function startNewPoint(lineIndex: number) {
  const l = lines[lineIndex];
  if (!l) return;
  openComposer({ id: null, quote: l.text, time: l.start, shot: null }, "");
}

function editPoint(p: Point) {
  openComposer({
    id: p.id, quote: p.quote, time: p.time,
    shot: p.screenshot ? { kind: "existing", name: p.screenshot, time: p.shot_time } : null,
  }, p.text);
  $<HTMLSelectElement>("c-bucket").value = p.bucket;
}

async function grabIntoDraft() {
  if (!draft) {
    // Screenshot with no point open: start one on the line playing now.
    const i = lineAt(lines, video.currentTime);
    if (i < 0) {
      $("v-error").textContent = "Pin a transcript line first — the screenshot goes into that point.";
      return;
    }
    startNewPoint(i);
  }
  const status = $("c-status");
  status.textContent = "Grabbing frame…";
  try {
    const { blob, time, via } = await grabFrame(video, probed?.input ?? null);
    if (!draft) return;
    draft.shot = { kind: "new", blob, time };
    setDraftThumb(URL.createObjectURL(blob), true);
    status.textContent = `Frame at ${fmtTime(time)} (${(blob.size / 1024).toFixed(0)} KB, via ${via}) — saved with the point.`;
  } catch (e) {
    status.textContent = `Screenshot failed: ${String(e)}`;
  }
}

async function writeShot(pointId: string, blob: Blob): Promise<string> {
  const name = shotName(pointId);
  await invoke("save_session_bytes", new Uint8Array(await blob.arrayBuffer()), {
    headers: { "x-session": sessionId(), "x-name": name },
  });
  return name;
}

async function deleteShot(name: string) {
  await invoke("delete_session_file", { id: sessionId(), name }).catch(() => {});
  const u = thumbUrls.get(name);
  if (u) URL.revokeObjectURL(u);
  thumbUrls.delete(name);
}

async function saveDraft() {
  if (!draft) return;
  const d = draft;
  const bucket = $<HTMLSelectElement>("c-bucket").value;
  const text = $<HTMLTextAreaElement>("c-text").value.trim();
  const status = $("c-status");
  status.textContent = "Saving…";
  try {
    if (d.id) {
      const p = points.points.find((x) => x.id === d.id);
      if (!p) throw new Error("point no longer exists");
      const old = p.screenshot;
      let screenshot = old, shot_time = p.shot_time;
      if (d.shot?.kind === "new") {
        screenshot = await writeShot(p.id, d.shot.blob);
        shot_time = d.shot.time;
      } else if (!d.shot) {
        screenshot = null;
        shot_time = null;
      }
      updatePoint(points, p.id, { bucket, text, screenshot, shot_time });
      await savePoints();
      if (old && old !== screenshot) await deleteShot(old);
    } else {
      const p = newPoint(points, { bucket, quote: d.quote, time: d.time, text, screenshot: null, shot_time: null });
      if (d.shot?.kind === "new") {
        try {
          updatePoint(points, p.id, { screenshot: await writeShot(p.id, d.shot.blob), shot_time: d.shot.time });
        } catch (e) {
          deletePoint(points, p.id);
          throw e;
        }
      }
      await savePoints();
    }
  } catch (e) {
    status.textContent = `Save failed: ${String(e)}`;
    return;
  }
  lastBucket = bucket;
  closeComposer();
  renderBuckets();
  renderPoints();
}

async function removePoint(p: Point) {
  deletePoint(points, p.id);
  if (draft?.id === p.id) closeComposer();
  try {
    await savePoints();
  } catch (e) {
    $("v-error").textContent = `Could not save points.json: ${String(e)}`;
  }
  if (p.screenshot) await deleteShot(p.screenshot);
  renderBuckets();
  renderPoints();
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  void saveDraft();
});
$("c-cancel").addEventListener("click", () => {
  closeComposer();
  renderPoints();
});
$("c-time").addEventListener("click", () => draft && void seekTo(draft.time));
$("c-shot").addEventListener("click", () => void grabIntoDraft());
$("v-shot").addEventListener("click", () => void grabIntoDraft());
$("c-shot-clear").addEventListener("click", () => {
  if (!draft) return;
  draft.shot = null;
  setDraftThumb(null);
  $("c-status").textContent = "Screenshot removed (takes effect on save).";
});
$("p-filter").addEventListener("change", () => renderPoints());
async function saveSession() {
  if (!session) return;
  await invoke("save_session_file", { id: session.id, name: "session.json", contents: JSON.stringify(session, null, 2) })
    .catch((err) => {
      $("v-error").textContent = `Could not save session.json: ${String(err)}`;
      $("a-status").textContent = `Could not save session.json: ${String(err)}`;
    });
}
/** Mode lives on the session and is shared by the Scrub and Assemble screens. */
async function setMode(m: Mode) {
  if (!session) return;
  session.mode = m;
  $<HTMLSelectElement>("s-mode").value = m;
  $<HTMLSelectElement>("r-mode").value = m;
  renderBuckets();
  renderPoints();
  if (!$("screen-assemble").hidden) renderAssemble();
  await saveSession();
}
$<HTMLSelectElement>("s-mode").addEventListener("change", (e) => void setMode((e.target as HTMLSelectElement).value as Mode));

let corsRetried = false;
video.addEventListener("error", () => {
  // If the webview refuses the CORS-mode load, play without crossOrigin; screenshots then
  // fall back to Mediabunny frame decode (the canvas path would be tainted).
  if (video.crossOrigin && !corsRetried && video.src) {
    corsRetried = true;
    const src = video.src;
    video.removeAttribute("crossorigin");
    video.src = src;
    return;
  }
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

// ---------- 4. Assemble ----------
let review: ReviewFile = emptyReview();
let reviewSaveTimer: number | undefined;
let previewTimer: number | undefined;

async function loadReview() {
  try {
    review = parseReview(await invoke<string | null>("load_session_file", { id: sessionId(), name: "review.json" }));
  } catch (e) {
    review = emptyReview();
    $("a-status").textContent = `Could not read review.json: ${String(e)}`;
  }
}

function writeReview() {
  clearTimeout(reviewSaveTimer);
  if (!session) return Promise.resolve();
  return invoke("save_session_file", { id: sessionId(), name: "review.json", contents: JSON.stringify(review, null, 2) })
    .then(() => {}, (e) => void ($("a-status").textContent = `Could not save review.json: ${String(e)}`));
}
function saveReviewSoon() {
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = window.setTimeout(() => void writeReview(), 400);
}

async function openAssemble() {
  if (!session) return;
  closeComposer();
  await loadReview();
  $<HTMLInputElement>("r-title").value = session.title;
  $<HTMLSelectElement>("r-mode").value = session.mode;
  $<HTMLInputElement>("r-verdict").value = review.verdict;
  $<HTMLInputElement>("r-who").value = review.who_for;
  $<HTMLInputElement>("r-score").value = review.score;
  $("a-status").textContent = "";
  renderAssemble();
  show("assemble");
}

/** Editor sections: one per bucket that has points, prose field above its points. */
function renderAssemble() {
  $("r-score-row").hidden = mode() === "rapid"; // no scores in rapid mode (DESIGN.md)
  const buckets = sectionBuckets(mode(), points.points);
  const box = $("a-sections");
  if (!buckets.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No points yet — pin transcript lines on the Scrub & point screen; each bucket with points becomes a section here.";
    box.replaceChildren(p);
  } else {
    box.replaceChildren(...buckets.map((b, i) => sectionEl(b, i)));
  }
  $<HTMLButtonElement>("a-draft").disabled = !buckets.length;
  refreshDraftWarning();
  renderPreviewSoon(0);
}

function sectionEl(bucket: string, i: number): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "a-section";
  const h = document.createElement("h3");
  h.textContent = `${String(i + 1).padStart(2, "0")}. ${bucketLabel(bucket)}`;
  const badge = document.createElement("span");
  badge.className = "draft-badge";
  badge.textContent = "AI DRAFT";
  h.append(badge);
  const ta = document.createElement("textarea");
  ta.rows = 5;
  ta.placeholder = "Write this section… (blank line = new paragraph)";
  ta.value = review.sections[bucket]?.prose ?? "";
  const draftRow = document.createElement("div");
  draftRow.className = "draft-row";
  const signOff = document.createElement("button");
  signOff.type = "button";
  signOff.textContent = "I've edited this — it's mine now";
  draftRow.append("Draft text from Gemini. Edit it into your own words, then:", signOff);
  const sync = () => {
    const d = !!review.sections[bucket]?.draft && ta.value.trim() !== "";
    wrap.classList.toggle("is-draft", d);
    badge.hidden = !d;
    draftRow.hidden = !d;
  };
  const changed = (delay?: number) => {
    sync();
    refreshDraftWarning();
    saveReviewSoon();
    renderPreviewSoon(delay);
  };
  ta.addEventListener("input", () => {
    // Typing keeps the draft flag (one keystroke doesn't make AI prose the user's); sign-off clears it.
    const wasDraft = review.sections[bucket]?.draft ?? false;
    review.sections[bucket] = { prose: ta.value, draft: wasDraft && ta.value.trim() !== "" };
    changed();
  });
  signOff.addEventListener("click", () => {
    const s = review.sections[bucket];
    if (s) s.draft = false;
    changed(0);
  });
  sync();

  const list = document.createElement("ol");
  list.className = "a-points";
  for (const p of pointsIn(points.points, bucket)) {
    const li = document.createElement("li");
    const t = document.createElement("time");
    t.textContent = `[${fmtTime(p.time)}]`;
    const body = document.createElement("div");
    body.append(p.text || "(no text)");
    if (p.quote) {
      const q = document.createElement("q");
      q.textContent = p.quote;
      body.append(" ", q);
    }
    li.append(t, body);
    if (p.screenshot) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = "screenshot";
      thumbUrl(p.screenshot).then((u) => (img.src = u), () => (img.alt = "screenshot missing"));
      li.append(img);
    }
    list.append(li);
  }
  wrap.append(h, ta, draftRow, list);
  return wrap;
}

function refreshDraftWarning() {
  const n = unreviewedDrafts(review, sectionBuckets(mode(), points.points)).length;
  const el = $("a-draft-warning");
  el.hidden = n === 0;
  el.textContent = `${n} section${n === 1 ? "" : "s"} still hold${n === 1 ? "s" : ""} unreviewed AI draft text (red dashed). ` +
    "Nothing is published automatically; edit and sign off each one.";
}

/** Live preview: the styled page in a script-less iframe; scroll position survives re-renders. */
function renderPreviewSoon(delay = 250) {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void renderPreview(), delay);
}
async function renderPreview() {
  if (!session) return;
  const shots = points.points.map((p) => p.screenshot).filter((n): n is string => !!n);
  await Promise.all(shots.map((n) => thumbUrl(n).catch(() => null)));
  const html = renderPage({
    title: session.title, mode: mode(), review, points: points.points,
    shotUrl: (n) => thumbUrls.get(n) ?? null, date: session.date,
  });
  const frame = $<HTMLIFrameElement>("a-preview");
  const y = frame.contentWindow?.scrollY ?? 0;
  frame.addEventListener("load", () => frame.contentWindow?.scrollTo(0, y), { once: true });
  frame.srcdoc = html;
}

const bindSetting = (id: string, apply: (v: string) => void) =>
  $<HTMLInputElement>(id).addEventListener("input", (e) => {
    apply((e.target as HTMLInputElement).value);
    saveReviewSoon();
    renderPreviewSoon();
  });
bindSetting("r-verdict", (v) => (review.verdict = v));
bindSetting("r-who", (v) => (review.who_for = v));
bindSetting("r-score", (v) => (review.score = v));
$<HTMLInputElement>("r-title").addEventListener("change", (e) => {
  if (!session) return;
  session.title = (e.target as HTMLInputElement).value.trim();
  void saveSession();
  renderPreviewSoon(0);
});
$<HTMLSelectElement>("r-mode").addEventListener("change", (e) => void setMode((e.target as HTMLSelectElement).value as Mode));

$("b-assemble").addEventListener("click", () => void openAssemble());
$("a-back").addEventListener("click", () => {
  void writeReview();
  renderBuckets();
  renderPoints();
  show("scrub");
});

// AI draft: buckets + points → the provider picked in Settings (key stays in Rust) → DRAFT prose in empty / still-draft sections only.
$("a-draft").addEventListener("click", async () => {
  if (!session) return;
  const status = $("a-status");
  const provider = aiProvider();
  const providerName = AI_PROVIDERS[provider].keyLabel.replace(" API key", "");
  if (!(await invoke<boolean>(`has_${provider}_key`).catch(() => false))) {
    status.textContent = `Enter your ${providerName} API key in Settings first.`;
    $<HTMLDetailsElement>("settings").open = true;
    return;
  }
  const buckets = sectionBuckets(mode(), points.points);
  const btn = $<HTMLButtonElement>("a-draft");
  btn.disabled = true;
  const model = aiModel();
  status.textContent = `Drafting with ${model || providerName}…`;
  try {
    const prompt = draftPrompt(
      { title: session.title, mode: mode(), verdict: review.verdict, who_for: review.who_for, points: points.points },
      buckets,
    );
    const text = await invoke<string>("ai_draft", {
      provider,
      model,
      baseUrl: provider === "openai_compat" ? (aiBaseInput.value.trim() || AI_DEFAULT_BASE) : "",
      system: DRAFT_SYSTEM,
      prompt,
    });
    const { filled, kept } = applyDraft(review, parseDraft(text, buckets));
    await writeReview();
    renderAssemble();
    status.textContent = `Draft filled ${filled.length} section${filled.length === 1 ? "" : "s"}` +
      (kept.length ? `; left ${kept.length} with your own prose untouched` : "") + ". It's a draft — edit it.";
  } catch (e) {
    status.textContent = `AI draft failed: ${String(e)}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Cloudflare settings (token in the keychain; account/project/site URL are not secrets) ----------
const cfInputs = { account: $<HTMLInputElement>("cf-account"), project: $<HTMLInputElement>("cf-project"), site: $<HTMLInputElement>("cf-site") };
for (const [k, ls] of [["account", LS_CF_ACCOUNT], ["project", LS_CF_PROJECT], ["site", LS_CF_SITE]] as const) {
  cfInputs[k].value = localStorage.getItem(ls) ?? "";
  cfInputs[k].addEventListener("change", () => localStorage.setItem(ls, cfInputs[k].value.trim()));
}
async function refreshCfStatus() {
  const has = await invoke<boolean>("has_cloudflare_key").catch(() => false);
  $("cf-status").textContent = has ? "token stored in OS keychain" : "no token set";
}
$("cf-save").addEventListener("click", async () => {
  const el = $<HTMLInputElement>("cf-key");
  try {
    await invoke("set_cloudflare_key", { key: el.value });
    el.value = "";
  } catch (e) {
    $("cf-status").textContent = `could not store token: ${String(e)}`;
    return;
  }
  void refreshCfStatus();
});
$("cf-clear").addEventListener("click", async () => {
  await invoke("clear_cloudflare_key").catch(() => {});
  void refreshCfStatus();
});
void refreshCfStatus();

// ---------- 5. Publish ----------
// Export = write the page into the local site folder. Publish = upload that folder to
// Cloudflare Pages on an explicit double click. The Itch comment is copy-only.
interface ExportResult { site_dir: string; review_dir: string }
interface PublishResult { site_url: string; deployment_url: string; uploaded: number }

const commentEl = $<HTMLTextAreaElement>("pb-comment");

function publishDrafts(): number {
  return unreviewedDrafts(review, sectionBuckets(mode(), points.points)).length;
}

function refreshPublishScreen() {
  const n = publishDrafts();
  const warn = $("pb-draft-warning");
  warn.hidden = n === 0;
  warn.textContent = `${n} section${n === 1 ? "" : "s"} still hold${n === 1 ? "s" : ""} unreviewed AI draft text. ` +
    "Go back and sign them off, or tick the override to export with the draft marks showing.";
  $("pb-override-row").hidden = n === 0;
  const blocked = n > 0 && !$<HTMLInputElement>("pb-override").checked;
  $<HTMLButtonElement>("pb-export").disabled = blocked;
  $<HTMLButtonElement>("pb-publish").disabled = blocked;
  $("pb-state").textContent = `state: ${review.publish_state}${review.slug ? ` · /${review.slug}/` : ""}`;
  const a = $<HTMLAnchorElement>("pb-url");
  a.textContent = review.url;
  a.href = review.url || "#";
}

function generateComment(): string {
  return itchComment({ hook: hookLine(review, points.points, mode()), verdict: review.verdict, url: review.url });
}

async function openPublish() {
  if (!session) return;
  await writeReview();
  $<HTMLInputElement>("pb-override").checked = false;
  for (const id of ["pb-export-status", "pb-publish-status", "pb-copy-status"]) $(id).textContent = "";
  if (!review.itch_comment.trim()) review.itch_comment = generateComment();
  commentEl.value = review.itch_comment;
  refreshPublishScreen();
  show("publish");
}

/** Render + write this review into the site folder. Returns the export paths. */
async function exportReview(): Promise<ExportResult> {
  const s = session!;
  const entries = parseSiteEntries(await invoke<string | null>("load_site_entries"));
  review.slug = chooseSlug(review.slug, s.title, s.id, entries);
  const all = upsertEntry(entries, { slug: review.slug, session_id: s.id, title: s.title, date: s.date, mode: mode() });
  const shots = [...new Set(points.points.map((p) => p.screenshot).filter((n): n is string => !!n))];
  const html = renderPage({
    title: s.title, mode: mode(), review, points: points.points,
    shotUrl: (n) => `shots/${encodeURIComponent(n)}`, date: s.date,
  });
  const res = await invoke<ExportResult>("export_review", {
    id: s.id, slug: review.slug, html, shots, indexHtml: renderIndex(all), entriesJson: JSON.stringify({ entries: all }, null, 2),
  });
  if (review.publish_state === "draft") review.publish_state = "exported";
  await writeReview();
  return res;
}

$("pb-export").addEventListener("click", async () => {
  if (!session) return;
  const btn = $<HTMLButtonElement>("pb-export"), status = $("pb-export-status");
  btn.disabled = true;
  status.textContent = "Exporting…";
  try {
    const res = await exportReview();
    status.textContent = "Saved. This review's folder:";
    $("pb-dir").textContent = `${res.review_dir}  (site folder: ${res.site_dir})`;
  } catch (e) {
    status.textContent = `Export failed: ${String(e)}`;
  } finally {
    refreshPublishScreen();
  }
});

let publishArmed: number | undefined;
$("pb-publish").addEventListener("click", async () => {
  if (!session) return;
  const btn = $<HTMLButtonElement>("pb-publish"), status = $("pb-publish-status");
  const accountId = cfInputs.account.value.trim(), project = cfInputs.project.value.trim();
  if (!accountId || !project || !(await invoke<boolean>("has_cloudflare_key").catch(() => false))) {
    status.textContent = "Set the Cloudflare token, account ID and project name in Settings first (or use Save files locally).";
    $<HTMLDetailsElement>("settings").open = true;
    return;
  }
  // Two clicks: the first arms, the second uploads. Nothing goes out without both.
  if (publishArmed === undefined) {
    btn.textContent = `Click again to upload to “${project}”`;
    publishArmed = window.setTimeout(() => {
      publishArmed = undefined;
      btn.textContent = "Publish to Cloudflare Pages";
    }, 5000);
    return;
  }
  clearTimeout(publishArmed);
  publishArmed = undefined;
  btn.textContent = "Publish to Cloudflare Pages";
  btn.disabled = true;
  try {
    status.textContent = "Exporting…";
    const exp = await exportReview();
    $("pb-dir").textContent = `${exp.review_dir}  (site folder: ${exp.site_dir})`;
    status.textContent = `Uploading the site folder to ${project}…`;
    const res = await invoke<PublishResult>("publish_site", { accountId, project });
    const base = normalizeSiteBase(cfInputs.site.value) || res.site_url;
    const placeholder = review.itch_comment === "" || review.itch_comment === generateComment();
    review.url = reviewUrl(base, review.slug);
    review.publish_state = "published";
    // Refresh the comment only if it was still the generated text (keeps the user's edits).
    if (placeholder) review.itch_comment = generateComment();
    else if (review.itch_comment.includes("[link — publish first]")) {
      review.itch_comment = review.itch_comment.replace("[link — publish first]", review.url);
    }
    commentEl.value = review.itch_comment;
    await writeReview();
    status.textContent = `Published: ${res.uploaded} new file${res.uploaded === 1 ? "" : "s"} uploaded (deployment ${res.deployment_url}). ` +
      "The live link can take a minute to update.";
  } catch (e) {
    status.textContent = `Publish failed: ${String(e)}. Your files are still in the local site folder.`;
  } finally {
    refreshPublishScreen();
  }
});

commentEl.addEventListener("input", () => {
  review.itch_comment = commentEl.value;
  saveReviewSoon();
});
$("pb-regen").addEventListener("click", () => {
  review.itch_comment = commentEl.value = generateComment();
  saveReviewSoon();
});
$("pb-copy").addEventListener("click", async () => {
  const status = $("pb-copy-status");
  try {
    await navigator.clipboard.writeText(commentEl.value);
  } catch {
    // Fallback for webviews that refuse the async clipboard API.
    commentEl.select();
    if (!document.execCommand("copy")) {
      status.textContent = "Copy failed — select the text and press Ctrl+C.";
      return;
    }
  }
  status.textContent = "Copied. Paste it into the Itch comment box yourself.";
});
$("pb-override").addEventListener("change", () => refreshPublishScreen());
$("a-publish").addEventListener("click", () => void openPublish());
$("pb-back").addEventListener("click", () => void writeReview().then(() => openAssemble()));
