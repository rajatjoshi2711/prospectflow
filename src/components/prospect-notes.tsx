"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProspectNoteView } from "@/lib/prospects/detail";

/**
 * The org-visible notes box on the prospect page.
 *
 * Notes are shared, so every one carries its author and timestamp — an
 * unattributed observation on a shared surface is unusable, because the reader
 * cannot ask a follow-up question or weigh who said it.
 *
 * `canDelete` only decides whether the button is rendered. The rule it mirrors
 * is enforced in `DELETE /api/prospects/notes/[id]`, whose WHERE clause carries
 * both the org and the author scope.
 *
 * Writes are NOT optimistic, unlike the mark buttons: a note is a paragraph a
 * person typed, and showing it as saved before the server accepted it risks
 * them navigating away having lost it. The composer stays disabled with a
 * "Saving…" label for the round trip, then `router.refresh()` re-reads the list
 * from the server so the author name and timestamp come from one source.
 */
export function ProspectNotes({
  identityKey,
  notes,
}: {
  identityKey: string;
  notes: ProspectNoteView[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function addNote(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || saving) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/prospects/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityKey, body }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(message?.error ?? "That note was not saved.");
      }
      setDraft("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That note was not saved.");
    } finally {
      setSaving(false);
    }
  }

  async function removeNote(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/prospects/notes/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("That note was not deleted.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That note was not deleted.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-2" onSubmit={addNote}>
        <label className="ef-label" htmlFor="prospect-note">
          Add a note
        </label>
        <textarea
          id="prospect-note"
          className="ef-input"
          rows={3}
          style={{ resize: "vertical" }}
          value={draft}
          maxLength={4000}
          disabled={saving}
          placeholder="What does the rest of the team need to know about them?"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="ef-btn ef-btn-primary"
            disabled={saving || draft.trim().length === 0}
          >
            {saving ? "Saving…" : "Add note"}
          </button>
          <span className="ef-caption">Everyone in your organization can read this.</span>
        </div>
        {error ? (
          <p className="ef-caption" style={{ color: "var(--danger)" }} role="alert">
            {error}
          </p>
        ) : null}
      </form>

      {notes.length === 0 ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          No notes on this person yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {notes.map((note) => (
            <li
              key={note.id}
              className="rounded-[10px] px-4 py-3"
              style={{ background: "var(--bg-subtle)" }}
            >
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className="ef-small" style={{ fontWeight: 600 }}>
                  {note.authorName}
                </span>
                <span className="ef-caption">
                  {note.createdAt.toLocaleString()}
                </span>
              </div>
              {/* Note bodies are user content and are rendered as text, never as
                  markup. `pre-wrap` keeps the author's line breaks. */}
              <p className="ef-small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {note.body}
              </p>
              {note.canDelete ? (
                <button
                  type="button"
                  className="ef-btn ef-btn-text mt-1"
                  style={{ padding: 0, color: "var(--danger)" }}
                  disabled={deletingId === note.id}
                  onClick={() => void removeNote(note.id)}
                >
                  {deletingId === note.id ? "Deleting…" : "Delete"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
