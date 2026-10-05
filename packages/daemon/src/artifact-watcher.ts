/**
 * chokidar adapter (Phase 5 Batch 2 slice 5, ADR-010 决策 25): the ONLY module
 * that imports chokidar. The WatchManager drives the `ArtifactWatcher` seam,
 * so every timing/ordering rule is testable with a fake watcher and only the
 * OS-event mapping needs the real library.
 *
 * Frozen options (批次计划 §2 片 5 依赖选择 逐字):
 *
 *  - `ignoreInitial: true` — the manager owns the first FULL scan (subscribe
 *    BEFORE scanning), so chokidar's initial `add` burst would only cause a
 *    redundant round;
 *  - `followSymlinks: false` — a symlinked subtree is never traversed (the
 *    scanner rejects in-tree symlinks anyway; slice 3);
 *  - `ignorePermissionErrors: false` — a permission fault must surface as an
 *    ERROR (reported as `watcher_error`), never be silently swallowed;
 *  - `persistent: true` — the subscription lives as long as the manager.
 *
 * Deliberately NO `awaitWriteFinish`: file stability is the SCANNER's
 * judgement (决策 23), and a second, differently-tuned stability window here
 * would make the two disagree.
 *
 * The seam only reports THAT something changed under the root: the manager
 * coalesces events and the full scan decides what actually moved, so no event
 * detail crosses this boundary.
 */
import { watch } from "chokidar";

/** Frozen literal, pinned by test. */
export const ARTIFACT_WATCHER_OPTIONS = Object.freeze({
  ignoreInitial: true,
  followSymlinks: false,
  ignorePermissionErrors: false,
  persistent: true,
});

export interface ArtifactWatcher {
  /** Resolves once the subscription is established (chokidar `ready`) — the
   *  manager's first scan runs only after this, so no event can be missed.
   *  Never rejects, and also resolves after `close()` (a swap that closed the
   *  watcher before it was ready must not hang its caller). */
  ready(): Promise<void>;
  /** Any add/change/unlink/addDir/unlinkDir under the root. */
  onEvent(listener: () => void): void;
  /** 'error' events (e.g. EACCES with `ignorePermissionErrors:false`). */
  onError(listener: (error: unknown) => void): void;
  close(): Promise<void>;
}

export type ArtifactWatcherFactory = (root: string) => ArtifactWatcher;

/** The production factory injected by the CLI; tests inject a fake. */
export function createChokidarWatcher(root: string): ArtifactWatcher {
  const watcher = watch(root, ARTIFACT_WATCHER_OPTIONS);
  const eventListeners: Array<() => void> = [];
  const errorListeners: Array<(error: unknown) => void> = [];
  let closed = false;
  let ready = false;
  let markReady!: () => void;
  const readyOnce = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const onReady = (): void => {
    ready = true;
    markReady();
  };
  // An unhandled 'error' event on an EventEmitter throws; attach the sink at
  // construction even before a listener is registered.
  const onError = (error: unknown): void => {
    if (closed) return;
    for (const listener of errorListeners) listener(error);
  };
  const onAll = (): void => {
    if (closed) return;
    for (const listener of eventListeners) listener();
  };

  watcher.once("ready", onReady);
  watcher.on("all", onAll);
  watcher.on("error", onError);

  return {
    ready(): Promise<void> {
      return ready ? Promise.resolve() : readyOnce;
    },
    onEvent(listener: () => void): void {
      eventListeners.push(listener);
    },
    onError(listener: (error: unknown) => void): void {
      errorListeners.push(listener);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      markReady(); // a caller parked on ready() must not hang on a closed watcher
      watcher.removeListener("ready", onReady);
      watcher.removeListener("all", onAll);
      watcher.removeListener("error", onError);
      await watcher.close();
    },
  };
}
