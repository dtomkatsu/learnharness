"use client";

/**
 * COURSES in the web app (2026-11, docs/course-roadmap-scope.md): a goal as a
 * roadmap of sized lessons — drafted by the strong model, approved or redrawn
 * from what the learner says, taken a lesson a day. The same /api/courses the
 * tablet's Learn page uses. Three pieces: the sidebar's Courses list, the new
 * course page (a goal, or a lesson from before courses), the course page.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BookOpenIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type LessonState = "locked" | "next" | "in-progress" | "done" | "held" | "skipped";
interface LessonV {
	id: string; n: number; title: string; objectives: string[]; steps: string[]; minutes: number; kind: "teach" | "checkpoint";
	chatId?: string; adopted?: { chatId: string; nodes: string[] }; state: LessonState; progress: { steps: number; confirmed: number; held: number } | null;
}
interface CourseV {
	id: string; title: string; goal: string; level: string; status: "draft" | "active"; done: number; total: number;
	next: { id: string; n: number; title: string; minutes: number; state: LessonState; chatId: string | null } | null;
	nextSuggestedAt: string | null; history: { at: string; why: string }[];
	units: { id: string; title: string; why: string; lessons: LessonV[] }[];
}
interface CourseSummary { id: string; title: string; status: "draft" | "active"; done: number; total: number; next: CourseV["next"] }

const MARK: Record<LessonState, string> = { done: "✓", held: "✓✓", "in-progress": "▸", next: "●", locked: "·", skipped: "↷" };
const WORD: Record<LessonState, string> = { done: "done", held: "done · held a day later", "in-progress": "in progress", next: "next", locked: "later", skipped: "skipped — known" };

async function call<T>(url: string, body?: unknown): Promise<T> {
	const r = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
	return j as T;
}

/** The sidebar's Courses: each with its progress and next lesson, and a door to a new one. */
export function SidebarCourses() {
	const router = useRouter(), pathname = usePathname();
	const [courses, setCourses] = useState<CourseSummary[] | null>(null);
	useEffect(() => { void call<{ courses: CourseSummary[] }>("/api/courses").then((d) => setCourses(d.courses)).catch(() => setCourses([])); }, [pathname]);
	return (
		<div className="mx-3 mb-3" data-testid="sidebar-courses">
			<div className="mb-1 flex items-center justify-between">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Courses</span>
				<button type="button" data-testid="new-course" onClick={() => router.push("/course/new")} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
					<PlusIcon className="size-3" /> Course
				</button>
			</div>
			{(courses ?? []).map((c) => (
				<button key={c.id} type="button" onClick={() => router.push(`/course/${c.id}`)} className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent ${pathname === `/course/${c.id}` ? "bg-accent" : ""}`}>
					<span className="flex items-center gap-1.5 text-sm"><BookOpenIcon className="size-3.5 shrink-0" />{c.title}</span>
					<span className="text-xs text-muted-foreground">{c.status === "draft" ? "draft — review the roadmap" : `${c.done} of ${c.total}${c.next ? ` · next: ${c.next.title}` : " · all done"}`}</span>
				</button>
			))}
		</div>
	);
}

/** A new course: from a goal, or from a lesson taken before courses (what is done stays done). */
export function NewCourse() {
	const router = useRouter();
	const [goal, setGoal] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lessons, setLessons] = useState<{ id: string; title: string }[]>([]);
	useEffect(() => {
		void call<{ chats: { id: string; title: string; kind?: string; parent?: unknown; course?: unknown; messageCount?: number }[] }>("/api/chats")
			.then((d) => setLessons(d.chats.filter((c) => c.kind !== "practice" && !c.parent && !c.course && (c.messageCount ?? 0) > 20))).catch(() => {});
	}, []);
	const draft = useCallback(async (body: { goal: string } | { fromChat: string }) => {
		setBusy(true); setError(null);
		try { const c = await call<CourseV>("/api/courses", body); router.push(`/course/${c.id}`); }
		catch (e) { setError((e as Error).message); setBusy(false); }
	}, [router]);
	return (
		<div className="mx-auto w-full max-w-2xl px-6 py-10" data-testid="new-course-page">
			<h1 className="mb-2 text-2xl font-semibold">A new course</h1>
			<p className="mb-6 text-sm text-muted-foreground">Say what you want to be able to do. The planner lays it out as lessons of about 25 minutes — one a day, with checkpoints — starting from what you already hold. You approve the roadmap or say what to change.</p>
			<Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} placeholder="e.g. understand how a transformer turns text into the next word" disabled={busy} />
			<div className="mt-3 flex gap-2">
				<Button onClick={() => void draft({ goal: goal.trim() })} disabled={busy || !goal.trim()}>{busy ? "Drafting the roadmap… (a minute)" : "Draft the roadmap"}</Button>
			</div>
			{error && <p className="mt-3 text-sm text-destructive">{error}</p>}
			{lessons.length > 0 && (
				<div className="mt-10">
					<h2 className="mb-2 text-sm font-medium">…or turn a lesson you have been taking into a course</h2>
					<div className="flex flex-col gap-1.5">
						{lessons.map((l) => (
							<Button key={l.id} variant="outline" className="justify-start" disabled={busy} onClick={() => void draft({ fromChat: l.id })}>{l.title}</Button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/** The course: its roadmap, Start / Continue, approve or redraw, a lesson's objectives, skip, its notes. */
export function CourseView({ courseId }: { courseId: string }) {
	const router = useRouter();
	const [v, setV] = useState<CourseV | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [request, setRequest] = useState("");
	const [open, setOpen] = useState<string | null>(null);
	const [changing, setChanging] = useState(false);
	useEffect(() => { void call<CourseV>(`/api/courses/${courseId}`).then(setV).catch((e) => setError((e as Error).message)); }, [courseId]);
	const act = useCallback(async (body: Record<string, unknown>, label: string) => {
		setBusy(label); setError(null);
		try { const r = await call<CourseV & { chatId?: string; created?: boolean; course?: CourseV }>(`/api/courses/${courseId}`, body); return r; }
		catch (e) { setError((e as Error).message); return null; }
		finally { setBusy(null); }
	}, [courseId]);
	const start = useCallback(async (lessonId: string) => {
		const r = await act({ action: "start", lessonId }, "start:" + lessonId);
		if (!r?.chatId) return;
		const l = r.course?.units.flatMap((u) => u.lessons).find((x) => x.id === lessonId);
		router.push(`/chat/${r.chatId}` + (r.created ? `?prompt=${encodeURIComponent(`Let’s start lesson ${l ? `${l.n}: ${l.title}` : ""}.`)}` : ""));
	}, [act, router]);
	if (error && !v) return <p className="p-10 text-sm text-destructive">{error}</p>;
	if (!v) return <p className="p-10 text-sm text-muted-foreground">Opening the course…</p>;
	const draft = v.status === "draft";
	return (
		<div className="mx-auto w-full max-w-3xl px-6 py-10" data-testid="course-page">
			<h1 className="text-2xl font-semibold">{v.title}</h1>
			<p className="mt-1 text-sm text-muted-foreground">{v.goal}{v.level ? ` · starting from: ${v.level}` : ""}</p>
			<p className="mt-3 text-sm">{v.done} of {v.total} lessons done</p>
			{draft && (
				<div className="mt-5 rounded-lg border p-4">
					<p className="text-sm"><b>A draft roadmap.</b> Approve it, or say what to change and it is redrawn.</p>
					<Textarea className="mt-3" rows={2} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. skip the maths refresher; more on attention" />
					<div className="mt-3 flex gap-2">
						<Button variant="outline" disabled={!!busy || !request.trim()} onClick={async () => { const r = await act({ action: "redraw", request }, "redraw"); if (r) { setV(r); setRequest(""); } }}>{busy === "redraw" ? "Redrawing… (a minute)" : "Redraw"}</Button>
						<Button disabled={!!busy} onClick={async () => { const r = await act({ action: "approve" }, "approve"); if (r) setV(r); }}>Approve</Button>
					</div>
				</div>
			)}
			{v.next && !draft && (
				<div className="mt-5">
					<Button size="lg" data-testid="course-continue" disabled={!!busy} onClick={() => void start(v.next!.id)}>
						{v.next.state === "in-progress" ? "Continue" : "Start"}: Lesson {v.next.n} · {v.next.title} · {v.next.minutes} min
					</Button>
					{v.nextSuggestedAt && v.next.state === "next" && <p className="mt-2 text-xs text-muted-foreground">You finished a lesson today — the next is for tomorrow, so today’s sinks in. It can start now anyway.</p>}
				</div>
			)}
			{error && <p className="mt-3 text-sm text-destructive">{error}</p>}
			{v.units.map((u) => (
				<section key={u.id} className="mt-8">
					<h2 className="text-xs uppercase tracking-widest text-muted-foreground">{u.title}</h2>
					{u.why && <p className="mt-1 text-xs italic text-muted-foreground">{u.why}</p>}
					<div className="mt-2 flex flex-col gap-1.5">
						{u.lessons.map((l) => {
							const chat = l.chatId;
							return (
								<div key={l.id} className={`rounded-lg border ${l.state === "next" || l.state === "in-progress" ? "border-foreground" : ""}`}>
									<button type="button" className="flex w-full flex-col items-start px-3 py-2 text-left" onClick={() => setOpen(open === l.id ? null : l.id)} data-testid={`lesson-${l.id}`}>
										<span className="text-sm font-medium">{MARK[l.state]} Lesson {l.n} · {l.title}</span>
										<span className="text-xs text-muted-foreground">{[l.kind === "checkpoint" ? "checkpoint" : "", `${l.minutes} min`, WORD[l.state], l.progress?.steps ? `${l.progress.confirmed} of ${l.progress.steps} steps confirmed` : ""].filter(Boolean).join(" · ")}</span>
									</button>
									{open === l.id && (
										<div className="border-t px-3 py-2 text-sm">
											<p className="text-xs text-muted-foreground">By the end you can:</p>
											<ul className="ml-5 list-disc">{l.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
											{l.steps.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Steps: {l.steps.join(" → ")}</p>}
											<div className="mt-2 flex flex-wrap gap-2">
												{chat && <Button size="sm" onClick={() => router.push(`/chat/${chat}`)}>Open the lesson</Button>}
												{l.adopted && <Button size="sm" variant="outline" onClick={() => router.push(`/chat/${l.adopted!.chatId}`)}>The earlier session</Button>}
												{!chat && !draft && l.state !== "skipped" && <Button size="sm" variant={l.state === "next" ? "default" : "outline"} disabled={!!busy} onClick={() => void start(l.id)}>{l.state === "locked" ? "Start anyway" : "Start"}</Button>}
												{!chat && !draft && <Button size="sm" variant="outline" disabled={!!busy} onClick={async () => { const r = await act({ action: l.state === "skipped" ? "unskip" : "skip", lessonId: l.id }, "skip"); if (r) setV(r); }}>{l.state === "skipped" ? "Not known after all" : "Skip — I know this"}</Button>}
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</section>
			))}
			<div className="mt-8 flex flex-wrap items-center gap-3">
				<a className="text-sm underline" href={`/api/courses/${v.id}/notes`} target="_blank" rel="noreferrer">All the notes as one Markdown file</a>
				{!draft && <Button variant="outline" size="sm" onClick={() => setChanging(!changing)}>Change the roadmap…</Button>}
			</div>
			{changing && (
				<div className="mt-3">
					<Textarea rows={2} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="What should change? Done lessons stay." />
					<Button className="mt-2" disabled={!!busy || !request.trim()} onClick={async () => { const r = await act({ action: "redraw", request }, "redraw"); if (r) { setV(r); setRequest(""); setChanging(false); } }}>{busy === "redraw" ? "Redrawing… (a minute)" : "Redraw the rest"}</Button>
				</div>
			)}
		</div>
	);
}
