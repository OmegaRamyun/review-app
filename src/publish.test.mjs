// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});
const P = await import("./publish.ts");
const R = await import("./review.ts");
const { emptyPoints, newPoint } = await import("./points.ts");

test("slugify + unique slugs per session, saved slug sticks", () => {
  assert.equal(P.slugify("Hookshot: The Grapplening!"), "hookshot-the-grapplening");
  assert.equal(P.slugify("Pokémon-ish  Café"), "pokemon-ish-cafe");
  assert.equal(P.slugify("???"), "review");
  assert.ok(P.slugify("a ".repeat(60)).length <= 48);
  const entries = [{ slug: "hookshot", session_id: "s1", title: "Hookshot", date: "2026-11-08", mode: "full" }];
  assert.equal(P.chooseSlug("", "Hookshot", "s1", entries), "hookshot");
  assert.equal(P.chooseSlug("", "Hookshot", "s2", entries), "hookshot-2");
  assert.equal(P.chooseSlug("kept-slug", "Renamed", "s1", entries), "kept-slug");
});

test("site entries: parse tolerates damage, upsert replaces per session", () => {
  assert.deepEqual(P.parseSiteEntries(null), []);
  const parsed = P.parseSiteEntries(JSON.stringify({ entries: [
    { slug: "ok", session_id: "s1", title: "Ok", date: "2026-11-01", mode: "rapid" },
    { slug: "../evil", session_id: "s2", title: "x", date: "d" },
    null,
  ] }));
  assert.deepEqual(parsed.map((e) => e.slug), ["ok"]);
  let list = P.upsertEntry(parsed, { slug: "b", session_id: "s3", title: "B", date: "2026-11-08", mode: "full" });
  list = P.upsertEntry(list, { slug: "ok", session_id: "s1", title: "Ok 2", date: "2026-11-01", mode: "rapid" });
  assert.deepEqual(list.map((e) => [e.slug, e.title]), [["b", "B"], ["ok", "Ok 2"]]);
});

test("index page escapes titles and links relative slugs", () => {
  const html = P.renderIndex([{ slug: "a-b", session_id: "s", title: "<A> & B", date: "2026-11-08T00:00Z", mode: "rapid" }]);
  assert.match(html, /<a href="a-b\/">&lt;A&gt; &amp; B<\/a>/);
  assert.match(html, /quick take/);
  assert.doesNotMatch(html, /<script/i);
});

test("site base + review URL", () => {
  assert.equal(P.normalizeSiteBase("reviews.pages.dev/"), "https://reviews.pages.dev");
  assert.equal(P.normalizeSiteBase(" https://x.example.com/sub/ "), "https://x.example.com/sub");
  assert.equal(P.normalizeSiteBase("nope"), "");
  assert.equal(P.reviewUrl("https://reviews.pages.dev/", "hookshot"), "https://reviews.pages.dev/hookshot/");
});

test("itch comment: hook + one-line verdict + link, placeholder before publish", () => {
  const pts = emptyPoints();
  newPoint(pts, { bucket: "overview", quote: "", time: 3, text: "A grapple platformer. Lots of dash.", screenshot: null, shot_time: null });
  const review = R.emptyReview();
  review.verdict = "Wishlist it. The grapple alone is worth the hour.";
  // No overview prose yet → first overview point's first sentence.
  assert.equal(P.hookLine(review, pts.points, "full"), "A grapple platformer.");
  review.sections.overview = { prose: "Hookshot is a grapple platformer that never stops moving! More text.", draft: false };
  const hook = P.hookLine(review, pts.points, "full");
  assert.equal(hook, "Hookshot is a grapple platformer that never stops moving!");
  const c = P.itchComment({ hook, verdict: review.verdict, url: "https://r.pages.dev/hookshot/" });
  assert.equal(c, "Hookshot is a grapple platformer that never stops moving!\n\nVerdict: Wishlist it.\n\nFull review: https://r.pages.dev/hookshot/");
  assert.match(P.itchComment({ hook, verdict: "", url: "" }), /publish first/);
  assert.ok(P.firstSentence("word ".repeat(100), 50).length <= 51);
});

test("review.json keeps publish fields, rejects junk slug/url", () => {
  const r = R.emptyReview();
  r.slug = "hookshot"; r.url = "https://r.pages.dev/hookshot/"; r.itch_comment = "hi"; r.publish_state = "published";
  assert.deepEqual(R.parseReview(JSON.stringify(r)), r);
  const bad = R.parseReview('{"slug":"../x","url":"javascript:alert(1)"}');
  assert.equal(bad.slug, "");
  assert.equal(bad.url, "");
});
