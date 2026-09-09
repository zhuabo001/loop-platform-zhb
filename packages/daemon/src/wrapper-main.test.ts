/**
 * The loopzhb wrapper CLI (Phase 4 Batch 2, plan §2.1, ADR-009 修订 8/9):
 * strict argument grammar, exactly-one-record discipline, wx/0600 writes,
 * secret-derived redaction and the secret-free invalid marker — exercised
 * by calling runLoopzhbWrapper directly (the spawned static executable is
 * the same function behind process.argv/env/cwd).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JOURNAL_OUTBOX_ENV, runLoopzhbWrapper } from "./wrapper-main.js";

const SECRET = "sk-ant-wrapper-secret";

let base: string;
let outbox: string;
let cwd: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "loopzhb-wrapper-test-"));
  outbox = path.join(base, "outbox");
  cwd = path.join(base, "cwd");
  mkdirSync(outbox, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [JOURNAL_OUTBOX_ENV]: outbox, ANTHROPIC_API_KEY: SECRET, ...extra };
}

/** The outbox's records as parsed JSON, in name order. */
function records(): unknown[] {
  return readdirSync(outbox)
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(outbox, name), "utf8")));
}

describe("valid invocations write exactly one 0600 record and exit 0", () => {
  it("report --status resolved --message", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "resolved", "--message", "did the work"], env(), cwd)).toBe(0);
    expect(records()).toEqual([{ kind: "report", status: "resolved", message: "did the work" }]);
    const [name] = readdirSync(outbox);
    expect(statSync(path.join(outbox, name!)).mode & 0o777).toBe(0o600);
    expect(name).toMatch(/^[0-9a-f]{24}\.json$/);
  });

  it("report --status nothing-new may omit the message", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new"], env(), cwd)).toBe(0);
    expect(records()).toEqual([{ kind: "report", status: "nothing-new" }]);
  });

  it("finish --reason with a state object", async () => {
    expect(
      await runLoopzhbWrapper(
        ["finish", "--reason", "goal met", "--state", '{"cursor":2,"done":["a"]}'],
        env(),
        cwd,
      ),
    ).toBe(0);
    expect(records()).toEqual([{ kind: "finish", reason: "goal met", state: { cursor: 2, done: ["a"] } }]);
  });

  it("--message-file and --state-file resolve against the agent cwd", async () => {
    writeFileSync(path.join(cwd, "msg.txt"), "from a file");
    writeFileSync(path.join(cwd, "state.json"), '{"step":1}');
    expect(
      await runLoopzhbWrapper(
        ["report", "--status", "new", "--message-file", "msg.txt", "--state-file", "state.json"],
        env(),
        cwd,
      ),
    ).toBe(0);
    expect(records()).toEqual([{ kind: "report", status: "new", message: "from a file", state: { step: 1 } }]);
  });

  it("two invocations never collide (random wx names)", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new"], env(), cwd)).toBe(0);
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new"], env(), cwd)).toBe(0);
    expect(readdirSync(outbox)).toHaveLength(2);
  });
});

