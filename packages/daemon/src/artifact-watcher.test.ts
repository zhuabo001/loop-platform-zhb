/**
 * Slice-5 real-chokidar coverage (AW1–AW5, AW8, AW9's adapter half): the
 * adapter is the ONLY place where OS events enter the daemon, so this suite
 * stays deliberately small, deadline-bounded and positive-assertion-only —
 * the one negative (symlink non-traversal) carries a positive control, and
 * every timing-sensitive wait polls to a deadline instead of sleeping.
 * ALL manager semantics live in the deterministic fake-watcher suite.
 *
 * Mutation that reddens this file: subscribing only to `change`/`unlink`
 * (AW1/AW5 lose their events), or dropping a watcher option in
 * ARTIFACT_WATCHER_OPTIONS (the pinned-literal case).
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_WATCHER_OPTIONS, createChokidarWatcher, type ArtifactWatcher } from "./artifact-watcher.js";

/** 15 s is the per-test ceiling; every wait POLLS to its own deadline so a
 *  regression fails with a message instead of hanging the suite. */
const DEADLINE_MS = 15_000;
const POLL_MS = 10;

let base: string;
let external: string;
const open: ArtifactWatcher[] = [];

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-watcher-test-"));
  external = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-watcher-external-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((watcher) => watcher.close()));
  rmSync(base, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

interface Recorder {
  watcher: ArtifactWatcher;
  events: () => number;
  errors: () => unknown[];
  waitForEvent: (from: number, label: string) => Promise<void>;
  settle: () => Promise<void>;
}

async function subscribe(root: string): Promise<Recorder> {
  const watcher = createChokidarWatcher(root);
  open.push(watcher);
  let events = 0;
  const errors: unknown[] = [];
  watcher.onEvent(() => {
    events += 1;
  });
  watcher.onError((error) => {
    errors.push(error);
  });
  await watcher.ready();
  return {
    watcher,
    events: () => events,
    errors: () => errors,
    async waitForEvent(from: number, label: string): Promise<void> {
      const deadline = Date.now() + DEADLINE_MS;
      while (events <= from) {
        if (Date.now() > deadline) throw new Error(`deadline exceeded waiting for an event after ${label}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    /** Waits until no NEW event has arrived for a full grace window — the
     *  baseline for tests that assert a non-change. */
    async settle(): Promise<void> {
      const deadline = Date.now() + DEADLINE_MS;
      for (;;) {
        const seen = events;
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (events === seen) return;
        if (Date.now() > deadline) throw new Error("deadline exceeded waiting for event quiescence");
      }
    },
  };
}

describe("artifact-watcher (real chokidar)", () => {
  it("pins the frozen options literal", () => {
    expect(ARTIFACT_WATCHER_OPTIONS).toEqual({
      ignoreInitial: true,
      followSymlinks: false,
      ignorePermissionErrors: false,
      persistent: true,
    });
    // No awaitWriteFinish: stability belongs to the scanner (决策 23).
    expect("awaitWriteFinish" in ARTIFACT_WATCHER_OPTIONS).toBe(false);
  });

  it("maps create, modify, rename, delete and directory rename to events (AW1–AW5)", async () => {
    mkdirSync(path.join(base, "sub"));
    writeFileSync(path.join(base, "sub", "seeded.txt"), "seeded");
    const recorder = await subscribe(base);
    // ignoreInitial suppresses the initial FILE replay, but a directory-shaped
    // event may still surface around readiness (the OS stream reports the
    // just-registered directory). The manager's subscribe-then-scan order
    // tolerates such a stray event — it costs one redundant scan that finds
    // nothing — so settle, then drive the operations from that baseline.
    await recorder.settle();
    let mark = recorder.events();

    writeFileSync(path.join(base, "created.txt"), "one");
    await recorder.waitForEvent(mark, "create"); // AW1

    mark = recorder.events();
    writeFileSync(path.join(base, "created.txt"), "two");
    await recorder.waitForEvent(mark, "modify"); // AW2

    mark = recorder.events();
    renameSync(path.join(base, "created.txt"), path.join(base, "renamed.txt"));
    await recorder.waitForEvent(mark, "file rename"); // AW4

    mark = recorder.events();
    renameSync(path.join(base, "sub"), path.join(base, "moved"));
    await recorder.waitForEvent(mark, "directory rename"); // AW5

    mark = recorder.events();
    unlinkSync(path.join(base, "renamed.txt"));
    await recorder.waitForEvent(mark, "delete"); // AW3
  });

  it("an atomic save (temp write + rename over the target) still produces an event (AW8)", async () => {
    writeFileSync(path.join(base, "doc.txt"), "old");
    const recorder = await subscribe(base);

    writeFileSync(path.join(base, "doc.txt.tmp"), "new");
    renameSync(path.join(base, "doc.txt.tmp"), path.join(base, "doc.txt"));

    await recorder.waitForEvent(0, "atomic save");
  });

  it(
    "catches a root that appears after the subscription started (adapter capability)",
    async () => {
      const missing = path.join(base, "later");
      const recorder = await subscribe(missing);
      // A beat for chokidar to install the parent watch before the tree exists.
      await new Promise((resolve) => setTimeout(resolve, 100));

      mkdirSync(missing);
      writeFileSync(path.join(missing, "appeared.txt"), "hello");

      await recorder.waitForEvent(0, "creation of a watched-but-missing root");
    },
    20_000,
  );

  it("does not traverse a symlinked directory, with a positive control (followSymlinks:false)", async () => {
    writeFileSync(path.join(external, "outside.txt"), "outside");
    symlinkSync(external, path.join(base, "link"));
    const recorder = await subscribe(base);
    // The symlink ENTRY itself is watched (an `add` for it may arrive around
    // readiness); its TARGET tree is not. Let that settle, then take the
    // baseline the negative assertion compares against.
    await recorder.settle();
    const baseline = recorder.events();

    writeFileSync(path.join(external, "outside.txt"), "outside-2"); // through the symlink
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recorder.events()).toBe(baseline);

    writeFileSync(path.join(base, "control.txt"), "control"); // positive control
    await recorder.waitForEvent(baseline, "positive control");
  });

  it("close() ends the subscription: no further events, no lingering handles", async () => {
    const recorder = await subscribe(base);
    await recorder.watcher.close();
    const seen = recorder.events();

    writeFileSync(path.join(base, "post-close.txt"), "ignored");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(recorder.events()).toBe(seen);
    expect(recorder.errors()).toEqual([]);
  });
});
