import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { unlink } from "node:fs/promises";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import { z } from "zod";
import { db, Prisma } from "@commonwax/db";
import { Permission } from "@commonwax/permissions";
import { MUSICBRAINZ_SEARCH_FIELDS, rangeParams } from "@commonwax/shared";
import {
  PASSWORD_ROUNDS,
  authenticate,
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  requirePermission,
  revokeAllSessions,
  revokeOtherSessions,
  verifyPassword
} from "./auth.js";
import { activityView, payloadId } from "./activity.js";
import { ServiceControlError, eraseAccount, managedServices, resetEverything, restartServices, serviceControlAvailable } from "./admin.js";
import { artworkBytes, artworkForNames, enqueue, enqueueMissing, listMissingArtists, setManualLogo } from "./artistArt.js";
import {
  bindingReference,
  captureLiveBindingSnapshots,
  catalogHasAlbum,
  deleteSongFiles,
  findAlbumBindingForReference,
  findLiveAlbumForReference,
  getCatalogAlbum,
  getCatalogArtist,
  listCatalogAlbums,
  listCatalogArtists,
  listCatalogTracks,
  listContributedAlbums,
  listRecentCatalogAlbums,
  navReference,
  previewCatalog,
  navidromeIdFromReference,
  refreshAlbumMetadata,
  resolveAvailableAlbumBindings,
  searchCatalog
} from "./catalog.js";
import { config } from "./config.js";
import { UploadError, finishImport, stageUpload, type StagedFile } from "./ingestion.js";
import { listAllAlbums, mediaUrl, pingNavidrome, startScan, streamMediaUrl } from "./navidrome.js";
import { buildLibraryOverview } from "./overview.js";
import { AVATAR_MAX_BYTES, ERASED_PERSON, avatarUrl, isReservedDisplayName, listContributors, personSelect, personView, sniffImageType } from "./people.js";
import { buildProfile } from "./profile.js";
import { rateLimit } from "./rateLimit.js";
import { coverArt, coverArtPath } from "./coverArt.js";
import { searchReleaseGroups } from "./musicbrainz.js";
import { randomToken, sha256 } from "./utils.js";

// Credential and invitation endpoints are the only ones an unauthenticated
// caller can reach in volume, so they carry the tighter budgets.
const credentialLimit = rateLimit({
  name: "credentials",
  windowMs: 15 * 60_000,
  max: 10,
  message: "Too many sign-in attempts. Try again in a few minutes."
});
const invitationLimit = rateLimit({ name: "invitations", windowMs: 15 * 60_000, max: 30 });
// One join screen spends a preview plus a wall of covers, so artwork carries its
// own budget: on the shared one, a second look at the page would lock the
// invitation out.
const invitationArtworkLimit = rateLimit({ name: "invitation-artwork", windowMs: 15 * 60_000, max: 300 });

/** How many covers an invitation shows of the collection behind it. */
const INVITATION_COVERS = 12;

/** A usable invitation: it exists, nobody has accepted it, and it has not expired. */
async function openInvitation(token: unknown) {
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256(String(token)) },
    include: { library: true, createdBy: { select: { displayName: true } } }
  });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) return null;
  return invitation;
}
const writeLimit = rateLimit({ name: "writes", windowMs: 60_000, max: 120 });
// MusicBrainz asks for one request per second per client, and the composer
// searches on demand rather than per keystroke. This keeps one impatient
// member from spending the whole deployment's goodwill with the service.
const musicBrainzLimit = rateLimit({ name: "musicbrainz", windowMs: 60_000, max: 40, message: "Too many searches. Give MusicBrainz a moment." });

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLocaleLowerCase()),
  password: z.string().min(10).max(200)
});
/**
 * One definition of a display name, so the rule that "someone" is spoken for
 * reaches account creation, invitation acceptance, and profile editing alike —
 * rather than the two of them that happened to be edited when it was added.
 */
const displayNameSchema = z.string().trim().min(1).max(80)
  .refine((value) => !isReservedDisplayName(value), { message: `"${ERASED_PERSON.displayName}" is how Commonwax names an erased account. Choose another name.` });
const personSchema = credentialsSchema.extend({ displayName: displayNameSchema });

const upload = multer({
  dest: config.stagingDir,
  limits: { fileSize: config.maxUploadBytes, files: config.maxFilesPerUpload },
  fileFilter: (_request, file, callback) => {
    const extension = file.originalname.toLocaleLowerCase().match(/\.(flac|mp3|aac|m4a|ogg|opus)$/);
    if (extension) callback(null, true);
    // An `UploadError` so the rejection reaches the member as the filename it
    // is about, the same as every other reason an upload can fail.
    else callback(new UploadError(`${file.originalname} is not a supported audio format.`));
  }
});

// Pictures are held in memory rather than staged on disk: they are capped small,
// they go straight into a Postgres column, and nothing about them belongs in the
// music staging directory.
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });

/** Artist logos are stored the same way as avatars: small images in memory. */
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

/**
 * multer caps each file and the file count, but not the batch as a whole.
 * Rejecting on the declared Content-Length refuses an oversized album before
 * any of it reaches the staging volume.
 */
function limitBatchSize(request: Request, _response: Response, next: NextFunction): void {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > config.maxUploadBatchBytes) {
    next(Object.assign(new Error("That upload is larger than the 20 GiB batch limit."), { status: 413 }));
    return;
  }
  next();
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error(result.error.issues[0]?.message ?? "Invalid request");
    (error as any).status = 400;
    throw error;
  }
  return result.data;
}

/** Whose contributions a browsable surface is narrowed to, or null for everyone. */
function addedByParam(request: Request): string | null {
  const value = request.query.addedBy;
  return typeof value === "string" && value ? parse(z.string().uuid(), value) : null;
}

async function proxyMedia(upstream: globalThis.Response, response: Response): Promise<void> {
  if (!upstream.ok || !upstream.body) {
    response.status(upstream.status === 404 ? 404 : 502).json({ error: "Media is not available from Navidrome." });
    return;
  }
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    // A zero Content-Length makes browsers ignore a streamed body. Navidrome
    // can report zero for a transcode whose source bitrate is unknown.
    if (value && !(header === "content-length" && value.trim() === "0")) response.setHeader(header, value);
  }
  response.status(upstream.status);
  const stream = Readable.fromWeb(upstream.body as any);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

