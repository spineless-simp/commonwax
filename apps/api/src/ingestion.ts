import { constants } from "node:fs";
import { access, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFile } from "music-metadata";
import { db, type UploadBatch } from "@commonwax/db";
import { config } from "./config.js";
import { scanStatus, startScan } from "./navidrome.js";
import { syncCatalog } from "./catalog.js";
import { insideDirectory, normalized, safeSegment, sleep } from "./utils.js";

const supportedExtensions = new Set([".flac", ".mp3", ".aac", ".m4a", ".ogg", ".opus"]);

export type StagedFile = { path: string; filename: string; originalname: string; size: number };

type InspectedFile = StagedFile & {
  artist: string;
  albumArtist: string;
  album: string;
  title: string;
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
  if (!supportedExtensions.has(extension)) throw new Error(`${file.originalname} is not a supported audio format.`);
  let metadata;
  try {
    metadata = await parseFile(file.path, { duration: false, skipCovers: true });
  } catch {
    throw new Error(`${file.originalname} is not a readable audio file.`);
  }
  const artist = metadata.common.artist?.trim() || "Unknown Artist";
  const albumArtist = metadata.common.albumartist?.trim() || artist;
  const album = metadata.common.album?.trim() || "Unknown Album";
  const title = metadata.common.title?.trim() || basename(file.originalname, extension);
  return { ...file, artist, albumArtist, album, title };
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
): Promise<UploadBatch> {
  if (!files.length) throw new Error("Choose at least one audio file.");
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
      throw new Error("This request must be claimed by you before you fulfill it.");
    }
    const matches = inspected.some(
      (file) => normalized(file.album) === normalized(request.album) &&
        [file.artist, file.albumArtist].some((artist) => normalized(artist) === normalized(request.artist))
    );
    if (!matches) {
      await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
      throw new Error(`The uploaded metadata does not match ${request.album} by ${request.artist}.`);
    }
  }

  const batch = await db.uploadBatch.create({
    data: {
      libraryId,
      uploaderId,
      requestId,
      stagingPath: config.stagingDir,
      files: {
        create: inspected.map((file) => ({
          originalName: file.originalname,
          stagedName: file.filename,
          detectedArtist: file.albumArtist,
          detectedAlbum: file.album,
          detectedTitle: file.title
        }))
      }
    }
  });

  try {
    for (const file of inspected) {
      const artistDirectory = safeSegment(file.albumArtist, "Unknown Artist");
      const albumDirectory = safeSegment(file.album, "Unknown Album");
      const destinationDirectory = join(config.musicDir, artistDirectory, albumDirectory);
      if (!insideDirectory(config.musicDir, destinationDirectory)) throw new Error("Unsafe destination path.");
      await mkdir(destinationDirectory, { recursive: true });
      const destination = await uniqueDestination(destinationDirectory, file.originalname);
      await movePreservingBytes(file.path, destination);
      await db.uploadFile.updateMany({
        where: { uploadBatchId: batch.id, stagedName: file.filename },
        data: { canonicalPath: relative(config.musicDir, destination) }
      });
    }
    await db.uploadBatch.update({ where: { id: batch.id }, data: { status: "SCANNING" } });
  } catch (error) {
    await db.uploadBatch.update({ where: { id: batch.id }, data: { status: "FAILED", error: error instanceof Error ? error.message : "Import failed" } });
    throw error;
  }
  return batch;
}

async function waitForScan(): Promise<void> {
  await sleep(750);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await scanStatus();
    if (!status.scanning) return;
    await sleep(1000);
  }
  throw new Error("Navidrome did not finish scanning within 90 seconds.");
}

function pathMatches(trackPath: string | null, canonicalPaths: Set<string>): boolean {
  if (!trackPath) return false;
  const clean = trackPath.replace(/^[/\\]*music[/\\]/i, "").replaceAll("\\", "/");
  return canonicalPaths.has(clean);
}

export async function finishImport(batchId: string): Promise<UploadBatch> {
  const batch = await db.uploadBatch.findUnique({ where: { id: batchId }, include: { files: true, uploader: true, request: true } });
  if (!batch) throw new Error("Upload batch not found.");
  try {
    await startScan();
    await waitForScan();
    await syncCatalog(batch.libraryId);

    const canonicalPaths = new Set(batch.files.map((file) => file.canonicalPath?.replaceAll("\\", "/")).filter((path): path is string => Boolean(path)));
    let importedTracks = await db.track.findMany({
      where: { libraryId: batch.libraryId },
      include: { album: { include: { artist: true } } }
    });
    importedTracks = importedTracks.filter((track) => pathMatches(track.path, canonicalPaths));

    if (!importedTracks.length) {
      const pairs = new Set(batch.files.map((file) => `${normalized(file.detectedArtist ?? "")}::${normalized(file.detectedAlbum ?? "")}`));
      importedTracks = (await db.track.findMany({
        where: { libraryId: batch.libraryId },
        include: { album: { include: { artist: true } } }
      })).filter((track) => pairs.has(`${normalized(track.album.artist.name)}::${normalized(track.album.title)}`));
    }
    if (!importedTracks.length) throw new Error("Navidrome completed its scan but the uploaded tracks were not found.");

    const byAlbum = new Map<string, typeof importedTracks>();
    for (const track of importedTracks) byAlbum.set(track.albumId, [...(byAlbum.get(track.albumId) ?? []), track]);

    await db.$transaction(async (tx) => {
      for (const [albumId, tracks] of byAlbum) {
        const contribution = await tx.contribution.upsert({
          where: { uploadBatchId_albumId: { uploadBatchId: batch.id, albumId } },
          create: {
            libraryId: batch.libraryId,
            contributorId: batch.uploaderId,
            uploadBatchId: batch.id,
            albumId,
            tracks: { create: tracks.map((track) => ({ trackId: track.id })) }
          },
          update: {}
        });
        const album = tracks[0].album;
        const existingActivity = await tx.activityEvent.findFirst({ where: { libraryId: batch.libraryId, type: "MUSIC_ADDED", payload: { path: ["contributionId"], equals: contribution.id } } });
        if (!existingActivity) {
          await tx.activityEvent.create({
            data: {
              libraryId: batch.libraryId,
              actorId: batch.uploaderId,
              type: "MUSIC_ADDED",
              payload: { contributionId: contribution.id, albumId, album: album.title, artist: album.artist.name, actor: batch.uploader.displayName }
            }
          });
        }
      }

      if (batch.request && batch.request.status === "CLAIMED") {
        const fulfilledAlbumId = [...byAlbum.keys()][0];
        await tx.musicRequest.update({
          where: { id: batch.request.id },
          data: { status: "FULFILLED", fulfillerId: batch.uploaderId, fulfilledAlbumId, fulfilledAt: new Date() }
        });
        await tx.activityEvent.create({
          data: {
            libraryId: batch.libraryId,
            actorId: batch.uploaderId,
            type: "REQUEST_FULFILLED",
            payload: { requestId: batch.request.id, artist: batch.request.artist, album: batch.request.album, actor: batch.uploader.displayName }
          }
        });
      }
      await tx.uploadBatch.update({ where: { id: batch.id }, data: { status: "IMPORTED", error: null, completedAt: new Date() } });
    });
    return (await db.uploadBatch.findUnique({ where: { id: batch.id } }))!;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    await db.uploadBatch.update({ where: { id: batch.id }, data: { status: "FAILED", error: message } });
    throw error;
  }
}
