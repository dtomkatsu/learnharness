"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EyeIcon, MicIcon, PauseIcon, PlayIcon, RotateCcwIcon, SkipForwardIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	VOICE_RATING, answerSpeech, deepgramListenUrl, promptSpeech, requeueMissed, speechChunks, voiceCommand,
	type SpeechSegment, type VoiceCard, type VoiceCommand,
} from "@/src/core";

/**
 * Hands-free review (2026-11): the review queue read aloud and rated
 * out loud, no button held. Tap Start once (phones only let a page speak
 * and record after a tap), then: the card is read → you answer, out loud
 * or in your head → "answer" (or anything that is not a command) reads
 * the card's answer → you rate it "again", "hard", "good" or "easy", the
 * same four grades as the review buttons (POST /api/learner/review with
 * the rating; nothing is graded by a model, owner 2026-11-18) → next.
 * "Repeat", "skip", "pause", "stop" work as whole replies; the buttons do
 * the same for when a hand is free.
 *
 * Half duplex on purpose: the mic is closed while the page speaks, so it
 * never hears its own voice, and on iOS an open mic would also drop the
 * speech to the earpiece.
 *
 * Two recognizers: Deepgram (the dictation key, /api/stt/token) when the
 * server has one, else the browser's own (Safari, Chrome). The screen
 * stays on (Wake Lock): a phone browser stops the mic when it locks.
 */

type Engine = "deepgram" | "browser";
type Phase = "idle" | "loading" | "speaking" | "listening" | "paused" | "done" | "error";

/** Nothing said for this long gives the turn back (the page asks once, then pauses). */
const QUIET_MS = 12000;
/** The longest a single answer may run. */
const MAX_MS = 120000;
/** How long a pause ends an answer, for the browser recognizer (Deepgram's is utterance_end_ms). */
const END_PAUSE_MS = 1800;
const RATE_KEY = "lh:voice-rate";

// ─── speaking ────────────────────────────────────────────────────────────────

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
	const base = lang.split("-")[0]!.toLowerCase();
	const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(base));
	return voices.find((v) => /premium|enhanced|natural|neural/i.test(v.name)) ?? voices.find((v) => v.default) ?? voices[0];
}

function sayOne(text: string, lang: string, rate: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const u = new SpeechSynthesisUtterance(text);
		u.lang = lang; u.rate = rate;
		const voice = pickVoice(lang); if (voice) u.voice = voice;
		let done = false;
		const finish = () => { if (done) return; done = true; clearTimeout(cap); signal.removeEventListener("abort", onAbort); resolve(); };
		const onAbort = () => { speechSynthesis.cancel(); finish(); };
		// An engine that never fires onend (it happens) must not hang the session.
		const cap = setTimeout(finish, 4000 + (text.length * 110) / rate);
		u.onend = finish; u.onerror = finish;
		signal.addEventListener("abort", onAbort);
		speechSynthesis.speak(u);
	});
}

async function say(segments: SpeechSegment[], rate: number, signal: AbortSignal): Promise<void> {
	for (const seg of segments)
		for (const chunk of speechChunks(seg.text)) {
			if (signal.aborted) return;
			await sayOne(chunk, seg.lang ?? "en-US", rate, signal);
		}
}

// ─── listening ───────────────────────────────────────────────────────────────

