import { resolve } from "node:path";

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port: Number.isFinite(port) ? port : 3000,
  navidromeUrl: (process.env.NAVIDROME_URL ?? "http://localhost:4533").replace(/\/$/, ""),
  navidromeUsername: process.env.NAVIDROME_USERNAME ?? "admin",
  navidromePassword: process.env.NAVIDROME_PASSWORD ?? "commonwax-navidrome",
  musicDir: resolve(process.env.MUSIC_DIR ?? "./music"),
  stagingDir: resolve(process.env.STAGING_DIR ?? "./staging"),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  sessionDays: 30,
  maxUploadBytes: 1024 * 1024 * 1024,
  maxFilesPerUpload: 200
};
