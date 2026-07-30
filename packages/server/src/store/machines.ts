/**
 * Store-internal machine primitives: first-contact self-registration and the
 * per-poll heartbeat/identity write (A-13).
 *
 * `lastSeen` is a PERSISTED HEARTBEAT WATERMARK, not a per-poll audit stamp:
 * it refreshes only when null, unparsable, or at least LAST_SEEN_REFRESH_MS
 * (10s) old, and an identity change rides the SAME single UPDATE. A future
 * stamp reads as fresh — the monotonic guard (`GREATEST`) never writes the
 * watermark backwards, so skewed clocks can't drag it down; it simply goes
 * stale naturally as real time catches up. Unparsable garbage can't
 * participate in a max() comparison, so it is corrected unconditionally.
 *
 * These writes happen on EVERY authenticated poll BEFORE the claim scan and
 * OUTSIDE any claim transaction: a lost claim race never rolls back confirmed
 * contact. No `online` column exists anywhere — presence is derived from this
 * watermark plus a threshold at read time.
 */
import { eq, sql } from "drizzle-orm";

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

/**
 * The per-poll heartbeat + identity write for an ALREADY-VERIFIED machine.
 * Returns the fresh row. Read-only when the watermark is fresh and no
 * identity field changed — the hot path of an idle daemon.
 *
 * Write shape (at most ONE update per poll):
 *  - watermark stale / null  → lastSeen = GREATEST(stored, pollTime) (monotonic)
 *  - watermark unparsable    → lastSeen = pollTime (correction; garbage can't max())
 *  - watermark future        → reads as fresh, no write (never regress)
 *  - identity changed        → the changed fields ride the SAME update, which
 *                              also refreshes the watermark (max-guarded)
 *  - empty name + valid host → name is filled from the hostname (a non-empty
 *                              friendly name is NEVER overwritten)
 */
export async function applyMachinePollContact(
  deps: MachineStoreDeps,
  machine: Machine,
  identity: PollIdentity,
): Promise<Machine> {
  const pollTime = deps.clock.now();
  const pollIso = pollTime.toISOString();
  const pollMs = pollTime.getTime();
  const storedMs = machine.lastSeen == null ? Number.NaN : Date.parse(machine.lastSeen);

  const garbage = machine.lastSeen != null && Number.isNaN(storedMs);
  const future = !Number.isNaN(storedMs) && storedMs > pollMs;
  const stale = !future && (machine.lastSeen == null || pollMs - storedMs >= LAST_SEEN_REFRESH_MS);

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
  if (future && !identityChanged) return machine; // fresh (skew) — read-only
  if (!garbage && !stale && !identityChanged) return machine; // fresh — read-only

  const lastSeen = garbage ? pollIso : sql`GREATEST(${machines.lastSeen}, ${pollIso})`;
  await deps.db
    .update(machines)
    .set({ ...patch, lastSeen })
    .where(eq(machines.id, machine.id));
  return (await getMachine(deps.db, machine.id))!;
}
