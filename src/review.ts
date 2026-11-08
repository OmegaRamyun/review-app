// Pure Assemble logic: review model, AI-draft prompt + response parsing, and the
// styled page renderer. No DOM, no Tauri, so `node --test` can exercise it
// (see review.test.mjs). Persisted as `review.json` in the session folder.
import { bucketLabel, bucketsFor, FULL_BUCKETS, RAPID_BUCKETS, type Mode, type Point } from "./points";

export interface SectionText {
  prose: string;
  /** true = this prose came from the AI draft and the user has not signed it off yet. */
  draft: boolean;
}

export interface ReviewFile {
  version: 1;
  verdict: string;
  who_for: string;
  /** Full mode only; never rendered or sent in rapid mode. Free text ("7/10", "B+"). */
  score: string;
  sections: Record<string, SectionText>;
  publish_state: "draft" | "exported" | "published";
}

export function emptyReview(): ReviewFile {
  return { version: 1, verdict: "", who_for: "", score: "", sections: {}, publish_state: "draft" };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseReview(json: string | null): ReviewFile {
  if (!json) return emptyReview();
  const raw = JSON.parse(json) as Partial<ReviewFile>;
  const sections: Record<string, SectionText> = {};
  if (raw.sections && typeof raw.sections === "object") {
    for (const [k, v] of Object.entries(raw.sections)) {
      if (v && typeof v === "object") sections[k] = { prose: str(v.prose), draft: v.draft === true };
    }
  }
  const ps = raw.publish_state;
  return {
    version: 1, verdict: str(raw.verdict), who_for: str(raw.who_for), score: str(raw.score), sections,
    publish_state: ps === "exported" || ps === "published" ? ps : "draft",
  };
}

const ORDER = [...FULL_BUCKETS, ...RAPID_BUCKETS].map((b) => b.id);

/** Buckets that get a section: those with points, current mode's order first, then any other-mode buckets. */
export function sectionBuckets(mode: Mode, points: readonly Point[]): string[] {
  const used = new Set(points.map((p) => p.bucket));
  const mine = bucketsFor(mode).map((b) => b.id).filter((id) => used.has(id));
  const rest = [...used].filter((id) => !mine.includes(id))
    .sort((a, b) => (ORDER.indexOf(a) + 1 || 999) - (ORDER.indexOf(b) + 1 || 999));
  return [...mine, ...rest];
}

export function pointsIn(points: readonly Point[], bucket: string): Point[] {
  return points.filter((p) => p.bucket === bucket).sort((a, b) => a.time - b.time || a.order - b.order);
}

/** Section buckets whose prose is still an unsigned AI draft. */
export function unreviewedDrafts(review: ReviewFile, buckets: readonly string[]): string[] {
  return buckets.filter((b) => review.sections[b]?.draft && review.sections[b].prose.trim() !== "");
}

// ---------- AI draft ----------

export const DRAFT_SYSTEM = [
  "You help a game reviewer turn their own review notes into a first-draft review in the style of",
  "Hardcore Gaming 101 and classic GameFAQs reviews: plain, specific, first person, conversational,",
  "concrete about what the player does and sees. No marketing language, no hype, no filler.",
  "Use ONLY what the notes say. Never invent mechanics, story details, names, numbers or opinions",
  "the notes do not contain; if a section's notes are thin, write a short section. Do not give scores.",
  "Each section gets 1-3 short paragraphs (separate paragraphs with a blank line), written so the",
  "sections read as one review in order. Keep the reviewer's own wording where it is good.",
  'Reply with JSON only: {"sections": {"<bucket id>": "<prose>", ...}} using exactly the bucket ids given.',
].join(" ");

export interface DraftInput {
  title: string;
  mode: Mode;
  verdict: string;
  who_for: string;
  points: readonly Point[];
}

export function fmtStamp(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** The user prompt: settings + every section's points. Only the buckets listed may come back. */
export function draftPrompt(input: DraftInput, buckets: readonly string[]): string {
  const out = [
    `Game: ${input.title || "(untitled)"}`,
    `Review mode: ${input.mode === "rapid" ? "rapid (demo-day quick take: hook, one mechanic, feel, verdict — keep it short)" : "full review"}`,
  ];
  if (input.verdict.trim()) out.push(`Reviewer's verdict wording: ${input.verdict.trim()}`);
  if (input.who_for.trim()) out.push(`Who it's for: ${input.who_for.trim()}`);
  out.push("", "Sections (bucket id — label), each with the reviewer's notes:");
  for (const b of buckets) {
    out.push("", `## ${b} — ${bucketLabel(b)}`);
    for (const p of pointsIn(input.points, b)) {
      const note = p.text.trim() || "(no note — use the quote)";
      out.push(`- [${fmtStamp(p.time)}] ${note}${p.quote.trim() ? ` (said while playing: "${p.quote.trim()}")` : ""}`);
    }
  }
  return out.join("\n");
}

/** Parse the model's JSON reply. Tolerates a ```json fence; keeps only requested buckets with non-empty strings. */
export function parseDraft(text: string, buckets: readonly string[]): Record<string, string> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    throw new Error("the model's reply was not JSON");
  }
  const sec = (v as { sections?: unknown })?.sections;
  if (!sec || typeof sec !== "object") throw new Error("the model's reply has no \"sections\" object");
  const out: Record<string, string> = {};
  for (const b of buckets) {
    const s = (sec as Record<string, unknown>)[b];
    if (typeof s === "string" && s.trim()) out[b] = s.trim();
  }
  return out;
}

