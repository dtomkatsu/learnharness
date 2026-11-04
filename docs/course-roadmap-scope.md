# Scope: a course with a roadmap, not one endless lesson (2026-11-04)

## The problem

A "lesson" today is one chat aimed at one goal. The tutor draws a map of 5–15 steps for it ("a map, not a syllabus") and teaches until the goal is reached. Devin's LLM lesson is that model stretched to its limit: one chat, 255 messages, 93 turns over two days, 20 steps, 74 pages on the tablet. There is no "lesson 3 of 9", no stopping point that says *today is done*, no sense of how far is left, and nothing that decides what to do at the start of the next sitting except the warm-up.

What he is asking for is a **course**: a goal broken into an ordered sequence of sized lessons, each with a clear purpose, which he can see laid out ahead of him and move through day by day.

## What the learning research says this should look like (no new search; standard findings)

- **Sized sessions with a defined end.** Working memory is small; a session should introduce a handful of new ideas and stop. A lesson that ends ("done for today") also makes the next day's spacing happen.
- **Mastery before moving on.** Move to the next unit when the current one is actually held (Bloom's mastery learning) — here: steps confirmed in the lesson and, ideally, recalled again a day later (the `held` status built today).
- **Cumulative, spaced review between lessons.** Each lesson opens by retrieving the previous ones (the warm-up exists); periodically a short checkpoint mixes earlier units (interleaving, for things easily confused).
- **An advance organiser.** Showing the whole route and where today's lesson sits helps place new ideas; it is also motivating to see progress.
- **Prerequisites as a graph.** Order comes from what rests on what — the same principle as the lesson map and the vocabulary gate, one level up.

## Design

### 1. A course above lessons

`data/courses/<id>.json`:

```
{ id, title, goal, level,                     // what he wants to be able to do, where he starts
  units: [ { id, title, why,                   // a unit: a few lessons around one idea
    lessons: [ { id, title, objectives: [..],  // "by the end you can …" (2–4, checkable)
                 steps: [..], introduces: [..terms], needs: [..terms],
                 minutes: 25, prereqs: [lessonId..],
                 kind: "teach" | "checkpoint" | "practice",
                 chatId?, status } ] } ],
  version, history: [ { at, why } ] }
```

Lessons stay LearnHarness chats; a chat gets `course: { id, lessonId }` (as side questions got `parent`). Inside a lesson, `plan_init` still draws its own step map — seeded from the course lesson's steps and vocabulary instead of from nothing.

### 2. Making a course

**+ New course** on the shelf: the goal → the existing probe (what he already holds) → a planner turn on the strong model drafts the roadmap: units, lessons of about 20–30 minutes with 3–6 steps each, objectives, the vocabulary each introduces and needs (checked by the same gate as `plan_init`, now across lessons), checkpoints every few lessons. He sees it as a roadmap and approves it, or says what to change by pen or voice ("skip the maths refresher", "more on attention") and the planner redraws it.

### 3. Running it

- **Next lesson** opens a new chat for the next unlocked lesson. Its first turn carries a `[Course context]` note: the course goal, this lesson's objectives and steps, what earlier lessons established (from the learner model: held, fragile, misbelieved), and what comes next — so the tutor neither re-teaches nor jumps ahead.
- **The lesson ends.** When its objectives are confirmed the tutor closes it: a short recap, the notes (built today) are finished, the new terms go into review. The tablet shows "Lesson 4 done — next: Lesson 5, tomorrow".
- **Gates.** The next lesson unlocks when this one's steps are confirmed; a lesson whose prerequisites are fragile starts by repairing them (the "unchecked steps" note, at course level).
- **Checkpoints.** Every 3–4 lessons a short checkpoint lesson: no new material, mixed retrieval over the units so far, own-words and use-it questions; a miss sends him to the relevant lesson's note and adds a repair step to the next lesson.

### 4. Changing course

The roadmap is a hypothesis, like the lesson map: re-planned when the probe or a checkpoint shows he already holds a lesson (test out: it is marked done), when he struggles (a repair lesson is inserted), or when he asks. Each change is kept in `history` with why.

### 5. On the tablet

- **Course page**: units → lessons, each with its status (done · held · in progress · next · locked) and length; the objectives of the next one; a big **Continue: Lesson 5 · 25 min**.
- **Shelf**: a course is one row with its progress ("LLMs · 4 of 12 lessons"), lessons and side questions nested under it.
- **Course notes**: the lesson notes, in course order — one document for the whole subject.
- The **Today** session idea (reviews → the next lesson, with its warm-up) runs on top of this.

### 6. The two existing lessons

- **LLMs**: turned into a course after the fact — its 20 steps grouped into units (vectors and dot products → word2vec, softmax and loss → matrices and layers → attention → the transformer), the confirmed steps marked done, its notes split by lesson; what is left (the steps never confirmed, the topics the tutor offered next) becomes the remaining lessons.
- **Bahasa**: its 13-step map is already a course outline (casual verbs → pronouns and register → particles → slang → reading real messages); it becomes 5 lessons, with the flashcard deck as its review.

## Slices

1. Course record, planner turn and the approve/redraw flow (LearnHarness), with tests.
2. Lessons as chats in a course: seeding `plan_init`, the `[Course context]` note, closing a lesson, gates.
3. The tablet: course page, Continue, shelf row, course notes.
4. Checkpoint lessons and re-planning (test out, repair lessons).
5. Converting the two existing lessons.

Slices 1–3 make it usable; 4 and 5 make it good. Each is a day-sized piece.

## Open questions for Devin

- **Lesson length**: about 20–30 minutes (my default), or shorter for tablet sittings?
- **Pace**: a lesson a day with reviews (the Today session), or entirely at will?
- **Testing out**: may a lesson be skipped when a quick check shows he already holds it?
- **How much say**: approve the roadmap once, or review each unit before it starts?
- **Where**: the tablet only, or LearnHarness's own web interface too (more work: its UI is React, separate from Paper's page)?
