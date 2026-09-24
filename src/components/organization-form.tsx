"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type OrganizationFormValues = {
  name: string;
  emailDomain: string;
  website: string | null;
  industry: string | null;
  location: string | null;
  description: string | null;
};

/**
 * Edit form for the organization's own profile.
 *
 * There is no create mode and no delete: an org is brought into existence by
 * the first signup from a domain, and deleting it would cascade away every
 * member, import and campaign in it. This form only edits.
 *
 * The email domain is shown but not editable — see the API route for why.
 * Showing it read-only is deliberate rather than hiding it: an admin looking at
 * organization settings wants to confirm which domain joins this org, and a
 * field that is simply absent invites the question.
 */
export function OrganizationForm({ initial }: { initial: OrganizationFormValues }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [website, setWebsite] = useState(initial.website ?? "");
  const [industry, setIndustry] = useState(initial.industry ?? "");
  const [location, setLocation] = useState(initial.location ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!name.trim()) {
      setError(
        "The organization needs a name — it is shown in the sidebar and on every dashboard.",
      );
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/organization", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          website: website.trim() || null,
          industry: industry.trim() || null,
          location: location.trim() || null,
          description: description.trim() || null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data?.error ?? "Could not save these details.");
        return;
      }
      // The server normalizes the website ("emergeflow.com" becomes a real
      // URL), so echo the saved values back rather than leaving the box
      // showing what was typed.
      if (data?.organization) {
        setWebsite(data.organization.website ?? "");
      }
      // Stay on the page. This is a settings screen, not a wizard — there is
      // nowhere to go next, so confirm in place.
      setNotice("Saved.");
      // The org name is rendered by the app shell, so the whole layout has to
      // re-read it, not just this form.
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

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
          style={{ background: "var(--blue-50)", color: "var(--text-primary)" }}
          role="status"
        >
          {notice}
        </p>
      ) : null}

      <div>
        <label className="ef-label" htmlFor="org-name">
          Organization name
        </label>
        <input
          id="org-name"
          className="ef-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="EmergeFlow"
          maxLength={120}
        />
      </div>

      <div>
        <span className="ef-label">Email domain</span>
        <p
          className="ef-input"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--bg-subtle)",
            color: "var(--text-secondary)",
            margin: 0,
          }}
        >
          @{initial.emailDomain}
        </p>
        <p className="ef-caption mt-2">
          Anyone signing up with an address at this domain joins this
          organization automatically. It cannot be changed here: rerouting it
          would separate your existing members from future signups.
        </p>
      </div>

      <div>
        <label className="ef-label" htmlFor="org-website">
          Website
        </label>
        <input
          id="org-website"
          className="ef-input"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          placeholder="emergeflow.com"
          maxLength={200}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="org-industry">
          Industry
        </label>
        <input
          id="org-industry"
          className="ef-input"
          value={industry}
          onChange={(event) => setIndustry(event.target.value)}
          placeholder="Supply chain software"
          maxLength={120}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="org-location">
          Headquarters
        </label>
        <input
          id="org-location"
          className="ef-input"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="Pune, India"
          maxLength={160}
        />
      </div>

      <div>
        <label className="ef-label" htmlFor="org-description">
          What this organization does
        </label>
        <textarea
          id="org-description"
          className="ef-input"
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What you sell and who you sell it to. Be concrete — this is the context a new team member reads before writing their first outreach message."
          maxLength={2000}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="ef-btn ef-btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
