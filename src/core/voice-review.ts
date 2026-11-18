/**
 * Hands-free review (2026-11): the review queue read aloud and answered by
 * voice, for a phone on the table or in a car mount. The page
 * (components/voice-review.tsx) owns the mic, the speech and the loop;
 * this module is the pure part: what a spoken reply means, what a card
 * and a verdict sound like, and where a missed card comes back.
 */

export type VoiceCommand =
	| "repeat" | "skip" | "dontKnow" | "pause" | "resume" | "stop"
	| "lastRight" | "lastWrong"
	| "yes" | "partly" | "no";

/** A stretch of speech, in a language when it is not the page's own (a vocabulary word). */
export interface SpeechSegment { text: string; lang?: string }

/** Lowercase, no punctuation or apostrophes, fillers off both ends: what a recognizer's "Um, I don't know." compares as. */
export function normalizeUtterance(text: string): string {
	let s = text.toLowerCase().replace(/[’'`]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
	const FILLER = /^(um+|uh+|er+|hmm+|ok|okay|so|well|please|oh)\s+|\s+(please|then|now)$/;
	for (let prev = ""; prev !== s; ) { prev = s; s = s.replace(FILLER, "").trim(); }
	return s;
}

const COMMANDS: [VoiceCommand, string[]][] = [
	["repeat", ["repeat", "repeat that", "repeat the question", "repeat it", "say that again", "say it again", "say again", "again", "come again", "pardon", "what was the question", "one more time"]],
	["skip", ["skip", "skip it", "skip this", "skip this one", "next", "next one", "next card", "next question"]],
	["dontKnow", ["i dont know", "dont know", "i do not know", "no idea", "i have no idea", "pass", "i pass", "not sure", "im not sure", "i give up", "give up", "tell me", "just tell me", "show me", "whats the answer", "what is the answer", "i forget", "i forgot", "i cant remember", "i dont remember"]],
	["pause", ["pause", "hold on", "wait", "hang on", "one second", "one sec", "give me a second", "give me a minute"]],
	["resume", ["resume", "continue", "go on", "keep going", "go", "go ahead", "im back", "ready", "im ready", "lets go", "start", "more", "keep it going"]],
	["stop", ["stop", "end", "quit", "done", "im done", "thats enough", "enough", "end session", "stop session", "finish", "were done", "thats it for now"]],
	["lastRight", ["last one was right", "the last one was right", "i was right", "that was right", "i got that right", "i got it right", "mark it right", "mark that right", "that should be right", "actually i was right"]],
	["lastWrong", ["last one was wrong", "the last one was wrong", "i was wrong", "that was wrong", "mark it wrong", "mark that wrong", "that should be wrong", "i got that wrong"]],
];
const SELF_GRADE: [VoiceCommand, string[]][] = [
	["yes", ["yes", "yeah", "yep", "yup", "got it", "i got it", "correct", "right", "i was right", "yes i did", "i did"]],
	["partly", ["partly", "partially", "sort of", "kind of", "sorta", "kinda", "half", "mostly", "some of it", "a bit"]],
	["no", ["no", "nope", "nah", "missed it", "i missed it", "wrong", "i was wrong", "no i didnt", "i didnt", "not really"]],
];

/**
 * What a reply means when it is a command — the WHOLE reply, so an answer
 * that merely contains "next" or "stop" is graded as an answer. `selfGrade`:
 * the page just asked "did you get it?", so yes/partly/no are heard first.
 */
export function voiceCommand(text: string, opts: { selfGrade?: boolean } = {}): VoiceCommand | null {
	const s = normalizeUtterance(text);
	if (!s) return null;
	for (const [cmd, says] of opts.selfGrade ? [...SELF_GRADE, ...COMMANDS] : COMMANDS) if (says.includes(s)) return cmd;
	return null;
}

const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega"];
const TEX_WORDS: Record<string, string> = {
	cdot: " times ", times: " times ", div: " divided by ", pm: " plus or minus ", le: " is at most ", leq: " is at most ", ge: " is at least ", geq: " is at least ",
	ne: " is not ", neq: " is not ", approx: " is about ", to: " to ", rightarrow: " gives ", Rightarrow: " implies ", implies: " implies ", infty: " infinity ",
	sum: " the sum of ", prod: " the product of ", int: " the integral of ", partial: " partial ", nabla: " del ", in: " in ", ldots: " and so on ", dots: " and so on ", cdots: " and so on ",
	log: " log ", ln: " natural log of ", sin: " sine ", cos: " cosine ", tan: " tangent ", lim: " the limit ", max: " max ", min: " min ",
};

/** TeX said in words, roughly: enough that "\frac{a}{b}^2" comes out as "a over b squared", not "backslash frac". */
export function texToSpeech(tex: string): string {
	let s = tex.replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, "").replace(/\\[,;:! ]/g, " ");
	s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|mathcal|mathbb)\s*\{([^{}]*)\}/g, " $1 ");
	for (let prev = ""; prev !== s; ) {
		prev = s;
		s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 ")
			.replace(/\\sqrt\s*\{([^{}]*)\}/g, " the square root of $1 ")
			.replace(/\^\s*\{\s*2\s*\}|\^2(?!\d)/g, " squared ").replace(/\^\s*\{\s*3\s*\}|\^3(?!\d)/g, " cubed ")
			.replace(/\^\s*\{([^{}]*)\}/g, " to the $1 ").replace(/_\s*\{([^{}]*)\}/g, " sub $1 ");
	}
	s = s.replace(/\^\s*(\w)/g, " to the $1 ").replace(/_\s*(\w)/g, " sub $1 ");
	s = s.replace(/\\([A-Za-z]+)/g, (m, w: string) => TEX_WORDS[w] ?? (GREEK.includes(w.toLowerCase()) ? ` ${w.toLowerCase()} ` : " "));
	s = s.replace(/=/g, " equals ").replace(/\+/g, " plus ").replace(/-/g, " minus ").replace(/</g, " is less than ").replace(/>/g, " is greater than ");
	return s.replace(/[{}\\&]/g, " ").replace(/\s+/g, " ").trim();
}

