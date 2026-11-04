/**
 * Side threads in a session list (2026-11): a session with a `parent` is a
 * question asked from another session, and is listed indented right under it
 * instead of as a subject of its own. Pure: the sidebar and any other list
 * (the e-ink reader) order their rows with it.
 */
import type { ChatParent } from "./contracts.ts";

export interface NestedRow<T> {
	chat: T;
	/** 0 = a session in its own right; 1 = a thread under it; 2 = a thread under a thread… */
	depth: number;
}

/** The list in the order given, each session followed by its threads (in the
 *  same relative order), recursively. A thread whose parent is not in the
 *  list (deleted, or filtered out) stands at the top level; a cycle cannot
 *  hide a session — whatever is left unplaced goes at the end, top level. */
export function nestChats<T extends { id: string; parent?: ChatParent }>(chats: readonly T[]): NestedRow<T>[] {
	const ids = new Set(chats.map((c) => c.id));
	const kids = new Map<string, T[]>();
	const roots: T[] = [];
	for (const c of chats) {
		const p = c.parent?.id;
		if (p && p !== c.id && ids.has(p)) {
			const k = kids.get(p);
			if (k) k.push(c);
			else kids.set(p, [c]);
		} else roots.push(c);
	}
	const out: NestedRow<T>[] = [];
	const placed = new Set<string>();
	const walk = (c: T, depth: number) => {
		if (placed.has(c.id)) return;
		placed.add(c.id);
		out.push({ chat: c, depth });
		for (const k of kids.get(c.id) ?? []) walk(k, depth + 1);
	};
	for (const r of roots) walk(r, 0);
	for (const c of chats) walk(c, 0);
	return out;
}
