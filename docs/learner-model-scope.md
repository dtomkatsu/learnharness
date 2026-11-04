# Learner model, progress, terms and memorization — scope

Status: **built 2026-11-04** on branch `side-threads` (dtomkatsu fork) — see *As built* at the end. LearnHarness's own web UI does not show it yet; the e-ink reader (Boox Paper's Learn page) does.

## Where things stand

What LearnHarness knows about the learner today:

| Signal | Where it lives | Survives the session? |
|---|---|---|
| Quiz / explain answers, confidence, thinking | the chat transcript only | only as transcript text |
| The probe's assessment | `probe_done` in the transcript | only as transcript text |
| Plan position | `record.tree` + quiz `nodeId` tags | per lesson; "visited", never "learned" |
| Facts encountered | `data/graph/nodes.jsonl` (31 nodes) with provenance | yes, but state-neutral |
| Per-proposition understanding (`solid` / `shaky` / …) | the extractor emits it… | **no** — the event ledger was purged (`events.jsonl` is deleted on load); vision §1: "state-neutral nodes until the state model is designed" |
| Terms taught / used too early / side questions | `record.vocabulary` (new, 2026-11) | per lesson |
| Practice targets (mastery trace) | practice transcripts | only as transcript text |

So every lesson starts from zero: the prober re-measures what earlier lessons already established, the teacher cannot see that "gradient" was missed twice last week, and nothing ever comes back for review. The vision already names the missing pieces — "the state model", "sessions open with retrieval", "spaced repetition on the event ledger" — but none is built.

The proposal is one foundation and four things built on it.

## 0. Foundation — the evidence ledger and a derived learner state

**Evidence ledger** — `data/learner/evidence.jsonl`, append-only, one line per observation, written by code (not judged by a model) wherever a signal already exists:

| Event | Source | Fields |
|---|---|---|
| `answer` | every quiz / explain result (teach, probe, practice) | target node ids, correct / miss / don't-know, confidence stop, latency, the learner's thinking (verbatim) |
| `review` | the review queue (§3) | item id, grade (again / hard / good / easy), mode (recall / produce / why) |
| `taught` / `used-early` | the vocabulary ledger | term, lesson, message |
| `asked` | a side question opened | term, lesson |
| `probe` | `probe_done`'s assessment | per area: held / shaky / absent |
| `understanding` | the extractor's closed-scale word | node, level, session |

Targets resolve to graph node ids the same way practice's mastery trace already does (`chains.ts` name→id normalization). Terms join the graph as nodes whose statement is the term's meaning (`name` = the term), so one id space covers both.

