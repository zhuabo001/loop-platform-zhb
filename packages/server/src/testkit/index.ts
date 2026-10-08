/**
 * Shared test fixtures — TEST-ONLY (excluded from the build via
 * tsconfig.build.json; nothing here ships in dist or package exports).
 *
 * Deterministic seams for the coordinator tests: a FakeClock, id/credential
 * factories with predictable sequences, and tiny row-seeding helpers so each
 * test states its fixture in one line.
 */
import { asc, eq } from "drizzle-orm";

import { machineIdFromToken, sha256 } from "@loopzhb/protocol/node";

import type { RunCoordinatorDependencies } from "../coordinator/index.js";
import type { AuthConfig } from "../config.js";
import type { Db } from "../db/index.js";
import {
  artifactBlobs,
  artifactManifests,
  artifactSyncSessions,
  authSessions,
  loops,
  machines,
  memberships,
  runLeases,
  runs,
  teams,
  users,
  type Loop,
  type NewLoop,
  type NewMachine,
  type NewRun,
  type NewRunLease,
  type NewTeam,
  type NewUser,
  type Run,
  type RunLeaseRow,
} from "../db/schema.js";
import type { Clock } from "../time.js";
import type { CronFactory, CronJob } from "../scheduler/index.js";

export const FIXTURE_T0 = new Date("2026-07-29T00:00:00.000Z");

export class FakeClock implements Clock {
  private t: number;
  constructor(t: number | Date = FIXTURE_T0) {
    this.t = typeof t === "number" ? t : t.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  iso(): string {
    return this.now().toISOString();
  }
}

export interface FakeCronJobEntry {
  pattern: string;
  options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void };
  callback: () => void | Promise<void>;
  stopped: boolean;
}

/**
 * On-demand Croner double shared by scheduler tests. Jobs never tick on their
 * own: tests may inspect registration, fire callbacks, or retain callbacks
 * past stop() to verify the stopped guard.
 */
export class FakeCronFactory implements CronFactory {
  public jobs = new Map<string, FakeCronJobEntry>();
  private idSeq = 0;

  create(
    pattern: string,
    options: { timezone: string; protect?: (job: unknown) => void; catch?: (err: unknown) => void },
    callback: () => void | Promise<void>,
  ): CronJob {
    const id = `job-${++this.idSeq}`;
    this.jobs.set(id, { pattern, options, callback, stopped: false });
    return {
      stop: () => {
        const entry = this.jobs.get(id);
        if (entry) entry.stopped = true;
      },
    };
  }

  async triggerAll(): Promise<void> {
    await Promise.all(this.fireAll());
  }

  /** Returns raw callback promises so race tests control their own awaits. */
  fireAll(): Promise<unknown>[] {
    return [...this.jobs.values()]
      .filter((entry) => !entry.stopped)
      .map((entry) => Promise.resolve(entry.callback()));
  }

  activeCount(): number {
    return [...this.jobs.values()].filter((entry) => !entry.stopped).length;
  }

  entries(): FakeCronJobEntry[] {
    return [...this.jobs.values()];
  }
}

/** Deterministic id/credential factories: `run-1`, `run-2`, … and
 *  `rk_testcred_1`, … (shape-valid per `isRunTokenShape`). Determinism lets
 *  tests assert exact rows and force PK collisions for rollback injection. */
export function makeTestFactories(): Pick<RunCoordinatorDependencies, "newRunId" | "mintRunCredential"> {
  let runN = 0;
  let credN = 0;
  return {
    newRunId: () => `run-${++runN}`,
    mintRunCredential: () => `rk_testcred_${++credN}`,
  };
}

export function testDeps(
  db: Db,
  clock: Clock = new FakeClock(),
  overrides: Partial<RunCoordinatorDependencies> = {},
): RunCoordinatorDependencies {
  return { db, clock, ...makeTestFactories(), ...overrides };
}

/** Seed a machine by ID. `overrides` carries anything the fixture needs to
 *  state explicitly — `teamId` for a claimed machine, `revokedAt` for a
 *  revoked one; the omitted fields stay at their neutral values (teamId null =
 *  UNCLAIMED). */
