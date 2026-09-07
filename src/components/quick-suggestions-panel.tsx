"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Org-wide quick suggestions, with dismissal.
 *
 * Dismissal is persisted (`QuickSuggestion.dismissed`) rather than hidden in the
 * browser, because the regeneration job reads it: a dismissed suggestion is not
 * re-created by tonight's sweep. The row disappears optimistically and the
 * server component is refreshed behind it; a failed request puts it back and
 * says why, rather than leaving the reader thinking it stuck.
 */

export type QuickSuggestionView = {
  id: string;
  title: string;
  text: string;
  sourceUserName: string;
  personName: string | null;
  company: string | null;
  matchScore: number | null;
  relationshipScore: number | null;
  basis: "ai" | "heuristic";
};

export function QuickSuggestionsPanel({
  suggestions,
}: {
  suggestions: QuickSuggestionView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const visible = suggestions.filter((suggestion) => !dismissedIds.includes(suggestion.id));

  async function dismiss(id: string) {
    setError(null);
    setDismissedIds((current) => [...current, id]);
    try {
      const response = await fetch(`/api/quick-suggestions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissed: true }),
      });
      if (!response.ok) throw new Error("Request failed");
      startTransition(() => router.refresh());
    } catch {
      setDismissedIds((current) => current.filter((value) => value !== id));
      setError("Could not dismiss that suggestion. Try again.");
    }
  }

  if (visible.length === 0) {
    return (
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        Nothing left in the queue. New suggestions are generated after each import
        and refreshed overnight.
      </p>
    );
  }

  return (
    <div>
      {error ? (
        <p className="ef-small mb-3" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {visible.map((suggestion) => (
          <li
            key={suggestion.id}
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-card)",
              padding: 16,
              background: "var(--bg-subtle)",
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div style={{ minWidth: 0 }}>
                <p className="ef-subhead" style={{ margin: 0, fontWeight: 600 }}>
                  {suggestion.title}
                </p>
                <p className="ef-small mt-1" style={{ color: "var(--text-secondary)", margin: 0 }}>
                  {suggestion.text}
                </p>
              </div>
              <button
                type="button"
                className="ef-btn ef-btn-text"
                onClick={() => dismiss(suggestion.id)}
                disabled={pending}
                style={{ flexShrink: 0 }}
              >
                Dismiss
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="ef-badge ef-badge-neutral">{suggestion.sourceUserName}</span>
              {suggestion.company ? (
                <span className="ef-badge ef-badge-neutral">{suggestion.company}</span>
              ) : null}
              {suggestion.matchScore !== null ? (
                <span className="ef-badge ef-badge-info">Match {suggestion.matchScore}/100</span>
              ) : null}
              <span
                className={`ef-badge ${
                  suggestion.relationshipScore === null ? "ef-badge-neutral" : "ef-badge-success"
                }`}
              >
                {suggestion.relationshipScore === null
                  ? "Relationship not yet scored"
                  : `Relationship ${suggestion.relationshipScore}/100`}
              </span>
              {suggestion.basis === "heuristic" ? (
                <span className="ef-badge ef-badge-warning">Ranked without AI</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
