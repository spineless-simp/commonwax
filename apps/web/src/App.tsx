import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, patch, post, remove } from "./api";
import { formatTime, usePlayer } from "./player";
import type { Activity, Album, Artist, MusicRequest, SessionUser, Track } from "./types";

type View = "home" | "albums" | "artists" | "tracks" | "requests" | "activity" | "people" | "hidden" | "search";

export function App() {
  const [state, setState] = useState<"loading" | "setup" | "login" | "app">("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const invitationToken = window.location.pathname.match(/^\/join\/([^/]+)$/)?.[1];

  const bootstrap = useCallback(async () => {
    if (invitationToken) return;
    const setup = await api<{ needsSetup: boolean }>("/api/setup/status");
    if (setup.needsSetup) { setState("setup"); return; }
    try {
      const session = await api<{ user: SessionUser }>("/api/session");
      setUser(session.user);
      setState("app");
    } catch {
      setState("login");
    }
  }, [invitationToken]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  if (invitationToken) return <Join invitationToken={invitationToken} onDone={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }} />;
  if (state === "loading") return <Splash />;
  if (state === "setup") return <Setup onDone={() => void bootstrap()} />;
  if (state === "login") return <Login onDone={() => void bootstrap()} />;
  if (!user) return <Splash />;
  return <Shell user={user} onLogout={async () => { await post("/api/auth/logout"); setUser(null); setState("login"); }} />;
}

function Splash() {
  return <main className="auth-page"><div className="brand-mark large">cw</div><p className="muted">Opening the collection…</p></main>;
}

function AuthFrame({ eyebrow, title, subtitle, children }: { eyebrow: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-lockup"><span className="brand-mark">cw</span><span>commonwax</span></div>
        <p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="auth-subtitle">{subtitle}</p>
        {children}
      </section>
    </main>
  );
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
  return <AuthFrame eyebrow="First run" title="Start your shared collection." subtitle="Create the owner account and give your Library a name. That’s all the setup your friends will ever see.">
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
  return <AuthFrame eyebrow="Welcome back" title="Return to the Library." subtitle="Sign in to browse, listen, and see what your friends have added.">
    <form className="stack-form" onSubmit={submit}>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <FormError message={error} /><button className="primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </AuthFrame>;
}

function Join({ invitationToken, onDone }: { invitationToken: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ libraryName: string; invitedBy: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ libraryName: string; invitedBy: string }>(`/api/invitations/${invitationToken}`).then(setInvite).catch((issue) => setLoadError(issue.message)); }, [invitationToken]);
  if (loadError) return <AuthFrame eyebrow="Invitation" title="This link can’t be used." subtitle={loadError}><a className="primary button-link" href="/">Go to sign in</a></AuthFrame>;
  if (!invite) return <Splash />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    try { await post(`/api/invitations/${invitationToken}/accept`, Object.fromEntries(new FormData(event.currentTarget))); onDone(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Could not join."); setBusy(false); }
  }
  return <AuthFrame eyebrow={`${invite.invitedBy} invited you`} title={`Join ${invite.libraryName}.`} subtitle="Make your account and you’re in—no server address or music service credentials needed.">
    <form className="stack-form" onSubmit={submit}>
      <Field label="Your name" name="displayName" autoComplete="name" required />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters" required />
      <FormError message={error} /><button className="primary wide" disabled={busy}>{busy ? "Joining…" : `Join ${invite.libraryName}`}</button>
    </form>
  </AuthFrame>;
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const { label, hint, ...input } = props;
  return <label className="field"><span>{label}</span><input {...input} />{hint && <small>{hint}</small>}</label>;
}

function FormError({ message }: { message: string }) { return message ? <p className="form-error">{message}</p> : null; }

