import { mkdir } from "node:fs/promises";
import { db } from "@commonwax/db";
import { createApp } from "./app.js";
import { config } from "./config.js";

await Promise.all([
  mkdir(config.musicDir, { recursive: true }),
  mkdir(config.stagingDir, { recursive: true })
]);

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Commonwax API listening on :${config.port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down.`);
  server.close(async () => {
    await db.$disconnect();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
