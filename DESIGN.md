---
name: Commonwax
description: A refined shared-listening system where music leads and people remain visible through the collection.
colors:
  ink: "#eff3ef"
  ink-soft: "#c5cdc6"
  ink-inverse: "#0b0e0c"
  chrome: "#080a09"
  chrome-raised: "#111512"
  canvas: "#0d100e"
  surface: "#151916"
  surface-deep: "#1d231f"
  surface-bright: "#edf2ee"
  muted: "#929c94"
  muted-light: "#b1bbb3"
  line: "#29302b"
  line-dark: "#202622"
  line-strong: "#3b443d"
  accent: "#86a5c3"
  accent-soft: "#1d2c39"
  danger: "#e47a72"
  danger-soft: "#351e1c"
typography:
  display:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.85rem, 2.5vw, 2.45rem)"
    fontWeight: 680
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  display-small:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 680
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 680
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.08rem, 1.5vw, 1.3rem)"
    fontWeight: 680
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  subheading:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 680
    lineHeight: 1.2
  title:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.84rem"
    fontWeight: 680
    lineHeight: 1.3
  body:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.76rem"
    fontWeight: 680
    lineHeight: 1.2
  metadata:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 400
    lineHeight: 1.35
  caption:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.65rem"
    fontWeight: 400
    lineHeight: 1.3
  label:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.09em"
  micro:
    fontFamily: "Instrument Sans Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.54rem"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  badge: "6px"
  compact: "7px"
  small: "8px"
  control: "9px"
  artwork: "10px"
  medium: "12px"
  large: "16px"
  full: "999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "10px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "42px"
components:
  button-primary:
    backgroundColor: "{colors.surface-bright}"
    textColor: "{colors.ink-inverse}"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "42px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "42px"
  input-field:
    backgroundColor: "{colors.surface-deep}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.small}"
    padding: "0 13px"
    height: "46px"
  nav-active:
    backgroundColor: "{colors.surface-deep}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.small}"
    padding: "0 11px"
    height: "40px"
  status-claimed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink-inverse}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "4px 7px"
---

# Design System: Commonwax

## Overview

**Creative North Star: "The Shared Listening Frame"**

Commonwax should feel like entering one familiar, refined listening environment: near-black navigation and playback hold a mineral-gray collection canvas, while porcelain text and slate-blue state cues keep the interface quiet and legible. Spotify and TIDAL set the craft bar; classic Napster contributes compact, useful metadata density rather than nostalgia or novelty chrome.

Music remains the visual lead. Album art supplies most of the color, dense track rows reward scanning, and contributor, request, and activity context stays integrated into the collection rather than becoming a separate dashboard. The system is compact but never cramped, restrained but never generic.

**Key Characteristics:**

- One continuous listening frame from navigation to fixed playback.
- Near-black chrome, mineral-gray canvas, porcelain type, and rare slate-blue state color.
- Edge-to-edge album fields with fine dividers instead of nested dashboard panels.
- Compact, format-aware metadata and native social context.
- Fast, interruptible motion that clarifies state without becoming spectacle.

## Colors

The palette is mostly neutral and mineral; album artwork provides chroma, while slate blue is reserved for focus, selected playback, attribution, and meaningful state.

### Primary

