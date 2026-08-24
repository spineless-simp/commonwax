import { Readable } from "node:stream";
import { resolve } from "node:path";
import { unlink } from "node:fs/promises";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import { z } from "zod";
import { db, Prisma } from "@commonwax/db";
import { Permission } from "@commonwax/permissions";
import { authenticate, createSession, destroySession, requireAuth, requirePermission } from "./auth.js";
import { albumView, syncCatalog, trackView } from "./catalog.js";
import { config } from "./config.js";
import { finishImport, stageUpload, type StagedFile } from "./ingestion.js";
import { mediaUrl, pingNavidrome, startScan } from "./navidrome.js";
import { asStringArray, insideDirectory, normalized, randomToken, sha256 } from "./utils.js";

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLocaleLowerCase()),
  password: z.string().min(10).max(200)
});
const personSchema = credentialsSchema.extend({ displayName: z.string().trim().min(1).max(80) });

const upload = multer({
  dest: config.stagingDir,
  limits: { fileSize: config.maxUploadBytes, files: config.maxFilesPerUpload },
  fileFilter: (_request, file, callback) => {
    const extension = file.originalname.toLocaleLowerCase().match(/\.(flac|mp3|aac|m4a|ogg|opus)$/);
    if (extension) callback(null, true);
    else callback(new Error(`${file.originalname} is not a supported audio format.`));
  }
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error(result.error.issues[0]?.message ?? "Invalid request");
    (error as any).status = 400;
    throw error;
  }
  return result.data;
}

function activityView(event: any) {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    actor: event.actor ? { id: event.actor.id, displayName: event.actor.displayName } : null,
    ...event.payload
  };
}

