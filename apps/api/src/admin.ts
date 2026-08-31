import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@commonwax/db";
import { bindingReference, deleteSongFiles, findLiveAlbumForReference } from "./catalog.js";
import { config } from "./config.js";
import { scanStatus, startScan } from "./navidrome.js";
import { insideDirectory, sleep } from "./utils.js";

/**
 * The host-facing half of Commonwax. Everything here is permission-gated and
 * none of it is ever shown to an ordinary member: PRODUCT.md's commitment is
 * that nontechnical members never encounter infrastructure, not that the person
 * who deployed the thing has to leave the browser to restart it.
 */

/**
 * The Compose container behind a service name. Compose names containers
 * `<project>-<service>-<index>` and this deployment runs one of each, which is
 * the only reason a name is enough to address them. The proxy in front of the
 * Docker Engine cannot list containers — see `restartService` — so there is
 * nothing to look this up against; it is a convention, and it is asserted by
 * `stack:ps` rather than by this file.
 */
function containerName(service: string): string {
  return `${config.dockerProject}-${service}-1`;
}

export function serviceControlAvailable(): boolean {
  return Boolean(config.dockerProxyUrl);
}

export function managedServices(): string[] {
  return [...config.managedServices];
}

export class ServiceControlError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "ServiceControlError";
  }
}

/**
 * Restarts one container through the docker-socket-proxy.
 *
 * The proxy is configured `CONTAINERS=0, POST=1, ALLOW_RESTARTS=1`, which
 * permits exactly `POST /containers/<name>/restart` and refuses listing,
 * inspecting, creating, and exec with 403. That is the whole reason the API
 * cannot read a container's state anywhere below: the capability was traded
 * away deliberately, because granting the read would have meant granting
 * `POST /containers/create` — a container that mounts the host root — with it.
 */
export async function restartService(service: string): Promise<void> {
  if (!serviceControlAvailable()) {
    throw new ServiceControlError("This deployment has no service control configured.", 503);
  }
  if (!config.managedServices.includes(service)) {
    throw new ServiceControlError(`${service} is not a service this deployment manages.`, 404);
  }
  const url = `${config.dockerProxyUrl}/containers/${encodeURIComponent(containerName(service))}/restart`;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
  } catch (error: any) {
    throw new ServiceControlError(`Could not reach the Docker service control: ${error?.message ?? "no response"}.`);
  }
  // 204 is the restart; 304 means it was already doing so.
  if (response.status === 204 || response.status === 304) return;
  if (response.status === 404) throw new ServiceControlError(`No container named ${containerName(service)} is running.`, 404);
  if (response.status === 403) throw new ServiceControlError("The Docker service control refused that operation.", 502);
  throw new ServiceControlError(`Docker returned HTTP ${response.status} restarting ${service}.`);
}

/**
 * Restarts several services in the order `config.managedServices` declares.
 *
 * Restarting `api` severs the connection carrying this request, so it is always
 * taken last and its failure is not a failure: from the caller's side, a
 * successful restart of the API and a dropped request look identical, and the
 * browser is told to wait for `/api/health` either way.
 */
export async function restartServices(services: readonly string[]): Promise<{ restarted: string[]; failed: Array<{ service: string; error: string }> }> {
  const ordered = config.managedServices.filter((service) => services.includes(service));
  const restarted: string[] = [];
  const failed: Array<{ service: string; error: string }> = [];
  for (const service of ordered) {
    try {
      await restartService(service);
      restarted.push(service);
    } catch (error: any) {
      failed.push({ service, error: error?.message ?? "Restart failed." });
    }
  }
  return { restarted, failed };
}

/**
 * Removes a member from the Library and erases the account behind them.
 *
 * `keepMusic` is the whole decision. Their contributions are Commonwax's record
 * of where the music came from, and the record outlives the account either way:
 * kept, it survives with a null contributor and reads as "someone" everywhere a
 * name would have been; deleted, the files go with it and Navidrome is rescanned
 * so the catalog stops offering tracks that are no longer on disk.
 *
 * The account row itself always goes. Every relation that named it is nullable
 * with `ON DELETE SET NULL`, so this is one delete rather than a cascade that
 * would take history with it.
 */
export async function eraseAccount(
  libraryId: string,
  userId: string,
  options: { keepMusic: boolean }
): Promise<{ removedFiles: number }> {
  let removedFiles = 0;
  if (!options.keepMusic) removedFiles = await deleteContributedMusic(libraryId, userId);

  // The recorded name in an activity payload is what lets an event outlive a
  // membership. An erased account has nothing left to outlive, so the snapshot
  // is cleared too and `activityView` falls through to the same placeholder the
  // contributions use. Postgres does the rewrite in one statement; there is no
  // Prisma expression for editing one key of a Json column in place.
  await db.$executeRaw`
    UPDATE "ActivityEvent"
    SET "payload" = jsonb_set("payload"::jsonb, '{actor}', 'null'::jsonb)::json
    WHERE "actorId" = ${userId}::uuid
  `;

  await db.user.delete({ where: { id: userId } });
  return { removedFiles };
}

