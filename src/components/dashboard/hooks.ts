import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { errorMessage } from "./api";

/** Calls `callback` every `delayMs`; pass `null` to pause. */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const tick = useEffectEvent(callback);
  useEffect(() => {
    if (delayMs == null) return;
    const id = window.setInterval(() => tick(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Epoch ms of the last completed attempt (success or failure). */
  updatedAt: number | null;
  refresh: () => void;
}

interface PollOptions<T> {
  /** Poll period; `null` fetches once. */
  intervalMs: number | null;
  /** Changing this value triggers an immediate refetch. */
  refreshToken?: number;
  /** Runs outside render with each successful payload (e.g. to diff for new rows). */
  onSuccess?: (data: T) => void;
}

/**
 * Fetch-and-poll. Keeps the last good data when a poll fails so a flaky or missing
 * route degrades to an in-panel error instead of blanking the panel.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  { intervalMs, refreshToken = 0, onSuccess }: PollOptions<T>,
): PollState<T> {
  const [state, setState] = useState<Omit<PollState<T>, "refresh">>({
    data: null,
    error: null,
    loading: true,
    updatedAt: null,
  });
  const [manualToken, setManualToken] = useState(0);

  const run = useEffectEvent(async (isActive: () => boolean) => {
    try {
      const data = await fetcher();
      if (!isActive()) return;
      onSuccess?.(data);
      setState({ data, error: null, loading: false, updatedAt: Date.now() });
    } catch (error) {
      if (!isActive()) return;
      setState((prev) => ({
        ...prev,
        error: errorMessage(error),
        loading: false,
        updatedAt: Date.now(),
      }));
    }
  });

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await run(() => active);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = intervalMs == null ? null : window.setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      if (id != null) window.clearInterval(id);
    };
  }, [intervalMs, refreshToken, manualToken]);

  const refresh = useCallback(() => setManualToken((n) => n + 1), []);
  return { ...state, refresh };
}

// ---------------------------------------------------------------------------
// Shared 1s clock for relative timestamps. Server snapshot is `null` so SSR and
// hydration never render a wall-clock-dependent string.
// ---------------------------------------------------------------------------

let clockNow = 0;
let clockTimer: number | undefined;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

export function useNow(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => (clockNow === 0 ? null : clockNow),
    () => null,
  );
}