interface Recognizer {
	lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
	onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
	onerror: ((e: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void; stop(): void; abort(): void;
}
function recognizerCtor(): (new () => Recognizer) | undefined {
	if (typeof window === "undefined") return undefined;
	const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** One answer through the browser's recognizer: resolves with what was said ("" for nothing) once a pause ends it. */
function browserListen(signal: AbortSignal, onHeard: (t: string) => void): Promise<string> {
	const Ctor = recognizerCtor();
	if (!Ctor) return Promise.reject(new Error("This browser has no speech recognition."));
	return new Promise((resolve, reject) => {
		const r = new Ctor();
		r.lang = "en-US"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
		let text = "", ending = false, settled = false;
		const settle = (err?: Error) => {
			if (settled) return; settled = true;
			clearTimeout(quiet); clearTimeout(cap); signal.removeEventListener("abort", end);
			if (err) reject(err); else resolve(text.replace(/\s+/g, " ").trim());
		};
		// Stop, then wait for onend so the mic is released before the page speaks (a second at most).
		function end() { if (ending) return; ending = true; try { r.stop(); } catch { /* already stopped */ } setTimeout(() => settle(), 1000); }
		let quiet = setTimeout(end, QUIET_MS);
		const cap = setTimeout(end, MAX_MS);
		r.onresult = (e) => {
			text = Array.from(e.results, (res) => res[0]?.transcript ?? "").join(" ");
			onHeard(text.trim());
			clearTimeout(quiet); quiet = setTimeout(end, END_PAUSE_MS);
		};
		r.onerror = (e) => {
			if (e.error === "not-allowed" || e.error === "service-not-allowed") settle(new Error("The microphone or speech recognition was refused — allow it for this site, then Start again."));
			else if (e.error === "network") settle(new Error("Speech recognition needs the network and could not reach it."));
		};
		r.onend = () => settle();
		signal.addEventListener("abort", end);
		try { r.start(); } catch (err) { settle(err as Error); }
	});
}

let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;
/** Made in the Start tap: an AudioContext begins suspended unless a tap made it. */
function audioContext(): AudioContext {
	if (!sharedCtx) { try { sharedCtx = new AudioContext({ sampleRate: 16000 }); } catch { sharedCtx = new AudioContext(); } }
	return sharedCtx;
}

/** One answer through Deepgram (the dictation path's capture worklet): ends on Deepgram's UtteranceEnd after speech. */
async function deepgramListen(signal: AbortSignal, token: string, onHeard: (t: string) => void): Promise<string> {
	const ctx = audioContext();
	if (ctx.state === "suspended") await ctx.resume().catch(() => {});
	workletModule ??= ctx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => { workletModule = null; throw e; });
	await workletModule;
	const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
	return new Promise((resolve, reject) => {
		const finals: string[] = [], pending: ArrayBuffer[] = [];
		let interim = "", opened = false, settled = false;
		const url = deepgramListenUrl("en").replace("sample_rate=16000", `sample_rate=${ctx.sampleRate}`) + "&interim_results=true&utterance_end_ms=1500&vad_events=true";
		const ws = new WebSocket(url, ["bearer", token]);
		ws.binaryType = "arraybuffer";
		const source = ctx.createMediaStreamSource(stream);
		const node = new AudioWorkletNode(ctx, "pcm-capture");
		node.port.onmessage = (e: MessageEvent<{ type: string; buffer?: Int16Array }>) => {
			if (e.data.type !== "audio" || !e.data.buffer) return;
			const buf = e.data.buffer.buffer as ArrayBuffer;
			if (ws.readyState === WebSocket.OPEN) ws.send(buf);
			else if (ws.readyState === WebSocket.CONNECTING && pending.length < 256) pending.push(buf);   // speech before the handshake is kept, not dropped
		};
		source.connect(node);
		node.connect(ctx.destination);   // an unconnected worklet is never clocked
		const finish = (err?: Error) => {
			if (settled) return; settled = true;
			clearTimeout(quiet); clearTimeout(cap); signal.removeEventListener("abort", onAbort);
			node.port.onmessage = null;
			try { source.disconnect(); node.disconnect(); } catch { /* gone */ }
			stream.getTracks().forEach((t) => t.stop());
			if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* closing */ } setTimeout(() => ws.close(), 1500); }
			else if (ws.readyState === WebSocket.CONNECTING) ws.close();
			if (err) reject(err); else resolve([...finals, interim].join(" ").replace(/\s+/g, " ").trim());
		};
		const onAbort = () => finish();
		let quiet = setTimeout(() => finish(), QUIET_MS);
		const cap = setTimeout(() => finish(), MAX_MS);
		ws.onopen = () => { opened = true; for (const b of pending.splice(0)) ws.send(b); };
		ws.onmessage = (ev) => {
			let m: { type?: string; is_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
			try { m = JSON.parse(String(ev.data)); } catch { return; }
			if (m.type === "Results") {
				const t = m.channel?.alternatives?.[0]?.transcript ?? "";
				if (m.is_final) { if (t) finals.push(t); interim = ""; } else interim = t;
				if (t) {
					onHeard([...finals, interim].join(" ").trim());
					// Speech has started: UtteranceEnd ends it; this is only the net under a missing one.
					clearTimeout(quiet); quiet = setTimeout(() => finish(), 5000);
				}
			} else if (m.type === "UtteranceEnd" && (finals.length || interim)) finish();
		};
		ws.onclose = () => finish(opened ? undefined : new Error("Deepgram refused the connection"));
		signal.addEventListener("abort", onAbort);
	});
}

// ─── server ─────────────────────────────────────────────────────────────────

class ApiError extends Error { constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); } }
async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const r = await fetch(url, init);
	const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
	if (!r.ok) throw new ApiError(typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `HTTP ${r.status}`, r.status, body);
	return body as T;
}
const post = <T,>(url: string, body: unknown) => api<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── the page ───────────────────────────────────────────────────────────────

