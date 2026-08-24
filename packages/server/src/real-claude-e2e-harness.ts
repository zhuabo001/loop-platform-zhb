import { execFile, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type DaemonLogStream = "stdout" | "stderr";

export const CLAUDE_PROVENANCE_PREFIX = "loopzhb claude provenance ";

export interface ClaudeProvenance {
  resolvedPath: string;
  version: string;
  sha256: string;
}

export type ProcessCloseResult = {
  kind: "closed";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export interface TerminationOptions {
  graceMs: number;
  killWaitMs: number;
}

export class DaemonLogObserver {
  private readonly secrets: Buffer[];
  private readonly overlapBytes: number;
  private readonly overlap: Record<DaemonLogStream, Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
  private tail = Buffer.alloc(0);
  private foundSecret = false;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutLineCarry = "";
  private provenance: ClaudeProvenance | null = null;
  private provenanceError: Error | null = null;

  constructor(
    secrets: readonly string[],
    private readonly maxDiagnosticBytes: number,
  ) {
    if (!Number.isInteger(maxDiagnosticBytes) || maxDiagnosticBytes <= 0) {
      throw new RangeError("maxDiagnosticBytes must be a positive integer");
    }
    this.secrets = secrets.filter((secret) => secret.length > 0).map((secret) => Buffer.from(secret));
    this.overlapBytes = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }

  append(stream: DaemonLogStream, chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk);
    const searchable = Buffer.concat([this.overlap[stream], bytes]);
    if (this.secrets.some((secret) => searchable.indexOf(secret) !== -1)) this.foundSecret = true;
    this.overlap[stream] = this.overlapBytes === 0 ? Buffer.alloc(0) : searchable.subarray(-this.overlapBytes);
    this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.maxDiagnosticBytes);
    if (stream === "stdout") this.observeStdoutLines(this.stdoutDecoder.write(bytes));
  }

  get secretSeen(): boolean {
    return this.foundSecret;
  }

  get diagnosticBytes(): number {
    return this.tail.length;
  }

  diagnosticTail(): string {
    let text = this.tail.toString("utf8");
    for (const secret of this.secrets) {
      text = text.replaceAll(secret.toString("utf8"), "[REDACTED]");
    }
    return text;
  }

  requireApprovedProvenance(expectedSha256: string): ClaudeProvenance {
    const provenance = this.approvedProvenance(expectedSha256);
    if (provenance === null) throw new Error("production daemon did not report Claude provenance");
    return provenance;
  }

  approvedProvenance(expectedSha256: string): ClaudeProvenance | null {
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
      throw new Error("LOOPZHB_EXPECTED_CLAUDE_SHA256 must be exactly 64 hexadecimal characters");
    }
    if (this.provenanceError !== null) throw this.provenanceError;
    if (this.provenance === null) return null;
    if (this.provenance.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error("production daemon Claude provenance does not match the approved sha256");
    }
    return this.provenance;
  }

  private observeStdoutLines(text: string): void {
    this.stdoutLineCarry += text;
    let newline = this.stdoutLineCarry.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutLineCarry.slice(0, newline).replace(/\r$/, "");
      this.stdoutLineCarry = this.stdoutLineCarry.slice(newline + 1);
      this.observeStdoutLine(line);
      newline = this.stdoutLineCarry.indexOf("\n");
    }
    if (this.stdoutLineCarry.length > 8192) {
      if (this.stdoutLineCarry.includes(CLAUDE_PROVENANCE_PREFIX)) {
        this.provenanceError = new Error("production daemon emitted an oversized Claude provenance record");
      }
      this.stdoutLineCarry = this.stdoutLineCarry.slice(-8192);
    }
  }

  private observeStdoutLine(line: string): void {
    if (!line.startsWith(CLAUDE_PROVENANCE_PREFIX)) return;
    try {
      const value = JSON.parse(line.slice(CLAUDE_PROVENANCE_PREFIX.length)) as Record<string, unknown>;
      if (
        typeof value.resolvedPath !== "string" ||
        !value.resolvedPath.startsWith("/") ||
        typeof value.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(value.version) ||
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(value.sha256)
      ) {
        throw new Error("invalid fields");
      }
      const observed = {
        resolvedPath: value.resolvedPath,
        version: value.version,
        sha256: value.sha256.toLowerCase(),
      };
      if (this.provenance !== null && JSON.stringify(this.provenance) !== JSON.stringify(observed)) {
        throw new Error("conflicting records");
      }
      this.provenance = observed;
    } catch (err) {
      this.provenanceError = new Error(
        `invalid production daemon Claude provenance: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export class DetachedProcessSupervisor {
  private readonly pid: number;
  private readonly closePromise: Promise<ProcessCloseResult>;
  private closeResult: ProcessCloseResult | null = null;
  private readonly knownGroups = new Set<number>();

  constructor(private readonly child: ChildProcess) {
    if (process.platform === "win32") throw new Error("detached process-group supervision requires POSIX");
    if (child.pid === undefined) throw new Error("cannot supervise a child process without a pid");
    this.pid = child.pid;
    this.knownGroups.add(this.pid);
    this.closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.closeResult = { kind: "closed", code, signal };
        resolve(this.closeResult);
      });
    });
  }

  async terminate(options: TerminationOptions): Promise<ProcessCloseResult> {
    await this.refreshDescendantGroups();
    this.signalKnownGroups("SIGTERM");
    const graceful = await this.waitForClosedGroups(options.graceMs);
    if (graceful !== null) return graceful;

    await this.refreshDescendantGroups();
    this.signalKnownGroups("SIGKILL");
    const forced = await this.waitForClosedGroups(options.killWaitMs);
    if (forced === null) {
      throw new Error(`daemon process tree rooted at ${this.pid} did not close after SIGKILL`);
    }
    return forced;
  }

  private async waitForClosedGroups(timeoutMs: number): Promise<ProcessCloseResult | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closeResult !== null && this.allKnownGroupsGone()) return this.closeResult;
      if (this.closeResult === null) {
        await Promise.race([
          this.closePromise.then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 20)),
        ]);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    return this.closeResult !== null && this.allKnownGroupsGone() ? this.closeResult : null;
  }

  private async refreshDescendantGroups(): Promise<void> {
    const rows = parseProcessTable(await readProcessTable());
    const children = new Map<number, Array<{ pid: number; pgid: number }>>();
    for (const row of rows) {
      const entries = children.get(row.ppid) ?? [];
      entries.push({ pid: row.pid, pgid: row.pgid });
      children.set(row.ppid, entries);
    }

    const pending = [this.pid];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const parent = pending.pop()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      for (const descendant of children.get(parent) ?? []) {
        if (descendant.pgid > 1) this.knownGroups.add(descendant.pgid);
        pending.push(descendant.pid);
      }
    }
  }

  private signalKnownGroups(signal: NodeJS.Signals): void {
    for (const pgid of [...this.knownGroups].sort((a, b) => b - a)) {
      try {
        process.kill(-pgid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
  }

  private allKnownGroupsGone(): boolean {
    for (const pgid of this.knownGroups) {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
    return true;
  }
}

interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
}

function readProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pgid="],
      { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err !== null) {
          reject(new Error(`cannot inspect daemon descendants: ${err.message}`, { cause: err }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}