/**
 * Merge a draft into the review. Sections holding the user's own prose are never
 * overwritten; empty sections and still-unsigned draft sections are (re)filled and marked draft.
 */
export function applyDraft(review: ReviewFile, drafted: Record<string, string>): { filled: string[]; kept: string[] } {
  const filled: string[] = [], kept: string[] = [];
  for (const [b, prose] of Object.entries(drafted)) {
    const cur = review.sections[b];
    if (cur && cur.prose.trim() && !cur.draft) {
      kept.push(b);
      continue;
    }
    review.sections[b] = { prose, draft: true };
    filled.push(b);
  }
  return { filled, kept };
}

// ---------- styled page ----------

export interface PageInput {
  title: string;
  mode: Mode;
  review: ReviewFile;
  points: readonly Point[];
  /** Screenshot file name → URL (blob URL in the preview, relative path on export). */
  shotUrl: (name: string) => string | null;
  /** ISO date shown in the footer. */
  date: string;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function paragraphs(prose: string): string {
  return prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n");
}

/** ASCII title banner, GameFAQs-header style. Long titles wrap inside the box. */
export function asciiBanner(title: string, width = 44): string {
  const inner = width - 4;
  const words = (title.trim() || "UNTITLED").toUpperCase().split(/\s+/);
  const rows: string[] = [];
  let row = "";
  for (let w of words) {
    while (w.length > inner) {
      if (row) rows.push(row), (row = "");
      rows.push(w.slice(0, inner));
      w = w.slice(inner);
    }
    if (!w) continue;
    if (row && row.length + 1 + w.length > inner) rows.push(row), (row = "");
    row = row ? `${row} ${w}` : w;
  }
  if (row) rows.push(row);
  const bar = `+${"=".repeat(width - 2)}+`;
  return [bar, ...rows.map((r) => `| ${r.padEnd(inner)} |`), bar].join("\n");
}

const two = (n: number) => String(n).padStart(2, "0");

// 8×8 two-tone checker as a data-URI tile, crisp-edged (pixel touch, no image files).
const TILE = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" shape-rendering="crispEdges">' +
  '<rect width="8" height="8" fill="#1d2b53"/><rect width="4" height="4" fill="#22325f"/>' +
  '<rect x="4" y="4" width="4" height="4" fill="#22325f"/><rect x="3" y="3" width="1" height="1" fill="#2c3f75"/></svg>',
);

const PAGE_CSS = `
html{background:#1d2b53 url("${TILE}") repeat;image-rendering:pixelated}
body{max-width:46rem;margin:1.5rem auto;padding:1.2rem 1.6rem;background:#fdf6e3;color:#1b1b1b;
 font:17px/1.6 Georgia,"Times New Roman",serif;border:3px double #1b1b1b;box-shadow:6px 6px 0 #000}
pre.banner{font:bold 14px/1.25 "Courier New",Courier,monospace;margin:0 0 .4rem;white-space:pre;overflow-x:auto;color:#7e2553}
.mono,h2,nav,.badge,.note time,.verdict dt,footer{font-family:"Courier New",Courier,monospace}
.kicker{margin:.2rem 0 1rem;font-size:.95rem}
nav{border:1px dashed #1b1b1b;padding:.5rem .9rem;margin:1rem 0;background:#fff}
nav b{display:block}nav ol{margin:.3rem 0 0;padding-left:0;list-style:none}nav a{color:#0b5fa5}
h2{font-size:1.05rem;margin:2rem 0 .3rem;padding:.25rem .5rem;background:#1b1b1b;color:#ffec27;letter-spacing:.05em;text-transform:uppercase}
h2 .num{color:#ff77a8}
.rule{font:13px/1 "Courier New",monospace;color:#888;overflow:hidden;white-space:nowrap;margin:0 0 .6rem}
a{color:#008751}
.notes{margin:.8rem 0;padding:.4rem .8rem;border-left:4px solid #83769c;background:#f3ead2;font-size:.92rem}
.notes b{font-family:"Courier New",monospace;font-size:.8rem;letter-spacing:.08em}
.note{margin:.35rem 0}.note time{color:#7e2553;font-size:.85rem}.note q{color:#555;font-style:italic}
figure{margin:.5rem 0}figure img{max-width:100%;border:2px solid #1b1b1b;image-rendering:auto}
figcaption{font:12px "Courier New",monospace;color:#555}
.verdict{margin:2rem 0 1rem;border:3px solid #1b1b1b;background:#fff;padding:.6rem 1rem}
.verdict h2{margin-top:0}.verdict dl{margin:0}.verdict dt{font-weight:bold;font-size:.85rem;text-transform:uppercase;margin-top:.4rem}.verdict dd{margin:0 0 .2rem}
.score{font:bold 2rem "Courier New",monospace;color:#7e2553}
.draft{outline:3px dashed #ff004d;outline-offset:4px;position:relative}
.draft::before{content:"AI DRAFT - NOT REVIEWED";display:table;font:bold 11px "Courier New",monospace;background:#ff004d;color:#fff;padding:1px 6px;margin-bottom:.3rem}
.badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:1.4rem}
.badge{display:inline-flex;align-items:center;justify-content:center;width:88px;height:31px;box-sizing:border-box;border:2px outset #c2c3c7;
 background:#000;color:#00e436;font-size:9px;line-height:1.05;text-align:center;text-transform:uppercase;font-weight:bold}
.badge.b2{background:#7e2553;color:#ffec27}.badge.b3{background:#c2c3c7;color:#1d2b53}
footer{margin-top:.8rem;font-size:.75rem;color:#555;border-top:1px dashed #888;padding-top:.4rem}
`;