function Shell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [view, setView] = useState<View>("home");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [uploadRequest, setUploadRequest] = useState<MusicRequest | null | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const [toast, setToast] = useState("");
  const canContribute = user.permissions.includes("music:contribute");
  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(""), 3500); }
  function navigate(next: View) { setView(next); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function submitSearch(event: FormEvent) { event.preventDefault(); if (!search.trim()) return; setSearchQuery(search.trim()); navigate("search"); }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand-lockup sidebar-brand" onClick={() => navigate("home")}><span className="brand-mark">cw</span><span>commonwax</span></button>
        <p className="library-label">{user.libraryName}</p>
        <nav>
          <NavButton active={view === "home"} onClick={() => navigate("home")} icon="⌂">Home</NavButton>
          <span className="nav-heading">Library</span>
          <NavButton active={view === "albums"} onClick={() => navigate("albums")} icon="◉">Albums</NavButton>
          <NavButton active={view === "artists"} onClick={() => navigate("artists")} icon="♬">Artists</NavButton>
          <NavButton active={view === "tracks"} onClick={() => navigate("tracks")} icon="≡">Tracks</NavButton>
          <NavButton active={view === "hidden"} onClick={() => navigate("hidden")} icon="◌">Hidden</NavButton>
          <span className="nav-heading">Together</span>
          <NavButton active={view === "requests"} onClick={() => navigate("requests")} icon="＋">Requests</NavButton>
          <NavButton active={view === "activity"} onClick={() => navigate("activity")} icon="↗">Activity</NavButton>
          <NavButton active={view === "people"} onClick={() => navigate("people")} icon="◎">People</NavButton>
        </nav>
        <div className="profile-card"><span className="avatar">{initials(user.displayName)}</span><span><strong>{user.displayName}</strong><small>{titleCase(user.role)}</small></span><button aria-label="Sign out" title="Sign out" onClick={onLogout}>↪</button></div>
      </aside>
      <main className="main-pane">
        <header className="topbar">
          <form className="search-box" onSubmit={submitSearch}><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the collection" aria-label="Search" /></form>
          {canContribute && <button className="primary" onClick={() => setUploadRequest(null)}>＋ Add music</button>}
        </header>
        <div className="page-content">
          {view === "home" && <Home user={user} refresh={refresh} onNavigate={navigate} onUpload={() => setUploadRequest(null)} />}
          {view === "albums" && <AlbumsPage refresh={refresh} onChanged={() => setRefresh((value) => value + 1)} />}
          {view === "hidden" && <AlbumsPage hidden refresh={refresh} onChanged={() => setRefresh((value) => value + 1)} />}
          {view === "artists" && <ArtistsPage refresh={refresh} />}
          {view === "tracks" && <TracksPage refresh={refresh} />}
          {view === "requests" && <RequestsPage user={user} refresh={refresh} onRefresh={() => setRefresh((value) => value + 1)} onFulfill={setUploadRequest} notify={notify} />}
          {view === "activity" && <ActivityPage refresh={refresh} />}
          {view === "people" && <PeoplePage user={user} refresh={refresh} notify={notify} />}
          {view === "search" && <SearchPage query={searchQuery} refresh={refresh} />}
        </div>
      </main>
      {uploadRequest !== undefined && <UploadDialog request={uploadRequest} onClose={() => setUploadRequest(undefined)} onDone={() => { setUploadRequest(undefined); setRefresh((value) => value + 1); notify("Music imported and added to the Library."); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: ReactNode }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span>{icon}</span>{children}</button>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}

function Home({ user, refresh, onNavigate, onUpload }: { user: SessionUser; refresh: number; onNavigate: (view: View) => void; onUpload: () => void }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [events, setEvents] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { Promise.all([api<{ albums: Album[] }>("/api/albums/recent"), api<{ events: Activity[] }>("/api/activity")]).then(([albumData, eventData]) => { setAlbums(albumData.albums); setEvents(eventData.events); }).finally(() => setLoading(false)); }, [refresh]);
  if (loading) return <PageLoading />;
  const canInvite = user.permissions.includes("members:invite");
  const canContribute = user.permissions.includes("music:contribute");
  return <>
    <PageHeader eyebrow="Your shared collection" title={`Good ${dayPart()}, ${user.displayName.split(" ")[0]}.`} description="See what’s new, put something on, or add to the shelves." />
    {!albums.length ? <section className="empty-welcome"><div className="record-graphic"><span /></div><div><p className="eyebrow">The shelves are empty</p><h2>Every collection starts with one record.</h2><p>Add the first album, then bring in the people you want to share it with.</p><div className="button-row">{canContribute && <button className="primary" onClick={onUpload}>＋ Add Music</button>}{canInvite && <button className="secondary" onClick={() => onNavigate("people")}>◎ Invite Friends</button>}</div></div></section> : <>
      <SectionHead title="Recently added" action={<button className="text-button" onClick={() => onNavigate("albums")}>See all →</button>} />
      <AlbumGrid albums={albums.slice(0, 10)} />
    </>}
    {events.length > 0 && <><SectionHead title="Around the Library" action={<button className="text-button" onClick={() => onNavigate("activity")}>Full activity →</button>} /><ActivityList events={events.slice(0, 5)} /></>}
  </>;
}

function AlbumsPage({ hidden = false, refresh, onChanged }: { hidden?: boolean; refresh: number; onChanged: () => void }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); api<{ albums: Album[] }>(`/api/albums${hidden ? "?hidden=true" : ""}`).then((data) => setAlbums(data.albums)).finally(() => setLoading(false)); }, [hidden, refresh]);
  if (loading) return <PageLoading />;
  return <><PageHeader eyebrow="Library" title={hidden ? "Hidden albums" : "Albums"} description={hidden ? "Only you can see this list. Restore an album to return it to your normal views." : `${albums.length} ${albums.length === 1 ? "album" : "albums"} in the shared collection.`} />
    {albums.length ? <AlbumGrid albums={albums} onChanged={onChanged} /> : <EmptyState title={hidden ? "Nothing hidden" : "No albums yet"} text={hidden ? "Albums you hide from your normal views will appear here." : "Use Add music to put the first album on the shelves."} />}
  </>;
}

