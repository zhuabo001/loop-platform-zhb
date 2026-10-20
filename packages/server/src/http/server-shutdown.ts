/**
 * Bounded HTTP listener shutdown for the production composition root.
 *
 * `server.close()` stops accepting connections but its callback waits for the
 * connections it did not close. A browser's keep-alive socket (the Dashboard
 * refreshes every 3 s) can keep that callback pending forever — and in
 * `main()` the database close, which releases the dataDir lock, runs ONLY in
 * that callback. The observed failure: Ctrl+C after opening the Dashboard left
 * the process alive and `data-dir.lock` on disk, so the next boot refused
 * until an operator removed it.
 *
 * The contract here:
 *  1. close the listener;
 *  2. close IDLE keep-alive connections immediately;
 *  3. after `graceMs`, force-close whatever is left and resolve anyway.
 *
 * The promise NEVER depends on every client choosing to disconnect. Steps 2
 * and 3 are optional calls because the @hono/node-server union also covers
 * HTTP/2 servers, where the methods may be absent; the resolve-on-grace
 * guarantee still holds.
 */
import type { ServerType } from "@hono/node-server";

type ClosableServer = ServerType & {
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

/** Long enough for an in-flight request, short enough to bound a hang. */
export const DEFAULT_HTTP_CLOSE_GRACE_MS = 5_000;

export function closeHttpServer(
  server: ServerType,
  options: { graceMs?: number } = {},
): Promise<void> {
  const closable = server as ClosableServer;
  const graceMs = options.graceMs ?? DEFAULT_HTTP_CLOSE_GRACE_MS;

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      closable.closeAllConnections?.();
      finish();
    }, graceMs);
    // A pending force-close must not keep a shutting-down process alive by
    // itself; the listener does that until `finish` runs.
    timer.unref?.();

    server.close(() => finish());
    closable.closeIdleConnections?.();
  });
}
