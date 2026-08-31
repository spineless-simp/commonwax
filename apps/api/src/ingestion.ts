import { constants } from "node:fs";
import { access, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFile } from "music-metadata";
import { db, type UploadBatch } from "@commonwax/db";
import { config } from "./config.js";
import { getNavAlbum, listAllAlbums, listAllSongPaths, listAllTracks, scanStatus, startScan, type NavTrack } from "./navidrome.js";
import { canonicalUploadPath, catalogTrackTitles, ensureAlbumBinding, ensureTrackBinding, trackMatchesPendingUploadPath } from "./catalog.js";
import { ERASED_PERSON } from "./people.js";
import { insideDirectory, normalized, safeSegment, sleep } from "./utils.js";

const supportedExtensions = new Set([".flac", ".mp3", ".aac", ".m4a", ".ogg", ".opus"]);

/**
 * A failure the uploader is the one who can act on: a file that will not parse,
 * a scan that ran long, an album already in the collection. `app.ts` speaks its
 * message even at 5xx, because "Navidrome timed out, retry" and "something went
 * wrong" are not the same instruction, and uploading is the one workflow where
 * a member has no other way to find out what happened.
 */
export class UploadError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "UploadError";
  }
}

export type StagedFile = { path: string; filename: string; originalname: string; size: number };

export type SkippedFile = { filename: string; title: string; artist: string; album: string };

type InspectedFile = StagedFile & {
  artist: string;
  albumArtist: string;
  album: string;
  title: string;
  duration: number;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspect(file: StagedFile): Promise<InspectedFile> {
  const extension = extname(file.originalname).toLocaleLowerCase();
  if (!supportedExtensions.has(extension)) throw new UploadError(`${file.originalname} is not a supported audio format.`);
  let metadata;
  try {
    metadata = await parseFile(file.path, { duration: true, skipCovers: true });
  } catch {
    throw new UploadError(`${file.originalname} is not a readable audio file.`);
  }
  const artist = metadata.common.artist?.trim() || "Unknown Artist";
  const albumArtist = metadata.common.albumartist?.trim() || artist;
  const album = metadata.common.album?.trim() || "Unknown Album";
  const title = metadata.common.title?.trim() || basename(file.originalname, extension);
  const duration = Number.isFinite(metadata.format.duration) && metadata.format.duration! > 0
    ? Math.round(metadata.format.duration!)
    : 0;
  return { ...file, artist, albumArtist, album, title, duration };
}

async function movePreservingBytes(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await unlink(source);
  }
}

async function uniqueDestination(directory: string, originalName: string): Promise<string> {
  const cleanName = safeSegment(basename(originalName), "audio");
  let destination = join(directory, cleanName);
  if (!(await exists(destination))) return destination;
  const extension = extname(cleanName);
  const stem = basename(cleanName, extension);
  destination = join(directory, `${stem}-${randomUUID().slice(0, 8)}${extension}`);
  return destination;
}

