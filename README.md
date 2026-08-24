# Commonwax v0.0.1

Commonwax is a native web client for a shared Navidrome collection. Navidrome owns cataloging, artwork, scanning, streaming, and transcoding; Commonwax owns accounts, membership, permissions, invitations, attribution, requests, preferences, and activity.

This repository implements the v0.0.1 workflow: create a Library, upload an album, invite a friend, listen together, request missing music, claim and fulfill the request with an upload, and retain attribution and activity throughout.

## Deploy

The only host prerequisites are Docker Engine and Docker Compose.

```bash
cp .env.example .env
```

Change both passwords in `.env`, and set `PUBLIC_URL` to the URL friends will use. `PUBLIC_URL` must be reachable by invited users because it is used to generate invitation links.

```bash
docker compose up -d --build
```

Open `http://localhost:8080` (or the configured `WEB_PORT`). The first-run screen asks only for the Owner account and Library name. Commonwax automatically applies PostgreSQL migrations and internally provisions the Navidrome service account; Navidrome's UI and credentials are never exposed to invited users.

Named volumes hold all persistent state:

- `commonwax_postgres` — Commonwax accounts and social data
- `commonwax_navidrome` — Navidrome's database and cache
- `commonwax_music` — canonical, unmodified source audio
- `commonwax_staging` — temporary uploads

Back up the PostgreSQL, Navidrome, and music volumes together. Do not expose the Navidrome container port publicly; Commonwax proxies authenticated streams and artwork.

## What is implemented

- Native Artists, Albums, Tracks, Recently Added, Search, album details, and playback
- Persistent play/pause, seek, previous/next, and queue controls
- FLAC, MP3, AAC/M4A (including ALAC), Ogg Vorbis, and Opus ingestion
- Metadata validation, safe canonical paths, Navidrome scan, catalog reconciliation, and retryable imports
- Stable UUID-backed Commonwax Artist, Album, and Track records mapped to Navidrome IDs
- Owner, Admin, and Member roles backed by effective permission sets and API middleware
- One-use invitation links with direct account creation and Library entry
- Contributor/album/track attribution and “Added by” display
- Open, claimed, fulfilled, and cancelled music requests
- Reusable activity events for additions, joins, request creation, claims, and fulfillment
- Personal album hiding and restoration, separate from permission-gated canonical removal
- Multi-Library-ready account and membership schema (the v0.0.1 UI selects the first membership)

## Architecture

```text
Browser ──> Commonwax web ──> Commonwax API ──> PostgreSQL
                                  │
                                  └──> OpenSubsonic API ──> Navidrome
                                            │
Upload ──> staging ──> canonical music <────┘
```

The API uses opaque HTTP-only session cookies. OpenSubsonic credentials stay inside the API container. Audio and artwork are streamed through authenticated Commonwax endpoints, so the browser never needs a Navidrome address or account.

## Local development

Node.js 22+, PostgreSQL, and Navidrome are required.

```bash
npm install
cp .env.example .env
```

For local services, set at least:

```dotenv
DATABASE_URL=postgresql://commonwax:commonwax@localhost:5432/commonwax?schema=public
NAVIDROME_URL=http://localhost:4533
NAVIDROME_USERNAME=admin
NAVIDROME_PASSWORD=your-local-navidrome-password
MUSIC_DIR=./music
STAGING_DIR=./staging
PUBLIC_URL=http://localhost:5173
```

Then run:

```bash
npm run db:migrate
npm run dev
```

Vite serves the web app at `http://localhost:5173` and proxies `/api` to the API at port 3000.

## Verification

```bash
npm run build
npm test
npm audit --omit=dev
```

The checked-in migration is at `packages/db/prisma/migrations/20260822000000_initial/migration.sql`. The permission matrix is centralized in `packages/permissions`; route handlers ask for permissions, never role names, except where role hierarchy itself is the managed object (for example, only an Owner can promote an Admin).

## Operational notes

- Uploads are limited to 1 GiB per file, 200 files, and 20 GiB total per batch.
- The upload request waits for Navidrome reconciliation for up to 90 seconds. A failed post-scan reconciliation is retained as a failed batch and can be retried through the API.
- Commonwax asks Navidrome for browser-compatible MP3 streams; original source files are never transcoded in place or modified.
- Removing an album deletes its canonical track files and Commonwax catalog records, then starts a Navidrome scan. Activity remains as historical group context.
- v0.0.1 intentionally has no public signup, playlists, reactions, external metadata acquisition, or embedded Navidrome UI.
