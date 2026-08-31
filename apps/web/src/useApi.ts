import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: string;
  reload: () => void;
};

export type ResourceOptions = {
  /** Change this to re-request the same path — how views react to `refresh`. */
  reloadKey?: unknown;
  fallbackError?: string;
  /** Hold the request back — for a path that is not worth asking for yet. */
  skip?: boolean;
};

function message(issue: unknown, fallback: string): string {
  return issue instanceof Error ? issue.message : fallback;
}

function useRequest<T>(paths: readonly string[], single: boolean, options: ResourceOptions): Resource<T> {
  const { reloadKey, fallbackError = "Could not load this view.", skip = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Paths arrive as a fresh array each render, so the serialized form — not the
  // array identity — is what the effect may depend on.
  const key = JSON.stringify(paths);

  useEffect(() => {
    // Skipping clears what was loaded: a stale answer to a question the caller
    // has stopped asking is worse than nothing.
    if (skip) {
      setData(null);
      setLoading(false);
      setError("");
      return;
    }
    let abandoned = false;
    const requested: string[] = JSON.parse(key);
    setLoading(true);
    setError("");
    const pending = single ? api<T>(requested[0]) : Promise.all(requested.map((path) => api<unknown>(path))) as Promise<T>;
    pending
      .then((result) => { if (!abandoned) setData(result); })
      .catch((issue) => { if (!abandoned) setError(message(issue, fallbackError)); })
      .finally(() => { if (!abandoned) setLoading(false); });
    // Ignore a response whose request has already been superseded, so a slow
    // earlier fetch cannot overwrite the results of a newer one.
    return () => { abandoned = true; };
  }, [key, single, attempt, reloadKey, fallbackError, skip]);

  return { data, loading, error, reload: useCallback(() => setAttempt((value) => value + 1), []) };
}

/** One GET, with the loading and error bookkeeping every page was repeating. */
export function useApiResource<T>(path: string, options: ResourceOptions = {}): Resource<T> {
  return useRequest<T>([path], true, options);
}

/** The same contract for a view that needs several endpoints at once. */
export function useApiResources<T extends readonly unknown[]>(
  paths: readonly string[],
  options: ResourceOptions = {}
): Resource<T> {
  return useRequest<T>(paths, false, options);
}

/** The value, but only once it has stopped changing for `delay` milliseconds. */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
