/**
 * The artifact HTTP facade — the narrow interface `http/app.ts` consumes
 * (Batch 2 slice 2). It is the ONLY door between the HTTP adapter and the
 * artifact domain: the adapter never imports Db/BlobStore/store functions
 * (its own module doc forbids it), and this module never shapes HTTP.
 *
 * Every machine method authenticates through `verifyMachineCredential`
 * (existing machines only, NEVER registering — ADR-010 决策 7) and passes the
 * store-resolved identity into the state machine, which re-resolves the
 * storage namespace per operation. Credential failure throws the coordinator's
 * `InvalidMachineCredentialError` — the ONE 401 source the edge already maps
 * for poll. `updateConfig` is the management path: it carries NO credential
 * (loopback/trusted-network boundary, like every other /api/loops route).
 *
 * Storage-failure classification is completed HERE, at the operation boundary
 * (#85): the shared credential read and machineRead's attribution read sit
 * AROUND the domain call, and the domain keeps its pre-transaction reads on
 * the raw-throw boundary — yet every one of them is the same storage read
 * 决策 13 assigns to the stable `storage_error` result. Each machine method
 * therefore wraps its WHOLE flow, so the failure code and the retry class can
 * no longer depend on which query failed.
 *
 * Batch 2 slice 7 adds the four MANAGEMENT reads (决策 27): no credential
 * (loopback boundary, like `updateConfig`), the machine identity discovered
 * from the loop row, attribution re-resolved before any snapshot/path/blob
 * resolution. `openDownload` returns a structured stream HANDLE — response
 * composition, the mid-stream pump and abort cleanup belong to the route.
 */
import { eq } from "drizzle-orm";

import type {
  ArtifactSyncErrorReportRequest,
  MachineLoopArtifactsResponse,
  PrepareArtifactSyncRequest,
} from "@loopzhb/protocol";

import { InvalidMachineCredentialError } from "../coordinator/errors.js";
import { loops } from "../db/schema.js";
import { verifyMachineCredential } from "../store/machines.js";
import type { TrustedMachineIdentity } from "./attribution.js";
import {
  diffLoopSnapshots,
  openArtifactDownload,
  readLoopArtifactsView,
  readRunArtifactsView,
  type ArtifactReadHome,
  type OpenArtifactDownloadResult,
  type ReadDiffResult,
  type ReadLoopArtifactsResult,
  type ReadRunArtifactsResult,
} from "./read.js";
import type { ArtifactHomeDeps } from "./sync.js";
import { commitArtifactSync, prepareArtifactSync, putArtifactBlob, type CommitArtifactSyncResult, type PrepareArtifactSyncResult, type PutArtifactBlobResult } from "./sync.js";
import { recordArtifactSyncError, type RecordArtifactSyncErrorResult } from "./sync-error.js";
import { isRecoverableStorageError } from "./storage-error.js";
import { updateArtifactConfig, type UpdateArtifactConfigResult } from "./config.js";

/**
 * Run one machine operation; a recognized recoverable storage fault that
 * ESCAPES it becomes the operation's stable `storage_error` result (决策 13:
 * `artifact_storage_error` / idempotent_retry), with the original driver
 * error carried as `cause`. Only the IDENTIFIED SQLSTATE classes
 * (08/53/57/58) qualify: invalid credentials still raise the unified 401 and
 * every uncoded/unrecognized defect keeps the raw-throw boundary — an unknown
 * defect is never laundered into the retryable class.
 */
async function withStorageError<T>(run: () => Promise<T>, onStorageError: (cause: unknown) => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isRecoverableStorageError(err)) return onStorageError(err);
    throw err;
  }
}

export type MachineLoopArtifactsReadResult =
  | { ok: true; response: MachineLoopArtifactsResponse }
  | { ok: false; failure: "attribution_missing" | "loop_not_found" | "artifact_dir_unconfigured" | "storage_error"; cause?: unknown };

