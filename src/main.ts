// U1 core loop: Import → Transcribe → Scrub. The recording is only ever
// addressed by absolute path (drag-drop) and read through the `media` scheme.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { extractMicWav, grabFrame, mediaUrl, probe, type Probe } from "./media";
import {
  bucketLabel, bucketsFor, deletePoint, emptyPoints, filterPoints, newPoint, parsePoints, pinnedTimes,
  shotName, updatePoint, type Mode, type Point, type PointsFile,
} from "./points";
import {
  chunkRanges, costCents, defaultMicTrack, fmtTime, groupLines, lineAt, type Line, type Word,
} from "./transcript";

interface MediaInfo { path: string; size_bytes: number }

interface Session {
  id: string;
  title: string;
  recording_path: string;
  date: string;
  mode: Mode;
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

async function openScrub(path: string, words: Word[]) {
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
  video.src = mediaUrl(path);
  video.requestVideoFrameCallback(onFrame);
  await loadPoints();
  show("scrub");
}

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
$<HTMLSelectElement>("s-mode").addEventListener("change", async (e) => {
  if (!session) return;
  session.mode = (e.target as HTMLSelectElement).value as Mode;
  renderBuckets();
  renderPoints();
  await invoke("save_session_file", { id: session.id, name: "session.json", contents: JSON.stringify(session, null, 2) })
    .catch((err) => ($("v-error").textContent = `Could not save session.json: ${String(err)}`));
});

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
