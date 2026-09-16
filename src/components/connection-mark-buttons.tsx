"use client";

import { useState } from "react";
import type { ConnectionMarkValue } from "@prisma/client";

/**
 * Thumbs up / thumbs down on one person, on the all-connections table.
 *
 * TOGGLE SEMANTICS
 * ----------------
 * Clicking the INACTIVE thumb switches the mark. Clicking the thumb that is
 * already active CLEARS it (the API deletes the row). A two-value control with
 * no third button has nowhere else to put "undo" — without this, a misclick is
 * permanent unless the user picks the opposite value, which would leave a
 * wrong opinion on record rather than none. The active thumb's tooltip says so
 * explicitly, since a clear-on-second-click is not guessable from the icons.
 *
 * The mark survives future imports: it is stored against the person's stable
 * `identityKey`, not against the per-batch `Connection.id` (see the
 * `ConnectionMark` note in the schema).
 *
 * Writes optimistically and rolls back if the API rejects the change, matching
 * the campaign lead status control — a mark the server did not accept must
 * never sit on screen looking saved.
 *
 * ACCESSIBILITY: the buttons are icon-only, so each carries an `aria-label`
 * and a `title`. Active state is carried by `aria-pressed` as well as colour,
 * so it is not conveyed by colour alone.
 */

function ThumbsUpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
      <path d="M7 11l4.5-8.5a2.5 2.5 0 0 1 4.7 1.6L15.5 9H20a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 18.8 20H7" />
    </svg>
  );
}

function ThumbsDownIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
      <path d="M17 13l-4.5 8.5a2.5 2.5 0 0 1-4.7-1.6L8.5 15H4a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 5.2 4H17" />
    </svg>
  );
}

export function ConnectionMarkButtons({
  identityKey,
  personName,
  initialValue,
}: {
  identityKey: string;
  personName: string;
  initialValue: ConnectionMarkValue | null;
}) {
  // Keyed off the server value on first render only. A re-render after
  // `router.refresh()` remounts the row with the saved value, so there is no
  // state to keep in sync.
  const [value, setValue] = useState<ConnectionMarkValue | null>(initialValue);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function apply(clicked: ConnectionMarkValue) {
    const next = value === clicked ? null : clicked;
    const previous = value;

    setValue(next);
    setSaving(true);
    setFailed(false);
    try {
      const res = await fetch("/api/connections/marks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityKey, value: next }),
      });
      if (!res.ok) throw new Error("rejected");
    } catch {
      setValue(previous);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <MarkButton
        active={value === "UP"}
        disabled={saving}
        activeColor="var(--green-600)"
        label={
          value === "UP"
            ? `Remove your thumbs up on ${personName}`
            : `Thumbs up ${personName}`
        }
        hint={value === "UP" ? "Click again to clear this mark" : undefined}
        onClick={() => void apply("UP")}
      >
        <ThumbsUpIcon />
      </MarkButton>
      <MarkButton
        active={value === "DOWN"}
        disabled={saving}
        activeColor="var(--danger)"
        label={
          value === "DOWN"
            ? `Remove your thumbs down on ${personName}`
            : `Thumbs down ${personName}`
        }
        hint={value === "DOWN" ? "Click again to clear this mark" : undefined}
        onClick={() => void apply("DOWN")}
      >
        <ThumbsDownIcon />
      </MarkButton>
      {failed ? (
        <span className="ef-caption" style={{ color: "var(--danger)" }} role="alert">
          Not saved
        </span>
      ) : null}
    </div>
  );
}

function MarkButton({
  active,
  disabled,
  activeColor,
  label,
  hint,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  activeColor: string;
  label: string;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={hint ? `${label} — ${hint}` : label}
      className="ef-btn ef-btn-text"
      style={{
        padding: 6,
        lineHeight: 0,
        // Filled when active, quiet when not: the mark has to be readable at a
        // glance down a column of 25 rows.
        color: active ? "#fff" : "var(--neutral-400)",
        background: active ? activeColor : "transparent",
        border: `1px solid ${active ? activeColor : "var(--border-subtle)"}`,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