describe("invalid invocations write the secret-free marker and exit 1", () => {
  const invalidCases: Array<[string, string[]]> = [
    ["unknown command", ["frobnicate"]],
    ["no command", []],
    ["positional argument", ["report", "--status", "resolved", "--message", "x", "extra"]],
    ["unknown flag", ["report", "--status", "resolved", "--message", "x", "--verbose", "y"]],
    ["duplicated flag", ["report", "--status", "resolved", "--status", "new", "--message", "x"]],
    ["missing value", ["report", "--status"]],
    ["message/message-file mutex", ["report", "--status", "resolved", "--message", "x", "--message-file", "f"]],
    ["state/state-file mutex", ["report", "--status", "nothing-new", "--state", "{}", "--state-file", "f"]],
    ["report missing --status", ["report", "--message", "x"]],
    ["report bad status", ["report", "--status", "bogus", "--message", "x"]],
    ["new without message", ["report", "--status", "new"]],
    ["resolved without message", ["report", "--status", "resolved"]],
    ["finish without --reason", ["finish", "--message", "x"]],
    ["finish empty reason", ["finish", "--reason", ""]],
    ["status flag on finish", ["finish", "--reason", "r", "--status", "new"]],
    ["invalid JSON state", ["report", "--status", "nothing-new", "--state", "{nope"]],
    ["non-object state (array)", ["report", "--status", "nothing-new", "--state", "[1,2]"]],
    ["non-object state (scalar)", ["report", "--status", "nothing-new", "--state", "42"]],
    ["message with NUL", ["report", "--status", "resolved", "--message", "a\0b"]],
    ["oversized message", ["report", "--status", "resolved", "--message", "x".repeat(2001)]],
    ["oversized state", ["report", "--status", "nothing-new", "--state", `{"k":"${"x".repeat(66_000)}"}`]],
    ["missing message-file", ["report", "--status", "resolved", "--message-file", "nope.txt"]],
  ];
  for (const [label, argv] of invalidCases) {
    it(label, async () => {
      expect(await runLoopzhbWrapper(argv, env(), cwd)).toBe(1);
      expect(records()).toEqual([{ kind: "invalid" }]);
    });
  }

  it("a directory as --state-file is invalid", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state-file", "."], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
  });

  it("a symlink *-file is invalid — even one pointing at a perfectly legal file (review SPEC-4)", async () => {
    writeFileSync(path.join(cwd, "legal.txt"), "legal content");
    symlinkSync(path.join(cwd, "legal.txt"), path.join(cwd, "link.txt"));
    expect(await runLoopzhbWrapper(["report", "--status", "resolved", "--message-file", "link.txt"], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
    rmSync(path.join(outbox, readdirSync(outbox)[0]!));
    symlinkSync(path.join(cwd, "legal.txt"), path.join(cwd, "slink.json"));
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state-file", "slink.json"], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
  });

  it("an oversized *-file is invalid (bounded read, no whole-file allocation)", async () => {
    writeFileSync(path.join(cwd, "big-msg.txt"), "x".repeat(2001));
    expect(await runLoopzhbWrapper(["report", "--status", "resolved", "--message-file", "big-msg.txt"], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
    rmSync(path.join(outbox, readdirSync(outbox)[0]!));
    writeFileSync(path.join(cwd, "big-state.json"), " ".repeat(65_537));
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state-file", "big-state.json"], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
  });

  it("the marker never carries user-supplied values", async () => {
    const evil = `leak-me-${SECRET}`;
    expect(await runLoopzhbWrapper(["report", "--status", "resolved", "--message", evil, "--bogus", "1"], env(), cwd)).toBe(1);
    const raw = readFileSync(path.join(outbox, readdirSync(outbox)[0]!), "utf8");
    expect(raw).not.toContain("leak-me");
    expect(raw).not.toContain(SECRET);
  });
});

describe("the env-derived secret boundary", () => {
  it("redacts a provider secret out of the message BEFORE the record lands", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "resolved", "--message", `token ${SECRET} end`], env(), cwd)).toBe(0);
    const raw = readFileSync(path.join(outbox, readdirSync(outbox)[0]!), "utf8");
    expect(raw).not.toContain(SECRET);
    const [record] = records() as Array<{ message: string }>;
    expect(record.message).not.toContain(SECRET);
    expect(record.message).toContain("token ");
  });

  it("redacts a secret embedded in the finish reason", async () => {
    expect(await runLoopzhbWrapper(["finish", "--reason", `done with ${SECRET}`], env(), cwd)).toBe(0);
    const raw = readFileSync(path.join(outbox, readdirSync(outbox)[0]!), "utf8");
    expect(raw).not.toContain(SECRET);
  });

  it("a state VALUE containing a known secret fails the invocation (never rewritten)", async () => {
    const state = JSON.stringify({ token: SECRET, keep: 1 });
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state", state], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
  });

  it("a state KEY containing a known secret fails the invocation", async () => {
    const state = JSON.stringify({ [`k-${SECRET}`]: 1 });
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state", state], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
  });

  it("a secret nested deep inside the state is still caught", async () => {
    const state = JSON.stringify({ a: [{ b: [`x${SECRET}y`] }] });
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state", state], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
  });

  it.each([
    ["base64", Buffer.from(SECRET, "utf8").toString("base64")],
    ["base64url", Buffer.from(SECRET, "utf8").toString("base64url")],
    ["hex", Buffer.from(SECRET, "utf8").toString("hex")],
    ["chunked base64", (Buffer.from(SECRET, "utf8").toString("base64").match(/.{1,5}/g) ?? []).join("-")],
  ])("a %s-derived secret in state writes only the invalid marker", async (_label, encoded) => {
    const state = JSON.stringify({ encoded });
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new", "--state", state], env(), cwd)).toBe(1);
    expect(records()).toEqual([{ kind: "invalid" }]);
    expect(readFileSync(path.join(outbox, readdirSync(outbox)[0]!), "utf8")).not.toContain(encoded);
  });

  it("every sensitive key family feeds redaction (review STD-3 — wrapper shares the single classifier)", async () => {
    const families: Array<[string, string]> = [
      ["ANTHROPIC_AUTH_TOKEN", "anthropic-auth-secret"],
      ["CLAUDE_CODE_OAUTH_TOKEN", "oauth-secret-value"],
      ["HTTPS_PROXY", "https://user:proxy-secret@proxy:8443"],
      ["all_proxy", "socks5://user:allproxy-secret@proxy:1080"],
    ];
    for (const [key, value] of families) {
      const exit = await runLoopzhbWrapper(["report", "--status", "resolved", "--message", `via ${value} end`], env({ [key]: value }), cwd);
      expect(exit).toBe(0);
      const raw = readFileSync(path.join(outbox, readdirSync(outbox)[0]!), "utf8");
      expect(raw).not.toContain(value);
      for (const name of readdirSync(outbox)) rmSync(path.join(outbox, name));
    }
  });
});

describe("infrastructure failures exit 2 without a record", () => {
  it("missing outbox env", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new"], { ANTHROPIC_API_KEY: SECRET }, cwd)).toBe(2);
    expect(readdirSync(outbox)).toHaveLength(0);
  });

  it("a relative outbox is refused", async () => {
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new"], { [JOURNAL_OUTBOX_ENV]: "rel/out" }, cwd)).toBe(2);
  });

  it("an unwritable/missing outbox fails even the marker write", async () => {
    const gone = path.join(base, "gone");
    expect(await runLoopzhbWrapper(["bogus"], { [JOURNAL_OUTBOX_ENV]: gone }, cwd)).toBe(2);
    expect(await runLoopzhbWrapper(["report", "--status", "nothing-new"], { [JOURNAL_OUTBOX_ENV]: gone }, cwd)).toBe(2);
  });
});
