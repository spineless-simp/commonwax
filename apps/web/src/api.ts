export class ApiFailure extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Called once when any request comes back unauthenticated. A session can end
 * without this tab doing anything — it expires, an admin removes the member, a
 * password change elsewhere revokes it, the deployment is reset — and every
 * view would otherwise render "Sign in to continue." as page text with no way
 * back to the sign-in screen but a manual reload.
 */
let onUnauthenticated: (() => void) | null = null;
export function handleUnauthenticated(handler: () => void): void {
  onUnauthenticated = handler;
}

/**
 * Bootstrap deliberately asks `/api/session` while signed out, so the 401 that
 * answers it is not a session ending. Only requests made after the app has a
 * user should be able to throw everyone back to sign-in.
 */
let signedIn = false;
export function setSignedIn(value: boolean): void {
  signedIn = value;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 401 && signedIn) {
    signedIn = false;
    onUnauthenticated?.();
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiFailure(body.error ?? "Something went wrong.", response.status);
  return body as T;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = <T>(path: string) => api<T>(path, { method: "DELETE" });

/**
 * `fetch` cannot report how much of a request body has gone out, and an album
 * upload is the one thing in Commonwax that can take minutes. This is the same
 * contract as `api`, over XHR, so the upload page can show a real bar instead
 * of a spinner and a promise that something is happening.
 */
export function upload<T>(path: string, body: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.withCredentials = true;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.total > 0 ? event.loaded / event.total : 0);
    });
    request.addEventListener("error", () => reject(new ApiFailure("The upload could not reach the Library. Check your connection and try again.", 0)));
    request.addEventListener("abort", () => reject(new ApiFailure("The upload was cancelled.", 0)));
    request.addEventListener("load", () => {
      const parsed = (() => { try { return JSON.parse(request.responseText); } catch { return {}; } })();
      if (request.status === 401) { setSignedIn(false); onUnauthenticated?.(); }
      if (request.status >= 200 && request.status < 300) resolve(parsed as T);
      else reject(new ApiFailure(parsed.error ?? "Something went wrong.", request.status));
    });
    request.send(body);
  });
}
