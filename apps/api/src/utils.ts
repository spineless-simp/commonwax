import { createHash, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalized(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function safeSegment(value: string, fallback: string): string {
  const clean = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 160);
  return clean || fallback;
}

export function insideDirectory(parent: string, candidate: string): boolean {
  const root = resolve(parent);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
}

export const sleep = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}
