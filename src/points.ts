// Pure point/bucket logic: no DOM, no Tauri, so `node --test` can exercise it
// (see points.test.mjs). Persisted as `points.json` in the session folder.

export type Mode = "full" | "rapid";

export interface Bucket { id: string; label: string }

/** Full mode, 14 buckets — labels exactly as DESIGN.md lists them. */
export const FULL_BUCKETS: readonly Bucket[] = [
  { id: "overview", label: "Overview/Hook" },
  { id: "character", label: "Character" },
  { id: "controls", label: "Controls" },
  { id: "camera", label: "Camera" },
  { id: "feel", label: "Game Feel/Juice" },
  { id: "systems", label: "Gameplay Systems" },
  { id: "level", label: "Level Design/Difficulty/Pacing" },
  { id: "graphics", label: "Graphical Presentation" },
  { id: "audio", label: "Audio Presentation" },
  { id: "story", label: "Story/Writing" },
  { id: "technical", label: "Performance/Technical" },
  { id: "value", label: "Length/Value/Replay" },
  { id: "context", label: "Context" },
  { id: "verdict", label: "Verdict" },
];

/** Rapid (demo-day) mode, 6 buckets. Separate ids: "Feel" here is 3Cs + juice, not full mode's Game Feel. */
export const RAPID_BUCKETS: readonly Bucket[] = [
  { id: "rapid-overview", label: "Overview" },
  { id: "rapid-feel", label: "Feel (3Cs + juice)" },
  { id: "rapid-systems", label: "Systems" },
  { id: "rapid-graphics", label: "Graphics" },
  { id: "rapid-audio", label: "Audio" },
  { id: "rapid-verdict", label: "Verdict" },
];

export function bucketsFor(mode: Mode): readonly Bucket[] {
  return mode === "rapid" ? RAPID_BUCKETS : FULL_BUCKETS;
}

export function bucketLabel(id: string): string {
  const b = FULL_BUCKETS.find((x) => x.id === id) ?? RAPID_BUCKETS.find((x) => x.id === id);
  if (!b) return id;
  return RAPID_BUCKETS.includes(b) ? `${b.label} (rapid)` : b.label;
}

export interface Point {
  /** Stable id, e.g. "p0007". */
  id: string;
  bucket: string;
  /** The pinned transcript line: quoted text + its timestamp on the recording timeline (s). */
  quote: string;
  time: number;
  /** The reviewer's own text for the point. */
  text: string;
  /** Screenshot file name inside the session folder (JPEG), or null. */
  screenshot: string | null;
  /** Recording time of the grabbed frame (s), or null. */
  shot_time: number | null;
  /** Creation order, 1-based, never reused. */
  order: number;
}

export interface PointsFile { version: 1; next: number; points: Point[] }

export function emptyPoints(): PointsFile {
  return { version: 1, next: 1, points: [] };
}

/** Parse points.json; tolerates a missing file (null) and drops malformed entries. */
export function parsePoints(json: string | null): PointsFile {
  if (!json) return emptyPoints();
  const raw = JSON.parse(json) as Partial<PointsFile>;
  const points = (Array.isArray(raw.points) ? raw.points : []).filter(
    (p): p is Point => !!p && typeof p.id === "string" && typeof p.bucket === "string" &&
      typeof p.time === "number" && typeof p.order === "number",
  );
  const maxOrder = points.reduce((m, p) => Math.max(m, p.order), 0);
  return { version: 1, next: Math.max(Number(raw.next) || 1, maxOrder + 1), points };
}

export function newPoint(file: PointsFile, init: Omit<Point, "id" | "order">): Point {
  const order = file.next++;
  const p: Point = { ...init, id: `p${String(order).padStart(4, "0")}`, order };
  file.points.push(p);
  return p;
}

export function updatePoint(file: PointsFile, id: string, patch: Partial<Omit<Point, "id" | "order">>): Point | null {
  const p = file.points.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch);
  return p;
}

export function deletePoint(file: PointsFile, id: string): Point | null {
  const i = file.points.findIndex((x) => x.id === id);
  return i < 0 ? null : file.points.splice(i, 1)[0];
}

/** Points in creation order, optionally restricted to one bucket ("" = all). */
export function filterPoints(points: readonly Point[], bucket: string): Point[] {
  return points.filter((p) => !bucket || p.bucket === bucket).sort((a, b) => a.order - b.order);
}

/** Pinned transcript lines are matched by start time (a line's timestamp is its first word's start). */
export function pinnedTimes(points: readonly Point[]): Set<number> {
  return new Set(points.map((p) => p.time));
}

/** Screenshot file name for a point; the timestamp suffix keeps a replaced shot from colliding with the old one. */
export function shotName(pointId: string, now = Date.now()): string {
  return `shot-${pointId}-${now}.jpg`;
}
