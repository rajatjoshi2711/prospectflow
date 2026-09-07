"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type ChannelPartnerFormValues = {
  id?: string;
  name: string;
  industry: string | null;
  criteria: string | null;
};

/**
 * Create/edit form for a channel partner definition.
 *
 * Same contract as `IcpForm`: the API re-validates everything and enforces
 * admin-ness, so this form is convenience only.
 */
export function ChannelPartnerForm({
  initial,
  mode,
}: {
  initial?: ChannelPartnerFormValues;
  mode: "create" | "edit";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(initial?.name ?? "");
  const [industry, setIndustry] = useState(initial?.industry ?? "");
  const [criteria, setCriteria] = useState(initial?.criteria ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!name.trim()) {
      setError("Give the channel partner a name.");
      return;
    }
    if (!industry.trim() && !criteria.trim()) {
      setError("Add an industry or matching criteria — there is nothing to match on otherwise.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        mode === "create"
          ? "/api/admin/channel-partners"
          : `/api/admin/channel-partners/${initial?.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            industry: industry.trim() || null,
            criteria: criteria.trim() || null,
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error ?? "Could not save this channel partner.");
        return;
      }
      if (data?.rescoreQueued === false) {
        // Saved, but scoring is not running — keep the admin here so they see it.
        setNotice(
          "Saved, but the re-scoring job could not be queued. Matches will refresh after the next import.",
        );
        router.refresh();
        return;
      }
      startTransition(() => {
        router.push("/admin/channel-partners");
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
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/channel-partners/${initial.id}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error ?? "Could not delete this channel partner.");
        return;
      }
      startTransition(() => {
        router.push("/admin/channel-partners");
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
        <label className="ef-label" htmlFor="cp-name">
          Name
        </label>
        <input
          id="cp-name"
          className="ef-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Systems integrators"
          maxLength={120}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="cp-industry">
          Industry
        </label>
        <input
          id="cp-industry"
          className="ef-input"
          value={industry}
          onChange={(event) => setIndustry(event.target.value)}
          placeholder="IT services"
          maxLength={120}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="cp-criteria">
          Matching criteria
        </label>
        <textarea
          id="cp-criteria"
          className="ef-input"
          rows={6}
          value={criteria}
          onChange={(event) => setCriteria(event.target.value)}
          placeholder="What makes someone a good channel partner: the kind of firm, the roles worth talking to, the work they already do."
          maxLength={2000}
        />
        <p className="ef-caption mt-1">
          The model reads this verbatim when scoring, and the keyword pre-filter
          uses it to shortlist. Concrete nouns beat adjectives.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="ef-btn ef-btn-primary" disabled={disabled}>
          {disabled ? "Saving…" : mode === "create" ? "Create channel partner" : "Save changes"}
        </button>
        {mode === "edit" ? (
          <button type="button" className="ef-btn ef-btn-danger" disabled={disabled} onClick={remove}>
            {confirmDelete ? "Confirm delete" : "Delete channel partner"}
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
      </div>
    </form>
  );
}