/** The whole styled review page as one self-contained HTML document (no scripts). */
export function renderPage(input: PageInput): string {
  const { review, mode } = input;
  const buckets = sectionBuckets(mode, input.points);
  const title = input.title.trim() || "Untitled";
  const showScore = mode === "full" && review.score.trim() !== "";
  const drafts = unreviewedDrafts(review, buckets);

  const toc = buckets.map((b, i) => `<li><a href="#s${two(i + 1)}">${two(i + 1)}. ${esc(bucketLabel(b))}</a></li>`);
  toc.push(`<li><a href="#verdict">${two(buckets.length + 1)}. Final word</a></li>`);

  const sections = buckets.map((b, i) => {
    const s = review.sections[b];
    const label = bucketLabel(b).replace(/ \(rapid\)$/, "");
    const notes = pointsIn(input.points, b).map((p) => {
      const url = p.screenshot ? input.shotUrl(p.screenshot) : null;
      const fig = url ? `<figure><img src="${esc(url)}" alt="${esc(label)} screenshot at ${fmtStamp(p.shot_time ?? p.time)}" loading="lazy"><figcaption>[${fmtStamp(p.shot_time ?? p.time)}]</figcaption></figure>` : "";
      const said = p.quote.trim() ? ` <q>${esc(p.quote.trim())}</q>` : "";
      return `<div class="note"><time>[${fmtStamp(p.time)}]</time> ${esc(p.text.trim())}${said}${fig}</div>`;
    }).join("\n");
    const prose = s?.prose.trim() ? `<div class="prose${s.draft ? " draft" : ""}">${paragraphs(s.prose)}</div>` : "";
    return `<section id="s${two(i + 1)}">
<h2><span class="num">[${two(i + 1)}]</span> ${esc(label)}</h2>
<div class="rule" aria-hidden="true">${"=-".repeat(40)}</div>
${prose}
<div class="notes"><b>FIELD NOTES</b>
${notes}
</div>
</section>`;
  }).join("\n");

  const verdictRows = [
    review.verdict.trim() ? `<dt>Verdict</dt><dd>${esc(review.verdict.trim())}</dd>` : "",
    review.who_for.trim() ? `<dt>Who it's for</dt><dd>${esc(review.who_for.trim())}</dd>` : "",
    showScore ? `<dt>Score</dt><dd class="score">${esc(review.score.trim())}</dd>` : "",
  ].join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — review</title><style>${PAGE_CSS}</style></head>
<body>
<pre class="banner" aria-label="${esc(title)}">${esc(asciiBanner(title))}</pre>
<p class="kicker mono">${mode === "rapid" ? "DEMO-DAY QUICK TAKE" : "FULL REVIEW"} · ${esc(input.date.slice(0, 10))}${review.who_for.trim() ? ` · for ${esc(review.who_for.trim())}` : ""}</p>
${drafts.length ? `<p class="draft">${drafts.length} section${drafts.length === 1 ? "" : "s"} below still hold${drafts.length === 1 ? "s" : ""} unreviewed AI draft text.</p>` : ""}
<nav><b>CONTENTS</b><ol>${toc.join("")}</ol></nav>
${sections || '<p class="mono">(No points pinned yet — pin some on the Scrub &amp; point screen.)</p>'}
<section id="verdict" class="verdict">
<h2><span class="num">[${two(buckets.length + 1)}]</span> Final word</h2>
${verdictRows ? `<dl>${verdictRows}</dl>` : '<p class="mono">(verdict not written yet)</p>'}
</section>
<div class="badges" aria-hidden="true"><span class="badge">hand<br>written</span><span class="badge b2">local<br>first</span><span class="badge b3">best viewed<br>any browser</span></div>
<footer>hand-assembled with Review App · ${esc(input.date.slice(0, 10))}</footer>
</body></html>`;
}
