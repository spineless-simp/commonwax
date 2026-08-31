import { mkdir } from "node:fs/promises";
import { db } from "@commonwax/db";
import { createApp } from "./app.js";
import { purgeExpiredSessions } from "./auth.js";
import { config } from "./config.js";

await Promise.all([
  mkdir(config.musicDir, { recursive: true }),
  mkdir(config.stagingDir, { recursive: true })
]);

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Commonwax API listening on :${config.port}`);
});

async function sweepSessions(): Promise<void> {
  try {
    const removed = await purgeExpiredSessions();
    if (removed > 0) console.log(`Purged ${removed} expired session(s).`);
  } catch (error) {
    console.error("Session sweep failed:", error);
  }
}

void sweepSessions();
// `unref` so an idle timer never holds the process open during shutdown.
const sessionSweep = setInterval(() => void sweepSessions(), 6 * 60 * 60_000);
sessionSweep.unref();

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down.`);
  clearInterval(sessionSweep);
  // Stop accepting connections, then give in-flight streams a bounded window
  // to drain before the container is killed.
  const forced = setTimeout(() => {
    console.error("Shutdown timed out; exiting.");
    process.exit(1);
  }, 15_000);
  forced.unref();
  server.close(async () => {
    clearTimeout(forced);
    await db.$disconnect();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
