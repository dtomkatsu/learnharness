import { VoiceReview } from "@/components/voice-review";

/**
 * Hands-free review (2026-11): the due cards read aloud and answered out
 * loud, for a phone. ?deck=<deck> reviews one deck's words; ?stt=browser
 * skips Deepgram for the browser's own recognizer.
 */
export default async function VoicePage({ searchParams }: { searchParams: Promise<{ deck?: string; stt?: string }> }) {
	const { deck, stt } = await searchParams;
	return <VoiceReview deck={deck || undefined} engine={stt === "browser" ? "browser" : undefined} />;
}
