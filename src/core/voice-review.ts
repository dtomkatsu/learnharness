/**
 * Hands-free review (2026-11): the review queue read aloud and answered by
 * voice, for a phone on the table or in a car mount. The page
 * (components/voice-review.tsx) owns the mic, the speech and the loop;
 * this module is the pure part: what a spoken reply means, what a card
 * and its answer sound like, and where a missed card comes back.
 */

export type VoiceCommand =
	| "repeat" | "skip" | "reveal" | "dontKnow" | "pause" | "resume" | "stop"
	| "again" | "hard" | "good" | "easy";

/** A stretch of speech, in a language when it is not the page's own (a vocabulary word). */
export interface SpeechSegment { text: string; lang?: string }

/** Lowercase, no punctuation or apostrophes, fillers off both ends: what a recognizer's "Um, I don't know." compares as. */
export function normalizeUtterance(text: string): string {
	let s = text.toLowerCase().replace(/[’'`]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
	const FILLER = /^(um+|uh+|er+|hmm+|ok|okay|so|well|please|oh)\s+|\s+(please|then|now)$/;
	for (let prev = ""; prev !== s; ) { prev = s; s = s.replace(FILLER, "").trim(); }
	return s;
}

// "again" is the rating (the Again button), so repeating the card is said "repeat" / "say that again".
const COMMANDS: [VoiceCommand, string[]][] = [
	["repeat", ["repeat", "repeat that", "repeat the question", "repeat it", "say that again", "say it again", "come again", "pardon", "what was the question", "read it again"]],
	["skip", ["skip", "skip it", "skip this", "skip this one", "next", "next one", "next card", "next question"]],
	["reveal", ["answer", "the answer", "show", "show me", "show answer", "show the answer", "show me the answer", "reveal", "reveal it", "flip", "flip it", "tell me", "just tell me", "whats the answer", "what is the answer", "read the answer"]],
	["dontKnow", ["i dont know", "dont know", "i do not know", "no idea", "i have no idea", "pass", "i pass", "i give up", "give up", "i forget", "i forgot", "i cant remember", "i dont remember"]],
	["pause", ["pause", "hold on", "wait", "hang on", "one second", "one sec", "give me a second", "give me a minute"]],
	["resume", ["resume", "continue", "go on", "keep going", "go", "go ahead", "im back", "ready", "im ready", "lets go", "start", "more", "keep it going"]],
	["stop", ["stop", "end", "quit", "done", "im done", "thats enough", "enough", "end session", "stop session", "finish", "were done", "thats it for now"]],
	["again", ["again", "try again", "again please", "missed it", "i missed it", "missed", "wrong", "i got it wrong", "nope", "no"]],
	["hard", ["hard", "that was hard", "difficult", "tough", "barely", "sort of", "kind of", "kinda", "sorta", "partly", "struggled"]],
	["good", ["good", "got it", "i got it", "yes", "yeah", "yep", "correct", "right", "knew it", "i knew it", "fine", "pretty good"]],
	["easy", ["easy", "too easy", "super easy", "that was easy", "very easy", "trivial", "obviously", "of course", "piece of cake"]],
];

/** The rating each rating word gives, as the review buttons number them (1 Again … 4 Easy). */
export const VOICE_RATING: Partial<Record<VoiceCommand, 1 | 2 | 3 | 4>> = { again: 1, dontKnow: 1, hard: 2, good: 3, easy: 4 };

/** What a reply means when it is a command — the WHOLE reply, so an answer that merely contains "next" or "good" is not one. */
export function voiceCommand(text: string): VoiceCommand | null {
	const s = normalizeUtterance(text);
	if (!s) return null;
	for (const [cmd, says] of COMMANDS) if (says.includes(s)) return cmd;
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

/** What is said to give a card's answer. */
export function answerSpeech(card: VoiceCard): string {
	return `The answer: ${speakable(card.answer)}`;
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
