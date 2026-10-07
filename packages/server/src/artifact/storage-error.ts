/**
 * The shared recoverable-storage-failure classifier (ADR-010 决策 13's
 * `artifact_storage_error` / idempotent_retry). Extracted from sync.ts in
 * Batch 2 slice 2 when the artifact-sync-error writer became its second
 * caller: one SQLSTATE table, so the two write paths can never drift into
 * classifying the same driver failure differently.
 */

/** The recoverable Postgres storage-failure classes: 08xxx connection
 *  exception, 53xxx insufficient resources, 57xxx operator intervention,
 *  58xxx system/internal I/O. */
const RECOVERABLE_STORAGE_SQLSTATE_CLASSES = ["08", "53", "57", "58"] as const;

/** Walk the cause chain for an IDENTIFIED recoverable storage failure. The
 *  classification is deliberately narrow (决策 13): only a string SQLSTATE in
 *  a recoverable class qualifies — constraint violations, serialization /
 *  deadlock codes, Node errno strings and every UNCODED error keep the
 *  raw-throw boundary, because laundering an unrecognized defect into the
 *  retryable class would loop a permanent failure. */
export function isRecoverableStorageError(err: unknown): boolean {
  let cur: unknown = err;
  while (cur !== null && typeof cur === "object") {
    if ("code" in cur) {
      const code = (cur as { code: unknown }).code;
      if (typeof code === "string" && RECOVERABLE_STORAGE_SQLSTATE_CLASSES.some((cls) => code.startsWith(cls))) return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
