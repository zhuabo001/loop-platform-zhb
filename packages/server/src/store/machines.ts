/**
 * Store-internal machine primitives: first-contact self-registration and the
 * per-poll heartbeat/identity write (A-13).
 *
 * `lastSeen` is a PERSISTED HEARTBEAT WATERMARK, not a per-poll audit stamp:
 * it refreshes only when null, unparsable, or at least LAST_SEEN_REFRESH_MS
 * (10s) old, and an identity change rides the SAME single UPDATE.
 *
 * Monotonicity contract (A-13 semantic ruling, 2026-07-30 — ADR-003 amended):
 * within the LEGAL watermark domain the stamp never moves backwards
 * (`GREATEST` guard; a within-slack future stamp reads as fresh and simply
 * goes stale naturally). The bound is HEARTBEAT_SKEW_SLACK_MS: a stamp
 * further than that into the future is POLLUTED, not fresh — the write side
 * repairs it to the poll time, and the consumer side (presence/sweep, via
 * `classifyHeartbeatWatermark`) treats it as NO liveness evidence. Without
 * the consumer-side half, a machine that stops polling after writing a
 * polluted stamp would read online forever.
 *
 * These writes happen on EVERY authenticated poll BEFORE the claim scan and
 * OUTSIDE any claim transaction: a lost claim race never rolls back confirmed
 * contact. No `online` column exists anywhere — presence is derived from this
 * watermark plus a threshold at read time.
 */
import { and, eq, sql } from "drizzle-orm";

import { InvalidMachineCredentialError } from "../coordinator/errors.js";
import type { Db } from "../db/index.js";
import { machines, type Machine, type NewMachine } from "../db/schema.js";
import type { Clock } from "../time.js";

export interface MachineStoreDeps {
  db: Db;
  clock: Clock;
}

/** How old the persisted watermark must be before a poll re-stamps it (A-13). */
export const LAST_SEEN_REFRESH_MS = 10_000;

/** Bounded clock-skew tolerance (the 2026-07-30 ruling): 5min ≫ any healthy
 *  NTP/multi-instance skew (sub-second to seconds), ≪ realistic pollution
 *  (+1h, +1day). A watermark beyond this window is anomalous on BOTH sides:
 *  the write side repairs it, the consumer side distrusts it. */
export const HEARTBEAT_SKEW_SLACK_MS = 5 * 60 * 1000;

/** THE shared window judge — write side and presence/sweep consumers MUST use
 *  this one predicate so "anomalous" can never drift between them. */
export function isHeartbeatWatermarkAnomalous(storedMs: number, nowMs: number): boolean {
  return storedMs - nowMs > HEARTBEAT_SKEW_SLACK_MS;
}

/** Consumer-side classification of a persisted watermark. presence/sweep
 *  (Day 8–10) MUST classify through here: `anomalous-future` is pollution,
 *  not proof of life. */
export type HeartbeatWatermarkClass = "absent" | "invalid" | "anomalous-future" | "valid";

export function classifyHeartbeatWatermark(lastSeen: string | null, nowMs: number): HeartbeatWatermarkClass {
  if (lastSeen == null) return "absent";
  const storedMs = Date.parse(lastSeen);
  if (Number.isNaN(storedMs)) return "invalid";
  if (isHeartbeatWatermarkAnomalous(storedMs, nowMs)) return "anomalous-future";
  return "valid";
}

/** Age of a VALID watermark (a within-slack future stamp clamps to 0 = just
 *  seen); null for absent/invalid/anomalous — no liveness evidence. */
export function heartbeatAgeMs(lastSeen: string | null, nowMs: number): number | null {
  if (classifyHeartbeatWatermark(lastSeen, nowMs) !== "valid") return null;
  return Math.max(0, nowMs - Date.parse(lastSeen!));
}

/** Untrusted-wire identity caps: hostname/platform/arch/daemonVersion. */
const CAP_HOSTNAME = 255;
const CAP_PLATFORM = 64;
const CAP_ARCH = 64;
const CAP_VERSION = 64;