/**
 * Deletes the music one person contributed, and only that music.
 *
 * An album can carry contributions from more than one member — a second upload
 * into the same release is a second `Contribution` against the same binding —
 * so an album anybody else also added is left entirely alone and only this
 * person's record of it is dropped. Erasing an account must not quietly delete
 * somebody else's music because the two of them share a release.
 *
 * For the albums that were theirs alone, this is the same order
 * `DELETE /api/albums/:albumId` uses: resolve the binding to what Navidrome
 * currently has, unlink those files, and let a scan be the thing that removes
 * them from the catalog. The binding goes too, so no "last known" snapshot is
 * left behind attributing an unavailable album to nobody.
 */
async function deleteContributedMusic(libraryId: string, userId: string): Promise<number> {
  const bindingIds = (await db.contribution.findMany({
    where: { libraryId, contributorId: userId },
    select: { albumBindingId: true },
    distinct: ["albumBindingId"]
  })).map((row) => row.albumBindingId);
  if (!bindingIds.length) return 0;

  const shared = new Set((await db.contribution.findMany({
    where: { libraryId, albumBindingId: { in: bindingIds }, contributorId: { not: userId } },
    select: { albumBindingId: true },
    distinct: ["albumBindingId"]
  })).map((row) => row.albumBindingId));

  let removed = 0;
  for (const bindingId of bindingIds) {
    if (shared.has(bindingId)) continue;
    const live = await findLiveAlbumForReference(libraryId, bindingReference(bindingId));
    await deleteSongFiles((live?.songs ?? []).map((song) => song.id));
    // Cascades the track bindings, contributions, and per-user hiding with it.
    await db.mediaAlbumBinding.delete({ where: { id: bindingId } }).catch(() => undefined);
    removed += 1;
  }

  // Contributions against albums somebody else also added: the music stays, the
  // erased account's claim on it does not.
  await db.contribution.deleteMany({ where: { libraryId, contributorId: userId } });
  if (removed > 0) await startScan();
  return removed;
}

/**
 * Empties the music directory and waits for Navidrome to notice.
 *
 * Verified against Navidrome 0.58.0: removing the files and running an ordinary
 * scan takes them out of the browsable catalog — `search3` and `getAlbumList2`
 * stop returning them — so nothing here needs access to Navidrome's own data
 * volume, which the API does not mount.
 */
async function emptyMusicLibrary(): Promise<boolean> {
  for (const directory of [config.musicDir, config.stagingDir]) {
    const entries = await readdir(directory).catch((error: any) => {
      if (error?.code === "ENOENT") return [] as string[];
      throw error;
    });
    for (const entry of entries) {
      const target = join(directory, entry);
      if (insideDirectory(directory, target)) await rm(target, { recursive: true, force: true });
    }
  }
  await startScan();
  return waitForScan();
}

/** How long a reset waits for the scan before reporting what it did anyway. */
const SCAN_TIMEOUT_MS = 90_000;
const SCAN_POLL_MS = 1_000;

async function waitForScan(): Promise<boolean> {
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SCAN_POLL_MS);
    const status = await scanStatus().catch(() => null);
    if (status && !status.scanning) return true;
  }
  return false;
}

/**
 * Every table Prisma owns, read from the database rather than listed here, so a
 * model added later is included without anybody remembering to come back. The
 * migration ledger is the one table that must survive: truncating it would make
 * `migrate deploy` replay every migration against a schema that already has it.
 */
/**
 * Postgres has no way to parameterise an identifier, so the table names come
 * back from `pg_tables` and go into the statement by interpolation. Every name
 * is checked against this first: a table whose name could carry a quote out of
 * the identifier is refused rather than quoted, because there is no legitimate
 * table in this schema that needs one and a truncate is not the statement to
 * be generous in.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function commonwaxTables(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'
  `;
  const names = rows.map((row) => row.tablename);
  const unexpected = names.filter((name) => !PLAIN_IDENTIFIER.test(name));
  if (unexpected.length) {
    throw new Error(`Refusing to reset: ${unexpected.length} table name(s) in this schema are not plain identifiers.`);
  }
  return names;
}

/**
 * Returns the deployment to the state a fresh install starts in: no accounts,
 * no Library, no music, and `/api/setup/status` answering `needsSetup`.
 *
 * The music goes first. Truncating the database ends every session including
 * this request's, so if the order were reversed a failure part-way would leave
 * a deployment nobody can sign in to still holding the whole collection.
 *
 * This is not a Navidrome reset: Navidrome keeps its own users and settings in
 * a volume the API cannot reach. What it loses is the music, because the files
 * it was indexing are gone.
 */
export async function resetEverything(): Promise<{ scanCompleted: boolean; tables: number }> {
  const scanCompleted = await emptyMusicLibrary();

  const tables = await commonwaxTables();
  if (tables.length) {
    const quoted = tables.map((table) => `"${table}"`).join(", ");
    // One statement so the tables come back empty together — a partial truncate
    // would leave foreign keys pointing into tables that no longer have rows.
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  return { scanCompleted, tables: tables.length };
}
