import { useEffect } from "react";

/**
 * Holds a screen wake lock while mounted (i.e. while on a channel) so a
 * phone in hand stays on like a real handheld. Re-acquires after tab
 * switches; silently does nothing where the API is unavailable.
 */
export function useWakeLock(): void {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") {
        return;
      }
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release();
        } else {
          lock = sentinel;
        }
      } catch {
        // Low battery or platform policy — not worth surfacing.
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}