export async function seedMachine(db: Db, id: string, overrides: Partial<NewMachine> = {}): Promise<void> {
  await db.insert(machines).values({
    id,
    name: "",
    tokenHash: `hash-${id}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

/** Seed a machine row at the id a device token derives to — the row's id and
 *  full token hash are exactly what the credential gate compares against.
 *  `teamId` defaults to NULL: the row is UNCLAIMED, which the poll gate
 *  rejects (PG5). Use `seedClaimedMachineForToken` for an eligible machine. */
export async function seedMachineForToken(
  db: Db,
  token: string,
  overrides: Partial<NewMachine> = {},
): Promise<string> {
  const id = machineIdFromToken(token);
  await db.insert(machines).values({
    id,
    name: "",
    tokenHash: sha256(token),
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
  return id;
}

/** The standard Team fixture id — same `t-<hex16>` shape ADR-011 决策 2 mints,
 *  and legal under the BlobStore's NAMESPACE_ID_RE. */
export const TEST_TEAM_ID = "t-0123456789abcdef";

/** Seed a machine row BY ID as claimed by the standard test team and not
 *  revoked — the execution-eligible fixture for tests that know only a
 *  machine id (loops, artifact reads, the scheduler). Token-based callers use
 *  `seedClaimedMachine` instead. */
export async function seedClaimedMachineById(db: Db, id: string): Promise<void> {
  await seedMachine(db, id, { teamId: TEST_TEAM_ID });
}

/**
 * Seed a machine for a device token as CLAIMED and NOT REVOKED — the
 * execution-eligible fixture (Phase 5 Batch 3 slice 3, ADR-011).
 *
 * Slice 3 removed production self-registration, so every test that polls must
 * state its machine explicitly. `seedMachineForToken` alone produces an
 * UNCLAIMED row (teamId NULL), which the poll gate now rejects with the
 * unified 401 — that is the PG5 fixture. This helper is the PG6 one.
 */
export async function seedClaimedMachineForToken(
  db: Db,
  token: string,
  overrides: Partial<NewMachine> = {},
): Promise<string> {
  return seedMachineForToken(db, token, { teamId: TEST_TEAM_ID, ...overrides });
}

/**
 * Idempotent variant for REBOOT scenarios: a second boot of the same dataDir
 * re-reads the persisted row instead of inserting a duplicate. Returns the
 * machine id either way.
 */
export async function seedClaimedMachineIfAbsent(db: Db, token: string): Promise<string> {
  const id = machineIdFromToken(token);
  const existing = await db.select({ id: machines.id }).from(machines).where(eq(machines.id, id));
  if (existing.length === 0) await seedClaimedMachineForToken(db, token);
  return id;
}

export async function seedLoop(db: Db, values: Partial<NewLoop> & { id: string }): Promise<void> {
  await db.insert(loops).values({
    machineId: "m-test",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...values,
  });
}

export async function seedRun(db: Db, values: Partial<NewRun> & { id: string }): Promise<void> {
  await db.insert(runs).values({
    loopId: "loop-1",
    machineId: "m-test",
    phase: "pending",
    role: "exec",
    ts: "2026-07-01T00:00:00.000Z",
    ...values,
  });
}

/** Seed a run lease (Phase 1 all-false caps by default). Key by the sha256 of
 *  the wire credential the test will present. */
export async function seedLease(db: Db, values: Partial<NewRunLease> & { tokenHash: string }): Promise<void> {
  await db.insert(runLeases).values({
    runId: "run-1",
    loopId: "loop-1",
    machineId: "m-test",
    role: "exec",
    allowControl: false,
    canSetUi: false,
    canSetSchema: false,
    canSetWorkflow: false,
    canFinish: false,
    state: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...values,
  });
}

/** Whole-table snapshot, id-ordered — for exact "zero writes" assertions. */
export async function snapshotRuns(db: Db): Promise<Run[]> {
  return db.select().from(runs).orderBy(asc(runs.id));
}

export async function snapshotLoops(db: Db): Promise<Loop[]> {
  return db.select().from(loops).orderBy(asc(loops.id));
}

export async function snapshotLeases(db: Db): Promise<RunLeaseRow[]> {
  return db.select().from(runLeases).orderBy(asc(runLeases.tokenHash));
}

/**
 * EVERY business table, deterministically ordered — the zero-write oracle for
 * the Phase 5 Batch 3 slice 3 refusal paths (Batch plan §1 验收: 对比拒绝前后
 * Machine、Run、Lease 和 Artifact 状态，证明零业务写入).
 *
 * Pair it with a POPULATED fixture: an empty table trivially "stays equal",
 * so a refusal test that seeds nothing proves almost nothing (review issue
 * #123 — a mutation inserting a real Run row left the old oracle green).
 */
export async function snapshotBusinessState(db: Db) {
  return {
    machines: await db.select().from(machines).orderBy(asc(machines.id)),
    loops: await db.select().from(loops).orderBy(asc(loops.id)),
    runs: await db.select().from(runs).orderBy(asc(runs.id)),
    runLeases: await snapshotLeases(db),
    artifactSyncSessions: await db.select().from(artifactSyncSessions).orderBy(asc(artifactSyncSessions.id)),
    artifactManifests: await db.select().from(artifactManifests).orderBy(asc(artifactManifests.id)),
    artifactBlobs: await db
      .select()
      .from(artifactBlobs)
      .orderBy(asc(artifactBlobs.namespaceId), asc(artifactBlobs.hash)),
  };
}

export { staticAttribution } from "./artifact-attribution.js";

// ---- Phase 5 Batch 3 identity fixtures (ADR-011) ----
//
// Explicit row seeders for the identity model — there is deliberately NO
// production self-registration path for any of these (Slice 1 停止边界):
// users/teams/memberships come from the slice-2 login transaction, machine
// claiming from the slice-4 offline CLI. Tests state their identity fixture
// in one line, the same way they state machines and loops.

/** A valid AuthConfig for boots that must pass the ADR-011 决策 5 gate.
 *  Loopback origin + fake GitHub credentials; override per test. */
export function makeTestAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  const origin = "http://127.0.0.1:3000";
  return {
    origin,
    githubCallbackUrl: `${origin}/auth/github/callback`,
    githubClientId: "test-gh-client-id",
    githubClientSecret: "test-gh-client-secret",
    ...overrides,
  };
}

/** Seed a User (GitHub numeric id as decimal string). Returns the id. */
export async function seedUser(db: Db, values: Partial<NewUser> = {}): Promise<string> {
  const id = values.id ?? "424242";
  await db.insert(users).values({
    id,
    username: "tester",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...values,
  });
  return id;
}

/** Seed a Team. The default id derives deterministically from the owner
 *  (`t-<sha256("team:"+githubUserId)[:16]>` — the ADR-011 决策 2 minting
 *  rule, so fixtures exercise the same shape production will). */
export async function seedTeam(db: Db, values: Partial<NewTeam> & { ownerUserId: string }): Promise<string> {
  const id = values.id ?? `t-${sha256(`team:${values.ownerUserId}`).slice(0, 16)}`;
  await db.insert(teams).values({
    id,
    name: `team-${values.ownerUserId}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...values,
  });
  return id;
}

