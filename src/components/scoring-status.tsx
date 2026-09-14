"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Relationship-scoring status, plus the "re-score now" control (Phase 7).
 *
 * TWO JOBS, ONE COMPONENT, on purpose: the answer to "why is this column
 * empty?" and the button that does something about it belong in the same place.
 * Splitting them produced a status line with no action and a button with no
 * feedback, which is what Phase 6 shipped.
 *
 * It polls `/api/relationship/recompute` only while a run is in flight, and
 * stops as soon as the run reports back — no background timer on an idle page.
 * When the run finishes it refreshes the server component behind it, so the
 * scores appear without the reader having to reload.
 *
 * HONESTY: `ready` with zero scores is stated as exactly that — a finished run
 * that found no interaction data — never as "no scores yet", which would imply
 * more waiting would help.
 */

export type ScoringStatus = "no-import" | "running" | "stalled" | "ready" | "never-run";

const POLL_INTERVAL_MS = 5_000;

type Copy = { badge: string; badgeClass: string; line: string };

function describe(status: ScoringStatus, scoredCount: number): Copy {
  switch (status) {
    case "no-import":
      return {
        badge: "No data",
        badgeClass: "ef-badge-neutral",
        line: "Upload a LinkedIn export and relationship scoring runs automatically.",
      };
    case "running":
      return {
        badge: "Scoring",
        badgeClass: "ef-badge-warning",
        line: "Relationship scoring is running in the background. Scores appear here as soon as it finishes.",
      };
    case "stalled":
      return {
        badge: "Taking longer than expected",
        badgeClass: "ef-badge-danger",
        line: "Relationship scoring was requested a while ago and has not reported back. Try running it again; if it keeps happening, the AI provider may be unavailable.",
      };
    case "ready":
      return scoredCount > 0
        ? {
            badge: "Up to date",
            badgeClass: "ef-badge-success",
            line: `${scoredCount.toLocaleString()} relationship${scoredCount === 1 ? "" : "s"} scored from your latest import.`,
          }
        : {
            badge: "Nothing to score",
            badgeClass: "ef-badge-neutral",
            line: "Scoring finished, but your export carried no messages or invitation notes, so there is nothing to score a relationship from. This is a gap in the data, not a weak network.",
          };
    case "never-run":
    default:
      return {
        badge: "Not run yet",
        badgeClass: "ef-badge-neutral",
        line: "Relationship scoring has not run against this import yet. It runs after each import and overnight, or you can start it now.",
      };
  }
}

export function ScoringStatusCard({
  initialStatus,
  initialScoredCount,
  canRescoreOrg = false,
}: {
  initialStatus: ScoringStatus;
  initialScoredCount: number;
  /** Admins get the org-wide variant alongside the personal one. */
  canRescoreOrg?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ScoringStatus>(initialStatus);
  const [scoredCount, setScoredCount] = useState(initialScoredCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Whether the last poll saw a run in flight, so we know a transition to
  // "ready" is worth refreshing the page for.
  const wasRunning = useRef(initialStatus === "running");

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/relationship/recompute", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { status: ScoringStatus; scoredCount: number };
      setStatus(data.status);
      setScoredCount(data.scoredCount);
      if (wasRunning.current && data.status !== "running") {
        wasRunning.current = false;
        router.refresh();
      }
      if (data.status === "running") wasRunning.current = true;
    } catch {
      // Transient. The next tick retries; a dropped poll must not replace a
      // correct status with an error.
    }
  }, [router]);

  useEffect(() => {
    if (status !== "running") return;
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [status, poll]);

  async function rescore(scope: "self" | "org") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/relationship/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "That did not work.");
      setStatus("running");
      wasRunning.current = true;
      setNotice(
        scope === "org"
          ? "Re-scoring every member. This runs in the background and can take a few minutes."
          : "Re-scoring started. This runs in the background.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const copy = describe(status, scoredCount);
  const canRun = status !== "no-import" && status !== "running";

  return (
    <section className="ef-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div style={{ minWidth: 0 }}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="ef-subhead" style={{ margin: 0 }}>
              Relationship scoring
            </p>
            <span className={`ef-badge ${copy.badgeClass}`}>
              {status === "running" ? <span aria-hidden className="ef-dot" /> : null}
              {copy.badge}
            </span>
          </div>
          <p className="ef-small" style={{ color: "var(--text-secondary)", margin: 0 }}>
            {copy.line}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="ef-btn ef-btn-secondary"
            onClick={() => void rescore("self")}
            disabled={busy || !canRun}
          >
            {status === "running" ? "Scoring…" : busy ? "Starting…" : "Re-score now"}
          </button>
          {canRescoreOrg ? (
            <button
              type="button"
              className="ef-btn ef-btn-text"
              onClick={() => void rescore("org")}
              disabled={busy || status === "running"}
            >
              Re-score whole organization
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p className="ef-caption mt-3" style={{ color: "var(--blue-500)" }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="ef-small mt-3" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