function ArtistsPage({ refresh }: { refresh: number }) {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<{ artists: Artist[] }>("/api/artists").then((data) => setArtists(data.artists)).finally(() => setLoading(false)); }, [refresh]);
  if (loading) return <PageLoading />;
  return <><PageHeader eyebrow="Library" title="Artists" description={`${artists.length} ${artists.length === 1 ? "artist" : "artists"} represented.`} />
    <div className="artist-list">{artists.map((artist) => <details key={artist.id}><summary><span className="artist-avatar">{initials(artist.name)}</span><span><strong>{artist.name}</strong><small>{artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"}</small></span><span>＋</span></summary><AlbumGrid albums={artist.albums ?? []} /></details>)}</div>
    {!artists.length && <EmptyState title="No artists yet" text="Artists appear here as music is added." />}
  </>;
}

function TracksPage({ refresh }: { refresh: number }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<{ tracks: Track[] }>("/api/tracks").then((data) => setTracks(data.tracks)).finally(() => setLoading(false)); }, [refresh]);
  if (loading) return <PageLoading />;
  return <><PageHeader eyebrow="Library" title="Tracks" description={`${tracks.length} tracks, ready to play.`} />{tracks.length ? <TrackTable tracks={tracks} /> : <EmptyState title="No tracks yet" text="Tracks appear after an album is imported." />}</>;
}