/** The identity fields a poll body may report. */
export interface PollIdentity {
  host?: string | undefined;
  platform?: string | undefined;
  arch?: string | undefined;
  version?: string | undefined;
}

/** NUL-strip → trim → blank-means-not-reported → cap. Mirrors the plan's
 *  cleaning rule for every identity field (plan §2). */
function cleanIdentityField(value: string | undefined, cap: number): string | undefined {
  if (value == null) return undefined;
  const cleaned = value.replace(/\0/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, cap);
}

/** Stable display-name fallback derived from the machine id. */
export function machineNameFallback(machineId: string): string {
  return `machine-${machineId.slice(2, 8)}`;
}

export async function getMachine(db: Db, id: string): Promise<Machine | undefined> {
  return (await db.select().from(machines).where(eq(machines.id, id)))[0];
}

/**
 * First-contact self-registration (Phase 1: poll is the ONLY enrollment
 * surface, enrollment is ungated until Phase 5 adds the connect-key check in
 * front of this branch). INSERTs the derived id, the FULL token hash, the
 * cleaned identity snapshot and the clock-stamped watermark in one row.
 *
 * A concurrent first poll for the SAME token loses the PK race: catch, re-read,
 * and converge to the row the winner inserted (idempotent — never a 500). A
 * row at the derived id under a DIFFERENT hash is a truncated-id collision:
 * reject the credential.
 */
export async function registerMachineOnPoll(
  deps: MachineStoreDeps,
  input: { machineId: string; tokenHash: string; identity: PollIdentity },
): Promise<Machine> {
  const nowIso = deps.clock.now().toISOString();
  const hostname = cleanIdentityField(input.identity.host, CAP_HOSTNAME);
  const values: NewMachine = {
    id: input.machineId,
    name: hostname ?? machineNameFallback(input.machineId),
    hostname: hostname ?? null,
    platform: cleanIdentityField(input.identity.platform, CAP_PLATFORM) ?? null,
    arch: cleanIdentityField(input.identity.arch, CAP_ARCH) ?? null,
    daemonVersion: cleanIdentityField(input.identity.version, CAP_VERSION) ?? null,
    tokenHash: input.tokenHash,
    roots: null,
    lastSeen: nowIso,
    createdAt: nowIso,
  };
  try {
    await deps.db.insert(machines).values(values);
  } catch (err) {
    const existing = await getMachine(deps.db, input.machineId);
    if (existing) {
      if (existing.tokenHash === input.tokenHash) return existing;
      throw new InvalidMachineCredentialError();
    }
    throw err; // a real DB failure, not a race — surface it (500 at the edge)
  }
  return (await getMachine(deps.db, input.machineId))!;
}

/** The contact could not safely settle within the bounded CAS budget.
 *  Failing explicitly is preferable to returning success after silently
 *  dropping this Poll's identity snapshot; the daemon will retry on its next
 *  Poll while every competing successful writer remains monotonic. */
export class MachineContactContentionError extends Error {
  constructor(readonly machineId: string) {
    super(`machine contact contention did not settle for ${machineId}`);
    this.name = "MachineContactContentionError";
  }
}

/**
 * The per-poll heartbeat + identity write for an ALREADY-VERIFIED machine.
 * Returns the fresh row. Read-only when the watermark is fresh and no
 * identity field changed — the hot path of an idle daemon.
 *
 * Write shape (at most ONE successful row mutation per Poll; correction CAS
 * misses may issue bounded zero-row UPDATE attempts before success/failure):
 *  - watermark stale / null      → lastSeen = GREATEST(stored, pollTime) (monotonic)
 *  - watermark unparsable        → lastSeen = pollTime, CAS-guarded
 *  - watermark ANOMALOUS-future  → lastSeen = pollTime, CAS-guarded (pollution
 *    repair; the ONE allowed downward write, outside the legal monotonic domain)
 *  - watermark within-slack-future → reads as fresh, no write (never regress)
 *  - identity changed            → the changed fields ride the SAME update, which
 *                                  also refreshes the watermark (max-guarded)
 *  - empty name + valid host     → name is filled from the hostname (a non-empty
 *                                  friendly name is NEVER overwritten)
 *
 * The correction branches are OPTIMISTIC-CAS'd on the observed watermark
 * (A-13: the monotonic condition must live in the DB write guard — 二次审核
 * P1): two polls that observed the SAME polluted value race to repair it, and
 * the loser's `WHERE last_seen = <observed>` simply misses — it re-reads and
 * re-decides against the winner's (legal) value instead of blindly
 * overwriting it with an older poll time.
 */