export async function stageUpload(
  libraryId: string,
  uploaderId: string,
  files: StagedFile[],
  requestId?: string
): Promise<{ batch: UploadBatch; skipped: SkippedFile[] }> {
  if (!files.length) throw new UploadError("Choose at least one audio file.");
  const inspected: InspectedFile[] = [];
  try {
    for (const file of files) inspected.push(await inspect(file));
  } catch (error) {
    await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
    throw error;
  }

  if (requestId) {
    const request = await db.musicRequest.findFirst({ where: { id: requestId, libraryId } });
    if (!request || request.status !== "CLAIMED" || request.claimantId !== uploaderId) {
      await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
      throw new UploadError("This request must be claimed by you before you fulfill it.", 409);
    }
    const matches = inspected.some(
      (file) => normalized(file.album) === normalized(request.album) &&
        [file.artist, file.albumArtist].some((artist) => normalized(artist) === normalized(request.artist))
    );
    if (!matches) {
      await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
      throw new UploadError(`The uploaded metadata does not match ${request.album} by ${request.artist}.`);
    }
  }

  // Grouped by album so the catalog is asked once per album rather than once
  // per file, then filtered a track at a time — see `catalogTrackTitles`.
  const albumsSeen = new Map<string, InspectedFile[]>();
  for (const file of inspected) {
    const key = `${normalized(file.albumArtist)}\0${normalized(file.album)}`;
    const group = albumsSeen.get(key);
    if (group) group.push(file);
    else albumsSeen.set(key, [file]);
  }

  const skipped: SkippedFile[] = [];
  const kept: InspectedFile[] = [];
  for (const group of albumsSeen.values()) {
    const present = await catalogTrackTitles(group[0].albumArtist, group[0].album);
    for (const file of group) {
      if (present.has(normalized(file.title))) {
        skipped.push({ filename: file.originalname, title: file.title, artist: file.albumArtist, album: file.album });
        await unlink(file.path).catch(() => undefined);
      } else {
        kept.push(file);
        // A batch carrying the same title twice would otherwise import both.
        present.add(normalized(file.title));
      }
    }
  }

  // Everything was already there. Nothing was imported, so this is a failure
  // rather than an empty success — but it is the uploader's to read, not a fault.
  if (!kept.length) {
    throw new UploadError(skipped.length === 1
      ? `“${skipped[0].title}” is already in the Library.`
      : `All ${skipped.length} of those tracks are already in the Library.`, 409);
  }

  const batch = await db.uploadBatch.create({
    data: {
      libraryId,
      uploaderId,
      requestId,
      stagingPath: config.stagingDir,
      files: {
        create: kept.map((file) => ({
          originalName: file.originalname,
          stagedName: file.filename,
          detectedArtist: file.albumArtist,
          detectedAlbum: file.album,
          detectedTitle: file.title,
          detectedDuration: file.duration
        }))
      }
    }
  });

  try {
    for (const file of kept) {
      const artistDirectory = safeSegment(file.albumArtist, "Unknown Artist");
      const albumDirectory = safeSegment(file.album, "Unknown Album");
      const destinationDirectory = join(config.musicDir, artistDirectory, albumDirectory);
      if (!insideDirectory(config.musicDir, destinationDirectory)) throw new Error("Unsafe destination path.");
      await mkdir(destinationDirectory, { recursive: true });
      const destination = await uniqueDestination(destinationDirectory, file.originalname);
      await movePreservingBytes(file.path, destination);
      await db.uploadFile.updateMany({
        where: { uploadBatchId: batch.id, stagedName: file.filename },
        data: { pendingCanonicalPath: relative(config.musicDir, destination) }
      });
    }
    await db.uploadBatch.update({ where: { id: batch.id }, data: { status: "SCANNING" } });
  } catch (error) {
    await db.uploadBatch.update({ where: { id: batch.id }, data: { status: "FAILED", error: error instanceof Error ? error.message : "Import failed" } });
    throw error;
  }
  return { batch, skipped };
}

async function waitForScan(): Promise<void> {
  await sleep(750);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await scanStatus();
    if (!status.scanning) return;
    await sleep(1000);
  }
  throw new UploadError("Navidrome did not finish scanning within 90 seconds. The files are staged; retry the import.", 504);
}