async function fetchStream(url: URL, headers: Record<string, string> | undefined, response: Response): Promise<globalThis.Response> {
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), 30_000);
  response.once("close", () => controller.abort());
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    // Once Navidrome has returned the headers, the audio body may legitimately
    // remain open for the full duration of an album track.
    clearTimeout(headerTimeout);
  }
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // nginx is the only hop in front of the API. Without this, every request
  // appears to come from the proxy and the rate limits below would bucket the
  // whole internet together.
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(authenticate);

  app.get("/api/health", async (_request, response) => {
    let database = false;
    let navidrome = false;
    try { await db.$queryRaw`SELECT 1`; database = true; } catch { /* reported below */ }
    try { await pingNavidrome(); navidrome = true; } catch { /* reported below */ }
    response.status(database && navidrome ? 200 : 503).json({ status: database && navidrome ? "ok" : "degraded", database, navidrome });
  });

  app.get("/api/setup/status", async (_request, response) => {
    response.json({ needsSetup: (await db.user.count()) === 0 });
  });

  app.post("/api/setup", credentialLimit, async (request, response) => {
    const input = parse(personSchema.extend({ libraryName: z.string().trim().min(1).max(100) }), request.body);
    const passwordHash = await bcrypt.hash(input.password, PASSWORD_ROUNDS);
    let owner;
    try {
      owner = await db.$transaction(async (tx) => {
        if ((await tx.user.count()) !== 0) {
          const error = new Error("Commonwax has already been set up.");
          (error as any).status = 409;
          throw error;
        }
        const user = await tx.user.create({ data: { email: input.email, displayName: input.displayName, passwordHash } });
        const library = await tx.library.create({ data: { name: input.libraryName } });
        await tx.membership.create({ data: { userId: user.id, libraryId: library.id, role: "OWNER" } });
        return user;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: any) {
      if (error?.code === "P2034") {
        response.status(409).json({ error: "Commonwax was set up in another window." });
        return;
      }
      throw error;
    }
    await createSession(owner.id, response);
    response.status(201).json({ ok: true });
  });

  app.post("/api/auth/login", credentialLimit, async (request, response) => {
    const input = parse(credentialsSchema, request.body);
    const user = await db.user.findUnique({ where: { email: input.email } });
    if (!(await verifyPassword(input.password, user?.passwordHash ?? null)) || !user) {
      response.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    await createSession(user.id, response);
    response.json({ ok: true });
  });

  app.post("/api/auth/logout", async (request, response) => {
    // Signing out ends the listening session too, rather than leaving the member
    // shown as playing until their presence row goes stale.
    if (request.auth) await db.listeningNow.deleteMany({ where: { userId: request.auth.user.id } });
    await destroySession(request, response);
    response.json({ ok: true });
  });

  app.get("/api/session", requireAuth, (request, response) => {
    const auth = request.auth!;
    response.json({
      user: {
        id: auth.user.id,
        email: auth.user.email,
        displayName: auth.user.displayName,
        avatarUrl: avatarUrl(auth.user),
        libraryId: auth.library.id,
        libraryName: auth.library.name,
        role: auth.membership.role,
        permissions: auth.permissions
      }
    });
  });

  app.get("/api/invitations/:token", invitationLimit, async (request, response) => {
    const invitation = await openInvitation(request.params.token);
    if (!invitation) {
      response.status(404).json({ error: "This invitation is invalid or has expired." });
      return;
    }
    const token = encodeURIComponent(String(request.params.token));
    const [memberCount, catalog] = await Promise.all([
      db.membership.count({ where: { libraryId: invitation.libraryId } }),
      // A collection Navidrome cannot answer for right now must never be what
      // stops someone joining, so the preview degrades to nothing and the form
      // below it still works.
      previewCatalog(INVITATION_COVERS).catch(() => null)
    ]);
    response.json({
      libraryName: invitation.library.name,
      // The account that wrote the invitation can be erased before it is
      // opened. The link stays good — it belongs to the Library, not to them.
      invitedBy: invitation.createdBy?.displayName ?? ERASED_PERSON.displayName,
      expiresAt: invitation.expiresAt,
      library: { memberCount, createdAt: invitation.library.createdAt },
      catalog: catalog && {
        albumCount: catalog.albumCount,
        trackCount: catalog.trackCount,
        covers: catalog.covers.map((cover) => ({
          ...cover,
          artworkUrl: `/api/invitations/${token}/artwork/${encodeURIComponent(cover.id)}`
        }))
      }
    });
  });

  // The one media path outside a session. It is scoped by the same invitation
  // the covers were listed under, serves artwork and never audio, and dies with
  // the invitation the moment it is accepted or expires.
  app.get("/api/invitations/:token/artwork/:albumId", invitationArtworkLimit, async (request, response) => {
    const invitation = await openInvitation(request.params.token);
    if (!invitation) return void response.status(404).end();
    const live = await findLiveAlbumForReference(invitation.libraryId, String(request.params.albumId));
    if (!live?.album.coverArt) return void response.status(404).end();
    const upstream = await fetch(mediaUrl("getCoverArt", live.album.coverArt, { size: 600 }), { signal: AbortSignal.timeout(20_000) });
    await proxyMedia(upstream, response);
  });

  app.post("/api/invitations/:token/accept", invitationLimit, async (request, response) => {
    const input = parse(personSchema, request.body);
    const invitation = await openInvitation(request.params.token);
    if (!invitation) {
      response.status(404).json({ error: "This invitation is invalid or has expired." });
      return;
    }
    if (await db.user.findUnique({ where: { email: input.email } })) {
      response.status(409).json({ error: "An account with this email already exists. Sign in first." });
      return;
    }
    const passwordHash = await bcrypt.hash(input.password, PASSWORD_ROUNDS);
    const user = await db.$transaction(async (tx) => {
      const freshInvitation = await tx.invitation.findUnique({ where: { id: invitation.id } });
      if (!freshInvitation || freshInvitation.acceptedAt) throw Object.assign(new Error("This invitation has already been used."), { status: 409 });
      const created = await tx.user.create({ data: { email: input.email, displayName: input.displayName, passwordHash } });
      await tx.membership.create({ data: { userId: created.id, libraryId: invitation.libraryId, role: invitation.role } });
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedById: created.id, acceptedAt: new Date() } });
      await tx.activityEvent.create({ data: { libraryId: invitation.libraryId, actorId: created.id, type: "MEMBER_JOINED", payload: { actor: created.displayName } } });
      return created;
    });
    await createSession(user.id, response);
    response.status(201).json({ ok: true });
  });

  app.post("/api/invitations", requirePermission(Permission.INVITE_MEMBERS), writeLimit, async (request, response) => {
    const input = parse(z.object({ role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"), daysValid: z.number().int().min(1).max(30).default(7) }), request.body ?? {});
    if (input.role === "ADMIN" && request.auth!.membership.role !== "OWNER") {
      response.status(403).json({ error: "Only the owner can invite an admin." });
      return;
    }
    const token = randomToken();
    const invitation = await db.invitation.create({
      data: {
        tokenHash: sha256(token),
        libraryId: request.auth!.library.id,
        createdById: request.auth!.user.id,
        role: input.role,
        expiresAt: new Date(Date.now() + input.daysValid * 86_400_000)
      }
    });
    response.status(201).json({ id: invitation.id, url: `${config.publicUrl}/join/${token}`, expiresAt: invitation.expiresAt });
  });

  app.get("/api/members", requireAuth, async (request, response) => {
    const members = await db.membership.findMany({
      where: { libraryId: request.auth!.library.id },
      include: { user: { select: { ...personSelect, email: true } } },
      orderBy: { joinedAt: "asc" }
    });
    response.json({ members: members.map((member) => ({ id: member.id, role: member.role, joinedAt: member.joinedAt, uploadsBlocked: Boolean(member.uploadsBlockedAt), user: { ...personView(member.user), email: member.user.email } })) });
  });

  // The public face of the server for everyone inside it: who runs it, who is in
  // it, what each of them has been doing, and who is listening right now. Every
  // member sees the same thing, so this is gated on membership alone.
  app.get("/api/library/overview", requireAuth, async (request, response) => {
    const overview = await buildLibraryOverview(request.auth!.library.id);
    if (!overview) return void response.status(404).json({ error: "Library not found." });
    response.json(overview);
  });

  app.patch("/api/members/:membershipId", requirePermission(Permission.MANAGE_MEMBERS), async (request, response) => {
    const input = parse(z.object({ role: z.enum(["ADMIN", "MEMBER"]).optional(), permissionOverrides: z.array(z.string()).nullable().optional(), uploadsBlocked: z.boolean().optional() }), request.body);
    const membership = await db.membership.findFirst({ where: { id: String(request.params.membershipId), libraryId: request.auth!.library.id } });
    if (!membership) return void response.status(404).json({ error: "Member not found." });
    if (membership.role === "OWNER") return void response.status(403).json({ error: "The owner role cannot be changed here." });
    if (membership.userId === request.auth!.user.id) return void response.status(400).json({ error: "You cannot change your own membership." });
    if (membership.role === "ADMIN" && request.auth!.membership.role !== "OWNER") return void response.status(403).json({ error: "Only the owner can manage another admin." });
    if (request.auth!.membership.role !== "OWNER" && input.role === "ADMIN") return void response.status(403).json({ error: "Only the owner can promote an admin." });
    if (request.auth!.membership.role !== "OWNER" && input.permissionOverrides !== undefined) return void response.status(403).json({ error: "Only the owner can customize permissions." });
    const updated = await db.membership.update({
      where: { id: membership.id },
      data: {
        role: input.role,
        permissionOverrides: input.permissionOverrides === undefined ? undefined : input.permissionOverrides === null ? Prisma.JsonNull : input.permissionOverrides,
        // Stored as the moment it was withheld rather than a flag, so the member
        // list can say since when without a second column to keep in step.
        uploadsBlockedAt: input.uploadsBlocked === undefined ? undefined : input.uploadsBlocked ? new Date() : null
      }
    });
    response.json({ membership: { id: updated.id, role: updated.role, uploadsBlocked: Boolean(updated.uploadsBlockedAt) } });
  });

  /**
   * Removing somebody erases the account behind them, which is why `music` is
   * not optional: their contributions either stay in the collection under the
   * "someone" placeholder, or go with them. Guessing either way would be the
   * wrong one half the time, and only one of them can be undone.
   */
  app.delete("/api/members/:membershipId", requirePermission(Permission.MANAGE_MEMBERS), async (request, response) => {
    const music = parse(z.enum(["keep", "delete"]), request.query.music);
    const membership = await db.membership.findFirst({ where: { id: String(request.params.membershipId), libraryId: request.auth!.library.id } });
    if (!membership) return void response.status(404).json({ error: "Member not found." });
    if (membership.role === "OWNER") return void response.status(403).json({ error: "The owner cannot be removed." });
    if (membership.userId === request.auth!.user.id) return void response.status(400).json({ error: "You cannot remove yourself." });
    if (membership.role === "ADMIN" && request.auth!.membership.role !== "OWNER") return void response.status(403).json({ error: "Only the owner can remove an admin." });
    // Before the account goes, so a request in flight on their cookie cannot
    // outlive it and land against a user row that is no longer there.
    await revokeAllSessions(membership.userId);
    const { removedFiles } = await eraseAccount(request.auth!.library.id, membership.userId, { keepMusic: music === "keep" });
    response.json({ removedAlbums: removedFiles });
  });

  // Everyone in a Library can look each other up: names appear all over the
  // product — on covers, in requests, through the feed — and each of them is a
  // way in here. Only your own page carries your email; nobody's address is
  // readable from somebody else's.
  app.get("/api/users/:userId", requireAuth, async (request, response) => {
    const userId = parse(z.string().uuid(), request.params.userId);
    const profile = await buildProfile(request.auth!.library.id, request.auth!.user.id, userId);
    if (!profile) return void response.status(404).json({ error: "That person is not in this Library." });
    response.json({ profile });
  });

  // Split from the profile above because this one asks Navidrome: the page
  // paints who someone is immediately and fills their records in behind it.
  app.get("/api/users/:userId/albums", requirePermission(Permission.LISTEN), async (request, response) => {
    const userId = parse(z.string().uuid(), request.params.userId);
    const libraryId = request.auth!.library.id;
    if (!(await db.membership.findUnique({ where: { userId_libraryId: { userId, libraryId } } }))) {
      return void response.status(404).json({ error: "That person is not in this Library." });
    }
    response.json({ albums: await listContributedAlbums(libraryId, request.auth!.user.id, userId) });
  });

  app.get("/api/users/:userId/avatar", requireAuth, async (request, response) => {
    const userId = parse(z.string().uuid(), request.params.userId);
    const membership = await db.membership.findUnique({
      where: { userId_libraryId: { userId, libraryId: request.auth!.library.id } },
      include: { user: { select: { avatar: true, avatarType: true } } }
    });
    const picture = membership?.user;
    if (!picture?.avatar || !picture.avatarType) return void response.status(404).end();
    // The URL is versioned on the moment the picture was last replaced, so the
    // browser may keep this copy forever. `private` because the picture belongs
    // to one Library and the request that fetched it carried a session cookie.
    response.setHeader("Content-Type", picture.avatarType);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.end(Buffer.from(picture.avatar));
  });

  // Changing what your account *is* — the address you sign in with, or the
  // password itself — is re-authenticated. Your display name is not: it is what
  // the Library already sees, and holding it behind a password would only make
  // people leave it wrong.
  app.patch("/api/users/me", requireAuth, writeLimit, async (request, response) => {
    const input = parse(z.object({
      displayName: displayNameSchema.optional(),
      email: credentialsSchema.shape.email.optional(),
      password: credentialsSchema.shape.password.optional(),
      currentPassword: z.string().max(200).optional()
    }), request.body);
    const auth = request.auth!;
    const reauthenticates = input.email !== undefined || input.password !== undefined;
    if (reauthenticates && !(await verifyPassword(input.currentPassword ?? "", auth.user.passwordHash))) {
      return void response.status(403).json({ error: "Your current password is incorrect." });
    }
    let user;
    try {
      user = await db.user.update({
        where: { id: auth.user.id },
        data: {
          displayName: input.displayName,
          email: input.email,
          passwordHash: input.password === undefined ? undefined : await bcrypt.hash(input.password, PASSWORD_ROUNDS)
        }
      });
    } catch (error: any) {
      if (error?.code === "P2002") return void response.status(409).json({ error: "An account with this email already exists." });
      throw error;
    }
    if (input.password !== undefined) await revokeOtherSessions(request, user.id);
    response.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: avatarUrl(user),
        libraryId: auth.library.id,
        libraryName: auth.library.name,
        role: auth.membership.role,
        permissions: auth.permissions
      }
    });
  });

  app.put("/api/users/me/avatar", requireAuth, writeLimit, avatarUpload.single("avatar"), async (request, response) => {
    const file = request.file;
    if (!file) return void response.status(400).json({ error: "Choose an image." });
    const avatarType = sniffImageType(file.buffer);
    if (!avatarType) return void response.status(400).json({ error: "That file is not a PNG, JPEG, GIF, or WebP image." });
    const user = await db.user.update({
      where: { id: request.auth!.user.id },
      data: { avatar: file.buffer, avatarType, avatarUpdatedAt: new Date() },
      select: personSelect
    });
    response.json({ avatarUrl: avatarUrl(user) });
  });

  app.delete("/api/users/me/avatar", requireAuth, async (request, response) => {
    await db.user.update({
      where: { id: request.auth!.user.id },
      data: { avatar: null, avatarType: null, avatarUpdatedAt: null }
    });
    response.status(204).end();
  });

  app.patch("/api/library", requirePermission(Permission.MANAGE_LIBRARY), async (request, response) => {
    const input = parse(z.object({ name: z.string().trim().min(1).max(100) }), request.body);
    const library = await db.library.update({ where: { id: request.auth!.library.id }, data: { name: input.name } });
    response.json({ library });
  });

  // The names behind the "added by" control that every browsable surface below
  // carries. It answers with contributors rather than members so the filter can
  // only ever name a collection that exists.
  /**
   * What the admin panel can offer on this deployment. Service control needs a
   * Docker proxy the development stack does not have, so the panel asks rather
   * than assuming, and hides the restart controls instead of showing buttons
   * that would answer 503.
   */
  app.get("/api/admin", requirePermission(Permission.CONTROL_SERVICES), (request, response) => {
    response.json({
      services: managedServices(),
      serviceControl: serviceControlAvailable(),
      // Emptying the deployment is the owner's alone: an admin can manage
      // members and restart what is running, not end the collection.
      canReset: request.auth!.permissions.includes(Permission.MANAGE_LIBRARY)
    });
  });

  /**
   * Restarting `api` cuts this connection before the response is written, which
   * is indistinguishable from a failure at the browser. The client is told to
   * watch `/api/health` rather than to trust what it got back from here.
   */
  app.post("/api/admin/restart", requirePermission(Permission.CONTROL_SERVICES), writeLimit, async (request, response) => {
    const input = parse(z.object({ services: z.array(z.string()).min(1).optional() }), request.body ?? {});
    const wanted = input.services ?? managedServices();
    const unknown = wanted.filter((service) => !managedServices().includes(service));
    if (unknown.length) return void response.status(404).json({ error: `Not a service this deployment manages: ${unknown.join(", ")}.` });
    if (!serviceControlAvailable()) return void response.status(503).json({ error: "This deployment has no service control configured." });
    const result = await restartServices(wanted);
    response.json(result);
  });

  /**
   * Empties the deployment back to a fresh install: no accounts, no Library, no
   * music. The owner alone can reach it, and the front end asks twice — a
   * dialog, then a held press — because nothing here is recoverable.
   *
   * The response is written before the session it authenticated with is gone,
   * so the browser learns it worked and then finds `needsSetup` on its next ask.
   */
  app.post("/api/admin/reset", requirePermission(Permission.MANAGE_LIBRARY), async (request, response) => {
    parse(z.object({ confirm: z.literal(true) }), request.body ?? {});
    const result = await resetEverything();
    clearSessionCookie(response);
    response.json({ ok: true, ...result });
  });

  /**
   * Returns the artist names that have no logo cached yet. The admin panel
   * fetches this before showing the "refresh missing" confirmation modal.
   */
  app.get("/api/admin/artists-missing-logos", requirePermission(Permission.MANAGE_LIBRARY), async (_request, response) => {
    const albums = await listAllAlbums();
    const names = [...new Set(albums.map((album) => album.artist).filter((name): name is string => Boolean(name)))];
    const missing = await listMissingArtists(names);
    response.json({ missing, total: names.length });
  });

  /**
   * Re-fetches every artist's logo and background from fanart.tv. Used once
   * after adding image trimming to backfill existing rows. The queue processes
   * names at MusicBrainz's one-request-per-second pace, so a large library
   * takes minutes — the response returns immediately with the count.
   *
   * Pass `?missing=true` to only queue artists with no logo cached yet.
   */
  app.post("/api/admin/refresh-artwork", requirePermission(Permission.MANAGE_LIBRARY), async (request, response) => {
    const albums = await listAllAlbums();
    const names = [...new Set(albums.map((album) => album.artist).filter((name): name is string => Boolean(name)))];
    if (request.query.missing === "true") {
      const queued = await enqueueMissing(names);
      response.json({ queued });
    } else {
      enqueue(names);
      response.json({ queued: names.length });
    }
  });

  app.get("/api/contributors", requirePermission(Permission.LISTEN), async (request, response) => {
    response.json({ contributors: await listContributors(request.auth!.library.id) });
  });

  app.get("/api/albums", requirePermission(Permission.LISTEN), async (request, response) => {
    const showHidden = request.query.hidden === "true";
    const albums = await listCatalogAlbums(request.auth!.library.id, request.auth!.user.id, showHidden, addedByParam(request));
    response.json({ albums });
  });

  app.get("/api/albums/recent", requirePermission(Permission.LISTEN), async (request, response) => {
    const albums = await listRecentCatalogAlbums(request.auth!.library.id, request.auth!.user.id, addedByParam(request));
    response.json({ albums });
  });

  app.get("/api/albums/:albumId", requirePermission(Permission.LISTEN), async (request, response) => {
    const album = await getCatalogAlbum(request.auth!.library.id, request.auth!.user.id, String(request.params.albumId));
    if (!album) return void response.status(404).json({ error: "Album not found." });
    response.json({ album });
  });

  // Refreshing an album's metadata rescans the whole collection and holds this
  // request open while it runs, so it is gated as the curation act it is rather
  // than as listening, and budgeted: without the limiter one member could keep
  // a large deployment permanently mid-scan.
  app.post("/api/albums/:albumId/refresh-metadata", requirePermission(Permission.CONTRIBUTE), writeLimit, async (request, response) => {
    const album = await refreshAlbumMetadata(request.auth!.library.id, request.auth!.user.id, String(request.params.albumId));
    if (!album) return void response.status(404).json({ error: "Album not found in Navidrome." });
    response.json({ album });
  });

  app.get("/api/artists", requirePermission(Permission.LISTEN), async (request, response) => {
    const artists = await listCatalogArtists(request.auth!.library.id, request.auth!.user.id, addedByParam(request));
    response.json({ artists });
  });

  /**
   * Logos for a list of artist names.
   *
   * Albums, tracks, and now-playing all carry an artist's name and nothing
   * about their artwork, and they are built in a dozen places from views that
   * make no such lookup. This is the one read those surfaces share instead:
   * names in, whatever is cached for them out, on exactly the terms every other
   * artwork read has — nothing waits on fanart.tv, and the names with no answer
   * are queued behind the response.
   */
  app.post("/api/artists/logos", requirePermission(Permission.LISTEN), async (request, response) => {
    const names = parse(z.array(z.string().min(1).max(300)).max(400), (request.body as { names?: unknown } | undefined)?.names ?? []);
    const artwork = await artworkForNames(names);
    response.json({ logos: Object.fromEntries([...artwork].map(([key, view]) => [key, view.logoUrl])) });
  });

  // Before `/api/artists/:artistId` only for the reader: Express matches one
  // path segment per parameter, so a three-segment artwork path could not reach
  // the single-segment route below whatever the order.
  app.get("/api/artists/artwork/:artworkId/:kind", requirePermission(Permission.LISTEN), async (request, response) => {
    const artworkId = parse(z.string().uuid(), request.params.artworkId);
    const kind = parse(z.enum(["logo", "background"]), request.params.kind);
    const image = await artworkBytes(artworkId, kind);
    if (!image) return void response.status(404).end();
    // Versioned on the moment the row last changed, so this copy may be kept
    // forever. `private` for the same reason an avatar is: the request that
    // fetched it carried a session cookie.
    response.setHeader("Content-Type", image.type);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.end(image.bytes);
  });

  app.put("/api/artists/:artistId/logo", requirePermission(Permission.MANAGE_LIBRARY), logoUpload.single("logo"), async (request, response) => {
    const file = request.file;
    if (!file) return void response.status(400).json({ error: "Choose an image file." });
    const artist = await getCatalogArtist(request.auth!.library.id, request.auth!.user.id, String(request.params.artistId));
    if (!artist) return void response.status(404).json({ error: "Artist not found." });
    const logoUrl = await setManualLogo(artist.name, file.buffer);
    if (!logoUrl) return void response.status(400).json({ error: "That file is not a PNG, JPEG, GIF, or WebP image." });
    response.json({ logoUrl });
  });

  app.get("/api/artists/:artistId", requirePermission(Permission.LISTEN), async (request, response) => {
    const artist = await getCatalogArtist(request.auth!.library.id, request.auth!.user.id, String(request.params.artistId), addedByParam(request));
    if (!artist) return void response.status(404).json({ error: "Artist not found." });
    response.json({ artist });
  });

  app.get("/api/tracks", requirePermission(Permission.LISTEN), async (request, response) => {
    const tracks = await listCatalogTracks(request.auth!.library.id, request.auth!.user.id, addedByParam(request));
    response.json({ tracks });
  });

  app.get("/api/search", requirePermission(Permission.LISTEN), async (request, response) => {
    const query = String(request.query.q ?? "").trim().slice(0, 100);
    if (!query) return void response.json({ artists: [], albums: [], tracks: [] });
    response.json(await searchCatalog(request.auth!.library.id, request.auth!.user.id, query, addedByParam(request)));
  });

  app.put("/api/albums/:albumId/hidden", requirePermission(Permission.LISTEN), async (request, response) => {
    const albumBinding = await findAlbumBindingForReference(request.auth!.library.id, String(request.params.albumId), true);
    if (!albumBinding) return void response.status(404).json({ error: "Album not found in Navidrome." });
    await db.hiddenAlbum.upsert({
      where: { userId_albumBindingId: { userId: request.auth!.user.id, albumBindingId: albumBinding.id } },
      create: { userId: request.auth!.user.id, libraryId: request.auth!.library.id, albumBindingId: albumBinding.id },
      update: {}
    });
    response.json({ hidden: true });
  });

  app.delete("/api/albums/:albumId/hidden", requirePermission(Permission.LISTEN), async (request, response) => {
    const albumBinding = await findAlbumBindingForReference(request.auth!.library.id, String(request.params.albumId), false);
    if (albumBinding) {
      await db.hiddenAlbum.deleteMany({ where: { userId: request.auth!.user.id, libraryId: request.auth!.library.id, albumBindingId: albumBinding.id } });
      await db.mediaAlbumBinding.deleteMany({
        where: {
          id: albumBinding.id,
          libraryId: request.auth!.library.id,
          hiddenBy: { none: {} },
          contributions: { none: {} },
          fulfilledFor: { none: {} },
          trackBindings: { none: {} }
        }
      });
    }
    response.status(204).end();
  });

  app.get("/api/albums/:albumId/artwork", requirePermission(Permission.LISTEN), async (request, response) => {
    const live = await findLiveAlbumForReference(request.auth!.library.id, String(request.params.albumId));
    if (!live?.album.coverArt) return void response.status(404).end();
    const upstream = await fetch(mediaUrl("getCoverArt", live.album.coverArt, { size: 600 }), { signal: AbortSignal.timeout(20_000) });
    await proxyMedia(upstream, response);
  });

  app.get("/api/tracks/:trackId/stream", requirePermission(Permission.LISTEN), async (request, response) => {
    const navidromeId = navidromeIdFromReference(String(request.params.trackId));
    if (!navidromeId) return void response.status(404).json({ error: "Track not found." });
    const headers = request.headers.range ? { Range: request.headers.range } : undefined;
    const upstream = await fetchStream(streamMediaUrl(navidromeId), headers, response);
    await proxyMedia(upstream, response);
  });

  // The player refreshes this while audio is actually playing and clears it when
  // playback stops; readers additionally discard anything that has gone stale, so
  // a browser that simply disappears stops being reported on its own.
  app.put("/api/now-playing", requirePermission(Permission.LISTEN), writeLimit, async (request, response) => {
    const input = parse(z.object({ trackId: z.string().trim().min(1).max(400) }), request.body);
    if (!navidromeIdFromReference(input.trackId)) {
      return void response.status(400).json({ error: "That is not a playable track." });
    }
    const userId = request.auth!.user.id;
    const libraryId = request.auth!.library.id;
    const existing = await db.listeningNow.findUnique({ where: { userId } });
    const sameTrack = existing?.libraryId === libraryId && existing.trackReference === input.trackId;
    await db.listeningNow.upsert({
      where: { userId },
      create: { userId, libraryId, trackReference: input.trackId },
      // A heartbeat on the same track keeps its original start time; moving to
      // another track restarts it.
      update: { libraryId, trackReference: input.trackId, ...(sameTrack ? {} : { startedAt: new Date() }) }
    });
    response.status(204).end();
  });

  app.delete("/api/now-playing", requireAuth, async (request, response) => {
    await db.listeningNow.deleteMany({ where: { userId: request.auth!.user.id } });
    response.status(204).end();
  });

  app.post("/api/uploads", requirePermission(Permission.CONTRIBUTE), writeLimit, limitBatchSize, upload.array("files", config.maxFilesPerUpload), async (request, response) => {
    const files = (request.files as Express.Multer.File[] | undefined) ?? [];
    const requestId = typeof request.body?.requestId === "string" && request.body.requestId ? request.body.requestId : undefined;
    if (requestId && !request.auth!.permissions.includes(Permission.FULFILL_REQUEST)) {
      throw Object.assign(new Error("You do not have permission to fulfill requests."), { status: 403 });
    }
    const { batch, skipped } = await stageUpload(request.auth!.library.id, request.auth!.user.id, files as StagedFile[], requestId);
    const completed = await finishImport(batch.id);
    response.status(201).json({ upload: completed, skipped });
  });

  app.post("/api/uploads/:batchId/retry", requirePermission(Permission.CONTRIBUTE), async (request, response) => {
    const batch = await db.uploadBatch.findFirst({ where: { id: String(request.params.batchId), libraryId: request.auth!.library.id, uploaderId: request.auth!.user.id, status: "FAILED" } });
    if (!batch) return void response.status(404).json({ error: "Failed upload not found." });
    const completed = await finishImport(batch.id);
    response.json({ upload: completed });
  });

  app.delete("/api/albums/:albumId", requirePermission(Permission.REMOVE_MUSIC), async (request, response) => {
    const live = await findLiveAlbumForReference(request.auth!.library.id, String(request.params.albumId));
    if (!live) return void response.status(404).json({ error: "Album not found in Navidrome." });
    await captureLiveBindingSnapshots(request.auth!.library.id, request.auth!.user.id, live);
    await deleteSongFiles(live.songs.map((song) => song.id));
    await startScan();
    response.status(204).end();
  });

  // Every field the release-group index accepts is readable here under its own
  // MusicBrainz name, so the composer can offer all of them without this route
  // growing a case per field. Ranges arrive as `<field>From`/`<field>To`.
  app.get("/api/requests/search", requireAuth, musicBrainzLimit, async (request, response) => {
    const text = (value: unknown) => {
      const single = Array.isArray(value) ? value[0] : value;
      return typeof single === "string" ? single.slice(0, 200) : undefined;
    };
    const fields: Record<string, string | undefined> = {};
    const ranges: Record<string, { from?: string; to?: string }> = {};
    for (const field of MUSICBRAINZ_SEARCH_FIELDS) {
      if (field.kind === "dateRange" || field.kind === "numberRange") {
        const { from, to } = rangeParams(field.name);
        ranges[field.name] = { from: text(request.query[from]), to: text(request.query[to]) };
      } else {
        fields[field.name] = text(request.query[field.name]);
      }
    }
    const page = parse(z.object({
      limit: z.coerce.number().int().min(1).max(50).default(25),
      offset: z.coerce.number().int().min(0).max(500).default(0)
    }), { limit: request.query.limit ?? undefined, offset: request.query.offset ?? undefined });

    try {
      const found = await searchReleaseGroups({ fields, ranges, limit: page.limit, offset: page.offset });
      response.json(found);
    } catch (error) {
      console.error("MusicBrainz search failed:", error);
      response.status(502).json({ error: "Could not reach MusicBrainz." });
    }
  });

  // The browser cannot reach the Cover Art Archive itself: the deployed CSP is
  // `img-src 'self' data:`. Covers come back through here instead.
  app.get("/api/requests/cover/:releaseGroupId", requireAuth, musicBrainzLimit, async (request, response) => {
    const releaseGroupId = parse(z.string().uuid(), request.params.releaseGroupId);
    let image;
    try {
      image = await coverArt(releaseGroupId);
    } catch (error) {
      console.error("Cover art fetch failed:", error);
      return void response.status(502).end();
    }
    if (!image) return void response.status(404).end();
    response.setHeader("Content-Type", image.type);
    // `private` for the same reason artist artwork is: the request that fetched
    // it carried a session cookie.
    response.setHeader("Cache-Control", "private, max-age=86400");
    response.end(image.bytes);
  });

  app.get("/api/requests", requireAuth, async (request, response) => {
    const requests = await db.musicRequest.findMany({
      where: { libraryId: request.auth!.library.id },
      include: {
        requester: { select: personSelect },
        claimant: { select: personSelect },
        fulfiller: { select: personSelect },
        fulfilledAlbumBinding: true
      },
      orderBy: { createdAt: "desc" }
    });
    const fulfilledBindings = [...new Map(requests.flatMap((musicRequest) =>
      musicRequest.fulfilledAlbumBinding ? [[musicRequest.fulfilledAlbumBinding.id, musicRequest.fulfilledAlbumBinding] as const] : []
    )).values()];
    const liveByBindingId = await resolveAvailableAlbumBindings(request.auth!.library.id, fulfilledBindings);
    response.json({
      requests: requests.map(({ fulfilledAlbumBinding, requester, claimant, fulfiller, ...musicRequest }) => ({
        ...musicRequest,
        // Derived rather than stored, so a request and a search result carry the
        // same shape and there is only one place the path is spelled.
        coverArtUrl: musicRequest.musicBrainzReleaseGroupId ? coverArtPath(musicRequest.musicBrainzReleaseGroupId) : null,
        requester: personView(requester),
        claimant: claimant && personView(claimant),
        fulfiller: fulfiller && personView(fulfiller),
        fulfilledAlbum: fulfilledAlbumBinding ? (() => {
          const live = liveByBindingId.get(fulfilledAlbumBinding.id);
          return live ? {
            id: navReference(live.id),
            title: live.name || live.title || "Untitled Album",
            available: true
          } : {
            id: bindingReference(fulfilledAlbumBinding.id),
            title: fulfilledAlbumBinding.lastKnownTitle,
            available: false
          };
        })() : null
      }))
    });
  });

  app.post("/api/requests", requirePermission(Permission.CREATE_REQUEST), async (request, response) => {
    const input = parse(z.object({
      artist: z.string().trim().min(1).max(160),
      album: z.string().trim().min(1).max(160),
      musicBrainzReleaseGroupId: z.string().trim().uuid().optional().nullable(),
      year: z.number().int().min(1900).max(2100).optional().nullable()
    }), request.body);
    if (await catalogHasAlbum(input.artist, input.album)) {
      return void response.status(409).json({ error: "That album is already in the Library." });
    }
    // Prevent duplicate requests for the same MusicBrainz release group.
    if (input.musicBrainzReleaseGroupId) {
      const existing = await db.musicRequest.findFirst({
        where: { libraryId: request.auth!.library.id, musicBrainzReleaseGroupId: input.musicBrainzReleaseGroupId }
      });
      if (existing) return void response.status(409).json({ error: "That album has already been requested." });
    }
    const musicRequest = await db.$transaction(async (tx) => {
      const created = await tx.musicRequest.create({
        data: {
          libraryId: request.auth!.library.id,
          artist: input.artist,
          album: input.album,
          requesterId: request.auth!.user.id,
          musicBrainzReleaseGroupId: input.musicBrainzReleaseGroupId ?? null,
          year: input.year ?? null
        },
        include: { requester: { select: personSelect }, claimant: true, fulfiller: true }
      });
      await tx.activityEvent.create({
        data: { libraryId: request.auth!.library.id, actorId: request.auth!.user.id, type: "REQUEST_CREATED", payload: { requestId: created.id, artist: created.artist, album: created.album, actor: request.auth!.user.displayName } }
      });
      return created;
    });
    response.status(201).json({ request: musicRequest });
  });

  app.post("/api/requests/:requestId/claim", requirePermission(Permission.FULFILL_REQUEST), async (request, response) => {
    const musicRequest = await db.musicRequest.findFirst({ where: { id: String(request.params.requestId), libraryId: request.auth!.library.id } });
    if (!musicRequest) return void response.status(404).json({ error: "Request not found." });
    if (musicRequest.status !== "OPEN") return void response.status(409).json({ error: "This request is no longer open." });
    if (musicRequest.requesterId === request.auth!.user.id) return void response.status(400).json({ error: "Another member must fulfill your request." });
    const claimed = await db.$transaction(async (tx) => {
      const result = await tx.musicRequest.updateMany({ where: { id: musicRequest.id, status: "OPEN" }, data: { status: "CLAIMED", claimantId: request.auth!.user.id, claimedAt: new Date() } });
      if (result.count !== 1) throw Object.assign(new Error("This request was claimed by someone else."), { status: 409 });
      const updated = await tx.musicRequest.findUnique({ where: { id: musicRequest.id }, include: { requester: { select: personSelect }, claimant: { select: personSelect } } });
      await tx.activityEvent.create({
        data: { libraryId: request.auth!.library.id, actorId: request.auth!.user.id, type: "REQUEST_CLAIMED", payload: { requestId: musicRequest.id, artist: musicRequest.artist, album: musicRequest.album, actor: request.auth!.user.displayName, requester: updated!.requester?.displayName ?? ERASED_PERSON.displayName } }
      });
      return updated;
    });
    response.json({ request: claimed });
  });

  app.post("/api/requests/:requestId/cancel", requireAuth, async (request, response) => {
    const musicRequest = await db.musicRequest.findFirst({ where: { id: String(request.params.requestId), libraryId: request.auth!.library.id } });
    if (!musicRequest) return void response.status(404).json({ error: "Request not found." });
    const canManage = request.auth!.permissions.includes(Permission.MANAGE_MEMBERS);
    if (musicRequest.requesterId !== request.auth!.user.id && !canManage) return void response.status(403).json({ error: "Only the requester or a library manager can cancel this request." });
    if (musicRequest.status === "FULFILLED") return void response.status(409).json({ error: "This request can no longer be cancelled." });
    await db.musicRequest.delete({ where: { id: musicRequest.id } });
    response.status(204).end();
  });

  app.get("/api/activity", requireAuth, async (request, response) => {
    const events = await db.activityEvent.findMany({
      where: { libraryId: request.auth!.library.id },
      include: { actor: { select: personSelect } },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    const contributionIds = events.flatMap((event) => {
      const id = event.type === "MUSIC_ADDED" ? payloadId(event, "contributionId") : null;
      return id ? [id] : [];
    });
    const requestIds = events.flatMap((event) => {
      const id = event.type === "REQUEST_FULFILLED" ? payloadId(event, "requestId") : null;
      return id ? [id] : [];
    });
    const [contributions, fulfilledRequests] = await Promise.all([
      db.contribution.findMany({
        where: { id: { in: contributionIds }, libraryId: request.auth!.library.id },
        include: { albumBinding: true }
      }),
      db.musicRequest.findMany({
        where: { id: { in: requestIds }, libraryId: request.auth!.library.id },
        include: { fulfilledAlbumBinding: true }
      })
    ]);
    const contributionBindings = new Map(contributions.map((contribution) => [contribution.id, contribution.albumBinding]));
    const requestBindings = new Map(fulfilledRequests.flatMap((musicRequest) =>
      musicRequest.fulfilledAlbumBinding ? [[musicRequest.id, musicRequest.fulfilledAlbumBinding] as const] : []
    ));
    const activityBindings = [...new Map([
      ...contributions.map((contribution) => [contribution.albumBinding.id, contribution.albumBinding] as const),
      ...fulfilledRequests.flatMap((musicRequest) =>
        musicRequest.fulfilledAlbumBinding ? [[musicRequest.fulfilledAlbumBinding.id, musicRequest.fulfilledAlbumBinding] as const] : []
      )
    ]).values()];
    const liveByBindingId = await resolveAvailableAlbumBindings(request.auth!.library.id, activityBindings);
    response.json({
      events: events.map((event) => {
        const binding = event.type === "MUSIC_ADDED"
          ? contributionBindings.get(payloadId(event, "contributionId") ?? "")
          : event.type === "REQUEST_FULFILLED"
            ? requestBindings.get(payloadId(event, "requestId") ?? "")
            : undefined;
        if (event.type !== "MUSIC_ADDED" && event.type !== "REQUEST_FULFILLED") return activityView(event);
        const live = binding ? liveByBindingId.get(binding.id) : null;
        return activityView(event, {
          mediaAvailable: Boolean(live),
          mediaId: live ? navReference(live.id) : binding ? bindingReference(binding.id) : null
        });
      })
    });
  });

  app.use("/api", (_request, response) => response.status(404).json({ error: "Not found." }));

  app.use((error: any, request: Request, response: Response, _next: NextFunction) => {
    if (request.files && Array.isArray(request.files)) {
      Promise.all(request.files.map((file: Express.Multer.File) => unlink(file.path).catch(() => undefined))).catch(() => undefined);
    }
    const status = Number(error?.status ?? (error instanceof multer.MulterError ? 400 : 500));
    if (status >= 500) console.error(error);
    // A 5xx normally says nothing back, because its message is an internal
    // detail. Two kinds of failure are the exception. A service-control failure
    // is addressed to the host, who is the only one who can see it, and naming
    // the container Docker could not find is the entire value of the message.
    // An upload failure is addressed to the member holding the files: whether
    // to retry, retag, or pick different ones is theirs to decide, and they
    // have no other way to find out.
    const speakable = status < 500 || error instanceof ServiceControlError || error instanceof UploadError;
    response.status(status).json({ error: speakable ? error?.message ?? "Invalid request." : "Something went wrong." });
  });

  return app;
}
