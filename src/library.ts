// Pure Library logic: session model, status derivation, search, and the demo-day
// queue. No DOM, no Tauri, so `node --test` can exercise it (library.test.mjs).
// Each session is a folder under app data `sessions/<id>/`: session.json, mic-NNN.wav,
// transcript.json/.txt, points.json, shot-*.jpg, review.json.
import { parsePoints, type Mode } from "./points";
import { parseReview, sectionBuckets, unreviewedDrafts } from "./review";

export interface Session {
  id: string;
  /** Game title (defaults to the recording's file name). */
  title: string;
  /** Event, e.g. "Demo Day Nov 2026" — searchable; may be empty. */
  event: string;
  recording_path: string;
  /** ISO creation time. */
  date: string;
  mode: Mode;
  mic_track: number;
  /** Clip length in seconds (probed at import); 0 = unknown (pre-U5 sessions). */
  duration: number;
}

/** What the backend's `list_sessions` returns per session folder (raw file contents). */
export interface SessionSummary {
  id: string;
  session: string;
  points: string | null;
  review: string | null;
  transcribed: boolean;
  partial_transcript: boolean;
  recording_exists: boolean;
}

export type Status = "imported" | "transcribed" | "points pinned" | "review done" | "published";
export const STATUSES: readonly Status[] = ["imported", "transcribed", "points pinned", "review done", "published"];

export interface LibraryRow {
  session: Session;
  status: Status;
  points: number;
  partial_transcript: boolean;
  recording_exists: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Parse session.json, filling fields older sessions lack (event, duration). Throws on non-JSON. */
export function parseSession(json: string, id: string): Session {
  const raw = JSON.parse(json) as Partial<Session>;
  return {
    id: str(raw.id) || id,
    title: str(raw.title),
    event: str(raw.event),
    recording_path: str(raw.recording_path),
    date: str(raw.date),
    mode: raw.mode === "rapid" ? "rapid" : "full",
    mic_track: num(raw.mic_track) || 2,
    duration: num(raw.duration),
  };
}

/**
 * Furthest stage reached. "Review done" = exported once, or every section has prose,
 * none is an unsigned AI draft, and the verdict is written.
 */
export function deriveStatus(s: Pick<SessionSummary, "points" | "review" | "transcribed">, mode: Mode): { status: Status; points: number } {
  let points = 0;
  let pts: ReturnType<typeof parsePoints>["points"] = [];
  try {
    pts = parsePoints(s.points).points;
    points = pts.length;
  } catch { /* unreadable points.json counts as none */ }
  let review = null;
  try {
    review = s.review ? parseReview(s.review) : null;
  } catch { /* unreadable review.json counts as none */ }
  if (review?.publish_state === "published") return { status: "published", points };
  if (review?.publish_state === "exported") return { status: "review done", points };
  if (review && points) {
    const buckets = sectionBuckets(mode, pts);
    const written = buckets.every((b) => (review.sections[b]?.prose ?? "").trim() !== "");
    if (written && review.verdict.trim() && !unreviewedDrafts(review, buckets).length) return { status: "review done", points };
  }
  if (points) return { status: "points pinned", points };
  return { status: s.transcribed ? "transcribed" : "imported", points };
}

/** Summaries → rows, newest first. Folders with an unreadable session.json are dropped. */
export function toRows(summaries: readonly SessionSummary[]): LibraryRow[] {
  const rows: LibraryRow[] = [];
  for (const s of summaries) {
    let session: Session;
    try {
      session = parseSession(s.session, s.id);
    } catch {
      continue;
    }
    session.id = s.id; // the folder name is the id that every command uses
    rows.push({ session, ...deriveStatus(s, session.mode), partial_transcript: s.partial_transcript, recording_exists: s.recording_exists });
  }
  return rows.sort((a, b) => b.session.date.localeCompare(a.session.date) || a.session.id.localeCompare(b.session.id));
}

/** Case-insensitive match of every whitespace-separated term against title or event. */
export function searchRows(rows: readonly LibraryRow[], query: string): LibraryRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter((r) => {
    const hay = `${r.session.title}\n${r.session.event}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** A session's work is finished for demo-day purposes once the review is done (or published). */
export function isFinished(status: Status): boolean {
  return status === "review done" || status === "published";
}

// ---------- demo-day queue (ordered session ids) ----------

export function parseQueue(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : [];
  } catch {
    return [];
  }
}

export function enqueue(queue: readonly string[], ids: readonly string[]): string[] {
  return [...queue, ...ids.filter((id, i) => !queue.includes(id) && ids.indexOf(id) === i)];
}

/** Drop ids the library no longer has (session folder deleted by hand). */
export function pruneQueue(queue: readonly string[], known: ReadonlySet<string>): string[] {
  return queue.filter((id) => known.has(id));
}

/**
 * The next session to work: the first unfinished one after `current` in queue order,
 * wrapping to the start so an item skipped earlier is not lost. null = all finished.
 */
export function nextInQueue(queue: readonly string[], statusOf: (id: string) => Status | undefined, current: string | null): string | null {
  const start = current ? queue.indexOf(current) + 1 : 0;
  const order = [...queue.slice(start), ...queue.slice(0, start)];
  return order.find((id) => id !== current && !isFinished(statusOf(id) ?? "imported")) ?? null;
}

// ---------- new sessions ----------

export function fileStem(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
}

/** `<UTC stamp>-<file stem>`, ≤64 chars of [A-Za-z0-9_-]; `taken` forces a unique suffix (same file queued twice in one second). */
export function newSessionId(path: string, now: Date, taken: ReadonlySet<string> = new Set()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug = (fileStem(path) || "rec").replace(/[^A-Za-z0-9_-]+/g, "-");
  const base = `${stamp}-${slug}`.slice(0, 64);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, 64 - String(n).length - 1)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