async function proxyMedia(upstream: globalThis.Response, response: Response): Promise<void> {
  if (!upstream.ok || !upstream.body) {
    response.status(upstream.status === 404 ? 404 : 502).json({ error: "Media is not available from Navidrome." });
    return;
  }
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
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

  app.post("/api/setup", async (request, response) => {
    const input = parse(personSchema.extend({ libraryName: z.string().trim().min(1).max(100) }), request.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
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

  app.post("/api/auth/login", async (request, response) => {
    const input = parse(credentialsSchema, request.body);
    const user = await db.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      response.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    await createSession(user.id, response);
    response.json({ ok: true });
  });

  app.post("/api/auth/logout", async (request, response) => {
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
        libraryId: auth.library.id,
        libraryName: auth.library.name,
        role: auth.membership.role,
        permissions: auth.permissions
      }
    });
  });

  app.get("/api/invitations/:token", async (request, response) => {
    const invitation = await db.invitation.findUnique({
      where: { tokenHash: sha256(String(request.params.token)) },
      include: { library: true, createdBy: { select: { displayName: true } } }
    });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      response.status(404).json({ error: "This invitation is invalid or has expired." });
      return;
    }
    response.json({ libraryName: invitation.library.name, invitedBy: invitation.createdBy.displayName, expiresAt: invitation.expiresAt });
  });

  app.post("/api/invitations/:token/accept", async (request, response) => {
    const input = parse(personSchema, request.body);
    const tokenHash = sha256(String(request.params.token));
    const invitation = await db.invitation.findUnique({ where: { tokenHash } });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      response.status(404).json({ error: "This invitation is invalid or has expired." });
      return;
    }
    if (await db.user.findUnique({ where: { email: input.email } })) {
      response.status(409).json({ error: "An account with this email already exists. Sign in first." });
      return;
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
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

  app.post("/api/invitations", requirePermission(Permission.INVITE_MEMBERS), async (request, response) => {
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
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { joinedAt: "asc" }
    });
    response.json({ members: members.map((member) => ({ id: member.id, role: member.role, joinedAt: member.joinedAt, user: member.user })) });
  });

  app.patch("/api/members/:membershipId", requirePermission(Permission.MANAGE_MEMBERS), async (request, response) => {
    const input = parse(z.object({ role: z.enum(["ADMIN", "MEMBER"]).optional(), permissionOverrides: z.array(z.string()).nullable().optional() }), request.body);
    const membership = await db.membership.findFirst({ where: { id: String(request.params.membershipId), libraryId: request.auth!.library.id } });
    if (!membership) return void response.status(404).json({ error: "Member not found." });
    if (membership.role === "OWNER") return void response.status(403).json({ error: "The owner role cannot be changed here." });
    if (membership.userId === request.auth!.user.id) return void response.status(400).json({ error: "You cannot change your own membership." });
    if (membership.role === "ADMIN" && request.auth!.membership.role !== "OWNER") return void response.status(403).json({ error: "Only the owner can manage another admin." });
    if (request.auth!.membership.role !== "OWNER" && input.role === "ADMIN") return void response.status(403).json({ error: "Only the owner can promote an admin." });
    if (request.auth!.membership.role !== "OWNER" && input.permissionOverrides !== undefined) return void response.status(403).json({ error: "Only the owner can customize permissions." });
    const updated = await db.membership.update({
      where: { id: membership.id },
      data: { role: input.role, permissionOverrides: input.permissionOverrides === undefined ? undefined : input.permissionOverrides === null ? Prisma.JsonNull : input.permissionOverrides }
    });
    response.json({ membership: updated });
  });

  app.delete("/api/members/:membershipId", requirePermission(Permission.MANAGE_MEMBERS), async (request, response) => {
    const membership = await db.membership.findFirst({ where: { id: String(request.params.membershipId), libraryId: request.auth!.library.id } });
    if (!membership) return void response.status(404).json({ error: "Member not found." });
    if (membership.role === "OWNER") return void response.status(403).json({ error: "The owner cannot be removed." });
    if (membership.userId === request.auth!.user.id) return void response.status(400).json({ error: "You cannot remove yourself." });
    if (membership.role === "ADMIN" && request.auth!.membership.role !== "OWNER") return void response.status(403).json({ error: "Only the owner can remove an admin." });
    await db.membership.delete({ where: { id: membership.id } });
    response.status(204).end();
  });

  app.patch("/api/library", requirePermission(Permission.MANAGE_LIBRARY), async (request, response) => {
    const input = parse(z.object({ name: z.string().trim().min(1).max(100) }), request.body);
    const library = await db.library.update({ where: { id: request.auth!.library.id }, data: { name: input.name } });
    response.json({ library });
  });

  app.post("/api/catalog/sync", requirePermission(Permission.MANAGE_LIBRARY), async (request, response) => {
    await syncCatalog(request.auth!.library.id);
    response.json({ ok: true });
  });

  app.get("/api/albums", requirePermission(Permission.LISTEN), async (request, response) => {
    const libraryId = request.auth!.library.id;
    if ((await db.album.count({ where: { libraryId } })) === 0) await syncCatalog(libraryId).catch(() => undefined);
    const showHidden = request.query.hidden === "true";
    const albums = await db.album.findMany({
      where: {
        libraryId,
        ...(showHidden ? { hiddenBy: { some: { userId: request.auth!.user.id } } } : { hiddenBy: { none: { userId: request.auth!.user.id } } })
      },
      include: {
        artist: true,
        hiddenBy: { where: { userId: request.auth!.user.id }, take: 1 },
        contributions: { orderBy: { createdAt: "desc" }, take: 1, include: { contributor: { select: { id: true, displayName: true } } } }
      },
      orderBy: [{ title: "asc" }]
    });
    response.json({ albums: albums.map(albumView) });
  });

  app.get("/api/albums/recent", requirePermission(Permission.LISTEN), async (request, response) => {
    const albums = await db.album.findMany({
      where: { libraryId: request.auth!.library.id, hiddenBy: { none: { userId: request.auth!.user.id } } },
      include: {
        artist: true,
        hiddenBy: { where: { userId: request.auth!.user.id }, take: 1 },
        contributions: { orderBy: { createdAt: "desc" }, take: 1, include: { contributor: { select: { id: true, displayName: true } } } }
      },
      orderBy: [{ navidromeAdded: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 20
    });
    response.json({ albums: albums.map(albumView) });
  });

  app.get("/api/albums/:albumId", requirePermission(Permission.LISTEN), async (request, response) => {
    const album = await db.album.findFirst({
      where: { id: String(request.params.albumId), libraryId: request.auth!.library.id },
      include: {
        artist: true,
        hiddenBy: { where: { userId: request.auth!.user.id }, take: 1 },
        contributions: { orderBy: { createdAt: "desc" }, take: 1, include: { contributor: { select: { id: true, displayName: true } } } },
        tracks: { orderBy: [{ discNumber: "asc" }, { trackNumber: "asc" }, { title: "asc" }], include: { artist: true, album: true } }
      }
    });
    if (!album) return void response.status(404).json({ error: "Album not found." });
    response.json({ album: { ...albumView(album), tracks: album.tracks.map(trackView) } });
  });

  app.get("/api/artists", requirePermission(Permission.LISTEN), async (request, response) => {
    const artists = await db.artist.findMany({
      where: { libraryId: request.auth!.library.id, albums: { some: { hiddenBy: { none: { userId: request.auth!.user.id } } } } },
      include: {
        albums: {
          where: { hiddenBy: { none: { userId: request.auth!.user.id } } },
          include: { artist: true, hiddenBy: false, contributions: { orderBy: { createdAt: "desc" }, take: 1, include: { contributor: { select: { id: true, displayName: true } } } } },
          orderBy: { title: "asc" }
        }
      },
      orderBy: { name: "asc" }
    });
    response.json({ artists: artists.map((artist) => ({ id: artist.id, name: artist.name, albumCount: artist.albums.length, albums: artist.albums.map(albumView) })) });
  });

  app.get("/api/tracks", requirePermission(Permission.LISTEN), async (request, response) => {
    const tracks = await db.track.findMany({
      where: { libraryId: request.auth!.library.id, album: { hiddenBy: { none: { userId: request.auth!.user.id } } } },
      include: { artist: true, album: true },
      orderBy: [{ title: "asc" }]
    });
    response.json({ tracks: tracks.map(trackView) });
  });

  app.get("/api/search", requirePermission(Permission.LISTEN), async (request, response) => {
    const query = String(request.query.q ?? "").trim().slice(0, 100);
    if (!query) return void response.json({ artists: [], albums: [], tracks: [] });
    const libraryId = request.auth!.library.id;
    const visible = { none: { userId: request.auth!.user.id } };
    const [artists, albums, tracks] = await Promise.all([
      db.artist.findMany({ where: { libraryId, name: { contains: query, mode: "insensitive" }, albums: { some: { hiddenBy: visible } } }, take: 20, orderBy: { name: "asc" } }),
      db.album.findMany({ where: { libraryId, title: { contains: query, mode: "insensitive" }, hiddenBy: visible }, include: { artist: true, hiddenBy: false, contributions: { orderBy: { createdAt: "desc" }, take: 1, include: { contributor: { select: { id: true, displayName: true } } } } }, take: 30 }),
      db.track.findMany({ where: { libraryId, title: { contains: query, mode: "insensitive" }, album: { hiddenBy: visible } }, include: { artist: true, album: true }, take: 50 })
    ]);
    response.json({ artists: artists.map(({ id, name, albumCount }) => ({ id, name, albumCount })), albums: albums.map(albumView), tracks: tracks.map(trackView) });
  });

  app.put("/api/albums/:albumId/hidden", requirePermission(Permission.LISTEN), async (request, response) => {
    const album = await db.album.findFirst({ where: { id: String(request.params.albumId), libraryId: request.auth!.library.id } });
    if (!album) return void response.status(404).json({ error: "Album not found." });
    await db.hiddenAlbum.upsert({
      where: { userId_albumId: { userId: request.auth!.user.id, albumId: album.id } },
      create: { userId: request.auth!.user.id, libraryId: request.auth!.library.id, albumId: album.id },
      update: {}
    });
    response.json({ hidden: true });
  });

  app.delete("/api/albums/:albumId/hidden", requirePermission(Permission.LISTEN), async (request, response) => {
    await db.hiddenAlbum.deleteMany({ where: { userId: request.auth!.user.id, libraryId: request.auth!.library.id, albumId: String(request.params.albumId) } });
    response.status(204).end();
  });

  app.get("/api/albums/:albumId/artwork", requirePermission(Permission.LISTEN), async (request, response) => {
    const album = await db.album.findFirst({ where: { id: String(request.params.albumId), libraryId: request.auth!.library.id } });
    if (!album?.coverArt) return void response.status(404).end();
    const upstream = await fetch(mediaUrl("getCoverArt", album.coverArt, { size: 600 }), { signal: AbortSignal.timeout(20_000) });
    await proxyMedia(upstream, response);
  });

  app.get("/api/tracks/:trackId/stream", requirePermission(Permission.LISTEN), async (request, response) => {
    const track = await db.track.findFirst({ where: { id: String(request.params.trackId), libraryId: request.auth!.library.id } });
    if (!track) return void response.status(404).json({ error: "Track not found." });
    const headers = request.headers.range ? { Range: request.headers.range } : undefined;
    const upstream = await fetchStream(mediaUrl("stream", track.navidromeId, { format: "mp3", estimateContentLength: "true" }), headers, response);
    await proxyMedia(upstream, response);
  });

  app.post("/api/uploads", requirePermission(Permission.CONTRIBUTE), upload.array("files", config.maxFilesPerUpload), async (request, response) => {
    const files = (request.files as Express.Multer.File[] | undefined) ?? [];
    const requestId = typeof request.body?.requestId === "string" && request.body.requestId ? request.body.requestId : undefined;
    if (requestId && !request.auth!.permissions.includes(Permission.FULFILL_REQUEST)) {
      throw Object.assign(new Error("You do not have permission to fulfill requests."), { status: 403 });
    }
    const batch = await stageUpload(request.auth!.library.id, request.auth!.user.id, files as StagedFile[], requestId);
    const completed = await finishImport(batch.id);
    response.status(201).json({ upload: completed });
  });

  app.post("/api/uploads/:batchId/retry", requirePermission(Permission.CONTRIBUTE), async (request, response) => {
    const batch = await db.uploadBatch.findFirst({ where: { id: String(request.params.batchId), libraryId: request.auth!.library.id, uploaderId: request.auth!.user.id, status: "FAILED" } });
    if (!batch) return void response.status(404).json({ error: "Failed upload not found." });
    const completed = await finishImport(batch.id);
    response.json({ upload: completed });
  });

  app.delete("/api/albums/:albumId", requirePermission(Permission.REMOVE_MUSIC), async (request, response) => {
    const album = await db.album.findFirst({ where: { id: String(request.params.albumId), libraryId: request.auth!.library.id }, include: { tracks: true } });
    if (!album) return void response.status(404).json({ error: "Album not found." });
    for (const track of album.tracks) {
      if (!track.path) continue;
      const target = resolve(config.musicDir, track.path.replace(/^[/\\]*music[/\\]/i, ""));
      if (insideDirectory(config.musicDir, target)) await unlink(target).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
    }
    await db.$transaction(async (tx) => {
      await tx.musicRequest.updateMany({ where: { fulfilledAlbumId: album.id }, data: { fulfilledAlbumId: null } });
      await tx.contribution.deleteMany({ where: { albumId: album.id } });
      await tx.album.delete({ where: { id: album.id } });
    });
    await startScan();
    response.status(204).end();
  });

  app.get("/api/requests", requireAuth, async (request, response) => {
    const requests = await db.musicRequest.findMany({
      where: { libraryId: request.auth!.library.id },
      include: {
        requester: { select: { id: true, displayName: true } },
        claimant: { select: { id: true, displayName: true } },
        fulfiller: { select: { id: true, displayName: true } },
        fulfilledAlbum: { select: { id: true, title: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    response.json({ requests });
  });

  app.post("/api/requests", requirePermission(Permission.CREATE_REQUEST), async (request, response) => {
    const input = parse(z.object({ artist: z.string().trim().min(1).max(160), album: z.string().trim().min(1).max(160) }), request.body);
    const albums = await db.album.findMany({ where: { libraryId: request.auth!.library.id }, include: { artist: true } });
    if (albums.some((album) => normalized(album.title) === normalized(input.album) && normalized(album.artist.name) === normalized(input.artist))) {
      return void response.status(409).json({ error: "That album is already in the Library." });
    }
    const musicRequest = await db.$transaction(async (tx) => {
      const created = await tx.musicRequest.create({
        data: { libraryId: request.auth!.library.id, artist: input.artist, album: input.album, requesterId: request.auth!.user.id },
        include: { requester: { select: { id: true, displayName: true } }, claimant: true, fulfiller: true }
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
      const updated = await tx.musicRequest.findUnique({ where: { id: musicRequest.id }, include: { requester: { select: { id: true, displayName: true } }, claimant: { select: { id: true, displayName: true } } } });
      await tx.activityEvent.create({
        data: { libraryId: request.auth!.library.id, actorId: request.auth!.user.id, type: "REQUEST_CLAIMED", payload: { requestId: musicRequest.id, artist: musicRequest.artist, album: musicRequest.album, actor: request.auth!.user.displayName, requester: updated!.requester.displayName } }
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
    if (musicRequest.status === "FULFILLED" || musicRequest.status === "CANCELLED") return void response.status(409).json({ error: "This request can no longer be cancelled." });
    const updated = await db.musicRequest.update({ where: { id: musicRequest.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    response.json({ request: updated });
  });

  app.get("/api/activity", requireAuth, async (request, response) => {
    const events = await db.activityEvent.findMany({
      where: { libraryId: request.auth!.library.id },
      include: { actor: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    response.json({ events: events.map(activityView) });
  });

  app.use("/api", (_request, response) => response.status(404).json({ error: "Not found." }));

  app.use((error: any, request: Request, response: Response, _next: NextFunction) => {
    if (request.files && Array.isArray(request.files)) {
      Promise.all(request.files.map((file: Express.Multer.File) => unlink(file.path).catch(() => undefined))).catch(() => undefined);
    }
    const status = Number(error?.status ?? (error instanceof multer.MulterError ? 400 : 500));
    if (status >= 500) console.error(error);
    response.status(status).json({ error: status >= 500 ? "Something went wrong." : error?.message ?? "Invalid request." });
  });

  return app;
}
