import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VOICE_RATING, answerSpeech, promptSpeech, requeueMissed, speakable, speechChunks, texToSpeech, voiceCommand, type VoiceCard } from "../src/core/voice-review.ts";

const card = (over: Partial<VoiceCard> = {}): VoiceCard => ({ itemId: "node:a", mode: "recall", label: "A", prompt: "What is **A**?", answer: "The first letter.", ...over });

describe("voice commands", () => {
	it("hears a command only when it is the whole reply", () => {
		assert.equal(voiceCommand("Skip."), "skip");
		assert.equal(voiceCommand("Um, I don't know."), "dontKnow");
		assert.equal(voiceCommand("I don’t know"), "dontKnow");
		assert.equal(voiceCommand("Say that again, please"), "repeat");
		assert.equal(voiceCommand("OK, stop"), "stop");
		assert.equal(voiceCommand("Show me the answer"), "reveal");
		assert.equal(voiceCommand("the next step is to stop the reaction"), null);
		assert.equal(voiceCommand("good question, it is about supply"), null);
		assert.equal(voiceCommand(""), null);
	});
	it("hears the four review grades, as the buttons number them", () => {
		const rate = (t: string) => VOICE_RATING[voiceCommand(t)!];
		assert.equal(rate("Again."), 1);
		assert.equal(rate("try again"), 1);
		assert.equal(rate("I don't know"), 1);
		assert.equal(rate("That was hard"), 2);
		assert.equal(rate("Good"), 3);
		assert.equal(rate("got it"), 3);
		assert.equal(rate("Easy!"), 4);
		assert.equal(VOICE_RATING[voiceCommand("repeat")!], undefined);
	});
});

describe("speech text", () => {
	it("says maths in words", () => {
		assert.equal(texToSpeech("\\frac{a}{b}^2"), "a over b squared");
		assert.equal(texToSpeech("x_{i} = \\sqrt{y} - 1"), "x sub i equals the square root of y minus 1");
		assert.equal(texToSpeech("e^{-x}"), "e to the minus x");
		assert.equal(texToSpeech("\\alpha \\le \\beta"), "alpha is at most beta");
	});
	it("drops markup and reads list lines as sentences", () => {
		assert.equal(speakable("## Why\n- **supply** falls\n- price $p$ rises"), "Why. supply falls. price p rises.");
		assert.equal(speakable("See [the note](http://x) and `f(x)`[1]."), "See the note and f(x).");
		assert.match(speakable("Run:\n```py\nprint(1)\n```"), /code block/);
	});
	it("cuts long speech at sentence ends", () => {
		const text = Array.from({ length: 12 }, (_v, i) => `Sentence number ${i} is here.`).join(" ");
		const chunks = speechChunks(text, 80);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((c) => c.length <= 80));
		assert.equal(chunks.join(" "), text);
	});
});

describe("prompts and verdicts", () => {
	it("asks a listening card in its own language", () => {
		assert.deepEqual(promptSpeech(card({ mode: "listen", speak: "rumah", lang: "id" })), [{ text: "rumah", lang: "id" }, { text: "What does it mean?" }]);
		assert.deepEqual(promptSpeech(card({ shape: "one sentence", looksFor: ["x", "y"] })).map((s) => s.text), ["What is A?", "one sentence, 2 points."]);
		assert.equal(promptSpeech(card({ retry: true }))[0]!.text, "Again, the one you missed.");
	});
	it("reads the answer as speech", () => {
		assert.equal(answerSpeech(card({ answer: "It is $x^2$." })), "The answer: It is x squared.");
	});
	it("brings a missed card back four cards on, at most three times", () => {
		const q = ["a", "b", "c", "d", "e", "f", "g"].map((id) => card({ itemId: id }));
		const after = requeueMissed(q, 0, 1);
		assert.equal(after.length, 8);
		assert.equal(after[5]!.itemId, "a");
		assert.equal(after[5]!.retry, true);
		assert.equal(requeueMissed(q, 0, 3).length, 7);
		assert.equal(requeueMissed([card({ retries: 3 })], 0, 1).length, 1);
		assert.equal(requeueMissed(q, 6, 1)[7]!.itemId, "g");
	});
});
