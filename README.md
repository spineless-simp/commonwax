# Commonwax

Commonwax is a native web client for Navidrome, with the added ability to share and collaborate with other users who you choose to invite. Curate a catalog with your friends and family, and keep it all self hosted -- get closer with your people and save some cash by dropping your music subscription.

# How does it work?

Navidrome is a well-respected application designed to help you self-host your music library. We take Navidrome and essentially layer a new frontend on top of it that handles all of the onboarding and social features. You'll never need to actually see Navidrome at all; everything happens inside of Commonwax instead.

## Setting it up

First, someone needs to host Commonwax. The only prerequisites required are Docker + Docker Compose.

1. Clone the repo to the machine you want to run Commonwax from. Even a cheap VPS should work, and is probably the best way to go, but I have only tested locally.

2. Set up your environment
* Run `cp .env.example .env` and open it in your editor of choice.
* Set `POSTGRES_PASSWORD` and `NAVIDROME_PASSWORD` to something unique.
* Set `PUBLIC_URL` to the URL your users will use.
    * If your server supports HTTPS, set `COOKIE_SECURE=true`.
* (optional) Set `FANART_API_KEY`. Get your free key from [fanart.tv](https://fanart.tv/get-an-api-key/) to populate artist logos and background images. They're cached on the server, so the fetch only happens once (unless you run it manually).

3. `docker compose up -d --build` to get started. Once it's done, head to `localhost:8080` (or use your configured URL and port) to set up your admin account and get going.

## Updating

There's no auto-update of any kind right now. Just run `git pull` and then `docker compose up -d --build` again.

# Where does the music come from?

Everything is local on the server, and users stream from it. It's like Spotify, but on your own computer instead of someone else's that you pay $14.99/month for, and you don't have to see Joe Rogan. Or audiobooks.

You can import music from in the app. It's a bit clunky right now, so if you have any suggestions for improvements, let me know or open a PR.

# What works

- Albums, artists, tracks, recently added, search, album details, and playback
- Album requests and fufillment
- Persistent play/pause, seek, previous/next, queueing
- FLAC, MP3, AAC/M4A, ALAC, Ogg Vorbis, and Opus ingestion
- Metadata validation
- Owner, admin, and member roles
    - Owners can do anything. Admins can do almost anything except destructive actions, and members can only listen, request, and upload
- Activity status (see what everyone's listening to)
- Basic user settings

# What's next?

- Import from an existing Navidrome installation
- Bulk invites
- Lidarr integration
- Playlists
    - Playlist migration from external services
- Native mobile apps (don't count on this anytime soon, but the web version is mobile friendly)

# Notes

This is very much a WIP, and comes from trying to solve a couple of problemms: I'm tired of not owning anything, and I want to share a music library with other people. Fragmented playlists across services and links that get lost kind of suck. This is, hopefully, a better experience.

There is **no telemetry** of any kind baked into Commonwax. I have no idea what you're doing with it, or how well it's working. So, if you see anything funny, let me know so I can fix it.

# Nerd shit

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
