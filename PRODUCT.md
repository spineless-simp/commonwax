# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A technically capable host deploys and maintains Commonwax. The people using it day to day are the host and invited, potentially nontechnical friends who browse, play, contribute to, and talk through one shared music collection.

## Product Purpose

Commonwax makes a personal music server feel like a collection held between friends. Success is the complete workflow: create a Library, add and play music, invite a friend, preserve who contributed it, request something missing, fulfill that request with an upload, and see the group activity that resulted.

## Positioning

Navidrome handles the music; Commonwax handles the people. Commonwax is a purpose-built Navidrome client whose attribution, requests, membership, and activity belong to the same collection experience rather than sitting beside a generic music player.

## Operating Context

The host deploys with Docker. Invited members enter through one link and never configure a server or see Navidrome credentials. In normal use, members browse album artwork, search, open albums, play tracks, see who added music, request albums, claim requests, upload music, review group activity, and open the Library itself to see who runs it and who is listening.

## Capabilities and Constraints

- Contains only the functionality in the original specification. Do not add adjacent music or social features.
- Albums are the primary visual music object; Artists, Tracks, Recently Added, and Search remain available.
- An artist is a place, not a disclosure: browsing artists opens one artist's page, led by their own lettering over their own photograph where those exist. That artwork is decoration sourced from outside the deployment, optional, absent until the host supplies a key, and nothing in the product waits on it or breaks without it.
- The persistent player supports play/pause, seek, previous/next, and a basic queue.
- Social context is essential within scope: attribution, requests, fulfillment, membership, and activity must feel native to the collection.
- Attribution is browsable, not only displayed: every surface that lists music can be narrowed to one contributor.
- Owner, Admin, and Member permissions are enforced by the API.
- The Library overview is open to every member regardless of role: who runs the library, who belongs to it, what each member recently did, and what each is playing right now.
- Listening presence is transient and self-expiring — a current state shown to the group, never a stored play history.
- Per-user hiding never changes shared media; canonical removal is permission-gated.
- Navidrome alone defines the current media catalog, metadata, artwork, paths, and availability; Commonwax stores only sparse social/history bindings.
- Historical media snapshots are visibly unavailable and never presented as current Navidrome metadata.
- Commonwax owns the web experience. Infrastructure and the Navidrome interface stay invisible to members. The host and admins have one page where the deployment is visible — restarting services, withholding uploads, removing a member, and starting over — reached only by the roles that hold those permissions.
- Removing a member erases their account and asks, rather than assumes, whether the music they added stays. Kept music is never left unattributed: it reads as "someone", a name no account may take.
- Emptying the deployment belongs to the owner alone, and asks twice.

## Brand Commitments

The product name is Commonwax. Product copy is sparse and functional. Use labels, state, and short instructions only when the interface cannot make the action self-evident.

- Familiar media-app conventions should meet the craft level of Spotify and TIDAL. Classic Napster contributes compact, useful track metadata—not nostalgic chrome or novelty styling.
- The listening experience is fully dark across navigation, collection, forms, and playback. Light values belong to type and compact controls, never page or panel backgrounds.

## Evidence on Hand

The application renders the user's real library metadata, artwork, contributors, members, requests, and activity. There are no marketing claims, testimonials, stock images, or fixed demonstration content to fabricate.

## Product Principles

- Music leads every normal session.
- People are visible through the music they add, request, and fulfill.
- State and action should be obvious without explanatory prose.
- Nontechnical members never encounter infrastructure.
- Stop when the specified end-to-end workflow is complete.
