/**
 * Jail pins (plan J1–J25). The jail is a cwd-SELECTION boundary, not runtime
 * filesystem confinement (batch 3's OS sandbox owns that). The fixture base
 * is realpath'd up front because macOS tmpdir() is itself behind a symlink
 * (/var → /private/var), and the jail speaks only canonical paths.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkdirJail, JailError } from "./jail.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(realpathSync(tmpdir()), "loopzhb-jail-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const scratchParent = (): string => path.join(base, "scratch");

describe("createWorkdirJail — root canonicalization", () => {
  it("J1: rejects a non-existent root and an empty roots array", async () => {
    await expect(
      createWorkdirJail({ allowedRoots: [path.join(base, "missing")], scratchParent: scratchParent() }),
    ).rejects.toThrow(JailError);
    await expect(createWorkdirJail({ allowedRoots: [], scratchParent: scratchParent() })).rejects.toThrow(JailError);
  });

  it("J2: rejects a root that is a file, not a directory", async () => {
    const file = path.join(base, "a-file");
    writeFileSync(file, "x");
    await expect(createWorkdirJail({ allowedRoots: [file], scratchParent: scratchParent() })).rejects.toThrow(
      JailError,
    );
  });

  it("J3: rejects relative roots", async () => {
    for (const bad of ["relative/dir", "./also-relative", ""]) {
      await expect(createWorkdirJail({ allowedRoots: [bad], scratchParent: scratchParent() }), bad).rejects.toThrow(
        JailError,
      );
    }
  });

  it("J4: rejects roots containing .. segments", async () => {
    const withDotDot = path.join(base, "sub", "..", "other");
    await expect(createWorkdirJail({ allowedRoots: [withDotDot], scratchParent: scratchParent() })).rejects.toThrow(
      JailError,
    );
  });

  it("J5: canonicalizes and dedupes roots (symlink aliases collapse)", async () => {
    const real = path.join(base, "real-root");
    mkdirSync(real);
    const alias = path.join(base, "alias-root");
    symlinkSync(real, alias, "dir");
    const jail = await createWorkdirJail({
      allowedRoots: [real, alias, real],
      scratchParent: scratchParent(),
    });
    expect(jail.daemonRoots).toEqual([realpathSync(real)]);
  });
});

describe("resolve — daemon ∩ server root intersection", () => {
  let daemonA: string;
  let daemonAChild: string;

  beforeEach(() => {
    daemonA = path.join(base, "daemon-a");
    daemonAChild = path.join(daemonA, "child");
    mkdirSync(daemonAChild, { recursive: true });
  });

  const resolveWith = (
    jail: Awaited<ReturnType<typeof createWorkdirJail>>,
    workdir: string,
    serverRoots: string[],
  ) => jail.resolve({ workdir, serverRoots, loopId: "loop-1", runId: "run-1" });

  it("J14: a server root INSIDE a daemon root narrows to the server root", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchParent: scratchParent() });
    const resolved = await resolveWith(jail, daemonAChild, [daemonAChild]);
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonAChild)]);
  });

  it("J15: a server root CONTAINING a daemon root narrows to the daemon root", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchParent: scratchParent() });
    const resolved = await resolveWith(jail, daemonA, [base]); // base ⊃ daemonA
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonA)]);
  });

  it("J16: fully disjoint server roots → JailError (no permitted workdir)", async () => {
    const disjoint = path.join(base, "disjoint");
    mkdirSync(disjoint);
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchParent: scratchParent() });
    await expect(resolveWith(jail, daemonA, [disjoint])).rejects.toThrow(JailError);
  });

  it("J17: empty server roots impose no narrowing; cwd realpaths, scratchDir stays null", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchParent: scratchParent() });
    const resolved = await resolveWith(jail, daemonA, []);
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonA)]);
    expect(resolved.cwd).toBe(realpathSync(daemonA));
    expect(resolved.scratchDir).toBeNull();
  });

  it("J18: missing, non-directory and relative server roots → JailError (never trusted pre-normalized)", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA], scratchParent: scratchParent() });
    await expect(resolveWith(jail, daemonA, [path.join(base, "missing")])).rejects.toThrow(JailError);
    const file = path.join(base, "srv-file");
    writeFileSync(file, "x");
    await expect(resolveWith(jail, daemonA, [file])).rejects.toThrow(JailError);
    await expect(resolveWith(jail, daemonA, ["relative/srv"])).rejects.toThrow(JailError);
  });

  it("J19: intersection dedupes and drops children already covered by a parent root", async () => {
    const jail = await createWorkdirJail({ allowedRoots: [daemonA, daemonAChild], scratchParent: scratchParent() });
    const resolved = await resolveWith(jail, daemonAChild, [daemonA]);
    expect(resolved.effectiveRoots).toEqual([realpathSync(daemonA)]);
  });
});
