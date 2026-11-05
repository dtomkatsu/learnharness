import { CourseView } from "@/components/course-view";

export const dynamic = "force-dynamic";

/** A course: its roadmap of lessons, Start / Continue, approve or redraw (components/course-view.tsx). */
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <CourseView courseId={id} />;
}
