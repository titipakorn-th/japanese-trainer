import { notFound } from "next/navigation";
import { SessionView } from "@/client/SessionView";
import { getSessionState } from "@/server/sessions";

/**
 * The session is rendered from server-side state on every load, so a reload
 * mid-session resumes the conversation rather than losing it.
 */
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = getSessionState(id);
  if (!state) notFound();

  return <SessionView initial={state} />;
}