export interface ArtifactApi {
  /** PATCH /api/loops/:id/artifact-dir — management, no credential. */
  updateConfig(loopId: string, command: { artifactDir: string | null }): Promise<UpdateArtifactConfigResult>;
  /** GET /api/loops/:id/artifacts — management read: the current file view. */
  readLoop(loopId: string): Promise<ReadLoopArtifactsResult>;
  /** GET /api/runs/:id/artifacts — management read: bound snapshot or explicit missing. */
  readRun(runId: string): Promise<ReadRunArtifactsResult>;
  /** GET /api/loops/:id/artifacts/diff — management read: structural diff of two same-loop snapshots. */
  diffSnapshots(loopId: string, query: { from?: string; to: string }): Promise<ReadDiffResult>;
  /** GET /api/loops/:id/artifacts/download — opens the verified blob stream
   *  for one manifest entry; the ROUTE owns response composition, the
   *  mid-stream pump and abort cleanup (决策 27). */
  openDownload(loopId: string, query: { snapshotId: string; path: string }): Promise<OpenArtifactDownloadResult>;
  /** GET /api/machine/loops/:id/artifacts — the restart/conflict recovery read. */
  readMachineLoop(token: string, loopId: string): Promise<MachineLoopArtifactsReadResult>;
  /** POST /api/machine/sync. */
  prepare(token: string, request: PrepareArtifactSyncRequest): Promise<PrepareArtifactSyncResult>;
  /** PUT /api/machine/blob/:hash (the session rides the header). */
  put(token: string, input: { syncId: string; hash: string; bytes: AsyncIterable<Uint8Array> }): Promise<PutArtifactBlobResult>;
  /** POST /api/machine/sync/:id/commit. */
  commit(token: string, input: { syncId: string }): Promise<CommitArtifactSyncResult>;
  /** POST /api/machine/loops/:id/artifact-sync-error. */
  reportSyncError(token: string, loopId: string, report: ArtifactSyncErrorReportRequest): Promise<RecordArtifactSyncErrorResult>;
}

export function createArtifactApi(home: ArtifactHomeDeps): ArtifactApi {
  const { db, clock, attribution, blobStore } = home;
  const reads: ArtifactReadHome = { db, attribution, blobStore };

  async function authenticate(token: string): Promise<TrustedMachineIdentity> {
    const machine = await verifyMachineCredential(db, token);
    if (!machine) throw new InvalidMachineCredentialError();
    return { machineId: machine.id };
  }

  return {
    updateConfig(loopId, command) {
      return updateArtifactConfig({ db, clock }, loopId, { artifactDir: command.artifactDir });
    },

    readLoop(loopId) {
      return withStorageError(
        () => readLoopArtifactsView(reads, loopId),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    readRun(runId) {
      return withStorageError(
        () => readRunArtifactsView(reads, runId),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    diffSnapshots(loopId, query) {
      return withStorageError(
        () => diffLoopSnapshots(reads, loopId, query),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    openDownload(loopId, query) {
      return withStorageError(
        () => openArtifactDownload(reads, loopId, query),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    readMachineLoop(token, loopId) {
      return withStorageError(
        async (): Promise<MachineLoopArtifactsReadResult> => {
          const machine = await authenticate(token);
          const resolved = await attribution.resolve(machine);
          if (!resolved.ok) return { ok: false, failure: "attribution_missing" };
          const loop = (
            await db
              .select({
                id: loops.id,
                machineId: loops.machineId,
                artifactDir: loops.artifactDir,
                configRevision: loops.artifactConfigRevision,
                manifestRevision: loops.artifactManifestRevision,
              })
              .from(loops)
              .where(eq(loops.id, loopId))
              .limit(1)
          )[0];
          // Unknown OR another machine's loop: one leak-free refusal.
          if (!loop || loop.machineId !== machine.machineId) return { ok: false, failure: "loop_not_found" };
          if (loop.artifactDir === null) return { ok: false, failure: "artifact_dir_unconfigured" };
          return {
            ok: true,
            response: {
              loopId: loop.id,
              artifactDir: loop.artifactDir,
              configRevision: loop.configRevision,
              manifestRevision: loop.manifestRevision,
            },
          };
        },
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    prepare(token, request) {
      return withStorageError(
        async (): Promise<PrepareArtifactSyncResult> => prepareArtifactSync(home, await authenticate(token), request),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    put(token, input) {
      return withStorageError(
        async (): Promise<PutArtifactBlobResult> => putArtifactBlob(home, await authenticate(token), input),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    commit(token, input) {
      return withStorageError(
        async (): Promise<CommitArtifactSyncResult> => commitArtifactSync(home, await authenticate(token), input),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },

    reportSyncError(token, loopId, report) {
      return withStorageError(
        async (): Promise<RecordArtifactSyncErrorResult> =>
          recordArtifactSyncError({ db, clock, attribution }, await authenticate(token), loopId, report),
        (cause) => ({ ok: false, failure: "storage_error", cause }),
      );
    },
  };
}