export async function applyMachinePollContact(
  deps: MachineStoreDeps,
  machine: Machine,
  identity: PollIdentity,
): Promise<Machine> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await tryApplyContact(deps, machine, identity);
    if (result !== "cas-lost") return result;
    // Lost the repair race: re-read the winner's row and re-decide (its value
    // is normally in the legal domain now, so the next attempt takes the
    // monotonic or read-only path while recomputing this Poll's identity patch).
    machine = (await getMachine(deps.db, machine.id))!;
  }
  // Do not acknowledge a Poll whose identity/contact write never landed.
  // An explicit failure lets the caller retry; returning `machine` here would
  // silently discard optional identity fields that may not be sent again.
  throw new MachineContactContentionError(machine.id);
}

async function tryApplyContact(
  deps: MachineStoreDeps,
  machine: Machine,
  identity: PollIdentity,
): Promise<Machine | "cas-lost"> {
  const pollTime = deps.clock.now();
  const pollIso = pollTime.toISOString();
  const pollMs = pollTime.getTime();
  const storedMs = machine.lastSeen == null ? Number.NaN : Date.parse(machine.lastSeen);

  const garbage = machine.lastSeen != null && Number.isNaN(storedMs);
  const anomalousFuture = !Number.isNaN(storedMs) && isHeartbeatWatermarkAnomalous(storedMs, pollMs);
  const nearFuture = !Number.isNaN(storedMs) && !anomalousFuture && storedMs > pollMs;
  const stale =
    !nearFuture && !anomalousFuture && (machine.lastSeen == null || pollMs - storedMs >= LAST_SEEN_REFRESH_MS);

  const patch: Partial<NewMachine> = {};
  const hostname = cleanIdentityField(identity.host, CAP_HOSTNAME);
  if (hostname !== undefined && hostname !== machine.hostname) patch.hostname = hostname;
  const platform = cleanIdentityField(identity.platform, CAP_PLATFORM);
  if (platform !== undefined && platform !== machine.platform) patch.platform = platform;
  const arch = cleanIdentityField(identity.arch, CAP_ARCH);
  if (arch !== undefined && arch !== machine.arch) patch.arch = arch;
  const version = cleanIdentityField(identity.version, CAP_VERSION);
  if (version !== undefined && version !== machine.daemonVersion) patch.daemonVersion = version;
  if (hostname !== undefined && machine.name.trim() === "") patch.name = hostname;

  const identityChanged = Object.keys(patch).length > 0;

  // Pollution repair (downward write) — optimistic CAS on the observed value
  // (non-null in both correction branches: garbage and anomalous-future both
  // require a present watermark).
  if (garbage || anomalousFuture) {
    const repaired = await deps.db
      .update(machines)
      .set({ ...patch, lastSeen: pollIso })
      .where(and(eq(machines.id, machine.id), eq(machines.lastSeen, machine.lastSeen!)))
      .returning({ id: machines.id });
    if (repaired.length === 0) return "cas-lost";
    return (await getMachine(deps.db, machine.id))!;
  }

  if (!stale && !identityChanged) return machine; // fresh — read-only

  await deps.db
    .update(machines)
    .set({ ...patch, lastSeen: sql`GREATEST(${machines.lastSeen}, ${pollIso})` })
    .where(eq(machines.id, machine.id));
  return (await getMachine(deps.db, machine.id))!;
}
