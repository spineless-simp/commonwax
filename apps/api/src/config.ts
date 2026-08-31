import { resolve } from "node:path";

const production = process.env.NODE_ENV === "production";

/**
 * Development defaults keep `npm run dev` a one-command experience. In
 * production every one of them is a known-public value, so a deploy that
 * forgot an environment variable must fail loudly at boot rather than come
 * up listening with a guessable Navidrome account or a plaintext cookie.
 */
function required(name: string, developmentDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (production) {
    throw new Error(
      `${name} must be set. Commonwax refuses to start in production with the built-in development default.`
    );
  }
  return developmentDefault;
}

function port(): number {
  const value = Number(process.env.PORT ?? 3000);
  return Number.isFinite(value) && value > 0 && value < 65_536 ? value : 3000;
}

const publicUrl = required("PUBLIC_URL", "http://localhost:5173").replace(/\/$/, "");
const cookieSecure = process.env.COOKIE_SECURE === "true";

// A session cookie without `Secure` is sent over plaintext HTTP. If the
// deployment tells users to reach it over HTTPS, refusing to start is the only
// honest response to that contradiction.
if (production && publicUrl.startsWith("https://") && !cookieSecure) {
  throw new Error("COOKIE_SECURE must be \"true\" when PUBLIC_URL is an https:// address.");
}

/**
 * The Compose services an admin may restart, in the order a full restart walks
 * them. Declared here as service names and resolved against `dockerProject`
 * into the container names Compose actually assigns (`<project>-<service>-1`).
 *
 * `api` is deliberately last: restarting it kills the request that asked for it,
 * so everything else must already be on its way back up by the time it goes.
 */
function services(): string[] {
  const value = process.env.MANAGED_SERVICES;
  if (!value) return ["postgres", "navidrome", "web", "api"];
  return value.split(",").map((name) => name.trim()).filter(Boolean);
}

export const config = {
  port: port(),
  production,
  navidromeUrl: (process.env.NAVIDROME_URL ?? "http://localhost:4533").replace(/\/$/, ""),
  navidromeUsername: process.env.NAVIDROME_USERNAME ?? "admin",
  navidromePassword: required("NAVIDROME_PASSWORD", "commonwax-navidrome"),
  musicDir: resolve(process.env.MUSIC_DIR ?? "./music"),
  stagingDir: resolve(process.env.STAGING_DIR ?? "./staging"),
  publicUrl,
  cookieSecure,
  sessionDays: 30,
  maxUploadBytes: 1024 * 1024 * 1024,
  maxFilesPerUpload: 200,
  maxUploadBatchBytes: 20 * 1024 * 1024 * 1024,
  /**
   * The docker-socket-proxy in front of the Docker Engine. Absent in
   * development, where the API is a host process with no containers of its own
   * to restart; the service controls report themselves unavailable rather than
   * pretending otherwise.
   */
  dockerProxyUrl: process.env.DOCKER_PROXY_URL?.replace(/\/$/, "") ?? "",
  dockerProject: process.env.DOCKER_PROJECT ?? "commonwax",
  managedServices: services(),
  /**
   * A fanart.tv API key. Artist logos and backgrounds are the one thing in
   * Commonwax that comes from outside the deployment, and they are decoration:
   * without a key the lookup never runs, no request leaves the host, and every
   * artist falls back to their typeset name. This is why it is not `required` —
   * an absent key is a configuration choice, not a broken deploy.
   */
  fanartApiKey: (process.env.FANART_API_KEY ?? "").trim()
};