export async function finishImport(batchId: string): Promise<UploadBatch> {
  const batch = await db.uploadBatch.findUnique({ where: { id: batchId }, include: { files: true, uploader: true, request: true } });
  if (!batch) throw new UploadError("Upload batch not found.", 404);
  try {
    await startScan();
    await waitForScan();
    const canonicalPaths = batch.files.map((file) => file.pendingCanonicalPath && canonicalUploadPath(file.pendingCanonicalPath)).filter((path): path is string => Boolean(path));
    if (canonicalPaths.length !== batch.files.length) throw new UploadError("The upload is missing canonical file provenance. Add these files again rather than retrying this import.", 409);

    const detectedDurationByPath = new Map<string, number>();
    for (const file of batch.files) {
      const canonical = file.pendingCanonicalPath && canonicalUploadPath(file.pendingCanonicalPath);
      if (canonical && file.detectedDuration > 0) detectedDurationByPath.set(canonical, file.detectedDuration);
    }

    const [liveTracks, listedAlbums, livePaths] = await Promise.all([listAllTracks(), listAllAlbums(), listAllSongPaths()]);
    const importedTracks: NavTrack[] = [];
    const detectedDurationByTrackId = new Map<string, number>();
    for (const canonicalPath of canonicalPaths) {
      const candidates = liveTracks.filter((track) => trackMatchesPendingUploadPath(livePaths.get(track.id), new Set([canonicalPath])));
      if (candidates.length !== 1) {
        throw new UploadError("Navidrome finished scanning but could not identify an uploaded track by its exact path. Nothing was imported; retry the import.", 409);
      }
      if (!importedTracks.some((track) => track.id === candidates[0].id)) {
        importedTracks.push(candidates[0]);
        const duration = detectedDurationByPath.get(canonicalPath);
        if (duration) detectedDurationByTrackId.set(candidates[0].id, duration);
      }
    }

    if (importedTracks.some((track) => !track.albumId)) {
      throw new UploadError("Navidrome indexed an uploaded track without an album. Check the file's album tag and add it again.", 409);
    }
    const byAlbum = new Map<string, NavTrack[]>();
    for (const track of importedTracks) {
      const albumId = track.albumId!;
      byAlbum.set(albumId, [...(byAlbum.get(albumId) ?? []), track]);
    }
    const albumDetails = await Promise.all([...byAlbum.keys()].map((albumId) => getNavAlbum(albumId)));
    const detailedAlbums = albumDetails.map((detail) => detail.album);
    const albumDetailsById = new Map(albumDetails.map((detail) => [detail.album.id, detail]));
    const detailedAlbumsById = new Map(detailedAlbums.map((album) => [album.id, album]));
    const identityAlbums = listedAlbums.map((album) => {
      const current = detailedAlbumsById.get(album.id);
      return current ? { ...album, ...current } : album;
    });
    for (const album of detailedAlbums) {
      if (!identityAlbums.some((candidate) => candidate.id === album.id)) identityAlbums.push(album);
    }
    const liveAlbums = new Map(detailedAlbums.map((album) => [album.id, album]));

    await db.$transaction(async (tx) => {
      const boundAlbums = new Map<string, string>();
      for (const [navidromeAlbumId, tracks] of byAlbum) {
        const liveAlbum = liveAlbums.get(navidromeAlbumId)!;
        const albumBinding = await ensureAlbumBinding(batch.libraryId, liveAlbum, identityAlbums, tx);
        boundAlbums.set(navidromeAlbumId, albumBinding.id);
        const trackBindings = [];
        const identityTracks = (albumDetailsById.get(navidromeAlbumId)?.songs ?? [])
          .map((track) => track.albumId ? track : { ...track, albumId: navidromeAlbumId });
        for (const track of tracks) {
          trackBindings.push(await ensureTrackBinding(batch.libraryId, albumBinding.id, track, identityTracks, tx, detectedDurationByTrackId.get(track.id)));
        }
        const contribution = await tx.contribution.upsert({
          where: { uploadBatchId_albumBindingId: { uploadBatchId: batch.id, albumBindingId: albumBinding.id } },
          create: {
            libraryId: batch.libraryId,
            contributorId: batch.uploaderId,
            uploadBatchId: batch.id,
            albumBindingId: albumBinding.id
          },
          update: {}
        });
        await tx.contributionTrack.createMany({
          data: trackBindings.map((trackBinding) => ({ contributionId: contribution.id, trackBindingId: trackBinding.id })),
          skipDuplicates: true
        });
        const existingActivity = await tx.activityEvent.findFirst({ where: { libraryId: batch.libraryId, type: "MUSIC_ADDED", payload: { path: ["contributionId"], equals: contribution.id } } });
        if (!existingActivity) {
          await tx.activityEvent.create({
            data: {
              libraryId: batch.libraryId,
              actorId: batch.uploaderId,
              type: "MUSIC_ADDED",
              payload: {
                contributionId: contribution.id,
                albumBindingId: albumBinding.id,
                album: liveAlbum.name || liveAlbum.title || "Untitled Album",
                artist: liveAlbum.displayArtist || liveAlbum.artist || "Unknown Artist",
                actor: batch.uploader?.displayName ?? ERASED_PERSON.displayName
              }
            }
          });
        }
      }

      if (batch.request && batch.request.status === "CLAIMED") {
        const requestedAlbumIds = [...liveAlbums]
          .filter(([, album]) =>
            normalized(album.name || album.title || "") === normalized(batch.request!.album) &&
            normalized(album.displayArtist || album.artist || "") === normalized(batch.request!.artist)
          )
          .map(([albumId]) => albumId);
        if (requestedAlbumIds.length !== 1) {
          throw new UploadError("The uploaded music could not be matched to the request it claims to fulfil.", 409);
        }
        const fulfilledAlbumBindingId = boundAlbums.get(requestedAlbumIds[0]);
        if (!fulfilledAlbumBindingId) throw new UploadError("The upload did not establish an album binding.", 409);
        await tx.musicRequest.update({
          where: { id: batch.request.id },
          data: { status: "FULFILLED", fulfillerId: batch.uploaderId, fulfilledAlbumBindingId, fulfilledAt: new Date() }
        });
        await tx.activityEvent.create({
          data: {
            libraryId: batch.libraryId,
            actorId: batch.uploaderId,
            type: "REQUEST_FULFILLED",
            payload: { requestId: batch.request.id, artist: batch.request.artist, album: batch.request.album, actor: batch.uploader?.displayName ?? ERASED_PERSON.displayName }
          }
        });
      }
      await tx.uploadFile.updateMany({ where: { uploadBatchId: batch.id }, data: { pendingCanonicalPath: null } });
      await tx.uploadBatch.update({ where: { id: batch.id }, data: { status: "IMPORTED", error: null, completedAt: new Date() } });
    });
    return (await db.uploadBatch.findUnique({ where: { id: batch.id } }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    await db.uploadBatch.update({ where: { id: batch.id }, data: { status: "FAILED", error: message } });
    throw error;
  }
}
