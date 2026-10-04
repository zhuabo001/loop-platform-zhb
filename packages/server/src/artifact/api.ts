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
import type { ArtifactHomeDeps } from "./sync.js";
import { commitArtifactSync, prepareArtifactSync, putArtifactBlob, type CommitArtifactSyncResult, type PrepareArtifactSyncResult, type PutArtifactBlobResult } from "./sync.js";
import { recordArtifactSyncError, type RecordArtifactSyncErrorResult } from "./sync-error.js";
import { isRecoverableStorageError } from "./storage-error.js";
import { updateArtifactConfig, type UpdateArtifactConfigResult } from "./config.js";

export type MachineLoopArtifactsReadResult =
  | { ok: true; response: MachineLoopArtifactsResponse }
  | { ok: false; failure: "attribution_missing" | "loop_not_found" | "artifact_dir_unconfigured" | "storage_error"; cause?: unknown };

export interface ArtifactApi {
  /** PATCH /api/loops/:id/artifact-dir — management, no credential. */
  updateConfig(loopId: string, command: { artifactDir: string | null }): Promise<UpdateArtifactConfigResult>;
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
  const { db, clock, attribution } = home;

  async function authenticate(token: string): Promise<TrustedMachineIdentity> {
    const machine = await verifyMachineCredential(db, token);
    if (!machine) throw new InvalidMachineCredentialError();
    return { machineId: machine.id };
  }

  return {
    updateConfig(loopId, command) {
      return updateArtifactConfig({ db, clock }, loopId, { artifactDir: command.artifactDir });
    },

    async readMachineLoop(token, loopId) {
      const machine = await authenticate(token);
      const resolved = await attribution.resolve(machine);
      if (!resolved.ok) return { ok: false, failure: "attribution_missing" };
      try {
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
      } catch (err) {
        if (isRecoverableStorageError(err)) return { ok: false, failure: "storage_error", cause: err };
        throw err;
      }
    },

    async prepare(token, request) {
      return prepareArtifactSync(home, await authenticate(token), request);
    },

    async put(token, input) {
      return putArtifactBlob(home, await authenticate(token), input);
    },

    async commit(token, input) {
      return commitArtifactSync(home, await authenticate(token), input);
    },

    async reportSyncError(token, loopId, report) {
      return recordArtifactSyncError({ db, clock, attribution }, await authenticate(token), loopId, report);
    },
  };
}
