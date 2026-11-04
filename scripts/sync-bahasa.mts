/**
 * Bahasa flashcards ⇄ the learner model (2026-11).
 *
 * The Learning-Bahasa-Indonesian app (github.com/dtomkatsu/Learning-Bahasa-Indonesian)
 * keeps its decks as vocab/*.tsv in the repo and each card's FSRS state in a
 * private gist (bahasa-progress.json, `bahasa:flashcards:fsrs:v1`, keyed by the
 * card's front). This script:
 *
 *   pull — writes data/learner/external/bahasa.json: every card (front, meaning,
 *          tags, example + translation, a volunteer recording from Lingua Libre
 *          when the app has one) with the app's schedule for it;
 *   push — for each card reviewed here (the learner model's Review, deck=bahasa)
 *          after the app last reviewed it, writes the new state back to the gist,
 *          so the app sees it too (it keeps whichever copy was reviewed later).
 *          The gist as it was is saved to ~/backups/bahasa-gist/ first.
 *
 * Uses the `gh` CLI's login (gist scope) for the gist. Run from the repo root:
 *   npx tsx scripts/sync-bahasa.mts [--pull-only] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "dtomkatsu/Learning-Bahasa-Indonesian";
const PAGES = "https://dtomkatsu.github.io/Learning-Bahasa-Indonesian/";
const GIST_FILE = "bahasa-progress.json";
const FSRS_KEY = "bahasa:flashcards:fsrs:v1";
const CUSTOM_KEY = "bahasa:flashcards:custom:v1";
const REMOVED_KEY = "bahasa:flashcards:removed:v1";
const args = new Set(process.argv.slice(2));

const { stores } = await import("../src/server/stores.ts");
const { learnerState } = await import("../src/server/learner.ts");
const { writeExternalDeck } = await import("../src/store/learner.ts");
const { termItem } = await import("../src/core/learner/model.ts");

const gh = (...a: string[]) => execFileSync("gh", a, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
const ghJson = (p: string) => JSON.parse(gh("api", p));
const raw = (p: string) => gh("api", `repos/${REPO}/contents/${p}`, "-H", "Accept: application/vnd.github.raw");

// ── the decks ──
const files = (ghJson(`repos/${REPO}/contents/vocab`) as { name: string }[]).map((f) => f.name).filter((n) => n.endsWith(".tsv")).sort();
let ll: Record<string, { file: string }> = {};
try { ll = JSON.parse(raw("audio/ll/index.json")); } catch { console.warn("no Lingua Libre index"); }

type Row = { term: string; gloss: string; tags: string[]; example?: string; exampleEn?: string };
const rows = new Map<string, Row>();
for (const f of files) {
	for (const line of raw("vocab/" + f).split("\n")) {
		const [front, back, tags, ex, exEn] = line.split("\t");
		if (!front?.trim() || !back?.trim() || rows.has(front.trim())) continue; // the app's rule: first file alphabetically wins
		rows.set(front.trim(), { term: front.trim(), gloss: back.trim(), tags: (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean), ...(ex?.trim() ? { example: ex.trim(), ...(exEn?.trim() ? { exampleEn: exEn.trim() } : {}) } : {}) });
	}
}

// ── the progress gist ──
const gists = JSON.parse(gh("api", "gists", "--paginate", "--slurp")).flat() as { id: string; files: Record<string, unknown> }[];
const gistId = gists.find((g) => g.files?.[GIST_FILE])?.id;
if (!gistId) throw new Error(`no gist holds ${GIST_FILE}`);
const gist = ghJson(`gists/${gistId}`);
const gf = gist.files[GIST_FILE];
const progressText: string = gf.truncated ? execFileSync("curl", ["-sfL", gf.raw_url], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }) : gf.content;
const progress = JSON.parse(progressText) as { data: Record<string, any>; exportedAt?: number; exportedAtISO?: string };
const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) ?? {};
const fsrs = parse(progress.data[FSRS_KEY]) as Record<string, { difficulty: number; stability: number; due: number; lastReview: number; reps: number; rev?: number }>;
const custom = parse(progress.data[CUSTOM_KEY]) as Record<string, { front?: string; back?: string; tags?: string[]; tag?: string }>;
const removed = new Set(Object.keys(parse(progress.data[REMOVED_KEY]) as Record<string, unknown>));

for (const [front, c] of Object.entries(custom)) {
	const term = (c.front ?? front).trim();
	if (!term || !c.back) continue;
	rows.set(term, { ...(rows.get(term) ?? { term, tags: [] }), term, gloss: c.back, tags: c.tags ?? (c.tag ? [c.tag] : rows.get(term)?.tags ?? []) });
}
for (const r of removed) rows.delete(r);

const items = [...rows.values()].map((r) => {
	const s = fsrs[r.term];
	const clip = ll[r.term] ?? ll[r.term.toLowerCase()];
	return {
		term: r.term, gloss: r.gloss, deck: "bahasa", lang: "id", tags: r.tags,
		...(r.example ? { example: r.example, ...(r.exampleEn ? { exampleEn: r.exampleEn } : {}) } : {}),
		...(clip?.file ? { audio: PAGES + "audio/ll/" + clip.file } : {}),
		schedule: s && Number.isFinite(s.stability) && s.lastReview ? { stability: s.stability, difficulty: s.difficulty, due: s.due, lastReview: s.lastReview, reps: s.reps ?? 0 } : null,
	};
});
if (!args.has("--dry-run")) writeExternalDeck({ deck: "bahasa", lang: "id", syncedAt: new Date().toISOString(), items });
console.log(`pull: ${items.length} cards from ${files.length} decks, ${items.filter((i) => i.schedule).length} studied in the app, ${items.filter((i) => i.audio).length} with a recording`);

// ── push what was reviewed here ──
if (args.has("--pull-only")) process.exit(0);
const state = learnerState(stores);
const changed: Record<string, unknown> = {};
for (const r of rows.values()) {
	const it = state.items.get(state.aliases.get(termItem(r.term)) ?? termItem(r.term));
	if (!it || it.deck !== "bahasa") continue;
	const mine = it.ratings.filter((x) => (x.source === "review" || x.source === "known") && !x.produce);
	const last = mine.length ? Date.parse(mine[mine.length - 1]!.at) : 0;
	const theirs = fsrs[r.term]?.lastReview ?? 0;
	if (!last || last <= theirs || it.schedule.state === 0) continue;
	changed[r.term] = { difficulty: it.schedule.difficulty, stability: it.schedule.stability, due: it.schedule.due, lastReview: last, reps: it.schedule.reps };
}
const n = Object.keys(changed).length;
if (!n) { console.log("push: nothing reviewed here since the app last saw it"); process.exit(0); }
if (args.has("--dry-run")) { console.log(`push (dry run): would write ${n} cards`, Object.keys(changed).slice(0, 10)); process.exit(0); }
const dir = path.join(os.homedir(), "backups", "bahasa-gist");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), progressText);
const nextFsrs = { ...fsrs, ...changed };
const wasString = typeof progress.data[FSRS_KEY] === "string";
progress.data[FSRS_KEY] = wasString ? JSON.stringify(nextFsrs) : nextFsrs;
progress.exportedAt = Date.now(); progress.exportedAtISO = new Date().toISOString();
const body = path.join(os.tmpdir(), `bahasa-gist-${process.pid}.json`);
fs.writeFileSync(body, JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(progress) } } }));
gh("api", "-X", "PATCH", `gists/${gistId}`, "--input", body);
fs.unlinkSync(body);
console.log(`push: wrote ${n} cards back to the app's progress`);
