// Pure Publish logic: site layout (slugs, the reviews index page) and the Itch
// comment generator. No DOM, no Tauri, so `node --test` can exercise it (see
// publish.test.mjs). Nothing here posts anything anywhere.
import type { Mode, Point } from "./points";
import { asciiBanner, esc, PAGE_CSS, pointsIn, type ReviewFile } from "./review";

/** One published/exported review on the local site (`site/reviews.json`). */
export interface SiteEntry {
  slug: string;
  session_id: string;
  title: string;
  /** ISO date of the session. */
  date: string;
  mode: Mode;
}

export function slugify(title: string): string {
  const s = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return s || "review";
}

/** Slug for a session: its saved one, else the title's, made unique against other sessions' entries. */
export function chooseSlug(saved: string, title: string, sessionId: string, entries: readonly SiteEntry[]): string {
  if (saved) return saved;
  const taken = new Set(entries.filter((e) => e.session_id !== sessionId).map((e) => e.slug));
  const base = slugify(title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function parseSiteEntries(json: string | null): SiteEntry[] {
  if (!json) return [];
  const raw = JSON.parse(json) as { entries?: unknown };
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  return list.filter((e): e is SiteEntry =>
    !!e && typeof e.slug === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(e.slug) &&
    typeof e.session_id === "string" && typeof e.title === "string" && typeof e.date === "string")
    .map((e) => ({ ...e, mode: e.mode === "rapid" ? "rapid" : "full" }));
}

/** Insert or replace this session's entry (one entry per session); newest first. */
export function upsertEntry(entries: readonly SiteEntry[], entry: SiteEntry): SiteEntry[] {
  return [...entries.filter((e) => e.session_id !== entry.session_id && e.slug !== entry.slug), entry]
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

/** The site's front page: a plain list of every review, same house style as the review pages. */
export function renderIndex(entries: readonly SiteEntry[]): string {
  const rows = entries.map((e) =>
    `<li><a href="${esc(e.slug)}/">${esc(e.title || "Untitled")}</a> <span class="mono">· ${esc(e.date.slice(0, 10))} · ${e.mode === "rapid" ? "quick take" : "full review"}</span></li>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reviews</title><style>${PAGE_CSS}
ul.reviews{list-style:square;padding-left:1.4rem}ul.reviews li{margin:.35rem 0}</style></head>
<body>
<pre class="banner" aria-label="Reviews">${esc(asciiBanner("Reviews"))}</pre>
<p class="kicker mono">${entries.length} review${entries.length === 1 ? "" : "s"} · newest first</p>
${rows.length ? `<ul class="reviews">\n${rows.join("\n")}\n</ul>` : '<p class="mono">(nothing here yet)</p>'}
<div class="badges" aria-hidden="true"><span class="badge">hand<br>written</span><span class="badge b2">local<br>first</span><span class="badge b3">best viewed<br>any browser</span></div>
<footer>hand-assembled with Review App</footer>
</body></html>`;
}

/** Public URL of a review: `<site base>/<slug>/`. */
export function reviewUrl(siteBase: string, slug: string): string {
  return `${siteBase.trim().replace(/\/+$/, "")}/${slug}/`;
}

/** Normalize a user-entered site URL ("reviews.example.com" → "https://reviews.example.com"); "" if unusable. */
export function normalizeSiteBase(v: string): string {
  const t = v.trim().replace(/\/+$/, "");
  if (!t) return "";
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return u.hostname.includes(".") ? `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}` : "";
  } catch {
    return "";
  }
}

/** First sentence of a text (or the whole thing, trimmed to ~max chars at a word boundary). */
export function firstSentence(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?[.!?])(?=\s|$)/);
  let s = m ? m[1] : t;
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return s;
}

const OVERVIEW = ["overview", "rapid-overview"];

/** The comment's hook: the overview section's opening line, else the first overview point, else any prose. */
export function hookLine(review: ReviewFile, points: readonly Point[], mode: Mode): string {
  const order = mode === "rapid" ? [...OVERVIEW].reverse() : OVERVIEW;
  for (const b of order) {
    const prose = review.sections[b]?.prose ?? "";
    if (prose.trim()) return firstSentence(prose);
  }
  for (const b of order) {
    const p = pointsIn(points, b).find((x) => x.text.trim());
    if (p) return firstSentence(p.text);
  }
  const any = Object.values(review.sections).find((s) => s.prose.trim());
  return any ? firstSentence(any.prose) : "";
}

export interface CommentInput {
  hook: string;
  verdict: string;
  url: string;
}

/** Paste-ready Itch comment: hook + one-line verdict + link. Plain text (Itch comments take plain text/markdown). */
export function itchComment({ hook, verdict, url }: CommentInput): string {
  const v = firstSentence(verdict, 160);
  const lines = [hook.trim(), v ? `Verdict: ${v}` : "", url.trim() ? `Full review: ${url.trim()}` : "Full review: [link — publish first]"];
  return lines.filter(Boolean).join("\n\n");
}
