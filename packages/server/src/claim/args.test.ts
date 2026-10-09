/**
 * `claim:legacy` argument grammar (ADR-011 决策 22). Pure — no fs, no DB.
 *
 * The pins that matter: the selection is always EXPLICIT (at least one
 * --machine-id, no "claim everything"), `--dry-run` is a bare boolean, and a
 * help probe is answered in a flag slot but never swallows a value slot.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseClaimArgs, USAGE } from "./args.js";

const CWD = "/work/here";

function ok(argv: string[]) {
  const result = parseClaimArgs(argv, CWD);
  if (!result.ok) throw new Error(`expected a parse, got ${JSON.stringify(result)}`);
  return result.args;
}

function failure(argv: string[]) {
  const result = parseClaimArgs(argv, CWD);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.args)}`);
  return result;
}

const BASE = ["--data-dir", "data", "--github-user-id", "424242", "--machine-id", "m-abc"];

describe("claim:legacy args — accepted forms", () => {
  it("parses the documented invocation", () => {
    expect(ok([...BASE, "--dry-run"])).toEqual({
      dataDir: path.resolve(CWD, "data"),
      githubUserId: "424242",
      machineIds: ["m-abc"],
      dryRun: true,
    });
  });

  it("resolves --data-dir against the invocation cwd and accepts absolute paths", () => {
    expect(ok(["--data-dir", "/srv/loopzhb", "--github-user-id", "1", "--machine-id", "m-a"]).dataDir).toBe("/srv/loopzhb");
  });

  it("keeps repeated --machine-id values in order", () => {
    expect(ok([...BASE, "--machine-id", "m-def", "--machine-id", "m-ghi"]).machineIds).toEqual(["m-abc", "m-def", "m-ghi"]);
  });

  it("tolerates the single leading -- separator pnpm documents", () => {
    expect(ok(["--", ...BASE]).machineIds).toEqual(["m-abc"]);
  });

  it("defaults dryRun to false", () => {
    expect(ok(BASE).dryRun).toBe(false);
  });
});

describe("claim:legacy args — help probes", () => {
  it("answers --help, -h, help and --version in a flag slot", () => {
    for (const token of ["--help", "-h", "help", "--version"]) {
      expect(failure([token])).toEqual({ ok: false, failure: "help" });
      expect(failure([...BASE, token])).toEqual({ ok: false, failure: "help" });
    }
  });

  it("never reads a help token in a VALUE slot as a probe", () => {
    // `--data-dir --help` is a malformed value, not a probe.
    expect(failure(["--data-dir", "--help"])).toMatchObject({ failure: "usage_invalid" });
  });

  it("ships a usage text that documents the lock and the exit codes", () => {
    expect(USAGE).toContain("data-dir.lock");
    expect(USAGE).toContain("never taken over automatically");
    expect(USAGE).toContain("rm <dir>/data-dir.lock");
    for (const code of ["  0  ", "  1  ", "  2  ", "  3  "]) expect(USAGE).toContain(code);
  });
});

describe("claim:legacy args — rejections", () => {
  it("rejects unknown flags and positional arguments", () => {
    expect(failure([...BASE, "--verbose"])).toMatchObject({ message: expect.stringContaining("unknown flag") });
    expect(failure([...BASE, "m-extra"])).toMatchObject({ message: expect.stringContaining("unknown flag") });
    expect(failure([...BASE, "--dry-run=true"])).toMatchObject({ message: expect.stringContaining("unknown flag") });
  });

  it("rejects duplicate single-value flags", () => {
    expect(failure([...BASE, "--data-dir", "other"])).toMatchObject({ message: "--data-dir may only be given once" });
    expect(failure([...BASE, "--github-user-id", "1"])).toMatchObject({ message: "--github-user-id may only be given once" });
    expect(failure([...BASE, "--dry-run", "--dry-run"])).toMatchObject({ message: "--dry-run may only be given once" });
  });

  it("rejects a repeated --machine-id VALUE (a copy-paste slip, not a dedup)", () => {
    expect(failure([...BASE, "--machine-id", "m-abc"])).toMatchObject({ message: expect.stringContaining("repeated") });
  });

  it("rejects missing and flag-shaped values", () => {
    expect(failure(["--data-dir"])).toMatchObject({ message: "--data-dir requires a value" });
    expect(failure([...BASE, "--machine-id"])).toMatchObject({ message: "--machine-id requires a value" });
    expect(failure(["--data-dir", "--dry-run", "--github-user-id", "1", "--machine-id", "m-a"])).toMatchObject({
      message: "--data-dir requires a value",
    });
    expect(failure(["--data-dir", "", "--github-user-id", "1", "--machine-id", "m-a"])).toMatchObject({
      message: "--data-dir requires a value",
    });
  });

  it("rejects a non-decimal GitHub user id", () => {
    expect(failure(["--data-dir", "d", "--github-user-id", "octocat", "--machine-id", "m-a"])).toMatchObject({
      message: expect.stringContaining("decimal GitHub user id"),
    });
  });

  it("requires every mandatory flag — the machine selection is never implicit", () => {
    expect(failure(["--github-user-id", "1", "--machine-id", "m-a"])).toMatchObject({ message: "--data-dir is required" });
    expect(failure(["--data-dir", "d", "--machine-id", "m-a"])).toMatchObject({ message: "--github-user-id is required" });
    expect(failure(["--data-dir", "d", "--github-user-id", "1"])).toMatchObject({
      message: "--machine-id is required at least once",
    });
  });
});