function SearchPage({ query, refresh }: { query: string; refresh: number }) {
  const [result, setResult] = useState<{ artists: Artist[]; albums: Album[]; tracks: Track[] }>({ artists: [], albums: [], tracks: [] });
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); api<typeof result>(`/api/search?q=${encodeURIComponent(query)}`).then(setResult).finally(() => setLoading(false)); }, [query, refresh]);
  if (loading) return <PageLoading />;
  const empty = !result.artists.length && !result.albums.length && !result.tracks.length;
  return <><PageHeader eyebrow="Search" title={`Results for “${query}”`} />{empty && <EmptyState title="No matches" text="Try another artist, album, or track title." />}
    {result.artists.length > 0 && <><SectionHead title="Artists" /><div className="search-artists">{result.artists.map((artist) => <span key={artist.id}><span className="artist-avatar">{initials(artist.name)}</span><strong>{artist.name}</strong></span>)}</div></>}
    {result.albums.length > 0 && <><SectionHead title="Albums" /><AlbumGrid albums={result.albums} /></>}
    {result.tracks.length > 0 && <><SectionHead title="Tracks" /><TrackTable tracks={result.tracks} /></>}
  </>;
}

function RequestsPage({ user, refresh, onRefresh, onFulfill, notify }: { user: SessionUser; refresh: number; onRefresh: () => void; onFulfill: (request: MusicRequest) => void; notify: (message: string) => void }) {
  const [requests, setRequests] = useState<MusicRequest[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api<{ requests: MusicRequest[] }>("/api/requests").then((data) => setRequests(data.requests)); }, [refresh]);
  async function claim(request: MusicRequest) { try { await post(`/api/requests/${request.id}/claim`); notify(`You claimed ${request.album}.`); onRefresh(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not claim request."); } }
  async function cancel(request: MusicRequest) { if (!window.confirm(`Cancel your request for ${request.album}?`)) return; try { await post(`/api/requests/${request.id}/cancel`); notify("Request cancelled."); onRefresh(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not cancel request."); } }
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); try { await post("/api/requests", Object.fromEntries(new FormData(event.currentTarget))); setCreateOpen(false); onRefresh(); notify("Request shared with the Library."); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not create request."); } }
  return <><PageHeader eyebrow="Together" title="Music requests" description="Ask for something missing, or help a friend fill a gap in the collection." action={user.permissions.includes("request:create") && <button className="primary" onClick={() => setCreateOpen(true)}>＋ New request</button>} />
    <FormError message={error} />
    <div className="request-list">{requests.map((request) => <article className="request-card" key={request.id}><span className={`status ${request.status.toLowerCase()}`}>{titleCase(request.status)}</span><div><h3>{request.album}</h3><p>{request.artist}</p><small>Requested by {request.requester.displayName} · {relativeDate(request.createdAt)}</small>{request.claimant && request.status !== "FULFILLED" && <small>Claimed by {request.claimant.displayName}</small>}{request.fulfiller && <small>Fulfilled by {request.fulfiller.displayName}</small>}</div><div className="request-action">
        {request.status === "OPEN" && request.requester.id !== user.id && user.permissions.includes("request:fulfill") && <button className="secondary" onClick={() => void claim(request)}>I have this</button>}
        {request.status === "CLAIMED" && request.claimant?.id === user.id && <button className="primary" onClick={() => onFulfill(request)}>Upload to fulfill</button>}
        {(request.status === "OPEN" || request.status === "CLAIMED") && request.requester.id === user.id && <button className="text-button" onClick={() => void cancel(request)}>Cancel request</button>}
      </div></article>)}</div>
    {!requests.length && <EmptyState title="No requests yet" text="When someone is looking for an album, their request will show up here." />}
    {createOpen && <Modal title="Request an album" onClose={() => setCreateOpen(false)}><form className="stack-form" onSubmit={create}><Field label="Artist" name="artist" required autoFocus /><Field label="Album" name="album" required /><FormError message={error} /><div className="modal-actions"><button type="button" className="secondary" onClick={() => setCreateOpen(false)}>Cancel</button><button className="primary">Share request</button></div></form></Modal>}
  </>;
}

function ActivityPage({ refresh }: { refresh: number }) {
  const [events, setEvents] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<{ events: Activity[] }>("/api/activity").then((data) => setEvents(data.events)).finally(() => setLoading(false)); }, [refresh]);
  if (loading) return <PageLoading />;
  return <><PageHeader eyebrow="Together" title="Activity" description="What’s been happening around the Library." />{events.length ? <ActivityList events={events} /> : <EmptyState title="It’s quiet in here" text="New music, members, and requests will leave a trace here." />}</>;
}

function PeoplePage({ user, refresh, notify }: { user: SessionUser; refresh: number; notify: (message: string) => void }) {
  const [members, setMembers] = useState<Array<{ id: string; role: string; joinedAt: string; user: { id: string; displayName: string; email: string } }>>([]);
  const [memberRefresh, setMemberRefresh] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");
  const canInvite = user.permissions.includes("members:invite");
  const canManage = user.permissions.includes("members:manage");
  useEffect(() => { api<{ members: typeof members }>("/api/members").then((data) => setMembers(data.members)); }, [refresh, memberRefresh]);
  async function makeInvite() { setError(""); try { const result = await post<{ url: string }>("/api/invitations", { role: "MEMBER", daysValid: 7 }); setInviteUrl(result.url); setInviteOpen(true); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not create invitation."); } }
  async function copyInvite() { await navigator.clipboard.writeText(inviteUrl); notify("Invitation link copied."); }
  async function changeRole(membershipId: string, role: string) { setError(""); try { await patch(`/api/members/${membershipId}`, { role }); setMemberRefresh((value) => value + 1); notify("Member role updated."); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not update role."); } }
  async function removeMember(membershipId: string, name: string) { if (!window.confirm(`Remove ${name} from ${user.libraryName}?`)) return; setError(""); try { await remove(`/api/members/${membershipId}`); setMemberRefresh((value) => value + 1); notify(`${name} was removed from the Library.`); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not remove member."); } }
  return <><PageHeader eyebrow="Together" title="People" description={`${members.length} ${members.length === 1 ? "person" : "people"} share ${user.libraryName}.`} action={canInvite && <button className="primary" onClick={() => void makeInvite()}>◎ Invite a friend</button>} /><FormError message={error} />
    <div className="member-list">{members.map((member) => <article key={member.id}><span className="avatar large-avatar">{initials(member.user.displayName)}</span><span><strong>{member.user.displayName}{member.user.id === user.id && " (you)"}</strong><small>{member.user.email}</small></span>{canManage && member.role !== "OWNER" && member.user.id !== user.id ? <span className="member-actions"><select aria-label={`${member.user.displayName} role`} value={member.role} onChange={(event) => void changeRole(member.id, event.target.value)}>{user.role === "OWNER" && <option value="ADMIN">Admin</option>}<option value="MEMBER">Member</option></select><button className="icon-button" title={`Remove ${member.user.displayName}`} onClick={() => void removeMember(member.id, member.user.displayName)}>×</button></span> : <span className="role-pill">{titleCase(member.role)}</span>}</article>)}</div>
    {inviteOpen && <Modal title="Invitation ready" onClose={() => setInviteOpen(false)}><p className="modal-copy">Send this link to your friend. It expires in 7 days and can be used once.</p><div className="copy-row"><input value={inviteUrl} readOnly /><button className="primary" onClick={() => void copyInvite()}>Copy</button></div><p className="privacy-note">They’ll create a Commonwax account and enter {user.libraryName} directly. No server setup required.</p></Modal>}
  </>;
}

function UploadDialog({ request, onClose, onDone }: { request: MusicRequest | null; onClose: () => void; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!files.length) return; setBusy(true); setError("");
    const body = new FormData(); files.forEach((file) => body.append("files", file)); if (request) body.append("requestId", request.id);
    try { await api("/api/uploads", { method: "POST", body }); onDone(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "Import failed."); setBusy(false); }
  }
  return <Modal title={request ? `Fulfill “${request.album}”` : "Add music"} onClose={busy ? undefined : onClose}><form onSubmit={submit}>
    {request && <p className="modal-copy">Upload <strong>{request.album}</strong> by {request.artist}. The embedded metadata must match the request.</p>}
    <label className={`drop-zone ${files.length ? "has-files" : ""}`}><input type="file" multiple accept=".flac,.mp3,.aac,.m4a,.ogg,.opus,audio/*" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} disabled={busy} /><span className="upload-icon">⇧</span><strong>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Choose audio files"}</strong><small>FLAC, MP3, AAC/M4A, ALAC, Ogg Vorbis, and Opus</small></label>
    {files.length > 0 && <ul className="file-preview">{files.slice(0, 6).map((file) => <li key={`${file.name}-${file.size}`}>{file.name}<span>{formatBytes(file.size)}</span></li>)}{files.length > 6 && <li>and {files.length - 6} more…</li>}</ul>}
    {busy && <div className="import-progress"><span /><p><strong>Importing your music…</strong><small>Validating metadata, scanning, and matching tracks. Keep this window open.</small></p></div>}
    <FormError message={error} /><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={!files.length || busy}>{busy ? "Importing…" : request ? "Upload & fulfill" : "Add to Library"}</button></div>
  </form></Modal>;
}

function AlbumGrid({ albums, onChanged }: { albums: Album[]; onChanged?: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return <><div className="album-grid">{albums.map((album) => <button className="album-card" key={album.id} onClick={() => setSelected(album.id)}><Cover album={album} /><span className="album-title">{album.title}</span><span className="album-artist">{album.artist.name}{album.year ? ` · ${album.year}` : ""}</span>{album.addedBy && <small>Added by {album.addedBy.displayName}</small>}</button>)}</div>{selected && <AlbumDialog albumId={selected} onClose={() => setSelected(null)} onChanged={() => { setSelected(null); onChanged?.(); }} />}</>;
}

function Cover({ album, className = "" }: { album: Album; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <span className={`album-cover ${className} ${failed ? "fallback" : ""}`}>{!failed && <img src={album.artworkUrl} alt={`${album.title} cover`} loading="lazy" onError={() => setFailed(true)} />}{failed && <span><i>commonwax</i><b>{album.title.slice(0, 1)}</b></span>}<em>▶</em></span>;
}

function AlbumDialog({ albumId, onClose, onChanged }: { albumId: string; onClose: () => void; onChanged: () => void }) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [canRemove, setCanRemove] = useState(false);
  const [error, setError] = useState("");
  const player = usePlayer();
  useEffect(() => { Promise.all([api<{ album: Album }>(`/api/albums/${albumId}`), api<{ user: SessionUser }>("/api/session")]).then(([albumData, session]) => { setAlbum(albumData.album); setCanRemove(session.user.permissions.includes("music:remove")); }).catch((issue) => setError(issue.message)); }, [albumId]);
  async function toggleHidden() { if (!album) return; try { if (album.hidden) await remove(`/api/albums/${album.id}/hidden`); else await api(`/api/albums/${album.id}/hidden`, { method: "PUT" }); onChanged(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not update preference."); } }
  async function removeFromLibrary() { if (!album || !window.confirm(`Permanently remove ${album.title} and its files from the shared Library?`)) return; try { await remove(`/api/albums/${album.id}`); onChanged(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not remove album."); } }
  return <Modal title="Album" onClose={onClose} wide>{!album ? <PageLoading /> : <div className="album-detail"><Cover album={album} className="detail-cover" /><div className="album-meta"><p className="eyebrow">Album</p><h2>{album.title}</h2><p className="detail-artist">{album.artist.name}</p><p className="meta-line">{[album.year, album.genre, `${album.songCount} tracks`, formatTime(album.duration)].filter(Boolean).join(" · ")}</p>{album.addedBy && <p className="attribution"><span className="avatar">{initials(album.addedBy.displayName)}</span>Added by <strong>{album.addedBy.displayName}</strong></p>}<div className="button-row"><button className="primary" onClick={() => player.play(album.tracks ?? [])} disabled={!album.tracks?.length}>▶ Play album</button><button className="secondary" onClick={() => void toggleHidden()}>{album.hidden ? "Restore to Library views" : "Hide for me"}</button>{canRemove && <button className="danger-text" onClick={() => void removeFromLibrary()}>Remove from Library</button>}</div></div><div className="detail-tracks"><TrackTable tracks={album.tracks ?? []} compact /></div></div>}<FormError message={error} /></Modal>;
}

function TrackTable({ tracks, compact = false }: { tracks: Track[]; compact?: boolean }) {
  const player = usePlayer();
  return <div className={`track-table ${compact ? "compact" : ""}`}>{tracks.map((track, index) => <button key={track.id} className={player.current?.id === track.id ? "playing" : ""} onClick={() => player.play(tracks, index)}><span className="track-number">{player.current?.id === track.id && player.playing ? "♪" : track.trackNumber ?? index + 1}</span><span><strong>{track.title}</strong>{!compact && <small>{track.artist.name}</small>}</span>{!compact && <span className="track-album">{track.album.title}</span>}<time>{formatTime(track.duration)}</time><span className="row-play">▶</span></button>)}</div>;
}

function ActivityList({ events }: { events: Activity[] }) {
  return <div className="activity-list">{events.map((event) => <article key={event.id}><span className={`activity-icon ${event.type.toLowerCase()}`}>{activityIcon(event.type)}</span><div><p>{activityText(event)}</p><time>{relativeDate(event.createdAt)}</time></div></article>)}</div>;
}

function activityText(event: Activity) {
  const actor = event.actor?.displayName ?? "Someone";
  switch (event.type) {
    case "MUSIC_ADDED": return <><strong>{actor}</strong> added <em>{event.album}</em> by {event.artist}.</>;
    case "MEMBER_JOINED": return <><strong>{actor}</strong> joined the Library.</>;
    case "REQUEST_CREATED": return <><strong>{actor}</strong> requested <em>{event.album}</em> by {event.artist}.</>;
    case "REQUEST_CLAIMED": return <><strong>{actor}</strong> is fulfilling {event.requester ? `${event.requester}’s` : "a"} request for <em>{event.album}</em>.</>;
    case "REQUEST_FULFILLED": return <><strong>{actor}</strong> fulfilled the request for <em>{event.album}</em> by {event.artist}.</>;
  }
}

function activityIcon(type: Activity["type"]) { return ({ MUSIC_ADDED: "♫", MEMBER_JOINED: "◎", REQUEST_CREATED: "＋", REQUEST_CLAIMED: "↗", REQUEST_FULFILLED: "✓" })[type]; }
function SectionHead({ title, action }: { title: string; action?: ReactNode }) { return <div className="section-head"><h2>{title}</h2>{action}</div>; }
function EmptyState({ title, text }: { title: string; text: string }) { return <section className="empty-state"><span>◌</span><h2>{title}</h2><p>{text}</p></section>; }
function PageLoading() { return <div className="page-loading"><span /><span /><span /></div>; }

function Modal({ title, onClose, children, wide = false }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}><section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><span>{title}</span>{onClose && <button className="icon-button" onClick={onClose} aria-label="Close">×</button>}</header><div className="modal-body">{children}</div></section></div>;
}

function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase(); }
function titleCase(value: string) { return value.toLocaleLowerCase().replace(/(^|\s)\w/g, (letter) => letter.toLocaleUpperCase()); }
function dayPart() { const hour = new Date().getHours(); return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"; }
function relativeDate(value: string) { const seconds = Math.round((new Date(value).valueOf() - Date.now()) / 1000); const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); if (Math.abs(seconds) < 60) return formatter.format(seconds, "second"); const minutes = Math.round(seconds / 60); if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute"); const hours = Math.round(minutes / 60); if (Math.abs(hours) < 24) return formatter.format(hours, "hour"); return formatter.format(Math.round(hours / 24), "day"); }
function formatBytes(bytes: number) { if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