**Derived state** — computed on read, never stored (the vision's "understanding is derived" rule):

- per item: *retrievability* (probability it comes to mind now) and *stability* (how long until that drops below 90%), from the review/answer history — FSRS-4.5 (open, well-tested, ~200 lines; the parameters fit to the learner once there are ~400 reviews). Leitner boxes are the cheaper fallback if FSRS is judged overkill.
- per item: *status* — `new` (seen, never retrieved), `learning`, `solid` (stability ≥ 21 days), `fragile` (≥2 misses in the last 3 attempts), `misconceived` (a miss whose thinking states a specific wrong belief; the belief is kept, verbatim).
- *calibration* — confidence vs. correctness over the last N answers; "sure and wrong" is the most useful single signal for the teacher.
- dependency-aware: a node is only as solid as the `follows` premises under it (min over premises, one level deep — the vision's open question 6, settled cheaply and revisable).

Effort: ledger writers + FSRS + derivation + tests — **3–4 days**. Everything below reads this.

## 1. Knowing what the learner knows

- **Learner profile as session context.** At lesson start (the `graph-context` marker pattern), the teacher and prober get a short block: solid / fragile / misconceived items near the topic (by graph neighbourhood and term match), the learner's calibration, and terms already held. Model-only, ≤40 lines, ranked by relevance.
- **Probe from the profile.** The prober skips what the ledger shows solid and recent, and spends its questions on fragile and unmeasured ground — shorter probes, no re-asking last week's answers.
- **Misconceptions as first-class.** A miss whose thinking names a wrong belief is recorded with the belief; the teacher sees "believes: the gradient points downhill" and is told to repair it explicitly, not just re-teach around it.
- **"What I know" page** (LH web + the tablet): per area, solid / fragile / due, with the evidence behind each (tap → the answers and lessons). Honest, not gamified (vision: no XP or streaks).

Effort: **2–3 days** after §0.

## 2. Progress tracking

- **Per lesson:** each plan node shows *checked* (a correct check landed), *repaired* (missed, then passed), *open* — derived from the evidence ledger, not from the `visited` tag. The lesson card says "6 of 9 steps checked · 2 repaired · 3 terms due".
- **Across lessons:** a weekly digest (LH home, the tablet's shelf, optionally the Boox sleep screen): new solid items, items slipping (retrievability falling below 70% and not yet due), misconceptions fixed, time spent.
- **End-of-lesson summary card:** what was established, what is still shaky, which terms were added to review, the next suggested step (frontier: nodes whose premises are all solid).
- **Teacher-visible:** "you have checked 6 of 9 nodes; nodes X and Y were never checked" in the lesson notes when the lesson is about to conclude, so nothing is skipped silently.

Effort: **2 days** (the derivations are cheap; most of it is the views).

## 3. Memorization — the review queue

A daily review, spaced by FSRS, over **terms** (from the vocabulary ledger, including every side question) and **propositions** (graph nodes taught in lessons).

**Card modes**, generated once per item by the cheap model from the statement and graph neighbourhood, stored with the item:

| Mode | Prompt | Answer | When |
|---|---|---|---|
| recall | the term | its meaning, in own words | first |
| produce | the meaning, or a situation | the term | once recall is stable (reverse direction is harder and needs its own schedule) |
| why | a proposition | the premise it follows from (`follows` edge) | propositions only; this is the "click" kept alive |
| discriminate | two confusable items side by side | what separates them | when both are held and were confused once |
| cloze | the statement with the key part removed | the missing part | formulas, definitions |

**Answering:** free recall, handwritten or spoken on the tablet (the pad and Speak already exist), graded by the cheap model against the stored meaning → again / hard / good / easy; the learner can overrule the grade with one tap. A self-graded "show answer" mode for speed.

**Helping it stick** — only where an item is struggling, so effort goes where it's needed:
- after a second miss: an **elaboration card** — re-derive it from what's held (the method's "how could I have discovered this?") rather than repeat it;
- after a third: a **memory hook** — an image, a contrast pair, or an etymology (Hessian → Otto Hesse), generated once and shown with the card;
- a **leech** (≥6 misses) is pulled from review and sent back to teaching as a lesson note: "this never stuck — it may rest on something missing".

**Interleaving into lessons:** due items near the current topic are handed to the teacher as candidates for retrieval checks inside the lesson ("ask about 'slope' before using it here") — reviews happen in context, not only in the queue.

**Session opening:** the vision's 60-second recall card — two or three due items from the last lesson in this area, before anything new.

Where it runs: a new session kind `review` in LH (like `practice`: its own small agent and doctrine), and a **Review** row on the tablet's shelf with the count due. Optional: the due count on the Boox sleep screen.

Effort: **4–5 days** (card generation, the review agent and grader, FSRS scheduling, LH UI, the tablet page).

## 4. Re-instilling terms that come up

Partly covered by §3; the term-specific pieces:

- **A glossary** — per lesson and global, built from the vocabulary ledger: term, the meaning as taught, where it was taught (deep link), status from §0. On the tablet, a term marked in a lesson (the side-thread underline) can open its glossary entry instead of a new thread when one exists.
- **Every side question becomes a review card** automatically (it is, by definition, a term that did not land).
- **Re-encounter in later lessons:** when a held term reappears, the vocabulary check records a *re-encounter*; a correct use by the learner counts as a successful retrieval (an `answer` event of low weight), so ordinary lessons feed the schedule.
- **Term drift:** if the checker sees a term used with a different meaning than the one taught (context-relative truth, vision §1), it flags it so the teacher names the shift rather than letting two meanings blur.

Effort: **1–2 days** after §0 and §3.

## Order and total

| Step | Gives | Effort |
|---|---|---|
| 0. Evidence ledger + derived state | the foundation; nothing visible yet | 3–4 d |
| 3. Review queue on **terms** first | the first visible memorization win; uses the vocabulary ledger already built | 3 d |
| 1. Profile as context + probe from it | lessons stop re-measuring; misconceptions repaired | 2–3 d |
| 2. Progress per lesson + digest | "where am I" on LH and the tablet | 2 d |
| 3b. Propositions, why/discriminate cards, hooks, leeches | memorization of ideas, not just words | 2 d |
| 4. Glossary, re-encounters, drift | terms stay fresh between reviews | 1–2 d |

About **2½–3 weeks** end to end; the first useful slice (0 + term reviews) is about a week.

## Decisions needed

1. **FSRS or Leitner?** FSRS is better and not much bigger; Leitner is simpler to explain. Recommendation: FSRS.
2. **Where reviews happen.** LH web and the tablet, or tablet-first? Recommendation: both, tablet-first for the UI work.
3. **Grading.** Model-graded free recall (slower, ~1 cheap call per card, better retention) or self-graded flip cards (fast, free)? Recommendation: model-graded by default, a self-graded quick mode.
4. **Upstream or fork-only.** The ledger revives a design the upstream author removed pending a state model; a PR upstream would need their agreement on that model. Recommendation: build on the fork, offer §0 upstream as a proposal once it has run for a while.

## Risks

- **Cost.** Card generation is once per item; grading is one cheap call per review (~$0.001 on Haiku-class models; on the Claude Code slot it counts against the subscription instead). The vocabulary check already adds one call per teaching turn.
- **Wrong grades** erode trust — the one-tap overrule and showing the model's reason matter more than grader accuracy.
- **Nagging.** Due counts must never interrupt a lesson; reviews are offered, not pushed (no notifications by default).
- **Identity drift.** Terms and propositions merge by the auditor's judgment; a wrong merge would pool two items' histories. Conservative merging (the auditor's existing rule) and a "split" action in the glossary.


## As built (2026-11-04)

| Piece | Where |
|---|---|
| FSRS-6 (adapted from ts-fsrs via upstream's flashcards plugin, MIT) | `src/core/learner/fsrs.ts` |
| Evidence types, derivation, queue, progress, digest, glossary, profile | `src/core/learner/model.ts` (pure) |
| Evidence log + cards | `src/store/learner.ts` → `data/learner/evidence.jsonl`, `data/learner/cards.json` |
| Writers (answers, practice, backfill), cards, grading, lesson notes | `src/server/learner.ts` |
| After-turn check (terms, verdicts, misconceptions, uses, drift) | `src/server/vocabulary-check.ts` |
| Notes into turns (profile, due, never stuck, unchecked, drift) | `src/server/chat-handler.ts` |
| API | `app/api/learner/{,items,item,review,review/overrule,progress/[id],glossary}` |
| Tests | `tests/learner-model.test.ts`, `tests/learner-routes.test.ts`, `tests/vocabulary.test.ts` |

Decisions taken: FSRS-6 (not 4.5 — upstream already had a tested port); model-graded free recall with a one-tap overrule, plus show-and-self-grade; fork-only for now.

Deviations from the plan: review runs as an API + the tablet's screens, not as a new LearnHarness session kind with its own agent (no conversation is needed to grade one card — one cheap call is). Items are terms and graph propositions; plan nodes map to terms through the plan's vocabulary, and an answer is joined to the propositions extracted from the teaching just before it (the messages since the previous answer, ≤4 propositions).

### What this replaces — the old events ledger vs. the learner model

| | Events ledger (removed 2026-09-27) | Learner model |
|---|---|---|
| Recorded | quiz outcome (correct / miss / don't-know + note); one closed-scale understanding word per node per session | every answer (probe, check, prediction, explain), with confidence and reasoning; practice outcomes with hint level; reviews; terms taught / used early / asked about; the learner's own correct and wrong uses; misconceptions verbatim; term drift |
| Attributed to | graph nodes, by the extractor's retroactive judgment | terms (via the plan's declared vocabulary) and propositions (provenance join on the teaching the question checked; practice targets directly) |
| Derived state | none — "state-neutral nodes until the state model is designed" | per item: FSRS schedule, retrievability now, status (new / learning / solid / fragile / misunderstood / never stuck / set aside), weakest premise; calibration |
| Things that are not evidence | counted alike | a missed prediction or probe is not a lapse; an unsure right answer is "hard"; an explain answer waits for the tutor's verdict; a correct use counts only once the item had begun to fade |
| Read back into teaching | never | profile at the start of each lesson (prober too), due related items every 4th turn, leeches, unchecked earlier steps, drift |
| Memorization | none | spaced review queue with recall / produce / why / cloze / tell-apart cards, model grading, elaboration after 2 lapses, a true memory hook after 3, leeches sent back to teaching |
| Progress | none | per lesson (checked / repaired / missed / open, frontier, established / shaky), weekly digest, glossary |
| History | deleted with the ledger | rebuilt from the transcripts on first use (`backfillEvidence`, idempotent) |

Measured on a copy of the live data (24 sessions), real cheap model (claude-code haiku): backfill 72 answers in 17 ms; 27 of 29 propositions get a state from past answers (3 of 29 with a same-message join only — the teaching-window join is what makes the history usable); calibration 77% right at 66% mean confidence, 10% of ≥75%-confident answers wrong; three cards written in 7–12 s; a grade in ~1.5 s; the after-turn check on the Indonesian lesson recorded 18 taught words and flagged the four forms used before teaching (-nya, -lah, deh, kan).

## Round two (2026-11-04, a8f3016 → 4cb35f3)

- **Tests never touch data/**: NODE_ENV=test with no LH_DATA_DIR gets a scratch folder (config.ts). A full run had left 44 fixture chats and 34 jobs in a real library.
- **Glossary tidy** (POST /api/learner/glossary/tidy; also in the background after a term check and when the glossary is opened): lone letters and numbers retired by rule; the cheap model retires everyday words, merges duplicates, fills missing meanings — as merge / retire / meaning evidence. On real data: 41 terms looked at, 1 retired (p), 9 meanings filled, nothing merged (the model kept bend / shares / neighbor / shape: the lesson used them as its own names).
- **Item changes** (POST /api/learner/item): known (held about three months at once), the learner's own meaning (never replaced), retire.
- **Confidence on reviews**; calibration by topic (lesson title or deck) in the summary.
- **Language words**: lang and an example sentence from the term check; asked recall → listen → cloze, and produce once stable.
- **Decks** (data/learner/external/*.json; scripts/sync-bahasa.mts every 30 min on madison, LaunchAgent com.devinthomas.learnharness-bahasa-sync): the Bahasa app's 1,043 cards (202 studied there, 618 with a Lingua Libre recording) with its FSRS schedule as the baseline; reviews here go on top and are written back to its progress gist (backup first, ~/backups/bahasa-gist/). Deck-only words have their own queue (?deck=bahasa) and stay out of the lessons' queue, glossary and weekly digest; a language lesson's profile names what the deck holds.
- **Opening a lesson** (GET /api/learner/lesson/[id]): warm-up items; after three hours or more, the recap (cheap model, kept until the lesson moves on); the tutor gets [Returning after …] once.
- **Map** (GET /api/learner/map) and **vocabulary health** (terms used before they were taught, by week; 27% on real data so far).