const PHASE_WORD: Record<Phase, string> = {
	idle: "Ready", loading: "Getting cards…", speaking: "Speaking", listening: "Listening", paused: "Paused", done: "Done", error: "Stopped",
};

export function VoiceReview({ deck, engine: forced }: { deck?: string; engine?: Engine }) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [card, setCard] = useState<VoiceCard | null>(null);
	const [pos, setPos] = useState({ i: 0, n: 0 });
	const [heard, setHeard] = useState("");
	const [said, setSaid] = useState("");
	const [reviewed, setReviewed] = useState(0);
	const [engine, setEngine] = useState<Engine | null>(null);
	const [notice, setNotice] = useState("");
	const [rate, setRate] = useState(1);
	const rateRef = useRef(1);
	const runRef = useRef(0);
	const stepRef = useRef<AbortController | null>(null);
	const pendingRef = useRef<VoiceCommand | null>(null);
	const waiterRef = useRef<((c: VoiceCommand) => void) | null>(null);
	const engineRef = useRef<Engine | null>(null);
	const tokenRef = useRef<{ token: string; at: number } | null>(null);
	const lockRef = useRef<WakeLockSentinel | null>(null);
	const phaseRef = useRef<Phase>("idle");
	const show = (p: Phase) => { phaseRef.current = p; setPhase(p); };

	useEffect(() => {
		try { const r = Number(localStorage.getItem(RATE_KEY)); if (r >= 0.6 && r <= 1.6) { setRate(r); rateRef.current = r; } } catch { /* no storage */ }
		// Voices load late in some browsers; asking once starts the load before the first card.
		speechSynthesis.getVoices();
	}, []);

	const holdScreen = useCallback(async () => {
		try { lockRef.current = await navigator.wakeLock?.request("screen"); } catch { /* not granted: the screen may sleep */ }
	}, []);
	useEffect(() => {
		// The lock is dropped whenever the page is hidden; take it again on return while a session runs.
		const onVis = () => { if (document.visibilityState === "visible" && runRef.current && !["idle", "done", "error"].includes(phaseRef.current)) void holdScreen(); };
		document.addEventListener("visibilitychange", onVis);
		return () => {
			document.removeEventListener("visibilitychange", onVis);
			runRef.current++; stepRef.current?.abort(); speechSynthesis.cancel();
			void lockRef.current?.release().catch(() => {});
		};
	}, [holdScreen]);
	/** A button: the same as saying it. Cuts off whatever is being said or heard. */
	const press = useCallback((cmd: VoiceCommand) => {
		pendingRef.current = cmd;
		stepRef.current?.abort();
		waiterRef.current?.(cmd);
	}, []);

	const loop = useCallback(async (run: number) => {
		const alive = () => runRef.current === run;
		const step = () => { const c = new AbortController(); stepRef.current = c; return c.signal; };
		const take = () => { const c = pendingRef.current; pendingRef.current = null; return c; };
		const speak = async (what: SpeechSegment[] | string) => {
			const segs = typeof what === "string" ? [{ text: what }] : what;
			show("speaking"); setSaid(segs.map((s) => s.text).join(" "));
			await say(segs, rateRef.current, step());
		};
		const token = async () => {
			if (tokenRef.current && Date.now() - tokenRef.current.at < 240000) return tokenRef.current.token;
			const j = await api<{ token: string }>("/api/stt/token");
			tokenRef.current = { token: j.token, at: Date.now() };
			return j.token;
		};
		const listenOnce = async (signal: AbortSignal) => {
			if (engineRef.current === "deepgram") {
				try { return await deepgramListen(signal, await token(), setHeard); }
				catch (e) {
					if (!recognizerCtor()) throw e;
					engineRef.current = "browser"; setEngine("browser");
					setNotice(`Deepgram failed (${(e as Error).message}); using the phone's own recognizer.`);
				}
			}
			return browserListen(signal, setHeard);
		};
		/** One reply. A pressed button wins over what the mic heard. */
		const hear = async (): Promise<{ cmd: VoiceCommand | null; text: string }> => {
			const early = take(); if (early) return { cmd: early, text: "" };
			show("listening"); setHeard("");
			await sleep(250);   // the speaker's tail out of the room before the mic opens
			const text = await listenOnce(step());
			const pressed = take(); if (pressed) return { cmd: pressed, text: "" };
			setHeard(text);
			return { cmd: voiceCommand(text), text };
		};
		const waitForPress = () => new Promise<VoiceCommand>((res) => { waiterRef.current = (c) => { waiterRef.current = null; pendingRef.current = null; res(c); }; });
		/** Paused: listens for "continue" a few times, then stops listening (no mic left open for nothing) and waits for a tap. */
		const waitResume = async (): Promise<"resume" | "stop"> => {
			await speak("Paused. Say continue when you're ready.");
			for (let quiet = 0; alive(); ) {
				if (quiet >= 4) {
					show("paused"); setSaid("Paused. Tap Resume to go on.");
					return (await waitForPress()) === "stop" ? "stop" : "resume";
				}
				const { cmd, text } = await hear();
				if (cmd === "resume" || cmd === "repeat") return "resume";
				if (cmd === "stop") return "stop";
				if (!text) quiet++;
			}
			return "stop";
		};

		let queue: VoiceCard[] = [], i = 0, done = 0, hinted = false;
		const load = async () => {
			show("loading"); setSaid("Getting your cards… (a card is written the first time it comes up, a few seconds)");
			queue = (await api<{ queue?: VoiceCard[] }>(`/api/learner/review?limit=25${deck ? `&deck=${encodeURIComponent(deck)}` : ""}`)).queue ?? [];
			i = 0;
		};

		try {
			if (forced !== "browser") { try { await token(); engineRef.current = "deepgram"; } catch { engineRef.current = null; } }
			if (!engineRef.current) {
				if (!recognizerCtor()) throw new Error("No speech recognition here: add a Deepgram key to the server, or open this page in Safari or Chrome.");
				engineRef.current = "browser";
			}
			setEngine(engineRef.current);
			await load();
			if (!alive()) return;
			if (!queue.length) { await speak("Nothing is due right now."); show("done"); return; }
			await speak(`${queue.length} card${queue.length === 1 ? "" : "s"} due. Answer out loud or in your head, say answer to hear it, then rate it: again, hard, good, or easy.`);

			cards: while (alive()) {
				if (i >= queue.length) {
					await speak(`That's all of them. ${done} reviewed. Say more for another round, or stop.`);
					const { cmd } = await hear();
					if (cmd !== "resume" && cmd !== "repeat") break;
					await load();
					if (!queue.length) { await speak("Nothing else is due."); break; }
					continue;
				}
				const c = queue[i]!;
				setCard(c); setPos({ i, n: queue.length });
				await speak(promptSpeech(c));
				let rating: 1 | 2 | 3 | 4 | null = null, quiet = 0, revealed = false;
				const reveal = async () => {
					revealed = true;
					// The first time in a session, say what to say next; after that the answer alone.
					await speak(answerSpeech(c) + (hinted ? "" : " How was it? Again, hard, good, or easy?"));
					hinted = true;
				};
				turn: while (alive()) {
					const { cmd, text } = await hear();
					if (!alive()) return;
					const said = cmd ? VOICE_RATING[cmd] : undefined;
					if (said) { rating = said; break turn; }
					switch (cmd) {
						case "repeat": await speak(revealed ? [{ text: answerSpeech(c) }] : promptSpeech(c)); continue;
						case "skip": break turn;
						case "stop": break cards;
						case "resume": continue;
						case "reveal": await reveal(); continue;
						case "pause": {
							if ((await waitResume()) === "stop") break cards;
							await speak(revealed ? [{ text: answerSpeech(c) }] : promptSpeech(c)); continue;
						}
					}
					if (!text) {
						if (++quiet === 1) { await speak(revealed ? "Again, hard, good, or easy?" : "Take your time. Say answer to hear it."); continue; }
						if ((await waitResume()) === "stop") break cards;
						quiet = 0; await speak(revealed ? [{ text: answerSpeech(c) }] : promptSpeech(c)); continue;
					}
					// Anything else is the answer said out loud: nothing grades it, the card's answer is read to check it against.
					if (!revealed) await reveal();
					else await speak("Again, hard, good, or easy?");
				}
				if (rating !== null) {
					await post("/api/learner/review", { itemId: c.itemId, mode: c.mode, rating });
					done++; setReviewed(done); queue = requeueMissed(queue, i, rating);
					// Rated a miss before hearing the answer: it is read now, the part of a miss that does the work.
					if (!revealed && rating <= 2) await speak(answerSpeech(c));
				}
				i++;
			}
			if (!alive()) return;
			pendingRef.current = null;
			await speak(`Stopping. ${done} reviewed.`);
			show("done");
		} catch (e) {
			if (!alive()) return;
			setNotice((e as Error).message); show("error");
			await say([{ text: "Something went wrong. The message is on the screen." }], rateRef.current, new AbortController().signal);
		} finally {
			if (alive()) { setCard(null); void lockRef.current?.release().catch(() => {}); lockRef.current = null; }
		}
	}, [deck, forced]);

	const start = () => {
		// Everything a phone allows only inside a tap happens here, before any await:
		// the first speech (iOS stays silent otherwise) and the audio context.
		speechSynthesis.cancel();
		const unlock = new SpeechSynthesisUtterance(" "); unlock.volume = 0; speechSynthesis.speak(unlock);
		if (forced !== "browser") void audioContext().resume().catch(() => {});
		void holdScreen();
		pendingRef.current = null; setNotice(""); setReviewed(0); setHeard(""); setSaid("");
		void loop(++runRef.current);
	};
	const setSpeed = (r: number) => { setRate(r); rateRef.current = r; try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* no storage */ } };

	const running = !["idle", "done", "error"].includes(phase);
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex min-h-full max-w-xl flex-col gap-5 px-4 py-6">
				<header className="flex items-baseline justify-between gap-3">
					<h1 className="text-lg font-semibold">Voice review{deck ? ` · ${deck}` : ""}</h1>
					<span className="text-xs text-muted-foreground">{engine ? (engine === "deepgram" ? "Deepgram" : "phone recognizer") : ""}</span>
				</header>

				<div className="flex items-center gap-2 text-sm">
					<span className={`inline-block size-2.5 rounded-full ${phase === "listening" ? "animate-pulse bg-red-500" : phase === "speaking" ? "bg-sky-500" : running ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
					<span className="font-medium">{PHASE_WORD[phase]}</span>
					{pos.n > 0 && running && <span className="text-muted-foreground">· card {pos.i + 1} of {pos.n}</span>}
					{reviewed > 0 && <span className="text-muted-foreground">· {reviewed} reviewed</span>}
				</div>

				{card && running && (
					<div className="rounded-lg border bg-card p-4">
						<div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{card.mode}{card.retry ? " · again" : ""}</div>
						<p className="whitespace-pre-wrap text-base leading-relaxed">{card.mode === "listen" && card.speak ? card.speak : card.prompt}</p>
					</div>
				)}
				{heard && <p className="text-sm"><span className="text-muted-foreground">You said: </span>{heard}</p>}
				{said && <p className="text-sm text-muted-foreground">{said}</p>}
				{notice && <p className="rounded-md border border-amber-500/40 p-3 text-sm">{notice}</p>}

				<div className="mt-auto flex flex-col gap-3 pb-[env(safe-area-inset-bottom)]">
					{running ? (
						<div className="grid grid-cols-2 gap-2">
							<Button variant="outline" size="lg" onClick={() => press("repeat")}><RotateCcwIcon />Repeat</Button>
							<Button variant="outline" size="lg" onClick={() => press("skip")}><SkipForwardIcon />Skip</Button>
							<Button variant="outline" size="lg" onClick={() => press("reveal")}><EyeIcon />Answer</Button>
							{phase === "paused"
								? <Button variant="outline" size="lg" onClick={() => press("resume")}><PlayIcon />Resume</Button>
								: <Button variant="outline" size="lg" onClick={() => press("pause")}><PauseIcon />Pause</Button>}
							<div className="col-span-2 grid grid-cols-4 gap-2">
								{(["again", "hard", "good", "easy"] as const).map((r) => (
									<Button key={r} variant="secondary" size="lg" className="capitalize" onClick={() => press(r)}>{r}</Button>
								))}
							</div>
							<Button variant="destructive" size="lg" className="col-span-2" onClick={() => press("stop")}><SquareIcon />Stop</Button>
						</div>
					) : (
						<Button size="lg" className="h-16 text-base" onClick={start}><MicIcon />{phase === "idle" ? "Start" : "Start again"}</Button>
					)}
					<label className="flex items-center gap-3 text-xs text-muted-foreground">
						Speed
						<input type="range" min={0.7} max={1.5} step={0.05} value={rate} onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1" />
						<span className="w-10 text-right tabular-nums">{rate.toFixed(2)}×</span>
					</label>
					{!running && (
						<p className="text-xs leading-relaxed text-muted-foreground">
							The phone reads each card. Answer out loud or in your head; say <i>answer</i> to hear it, then rate it: <i>again</i>, <i>hard</i>, <i>good</i> or <i>easy</i>, as on the buttons. Also <i>repeat</i>, <i>skip</i>, <i>pause</i>, <i>stop</i>. Keep the screen on: a locked phone stops the mic.
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