/** Markdown and TeX as a voice would read them: no markup, maths in words, code named rather than spelled out. */
export function speakable(md: string): string {
	let s = md.replace(/```[\s\S]*?```/g, " (a code block — see the screen) ");
	s = s.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g, (_m, a?: string, b?: string, c?: string, d?: string) => ` ${texToSpeech(a ?? b ?? c ?? d ?? "")} `);
	s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[\^?\d+\]/g, "");
	s = s.replace(/`([^`]*)`/g, "$1").replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2");
	s = s.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "").replace(/^\s*\|?[-:| ]+\|?\s*$/gm, "").replace(/\s*\|\s*/g, ", ");
	s = s.replace(/<[^>]+>/g, " ").replace(/—|–/g, ", ");
	// Lines end in a stop unless they have one, so a list is read as a list and not one breathless sentence.
	return s.split(/\n+/).map((l) => l.trim().replace(/^,\s*|,\s*$/g, "")).filter(Boolean).map((l) => (/[.!?:;,]$/.test(l) ? l : l + ".")).join(" ").replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}

/** Speech in pieces of at most ~`max` characters at sentence ends: some engines cut an utterance off after 15 s, and Stop takes effect between pieces. */
export function speechChunks(text: string, max = 220): string[] {
	const out: string[] = [];
	for (const sentence of text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) {
		const t = sentence.trim(); if (!t) continue;
		const last = out.length ? out[out.length - 1]! : "";
		if (last && last.length + t.length + 1 <= max) out[out.length - 1] = last + " " + t;
		else if (t.length <= max) out.push(t);
		else for (const part of t.match(new RegExp(`.{1,${max}}(?:\\s|$)`, "g")) ?? [t]) out.push(part.trim());
	}
	return out;
}

/** The fields of a review-queue entry (GET /api/learner/review) the voice reads. */
export interface VoiceCard {
	itemId: string;
	mode: string;
	label: string;
	prompt: string;
	answer: string;
	speak?: string;
	lang?: string;
	shape?: string;
	looksFor?: string[];
	retry?: boolean;
	retries?: number;
}

/** What is said to ask a card. A listening card says its word in its own language, then asks. */
export function promptSpeech(card: VoiceCard): SpeechSegment[] {
	const out: SpeechSegment[] = [];
	if (card.retry) out.push({ text: "Again, the one you missed." });
	if (card.mode === "listen" && card.speak) {
		out.push({ text: card.speak, ...(card.lang ? { lang: card.lang } : {}) }, { text: "What does it mean?" });
		return out;
	}
	out.push({ text: speakable(card.prompt) });
	const points = card.looksFor?.length ?? 0;
	const cue = [card.shape, points > 1 ? `${points} points` : ""].filter(Boolean).join(", ");
	if (cue) out.push({ text: `${cue}.` });
	return out;
}

/** The grading answer from POST /api/learner/review the voice reads. */
export interface VoiceVerdict {
	rating: number;
	reason?: string;
	answer?: string;
	belief?: string;
	looksFor?: string[];
	hit?: number[];
}

const RATE_SAID: Record<number, string> = { 1: "Not quite.", 2: "Partly.", 3: "Right.", 4: "Spot on." };

/**
 * What is said after a graded answer. Right: the word, and the grader's
 * reason only when short (it is where "but you left out X" lives). Wrong
 * or partial: the reason, the points missed, and the answer — the
 * corrective feedback is the part of a miss that does the work.
 */
export function verdictSpeech(v: VoiceVerdict, card: VoiceCard): string {
	const parts = [RATE_SAID[v.rating] ?? ""];
	const reason = v.reason ? speakable(v.reason) : "";
	if (v.rating >= 3) {
		if (reason && reason.length <= 160 && v.rating === 3) parts.push(reason);
		return parts.join(" ").trim();
	}
	if (reason) parts.push(reason);
	if (v.belief) parts.push(`It sounded like you think ${speakable(v.belief).replace(/\.$/, "")}.`);
	const missed = (v.looksFor ?? []).filter((_t, i) => v.hit && !v.hit.includes(i));
	if (missed.length && missed.length < (v.looksFor ?? []).length) parts.push(`You missed: ${missed.map(speakable).map((t) => t.replace(/\.$/, "")).join("; ")}.`);
	else parts.push(`The answer: ${speakable(v.answer || card.answer)}`);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Successive relearning, as on the tablet's review: a card answered Again
 * comes back four cards later in the same session, at most three times.
 * Returns the queue with the copy in place (the queue is not changed).
 */
export const VOICE_RETRY_MAX = 3;
export function requeueMissed<T extends VoiceCard>(queue: readonly T[], i: number, rating: number): T[] {
	const c = queue[i];
	if (!c || rating !== 1 || (c.retries ?? 0) >= VOICE_RETRY_MAX) return [...queue];
	const at = Math.min(queue.length, i + 5);
	return [...queue.slice(0, at), { ...c, retries: (c.retries ?? 0) + 1, retry: true }, ...queue.slice(at)];
}