export async function seedMembership(
  db: Db,
  values: { userId: string; teamId: string; role?: "owner"; createdAt?: string },
): Promise<void> {
  await db.insert(memberships).values({
    role: "owner",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...values,
  });
}

/** Seed the full first-login product in one call: User + personal Team +
 *  owner Membership. The PG/MG/SE access-matrix fixture. */
export async function seedPersonalIdentity(
  db: Db,
  opts: { githubUserId?: string; username?: string } = {},
): Promise<{ userId: string; teamId: string }> {
  const userId = await seedUser(db, { id: opts.githubUserId ?? "424242", username: opts.username ?? "tester" });
  const teamId = await seedTeam(db, { ownerUserId: userId, name: opts.username ?? "tester" });
  await seedMembership(db, { userId, teamId });
  return { userId, teamId };
}

let sessionSeq = 0;

/** Seed a Login Session row (ADR-011 决策 4: hash-only, absolute 7-day
 *  lifetime). Returns BOTH the plaintext credential (for Cookie headers) and
 *  its persisted hash. Default expiry pins the absolute-lifetime semantics:
 *  FIXTURE_T0 + 7 days, computed — never sliding. */
export async function seedSession(
  db: Db,
  values: { userId: string; credential?: string; credentialHash?: string; createdAt?: string; expiresAt?: string },
): Promise<{ credential: string; credentialHash: string }> {
  const credential = values.credential ?? `sk_test_${++sessionSeq}`;
  const credentialHash = values.credentialHash ?? sha256(credential);
  await db.insert(authSessions).values({
    credentialHash,
    userId: values.userId,
    createdAt: values.createdAt ?? FIXTURE_T0.toISOString(),
    expiresAt: values.expiresAt ?? new Date(FIXTURE_T0.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  return { credential, credentialHash };
}

/** Seed a CLAIMED machine: the machine a given device token owns, already
 *  bound to a team (the slice-4 claim's product). A machine seeded WITHOUT
 *  teamId (plain `seedMachineForToken`) is the Unclaimed Machine fixture. */
export async function seedClaimedMachine(
  db: Db,
  token: string,
  teamId: string,
  overrides: Partial<NewMachine> = {},
): Promise<string> {
  return seedMachineForToken(db, token, { teamId, ...overrides });
}

// ---- Slice 2: Set-Cookie assertion helper ----

export interface ParsedSetCookie {
  name: string;
  value: string;
  /** Attribute keys lowercased; flag attributes (HttpOnly, Secure) are true. */
  attrs: Record<string, string | true>;
}

/** Parse ALL Set-Cookie headers of a response (a 303 can carry both a session
 *  cookie and a tx-cookie clear). Uses `headers.getSetCookie()` — never
 *  `get()`, which would smash the values together. */
export function parseSetCookies(res: Response): ParsedSetCookie[] {
  return res.headers.getSetCookie().map((line) => {
    const [nameValue, ...attrParts] = line.split(";");
    const eq = nameValue!.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const part of attrParts) {
      const trimmed = part.trim();
      const i = trimmed.indexOf("=");
      if (i === -1) attrs[trimmed.toLowerCase()] = true;
      else attrs[trimmed.slice(0, i).trim().toLowerCase()] = trimmed.slice(i + 1).trim();
    }
    return { name: nameValue!.slice(0, eq), value: nameValue!.slice(eq + 1), attrs };
  });
}

/** The value of one named Set-Cookie, or undefined when absent. */
export function setCookieValue(res: Response, name: string): string | undefined {
  return parseSetCookies(res).find((c) => c.name === name)?.value;
}
