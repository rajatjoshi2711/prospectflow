# ProspectFlow

An internal tool that turns every employee's LinkedIn network into a shared,
queryable asset: ICP/channel-partner matching, job-change alerts, campaign
tracking, and an AI chat assistant over the whole dataset.

This repository currently implements **Phase 1 — Foundation** and
**Phase 2 — Ingestion**: auth, org-by-email-domain bootstrap, the full
database schema, the base app shell styled with the EmergeFlow Design
System, admin user management, and the LinkedIn export ingestion pipeline
(direct-to-blob zip upload, background CSV processing via Inngest, and an
imports page with version history). Later phases (diffing-driven
dashboards, ICP/channel-partner matching, campaigns, AI depth) build on top
of this.

## Stack

- Next.js (App Router) + TypeScript
- Prisma + Postgres
- Tailwind CSS v4, styled with the EmergeFlow Design System tokens
- Auth: email/password, custom session (signed JWT in an httpOnly cookie via
  [`jose`](https://github.com/panva/jose)), passwords hashed with `bcryptjs`
- Ingestion: direct-to-blob upload via [`@vercel/blob`](https://vercel.com/docs/storage/vercel-blob),
  background processing via [Inngest](https://www.inngest.com/), zip
  streaming via `unzipper`, CSV parsing via `papaparse`

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

| Variable | Required in | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Phase 1 | Postgres connection string. Any Postgres works (local, Neon, Supabase, Vercel Postgres, etc.). |
| `AUTH_SECRET` | Phase 1 | Random string used to sign session JWTs. Generate with `openssl rand -base64 32`. |
| `BLOB_READ_WRITE_TOKEN` | Phase 2 | Vercel Blob read/write token. See "Getting a `BLOB_READ_WRITE_TOKEN`" below. |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | Phase 2 (prod only) | Not needed for local dev against `inngest-cli dev`; required once deployed so Inngest's cloud can reach your app. |
| `GROQ_API_KEY` | No — Phase 6 | Not read by any code yet. |

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

## How ingestion works

1. **Upload.** On `/imports`, the user picks (or drops) a `.zip` file. The
   client calls `upload()` from `@vercel/blob/client`, which uploads the
   file directly to Vercel Blob (bypassing the serverless request body-size
   limit) after getting a signed token from
   `src/app/api/uploads/blob-token/route.ts`.
2. **Authorization (`onBeforeGenerateToken`).** That route uses
   `handleUpload` from `@vercel/blob/client` (server side). Before minting
   an upload token it reads the real session from cookies
   (`getSession()`), rejects anything not ending in `.zip`, caps the size at
   50MB, and embeds `{ userId, organizationId }` from the *verified session*
   as `tokenPayload` — the client never gets to assert its own identity.
3. **`ImportBatch` creation (`onUploadCompleted`).** Once the blob actually
   exists, Vercel calls this callback server-side (it fires even if the
   uploading browser tab has since closed). It decodes the `tokenPayload`,
   re-checks the user/org still match, creates an `ImportBatch` row
   (`status: PENDING`, `blobUrl` set), and sends an `import/batch.created`
   event to Inngest.
4. **Background processing (`src/inngest/functions/process-import.ts`).**
   An Inngest step function: marks the batch `PROCESSING`, downloads the
   zip from Blob, streams it open with `unzipper`, and for each `.csv` entry
   (matched case-insensitively — `Connections.csv`, `Positions.csv`,
   `Invitations.csv`, `messages.csv`, or anything under a `Messages/`
   folder) parses it in streaming mode with `papaparse` and batch-inserts
   rows via `prisma.createMany` in chunks of 500. Every person gets an
   `identityKey` — normalized `linkedinUrl` if present, else
   `sha256(lower(firstName+lastName+company))` (see
   `src/lib/ingestion/identity-key.ts`) — so the same person can be matched
   across CSVs and across batches. Any CSV that isn't one of the known
   files lands in `RawCsvRow` (`sourceFilename` + `rowData: Json`) so
   nothing is silently dropped. On success the batch is marked `COMPLETE`
   with a `fileCount` and `completedAt`, and `User.lastImportAt` is
   updated; on failure it's marked `FAILED` with `errorMessage` and the
   error is rethrown so Inngest applies its retry policy.
5. **Job-change diffing.** Still inside the same function, once a batch
   completes, it compares the two most recent `COMPLETE` batches for that
   user by `identityKey` + current `(title, company)` from `Position` rows,
   and writes a `JobChangeEvent` for every real change. A person who only
   appears in the newer batch (no prior position on record) is not treated
   as a change. Relationship-strength recompute and quick-suggestion
   regeneration are left as `TODO` comments in `process-import.ts` — they
   land in Phase 6.
6. **Imports page.** `src/app/(app)/imports/page.tsx` (server component)
   loads the user's batches; `src/components/imports-manager.tsx` (client)
   handles the drag/drop upload and polls `GET /api/imports` every 4s while
   any batch is `PENDING`/`PROCESSING`, so status transitions show up
   without a full page reload. A completed batch with `JobChangeEvent` rows
   shows an "N job changes detected" badge.

### Running Inngest locally

Inngest needs a dev server that talks to your Next.js app's
`/api/inngest` endpoint:

```bash
npx inngest-cli@latest dev
```

By default it looks for your app at `http://localhost:3000/api/inngest`
(matching `npm run dev`). Open the Inngest dev UI it prints (typically
`http://localhost:8288`) to watch runs, inspect each step, and see
failures/retries for `process-import`. No `INNGEST_EVENT_KEY` /
`INNGEST_SIGNING_KEY` are needed for this local flow — those only matter
once you deploy and Inngest's cloud needs to authenticate with your app.

### Getting a `BLOB_READ_WRITE_TOKEN`

1. In the [Vercel dashboard](https://vercel.com/dashboard), open (or create)
   the project this repo deploys as.
2. Go to **Storage → Create Database → Blob**, create a store, and connect
   it to the project.
3. Vercel adds `BLOB_READ_WRITE_TOKEN` to the project's environment
   variables automatically. For local dev, either run `vercel env pull` in
   a linked project, or copy the token from the store's dashboard into your
   local `.env`.

### Testing the full upload flow locally

No live LinkedIn export is needed to exercise the pipeline — a zip with the
right filenames is enough:

1. Create a small test export, e.g.:
   ```
   Connections.csv   (headers: First Name,Last Name,URL,Email Address,Company,Position,Connected On)
   Positions.csv     (headers: First Name,Last Name,Company Name,Title,Location,Started On,Finished On)
   Invitations.csv   (headers: From,To,Direction,Sent At,Message)
   messages.csv      (headers: Conversation ID,From,To,Date,Content)
   something-else.csv  (any other headers — this should land in RawCsvRow)
   ```
   Zip these into e.g. `test-export.zip`. There's no fixture checked into
   this repo yet (`test-fixtures/` is a reasonable place to add one if you
   build it, e.g. a small script that writes the CSVs above and zips them).
2. With `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` set, `npm run dev` running,
   and `npx inngest-cli@latest dev` running in another terminal, log in and
   go to `/imports`.
3. Upload `test-export.zip`. Watch the version history row go
   `Pending` → `Processing` → `Complete` (the page polls automatically).
4. Check the Inngest dev UI for the `process-import` run and its steps, and
   query the database (e.g. `npx prisma studio`) to confirm rows landed in
   `Connection`, `Position`, `Invitation`, `MessageRecord`, and
   `RawCsvRow`.
5. Upload the same zip a second time (optionally with a changed title/
   company in `Positions.csv`) and confirm a second `ImportBatch` is
   created (never overwriting the first) and, if a tracked person's title
   or company changed, a `JobChangeEvent` row appears and the "N job
   changes detected" badge shows on the newer batch.

## Project structure

```
prisma/schema.prisma          full data model (see below)
prisma/migrations/            offline-generated migrations
src/middleware.ts             route guarding (auth + admin role)
src/lib/prisma.ts             Prisma client singleton
src/lib/auth/                 session, password hashing, org bootstrap, server actions
src/lib/ingestion/identity-key.ts  identityKey computation (LinkedIn URL or name+company hash)
src/inngest/client.ts         Inngest client instance + event types
src/inngest/functions/process-import.ts  unzip, parse, ingest, diff job changes
src/app/(auth)/login          /login
src/app/(auth)/signup         /signup
src/app/(app)/layout.tsx      authenticated nav shell
src/app/(app)/dashboard       user dashboard (placeholder)
src/app/(app)/org             org dashboard (placeholder)
src/app/(app)/icps            all-ICPs dashboard (placeholder)
src/app/(app)/channel-partners
src/app/(app)/connections
src/app/(app)/campaigns(+/new, +/[id])
src/app/(app)/imports         fully functional: upload zip, version history
src/app/(app)/prospect-ask
src/app/(app)/admin/users     fully functional: list org users, promote/demote
src/app/(app)/admin/icps(+[id])         placeholder, admin-gated
src/app/(app)/admin/channel-partners(+[id]) placeholder, admin-gated
src/app/api/admin/users/[id]/role/route.ts  PATCH — change a user's role
src/app/api/uploads/blob-token/route.ts     Vercel Blob client-upload authorization
src/app/api/imports/route.ts                GET — current user's import batches (polling)
src/app/api/inngest/route.ts                Inngest serve handler
src/components/imports-manager.tsx          upload form + version history table (client)
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

Dashboards backed by real data (beyond the imports page itself),
ICP/channel-partner CRUD and matching, campaigns, relationship-strength
scoring, quick suggestions, and ProspectAsk are all out of scope for Phases
1–2. Their routes exist as styled "Coming soon" placeholders so navigation
and the route structure are already in place for later phases. Job-change
diffing (Phase 3's core feature) is implemented as part of the ingestion
pipeline since it's a natural chained step after each import, but the
dashboard/UI that surfaces those alerts is not built yet.
