"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Starting a session is the whole of this screen: one button, and the scene it
 * drops you into. The scenario itself comes from the server, so the store is
 * never pulled into the browser.
 */
export function StartCard({ goal }: { goal: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { id } = (await response.json()) as { id: string };
      router.push(`/session/${id}`);
    } catch {
      setError("Could not start a session. Is the server running?");
      setStarting(false);
    }
  }

  return (
    <main className="start">
      <div className="start-card">
        <h1>Start a session</h1>
        <p>
          One scene, one partner, one goal. Stay in the conversation — the notes appear quietly
          underneath your turn, and never interrupt.
        </p>
        <p className="goal jp">{goal}</p>
        <button type="button" onClick={start} disabled={starting}>
          {starting ? "Opening…" : "Start"}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </main>
  );
}
