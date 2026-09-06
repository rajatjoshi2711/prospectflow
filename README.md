# ProspectFlow

An internal tool that turns every employee's LinkedIn network into a shared,
queryable asset: ICP/channel-partner matching, job-change alerts, campaign
tracking, and an AI chat assistant over the whole dataset.

This repository currently implements **Phase 1 — Foundation**: auth,
org-by-email-domain bootstrap, the full database schema, the base app shell
styled with the EmergeFlow Design System, and admin user management. Later
phases (ingestion, dashboards, ICP/channel-partner matching, campaigns, AI
depth) build on top of this.

## Stack

- Next.js (App Router) + TypeScript
- Prisma + Postgres
- Tailwind CSS v4, styled with the EmergeFlow Design System tokens
- Auth: email/password, custom session (signed JWT in an httpOnly cookie via
  [`jose`](https://github.com/panva/jose)), passwords hashed with `bcryptjs`

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required in Phase 1? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. Any Postgres works (local, Neon, Supabase, Vercel Postgres, etc.). |
| `AUTH_SECRET` | Yes | Random string used to sign session JWTs. Generate with `openssl rand -base64 32`. |
| `GROQ_API_KEY` | No — Phase 6 | Not read by any code yet. |
| `BLOB_READ_WRITE_TOKEN` | No — Phase 2 | Not read by any code yet. |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | No — Phase 2 | Not read by any code yet. |

### 3. Set up the database

Once `DATABASE_URL` points at a live Postgres instance:

```bash
npm run prisma:migrate   # applies prisma/migrations, or creates a new one if the schema changed
npm run prisma:generate  # regenerates the Prisma client (also runs automatically via postinstall)
```

The initial migration (`prisma/migrations/*_init`) was generated offline
(`prisma migrate diff --from-empty`) against the schema in this repo, since no
live database was available at build time. Running `npm run prisma:migrate`
against a real database will apply it (or, if Prisma decides the migration
history doesn't match, will prompt you to reset the dev database — safe to do
since there's no data yet).

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/login`.

### 5. Try it out

1. Go to `/signup` and create an account with a work email, e.g.
   `alice@acme.com`. Since no organization exists yet for `acme.com`, one is
   created and Alice becomes its `ADMIN`.
2. Sign up a second user with the same domain, e.g. `bob@acme.com`. Bob joins
   the existing `acme.com` organization as a `MEMBER`.
3. Log in as Alice and visit `/admin/users` to promote/demote org members.
   `/admin/*` redirects non-admins back to `/dashboard`.

## How auth works

- `src/lib/auth/password.ts` — bcrypt hashing/verification.
- `src/lib/auth/org.ts` — derives the email domain and finds-or-creates the
  `Organization` for it.
- `src/lib/auth/actions.ts` — server actions (`signUpAction`, `logInAction`,
  `logOutAction`) used directly by the `/signup` and `/login` forms. Signup
  runs the "find-or-create org, decide role" logic inside a single Prisma
  transaction so two simultaneous first-signups from the same domain can't
  both become admin of two different orgs.
- `src/lib/auth/session.ts` — signs/verifies a JWT (via `jose`) containing
  `{ userId, organizationId, role, email, name }` and stores it in an
  httpOnly, `SameSite=Lax` cookie.
- `src/middleware.ts` — runs on every request except `/api/*` and static
  assets. Redirects unauthenticated requests to `/login`, redirects
  authenticated users away from `/login` and `/signup`, and redirects
  non-admins away from `/admin/*`.
- `src/app/(app)/layout.tsx` re-checks the session server-side (defense in
  depth) before rendering the nav shell.

## Project structure

```
prisma/schema.prisma          full data model (see below)
prisma/migrations/            offline-generated initial migration
src/middleware.ts             route guarding (auth + admin role)
src/lib/prisma.ts             Prisma client singleton
src/lib/auth/                 session, password hashing, org bootstrap, server actions
src/app/(auth)/login          /login
src/app/(auth)/signup         /signup
src/app/(app)/layout.tsx      authenticated nav shell
src/app/(app)/dashboard       user dashboard (placeholder)
src/app/(app)/org             org dashboard (placeholder)
src/app/(app)/icps            all-ICPs dashboard (placeholder)
src/app/(app)/channel-partners
src/app/(app)/connections
src/app/(app)/campaigns(+/new, +/[id])
src/app/(app)/imports
src/app/(app)/prospect-ask
src/app/(app)/admin/users     fully functional: list org users, promote/demote
src/app/(app)/admin/icps(+[id])         placeholder, admin-gated
src/app/(app)/admin/channel-partners(+[id]) placeholder, admin-gated
src/app/api/admin/users/[id]/role/route.ts  PATCH — change a user's role
```

## Data model

`prisma/schema.prisma` includes the full model set from the build plan
(`Organization`, `User`, `ImportBatch`, `Connection`, `Position`,
`Invitation`, `MessageRecord`, `RawCsvRow`, `JobChangeEvent`, `ICP`,
`ChannelPartner`, `ProspectMatch`, `Campaign`, `CampaignLead`,
`RelationshipStrengthScore`, `QuickSuggestion`, `ChatMessage`) even though
only the `Organization`/`User` pieces are wired up to application code in
this phase. This lets later phases build against a stable, already-migrated
schema instead of bolting models on incrementally.

## Design system

All UI uses the EmergeFlow Design System (Sora for display type, Manrope for
body/UI, the EmergeFlow blue/green/neutral palette, standard radii/shadows).
Tokens live as CSS custom properties in `src/app/globals.css`, plus small
utility classes (`ef-btn`, `ef-card`, `ef-badge`, `ef-input`, etc.) mirroring
the design system's own reference CSS.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Start the production server (after `build`) |
| `npm run lint` | ESLint |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run prisma:migrate` | Run `prisma migrate dev` against `DATABASE_URL` |

## What's not in this phase

Ingestion (zip upload, Inngest, CSV parsing), dashboards backed by real data,
ICP/channel-partner CRUD and matching, campaigns, relationship-strength
scoring, quick suggestions, and ProspectAsk are all out of scope for Phase 1.
Their routes exist as styled "Coming soon" placeholders so navigation and
the route structure are already in place for later phases.
