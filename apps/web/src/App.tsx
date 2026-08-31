import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion, useMotionValue } from "motion/react";
import { ApiFailure, api, handleUnauthenticated, patch, post, remove, setSignedIn, upload } from "./api";
import { ArtistLettering, ArtistName } from "./artistLogos";
import { Icon, type IconName } from "./icons";
import { PlayerBar, formatTime, usePlayer } from "./player";
import { Permission, can } from "./session";
import { sortTracks, type TrackSort, type TrackSortKey } from "./trackSorting";
import { useApiResource, useApiResources, useDebounced } from "./useApi";
import type { Activity, AdminCapabilities, Album, Artist, InvitationPreview, LibraryOverview, Member, MusicBrainzReleaseGroup, MusicBrainzSearchResult, MusicRequest, Person, Profile, RestartResult, SessionUser, SkippedFile, Track } from "./types";
import { MUSICBRAINZ_FIELD_GROUPS, MUSICBRAINZ_SEARCH_FIELDS, rangeParams, type MusicBrainzSearchField } from "@commonwax/shared";

type View = "home" | "albums" | "artists" | "tracks" | "requests" | "activity" | "people" | "hidden" | "search" | "library" | "profile" | "admin" | "settings";

/**
 * Everywhere the shell can be: the selected view, the album or person layered
 * over it, the search that produced it, and the upload flow (`undefined` means
 * "not uploading", `null` means "adding music unprompted").
 *
 * This is also the address. Each location is pushed onto the browser's history
 * with a path of its own, so Back is the system's Back, a reload lands where
 * the reader was, and an album or an artist can be sent to somebody.
 */
export type Location = { view: View; albumId: string | null; artistId: string | null; profileId: string | null; query: string; uploadRequest: MusicRequest | null | undefined };

export const HOME: Location = { view: "home", albumId: null, artistId: null, profileId: null, query: "", uploadRequest: undefined };

/** Identity of a location — distinct wherever the rendered page differs. */
function locationKey(at: Location) {
  return `${at.view}|${at.albumId ?? ""}|${at.artistId ?? ""}|${at.profileId ?? ""}|${at.query}|${at.uploadRequest === undefined ? "" : `upload-${at.uploadRequest?.id ?? "library"}`}`;
}

/** The views that own a top-level path; everything else is addressed by its detail. */
const PATH_VIEWS: readonly View[] = ["albums", "artists", "tracks", "requests", "activity", "people", "hidden", "library", "admin", "settings"];

/**
 * The address bar for a location. Detail pages win over the view behind them,
 * because a link to an album should open the album wherever it was opened from.
 */
export function pathFor(at: Location): string {
  if (at.uploadRequest !== undefined) return at.uploadRequest ? `/upload/${at.uploadRequest.id}` : "/upload";
  if (at.albumId) return `/albums/${encodeURIComponent(at.albumId)}`;
  if (at.artistId) return `/artists/${encodeURIComponent(at.artistId)}`;
  if (at.profileId) return `/people/${encodeURIComponent(at.profileId)}`;
  if (at.view === "search") return at.query ? `/search?q=${encodeURIComponent(at.query)}` : "/search";
  if (at.view === "home") return "/";
  if (at.view === "settings") return "/settings";
  return `/${at.view}`;
}

/**
 * The reverse, for a cold load: a pasted link, a bookmark, a reload. Back and
 * forward within a session do not come through here — those carry the whole
 * location in the history entry, including the request an upload is fulfilling,
 * which a path cannot express.
 *
 * `/upload/<id>` is the one address that cannot be restored, because the
 * request it names has to be read from the API before the page means anything.
 * It resolves to the Requests view, which is where that workflow starts.
 */
export function locationFromPath(pathname: string, search: string): Location {
  const [, head = "", tail = ""] = pathname.split("/");
  const detail = tail ? decodeURIComponent(tail) : "";
  if (head === "upload") return detail ? { ...HOME, view: "requests" } : { ...HOME, uploadRequest: null };
  if (head === "albums" && detail) return { ...HOME, view: "albums", albumId: detail };
  if (head === "artists" && detail) return { ...HOME, view: "artists", artistId: detail };
  if (head === "people" && detail) return { ...HOME, view: "profile", profileId: detail };
  if (head === "search") return { ...HOME, view: "search", query: new URLSearchParams(search).get("q") ?? "" };
  const view = PATH_VIEWS.find((candidate) => candidate === head);
  return view ? { ...HOME, view } : HOME;
}

type NavEntry = {
  view: View;
  label: string;
  icon: IconName;
  /** Sidebar grouping. */
  group: "listen" | "together" | "host";
  /** Where the entry appears on small screens: the fixed bar, or behind "More". */
  mobile: "bar" | "menu";
  /**
   * Withheld unless the member holds this. The whole group disappears with its
   * last entry, so an ordinary member never sees an empty "Host" heading where
   * infrastructure would be.
   */
  permission?: Permission;
};

/**
 * The single description of the app's navigation. The sidebar, the mobile bar,
 * the mobile overflow menu, and the document title all read from it, so adding
 * a view means adding one row here plus its route below — not editing four
 * hand-maintained lists that can drift apart.
 */
const navigation: readonly NavEntry[] = [
  { view: "home", label: "Home", icon: "home", group: "listen", mobile: "bar" },
  { view: "albums", label: "Albums", icon: "albums", group: "listen", mobile: "bar" },
  { view: "artists", label: "Artists", icon: "artists", group: "listen", mobile: "menu" },
  { view: "tracks", label: "Tracks", icon: "tracks", group: "listen", mobile: "menu" },
  { view: "requests", label: "Requests", icon: "request", group: "together", mobile: "bar" },
  { view: "activity", label: "Activity", icon: "activity", group: "together", mobile: "bar" },
  { view: "people", label: "People", icon: "people", group: "together", mobile: "menu" },
  { view: "hidden", label: "Hidden", icon: "hidden", group: "together", mobile: "menu" }
];

const groupLabels: Record<NavEntry["group"], string> = { listen: "Listen", together: "Together", host: "Host" };

/** Views reached from somewhere other than the nav list, so they have no row above. */
const asideLabels: Partial<Record<View, string>> = { library: "Library", search: "Search", profile: "Profile", settings: "Settings" };

/**
 * Names are the way to a person's page, and they appear at every depth of this
 * file — on a cover, inside a request card, down the activity feed. One context
 * is what keeps that from becoming an `onOpenProfile` prop threaded through
 * every component between the shell and a `<small>`.
 */
const ProfileNavigation = createContext<(userId: string) => void>(() => {});
const useOpenProfile = () => useContext(ProfileNavigation);

type ContributorFilter = { addedBy: Person | null; setAddedBy: (person: Person | null) => void; contributors: Person[] };

/**
 * Who added it, narrowing every browsable surface at once. It lives beside the
 * search query as shell state rather than in the address: the question is about
 * a person, not a page, so walking from albums to artists to tracks keeps
 * asking it instead of resetting at each view.
 */
const ContributorNarrowing = createContext<ContributorFilter>({ addedBy: null, setAddedBy: () => {}, contributors: [] });
const useContributorFilter = () => useContext(ContributorNarrowing);

/** A catalog path carrying only the parameters that are actually set. */
function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => value ? [[key, value] as [string, string]] : []));
  return query.size ? `${path}?${query}` : path;
}

/**
 * The filter control itself. One contributor cannot narrow anything — the
 * choice would be the whole collection either way — so it stays out of the way
 * until a second person has added music.
 */
function AddedByFilter() {
  const { addedBy, setAddedBy, contributors } = useContributorFilter();
  if (contributors.length < 2) return null;
  const pick = (person: Person) => setAddedBy(addedBy?.id === person.id ? null : person);
  return <div className="added-by" role="group" aria-label="Filter by who added it">
    <span className="added-by-label">Added by</span>
    <div className="added-by-people">
      <button type="button" className={addedBy ? "" : "active"} aria-pressed={!addedBy} onClick={() => setAddedBy(null)}>Everyone</button>
      {contributors.map((person) => <button key={person.id} type="button" className={addedBy?.id === person.id ? "active" : ""} aria-pressed={addedBy?.id === person.id} onClick={() => pick(person)}><Avatar person={person} />{person.displayName}</button>)}
    </div>
  </div>;
}

/** A person's picture, or their initials until they have chosen one. */
function Avatar({ person, className = "" }: { person: { displayName: string; avatarUrl: string | null }; className?: string }) {
  const [failed, setFailed] = useState(false);
  const picture = person.avatarUrl && !failed ? person.avatarUrl : null;
  return <span className={`avatar ${className} ${picture ? "has-picture" : ""}`}>
    {picture ? <img src={picture} alt="" loading="lazy" onError={() => setFailed(true)} /> : initials(person.displayName)}
  </span>;
}

/**
 * A name that opens the person behind it. Not every name can be one: the covers
 * in a grid already sit inside a button that plays or opens the album, and a
 * button cannot contain another, so those keep the plain `PersonName` below.
 *
 * An erased account has no page to open, so its placeholder name is rendered as
 * the text it is rather than as a control that would lead nowhere.
 */
function PersonLink({ person, className = "" }: { person: Person; className?: string }) {
  const openProfile = useOpenProfile();
  if (!person.id) return <span className={`person-erased ${className}`}>{person.displayName}</span>;
  return <button type="button" className={`person-link ${className}`} onClick={() => openProfile(person.id!)}>{person.displayName}</button>;
}

function viewLabel(view: View): string {
  return navigation.find((entry) => entry.view === view)?.label ?? asideLabels[view] ?? "Search";
}

export function App() {
  const [state, setState] = useState<"loading" | "setup" | "login" | "app">("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  // Read once. Accepting the invitation rewrites the address, and neither the
  // flow nor `bootstrap` may restart because the path it began on is gone.
  const [invitationToken] = useState(() => window.location.pathname.match(/^\/join\/([^/]+)$/)?.[1] ?? null);
  const [joined, setJoined] = useState(false);
  const [arriving, setArriving] = useState(false);

  const bootstrap = useCallback(async () => {
    if (invitationToken) return;
    const setup = await api<{ needsSetup: boolean }>("/api/setup/status");
    if (setup.needsSetup) { setState("setup"); return; }
    try {
      const session = await api<{ user: SessionUser }>("/api/session");
      setUser(session.user);
      setSignedIn(true);
      setState("app");
    } catch {
      setState("login");
    }
  }, [invitationToken]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  // A session can end while the app is open — it expires, an admin removes the
  // member, a password change elsewhere revokes it. Without this every view
  // would render "Sign in to continue." as page text and stay there.
  useEffect(() => {
    handleUnauthenticated(() => {
      setUser(null);
      setState("login");
    });
  }, []);

  // Accepting an invitation already signed them in, so the session is read
  // rather than reloaded for: a reload would throw away the one moment this
  // person gets to meet the collection they just joined.
  async function acceptedInvitation() {
    window.history.replaceState({}, "", "/");
    let session: { user: SessionUser };
    // The account and the session cookie already exist by now, so a failed read
    // here is a transient fetch — not a failed join, and never reported as one.
    try { session = await api<{ user: SessionUser }>("/api/session"); }
    catch { window.location.reload(); return; }
    setUser(session.user);
    setSignedIn(true);
    setState("app");
    setArriving(true);
    setJoined(true);
  }

  const screen = invitationToken && !joined ? <Join invitationToken={invitationToken} onJoined={acceptedInvitation} />
    : state === "loading" ? <Splash />
    : state === "setup" ? <Setup onDone={() => void bootstrap()} />
    : state === "login" ? <Login onDone={() => void bootstrap()} />
    : !user ? <Splash />
    : arriving ? <Arrival user={user} onEnter={() => setArriving(false)} />
    // A completed reset leaves no account and no Library, so the app returns to
    // the screen a fresh install opens on rather than to sign-in — `bootstrap`
    // asks `/api/setup/status`, which now answers that setup is needed.
    // A reset ends this session too, so the signed-in flag goes down before the
    // truncate can answer 401 and race `bootstrap` to the sign-in screen.
    : <Shell user={user} onUser={setUser} onReset={() => { setSignedIn(false); setUser(null); setState("loading"); void bootstrap(); }} onLogout={async () => { setSignedIn(false); await post("/api/auth/logout"); setUser(null); setState("login"); }} />;

  return <MotionConfig reducedMotion="user">{screen}</MotionConfig>;
}

function Splash() {
  return <main className="auth-page"><motion.div className="brand-mark large" animate={{ opacity: [0.55, 1, 0.55] }} transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}>cw</motion.div><p className="muted">Opening…</p></main>;
}

/**
 * `proof` is the join screen's evidence pane. Setup and sign-in have nothing to
 * prove — they keep the single centred card, including its full-bleed treatment
 * on small screens — so the frame only becomes two-up when a pane is passed.
 */
function AuthFrame({ title, instruction, proof, children }: { title: string; instruction?: string; proof?: ReactNode; children: ReactNode }) {
  const card = (
    <section className="auth-card">
      <div className="brand-lockup"><span className="brand-mark">cw</span><span>commonwax</span></div>
      <h1>{title}</h1>{instruction && <p className="auth-subtitle">{instruction}</p>}
      {children}
    </section>
  );
  if (!proof) return <main className="auth-page">{card}</main>;
  return <main className="auth-page join-page"><div className="join-frame">{proof}{card}</div></main>;
}

function Setup({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await post("/api/setup", Object.fromEntries(data)); onDone();
    } catch (issue) { setError(issue instanceof Error ? issue.message : "Setup failed."); setBusy(false); }
  }
  return <AuthFrame title="Create your library">
    <form className="stack-form" onSubmit={submit}>
      <Field label="Your name" name="displayName" autoComplete="name" required />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters" required />
      <Field label="Library name" name="libraryName" placeholder="The Listening Room" required />
      <FormError message={error} /><button className="primary wide" disabled={busy}>{busy ? "Creating…" : "Enter Commonwax"}</button>
    </form>
  </AuthFrame>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    try { await post("/api/auth/login", Object.fromEntries(data)); onDone(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Sign in failed."); setBusy(false); }
  }
  return <AuthFrame title="Sign in">
    <form className="stack-form" onSubmit={submit}>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <FormError message={error} /><button className="primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </AuthFrame>;
}

/**
 * Someone arriving here has a link and nothing else. The collection behind the
 * invitation is the only argument for filling the form, so the covers and the
 * size of it are shown before the fields rather than after the account exists.
 */
function Join({ invitationToken, onJoined }: { invitationToken: string; onJoined: () => Promise<void> }) {
  const [invite, setInvite] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<InvitationPreview>(`/api/invitations/${invitationToken}`).then(setInvite).catch((issue) => setLoadError(issue.message)); }, [invitationToken]);
  if (loadError) return <AuthFrame title="Invitation unavailable" instruction={loadError}><a className="primary button-link" href="/">Go to sign in</a></AuthFrame>;
  if (!invite) return <Splash />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      await post(`/api/invitations/${invitationToken}/accept`, Object.fromEntries(new FormData(event.currentTarget)));
      await onJoined();
    } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not join."); setBusy(false); }
  }
  const covers = invite.catalog?.covers ?? [];
  return <AuthFrame
    title={`Join ${invite.libraryName}`}
    instruction={`${invite.invitedBy} invited you.`}
    proof={covers.length ? <div className="join-proof">
      <div className="cover-wall" aria-hidden="true">{covers.map((cover, index) => <WallTile key={cover.id} title={cover.title} artworkUrl={cover.artworkUrl} index={index} />)}</div>
      <p className="join-facts">{collectionSummary(invite)}</p>
    </div> : undefined}
  >
    <form className="stack-form" onSubmit={submit}>
      <Field label="Your name" name="displayName" autoComplete="name" required />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters" required />
      <FormError message={error} /><button className="primary wide" disabled={busy}>{busy ? "Joining…" : `Join ${invite.libraryName}`}</button>
    </form>
  </AuthFrame>;
}

