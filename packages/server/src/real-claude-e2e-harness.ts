import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type DaemonLogStream = "stdout" | "stderr";

export class DaemonLogObserver {
  private readonly secrets: Buffer[];
  private readonly overlapBytes: number;
  private readonly overlap: Record<DaemonLogStream, Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
  private tail = Buffer.alloc(0);
  private foundSecret = false;

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
}

export const CLAUDE_PROVENANCE_PREFIX = "loopzhb claude provenance ";
export const CLAUDE_PROCESS_GROUP_PREFIX = "loopzhb claude process-group ";

export interface ClaudeProvenance {
  resolvedPath: string;
  version: string;
  sha256: string;
}

export type ProcessGroupEvent =
  | { kind: "started"; pgid: number }
  | { kind: "closed"; pgid: number };

export class DaemonControlObserver {
  private readonly decoder = new StringDecoder("utf8");
  private lineCarry = "";
  private provenance: ClaudeProvenance | null = null;
  private controlError: Error | null = null;

  constructor(private readonly onProcessGroup: (event: ProcessGroupEvent) => void) {}

  append(chunk: Uint8Array): void {
    this.observeLines(this.decoder.write(Buffer.from(chunk)));
  }

  requireApprovedProvenance(expectedSha256: string): ClaudeProvenance {
    const provenance = this.approvedProvenance(expectedSha256);
    if (provenance === null) throw new Error("production daemon did not report Claude provenance");
    return provenance;
  }

  approvedProvenance(expectedSha256: string): ClaudeProvenance | null {
    this.assertHealthy();
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
      throw new Error("LOOPZHB_EXPECTED_CLAUDE_SHA256 must be exactly 64 hexadecimal characters");
    }
    if (this.provenance === null) return null;
    if (this.provenance.sha256 !== expectedSha256.toLowerCase()) {
      throw new Error("production daemon Claude provenance does not match the approved sha256");
    }
    return this.provenance;
  }

  assertHealthy(): void {
    if (this.controlError !== null) throw this.controlError;
  }

  private observeLines(text: string): void {
    this.lineCarry += text;
    let newline = this.lineCarry.indexOf("\n");
    while (newline !== -1) {
      const line = this.lineCarry.slice(0, newline).replace(/\r$/, "");
      this.lineCarry = this.lineCarry.slice(newline + 1);
      this.observeLine(line);
      newline = this.lineCarry.indexOf("\n");
    }
    if (this.lineCarry.length > 8192) {
      if (this.lineCarry.includes(CLAUDE_PROVENANCE_PREFIX) || this.lineCarry.includes(CLAUDE_PROCESS_GROUP_PREFIX)) {
        this.controlError = new Error("production daemon emitted an oversized control record");
      }
      this.lineCarry = this.lineCarry.slice(-8192);
    }
  }

  private observeLine(line: string): void {
    if (line.startsWith(CLAUDE_PROVENANCE_PREFIX)) {
      this.observeProvenance(line.slice(CLAUDE_PROVENANCE_PREFIX.length));
      return;
    }
    if (line.startsWith(CLAUDE_PROCESS_GROUP_PREFIX)) {
      this.observeProcessGroup(line.slice(CLAUDE_PROCESS_GROUP_PREFIX.length));
    }
  }

  private observeProvenance(json: string): void {
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
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
      this.controlError = new Error(
        `invalid production daemon Claude provenance: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private observeProcessGroup(json: string): void {
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
      if (
        (value.kind !== "started" && value.kind !== "closed") ||
        typeof value.pgid !== "number" ||
        !Number.isSafeInteger(value.pgid) ||
        value.pgid <= 1
      ) {
        throw new Error("invalid fields");
      }
      this.onProcessGroup({ kind: value.kind, pgid: value.pgid });
    } catch (err) {
      this.controlError = new Error(
        `invalid production daemon Claude process-group record: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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

export class DetachedProcessSupervisor {
  private readonly pid: number;
  private readonly closePromise: Promise<ProcessCloseResult>;
  private closeResult: ProcessCloseResult | null = null;
  private readonly knownGroups = new Set<number>();
  private terminationPromise: Promise<ProcessCloseResult> | null = null;
  private currentSignal: NodeJS.Signals | null = null;

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

  trackProcessGroup(pgid: number): void {
    this.validateExternalGroup(pgid);
    this.knownGroups.add(pgid);
    if (this.currentSignal !== null) this.signalGroup(pgid, this.currentSignal);
  }

  releaseProcessGroup(pgid: number): void {
    this.validateExternalGroup(pgid);
    this.knownGroups.delete(pgid);
  }

  async terminate(options: TerminationOptions): Promise<ProcessCloseResult> {
    this.terminationPromise ??= this.terminateOnce(options);
    return await this.terminationPromise;
  }

  private async terminateOnce(options: TerminationOptions): Promise<ProcessCloseResult> {
    this.currentSignal = "SIGTERM";
    this.signalKnownGroups("SIGTERM");
    const graceful = await this.waitForClosedGroups(options.graceMs);
    if (graceful !== null) return graceful;

    this.currentSignal = "SIGKILL";
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

  private signalKnownGroups(signal: NodeJS.Signals): void {
    for (const pgid of [...this.knownGroups].sort((a, b) => b - a)) this.signalGroup(pgid, signal);
  }

  private signalGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
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

  private validateExternalGroup(pgid: number): void {
    if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === this.pid) {
      throw new Error(`invalid external process group ${pgid}`);
    }
  }
}
