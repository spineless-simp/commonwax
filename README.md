# Commonwax

Commonwax is a native web client for [Navidrome](https://github.com/navidrome/navidrome), with the added ability to share and collaborate with other users who you choose to invite. Curate a catalog with your friends and family, and keep it all self hosted -- get closer with your people and save some cash by dropping your music subscription.

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
