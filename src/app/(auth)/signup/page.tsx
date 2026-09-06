"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUpAction, type AuthFormState } from "@/lib/auth/actions";
import { SubmitButton } from "@/components/submit-button";

export default function SignupPage() {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    signUpAction,
    null,
  );

  return (
    <div>
      <h1 className="ef-h3 mb-1">Create your account</h1>
      <p className="ef-small mb-6" style={{ color: "var(--text-secondary)" }}>
        First person from your company joins as admin. Everyone after joins as
        a member automatically.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <div>
          <label htmlFor="name" className="ef-label">
            Full name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            className="ef-input"
            placeholder="Jane Doe"
          />
        </div>
        <div>
          <label htmlFor="email" className="ef-label">
            Work email
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
            autoComplete="new-password"
            required
            minLength={8}
            className="ef-input"
            placeholder="At least 8 characters"
          />
        </div>

        {state?.error ? (
          <p className="ef-small" style={{ color: "var(--danger)" }}>
            {state.error}
          </p>
        ) : null}

        <SubmitButton>Create account</SubmitButton>
      </form>

      <p className="ef-small mt-6 text-center" style={{ color: "var(--text-secondary)" }}>
        Already have an account?{" "}
        <Link href="/login" className="ef-btn-text" style={{ padding: 0 }}>
          Log in
        </Link>
      </p>
    </div>
  );
}
