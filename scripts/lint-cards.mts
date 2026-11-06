/**
 * Lints the review cards for vague open prompts (2026-11): `npx tsx scripts/lint-cards.mts [--all] [--file cards.json]`.
 * Counts the sure cases (two asks in one, an unbounded opener) over the open prompts, how many carry `shape` and `looksFor`,
 * and which prompt version wrote them; lists the flagged prompts (`--all`: every one, else ten). A baseline before a change to
 * the card prompt and the same numbers after the cards are rewritten (they are, lazily, when next needed).
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import { lintPrompt, openPrompts } from "../src/core/learner/prompt-lint.ts";

const args = process.argv.slice(2);
const fi = args.indexOf("--file");
const file = fi >= 0 ? args[fi + 1]! : path.join(PATHS.data, "learner", "cards.json");
const cards = Object.values(JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>);
let total = 0, withShape = 0, withPoints = 0;
const flagged: { id: string; mode: string; prompt: string; flags: string[] }[] = [], versions: Record<string, number> = {};
for (const c of cards) {
	versions[String(c.promptVersion ?? 1)] = (versions[String(c.promptVersion ?? 1)] ?? 0) + 1;
	for (const m of ["recall", "why", "discriminate"]) { const f = c[m]; if (f?.prompt) { total++; if (f.shape) withShape++; if (f.looksFor?.length) withPoints++; } }
	for (const f of c.apply ?? []) { total++; if (f.shape) withShape++; if (f.looksFor?.length) withPoints++; }
	for (const { mode, prompt } of openPrompts(c)) { const flags = lintPrompt(prompt); if (flags.length) flagged.push({ id: c.itemId, mode, prompt, flags }); }
}
const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0) + "%";
console.log(`${cards.length} cards, ${total} open prompts (${file})`);
console.log(`flagged: ${flagged.length} (${pct(flagged.length)}) — two asks: ${flagged.filter((f) => f.flags.includes("two-asks")).length}, unbounded: ${flagged.filter((f) => f.flags.includes("unbounded")).length}`);
console.log(`with a shape: ${withShape} (${pct(withShape)}), with key points: ${withPoints} (${pct(withPoints)})`);
console.log(`written under prompt version: ${Object.entries(versions).map(([v, n]) => `v${v} × ${n}`).join(", ")}`);
for (const f of flagged.slice(0, args.includes("--all") ? flagged.length : 10)) console.log(`  [${f.flags.join(",")}] (${f.mode}) ${f.prompt.slice(0, 150)}`);
