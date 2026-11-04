/**
 * The learner store (2026-11): data/learner/evidence.jsonl — the append-only
 * evidence log the learner model replays (core/learner/model.ts) — and
 * data/learner/cards.json, the review cards generated per item. The log is
 * the only source of truth; nothing derived is stored. A line that does not
 * parse is skipped (and reported once), never fatal.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../config.ts";
import type { ExternalItem, ItemId, LearnerEvent, ReviewMode } from "../core/learner/model.ts";

const DIR = path.join(PATHS.data, "learner");
const EVIDENCE = path.join(DIR, "evidence.jsonl");
const CARDS = path.join(DIR, "cards.json");
/** Other apps' decks, one snapshot file each (written by their sync, e.g. scripts/sync-bahasa.mts). */
const EXTERNAL = path.join(DIR, "external");
/** Which terms the glossary tidy has already looked at. */
const TIDY = path.join(DIR, "tidy.json");

export interface CardFace { prompt: string; answer: string }
export interface Card {
	itemId: ItemId;
	/** The meaning the cards were written from (fills a term with no taught gloss). */
	meaning: string;
	recall: CardFace;
	produce?: CardFace;
	why?: CardFace;
	cloze?: CardFace;
	discriminate?: CardFace & { with: string };
	/** Re-derivation shown after a second lapse. */
	elaboration?: string;
	/** Memory hook shown after a third. */
	hook?: string;
	/** For a language word: a sentence using it and its translation (cloze and the back of a card). */
	example?: { sentence: string; translation: string };
	/** Small fresh problems that USE the idea (compute, predict, decide) — asked in turn; [] when it cannot be applied. */
	apply?: CardFace[];
	/** Lapses when generated — regenerate elaboration/hook as they grow. */
	lapsesAt: number;
	generatedAt: string;
}

export const newEventId = () => "ev_" + Date.now().toString(36) + "_" + crypto.randomUUID().slice(0, 8);

let warned = false;
export function readEvidence(): LearnerEvent[] {
	let text = "";
	try { text = fs.readFileSync(EVIDENCE, "utf-8"); } catch { return []; }
	const out: LearnerEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line) as LearnerEvent); }
		catch { if (!warned) { warned = true; console.warn(`[learner] skipped an unreadable evidence line in ${EVIDENCE}`); } }
	}
	return out;
}

/** Appends events (ids and times filled in when absent). Returns them as written. */
export function appendEvidence(events: readonly (Omit<LearnerEvent, "id" | "at"> & { id?: string; at?: string })[]): LearnerEvent[] {
	if (!events.length) return [];
	const now = new Date().toISOString();
	const full = events.map((e) => ({ ...e, id: e.id ?? newEventId(), at: e.at ?? now }) as LearnerEvent);
	fs.mkdirSync(DIR, { recursive: true });
	fs.appendFileSync(EVIDENCE, full.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return full;
}

export function readCards(): Record<ItemId, Card> {
	try { return JSON.parse(fs.readFileSync(CARDS, "utf-8")) as Record<ItemId, Card>; } catch { return {}; }
}

export function writeCards(cards: Record<ItemId, Card>): void {
	fs.mkdirSync(DIR, { recursive: true });
	const tmp = CARDS + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(cards, null, "\t"), "utf-8");
	fs.renameSync(tmp, CARDS);
}

export const hasCardMode = (cards: Record<ItemId, Card>) => (id: ItemId, mode: ReviewMode): boolean => {
	const f = (cards[id] as unknown as Record<string, unknown> | undefined)?.[mode];
	return Array.isArray(f) ? f.length > 0 : !!f;
};

export interface ExternalDeck { deck: string; lang?: string; syncedAt: string; items: ExternalItem[] }

/** Every external deck's items (a snapshot file that does not parse is skipped). */
export function readExternal(): ExternalItem[] {
	let names: string[] = [];
	try { names = fs.readdirSync(EXTERNAL).filter((f) => f.endsWith(".json")); } catch { return []; }
	const out: ExternalItem[] = [];
	for (const f of names) {
		try { const d = JSON.parse(fs.readFileSync(path.join(EXTERNAL, f), "utf-8")) as ExternalDeck; if (Array.isArray(d.items)) out.push(...d.items); }
		catch { console.warn(`[learner] skipped an unreadable deck snapshot ${f}`); }
	}
	return out;
}

export function readExternalDeck(deck: string): ExternalDeck | null {
	try { return JSON.parse(fs.readFileSync(path.join(EXTERNAL, deck + ".json"), "utf-8")) as ExternalDeck; } catch { return null; }
}

export function writeExternalDeck(d: ExternalDeck): void {
	fs.mkdirSync(EXTERNAL, { recursive: true });
	const f = path.join(EXTERNAL, d.deck + ".json"), tmp = f + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(d), "utf-8");
	fs.renameSync(tmp, f);
}

export function readTidied(): Set<ItemId> {
	try { return new Set(JSON.parse(fs.readFileSync(TIDY, "utf-8")).items as ItemId[]); } catch { return new Set(); }
}

export function writeTidied(ids: Set<ItemId>): void {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(TIDY, JSON.stringify({ items: [...ids] }), "utf-8");
}

export const learnerPaths = { dir: DIR, evidence: EVIDENCE, cards: CARDS, external: EXTERNAL };
