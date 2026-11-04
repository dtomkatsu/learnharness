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
import type { ItemId, LearnerEvent, ReviewMode } from "../core/learner/model.ts";

const DIR = path.join(PATHS.data, "learner");
const EVIDENCE = path.join(DIR, "evidence.jsonl");
const CARDS = path.join(DIR, "cards.json");

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

export const hasCardMode = (cards: Record<ItemId, Card>) => (id: ItemId, mode: ReviewMode): boolean => !!cards[id]?.[mode];

export const learnerPaths = { dir: DIR, evidence: EVIDENCE, cards: CARDS };
