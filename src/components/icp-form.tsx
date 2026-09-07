"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { COUNTRIES } from "@/lib/matching/countries";

export type IcpFormValues = {
  id?: string;
  name: string;
  country: string | null;
  industry: string | null;
  positions: string[];
  description: string | null;
};

/**
 * Create/edit form for an ICP.
 *
 * Positions are entered as chips because `ICP.positions` is a `String[]` and
 * the pre-filter matches each entry as its own phrase — a single comma-jammed
 * string would match nothing.
 *
 * The server is the authority on validation and on admin-ness; this form only
 * prevents the obvious mistakes so the round trip is not wasted.
 */
export function IcpForm({
  initial,
  mode,
}: {
  initial?: IcpFormValues;
  mode: "create" | "edit";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(initial?.name ?? "");
  const [country, setCountry] = useState(initial?.country ?? "");
  const [industry, setIndustry] = useState(initial?.industry ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [positions, setPositions] = useState<string[]>(initial?.positions ?? []);
  const [positionDraft, setPositionDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function addPosition() {
    const value = positionDraft.trim();
    if (!value) return;
    if (positions.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
      setPositionDraft("");
      return;
    }
    setPositions([...positions, value]);
    setPositionDraft("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    // A position typed but not yet added is almost certainly meant to count.
    const finalPositions = positionDraft.trim()
      ? [...positions, positionDraft.trim()]
      : positions;

    if (!name.trim()) {
      setError("Give the ICP a name so people can tell it apart on the dashboard.");
      return;
    }
    if (finalPositions.length === 0 && !industry.trim() && !description.trim()) {
      setError(
        "Add at least an industry, a position, or a description — matching has nothing to work from otherwise.",
      );
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        mode === "create" ? "/api/admin/icps" : `/api/admin/icps/${initial?.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            country: country || null,
            industry: industry.trim() || null,
            positions: finalPositions,
            description: description.trim() || null,
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error ?? "Could not save this ICP.");
        return;
      }
      if (data?.rescoreQueued === false) {
        // Saved, but scoring is not running. Stay put so the admin actually
        // reads that, rather than bouncing to a list that looks fine.
        setNotice(
          "Saved, but the re-scoring job could not be queued. Matches will refresh after the next import.",
        );
        router.refresh();
        return;
      }
      startTransition(() => {
        router.push("/admin/icps");
        router.refresh();
      });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial?.id) return;
    // Two-step, because deleting an ICP cascades away every match scored
    // against it.
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/icps/${initial.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error ?? "Could not delete this ICP.");
        return;
      }
      startTransition(() => {
        router.push("/admin/icps");
        router.refresh();
      });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || isPending;

  return (
    <form onSubmit={submit} className="ef-card flex flex-col gap-5" style={{ maxWidth: 680 }}>
      {error ? (
        <p
          className="ef-small rounded-[10px] px-4 py-3"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          className="ef-small rounded-[10px] px-4 py-3"
          style={{ background: "var(--warning-soft)", color: "var(--text-primary)" }}
        >
          {notice}
        </p>
      ) : null}

      <div>
        <label className="ef-label" htmlFor="icp-name">
          Name
        </label>
        <input
          id="icp-name"
          className="ef-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Mid-market ops leaders, DACH"
          maxLength={120}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="icp-country">
          Country
        </label>
        <select
          id="icp-country"
          className="ef-input"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
        >
          <option value="">Any country</option>
          {COUNTRIES.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <p className="ef-caption mt-1">
          Connections known to be somewhere else are excluded. Connections with no
          location in the export are still considered.
        </p>
      </div>

      <div>
        <label className="ef-label" htmlFor="icp-industry">
          Industry
        </label>
        <input
          id="icp-industry"
          className="ef-input"
          value={industry}
          onChange={(event) => setIndustry(event.target.value)}
          placeholder="Logistics"
          maxLength={120}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="icp-position">
          Positions
        </label>
        <div className="flex items-center gap-2">
          <input
            id="icp-position"
            className="ef-input"
            value={positionDraft}
            onChange={(event) => setPositionDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addPosition();
              }
            }}
            placeholder="Head of Operations"
            maxLength={120}
          />
          <button type="button" className="ef-btn ef-btn-secondary" onClick={addPosition}>
            Add
          </button>
        </div>
        {positions.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {positions.map((entry) => (
              <li key={entry}>
                <span className="ef-badge ef-badge-info inline-flex items-center gap-2">
                  {entry}
                  <button
                    type="button"
                    aria-label={`Remove ${entry}`}
                    onClick={() => setPositions(positions.filter((item) => item !== entry))}
                    style={{ cursor: "pointer", fontWeight: 700 }}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ef-caption mt-2">
            Add every title worth matching. Each one is matched on its own.
          </p>
        )}
      </div>

      <div>
        <label className="ef-label" htmlFor="icp-description">
          Description
        </label>
        <textarea
          id="icp-description"
          className="ef-input"
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Who is a good fit, and why. The model reads this when scoring, so be concrete."
          maxLength={2000}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="ef-btn ef-btn-primary" disabled={disabled}>
          {disabled ? "Saving…" : mode === "create" ? "Create ICP" : "Save changes"}
        </button>
        {mode === "edit" ? (
          <button type="button" className="ef-btn ef-btn-danger" disabled={disabled} onClick={remove}>
            {confirmDelete ? "Confirm delete" : "Delete ICP"}
          </button>
        ) : null}
        {confirmDelete ? (
          <button
            type="button"
            className="ef-btn ef-btn-text"
            onClick={() => setConfirmDelete(false)}
            disabled={disabled}
          >
            Cancel
          </button>
        ) : null}
        <p className="ef-caption">
          Saving re-scores every connection in the org against this definition.
        </p>
      </div>
    </form>
  );
}