- **Slate Signal** (#86a5c3): The restrained accent for focus outlines, active playback, avatars, claimed requests, and fallback artwork.
- **Slate Depth** (#1d2c39): The dark active-state field behind playing tracks and import progress.

### Tertiary

- **Signal Red** (#e47a72): Destructive actions and unavailable media warnings only.
- **Ember Warning** (#351e1c): Inline error fields that need readable contrast without visual alarm.

### Neutral

- **Listening Black** (#080a09): The foundational chrome for navigation, playback, and empty-state framing.
- **Raised Charcoal** (#111512): The subtle lifted layer inside chrome.
- **Onyx Canvas** (#0d100e): The continuous collection background.
- **Graphite Surface** (#151916): The card and panel surface across collection, forms, and dialogs.
- **Deep Mineral** (#1d231f): The hover and secondary surface layer.
- **Porcelain Surface** (#edf2ee): The bright solid-action surface for primary buttons and high-contrast avatars.
- **Porcelain Ink** (#eff3ef): Primary text.
- **Carbon Ink** (#0b0e0c): Text and icon color on light-filled surfaces — primary buttons, avatars, claimed-status pills.
- **Ash Ink** (#c5cdc6): Secondary text on dark surfaces.
- **Field Note Gray** (#929c94): Supporting text and metadata.
- **Mist Gray** (#b1bbb3): Supporting text on dark chrome.
- **Line Mineral** (#29302b): Primary dividers across collection, forms, and lists.
- **Hairline Dark** (#202622): Subtler dividers on already-dark chrome, such as the sidebar profile card.
- **Line Strong** (#3b443d): Visible borders for input fields, the dashed upload drop zone, and hover-state outlines.

### Named Rules

**The Artwork Carries Color Rule.** Keep interface chroma scarce so covers remain the strongest color in ordinary browsing.

**The Slate Means State Rule.** Use the accent for focus, selection, playback, attribution, and fulfillment state—not for decorative brand wash.

**The Derived Shade Rule.** Contextual hover, muted-on-dark, error-ink, and state shades are calculated from the normative palette with `color-mix()`; do not introduce one-off color literals.

### Theming

The palette above is the default (Dark) theme and the one this document's frontmatter and Do's and Don'ts describe. A member may instead choose Light, Dark High Contrast, or Light High Contrast from Settings → Appearance; each is a full override of the same token set (`ink`, `chrome`, `canvas`, `surface`, `muted`, `line`, `accent`, `danger`, `shadow-low`/`shadow-high`) in `apps/web/src/styles.css`, applied via a `data-theme` attribute so every derived, `color-mix()`-built shade re-resolves automatically. The two high-contrast themes push toward pure black/white with sharper borders and a brighter accent for stronger legibility. fanart.tv artist wordmarks, which ship as white lettering on transparency, are inverted in the two light themes wherever they sit on a themed surface — the album plate's fixed dark "vinyl label" background and the artist header's photographic backdrop are exempted, since neither follows site theme.

## Typography

**Display Font:** Instrument Sans Variable (with Helvetica Neue, Arial, sans-serif fallbacks)
**Body Font:** Instrument Sans Variable (with Helvetica Neue, Arial, sans-serif fallbacks)

**Character:** One variable grotesk family keeps the experience coherent across expressive album titles and dense utility metadata. Weight, scale, spacing, and tabular numerals create hierarchy; a second display face would make the product feel editorial rather than operational.

### Hierarchy

- **Display** (variable weight 680, fluid 1.85–2.45rem, 1.05 line-height): Page titles and high-value album detail titles.
- **Display Small** (variable weight 680, 1.75rem, 1.08 line-height): Narrow-screen page titles.
- **Section** (variable weight 680, 1.6rem, 1.1 line-height): Compact collection headings at narrow breakpoints.
- **Headline** (variable weight 680, fluid 1.08–1.3rem, 1.2 line-height): Section headings and modal-scale hierarchy.
- **Subheading** (variable weight 680, 1rem, 1.2 line-height): Dense list headers, brand lockups, and secondary hierarchy.
- **Title** (variable weight 680, 0.84rem, 1.3 line-height): Album, track, request, and component titles.
- **Body** (regular, 0.8rem, 1.5 line-height): Functional copy and short instructions; explanatory lines top out at roughly 65 characters.
- **Control** (variable weight 680, 0.76rem, 1.2 line-height): Buttons, menus, and compact feedback.
- **Metadata** (regular, 0.72rem, 1.35 line-height): Artist, album, time, format, and supporting utility values.
- **Caption** (regular, 0.65rem, 1.3 line-height): Contributor ribbons, player context, and secondary dark-chrome labels.
- **Label** (variable weight 700, 0.6rem, 0.09em tracking, uppercase): Navigation groups, table headings, formats, status pills, and availability labels.
- **Micro** (variable weight 700, 0.54rem, 1.2 line-height): Initials and the most space-constrained mobile navigation labels only.

### Named Rules

**The One-Family Rule.** Use Instrument Sans for every interface voice; create contrast with variable weight, compact sizing, and numeric treatment.

**The Metadata Stays Compact Rule.** Utility text may be small, but it must retain clear contrast, tabular numerals where appropriate, and a minimum purposeful role.

## Layout

Desktop uses a fixed listening frame: a compact navigation rail (216px), a sticky toolbar (64px), an edge-to-edge content pane, and a compact bottom player (88px). The home view pairs the flexible collection with an integrated social rail (308px) separated by one fine divider. Album grids fill available width using approximately 142–148px minimum columns rather than sitting inside a centered card or dashboard container.

Spacing follows a compact 4/8/10/16/24/32/42px rhythm, with larger fluid gaps only where the canvas needs breathing room. Rows are deliberately dense: the canonical track row is 56px high and exposes title, album, format, duration, and playback state without extra framing.

At 1180px the social rail tightens; at 920px the desktop rail disappears, the social column moves below the collection, the player compresses to 72px above a 64px mobile bottom navigation, and table metadata selectively collapses. At 620px the album field becomes two equal columns, dialogs become bottom sheets, action groups stack, and album detail becomes one column. At 380px the smallest spacing and playback controls simplify again. Preserve safe-area padding in bottom navigation.

**The No Nested Stage Rule.** Do not wrap the library in a centered dashboard card or oversized hero; the music field owns the canvas edge to edge.

## Elevation & Depth

The system is tonally layered first and shadowed selectively. Fine light or dark dividers establish most structure. A diffuse low shadow belongs to artwork and compact surfaced feedback; the high shadow is reserved for true overlays such as dialogs, menus, queues, and toasts. Album hover may lift by 3px with a slightly stronger ambient shadow, while ordinary rows and rails remain flat.

### Shadow Vocabulary

- **Ambient Low** (`0 8px 24px rgba(19, 25, 21, .12)`): Resting album art, compact feedback, and understated depth.
- **Overlay High** (`0 22px 64px rgba(11, 15, 12, .28)`): Dialogs, queue, mobile menu, and toast surfaces.
- **Player Horizon** (`0 -10px 36px rgba(11, 15, 12, .22)`): The fixed playback edge only.

### Named Rules

**The Tonal-First Rule.** Establish hierarchy with material shifts and hairline dividers before adding a shadow.

**The Overlay Owns Elevation Rule.** High elevation signals a temporary layer above the listening frame; never spend it on ordinary cards.

## Shapes

Corners are quiet and calibrated: 6px for badges, 7px for embedded compact artwork, 8px for controls and rows, 9px for buttons, 10px for primary artwork and search, 12px for medium feature surfaces, and 16px for dialogs and large containers. Pills and avatars alone use fully rounded geometry. Album artwork remains square and clips cleanly; borders are generally one-pixel hairlines, with a dashed border reserved for the upload drop zone.

**The Quiet Radius Rule.** Curves soften controls without turning the interface into a field of bubbles; full rounding is semantic, not decorative.

## Components

### Buttons

- **Shape:** Compact, gently rounded controls (9px) with a 42px minimum height; icon buttons use 8px corners or circles when they represent playback.
- **Primary:** Carbon Ink fill with porcelain text and horizontal 16px padding. Hover lightens to charcoal; active deepens toward black; disabled state reduces opacity without changing layout.
- **Hover / Focus:** Use restrained tonal shifts and the shared 2px Slate Signal focus outline offset by 3px.
- **Secondary / Ghost / Tertiary:** Secondary actions are transparent with a one-pixel mineral border; ghost and text actions rely on surface tint or an underline appearing on hover. Destructive text stays Signal Red and never masquerades as a primary action.

### Chips

- **Style:** Status and role pills use compact uppercase labels, 4–5px vertical padding, and fully rounded geometry.
- **State:** Neutral states remain mineral; claimed state uses Slate Signal, fulfilled state uses a quiet green-gray, and cancelled state recedes.

### Cards / Containers

- **Corner Style:** Album cards are structurally unboxed; only their 10px artwork clips. Large authored empty states use 16px corners.
- **Background:** Ordinary collection items share the Mineral Canvas. Dark welcome and authentication surfaces use Listening Black or Raised Charcoal.
- **Shadow Strategy:** Artwork receives Ambient Low; large containers stay tonal unless they are overlays.
- **Border:** Social, request, list, and metadata structures use single hairline dividers instead of enclosing borders.
- **Internal Padding:** Compact rows use 8–16px; dialogs use 24px and adapt to 17–20px on narrow screens.

### Inputs / Fields

- **Style:** Fields use a light surface, one-pixel neutral stroke, 8px corners, a 46px minimum height, and 13px horizontal padding. Search is a denser 40px tonal field without an enclosing border.
- **Focus:** Every field uses the shared Slate Signal outline; browser default outlines must not be suppressed unless this replacement is present.
- **Error / Disabled:** Errors pair Signal Red copy with Blush Warning. Disabled actions retain their dimensions and use reduced opacity.

### Search Suggestions

Search answers while someone types rather than waiting for a submit. The 40px toolbar field keeps its tonal treatment and gains a clear control once there is text; below it a high-elevation 16px overlay lists a few artists, albums, and tracks under quiet uppercase group labels, closing with one row that opens the full results page. Rows are 46px, led by 30px clipped artwork or an initials avatar, and truncate rather than wrap. Suggestions arrive on a debounce, results already on screen stay put while better ones load, and the field says it is searching instead of claiming no matches. The overlay is a combobox: the arrow keys move an active row, Enter takes it, Enter on nothing runs the full search, Escape retreats one step — suggestions first, then the query — and a press outside dismisses. Unavailable media stays listed, labelled, and inert. Below 920px the menu leaves the narrow field and hangs from the sticky toolbar across the screen.

### Navigation

Desktop navigation is a fixed near-black 216px rail with compact 40px rows, quiet gray labels, restrained dark hover, and a porcelain active field. At 920px and below it becomes a fixed 64px bottom navigation; secondary destinations move into a surfaced menu above it. Active mobile items use porcelain text on a subtly raised charcoal field.

### Album Card

Artwork is the primary visual object. A resting low shadow, 10px clipping, small title stack, contributor ribbon, and top-right circular play control carry the interaction. Hover lifts artwork by 3px and reveals playback; touch devices expose playback without relying on hover. Unavailable items remove the lift and visibly label their state.

### Album Feed Row

The feed reads left to right as three regions: 88px artwork, the album's title with its year beneath, and the artist's logo centred in the middle of the row, with the track count closing on the right. The year sits under the title rather than after the artist because it belongs to the record, not the person who made it. The artwork is the row's anchor and carries the weight the row is built around, so the title takes Subheading rather than Title, and the logo is set at 32px — a size to be read at, not a mark to be recognised beside something else. The artist's name appears here only when they have no logo, and takes the same standing the lettering would.

One row carries two actions, and which one a press means is decided by where it lands: the artwork starts the album, everywhere else opens it. Only the artwork announces itself — a 30px chip over the cover on hover and on keyboard focus, the cover dimming behind it — because a row that opens a page is what a row already does, while a row that begins playing is not. That replaces the play control the row used to park at its right end, which said the same thing while sitting furthest from the artwork it would play. Where there is no hover the chip is simply always there, the way the album card's is. An unavailable album renders its cover with nothing to press.

An unavailable album greys its cover and mutes its title and artist, and carries no badge: the label is sized for a full album card and does not fit a row thumbnail, and the row already says it twice over.

The two text columns share the row in fixed proportion and the count is held to what it needs, rather than any column being measured from its contents, because each row is its own grid and a content-sized column is a different width on every one of them, which walks the centred artist left and right down the list. What the row can fit is set by the feed's own width and not the window's — the home rail leaves it 400px in a 1000px window and 700px in an 880px one — so the two reductions key to the container: the track count goes below 560px, and below 380px the title and artist stack and the artist returns to the left, a column one item wide having no middle to sit in.

### Artist Row

Artists browse as an 88px divider-led row rather than a field of cards: the collection's own artwork is albums, and a wall of borrowed lettering would outrank it. Each row leads with the artist's logo fitted inside a fixed 124x54 frame, then their name and album count, then a trailing arrow that brightens and steps right on hover. The frame is a fixed box the logo is *fitted* into, never sized by — logos arrive on a shared canvas but fill wildly different fractions of it, and letting each set its own height makes the list ripple. An artist with no logo keeps the initials avatar in the same frame. Below 920px the frame tightens to 100x46 and the row to 78px.

### Artist Lettering

An artist's logo also sits beside their name wherever their name is written — album cards, the album page's subheading, the track table's artist and album-artist columns, search suggestions, the player bar, the queue, and the listening-now lines. The mark accompanies the name; it never replaces it, because these are single lines of running text where an image standing in for a word would break scanning and sorting. The two exceptions are the surfaces where the artist is the subject rather than an attribute of one: the artist header, and the album feed row's artist column, where the logo *is* the name and the name appears only when there is no logo.

Every one of these is a fixed 17px box the logo is fitted into, capped at 88px wide, with the album page's subheading taking 26px and 132px — a fixed height rather than one scaled from the surrounding type, for the reason the artist row's frame is fixed: the logos arrive on a shared canvas and fill wildly different fractions of it, so a mark sized by the line would leave one artist's lettering a legible wordmark and the next a smudge. 17px is the smallest box a thin wide wordmark still reads in, and it fits inside the track table's 56px row and the player bar without either growing.

A missing logo takes no space and leaves no gap — no placeholder, no reserved box, no initials standing in — because absence is the common case and the name is already there in text. That is also what keeps this from becoming the wall of borrowed lettering the artist row exists to avoid: the marks are a recognition cue running alongside the collection's own artwork, never a field of them.

Requests and the activity feed keep the artist as plain text. Those names are typed into a form or recorded at the time rather than read from the catalog, and a name nobody has matched to a release is not one to go looking up artwork for.

### Artist Header

The artist page is the one place borrowed artwork leads, and it has three honest shapes rather than one with holes in it, because the logo and the background arrive independently and either can be missing.

With a background, the header cancels the content pane's padding and runs edge to edge at `clamp(232px, 29vw, 348px)`, the photograph fading in on load. Two scrims carry it: the canvas rising from the bottom edge so the header dissolves into the collection instead of ending on a rule, and the canvas darkening the leading edge so lettering and metadata hold contrast over an unpredictable frame. The logo carries its own drop shadow besides, because it is white lettering and the photograph behind it may be white too.

With only a logo, the header is typographic on the plain canvas and closes with one hairline. With neither, the artist's name is set in display type. The logo *is* the heading where it exists — an `h1` around the image carrying the name as its alt text — never a picture above the same name repeated at the same size.

This is an artist header, not the library hero the layout rules forbid: it is bounded, it belongs to one record's page rather than the collection's front, and the contributor filter and album field follow it immediately.

### Added By Filter

Attribution is browsable, not only displayed. Wherever music is listed — recently added, albums, artists, one artist's page, tracks, search, and the hidden shelf — one row of contributor pills sits between the heading and the music and narrows all of it to a single person. Pills rather than a menu: the list is the people in one Library, so it reads faster than it opens. The row carries a quiet uppercase "Added by" label, a leading "Everyone" pill, then one 32px fully rounded pill per contributor led by their 20px avatar; the selected pill takes the Slate Depth field and Slate Signal ink the contributor ribbons on the covers below already use, and pressing it again clears the filter. It offers contributors, never the member list, and disappears entirely below two of them, where the only available choice would be the whole collection twice. The selection follows the reader between those views instead of resetting per page, and an emptied view names the person rather than implying the collection is empty. Below 620px the label stacks above the row and the pills scroll horizontally without a visible scrollbar.

### Track Row

The track list is the classic-Napster utility layer: a 56px divider-led row with tabular track number and duration, format in uppercase, and truncation for long metadata. Hover reveals the row play affordance; the playing row receives the Slate Mist field. Unavailable tracks remain legible but noninteractive.

### Player & Queue

The fixed player owns the bottom horizon in Listening Black. Playback progress is a 3px full-width rail driven by a transform-bound MotionValue so continuous updates do not trigger React renders; its invisible range input remains the accessible seek control. The queue is a high-elevation dark overlay with focus moved inside on open, trapped while open, dismissed by Escape, and restored to its trigger on close.

### Dialogs & Menus

Temporary layers use `role="dialog"` where appropriate, a labelled accessible name, initial focus, Tab containment, Escape dismissal, backdrop dismissal only from the backdrop itself, and trigger focus restoration. Motion settles in 200–300ms using the shared fast ease; reduced-motion preference collapses animation and transition durations to effectively zero. On small screens, dialogs attach to the bottom edge as sheets. A dialog outranks the fixed player and the mobile navigation in the stack — anything less clips its own actions out of reach on a narrow screen — and yields only to the toast.

Reversible changes keep their inline confirmation in the row they belong to. A dialog is for the ones that cannot be taken back, and it states the consequence rather than asking whether the reader is sure. Where the irreversible action has two honest outcomes, both are offered as equal rows with the safer one leading, not as a button and a piece of small print.

### Held Confirmation

The one action that ends the collection is confirmed twice: a dialog, then a press held for ten seconds. The control fills left to right from a transform-bound MotionValue, for the same reason the player's progress rail is — it updates every frame and must not re-render the dialog around it. Releasing early resets the fill and does nothing. It answers pointer and keyboard alike, since a control reachable by Tab and impossible to complete without a mouse is not reachable. The delay is a safeguard, not decoration: a reduced-motion preference shortens neither it nor the fill that reports it.

### First Run

Two authored screens carry someone from an invitation link into the collection, and neither is a tour.

- **Invitation.** The join form sits beside the evidence for filling it in: a wall of real covers from the collection behind the link, and one line of facts — albums, people, collecting since. The covers are decorative proof, so they carry no alt text and no link. Below 920px the frame stacks and the wall trims to two rows; the join card stays a card at every width rather than taking sign-in's full-bleed treatment, so the action never falls past the fold.
- **Arrival.** Shown once, to a member who did not start this collection. Library name, who is here, and a short field of recently added records with their contributor ribbons intact — each one a single control that starts playback and enters the app in one press. The one line of instruction names only what that member's permissions actually allow.

Neither screen blocks the collection, repeats itself, or teaches the interface. The host's empty "Start the collection" state is not onboarding for an invited member — it is the opposite case, and must never stand in for this one.


## Do's and Don'ts

### Do:

- **Do** let album artwork carry most of the screen's color while the interface remains mineral and quiet.
- **Do** keep browsing, contribution, request, activity, and playback context inside one continuous listening frame.
- **Do** use dense, format-aware track rows with tabular time values and clear unavailable state.
- **Do** reserve Slate Signal for focus, selection, playback, attribution, and meaningful workflow state.
- **Do** use fast, interruptible transitions and honor reduced-motion preference globally.
- **Do** preserve focus containment, Escape dismissal, and focus restoration for every overlay.

### Don't:

- **Don't** introduce an oversized library hero, a centered dashboard stage, or nested cards around the album field.
- **Don't** turn the slate accent into a decorative wash or let interface chrome compete with cover art.
- **Don't** add nostalgic Napster chrome; borrow only its compact, useful metadata density.
- **Don't** use a second typeface, ornamental display type, or loose marketing-page typography.
- **Don't** use high shadows on ordinary rows, cards, or navigation surfaces.
- **Don't** hide essential playback actions behind hover on touch devices or create an overlay without complete keyboard behavior.
