# Commonwax v0.1.0

Commonwax is a native web client for a shared Navidrome collection. Navidrome owns cataloging, artwork, scanning, streaming, and transcoding; Commonwax owns accounts, membership, permissions, invitations, attribution, requests, preferences, and activity.

This repository implements the workflow: create a Library, upload an album, invite a friend, listen together, request missing music, claim and fulfill the request with an upload, and retain attribution and activity throughout.

## Deploy

The only host prerequisites are Docker Engine and Docker Compose.

```bash
cp .env.example .env
```

Set `POSTGRES_PASSWORD` and `NAVIDROME_PASSWORD` in `.env` — both are required and have no default, so `docker compose` refuses to start without them. Set `PUBLIC_URL` to the URL friends will use; it must be reachable by invited users because invitation links are built from it. If that URL is `https://`, set `COOKIE_SECURE=true` or the API will refuse to start rather than send session cookies in cleartext.

`FANART_API_KEY` is optional. With a key from [fanart.tv](https://fanart.tv/get-an-api-key/), artists browse under their own logos and an artist's page is led by their logo over their background image. Without one the deployment makes no outbound request for artwork and artists fall back to their name — nothing else changes. The images are fetched by the API, stored, and served from Commonwax's own origin, so no member's browser ever talks to fanart.tv.

```bash
docker compose up -d --build
```

Open `http://localhost:8080` (or the configured `WEB_PORT`). The first-run screen asks only for the Owner account and Library name. Commonwax automatically applies PostgreSQL migrations and internally provisions the Navidrome service account; Navidrome's UI and credentials are never exposed to invited users.

Named volumes hold all persistent state:

- `commonwax_postgres` — Commonwax accounts and social data
- `commonwax_navidrome` — Navidrome's database and cache
- `commonwax_music` — canonical, unmodified source audio
- `commonwax_staging` — temporary uploads

Do not expose the Navidrome container port publicly; Commonwax proxies authenticated streams and artwork.

### Backup and restore

Back the three stateful volumes up **together and from a stopped stack** — a
Postgres dump taken while music is being imported can reference bindings for
files the music volume snapshot does not yet contain.

```bash
docker compose stop
for v in postgres navidrome music; do
  docker run --rm -v commonwax_$v:/from -v "$PWD/backup:/to" alpine \
    tar czf "/to/$v.tar.gz" -C /from .
done
docker compose start
```

Restoring goes the other way, into a stack that is down, and `.env` has to come
back with it — a restored database whose `NAVIDROME_PASSWORD` no longer matches
leaves the API unable to reach its own catalog:

```bash
docker compose down
for v in postgres navidrome music; do
  docker volume rm -f commonwax_$v
  docker volume create commonwax_$v
  docker run --rm -v commonwax_$v:/to -v "$PWD/backup:/from" alpine \
    tar xzf "/from/$v.tar.gz" -C /to
done
docker compose up -d
```

The staging volume holds only in-flight uploads and is not worth keeping.
Resetting the deployment from the admin page has no undo and does not take a
backup first; this is the only thing that makes it recoverable.

The API container runs as the unprivileged `node` user. Docker gives a *new* named volume the ownership of the image's mount point, so fresh deployments need nothing extra. A deployment created before this change has root-owned `music` and `staging` volumes and needs a one-time fix, otherwise uploads fail with `EACCES`:

```bash
docker compose run --rm --user root api chown -R node:node /music /staging
```

## What is implemented

- Native Artists, Albums, Tracks, Recently Added, Search, album details, and playback
- Persistent play/pause, seek, previous/next, and queue controls
- FLAC, MP3, AAC/M4A (including ALAC), Ogg Vorbis, and Opus ingestion
- Metadata validation, safe canonical paths, Navidrome scan, exact upload provenance matching, and retryable imports
- Live catalog, metadata, artwork, path, and playback reads from Navidrome
- Sparse UUID-backed media bindings created only when Commonwax-owned state needs a stable identity
- Conservative MusicBrainz/ISRC rebinding when Navidrome IDs change, with unavailable historical records when identity is uncertain
- Owner, Admin, and Member roles backed by effective permission sets and API middleware
- One-use invitation links with direct account creation and Library entry
- Contributor/album/track attribution and “Added by” display
- Open, claimed, and fulfilled music requests, cancellable by the requester or a library manager
- Reusable activity events for additions, joins, request creation, claims, and fulfillment
- Personal album hiding and restoration, separate from permission-gated canonical removal
- Host-facing admin page: restarting individual services or the whole stack, withholding uploads from one member, removing a member with an explicit choice about their music, and resetting the deployment to a fresh install
- Multi-Library-ready account and membership schema (the v0.0.1 UI selects the first membership)

## Architecture

```text
Browser ──> Commonwax web ──> Commonwax API ──> PostgreSQL
                                  │
                                  ├──> OpenSubsonic API ──> Navidrome
                                  │          │
Upload ──> staging ──> canonical music <─────┘
                                  │
                                  └──> docker-proxy ──> Docker Engine   (restart only)
```

The API uses opaque HTTP-only session cookies. OpenSubsonic credentials stay inside the API container. Audio and artwork are streamed through authenticated Commonwax endpoints, so the browser never needs a Navidrome address or account.

### Catalog ownership

Navidrome is the sole source of truth for the current music library. Commonwax does not import or reconcile a second catalog: album, artist, track, metadata, artwork, file path, and playback availability responses are read live through OpenSubsonic.

PostgreSQL holds only sparse media identity/provenance bindings needed by Commonwax-owned contributions, request fulfillment, hiding, and future social state. A binding can retain a title, artist, year, and track labels for historical display after upstream media disappears. Those snapshots are returned only with an explicit unavailable state and are never mixed into current catalog results. Rebinding uses an unambiguous MusicBrainz ID or ISRC; names, titles, ordering, and paths are never used to guess after an upstream ID changes.

## Local development

Node.js 22+ and Docker are the only prerequisites.

The default loop is the deployed stack. You build the same images the deployment
runs, and you use the app the way anyone else does — through nginx, on real
volumes, as a real container. Nothing about the container is simulated, which
means the parts with no test coverage (Dockerfiles, mounts, users, ports, env,
healthchecks) are exercised every time you look at your change.

```bash
npm install
npm run stack:rebuild        # build and start everything
# open http://localhost:8080
```

After that, reload only what you changed:

| Command | Effect | Typical |
| --- | --- | --- |
| `npm run stack:reload -- web` | Rebuild and replace the web container, leaving its dependencies running | ~8-14s |
| `npm run stack:reload -- api` | Same for the API | ~24s |
| `npm run stack:rebuild` | Rebuild everything and restart the whole stack, dependencies included | ~45-65s |
| `npm run stack:up` | Start without rebuilding | |
| `npm run stack:ps` | Service status | |
| `npm run stack:logs` | Follow all logs | |
| `npm run stack:logs -- api` | Follow one service | |
| `npm run stack:down` | Stop; named volumes are kept | |

`stack:reload` is `stack:rebuild` plus `--no-deps`. The difference is almost
entirely waiting: without it Compose restarts Postgres, Navidrome, and the API
and blocks on their healthchecks even when only the web bundle changed. Use
`stack:rebuild` when a change crosses services or touches Compose itself, and
`stack:reload` the rest of the time.

If a reload prints `Container ... Running` rather than `Recreated`, the build
produced a byte-identical image and there was nothing to replace. That is the
correct outcome, not a missed change.

**Use two terminals.** `stack:rebuild` and `stack:reload` are detached — they
build, replace the container, and hand you back the shell. They deliberately
print no logs. Logs are their own command, in their own terminal:

```bash
# terminal 1 — leave this running all day
npm run stack:logs -- api      # one service, quiet
npm run stack:logs             # all five, prefixed and noisy

# terminal 2 — your actual work
npm run stack:reload -- api
```

The log stream survives a reload. `docker compose logs -f` follows the service,
not the container, so when `stack:reload` replaces the container the stream stays
attached and picks up the new one's output. Start it once and forget it.

For a one-off look rather than a live follow:

```bash
docker compose logs --tail=200 api
```

These require the invoking user to be able to reach the Docker daemon — on a
single-user host, `sudo usermod -aG docker $USER` followed by a new login. No
`sudo` after that.

### Watch mode, for visual iteration

`npm run stack:reload` is fast enough for most work, but it still costs a
rebuild and loses whatever state the page was in. For sustained visual work —
spacing, color, the tenth pass on a layout — run the API and web app as host
processes instead:

```bash
npm run dev
# http://localhost:5173
```

`npm run dev` builds the `packages/*` workspaces, starts a separate Postgres and
Navidrome from `docker-compose.dev.yml`, applies migrations, then runs the API on
port 3000 and Vite on 5173 with `/api` proxied to it. tsx watches the API and
Vite hot-reloads the web app, so a change is live without a rebuild and without
losing component state. Logs stream to that terminal.

Its environment is the committed `.env.dev`, then `.env.dev.local` if present.
Every value in `.env.dev` is a fixed local constant; a development secret — a
fanart.tv key — belongs in the gitignored `.env.dev.local`. `.env` holds
deployment secrets and is not read here.

The development services are their own Compose project (`commonwax-dev`) with
their own volumes, published on 127.0.0.1 only — Postgres on 5433 and Navidrome
on 4534, off the default ports so they cannot be mistaken for a deployment.
Uploads write to `./music`, the directory bind-mounted into the development
Navidrome, so the upload → scan → import pipeline behaves as it does in
production. The library starts empty.

| Command | Effect |
| --- | --- |
| `npm run dev` | Development services, migrations, and both watchers |
| `npm run dev:services` | Start development Postgres and Navidrome only |
| `npm run dev:services:logs` | Follow their logs |
| `npm run dev:services:down` | Stop them, keeping the development library and database |
| `npm run dev:services:reset` | Stop them and delete their volumes — an empty library again |
| `npm run db:migrate` | Author a new migration against the development database |

If `npm run dev` ever appears to ignore your configuration, check which process
owns port 3000. `concurrently` restarts its children, so killing the API alone
leaves a supervisor that respawns it with the old environment:

```bash
ss -ltnp | grep -E ':3000|:5173'
```

### A second isolated stack

The destructive admin actions need somewhere safe to run. `DOCKER_PROJECT` names
both the Compose project and the containers the API addresses, so a fully
separate stack — its own containers, its own volumes — is one variable:

```bash
DOCKER_PROJECT=commonwax-probe WEB_PORT=8099 docker compose --env-file probe.env up -d --build
# ... exercise it ...
DOCKER_PROJECT=commonwax-probe docker compose --env-file probe.env down -v
```

## Verification

```bash
npm run build
npm run typecheck
npm test
npm audit --omit=dev
```

`.github/workflows/ci.yml` runs all four on every push and pull request, and additionally builds both container images and asserts that `docker compose config` fails when the required passwords are absent.

Checked-in migrations are under `packages/db/prisma/migrations`, including the sparse-media-binding conversion. The permission matrix is centralized in `packages/permissions`; route handlers ask for permissions, never role names, except where role hierarchy itself is the managed object (for example, only an Owner can promote an Admin).

## Operational notes

- Uploads are limited to 1 GiB per file, 200 files, and 20 GiB total per batch. The batch limit is enforced from the declared `Content-Length` before any bytes reach the staging volume.
- Sign-in, first-run setup, and invitation endpoints are rate limited per client address (10 credential attempts and 30 invitation lookups per 15 minutes). The counters live in the API process, so a horizontally scaled deployment would need a shared store instead.
- Expired sessions are swept at startup and every six hours.
- The upload request waits for Navidrome's scan for up to 90 seconds, then binds only uploaded tracks that match their exact temporary Commonwax canonical paths. An ambiguous or missing match fails closed and can be retried through the API; successful imports discard that path staging data.
- Commonwax asks Navidrome for browser-compatible MP3 streams; original source files are never transcoded in place or modified.
- Removing an album deletes the files Navidrome's own REST API reports on disk and starts a scan, pruning directories it empties. The paths come from `/api/song` rather than from OpenSubsonic, whose `path` is synthesized from tags and does not name the file. Commonwax bindings, attribution, fulfilled requests, and activity remain as unavailable historical context.
- Admin and Owner reach an admin page; Members have neither the route nor a navigation entry to it. Restarts go through `docker-proxy`, a haproxy in front of the Docker socket configured `CONTAINERS=0, POST=1, ALLOW_RESTARTS=1`, which permits `POST /containers/<name>/restart` and answers 403 to listing, inspecting, creating, starting, and exec. The API therefore cannot read container state, and the page reports the health it can see rather than claiming otherwise. Without `DOCKER_PROXY_URL` — in development, or a deployment that removes the service — the restart controls are hidden and the endpoint answers 503.
- Withholding uploads from a member subtracts `music:contribute` and `request:fulfill` from whatever their role grants, rather than snapshotting a permission list, so it survives a later role change and lifting it restores their current role exactly.
- Removing a member erases their account, ends their sessions, and requires an explicit `music=keep|delete`. Kept, their contributions stay and read as “someone”, a name no account may take. Deleted, only albums nobody else contributed to are removed; an album a second member also added is left intact and only the erased account's claim on it is dropped.
- Resetting the deployment (Owner only, behind a dialog and a ten-second held press) empties `MUSIC_DIR` and staging, rescans Navidrome, and truncates every Commonwax table except the Prisma migration ledger. Navidrome's own users and settings live in a volume the API does not mount and are untouched. There is no backup and no undo.
