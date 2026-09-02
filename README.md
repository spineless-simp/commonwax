# Commonwax

Commonwax is a native web client for [Navidrome](https://github.com/navidrome/navidrome), with the added ability to share and collaborate with other users who you choose to invite. Curate a catalog with your friends and family, and keep it all self hosted -- get closer with your people and save some cash by dropping your music subscription.

# How does it work?

Navidrome is a well-respected application designed to help you self-host your music library. We take Navidrome and essentially layer a new frontend on top of it that handles all of the onboarding and social features. You'll never need to actually see Navidrome at all; everything happens inside of Commonwax instead.

# Features

- Playback and basic player controls (seek, shuffle, play/pause/stop, next/previous)
- Importing music
- A basic request system: users can add requests and others can claim / fufill them by uploading the requested album
- Super basic theme support: currently offers light, dark, light HC, dark HC, and two goofy retro themes that I just had to have
- User activity
- Metadata and image storage: while Navidrome handles most of this, Commonwax keeps track of some additional items just in case metadata arrives damaged. We also grab image files from fanart.tv (if configured) to enhance the UI with artist logos and backgrounds

# Upcoming

- Import of existing Navidrome library
- Lidarr integration
- Playlist import from external services (only the lists, not the actual music)

# Disclosures

This app does not come with any telemetry of any kind. It was built primarily using OpenCode with a locally-running model (MiMo v2.5 Free), and tested by hand. This README was also human-authored. No art assets were AI generated or AI assisted, outside of potential images delivered via metadata retrieval, which is outside of my control. I'm not a developer; I just wanted this thing to exist, so I guided the robots to help me build it to my specifications. If you run into any issues or want to contribute, feel free to open a PR.

# Usage

## Installation

The only prerequisites required are Docker + Docker Compose.

1. Clone the repo to the machine you want to run Commonwax from. Even a cheap VPS should work, and is probably the best way to go, but I have only tested locally.

2. Set up your environment
* Run `cp .env.example .env` and open it in your editor of choice.
* Set `POSTGRES_PASSWORD` and `NAVIDROME_PASSWORD` to something unique.
* Set `PUBLIC_URL` to the URL your users will use.
    * If your server supports HTTPS, set `COOKIE_SECURE=true`.
* Set `FANART_API_KEY`. Get your free key from [fanart.tv](https://fanart.tv/get-an-api-key/) to populate artist logos and background images. They're cached on the server, so the fetch only happens once (unless you run it manually).

3. `docker compose up -d --build` to get started. Once it's done, head to `localhost:8080` (or use your configured URL and port) to set up your admin account and get going.

## Listening

Anyone with access can just head to the web address and log in to listen. This should work as a PWA, but hasn't been fully tested as such.

## Inviting

Click on *People* in the left-hand sidebar, and then *Invite* towards the top-right corner of the screen. Currently, invite links only work once and expire after seven days.

## Updating

There's no auto-update of any kind right now. Just run `git pull` and then `docker compose up -d --build` again.

## Adding music

Everything is local on the server, and users stream from it. You can import music from inside of the app by selecting *Add music* in the top-right corner. It's a bit clunky right now, so if you have any suggestions for improvements, let me know or open a PR. **Do not upload using Navidrome directly, or you'll end up with mismatched libraries and probably some other annoying behavior.**

# Notes

This is very much a WIP, and comes from trying to solve a couple of problemms: I'm tired of not owning anything, and I want to share a music library with other people. Fragmented playlists across services and links that get lost kind of suck. This is, hopefully, a better experience.
