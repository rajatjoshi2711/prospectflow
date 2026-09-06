"use client";

import { useActionState } from "react";
import Link from "next/link";
import { logInAction, type AuthFormState } from "@/lib/auth/actions";
import { SubmitButton } from "@/components/submit-button";

export default function LoginPage() {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    logInAction,
    null,
  );

  return (
    <div>
      <h1 className="ef-h3 mb-1">Welcome back</h1>
      <p className="ef-small mb-6" style={{ color: "var(--text-secondary)" }}>
        Log in to your ProspectFlow account.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <div>
          <label htmlFor="email" className="ef-label">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="ef-input"
            placeholder="you@company.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="ef-label">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="ef-input"
            placeholder="••••••••"
          />
        </div>

        {state?.error ? (
          <p className="ef-small" style={{ color: "var(--danger)" }}>
            {state.error}
          </p>
        ) : null}

        <SubmitButton>Log in</SubmitButton>
      </form>

      <p className="ef-small mt-6 text-center" style={{ color: "var(--text-secondary)" }}>
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="ef-btn-text" style={{ padding: 0 }}>
          Sign up
        </Link>
      </p>
    </div>
  );
}
