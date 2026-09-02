/**
 * Journal collector pins (Phase 4 Batch 2, plan §2.1, ADR-009 修订 8/9):
 * exactly-one-regular-file discipline, the stable failure classification
 * (missing / multiple / corrupt / invalid / io), terminal shape + policy
 * re-validation against the protocol's single source, and the daemon-side
 * second redaction layer on message/reason.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectJournal, JOURNAL_OUTBOX_MAX_ENTRIES, JOURNAL_RECORD_MAX_BYTES, type JournalResult } from "./journal.js";

function errorOf(result: JournalResult): string {
  if (result.kind !== "error") throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  return result.error;
}

const SECRET = "sk-ant-journal-secret";
const SECRETS = [SECRET, "rk_run_token"];

let base: string;
let outbox: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "loopzhb-journal-test-"));
  outbox = path.join(base, "outbox");
  mkdirSync(outbox);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeRecord(name: string, content: string): void {
  writeFileSync(path.join(outbox, name), content);
}

describe("the exactly-one discipline", () => {
  it("zero records is journal_missing", async () => {
    expect(await collectJournal(outbox, SECRETS)).toEqual({ kind: "error", error: "journal_missing" });
  });

  it("two records is journal_multiple", async () => {
    writeRecord("a.json", '{"kind":"report","status":"nothing-new"}');
    writeRecord("b.json", '{"kind":"report","status":"nothing-new"}');
    expect(await collectJournal(outbox, SECRETS)).toEqual({ kind: "error", error: "journal_multiple" });
  });

  it("a symlink entry is journal_multiple even when it is the ONLY entry", async () => {
    writeRecord("target.json", '{"kind":"report","status":"nothing-new"}');
    rmSync(path.join(outbox, "target.json"));
    symlinkSync(path.join(base, "elsewhere"), path.join(outbox, "link.json"));
    const result = await collectJournal(outbox, SECRETS);
    expect(result).toEqual({ kind: "error", error: "journal_multiple: outbox holds a non-record entry" });
  });

  it("a missing outbox is journal_io", async () => {
    const result = await collectJournal(path.join(base, "gone"), SECRETS);
    expect(result).toEqual({ kind: "error", error: "journal_io: outbox unreadable" });
  });
});

describe("record validity", () => {
  it("a non-JSON record is journal_corrupt", async () => {
    writeRecord("x.json", "not json{");
    expect(await collectJournal(outbox, SECRETS)).toEqual({ kind: "error", error: "journal_corrupt" });
  });

  it("a JSON array/scalar record is journal_corrupt", async () => {
    writeRecord("x.json", "[1,2]");
    expect(await collectJournal(outbox, SECRETS)).toEqual({ kind: "error", error: "journal_corrupt" });
  });

  it("the wrapper's invalid marker is journal_invalid", async () => {
    writeRecord("x.json", '{"kind":"invalid"}');
    const result = await collectJournal(outbox, SECRETS);
    expect(result).toEqual({ kind: "error", error: "journal_invalid: the wrapper rejected the terminal invocation" });
  });

  it("a shape violation (new without message) is journal_invalid", async () => {
    writeRecord("x.json", '{"kind":"report","status":"new"}');
    const result = await collectJournal(outbox, SECRETS);
    expect(result).toEqual({ kind: "error", error: "journal_invalid: malformed terminal command" });
  });

  it("a policy violation (oversized message / non-object state) is journal_invalid", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "report", status: "resolved", message: "x".repeat(2001) }));
    expect(errorOf(await collectJournal(outbox, SECRETS))).toBe("journal_invalid: message violates the terminal policy");

    rmSync(path.join(outbox, "x.json"));
    writeRecord("y.json", JSON.stringify({ kind: "finish", reason: "r", state: [1] }));
    expect(errorOf(await collectJournal(outbox, SECRETS))).toBe("journal_invalid: malformed terminal command");
  });

  it("an unknown status is journal_invalid", async () => {
    writeRecord("x.json", '{"kind":"report","status":"bogus"}');
    expect(errorOf(await collectJournal(outbox, SECRETS))).toBe("journal_invalid: malformed terminal command");
  });
});

describe("accepted commands", () => {
  it("a report command passes through with its state canonically cloned", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "report", status: "resolved", message: "done", state: { cursor: 2 }, extra: "stripped" }));
    const result = await collectJournal(outbox, SECRETS);
    expect(result).toEqual({
      kind: "ok",
      command: { kind: "report", status: "resolved", message: "done", state: { cursor: 2 } },
    });
  });

  it("a finish command with an optional message", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "finish", reason: "goal met", message: "evidence attached" }));
    expect(await collectJournal(outbox, SECRETS)).toEqual({
      kind: "ok",
      command: { kind: "finish", reason: "goal met", message: "evidence attached" },
    });
  });

  it("message/reason are redacted with the daemon's full secret list", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "finish", reason: `met via ${SECRET}`, message: `run rk_run_token done` }));
    const result = await collectJournal(outbox, SECRETS);
    if (result.kind !== "ok") throw new Error("expected ok");
    if (result.command.kind !== "finish") throw new Error("expected finish");
    expect(result.command.reason).not.toContain(SECRET);
    expect(result.command.message).not.toContain("rk_run_token");
    // …and the on-disk record is NOT modified — redaction is report-side.
    const raw = readFileSync(path.join(outbox, readdirSync(outbox)[0]!), "utf8");
    expect(raw).toContain(SECRET);
  });
});

describe("the state secret scan (review ADV-1 — direct record writes bypass the wrapper)", () => {
  it("a secret in a state VALUE fails closed as journal_invalid", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "report", status: "nothing-new", state: { providerToken: SECRET } }));
    const error = errorOf(await collectJournal(outbox, SECRETS));
    expect(error).toBe("journal_invalid: state contains a known secret");
    expect(error).not.toContain(SECRET); // content-free: the needle is never echoed
  });

  it("a secret in a state KEY fails closed too", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "report", status: "nothing-new", state: { [`token_${SECRET}`]: "x" } }));
    expect(errorOf(await collectJournal(outbox, SECRETS))).toBe("journal_invalid: state contains a known secret");
  });

  it("a secret nested in arrays/objects deep inside the state is caught", async () => {
    writeRecord(
      "x.json",
      JSON.stringify({
        kind: "finish",
        reason: "goal met",
        state: { steps: [{ note: "fine" }, ["rk_run_token"]] },
      }),
    );
    expect(errorOf(await collectJournal(outbox, SECRETS))).toBe("journal_invalid: state contains a known secret");
  });

  it.each([
    ["base64", Buffer.from(SECRET, "utf8").toString("base64")],
    ["base64url", Buffer.from(SECRET, "utf8").toString("base64url")],
    ["hex", Buffer.from(SECRET, "utf8").toString("hex")],
    ["percent", encodeURIComponent(SECRET)],
    ["chunked base64", (Buffer.from(SECRET, "utf8").toString("base64").match(/.{1,5}/g) ?? []).join("-")],
  ])("a %s-derived secret in state fails closed", async (_label, encoded) => {
    writeRecord("x.json", JSON.stringify({ kind: "report", status: "nothing-new", state: { encoded } }));
    const error = errorOf(await collectJournal(outbox, SECRETS));
    expect(error).toBe("journal_invalid: state contains a known secret");
    expect(error).not.toContain(encoded);
  });

  it("a secret in the MESSAGE is redacted, not rejected (state scan does not swallow text fields)", async () => {
    writeRecord("x.json", JSON.stringify({ kind: "report", status: "resolved", message: `used ${SECRET} here` }));
    const result = await collectJournal(outbox, SECRETS);
    if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    if (result.command.kind !== "report") throw new Error("expected report");
    expect(result.command.message).not.toContain(SECRET);
  });
});

describe("the bounded read (review ADV-4)", () => {
  it("the largest realistic legitimate record is accepted (the ceiling does not false-positive)", async () => {
    // state at the 64 KiB compact policy edge + max-length message/reason —
    // comfortably under JOURNAL_RECORD_MAX_BYTES (128 KiB).
    const state = { pad: "x".repeat(65_536 - 80) };
    writeRecord("x.json", JSON.stringify({ kind: "finish", reason: "r".repeat(2000), message: "m".repeat(2000), state }));
    const result = await collectJournal(outbox, SECRETS);
    expect(result.kind).toBe("ok");
  });

  it("a record at exactly the ceiling is classified by CONTENT, not size", async () => {
    // Pad a well-formed record to exactly JOURNAL_RECORD_MAX_BYTES: the size
    // gate passes, and the terminal policy (state over 64 KiB) classifies it
    // — proving the ceiling reads the whole file before judging content.
    const prefix = '{"kind":"report","status":"nothing-new","state":{"pad":"';
    const suffix = '"}}';
    writeRecord("x.json", prefix + "x".repeat(JOURNAL_RECORD_MAX_BYTES - prefix.length - suffix.length) + suffix);
    expect(readFileSync(path.join(outbox, "x.json")).length).toBe(JOURNAL_RECORD_MAX_BYTES);
    const error = errorOf(await collectJournal(outbox, SECRETS));
    expect(error).not.toBe("journal_too_large");
    expect(error).toContain("journal_invalid");
  });

  it("a record one byte over the ceiling is journal_too_large", async () => {
    writeRecord("x.json", " ".repeat(JOURNAL_RECORD_MAX_BYTES + 1));
    expect(await collectJournal(outbox, SECRETS)).toEqual({ kind: "error", error: "journal_too_large" });
  });

  it("a 1 GiB sparse record is journal_too_large without reading it (fstat-guarded)", async () => {
    writeFileSync(path.join(outbox, "x.json"), "{}");
    truncateSync(path.join(outbox, "x.json"), 1024 * 1024 * 1024);
    const started = Date.now();
    expect(await collectJournal(outbox, SECRETS)).toEqual({ kind: "error", error: "journal_too_large" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("an outbox beyond the entry cap is journal_multiple before any lstat sweep", async () => {
    for (let i = 0; i < JOURNAL_OUTBOX_MAX_ENTRIES + 1; i += 1) writeRecord(`e${String(i).padStart(2, "0")}.json`, "{}");
    let entriesRead = 0;
    expect(
      await collectJournal(outbox, SECRETS, {
        onOutboxEntryRead: () => {
          entriesRead += 1;
        },
      }),
    ).toEqual({ kind: "error", error: "journal_multiple" });
    expect(entriesRead).toBe(JOURNAL_OUTBOX_MAX_ENTRIES + 1);
  });

  it("a symlink swap between the listing lstat and the record read is journal_multiple", async () => {
    writeRecord("x.json", '{"kind":"report","status":"nothing-new"}');
    const outside = path.join(base, "outside");
    writeFileSync(outside, "OUTSIDE");
    const result = await collectJournal(outbox, SECRETS, {
      open: async (p, flags, mode) => {
        rmSync(p);
        symlinkSync(outside, p);
        return fs.open(p, flags as never, mode as never);
      },
    });
    expect(result).toEqual({ kind: "error", error: "journal_multiple: outbox holds a non-record entry" });
  });

  it("an inode swap between the listing lstat and the record read is journal_multiple", async () => {
    writeRecord("x.json", '{"kind":"report","status":"nothing-new"}');
    const result = await collectJournal(outbox, SECRETS, {
      open: async (p, flags, mode) => {
        rmSync(p);
        writeFileSync(p, '{"kind":"report","status":"nothing-new"}'); // same content, NEW inode
        return fs.open(p, flags as never, mode as never);
      },
    });
    expect(result).toEqual({ kind: "error", error: "journal_multiple: outbox holds a non-record entry" });
  });
});