/** The wall is evidence, not a catalog: it carries no alt text and no link. */
function WallTile({ title, artworkUrl, index }: { title: string; artworkUrl: string; index: number }) {
  const [failed, setFailed] = useState(false);
  return <motion.span
    className={`wall-tile ${failed ? "fallback" : ""}`}
    initial={{ opacity: 0, y: 12, filter: "blur(8px)" }}
    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    transition={{ delay: 0.035 * index, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
  >{failed ? <b>{title.slice(0, 1)}</b> : <img src={artworkUrl} alt="" loading="lazy" onError={() => setFailed(true)} />}</motion.span>;
}

function collectionSummary(invite: InvitationPreview): string {
  const { memberCount } = invite.library;
  const albums = invite.catalog?.albumCount;
  return [
    albums === undefined ? null : `${albums.toLocaleString()} ${albums === 1 ? "album" : "albums"}`,
    `${memberCount} ${memberCount === 1 ? "person" : "people"}`,
    `collecting since ${monthYear(invite.library.createdAt)}`
  ].filter(Boolean).join(" · ");
}

/**
 * The one screen a member of an established Library sees exactly once. They did
 * not start this collection, so instead of the host's "add your first album"
 * they get what is already here and the shortest path to the moment the product
 * is actually about: playing a record with someone else's name on it.
 */
function Arrival({ user, onEnter }: { user: SessionUser; onEnter: () => void }) {
  const { playAlbum, playError } = usePlayAlbum();
  const { data, loading, error } = useApiResources<[{ albums: Album[] }, LibraryOverview]>(["/api/albums/recent", "/api/library/overview"]);
  if (loading) return <Splash />;
  const available = (data?.[0].albums ?? []).filter((album) => album.available);
  // Attribution is the whole point of this screen, so records carrying a name
  // lead; unattributed ones fill in behind them rather than being dropped.
  const picks = [...available.filter((album) => album.addedBy), ...available.filter((album) => !album.addedBy)].slice(0, 6);
  const overview = data?.[1] ?? null;
  const facts = overview
    ? `${overview.library.memberCount} ${overview.library.memberCount === 1 ? "person" : "people"} · collecting since ${monthYear(overview.library.createdAt)}`
    : "";
  // Only leave for the collection once something is actually playing, so a
  // stream that fails reports it here instead of on a screen they never saw.
  async function startWith(album: Album) { if (await playAlbum(album)) onEnter(); }
  // What a new member may do is a permission, not a role, so the line naming it
  // is read from the same matrix the API gates on.
  const canContribute = can(user, Permission.CONTRIBUTE);
  const canRequest = can(user, Permission.CREATE_REQUEST);
  const invitationToAct = canContribute && canRequest ? "You can add music of your own, and ask for anything that is missing."
    : canContribute ? "You can add music of your own here too."
    : canRequest ? "Ask for anything that is missing, and someone here can add it."
    : "";
  return <main className="arrival">
    <div className="arrival-frame">
      <header className="arrival-head">
        <div className="brand-lockup"><span className="brand-mark">cw</span><span>commonwax</span></div>
        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>You’re in.</motion.h1>
        <p className="arrival-library">{user.libraryName}</p>
        {facts && <p className="arrival-facts">{facts}</p>}
      </header>
      {picks.length > 0 && <>
        <p className="arrival-lead">{picks.some((album) => album.addedBy) ? "Everything here was added by someone. Start with one of theirs." : "The most recent additions to the collection."}</p>
        <div className="arrival-picks">{picks.map((album, index) => <motion.article
          key={album.id}
          initial={{ opacity: 0, y: 14, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ delay: 0.12 + 0.05 * index, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <button className="arrival-pick" onClick={() => void startWith(album)} aria-label={`Play ${album.title} by ${album.artist.name}`}>
            <span className="arrival-art">
              <Cover album={album} contributor={album.addedBy} />
              <span className="arrival-play"><Icon name="play" /></span>
            </span>
            <span className="album-title">{album.title}</span>
            <span className="album-artist"><ArtistLettering name={album.artist.name} />{album.artist.name}</span>
          </button>
        </motion.article>)}</div>
      </>}
      <FormError message={playError || error} />
      <div className="arrival-actions">
        <button className="primary" onClick={onEnter}>{picks.length ? "Start listening" : "Go to the collection"}</button>
        {invitationToAct && <p>{invitationToAct}</p>}
      </div>
    </div>
  </main>;
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const { label, hint, ...input } = props;
  return <label className="field"><span>{label}</span><input {...input} />{hint && <small>{hint}</small>}</label>;
}

function FormError({ message }: { message: string }) { return message ? <p className="form-error">{message}</p> : null; }

function Shell({ user, onLogout, onUser, onReset }: { user: SessionUser; onLogout: () => void; onUser: (user: SessionUser) => void; onReset: () => void }) {
  // One location, not five pieces of it, because it is also what goes into the
  // history entry — and a Back that restored four of the five would be worse
  // than no Back at all.
  const [here, setHere] = useState<Location>(() => locationFromPath(window.location.pathname, window.location.search));
  const { view, albumId, artistId, profileId, query: searchQuery, uploadRequest } = here;
  // How many entries this app has pushed. Read back from the history entry on
  // popstate, so it can never drift from the browser's own idea of the stack.
  const [depth, setDepth] = useState(0);
  const [addedBy, setAddedBy] = useState<Person | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuButton = useRef<HTMLButtonElement>(null);
  const mobileMenu = useRef<HTMLElement>(null);
  const [refresh, setRefresh] = useState(0);
  const [toast, setToast] = useState("");
  const canContribute = can(user, Permission.CONTRIBUTE);
  // Filtered once, so the sidebar, the mobile bar, and the overflow menu cannot
  // disagree about whether a member is offered a view the API would refuse.
  const visibleNavigation = useMemo(() => navigation.filter((entry) => !entry.permission || can(user, entry.permission)), [user]);
  const contributors = useApiResource<{ contributors: Person[] }>("/api/contributors", { reloadKey: refresh });
  const narrowing = useMemo<ContributorFilter>(
    () => ({ addedBy, setAddedBy, contributors: contributors.data?.contributors ?? [] }),
    [addedBy, contributors.data]
  );
  // Anywhere but the first entry this app pushed. Going back from there would
  // leave Commonwax, which the in-app control should not offer.
  const canGoBack = depth > 0;
  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(""), 3500); }
  function dismissChrome() { setMobileMenuOpen(false); window.scrollTo({ top: 0 }); }
  function show(next: Location) { setHere(next); dismissChrome(); }
  // Re-choosing where you already are still dismisses the menu, but must not
  // stack a duplicate entry the back button would then have to walk through.
  function go(next: Location) {
    dismissChrome();
    if (locationKey(next) === locationKey(here)) return;
    const at = depth + 1;
    // The whole location rides in the history entry. The path alone cannot
    // carry the request an upload is fulfilling, and Back has to restore it.
    window.history.pushState({ at: next, depth: at }, "", pathFor(next));
    setDepth(at);
    setHere(next);
  }
  function replaceWith(next: Location) {
    window.history.replaceState({ at: next, depth }, "", pathFor(next));
    setHere(next);
    dismissChrome();
  }
  function goBack() {
    if (canGoBack) { window.history.back(); return; }
    // Opened straight onto this page from a link, so there is nothing of ours
    // behind it and Back would leave Commonwax. Home replaces the entry rather
    // than stacking one, because what is being left — an album just deleted, an
    // upload just finished — should not be somewhere Back can return to.
    if (locationKey(here) !== locationKey(HOME)) replaceWith(HOME);
  }
  function navigate(next: View) { go({ ...HOME, view: next }); }
  function openAlbum(id: string) { go({ ...HOME, view, albumId: id }); }
  // An artist opened from a search result lands on the artists view, so the back
  // button leaves somewhere that lists artists rather than the query behind it.
  function openArtist(id: string) { go({ ...HOME, view: view === "search" ? "artists" : view, artistId: id }); }
  function openProfile(id: string) { go({ ...HOME, view: "profile", profileId: id }); }
  function openUpload(request: MusicRequest | null) { go({ ...HOME, view, uploadRequest: request }); }
  function closeMobileMenu() {
    setMobileMenuOpen(false);
    window.requestAnimationFrame(() => mobileMenuButton.current?.focus());
  }
  function runSearch(query: string) { go({ ...HOME, view: "search", query }); }

  // The first entry is the address the app was opened on, replaced rather than
  // pushed so there is nothing of ours behind it to go back to.
  useEffect(() => {
    window.history.replaceState({ at: here, depth: 0 }, "", pathFor(here));
    const onPop = (event: PopStateEvent) => {
      const state = event.state as { at?: Location; depth?: number } | null;
      setHere(state?.at ?? locationFromPath(window.location.pathname, window.location.search));
      setDepth(state?.depth ?? 0);
      dismissChrome();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // Runs once: `here` is only read for the initial entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { document.title = `${uploadRequest !== undefined ? (uploadRequest ? "Fulfill request" : "Add music") : albumId ? "Album" : artistId ? "Artist" : viewLabel(view)} · Commonwax`; }, [albumId, artistId, uploadRequest, view]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const menu = mobileMenu.current;
    window.requestAnimationFrame(() => firstFocusable(menu)?.focus());
    return () => {
      if (document.activeElement === document.body || menu?.contains(document.activeElement)) mobileMenuButton.current?.focus();
    };
  }, [mobileMenuOpen]);

  const albumChanged = () => { goBack(); setRefresh((value) => value + 1); };
  const uploadDone = (skipped: SkippedFile[]) => {
    goBack();
    setRefresh((value) => value + 1);
    // Silently dropping a track the member chose is the one outcome an upload
    // must never report as an unqualified success.
    notify(skipped.length === 0
      ? "Music imported and added to the Library."
      : skipped.length === 1
        ? `Imported. “${skipped[0].title}” was already in the Library.`
        : `Imported. ${skipped.length} tracks were already in the Library.`);
  };
  const currentView = uploadRequest !== undefined ? <UploadPage request={uploadRequest} onCancel={goBack} onDone={uploadDone} />
    : albumId ? <AlbumPage albumId={albumId} user={user} onChanged={albumChanged} />
    : artistId ? <ArtistPage artistId={artistId} onOpenAlbum={openAlbum} />
    : profileId ? <ProfilePage profileId={profileId} user={user} refresh={refresh} onUser={onUser} onOpenAlbum={openAlbum} notify={notify} />
    : view === "home" ? <Home user={user} refresh={refresh} onNavigate={navigate} onUpload={() => openUpload(null)} onOpenAlbum={openAlbum} />
    : view === "albums" ? <AlbumsPage refresh={refresh} onOpenAlbum={openAlbum} />
    : view === "hidden" ? <AlbumsPage hidden refresh={refresh} onOpenAlbum={openAlbum} />
    : view === "artists" ? <ArtistsPage refresh={refresh} onOpenArtist={openArtist} />
    : view === "tracks" ? <TracksPage refresh={refresh} />
    : view === "requests" ? <RequestsPage user={user} refresh={refresh} onRefresh={() => setRefresh((value) => value + 1)} onFulfill={openUpload} notify={notify} />
    : view === "activity" ? <ActivityPage refresh={refresh} />
    : view === "people" ? <PeoplePage user={user} refresh={refresh} notify={notify} />
    : view === "library" ? <LibraryPage user={user} refresh={refresh} />
    : view === "settings" ? <SettingsPage user={user} onUser={onUser} notify={notify} onReset={onReset} />
    : <SearchPage query={searchQuery} refresh={refresh} onOpenAlbum={openAlbum} onOpenArtist={openArtist} />;

  return (
    <ProfileNavigation.Provider value={openProfile}>
    <ContributorNarrowing.Provider value={narrowing}>
    <div className="app-shell">
        <aside className="sidebar">
          <button className="brand-lockup sidebar-brand" onClick={() => navigate("home")}><span className="brand-mark">cw</span><span>commonwax</span></button>
          <button className="library-context" onClick={() => navigate("library")} aria-current={view === "library" ? "page" : undefined} title={`About ${user.libraryName}`}><span className="library-icon"><Icon name="music" /></span><span><small>Library</small><strong>{user.libraryName}</strong></span></button>
          <nav aria-label="Primary navigation">
            {(["listen", "together"] as const).map((group) => {
              const entries = visibleNavigation.filter((entry) => entry.group === group);
              if (!entries.length) return null;
              return <Fragment key={group}>
                <span className={`nav-group-label ${group === "together" ? "community-label" : ""}`}>{groupLabels[group]}</span>
                {entries.map((entry) =>
                  <NavButton key={entry.view} active={view === entry.view} onClick={() => navigate(entry.view)} icon={entry.icon}>{entry.label}</NavButton>)}
              </Fragment>;
            })}
          </nav>
          <div className="profile-card"><button className="profile-card-open" onClick={() => openProfile(user.id)} aria-current={profileId === user.id ? "page" : undefined} title="Your profile"><Avatar person={user} /><span><strong>{user.displayName}</strong><small>{titleCase(user.role)}</small></span></button><button className={view === "settings" ? "active" : ""} aria-label="Settings" title="Settings" onClick={() => navigate("settings")}><Icon name="settings" /></button><button aria-label="Sign out" title="Sign out" onClick={onLogout}><Icon name="logout" /></button></div>
        </aside>
        <main className="main-pane">
          <header className="topbar">
            <div className="topbar-lead">
              <button className="icon-button topbar-back" onClick={goBack} disabled={!canGoBack} aria-label="Back" title="Back"><Icon name="arrow" /></button>
              <button className="mobile-library" onClick={() => navigate("library")} aria-current={view === "library" ? "page" : undefined} title={`About ${user.libraryName}`}><span className="brand-mark">cw</span><span><small>Library</small><strong>{user.libraryName}</strong></span></button>
            </div>
            <SearchField onSearch={runSearch} onOpenAlbum={openAlbum} />
            <div className="topbar-trail">
              {canContribute && <button className="primary add-music" aria-label="Add music" onClick={() => openUpload(null)}><Icon name="add" /><span>Add music</span></button>}
            </div>
          </header>
          <div className="page-content">
            <AnimatePresence initial={false} mode="wait">
              <motion.div className="view-surface" key={locationKey(here)} initial={{ opacity: 0.94, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
                {currentView}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {visibleNavigation.filter((entry) => entry.mobile === "bar").map((entry) =>
            <NavButton key={entry.view} active={view === entry.view} onClick={() => navigate(entry.view)} icon={entry.icon}>{entry.label}</NavButton>)}
          <button ref={mobileMenuButton} className={mobileMenuOpen ? "active" : ""} onClick={() => setMobileMenuOpen((open) => !open)} aria-expanded={mobileMenuOpen} aria-controls="mobile-more-menu"><Icon name="menu" />More</button>
        </nav>
        <AnimatePresence>
          {mobileMenuOpen && <motion.aside ref={mobileMenu} id="mobile-more-menu" className="mobile-menu" tabIndex={-1} onKeyDown={(event) => handleOverlayKeys(event, mobileMenu.current, closeMobileMenu)} initial={{ opacity: 0, y: 20, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: 14 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
            <header><button className="menu-library" onClick={() => navigate("library")} aria-current={view === "library" ? "page" : undefined}><small>Library</small><strong>{user.libraryName}</strong></button><button className="icon-button" onClick={closeMobileMenu} aria-label="Close menu"><Icon name="close" /></button></header>
            <nav>{visibleNavigation.filter((entry) => entry.mobile === "menu").map((entry) =>
              <NavButton key={entry.view} active={view === entry.view} onClick={() => navigate(entry.view)} icon={entry.icon}>{entry.label}</NavButton>)}</nav>
            <div className="mobile-identity"><button className="mobile-profile" onClick={() => openProfile(user.id)}><Avatar person={user} /><span><strong>{user.displayName}</strong><small>{titleCase(user.role)}</small></span></button><button className={`mobile-settings ${view === "settings" ? "active" : ""}`} aria-label="Settings" title="Settings" onClick={() => { closeMobileMenu(); navigate("settings"); }}><Icon name="settings" /></button><button className="mobile-signout" onClick={onLogout} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button></div>
          </motion.aside>}
        </AnimatePresence>
      <AnimatePresence>{toast && <motion.div className="toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>{toast}</motion.div>}</AnimatePresence>
      <PlayerBar />
    </div>
    </ContributorNarrowing.Provider>
    </ProfileNavigation.Provider>
  );
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: IconName; children: ReactNode }) {
  return <button className={active ? "active" : ""} onClick={onClick} aria-current={active ? "page" : undefined}><Icon name={icon} />{children}</button>;
}

function PageHeader({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{meta && <p>{meta}</p>}</div>{action}</header>;
}

function Home({ user, refresh, onNavigate, onUpload, onOpenAlbum }: { user: SessionUser; refresh: number; onNavigate: (view: View) => void; onUpload: () => void; onOpenAlbum: (albumId: string) => void }) {
  const [homeView, setHomeView] = useState<"feed" | "grid">("feed");
  const { addedBy } = useContributorFilter();
  const { data, loading, error } = useApiResources<[{ albums: Album[] }, { events: Activity[] }, { requests: MusicRequest[] }]>(
    [withQuery("/api/albums/recent", { addedBy: addedBy?.id }), "/api/activity", "/api/requests"],
    { reloadKey: refresh }
  );
  if (loading) return <PageLoading />;
  const albums = data?.[0].albums ?? [];
  const events = data?.[1].events ?? [];
  const requests = data?.[2].requests ?? [];
  const canInvite = can(user, Permission.INVITE_MEMBERS);
  const canContribute = can(user, Permission.CONTRIBUTE);
  const activeRequests = requests.filter((request) => request.status === "OPEN" || request.status === "CLAIMED");
  const recentAlbums = albums.slice(0, 10);
  return <>
    <FormError message={error} />
    {!albums.length && !addedBy ? <section className="empty-welcome"><div className="empty-sleeve"><Icon name="music" /></div><div><h2>Start the collection</h2><div className="button-row">{canContribute && <button className="primary" onClick={onUpload}><Icon name="add" />Add music</button>}{canInvite && <button className="secondary" onClick={() => onNavigate("people")}><Icon name="invite" />Invite friends</button>}</div></div></section> : <div className="home-stage">
      <section className="collection-stage"><header className="home-heading"><div><h1>Recently added</h1><p>{albums.length} {albums.length === 1 ? "release" : "releases"}</p></div><div className="home-heading-actions"><div className="view-toggle" role="group" aria-label="Album view"><button className={homeView === "feed" ? "active" : ""} onClick={() => setHomeView("feed")} aria-label="Feed view"><Icon name="view-feed" /></button><button className={homeView === "grid" ? "active" : ""} onClick={() => setHomeView("grid")} aria-label="Grid view"><Icon name="view-grid" /></button></div><button className="text-button" onClick={() => onNavigate("albums")}>See all <Icon name="arrow" /></button></div></header><AddedByFilter />{!albums.length ? <p className="quiet-state">Nothing from {addedBy?.displayName} yet</p> : homeView === "feed" ? <AlbumFeed albums={recentAlbums} onOpen={onOpenAlbum} /> : <AlbumGrid albums={recentAlbums} onOpen={onOpenAlbum} variant="stage" />}</section>
      <aside className="social-rail">
        <SectionHead title="Requests" action={<button className="text-button" onClick={() => onNavigate("requests")}>All <Icon name="arrow" /></button>} />
        {activeRequests.length ? <RequestPreview requests={activeRequests.slice(0, 3)} /> : <p className="quiet-state">No open requests</p>}
        <SectionHead title="Activity" action={<button className="text-button" onClick={() => onNavigate("activity")}>All <Icon name="arrow" /></button>} />
        {events.length ? <ActivityList events={events.slice(0, 5)} compact /> : <p className="quiet-state">No activity yet</p>}
      </aside>
    </div>}
  </>;
}

function AlbumsPage({ hidden = false, refresh, onOpenAlbum }: { hidden?: boolean; refresh: number; onOpenAlbum: (albumId: string) => void }) {
  const [view, setView] = useState<"grid" | "feed">("grid");
  const { addedBy } = useContributorFilter();
  const { data, loading, error } = useApiResource<{ albums: Album[] }>(
    withQuery("/api/albums", { hidden: hidden ? "true" : null, addedBy: addedBy?.id }),
    { reloadKey: refresh }
  );
  if (loading) return <PageLoading />;
  const albums = data?.albums ?? [];
  return <><FormError message={error} /><PageHeader title={hidden ? "Hidden" : "Albums"} meta={hidden ? "Visible only to you" : `${albums.length} ${albums.length === 1 ? "album" : "albums"}`} action={
    <div className="view-toggle" role="group" aria-label="Album view"><button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} aria-label="Grid view"><Icon name="view-grid" /></button><button className={view === "feed" ? "active" : ""} onClick={() => setView("feed")} aria-label="Feed view"><Icon name="view-feed" /></button></div>
  } />
    <AddedByFilter />
    {albums.length ? view === "grid"
      ? <AlbumGrid albums={albums} onOpen={onOpenAlbum} />
      : <AlbumFeed albums={albums} onOpen={onOpenAlbum} />
    : <EmptyState {...emptyBrowse(addedBy, hidden ? "Nothing hidden" : "No albums", hidden ? "Albums hidden from your library appear here." : "Add music to begin.")} />}
  </>;
}

/**
 * An artist's logo where there is one, their initials where there is not.
 *
 * fanart.tv publishes these as white lettering on transparency, and the two in
 * the collection this was built against measure that way; nothing here detects a
 * dark logo, which would sit invisibly on the canvas. The image is decorative in
 * every list, because the artist's name is already beside it in text — on the
 * artist page, where the logo *is* the heading, it carries the name instead.
 */
function ArtistMark({ artist, className = "", alt = "" }: { artist: Artist; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const logo = artist.logoUrl && !failed ? artist.logoUrl : null;
  return <span className={`artist-mark ${className} ${logo ? "has-logo" : ""}`}>
    {logo
      ? <img src={logo} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      : <span className="artist-avatar">{initials(artist.name)}</span>}
  </span>;
}

function artistMeta(artist: Artist) {
  return `${artist.albumCount} ${artist.albumCount === 1 ? "album" : "albums"}`;
}

function ArtistsPage({ refresh, onOpenArtist }: { refresh: number; onOpenArtist: (artistId: string) => void }) {
  const [view, setView] = useState<"list" | "grid">("list");
  const { addedBy } = useContributorFilter();
  const { data, loading, error } = useApiResource<{ artists: Artist[] }>(withQuery("/api/artists", { addedBy: addedBy?.id }), { reloadKey: refresh });
  if (loading) return <PageLoading />;
  const artists = data?.artists ?? [];
  return <><FormError message={error} /><PageHeader title="Artists" meta={`${artists.length} ${artists.length === 1 ? "artist" : "artists"}`} action={
    <div className="view-toggle" role="group" aria-label="Artist view"><button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="List view"><Icon name="view-feed" /></button><button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} aria-label="Grid view"><Icon name="view-grid" /></button></div>
  } />
    <AddedByFilter />
    {view === "list"
      ? <div className="artist-list">{artists.map((artist) => <button key={artist.id} className="artist-row" onClick={() => onOpenArtist(artist.id)}><ArtistMark artist={artist} /><span className="artist-row-text"><strong>{artist.name}</strong><small>{artistMeta(artist)}</small></span><Icon name="arrow" /></button>)}</div>
      : <div className="artist-grid">{artists.map((artist) => <button key={artist.id} className="artist-card" onClick={() => onOpenArtist(artist.id)}><ArtistMark artist={artist} /><span className="artist-card-text"><strong>{artist.name}</strong><small>{artistMeta(artist)}</small></span></button>)}</div>
    }
    {!artists.length && <EmptyState {...emptyBrowse(addedBy, "No artists", "Add music to begin.")} />}
  </>;
}

function TracksPage({ refresh }: { refresh: number }) {
  const [sort, setSort] = useState<TrackSort>({ key: "albumArtist", direction: "asc" });
  const { addedBy } = useContributorFilter();
  const { data, loading, error } = useApiResource<{ tracks: Track[] }>(withQuery("/api/tracks", { addedBy: addedBy?.id }), { reloadKey: refresh });
  const tracks = useMemo(() => data?.tracks ?? [], [data]);
  const sortedTracks = useMemo(() => sortTracks(tracks, sort), [sort, tracks]);
  function changeSort(key: TrackSortKey) { setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" })); }
  if (loading) return <PageLoading />;
  return <><FormError message={error} /><PageHeader title="Tracks" meta={`${tracks.length} tracks · sorted by ${sortLabel(sort.key)}`} /><AddedByFilter />{tracks.length ? <TrackTable tracks={sortedTracks} sort={sort} onSort={changeSort} /> : <EmptyState {...emptyBrowse(addedBy, "No tracks", "Add music to begin.")} />}</>;
}

type SearchResults = { artists: Artist[]; albums: Album[]; tracks: Track[] };

const NO_RESULTS: SearchResults = { artists: [], albums: [], tracks: [] };

/** How much of each kind the dropdown answers with before deferring to the page. */
const SUGGESTION_LIMITS = { artists: 3, albums: 4, tracks: 5 };

type Suggestion =
  | { key: string; kind: "artist"; artist: Artist }
  | { key: string; kind: "album"; album: Album }
  | { key: string; kind: "track"; track: Track; queue: Track[]; index: number }
  | { key: string; kind: "all" };

const suggestionGroups: Partial<Record<Suggestion["kind"], string>> = { artist: "Artists", album: "Albums", track: "Tracks" };

/**
 * The collection answers while you type. The field holds what was typed; a
 * debounced copy is what the API sees, so a fast typist spends one request
 * rather than one per keystroke, and results already on screen stay put until
 * better ones arrive instead of blinking out between letters.
 *
 * A suggestion goes straight to the thing — an album opens, a track plays — and
 * Enter with nothing highlighted still opens the full results page, which is
 * the only place the whole answer lives.
 */
function SearchField({ onSearch, onOpenAlbum }: { onSearch: (query: string) => void; onOpenAlbum: (albumId: string) => void }) {
  const player = usePlayer();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const typed = value.trim();
  const query = useDebounced(typed, 200);
  // A single letter matches most of a collection: that is noise, not an answer.
  const asking = query.length > 1;
  const { data, loading } = useApiResource<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`, { skip: !asking });
  const results = typed.length > 1 ? data ?? NO_RESULTS : NO_RESULTS;
  const suggestions = useMemo<Suggestion[]>(() => {
    const tracks = results.tracks.slice(0, SUGGESTION_LIMITS.tracks);
    return [
      ...results.artists.slice(0, SUGGESTION_LIMITS.artists).map((artist) => ({ key: `artist-${artist.id}`, kind: "artist" as const, artist })),
      ...results.albums.slice(0, SUGGESTION_LIMITS.albums).map((album) => ({ key: `album-${album.id}`, kind: "album" as const, album })),
      ...tracks.map((track, index) => ({ key: `track-${track.id}`, kind: "track" as const, track, queue: tracks, index })),
      { key: "all", kind: "all" as const }
    ];
  }, [results]);
  const found = suggestions.length > 1;
  // The debounce is part of the wait, so the field says "searching" from the
  // keystroke rather than claiming no matches for the 200ms before it asks.
  const searching = loading || query !== typed;
  const showing = open && typed.length > 1;

  function dismiss() { setOpen(false); setActive(-1); }
  function search(text: string) { if (!text) return; setValue(text); dismiss(); onSearch(text); }
  function choose(suggestion: Suggestion) {
    if (suggestion.kind === "artist") return search(suggestion.artist.name);
    if (suggestion.kind === "all") return search(typed);
    if (suggestion.kind === "album") { dismiss(); return onOpenAlbum(suggestion.album.id); }
    if (!suggestion.track.available) return;
    dismiss();
    player.play(suggestion.queue, suggestion.index);
  }
  function move(step: number) {
    const total = suggestions.length;
    if (!total) return;
    setActive((current) => current < 0 ? (step > 0 ? 0 : total - 1) : (current + step + total) % total);
  }

  function keyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (typed.length < 2) return;
      event.preventDefault();
      setOpen(true);
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && showing && active >= 0) { event.preventDefault(); choose(suggestions[active]); return; }
    // Escape retreats one step at a time: the suggestions first, the query next.
    if (event.key === "Escape") { if (showing) dismiss(); else if (value) setValue(""); return; }
    if (event.key === "Tab") dismiss();
  }

  useEffect(() => {
    if (!open) return;
    function elsewhere(event: PointerEvent) { if (!field.current?.contains(event.target as Node)) dismiss(); }
    document.addEventListener("pointerdown", elsewhere);
    return () => document.removeEventListener("pointerdown", elsewhere);
  }, [open]);

  return <div className="search-field" ref={field}>
    <form className="search-box" role="search" onSubmit={(event) => { event.preventDefault(); search(typed); }}>
      <Icon name="search" />
      <input
        ref={input}
        value={value}
        onChange={(event) => { setValue(event.target.value); setActive(-1); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={keyDown}
        placeholder="Search albums, artists, tracks"
        aria-label="Search the collection"
        role="combobox"
        aria-expanded={showing}
        aria-controls="search-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={showing && active >= 0 ? `search-option-${active}` : undefined}
        autoComplete="off"
      />
      {value && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setValue(""); dismiss(); input.current?.focus(); }}><Icon name="close" /></button>}
    </form>
    <AnimatePresence>
      {showing && <motion.div
        className="search-menu"
        id="search-suggestions"
        role="listbox"
        aria-label={`Results for ${typed}`}
        initial={{ opacity: 0, y: -5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        {!found && <p className="search-note" role="presentation">{searching ? "Searching…" : `Nothing matches “${typed}”`}</p>}
        {suggestions.map((suggestion, index) => <Fragment key={suggestion.key}>
          {suggestion.kind !== suggestions[index - 1]?.kind && suggestionGroups[suggestion.kind] && <p className="search-group" role="presentation">{suggestionGroups[suggestion.kind]}</p>}
          <button
            type="button"
            role="option"
            id={`search-option-${index}`}
            aria-selected={index === active}
            aria-disabled={suggestion.kind === "track" && !suggestion.track.available}
            className={`search-option ${suggestion.kind} ${index === active ? "active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActive(index)}
            onClick={() => choose(suggestion)}
          >{suggestionRow(suggestion, typed)}</button>
        </Fragment>)}
      </motion.div>}
    </AnimatePresence>
  </div>;
}

function suggestionRow(suggestion: Suggestion, typed: string) {
  if (suggestion.kind === "artist") return <>
    <span className="artist-avatar suggest-avatar">{initials(suggestion.artist.name)}</span>
    <span className="suggest-text"><strong><ArtistLettering name={suggestion.artist.name} />{suggestion.artist.name}</strong><small>{suggestion.artist.albumCount} {suggestion.artist.albumCount === 1 ? "album" : "albums"}</small></span>
  </>;
  if (suggestion.kind === "album") return <>
    <SuggestArt src={suggestion.album.available ? suggestion.album.artworkUrl : null} />
    <span className="suggest-text"><strong>{suggestion.album.title}</strong><small><ArtistLettering name={suggestion.album.artist.name} />{suggestion.album.artist.name}{suggestion.album.year ? ` · ${suggestion.album.year}` : ""}</small></span>
    {!suggestion.album.available && <span className="track-unavailable">Off</span>}
  </>;
  if (suggestion.kind === "track") return <>
    <SuggestArt src={suggestion.track.available ? suggestion.track.album.artworkUrl : null} />
    <span className="suggest-text"><strong>{suggestion.track.title}</strong><small><ArtistLettering name={suggestion.track.artist.name} />{suggestion.track.artist.name} · {suggestion.track.album.title}</small></span>
    {suggestion.track.available ? <span className="suggest-play"><Icon name="play" /></span> : <span className="track-unavailable">Off</span>}
  </>;
  return <>
    <span className="suggest-all-icon"><Icon name="search" /></span>
    <span className="suggest-text"><strong>See all results for “{typed}”</strong></span>
    <Icon name="arrow" />
  </>;
}

function SuggestArt({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="suggest-art fallback"><Icon name="music" /></span>;
  return <img className="suggest-art" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function SearchPage({ query, refresh, onOpenAlbum, onOpenArtist }: { query: string; refresh: number; onOpenAlbum: (albumId: string) => void; onOpenArtist: (artistId: string) => void }) {
  const { addedBy } = useContributorFilter();
  const { data, loading, error } = useApiResource<{ artists: Artist[]; albums: Album[]; tracks: Track[] }>(
    withQuery("/api/search", { q: query, addedBy: addedBy?.id }),
    { reloadKey: refresh }
  );
  if (loading) return <PageLoading />;
  const result = data ?? { artists: [], albums: [], tracks: [] };
  const empty = !result.artists.length && !result.albums.length && !result.tracks.length;
  return <><FormError message={error} /><PageHeader title={`“${query}”`} meta={`${result.albums.length} albums · ${result.tracks.length} tracks`} /><AddedByFilter />{empty && <EmptyState title="No matches" text={addedBy ? `Nothing ${addedBy.displayName} added matches this search.` : "Try another artist, album, or track."} />}
    {result.artists.length > 0 && <><SectionHead title="Artists" /><div className="search-artists">{result.artists.map((artist) => <button key={artist.id} onClick={() => onOpenArtist(artist.id)}><ArtistMark artist={artist} className="search-mark" /><strong>{artist.name}</strong></button>)}</div></>}
    {result.albums.length > 0 && <><SectionHead title="Albums" /><AlbumGrid albums={result.albums} onOpen={onOpenAlbum} /></>}
    {result.tracks.length > 0 && <><SectionHead title="Tracks" /><TrackTable tracks={result.tracks} /></>}
  </>;
}

function RequestPreview({ requests }: { requests: MusicRequest[] }) {
  return <div className="request-preview">{requests.map((request) => <article key={request.id}>
    <span className={`status ${request.status.toLowerCase()}`}>{titleCase(request.status)}</span>
    <strong>{request.album}</strong>
    <span>{request.artist}</span>
    <small>{request.status === "CLAIMED" && request.claimant ? `${request.claimant.displayName} is fulfilling` : `Requested by ${request.requester.displayName}`} · {relativeDate(request.createdAt)}</small>
  </article>)}</div>;
}

function RequestsPage({ user, refresh, onRefresh, onFulfill, notify }: { user: SessionUser; refresh: number; onRefresh: () => void; onFulfill: (request: MusicRequest) => void; notify: (message: string) => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { data, error: loadError } = useApiResource<{ requests: MusicRequest[] }>("/api/requests", { reloadKey: refresh });
  const requests = data?.requests ?? [];
  async function claim(request: MusicRequest) { try { await post(`/api/requests/${request.id}/claim`); notify(`You claimed ${request.album}.`); onRefresh(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not claim request."); } }
  // The API lets a library manager cancel anybody's request, not just their own
  // — offering it only to the requester left the other half unreachable.
  const manages = can(user, Permission.MANAGE_MEMBERS);
  function canCancel(request: MusicRequest) { return manages || request.requester.id === user.id; }
  async function cancel(request: MusicRequest) { try { await post(`/api/requests/${request.id}/cancel`); setConfirmingCancel(null); notify("Request cancelled."); onRefresh(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not cancel request."); } }
  const canRequest = can(user, Permission.CREATE_REQUEST);
  return <><PageHeader title="Requests" meta={`${requests.length} total`} action={canRequest && <button className={createOpen ? "secondary" : "primary"} onClick={() => setCreateOpen((open) => !open)} aria-expanded={createOpen}><Icon name={createOpen ? "close" : "add"} />{createOpen ? "Close" : "New request"}</button>} />
    <AnimatePresence initial={false}>{createOpen && <motion.section className="inline-workflow request-composer" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}><RequestComposer onCreated={() => { setCreateOpen(false); onRefresh(); notify("Request shared with the Library."); }} onCancel={() => setCreateOpen(false)} /></motion.section>}</AnimatePresence>
    <FormError message={error || loadError} />
    <div className="request-list">{requests.map((request) => <article className="request-card" key={request.id}><span className={`status ${request.status.toLowerCase()}`}>{titleCase(request.status)}</span><div className="request-card-content">{request.coverArtUrl && <img className="request-cover" src={request.coverArtUrl} alt="" />}<div><h3>{request.album}</h3><p>{request.artist}{request.year ? ` · ${request.year}` : ""}</p><small>Requested by <PersonLink person={request.requester} /> · {relativeDate(request.createdAt)}</small>{request.claimant && request.status !== "FULFILLED" && <small>Claimed by <PersonLink person={request.claimant} /></small>}{request.fulfiller && <small>Fulfilled by <PersonLink person={request.fulfiller} /></small>}{request.fulfilledAlbum && !request.fulfilledAlbum.available && <small className="unavailable-copy">Album unavailable in Navidrome</small>}</div></div><div className="request-action">
        {request.status === "OPEN" && request.requester.id !== user.id && can(user, Permission.FULFILL_REQUEST) && <button className="secondary" onClick={() => void claim(request)}>I have this</button>}
        {request.status === "CLAIMED" && request.claimant?.id === user.id && <button className="primary" onClick={() => onFulfill(request)}>Upload to fulfill</button>}
        {(request.status === "OPEN" || request.status === "CLAIMED") && canCancel(request) && (confirmingCancel === request.id ? <span className="confirm-actions"><button className="danger-text" onClick={() => void cancel(request)}>Confirm cancel</button><button className="text-button" onClick={() => setConfirmingCancel(null)}>Keep</button></span> : <button className="text-button" onClick={() => setConfirmingCancel(request.id)}>Cancel request</button>)}
      </div></article>)}</div>
    {!requests.length && <EmptyState
      title="No requests yet"
      text={canRequest ? "Ask for an album nobody here has added. Anyone in the Library can fill it." : "When someone is looking for an album, their request will show up here."}
      action={canRequest && !createOpen ? <button className="primary" onClick={() => setCreateOpen(true)}>Request an album</button> : undefined}
    />}
  </>;
}

/** One MusicBrainz filter, rendered by the kind of value the index expects. */
function FilterField({ field, values, onChange }: { field: MusicBrainzSearchField; values: Record<string, string>; onChange: (name: string, value: string) => void }) {
  if (field.kind === "dateRange" || field.kind === "numberRange") {
    const { from, to } = rangeParams(field.name);
    const year = field.kind === "dateRange";
    return <div className="field filter-range">
      <span>{field.label}</span>
      <div className="filter-range-inputs">
        <input inputMode="numeric" value={values[from] ?? ""} onChange={(event) => onChange(from, event.target.value)} placeholder={year ? "From year" : "Least"} aria-label={`${field.label}, lower bound`} />
        <span className="filter-range-dash" aria-hidden="true">–</span>
        <input inputMode="numeric" value={values[to] ?? ""} onChange={(event) => onChange(to, event.target.value)} placeholder={year ? "To year" : "Most"} aria-label={`${field.label}, upper bound`} />
      </div>
      <small>{field.hint}</small>
    </div>;
  }
  if (field.kind === "enum") {
    return <label className="field">
      <span>{field.label}</span>
      <select value={values[field.name] ?? ""} onChange={(event) => onChange(field.name, event.target.value)}>
        <option value="">Any</option>
        {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <small>{field.hint}</small>
    </label>;
  }
  return <label className="field">
    <span>{field.label}</span>
    <input value={values[field.name] ?? ""} onChange={(event) => onChange(field.name, event.target.value)} placeholder={field.kind === "mbid" ? "00000000-0000-0000-0000-000000000000" : ""} spellCheck={field.kind !== "mbid"} />
    <small>{field.hint}</small>
  </label>;
}

/** Artwork the Cover Art Archive may not hold; the initial stands in when it doesn't. */
function ReleaseArt({ release, className }: { release: MusicBrainzReleaseGroup; className: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [release.id]);
  if (failed) return <span className={`${className} release-art-fallback`} aria-hidden="true"><b>{release.title.slice(0, 1)}</b></span>;
  return <img className={className} src={release.coverArtUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** Year, type, and edition — the facts that tell two identically titled albums apart. */
function ReleaseMeta({ release }: { release: MusicBrainzReleaseGroup }) {
  const parts = [
    release.year ? String(release.year) : null,
    release.primaryType,
    ...release.secondaryTypes,
    release.releaseCount ? `${release.releaseCount} ${release.releaseCount === 1 ? "release" : "releases"}` : null
  ].filter(Boolean) as string[];
  return <span className="release-meta">{parts.map((part, index) => <Fragment key={part}>{index > 0 && <i aria-hidden="true">·</i>}{part}</Fragment>)}</span>;
}

const PROMINENT_FIELDS = MUSICBRAINZ_SEARCH_FIELDS.filter((field) => field.prominent);
const FILTER_FIELDS = MUSICBRAINZ_SEARCH_FIELDS.filter((field) => !field.prominent);
const SEARCH_PAGE_SIZE = 25;

/** The query parameters one field occupies — two for a range, otherwise its own name. */
function fieldParams(field: MusicBrainzSearchField): string[] {
  if (field.kind !== "dateRange" && field.kind !== "numberRange") return [field.name];
  const { from, to } = rangeParams(field.name);
  return [from, to];
}

// Matched by exact parameter name, not by prefix: `releasegroupaccent` begins
// with the prominent `releasegroup` and would otherwise never be counted.
const PROMINENT_PARAMS = new Set(PROMINENT_FIELDS.flatMap(fieldParams));

function RequestComposer({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<MusicBrainzSearchResult | null>(null);
  const [selected, setSelected] = useState<MusicBrainzReleaseGroup | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef(0);

  const filled = Object.entries(values).filter(([, value]) => value.trim()).map(([name]) => name);
  const extraFilters = filled.filter((name) => !PROMINENT_PARAMS.has(name)).length;

  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function clear() {
    setValues({});
    setFound(null);
    setSelected(null);
    setError("");
  }

  function search(offset = 0) {
    if (!filled.length) return;
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) if (value.trim()) params.set(name, value.trim());
    params.set("limit", String(SEARCH_PAGE_SIZE));
    params.set("offset", String(offset));
    // Only the newest search may write to state: a slow earlier one must not
    // replace the results somebody is already reading.
    const ticket = ++attempt.current;
    setSelected(null);
    setSearching(true);
    setError("");
    api<MusicBrainzSearchResult>(`/api/requests/search?${params}`)
      .then((data) => { if (ticket === attempt.current) setFound(data); })
      .catch((issue) => { if (ticket === attempt.current) { setFound(null); setError(issue instanceof Error ? issue.message : "Could not search MusicBrainz."); } })
      .finally(() => { if (ticket === attempt.current) setSearching(false); });
  }

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    setError("");
    try {
      await post("/api/requests", {
        artist: selected.artist,
        album: selected.title,
        musicBrainzReleaseGroupId: selected.id,
        year: selected.year
      });
      onCreated();
    } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not create request."); setSubmitting(false); }
  }

  const results = found?.results ?? [];
  const shown = (found?.offset ?? 0) + results.length;
  const more = found ? shown < found.total : false;

  return <div className="request-composer-inner">
    <div className="workflow-heading"><h2>Request an album</h2><p>Search MusicBrainz for the album you want added to the Library.</p></div>
    <form className="request-search" onSubmit={(event) => { event.preventDefault(); search(0); }}>
      <div className="request-search-primary">
        {PROMINENT_FIELDS.map((field) => <FilterField key={field.name} field={field} values={values} onChange={update} />)}
      </div>
      <div className="request-search-actions">
        <button type="button" className="text-button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}>
          <Icon name="chevron" className={filtersOpen ? "filter-chevron open" : "filter-chevron"} />
          {filtersOpen ? "Fewer filters" : "More filters"}
          {!filtersOpen && extraFilters > 0 && <span className="filter-count">{extraFilters}</span>}
        </button>
        <div className="request-search-buttons">
          {filled.length > 0 && <button type="button" className="text-button" onClick={clear}>Clear</button>}
          <button type="submit" className="secondary" disabled={!filled.length || searching}><Icon name="search" />{searching ? "Searching…" : "Search"}</button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {filtersOpen && <motion.div className="request-filters" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
          {MUSICBRAINZ_FIELD_GROUPS.map((group) => {
            const fields = FILTER_FIELDS.filter((field) => field.group === group);
            if (!fields.length) return null;
            return <fieldset className="filter-group" key={group}>
              <legend>{group}</legend>
              <div className="filter-grid">{fields.map((field) => <FilterField key={field.name} field={field} values={values} onChange={update} />)}</div>
            </fieldset>;
          })}
        </motion.div>}
      </AnimatePresence>
    </form>

    {selected
      ? <div className="request-selected">
          <ReleaseArt release={selected} className="request-selected-art" />
          <div className="request-selected-info">
            <strong>{selected.title}{selected.disambiguation && <em className="release-disambiguation"> ({selected.disambiguation})</em>}</strong>
            <span className="request-selected-artist">{selected.artist}</span>
            <ReleaseMeta release={selected} />
          </div>
          <button type="button" className="text-button" onClick={() => setSelected(null)}>Change</button>
        </div>
      : found && <>
          <p className="request-results-summary">{found.total === 0
            ? "No albums match these filters."
            : `Showing ${results.length} of ${found.total.toLocaleString()} ${found.total === 1 ? "album" : "albums"}.`}</p>
          {results.length > 0 && <div className="request-results" role="listbox" aria-label="Search results">
            {results.map((release) => <button type="button" role="option" aria-selected="false" key={release.id} className="request-result" onClick={() => setSelected(release)}>
              <ReleaseArt release={release} className="request-result-art" />
              <span className="request-result-info">
                <strong>{release.title}{release.disambiguation && <em className="release-disambiguation"> ({release.disambiguation})</em>}</strong>
                <span className="request-result-artist">{release.artist}</span>
                <ReleaseMeta release={release} />
              </span>
            </button>)}
          </div>}
          {more && <button type="button" className="text-button request-results-more" disabled={searching} onClick={() => search(shown)}>Show more</button>}
        </>}

    {searching && !found && <p className="quiet-state">Searching MusicBrainz…</p>}
    <FormError message={error} />
    <div className="workflow-actions"><button type="button" className="secondary" onClick={onCancel} disabled={submitting}>Cancel</button><button type="button" className="primary" disabled={!selected || submitting} onClick={() => void submit()}>{submitting ? "Requesting…" : "Request"}</button></div>
  </div>;
}

function ActivityPage({ refresh }: { refresh: number }) {
  const { data, loading, error } = useApiResource<{ events: Activity[] }>("/api/activity", { reloadKey: refresh });
  if (loading) return <PageLoading />;
  const events = data?.events ?? [];
  return <><FormError message={error} /><PageHeader title="Activity" />{events.length ? <ActivityList events={events} /> : <EmptyState title="No activity" text="Add music, invite someone, or make a request." />}</>;
}

function PeoplePage({ user, refresh, notify }: { user: SessionUser; refresh: number; notify: (message: string) => void }) {
  const [memberRefresh, setMemberRefresh] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canInvite = can(user, Permission.INVITE_MEMBERS);
  const canManage = can(user, Permission.MANAGE_MEMBERS);
  const { data, error: loadError } = useApiResource<{ members: Member[] }>("/api/members", { reloadKey: `${refresh}:${memberRefresh}` });
  const members = data?.members ?? [];
  const reload = () => setMemberRefresh((value) => value + 1);
  function failed(issue: unknown, fallback: string) { setError(issue instanceof Error ? issue.message : fallback); }
  async function makeInvite() { setError(""); try { const result = await post<{ url: string }>("/api/invitations", { role: "MEMBER", daysValid: 7 }); setInviteUrl(result.url); setInviteOpen(true); } catch (issue) { failed(issue, "Could not create invitation."); } }
  async function copyInvite() { await navigator.clipboard.writeText(inviteUrl); notify("Invitation link copied."); }
  async function changeRole(membershipId: string, role: string) { setError(""); try { await patch(`/api/members/${membershipId}`, { role }); reload(); notify("Member role updated."); } catch (issue) { failed(issue, "Could not update role."); } }
  async function setUploads(member: Member, blocked: boolean) {
    setError("");
    try {
      await patch(`/api/members/${member.id}`, { uploadsBlocked: blocked });
      reload();
      notify(blocked ? `${member.user.displayName} can no longer add music.` : `${member.user.displayName} can add music again.`);
    } catch (issue) { failed(issue, "Could not change who can add music."); }
  }
  async function removeMember(music: "keep" | "delete") {
    if (!removing) return;
    setError(""); setBusy(true);
    const name = removing.user.displayName;
    try {
      const result = await remove<{ removedAlbums: number }>(`/api/members/${removing.id}?music=${music}`);
      setRemoving(null);
      reload();
      notify(music === "keep"
        ? `${name} was removed. Their music stays in the collection.`
        : `${name} was removed, along with ${result.removedAlbums} ${result.removedAlbums === 1 ? "album" : "albums"}.`);
    } catch (issue) { failed(issue, "Could not remove this member."); }
    finally { setBusy(false); }
  }
  return <><PageHeader title="People" meta={`${members.length} ${members.length === 1 ? "member" : "members"}`} action={canInvite && <button className={inviteOpen ? "secondary" : "primary"} onClick={() => inviteOpen ? setInviteOpen(false) : void makeInvite()} aria-expanded={inviteOpen}><Icon name={inviteOpen ? "close" : "invite"} />{inviteOpen ? "Close" : "Invite"}</button>} />
    <AnimatePresence initial={false}>{inviteOpen && <motion.section className="inline-workflow invite-workflow" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}><div className="workflow-heading"><h2>Invitation link</h2><p>Expires in 7 days and works once.</p></div><div className="copy-row"><input value={inviteUrl} readOnly aria-label="Invitation link" /><button className="primary" onClick={() => void copyInvite()}>Copy link</button></div></motion.section>}</AnimatePresence>
    <FormError message={removing ? loadError : error || loadError} />
    <div className="member-list">{members.map((member) => <article key={member.id}><Avatar person={member.user} className="large-avatar" /><span><strong><PersonLink person={member.user} />{member.user.id === user.id && " (you)"}</strong><small>{member.user.email}</small>{member.uploadsBlocked && <small className="member-flag"><Icon name="block" />Cannot add music</small>}</span>{canManage && member.role !== "OWNER" && member.user.id !== user.id ? <span className="member-actions"><select aria-label={`${member.user.displayName} role`} value={member.role} onChange={(event) => void changeRole(member.id, event.target.value)}>{user.role === "OWNER" && <option value="ADMIN">Admin</option>}<option value="MEMBER">Member</option></select><button className="text-button" aria-pressed={member.uploadsBlocked} onClick={() => void setUploads(member, !member.uploadsBlocked)}>{member.uploadsBlocked ? "Allow uploads" : "Block uploads"}</button><button className="icon-button" title={`Remove ${member.user.displayName}`} aria-label={`Remove ${member.user.displayName}`} onClick={() => { setError(""); setRemoving(member); }}><Icon name="close" /></button></span> : <span className="role-pill">{titleCase(member.role)}</span>}</article>)}</div>
    <AnimatePresence>{removing && <RemoveMemberDialog member={removing} busy={busy} error={error} onCancel={() => setRemoving(null)} onRemove={(music) => void removeMember(music)} />}</AnimatePresence>
  </>;
}

/**
 * Removing somebody erases their account, so this asks the one question that
 * cannot be inferred: whether the music they added stays.
 *
 * Both answers are offered as equals rather than one being the button and the
 * other the small print. Keeping is the safer of the two and leads, but an
 * admin removing somebody whose uploads are the reason should not have to hunt
 * for the other one.
 */
function RemoveMemberDialog({ member, busy, error, onCancel, onRemove }: { member: Member; busy: boolean; error: string; onCancel: () => void; onRemove: (music: "keep" | "delete") => void }) {
  return <Modal tone="danger" title={`Remove ${member.user.displayName}?`} onClose={busy ? () => {} : onCancel}
    description="Their account is erased and they are signed out everywhere. This cannot be undone.">
    <ul className="modal-choices">
      <li>
        <div><strong>Keep their music</strong><small>Everything they added stays in the collection, credited to “someone”.</small></div>
        <button className="primary" disabled={busy} onClick={() => onRemove("keep")}>{busy ? "Removing…" : "Keep music"}</button>
      </li>
      <li>
        <div><strong>Delete their music</strong><small>Albums only they added are deleted from disk. Anything another member also added stays.</small></div>
        <button className="danger-button" disabled={busy} onClick={() => onRemove("delete")}>{busy ? "Removing…" : "Delete music"}</button>
      </li>
    </ul>
    <FormError message={error} />
    <div className="modal-actions"><button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </Modal>;
}

/**
 * The host's page, and the only place in Commonwax where the deployment itself
 * is visible. Everything on it is gated: an ordinary member has no route here
 * and no navigation entry that leads to one, which is what keeps PRODUCT.md's
 * promise that infrastructure stays invisible to the people listening.
 *
 * There is no container status readout, deliberately. The API can restart a
 * service and cannot inspect one — reading container state would have meant
 * granting the Docker access that also creates containers — so the page reports
 * what Commonwax can actually see: whether the API is answering and whether
 * Navidrome is, from `/api/health`.
 */
function AdminContent({ user, notify, onReset }: { user: SessionUser; notify: (message: string) => void; onReset: () => void }) {
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState("");
  const [confirmingReset, setConfirmingReset] = useState<"none" | "first" | "hold">("none");
  const [resetting, setResetting] = useState(false);
  const [healthTick, setHealthTick] = useState(0);
  const [refreshingArtwork, setRefreshingArtwork] = useState(false);
  const [artworkQueued, setArtworkQueued] = useState<number | null>(null);
  const capabilities = useApiResource<AdminCapabilities>("/api/admin");
  const health = useApiResource<{ status: string; database: boolean; navidrome: boolean }>("/api/health", { reloadKey: healthTick });
  const canReset = capabilities.data?.canReset ?? false;
  const services = capabilities.data?.services ?? [];
  const serviceControl = capabilities.data?.serviceControl ?? false;

  /**
   * Restarting `api` severs this request, so a rejected fetch is the expected
   * outcome rather than a failure, and neither answer is trusted: what settles
   * it is `/api/health` answering again afterwards.
   */
  async function restart(wanted: string[], label: string) {
    setError(""); setRestarting(label);
    let failures: RestartResult["failed"] = [];
    try {
      const result = await post<RestartResult>("/api/admin/restart", { services: wanted });
      failures = result.failed;
    } catch (issue) {
      if (!wanted.includes("api")) { setError(issue instanceof Error ? issue.message : "Restart failed."); setRestarting(""); return; }
    }
    if (failures.length) setError(failures.map((failure) => `${failure.service}: ${failure.error}`).join(" "));
    await waitForHealth();
    setRestarting("");
    setHealthTick((value) => value + 1);
    if (!failures.length) notify(`${label} restarted.`);
  }

  async function runReset() {
    setError(""); setResetting(true);
    try {
      await post("/api/admin/reset", { confirm: true });
      onReset();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Reset failed.");
      setResetting(false);
      setConfirmingReset("none");
    }
  }

  async function refreshArtwork() {
    setError(""); setRefreshingArtwork(true); setArtworkQueued(null);
    try {
      const result = await post<{ queued: number }>("/api/admin/refresh-artwork", {});
      setArtworkQueued(result.queued);
      notify(`${result.queued} artist${result.queued === 1 ? "" : "s"} queued for refresh.`);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Refresh failed.");
    } finally {
      setRefreshingArtwork(false);
    }
  }

  const busy = Boolean(restarting) || resetting;
  return <>
    <FormError message={error || capabilities.error} />

    <SectionHead title="Services" />
    {serviceControl ? <>
      <p className="admin-note">Restarting reloads a service in place. Nothing is deleted and the collection is untouched.</p>
      <div className="service-list">
        {services.map((service) => <article key={service}>
          <span><strong>{service}</strong><small>{serviceDescriptions[service] ?? "Part of this deployment."}</small></span>
          <button className="secondary" disabled={busy} onClick={() => void restart([service], service)}>
            <Icon name="restart" />{restarting === service ? "Restarting…" : "Restart"}
          </button>
        </article>)}
      </div>
      <div className="admin-actions">
        <button className="secondary" disabled={busy} onClick={() => void restart(services, "Everything")}>
          <Icon name="restart" />{restarting === "Everything" ? "Restarting everything…" : "Restart everything"}
        </button>
      </div>
    </> : <p className="quiet-state">This deployment has no service control configured, so nothing here can be restarted from the browser.</p>}

    <SectionHead title="Health" />
    <dl className="server-facts">
      <div><dt>API</dt><dd>{health.loading ? "…" : health.data ? "Answering" : "Not answering"}</dd></div>
      <div><dt>Database</dt><dd>{health.data?.database ? "Connected" : health.loading ? "…" : "Unreachable"}</dd></div>
      <div><dt>Navidrome</dt><dd>{health.data?.navidrome ? "Connected" : health.loading ? "…" : "Unreachable"}</dd></div>
    </dl>

    <SectionHead title="Artwork" />
    <p className="admin-note">Re-fetches every artist logo and background from fanart.tv and trims transparent edges. Processes at one artist per second, so a large library takes several minutes.</p>
    <div className="admin-actions">
      <button className="secondary" disabled={busy || refreshingArtwork} onClick={() => void refreshArtwork()}>
        <Icon name="restart" />{refreshingArtwork ? "Queuing…" : artworkQueued !== null ? `Queued ${artworkQueued} artist${artworkQueued === 1 ? "" : "s"}` : "Refresh all artwork"}
      </button>
    </div>

    {canReset && <>
      <SectionHead title="Start over" />
      <section className="danger-zone">
        <div>
          <h3><Icon name="warning" />Delete everything</h3>
          <p>Deletes every track in the collection, every account including yours, and every request, contribution, and activity record. Commonwax returns to its setup screen as though it had just been installed. There is no undo and no backup.</p>
        </div>
        <button className="danger-button" disabled={busy} onClick={() => { setError(""); setConfirmingReset("first"); }}>Delete everything</button>
      </section>
    </>}

    <AnimatePresence>
      {confirmingReset === "first" && <Modal tone="danger" title="Delete everything?" onClose={() => setConfirmingReset("none")}
        description={`Every track in ${user.libraryName}, every member, and every record of what anyone added or requested. Nothing here can be recovered afterwards.`}>
        <div className="modal-actions">
          <button className="secondary" onClick={() => setConfirmingReset("none")}>Cancel</button>
          <button className="danger-button" onClick={() => setConfirmingReset("hold")}>Continue</button>
        </div>
      </Modal>}
      {confirmingReset === "hold" && <Modal tone="danger" title="Hold to confirm" onClose={resetting ? () => {} : () => setConfirmingReset("none")}
        description="Press and hold for ten seconds. Let go at any point to stop.">
        <HoldToConfirm label="Hold to delete everything" holdingLabel="Keep holding…" disabled={resetting} onConfirm={() => void runReset()} />
        <FormError message={error} />
        <div className="modal-actions"><button className="secondary" disabled={resetting} onClick={() => setConfirmingReset("none")}>Cancel</button></div>
      </Modal>}
    </AnimatePresence>
  </>;
}

function AdminPage({ user, notify, onReset }: { user: SessionUser; notify: (message: string) => void; onReset: () => void }) {
  return <>
    <PageHeader title="Admin" meta="Only you and other admins can see this page." />
    <AdminContent user={user} notify={notify} onReset={onReset} />
  </>;
}

/** What each service is, in the terms a host reading this page thinks in. */
const serviceDescriptions: Record<string, string> = {
  api: "Commonwax itself. Restarting it signs nobody out, but interrupts playback.",
  web: "The nginx server delivering the app to browsers.",
  postgres: "Accounts, membership, requests, and activity.",
  navidrome: "The music catalog, artwork, scanning, and streaming."
};

function SettingsPage({ user, onUser, notify, onReset }: { user: SessionUser; onUser: (user: SessionUser) => void; notify: (message: string) => void; onReset: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const details = useApiResource<{ profile: Profile }>(`/api/users/${user.id}`, { fallbackError: "Could not load your profile." });
  const profile = details.data?.profile ?? null;

  // Playback settings from localStorage
  const [volumeMemory, setVolumeMemory] = useState(() => localStorage.getItem("cw:volume-memory") !== "false");
  const [autoplay, setAutoplay] = useState(() => localStorage.getItem("cw:autoplay") !== "false");
  const [skipInterval, setSkipInterval] = useState(() => Number(localStorage.getItem("cw:skip-interval")) || 10);
  const [queueBehavior, setQueueBehavior] = useState<"clear" | "append">(() => (localStorage.getItem("cw:queue-behavior") as "clear" | "append") || "clear");
  const [continuePlaying, setContinuePlaying] = useState(() => localStorage.getItem("cw:continue-playing") === "true");

  // Developer settings
  const [developerEnabled, setDeveloperEnabled] = useState(false);

  function persist(key: string, value: string) { localStorage.setItem(key, value); }

  function failed(issue: unknown, fallback: string) { setError(issue instanceof Error ? issue.message : fallback); }
  function saved(updated: SessionUser, message: string) { onUser(updated); notify(message); }

  async function change(body: Record<string, string>, message: string, form?: HTMLFormElement) {
    setBusy(message); setError("");
    try {
      const result = await patch<{ user: SessionUser }>("/api/users/me", body);
      saved(result.user, message);
      form?.reset();
    } catch (issue) { failed(issue, "Could not save that."); }
    finally { setBusy(""); }
  }

  async function choosePicture(file: File | undefined) {
    if (!file) return;
    setBusy("Picture updated."); setError("");
    const body = new FormData();
    body.append("avatar", file);
    try {
      const result = await api<{ avatarUrl: string }>("/api/users/me/avatar", { method: "PUT", body });
      saved({ ...user, avatarUrl: result.avatarUrl }, "Picture updated.");
    } catch (issue) { failed(issue, "Could not save that picture."); }
    finally { setBusy(""); if (picker.current) picker.current.value = ""; }
  }

  async function removePicture() {
    setBusy("Picture removed."); setError("");
    try { await remove("/api/users/me/avatar"); saved({ ...user, avatarUrl: null }, "Picture removed."); }
    catch (issue) { failed(issue, "Could not remove that picture."); }
    finally { setBusy(""); }
  }

  function fields(form: HTMLFormElement) { return Object.fromEntries(new FormData(form)) as Record<string, string>; }

  const canSeeDeveloper = can(user, Permission.CONTROL_SERVICES);

  return <>
    <PageHeader title="Settings" />
    <FormError message={error || details.error} />

    <SectionHead title="Account" />
    {details.loading && !profile ? <PageLoading /> : profile ? <>
      <section className="settings-profile">
        <Avatar person={profile} className="hero-avatar" />
        <div className="settings-profile-info">
          <h2>{profile.displayName}</h2>
          <p className="profile-meta"><span className="role-pill">{titleCase(profile.role)}</span>Joined {monthYear(profile.joinedAt)} · {profile.contributions} {profile.contributions === 1 ? "contribution" : "contributions"}</p>
          <div className="button-row">
            <input ref={picker} type="file" accept={PICTURE_TYPES} hidden onChange={(event) => void choosePicture(event.target.files?.[0])} />
            <button className="secondary" onClick={() => picker.current?.click()} disabled={Boolean(busy)}>{profile.avatarUrl ? "Change picture" : "Add picture"}</button>
            {profile.avatarUrl && <button className="text-button" onClick={() => void removePicture()} disabled={Boolean(busy)}>Remove picture</button>}
          </div>
        </div>
      </section>

      <div className="settings-section">
        <h3>Account details</h3>
        <div className="editor-forms">
          <form className="stack-form" onSubmit={(event) => { event.preventDefault(); void change({ displayName: fields(event.currentTarget).displayName }, "Name updated."); }}>
            <Field label="Display name" name="displayName" defaultValue={profile.displayName} maxLength={80} required />
            <button className="secondary" disabled={Boolean(busy)}>Save name</button>
          </form>
          <form className="stack-form" onSubmit={(event) => { const form = event.currentTarget; event.preventDefault(); void change(fields(form), "Email updated.", form); }}>
            <Field label="Email" name="email" type="email" defaultValue={profile.email ?? ""} autoComplete="email" required />
            <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
            <button className="secondary" disabled={Boolean(busy)}>Save email</button>
          </form>
          <form className="stack-form" onSubmit={(event) => { const form = event.currentTarget; event.preventDefault(); void change(fields(form), "Password updated. Other sessions were signed out.", form); }}>
            <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
            <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters" required />
            <button className="secondary" disabled={Boolean(busy)}>Change password</button>
          </form>
        </div>
      </div>
    </> : null}

    <SectionHead title="Playback" />
    <div className="settings-section">
      <label className="settings-toggle">
        <input type="checkbox" checked={volumeMemory} onChange={(event) => { setVolumeMemory(event.target.checked); persist("cw:volume-memory", String(event.target.checked)); }} />
        <span className="toggle-track"><span className="toggle-thumb" /></span>
        <span className="toggle-label">
          <strong>Remember volume</strong>
          <small>Restore your volume level when you return</small>
        </span>
      </label>
      <label className="settings-toggle">
        <input type="checkbox" checked={autoplay} onChange={(event) => { setAutoplay(event.target.checked); persist("cw:autoplay", String(event.target.checked)); }} />
        <span className="toggle-track"><span className="toggle-thumb" /></span>
        <span className="toggle-label">
          <strong>Autoplay</strong>
          <small>Continue to the next track when the current one ends</small>
        </span>
      </label>
      <div className="settings-field">
        <label className="settings-select-label">
          <strong>Skip interval</strong>
          <select value={skipInterval} onChange={(event) => { const value = Number(event.target.value); setSkipInterval(value); persist("cw:skip-interval", String(value)); }}>
            <option value={5}>5 seconds</option>
            <option value={10}>10 seconds</option>
            <option value={15}>15 seconds</option>
            <option value={30}>30 seconds</option>
          </select>
        </label>
      </div>
      <fieldset className="settings-field">
        <legend>When starting a new album</legend>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input type="radio" name="queue-behavior" value="clear" checked={queueBehavior === "clear"} onChange={() => { setQueueBehavior("clear"); persist("cw:queue-behavior", "clear"); }} />
            <span>Replace queue</span>
          </label>
          <label className="settings-radio">
            <input type="radio" name="queue-behavior" value="append" checked={queueBehavior === "append"} onChange={() => { setQueueBehavior("append"); persist("cw:queue-behavior", "append"); }} />
            <span>Add to queue</span>
          </label>
        </div>
      </fieldset>
      <label className="settings-toggle">
        <input type="checkbox" checked={continuePlaying} onChange={(event) => { setContinuePlaying(event.target.checked); persist("cw:continue-playing", String(event.target.checked)); }} />
        <span className="toggle-track"><span className="toggle-thumb" /></span>
        <span className="toggle-label">
          <strong>Keep playing</strong>
          <small>When the queue ends, shuffle all tracks and keep playing</small>
        </span>
      </label>
    </div>

    {canSeeDeveloper && <>
      <SectionHead title="Developer" />
      <div className="settings-section">
        <label className="settings-toggle">
          <input type="checkbox" checked={developerEnabled} onChange={(event) => setDeveloperEnabled(event.target.checked)} />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
          <span className="toggle-label">
            <strong>Enable developer settings</strong>
            <small className="developer-warning"><Icon name="warning" />These controls can restart services and erase data. Use them only when something has gone wrong.</small>
          </span>
        </label>
        {developerEnabled && <div className="settings-developer-content">
          <AdminContent user={user} notify={notify} onReset={onReset} />
        </div>}
      </div>
    </>}
  </>;
}

/** How long a restart waits for the API to answer before giving up on it. */
const HEALTH_TIMEOUT_MS = 60_000;

/**
 * Waits for the API to be reachable again. A restarted API refuses connections
 * for a moment and then answers 503 while it reconnects to Postgres, so this
 * waits for a body rather than for the request to merely complete.
 */
async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((settle) => window.setTimeout(settle, 1500));
    try {
      await api<{ status: string }>("/api/health");
      return true;
    } catch (issue) {
      // A 503 is the API answering that something it depends on is not ready
      // yet; anything else means it is not there to answer at all.
      if (issue instanceof ApiFailure && issue.status !== 503) continue;
    }
  }
  return false;
}

/** Close enough to live for a listening indicator without polling like a chat app. */
const OVERVIEW_POLL_MS = 20_000;

/**
 * The library's own page: who runs this server, who is in it, what each of them
 * has been doing, and who is playing something right now. Every member sees the
 * same thing — nothing here is permission-gated.
 */
function LibraryPage({ user, refresh }: { user: SessionUser; refresh: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const beat = window.setInterval(() => setTick((value) => value + 1), OVERVIEW_POLL_MS);
    return () => window.clearInterval(beat);
  }, []);
  const { data, loading, error } = useApiResource<LibraryOverview>("/api/library/overview", { reloadKey: `${refresh}:${tick}` });
  // A polled reload must not drop the page back to its skeleton every 20 seconds.
  if (loading && !data) return <PageLoading />;
  if (!data) return <><FormError message={error} /><EmptyState title="Library unavailable" text="These details could not be loaded." /></>;
  const owner = data.members.find((member) => member.role === "OWNER");
  const listeners = data.members.filter((member) => member.listening);
  return <>
    <FormError message={error} />
    <PageHeader title={data.library.name} meta="Visible to everyone in this Library" />
    <dl className="server-facts">
      <div><dt>Run by</dt><dd>{owner?.user.displayName ?? "—"}</dd></div>
      <div><dt>Members</dt><dd>{data.library.memberCount}</dd></div>
      <div><dt>Contributions</dt><dd>{data.library.contributionCount}</dd></div>
      <div><dt>Collecting since</dt><dd>{monthYear(data.library.createdAt)}</dd></div>
    </dl>
    <SectionHead title="Listening now" />
    {listeners.length ? <div className="listening-now">{listeners.map((member) => <article key={member.id}>
      <ListeningArt src={member.listening!.track.artworkUrl} />
      <div>
        <span className="listening-who"><Avatar person={member.user} /><PersonLink person={member.user} />{member.user.id === user.id && " (you)"}</span>
        <strong>{member.listening!.track.title}</strong>
        <small><ArtistLettering name={member.listening!.track.artist} />{member.listening!.track.artist} · {member.listening!.track.album}</small>
        <time>Started {relativeDate(member.listening!.since)}</time>
      </div>
    </article>)}</div> : <p className="quiet-state">Nobody is listening right now.</p>}
    <SectionHead title="Members" />
    <div className="member-overview">{data.members.map((member) => <article key={member.id}>
      <Avatar person={member.user} className="large-avatar" />
      <div>
        <span className="member-overview-head"><strong><PersonLink person={member.user} />{member.user.id === user.id && " (you)"}</strong><span className="role-pill">{titleCase(member.role)}</span></span>
        <small className="member-overview-meta">Joined {monthYear(member.joinedAt)} · {member.contributions} {member.contributions === 1 ? "contribution" : "contributions"}</small>
        {member.listening && <p className="member-playing"><Icon name="activity" />Playing <strong>{member.listening.track.title}</strong><span>· <ArtistLettering name={member.listening.track.artist} />{member.listening.track.artist}</span></p>}
        {member.activity.length ? <ActivityList events={member.activity} compact personal /> : <p className="quiet-state">Nothing yet.</p>}
      </div>
    </article>)}</div>
  </>;
}

function ListeningArt({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="listening-art fallback"><Icon name="music" /></span>;
  return <img className="listening-art" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** Formats accepted by the avatar route, which sniffs the bytes rather than trusting this. */
const PICTURE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/**
 * One member's page. Your own is the only place in the product where an account
 * is edited — picture, name, email, password — and everyone else's is read: what
 * they have added, what they are playing right now, and what they have done here.
 *
 * There is no listening history here and there must not be. Commonwax stores
 * presence, which expires on its own, and never a record of what anyone played;
 * "what they are playing" is that same transient row, absent once it goes stale.
 */
function ProfilePage({ profileId, user, refresh, onUser, onOpenAlbum, notify }: { profileId: string; user: SessionUser; refresh: number; onUser: (user: SessionUser) => void; onOpenAlbum: (albumId: string) => void; notify: (message: string) => void }) {
  const details = useApiResource<{ profile: Profile }>(`/api/users/${profileId}`, { reloadKey: refresh, fallbackError: "Could not load this profile." });
  // The records ask Navidrome, so they arrive after the person does rather than
  // holding the whole page behind the slower of the two.
  const records = useApiResource<{ albums: Album[] }>(`/api/users/${profileId}/albums`, { reloadKey: refresh });
  const profile = details.data?.profile ?? null;
  const albums = records.data?.albums ?? [];

  if (details.loading && !profile) return <PageLoading />;
  if (!profile) return <><FormError message={details.error} /><EmptyState title="Profile unavailable" text="This person could not be found in your Library." /></>;

  return <>
    <section className="profile-hero">
      <Avatar person={profile} className="hero-avatar" />
      <div className="profile-identity">
        <h1>{profile.displayName}{profile.self && <span className="you-pill">You</span>}</h1>
        <p className="profile-meta"><span className="role-pill">{titleCase(profile.role)}</span>Joined {monthYear(profile.joinedAt)} · {profile.contributions} {profile.contributions === 1 ? "contribution" : "contributions"}</p>
      </div>
    </section>

    <FormError message={details.error} />

    {profile.listening && <><SectionHead title="Listening now" /><div className="listening-now"><article>
      <ListeningArt src={profile.listening.track.artworkUrl} />
      <div>
        <strong>{profile.listening.track.title}</strong>
        <small><ArtistLettering name={profile.listening.track.artist} />{profile.listening.track.artist} · {profile.listening.track.album}</small>
        <time>Started {relativeDate(profile.listening.since)}</time>
      </div>
    </article></div></>}

    <SectionHead title={profile.self ? "Music you added" : `Music ${profile.displayName} added`} />
    <FormError message={records.error} />
    {records.loading && !records.data ? <PageLoading />
      : albums.length ? <AlbumGrid albums={albums} onOpen={onOpenAlbum} />
      : <p className="quiet-state">{profile.self ? "You have not added anything yet." : "Nothing added yet."}</p>}

    <SectionHead title="Activity" />
    {profile.activity.length ? <ActivityList events={profile.activity} personal /> : <p className="quiet-state">Nothing yet.</p>}
  </>;
}

function UploadPage({ request, onCancel, onDone }: { request: MusicRequest | null; onCancel: () => void; onDone: (skipped: SkippedFile[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState("");
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  // Once the bytes are all up, the wait is Navidrome's scan, which reports no
  // progress of its own. Saying which of the two is happening is the honest
  // amount of detail: a bar that sat at 100% would look stuck.
  const scanning = busy && sent >= 1;

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!files.length) return; setBusy(true); setSent(0); setError("");
    const body = new FormData(); files.forEach((file) => body.append("files", file)); if (request) body.append("requestId", request.id);
    try {
      const result = await upload<{ skipped?: SkippedFile[] }>("/api/uploads", body, setSent);
      onDone(result.skipped ?? []);
    }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Import failed."); setBusy(false); }
  }
  return <><PageHeader title={request ? `Fulfill “${request.album}”` : "Add music"} meta={request ? `Requested by ${request.requester.displayName}` : "Import audio into the shared Library"} /><section className="upload-workflow"><form onSubmit={submit}>
    {request && <p className="workflow-copy">Upload <strong>{request.album}</strong> by {request.artist}. The embedded metadata must match the request.</p>}
    <label className={`drop-zone ${files.length ? "has-files" : ""}`}><input type="file" multiple accept=".flac,.mp3,.aac,.m4a,.ogg,.opus" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} disabled={busy} /><span className="upload-icon"><Icon name="upload" /></span><strong>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Choose audio files"}</strong><small>FLAC, MP3, AAC/M4A, ALAC, Ogg Vorbis, Opus</small></label>
    {files.length > 0 && <ul className="file-preview">{files.slice(0, 6).map((file) => <li key={`${file.name}-${file.size}`}>{file.name}<span>{formatBytes(file.size)}</span></li>)}{files.length > 6 && <li>and {files.length - 6} more…</li>}</ul>}
    {busy && <div className="import-progress">
      <div className="upload-meter" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sent * 100)}><span style={{ transform: `scaleX(${scanning ? 1 : sent})` }} /></div>
      <p>{scanning
        ? <><strong>Scanning and matching tracks…</strong><small>All {formatBytes(total)} uploaded. Navidrome is indexing them now. Keep this window open.</small></>
        : <><strong>Uploading — {Math.round(sent * 100)}%</strong><small>{formatBytes(Math.round(sent * total))} of {formatBytes(total)}. Keep this window open.</small></>}</p>
    </div>}
    <FormError message={error} /><div className="workflow-actions"><button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button><button className="primary" disabled={!files.length || busy}>{busy ? "Importing…" : request ? "Upload & fulfill" : "Add to Library"}</button></div>
  </form></section></>;
}

function usePlayAlbum() {
  const [playError, setPlayError] = useState("");
  const player = usePlayer();
  /** Resolves true only once a queue is actually playing, for callers that navigate on success. */
  async function playAlbum(album: Album): Promise<boolean> {
    setPlayError("");
    try {
      if (!album.available) throw new Error("This album is no longer available in Navidrome.");
      const detail = await api<{ album: Album }>(`/api/albums/${album.id}`);
      if (!detail.album.tracks?.length) throw new Error("This album has no playable tracks.");
      player.play(detail.album.tracks);
      return true;
    } catch (issue) {
      setPlayError(issue instanceof Error ? issue.message : "Could not play album.");
      return false;
    }
  }
  return { playAlbum, playError };
}

function AlbumPlate({ album, onOpen, playAlbum }: { album: Album; onOpen: (id: string) => void; playAlbum: (album: Album) => Promise<boolean> }) {
  const [artFailed, setArtFailed] = useState(false);
  const showArtwork = album.available && Boolean(album.artworkUrl) && !artFailed;
  const trackLabel = [album.songCount != null ? `${album.songCount} ${album.songCount === 1 ? "track" : "tracks"}` : null, album.duration != null ? formatTime(album.duration) : null, album.year].filter(Boolean).join(" · ");
  return <article className={`album-card ${album.available ? "" : "unavailable"}`} key={album.id}><button className="album-open" onClick={() => onOpen(album.id)}><span className="plate-art">{showArtwork ? <img src={album.artworkUrl!} alt={`${album.title} cover`} loading="lazy" onError={() => setArtFailed(true)} /> : <span className="plate-art-fallback"><b>{album.title.slice(0, 1)}</b></span>}{!album.available && <span className="unavailable-label">Unavailable</span>}</span>{album.addedBy && <span className="plate-stamp">{album.addedBy.displayName.charAt(0).toUpperCase()}</span>}<span className="plate"><ArtistName name={album.artist.name} className="plate-artist" /><strong className="plate-title">{album.title}</strong><span className="plate-meta">{trackLabel}</span>{album.addedBy && <span className="plate-byline">ADDED BY {album.addedBy.displayName.toUpperCase()}</span>}</span></button>{album.available && <button className="album-play" aria-label={`Play ${album.title}`} onClick={() => void playAlbum(album)}><Icon name="play" /></button>}</article>;
}

function AlbumGrid({ albums, onOpen, variant = "default" }: { albums: Album[]; onOpen: (albumId: string) => void; variant?: "default" | "stage" | "artist" }) {
  const { playAlbum, playError } = usePlayAlbum();
  return <><div className={`album-grid ${variant === "stage" ? "stage-grid" : ""}`}>{albums.map((album) => <AlbumPlate key={album.id} album={album} onOpen={onOpen} playAlbum={playAlbum} />)}</div><FormError message={playError} /></>;
}

/**
 * The feed row carries two different actions, and which one a press means is
 * decided by where it lands: the artwork starts the album, everywhere else
 * opens it. They are siblings rather than nested because a button cannot
 * contain a button, and the artwork is the only one that has to announce
 * itself, since a row that opens a page is what a row does anyway.
 */
function AlbumFeed({ albums, onOpen }: { albums: Album[]; onOpen: (albumId: string) => void }) {
  const { playAlbum, playError } = usePlayAlbum();
  return <><div className="album-feed">{albums.map((album) => { const trackLabel = album.songCount === null ? null : `${album.songCount} ${album.songCount === 1 ? "track" : "tracks"}${album.duration !== null ? ` · ${formatTime(album.duration)}` : ""}`; return <article className={`feed-row ${album.available ? "" : "unavailable"}`} key={album.id}>{album.available
      ? <button className="feed-art" aria-label={`Play ${album.title}`} onClick={() => void playAlbum(album)}><Cover album={album} className="feed-cover" /><span className="feed-art-play"><Icon name="play" /></span></button>
      : <Cover album={album} className="feed-cover" />}<button className="feed-open" onClick={() => onOpen(album.id)}><span className="feed-meta"><strong className="feed-title">{album.title}</strong>{album.year ? <span className="feed-year">{album.year}</span> : null}</span><span className="feed-artist"><ArtistName name={album.artist.name} className="feed-lettering" /></span>{trackLabel && <span className="feed-count">{trackLabel}</span>}</button></article>; })}</div><FormError message={playError} /></>;
}

function Cover({ album, className = "", contributor }: { album: Album; className?: string; contributor?: Person | null }) {
  const [failed, setFailed] = useState(false);
  const showArtwork = album.available && Boolean(album.artworkUrl) && !failed;
  return <span className={`album-cover ${className} ${showArtwork ? "" : "fallback"} ${album.available ? "" : "unavailable"}`}>{showArtwork && <img src={album.artworkUrl!} alt={`${album.title} cover`} loading="lazy" onError={() => setFailed(true)} />}{!showArtwork && <span><i>commonwax</i><b>{album.title.slice(0, 1)}</b></span>}{!album.available && <span className="availability-label">Unavailable</span>}{contributor && <span className="contributor-ribbon"><Avatar person={contributor} />Added by {contributor.displayName}</span>}</span>;
}

function AlbumPage({ albumId, user, onChanged }: { albumId: string; user: SessionUser; onChanged: () => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const player = usePlayer();
  // The signed-in session already carries the permission set, so this view has
  // no reason to ask /api/session again on every album it opens.
  const canRemove = can(user, Permission.REMOVE_MUSIC);
  const { data, error: loadError, reload } = useApiResource<{ album: Album }>(`/api/albums/${albumId}`);
  const album = data?.album ?? null;
  async function toggleHidden() { if (!album) return; try { if (album.hidden) await remove(`/api/albums/${album.id}/hidden`); else await api(`/api/albums/${album.id}/hidden`, { method: "PUT" }); onChanged(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not update preference."); } }
  async function removeFromLibrary() { if (!album?.available) return; try { await remove(`/api/albums/${album.id}`); onChanged(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not remove album."); } }
  async function refreshMetadata() { if (!album?.available) return; setRefreshing(true); try { await api(`/api/albums/${album.id}/refresh-metadata`, { method: "POST" }); reload(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not refresh metadata."); } finally { setRefreshing(false); } }
  return <>{!album ? <PageLoading /> : <section className="album-page"><div className="album-detail"><Cover album={album} className="detail-cover" /><div className="album-meta"><h1>{album.title}</h1><p className="detail-artist"><ArtistLettering name={album.artist.name} className="detail-lettering" />{album.artist.name}</p>{album.available ? <p className="meta-line">{[album.year, album.genre, album.songCount === null ? null : `${album.songCount} tracks`, album.duration === null ? null : formatTime(album.duration)].filter(Boolean).join(" · ")}</p> : <p className="availability-note"><strong>Unavailable in Navidrome</strong><span>Showing last-known details from this Commonwax record.</span></p>}{album.addedBy && <p className="attribution"><Avatar person={album.addedBy} />Added by <PersonLink person={album.addedBy} /></p>}<div className="button-row"><button className="primary" onClick={() => player.play(album.tracks ?? [])} disabled={!album.available || !album.tracks?.some((track) => track.available)}><Icon name="play" />Play album</button><button className="secondary" onClick={() => void toggleHidden()}>{album.hidden ? "Unhide" : "Hide for me"}</button>{album.available && <button className="secondary" onClick={() => void refreshMetadata()} disabled={refreshing}>{refreshing ? "Refreshing\u2026" : "Refresh metadata"}</button>}{canRemove && album.available && !confirmRemove && <button className="danger-text" onClick={() => setConfirmRemove(true)}>Remove</button>}</div>{confirmRemove && <div className="inline-confirm" role="alert"><p>Permanently remove the album files? Attribution and history will remain.</p><span><button className="danger-text" onClick={() => void removeFromLibrary()}>Confirm remove</button><button className="text-button" onClick={() => setConfirmRemove(false)}>Keep album</button></span></div>}</div></div>{Boolean(album.tracks?.length) && <div className="detail-tracks"><TrackTable tracks={album.tracks ?? []} compact /></div>}</section>}<FormError message={error || loadError} /></>;
}

/**
 * One artist, led by their own lettering.
 *
 * The two images fanart.tv supplies arrive independently and either can be
 * missing, so this has three honest shapes rather than one with holes in it: a
 * photographic header when there is a background, a plain typographic one when
 * there is only a logo, and the artist's name set in display type when there is
 * neither. Nothing about the page waits on artwork or reserves space for it.
 *
 * The logo is the heading when it exists — an `h1` around the image, carrying
 * the name as its alt text — rather than a picture sitting above a redundant
 * repetition of the name at the same size.
 */
function ArtistPage({ artistId, onOpenAlbum }: { artistId: string; onOpenAlbum: (albumId: string) => void }) {
  const { addedBy } = useContributorFilter();
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  const { data, error } = useApiResource<{ artist: Artist }>(withQuery(`/api/artists/${artistId}`, { addedBy: addedBy?.id }));
  const artist = data?.artist ?? null;
  if (!artist) return <><PageLoading /><FormError message={error} /></>;
  const albums = artist.albums ?? [];
  const trackCount = albums.reduce((total, album) => total + (album.songCount ?? 0), 0);
  const meta = [artistMeta(artist), trackCount ? `${trackCount} ${trackCount === 1 ? "track" : "tracks"}` : null].filter(Boolean).join(" · ");
  return <section className="artist-page">
    {artist.backgroundUrl && <div className={`artist-backdrop ${backdropLoaded ? "loaded" : ""}`}>
      <img className="artist-backdrop-sharp" src={artist.backgroundUrl} alt="" onLoad={() => setBackdropLoaded(true)} />
      <img className="artist-backdrop-blur" src={artist.backgroundUrl} alt="" />
    </div>}
    <header className={`artist-hero ${artist.backgroundUrl ? "has-backdrop" : ""}`}>
      <div className="artist-hero-body">
        {artist.logoUrl
          ? <h1 className="artist-logo"><ArtistMark artist={artist} className="hero-mark" alt={artist.name} /></h1>
          : <h1 className="artist-name">{artist.name}</h1>}
        <p className="artist-hero-meta">{meta}</p>
      </div>
    </header>
    <AddedByFilter />
    {albums.length
      ? <AlbumGrid albums={albums} onOpen={onOpenAlbum} variant="artist" />
      : <EmptyState {...emptyBrowse(addedBy, "No albums", "Nothing by this artist is in the collection.")} />}
    <FormError message={error} />
  </section>;
}

function TrackTable({ tracks, compact = false, sort, onSort }: { tracks: Track[]; compact?: boolean; sort?: TrackSort; onSort?: (key: TrackSortKey) => void }) {
  const player = usePlayer();
  return <div className={`track-table ${compact ? "compact" : ""}`}>{!compact && <div className="track-table-head"><span>#</span><TrackHeading label="Track" column="title" sort={sort} onSort={onSort} /><TrackHeading label="Artist" column="artist" sort={sort} onSort={onSort} /><TrackHeading label="Album" column="album" sort={sort} onSort={onSort} /><TrackHeading label="Album artist" column="albumArtist" sort={sort} onSort={onSort} /><TrackHeading label="Format" column="format" sort={sort} onSort={onSort} /><TrackHeading label="Time" column="duration" sort={sort} onSort={onSort} /><span /></div>}{tracks.map((track, index) => <button key={track.id} className={`${player.current?.id === track.id ? "playing" : ""} ${track.available ? "" : "unavailable"}`} onClick={() => player.play(tracks, index)} disabled={!track.available} title={track.available ? `Play ${track.title}` : "Unavailable in Navidrome"}><span className="track-number">{player.current?.id === track.id && player.playing ? <Icon name="music" /> : track.trackNumber ?? index + 1}</span><span className="track-title"><strong>{track.title}</strong>{compact && track.artist.name !== track.album.artist.name && <small><ArtistLettering name={track.artist.name} />{track.artist.name}</small>}{!compact && <small className="track-mobile-context">{track.artist.name} · {track.album.title} · {track.album.artist.name}</small>}</span>{!compact && <span className="track-artist"><ArtistLettering name={track.artist.name} />{track.artist.name}</span>}{!compact && <span className="track-album"><span>{track.album.title}</span><small>{track.album.artist.name}</small></span>}{!compact && <span className="track-album-artist"><ArtistLettering name={track.album.artist.name} />{track.album.artist.name}</span>}<span className="track-format">{track.suffix?.replace(/^\./, "").toLocaleUpperCase() || "Audio"}</span><time>{track.duration === null ? "—" : formatTime(track.duration)}</time>{track.available ? <span className="row-play"><Icon name="play" /></span> : <span className="track-unavailable">Off</span>}</button>)}</div>;
}

function TrackHeading({ label, column, sort, onSort }: { label: string; column: TrackSortKey; sort?: TrackSort; onSort?: (key: TrackSortKey) => void }) {
  if (!sort || !onSort) return <span>{label}</span>;
  const active = sort.key === column;
  return <button className={`sort-heading ${active ? "active" : ""}`} onClick={() => onSort(column)} aria-label={`Sort by ${label}${active ? `, currently ${sort.direction === "asc" ? "ascending" : "descending"}` : ""}`}><span>{label}</span><Icon name="chevron" className={active && sort.direction === "desc" ? "descending" : ""} /></button>;
}

function sortLabel(key: TrackSortKey) {
  return ({ title: "track", artist: "artist", album: "album", albumArtist: "album artist and album", format: "format", duration: "duration" } as const)[key];
}

/** `personal` drops the actor's name, for a list already filed under that person. */
function ActivityList({ events, compact = false, personal = false }: { events: Activity[]; compact?: boolean; personal?: boolean }) {
  return <div className={`activity-list ${compact ? "compact" : ""}`}>{events.map((event) => <article key={event.id}><span className={`activity-icon ${event.type.toLowerCase()}`}><Icon name={activityIcon(event.type)} /></span><div><p>{activityText(event, personal)}</p><time>{relativeDate(event.createdAt)}</time></div></article>)}</div>;
}

/**
 * The name is always carried by the event, so a line still reads as that
 * person's own after they leave. Only someone still here has a page to open,
 * which is what `actorId` decides.
 */
function activityActor(event: Activity) {
  const name = event.actor ?? "A former member";
  // Wrapped either way: the name carries the same weight it did before it became
  // a link, and `.person-link` inherits its type rather than restyling it.
  return <strong>{event.actorId
    ? <PersonLink person={{ id: event.actorId, displayName: name, avatarUrl: event.actorAvatarUrl }} />
    : name}</strong>;
}

function activityText(event: Activity, personal = false) {
  const actor = activityActor(event);
  const unavailable = event.mediaAvailable === false ? <span className="activity-unavailable"> Unavailable in Navidrome.</span> : null;
  switch (event.type) {
    case "MUSIC_ADDED": return personal
      ? <>Added <em>{event.album}</em> by {event.artist}.{unavailable}</>
      : <>{actor} added <em>{event.album}</em> by {event.artist}.{unavailable}</>;
    case "MEMBER_JOINED": return personal ? <>Joined the Library.</> : <>{actor} joined the Library.</>;
    case "REQUEST_CREATED": return personal
      ? <>Requested <em>{event.album}</em> by {event.artist}.</>
      : <>{actor} requested <em>{event.album}</em> by {event.artist}.</>;
    case "REQUEST_CLAIMED": return personal
      ? <>Fulfilling {event.requester ? `${event.requester}’s` : "a"} request for <em>{event.album}</em>.</>
      : <>{actor} is fulfilling {event.requester ? `${event.requester}’s` : "a"} request for <em>{event.album}</em>.</>;
    case "REQUEST_FULFILLED": return personal
      ? <>Fulfilled the request for <em>{event.album}</em> by {event.artist}.{unavailable}</>
      : <>{actor} fulfilled the request for <em>{event.album}</em> by {event.artist}.{unavailable}</>;
  }
}

function activityIcon(type: Activity["type"]): IconName { return ({ MUSIC_ADDED: "music", MEMBER_JOINED: "people", REQUEST_CREATED: "request", REQUEST_CLAIMED: "activity", REQUEST_FULFILLED: "albums" } as const)[type]; }
function SectionHead({ title, action }: { title: string; action?: ReactNode }) { return <div className="section-head"><h2>{title}</h2>{action}</div>; }
/** What an empty browse view says — the filter's doing, when there is a filter. */
function emptyBrowse(addedBy: Person | null, title: string, text: string) {
  return addedBy ? { title: `Nothing from ${addedBy.displayName}`, text: "Clear the filter to see the whole collection." } : { title, text };
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <section className="empty-state"><Icon name="music" /><h2>{title}</h2><p>{text}</p>{action}</section>; }
function PageLoading() { return <div className="page-loading"><span /><span /><span /></div>; }

function focusableElements(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
}

function firstFocusable(container: HTMLElement | null) { return focusableElements(container)[0]; }

function handleOverlayKeys(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement | null, close?: () => void) {
  if (event.key === "Escape" && close) {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements(container);
  if (!elements.length) {
    event.preventDefault();
    container?.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The product's one true overlay. Everything before this was an inline workflow
 * or a confirm that lived in the row it belonged to, which is right for a
 * reversible change; these are not reversible, and a dialog is what makes the
 * reader stop.
 *
 * Carries the behaviour DESIGN.md requires of a temporary layer: an accessible
 * name, focus moved inside on open and restored to the trigger on close, Tab
 * contained, Escape dismissal, and a backdrop that only dismisses when the
 * backdrop itself is what was pressed.
 */
function Modal({ title, description, onClose, children, tone = "default" }: { title: string; description?: string; onClose: () => void; children: ReactNode; tone?: "default" | "danger" }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    window.requestAnimationFrame(() => (firstFocusable(panel.current) ?? panel.current)?.focus());
    return () => { (opener.current as HTMLElement | null)?.focus?.(); };
  }, []);
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
    // Pressing inside the panel bubbles up to here, so the target has to be the
    // backdrop itself or a drag that ended outside would close the dialog.
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <motion.div ref={panel} className={`modal-panel ${tone === "danger" ? "danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}
      onKeyDown={(event) => handleOverlayKeys(event, panel.current, onClose)}
      initial={{ opacity: 0, y: 14, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.99 }} transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}>
      <header className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
      {description && <p className="modal-description">{description}</p>}
      {children}
    </motion.div>
  </motion.div>;
}

/** How long the reset's second confirmation has to be held down. */
const HOLD_TO_CONFIRM_MS = 10_000;

/**
 * A control that fires only after being held for ten seconds, for the one
 * action in the product that cannot be taken back.
 *
 * The progress fill is a MotionValue driven from an animation frame, the same
 * reason the player's seek bar is: it updates sixty times a second for ten
 * seconds and must not re-render the dialog around it while it does.
 *
 * `reducedMotion` is deliberately not consulted. The delay is the safeguard, not
 * an animation, and shortening it for that preference would remove the thing
 * the control exists for; only the fill is motion, and a progress indicator is
 * what a reduced-motion preference still expects to see.
 */
function HoldToConfirm({ label, holdingLabel, onConfirm, disabled = false }: { label: string; holdingLabel: string; onConfirm: () => void; disabled?: boolean }) {
  const progress = useMotionValue(0);
  const [holding, setHolding] = useState(false);
  const fired = useRef(false);
  const frame = useRef(0);

  const stop = useCallback(() => {
    window.cancelAnimationFrame(frame.current);
    setHolding(false);
    progress.set(0);
  }, [progress]);

  // A press that ends anywhere — off the button, outside the window, in another
  // tab — has to release the hold, or letting go somewhere else would leave it
  // filling on its own.
  useEffect(() => {
    if (!holding) return;
    const release = () => { if (!fired.current) stop(); };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [holding, stop]);

  useEffect(() => () => window.cancelAnimationFrame(frame.current), []);

  function start() {
    if (disabled || holding || fired.current) return;
    setHolding(true);
    const began = performance.now();
    const step = (now: number) => {
      const ratio = Math.min(1, (now - began) / HOLD_TO_CONFIRM_MS);
      progress.set(ratio);
      if (ratio < 1) { frame.current = window.requestAnimationFrame(step); return; }
      fired.current = true;
      setHolding(false);
      onConfirm();
    };
    frame.current = window.requestAnimationFrame(step);
  }

  const remaining = holding ? holdingLabel : label;
  return <button type="button" className={`hold-confirm ${holding ? "holding" : ""}`} disabled={disabled}
    onPointerDown={start}
    // Space and Enter repeat while held, so a keyboard press starts the same
    // fill; `keyup` is the release. Without this the control would be reachable
    // by keyboard and impossible to complete with one.
    onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); start(); } }}
    onKeyUp={(event) => { if ((event.key === " " || event.key === "Enter") && !fired.current) stop(); }}
    onBlur={() => { if (!fired.current) stop(); }}>
    <motion.span className="hold-fill" aria-hidden="true" style={{ scaleX: progress }} />
    <span className="hold-label">{remaining}</span>
  </button>;
}

function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase(); }
function titleCase(value: string) { return value.toLocaleLowerCase().replace(/(^|\s)\w/g, (letter) => letter.toLocaleUpperCase()); }
function relativeDate(value: string) { const seconds = Math.round((new Date(value).valueOf() - Date.now()) / 1000); const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); if (Math.abs(seconds) < 60) return formatter.format(seconds, "second"); const minutes = Math.round(seconds / 60); if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute"); const hours = Math.round(minutes / 60); if (Math.abs(hours) < 24) return formatter.format(hours, "hour"); return formatter.format(Math.round(hours / 24), "day"); }
function monthYear(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "long", year: "numeric" }); }
function formatBytes(bytes: number) { if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
