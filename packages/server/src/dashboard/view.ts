/**
 * Snapshot → page model: PURE functions — no I/O, no HTML, no clock.
 *
 * This is where every display rule of the Batch 3 Dashboard lives as data a
 * test can assert on, so the renderer stays a dumb template:
 *  - the ADR-009 决策 1 lifecycle priority (Completed > Paused > Open/Closed),
 *  - lifecycle and ACTIVITY kept as two independent facts (a late running Run
 *    can outlive completion, so activity must never overwrite lifecycle),
 *  - UTC-labelled timestamps and the single "暂无" placeholder,
 *  - every fixed Chinese string, with the domain terms (Open, Closed,
 *    Completed, Paused, Pending, Running, exec, done, …) kept in English.
 */
import type {
  ArtifactDiffResponse,
  LoopArtifactsResponse,
  LoopSummary,
  RunArtifactsResponse,
  RunRole,
  RunSummary,
  TaskFileSyncError,
} from "@loopzhb/protocol";

import type {
  DashboardActiveRun,
  DashboardBoundSnapshotRef,
  DashboardLoop,
  DashboardSnapshot,
  LoopLifecycle,
} from "./index.js";

/** The one placeholder for "this value is not set" (plan §2 切片一). */
export const NONE_TEXT = "暂无";

/**
 * The Run Now endpoint, in both the shapes that must agree: the Hono pattern
 * `routes.ts` registers (with the parameter placeholder) and the concrete
 * action `page.ts` renders. They live here, side by side, because a drift
 * between them is a silent 404 in the browser — and `page.test.ts` /
 * `routes.test.ts` both close the loop by round-tripping a rendered action.
 */
export const DASHBOARD_RUN_PREFIX = "/dashboard/loops";
export const DASHBOARD_RUN_PATH = `${DASHBOARD_RUN_PREFIX}/:id/run`;

/** The form action for one loop. The id is a PATH SEGMENT: percent-encode it,
 *  so a hostile id cannot break out of the attribute (the template would
 *  escape it anyway) and cannot introduce a second path segment. Hono
 *  percent-decodes `:id` on the way back in, so the round trip is lossless. */
export function dashboardRunAction(loopId: string): string {
  return `${DASHBOARD_RUN_PREFIX}/${encodeURIComponent(loopId)}/run`;
}

// ---- slice 7 artifact page paths (ADR-010 决策 27) ----
// Same encoding discipline as `dashboardRunAction`: ids are path segments,
// query values are percent-encoded by the builder — the templates escape
// whatever is interpolated, and these helpers make the href attribute and
// the registered Hono pattern agree by construction.

/** The loop artifact page. */
export function dashboardArtifactsPath(loopId: string): string {
  return `${DASHBOARD_RUN_PREFIX}/${encodeURIComponent(loopId)}/artifacts`;
}

/** The run-snapshot page (one bound Run's file table). */
export function dashboardRunArtifactsPath(loopId: string, runId: string): string {
  return `${dashboardArtifactsPath(loopId)}/runs/${encodeURIComponent(runId)}`;
}

/** The diff result page (GET form target). */
export function dashboardArtifactDiffPath(loopId: string): string {
  return `${dashboardArtifactsPath(loopId)}/diff`;
}

/** The config form's POST action. */
export function dashboardArtifactConfigPath(loopId: string): string {
  return `${dashboardArtifactsPath(loopId)}/config`;
}

/** The Hono patterns the artifact pages register — defined next to the link
 *  builders so a drift between the rendered href and the mounted route is a
 *  one-file diff (the `DASHBOARD_RUN_PATH` convention). */
export const DASHBOARD_LOOP_ARTIFACTS_PATH = `${DASHBOARD_RUN_PREFIX}/:id/artifacts`;
export const DASHBOARD_RUN_ARTIFACTS_PATH = `${DASHBOARD_RUN_PREFIX}/:id/artifacts/runs/:runId`;
export const DASHBOARD_ARTIFACT_DIFF_PATH = `${DASHBOARD_RUN_PREFIX}/:id/artifacts/diff`;
export const DASHBOARD_ARTIFACT_CONFIG_PATH = `${DASHBOARD_RUN_PREFIX}/:id/artifacts/config`;

/** A download href: snapshotId + manifest path as QUERY values, both
 *  percent-encoded — the lookup is the manifest entries table, never a disk
 *  path (决策 27). */
export function artifactDownloadLink(loopId: string, snapshotId: string, path: string): string {
  return `/api/loops/${encodeURIComponent(loopId)}/artifacts/download?snapshotId=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(path)}`;
}

/** Kept in English on purpose: these are domain terms, not UI chrome. */
const LIFECYCLE_LABELS: Record<LoopLifecycle, string> = {
  open: "Open",
  closed: "Closed",
  paused: "Paused",
  completed: "Completed",
};

const SYNCHRONIZED_NEVER_TEXT = "从未成功同步";
const MANUAL_ONLY_TEXT = "手动触发";

const SYNC_ERROR_LABELS: Record<TaskFileSyncError, string> = {
  missing: "文件不存在",
  unreadable: "文件不可读",
  outside_jail: "超出允许目录",
  changed: "同步前后发生变化",
  too_large: "超过大小上限",
};

/** Shown when the machine has no `terminal-journal-v1` capability. A missing
 *  machine row produces the SAME text on purpose: the page must not leak which
 *  internal reason applies, and the operator's action is identical either way. */
export const CAPABILITY_WARNING_TEXT =
  "该 Loop 所在机器未声明 terminal-journal-v1，Phase 4 的 terminal / state / Task File 语义不可用，请升级 daemon 后重新 poll。";

/**
 * The primary lifecycle status by the ADR-009 决策 1 FIXED priority:
 * Completed > Paused > (goal === null ? Open : Closed).
 *
 * Deliberately a local precedence check rather than `classifyLoop`: the latter
 * validates the full snapshot (including `goalRevision`/`scheduleRevision`) and
 * throws, but the Dashboard reads the wire projection, which deliberately does
 * not carry the revision counters. The completion triple is guaranteed atomic
 * by the `loops_completion_ck` CHECK, so the field check below is equivalent
 * for every row the database can hold.
 */
export function classifyDisplayLifecycle(
  loop: Pick<LoopSummary, "goal" | "completedAt" | "completionReason" | "enabled">,
): LoopLifecycle {
  // `?? null` throughout: these are OPTIONAL on the additive wire DTO, so an
  // older producer yields undefined rather than a missing key.
  const goal = loop.goal ?? null;
  const completedAt = loop.completedAt ?? null;
  const completionReason = loop.completionReason ?? null;

  if (goal !== null && completedAt !== null && completionReason !== null) return "completed";
  if (!loop.enabled) return "paused";
  return goal === null ? "open" : "closed";
}

/**
 * `YYYY-MM-DD HH:MM:SS UTC` for a stored ISO timestamp, `暂无` for anything
 * missing or unparseable. Built from `toISOString()`, so the output is a
 * function of the stored value alone — the host timezone can never shift it.
 */
export function formatUtc(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return NONE_TEXT;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return NONE_TEXT;
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const RUN_DISABLED_COMPLETED = "Loop 已完成（Completed），Run Now 会被拒绝。";
const RUN_DISABLED_RUNNING = "已有 Running Run，避免重复触发。";
const RUN_DISABLED_PENDING = "已有 Pending Run，等待执行。";

/**
 * Why the Run Now button is disabled, or `null` when it is available. The rule
 * lives HERE, once, as data a test can assert on.
 *
 * It is the same rule as the backend's manual branch (`store/runs.ts`, Batch 3
 * plan §3 「按钮规则与后端规则一致」), in the same order:
 *   completed → the pre-transaction refusal (`loop_completed`, HTTP 409)
 *   running   → `running_exists`
 *   pending   → `pending_exists` (the Dashboard's `pendingPolicy: "skip"`)
 *
 * `lifecycle === "completed"` is equivalent to the backend's
 * `completedAt !== null` for every row the database can hold: the
 * `loops_completion_ck` CHECK keeps the completion triple atomic (see
 * `classifyDisplayLifecycle`).
 *
 * Paused-but-not-completed with no active run stays ENABLED: a manual trigger
 * deliberately bypasses the enablement check (ADR-008), and a missing
 * `terminal-journal-v1` capability only shows the upgrade hint — it never
 * changes the trigger rule.
 *
 * The page can be up to one meta-refresh (3s) stale, so this is advisory: the
 * backend's skip is the authority, and a click on a stale-looking button still
 * cannot replace a pending run.
 */
export function runNowDisabledReason(input: {
  lifecycle: LoopLifecycle;
  pendingCount: number;
  runningCount: number;
}): string | null {
  if (input.lifecycle === "completed") return RUN_DISABLED_COMPLETED;
  if (input.runningCount > 0) return RUN_DISABLED_RUNNING;
  if (input.pendingCount > 0) return RUN_DISABLED_PENDING;
  return null;
}

/** One in-flight Run line. `phaseLabel` is rendered so the pending/running
 *  distinction never rests on styling alone. */
export interface LoopActivityLine {
  phase: "pending" | "running";
  phaseLabel: string;
  role: RunRole;
  /** `步骤 3：testing（2026-07-01 00:00:05 UTC）`, or 暂无. */
  progressLabel: string;
  /** The Run's last transition, UTC-labelled. */
  transitionLabel: string;
  messageLabel: string;
  errorLabel: string;
}

/** The latest EXEC Run (`ts DESC, id DESC`) — the existing definition, reused. */
export interface LoopLastRunView {
  phase: string;
  statusLabel: string;
  messageLabel: string;
  errorLabel: string;
  transitionLabel: string;
}

export interface LoopCard {
  id: string;
  machineId: string;
  /** The Run Now form action. */
  runAction: string;
  /** Whether that form's button is disabled, and why — the two travel together
   *  so the page can never render a disabled button without a stated reason
   *  (colour alone is not a signal). `runDisabledReason === null` ⟺ enabled. */
  runDisabled: boolean;
  runDisabledReason: string | null;
  nameLabel: string;
  lifecycle: LoopLifecycle;
  lifecycleLabel: string;
  /** The goal dimension, readable independently of the primary status. */
  typeLabel: "Open" | "Closed";
  goalLabel: string;
  /** The cron expression itself, or 手动触发 for a manual-only loop. */
  scheduleLabel: string;
  timezone: string;
  nextFireAtLabel: string;
  taskFilePathLabel: string;
  taskFileSyncedAtLabel: string;
  /** Only ever a FAILED attempt: `taskFileSyncAttemptedAt` also advances on
   *  success, so it is a failure time only while an error is recorded. */
  taskFileFailedAtLabel: string;
  taskFileErrorLabel: string | null;
  lastRun: LoopLastRunView | null;
  completionReasonLabel: string;
  pending: LoopActivityLine[];
  running: LoopActivityLine[];
  capabilityWarning: string | null;
}

export interface DashboardPageModel {
  generatedAtLabel: string;
  /** Always present: the page must state the sort order and the row cap. */
  rangeNotice: string;
  /** Present only when the page came back full — the fixed list cap means
   *  earlier loops MAY exist, but a capped response cannot prove it. */
  truncationNotice: string | null;
  emptyNotice: string | null;
  loops: LoopCard[];
}

function toActivityLine(run: DashboardActiveRun): LoopActivityLine {
  const progress = run.progress;
  return {
    phase: run.phase,
    phaseLabel: run.phase === "pending" ? "Pending" : "Running",
    role: run.role,
    progressLabel:
      progress === null ? NONE_TEXT : `步骤 ${progress.step}：${progress.label}（${formatUtc(progress.at)}）`,
    transitionLabel: formatUtc(run.ts),
    messageLabel: run.message ?? NONE_TEXT,
    errorLabel: run.error ?? NONE_TEXT,
  };
}

function toLastRunView(run: RunSummary): LoopLastRunView {
  return {
    phase: run.phase,
    statusLabel: run.status ?? NONE_TEXT,
    messageLabel: run.message ?? NONE_TEXT,
    errorLabel: run.error ?? NONE_TEXT,
    transitionLabel: formatUtc(run.ts),
  };
}

function toLoopCard(entry: DashboardLoop): LoopCard {
  const loop = entry.loop;
  const goal = loop.goal ?? null;
  const cron = loop.cron ?? null;
  const syncedAt = loop.taskFileSyncedAt ?? null;
  const attemptedAt = loop.taskFileSyncAttemptedAt ?? null;
  const syncError = loop.taskFileSyncError ?? null;
  const runDisabledReason = runNowDisabledReason({
    lifecycle: entry.lifecycle,
    pendingCount: entry.pending.length,
    runningCount: entry.running.length,
  });

  return {
    id: loop.id,
    machineId: loop.machineId,
    runAction: dashboardRunAction(loop.id),
    runDisabled: runDisabledReason !== null,
    runDisabledReason,
    nameLabel: loop.name ?? NONE_TEXT,
    lifecycle: entry.lifecycle,
    lifecycleLabel: LIFECYCLE_LABELS[entry.lifecycle],
    typeLabel: goal === null ? "Open" : "Closed",
    goalLabel: goal ?? NONE_TEXT,
    scheduleLabel: cron === null ? MANUAL_ONLY_TEXT : cron,
    timezone: loop.timezone ?? "UTC",
    nextFireAtLabel: formatUtc(loop.nextFireAt ?? null),
    taskFilePathLabel: loop.taskFile ?? NONE_TEXT,
    taskFileSyncedAtLabel: syncedAt === null ? SYNCHRONIZED_NEVER_TEXT : formatUtc(syncedAt),
    taskFileFailedAtLabel: syncError === null ? NONE_TEXT : formatUtc(attemptedAt),
    taskFileErrorLabel:
      syncError === null ? null : `同步失败：${SYNC_ERROR_LABELS[syncError]}（${syncError}）`,
    lastRun: loop.lastRun === null ? null : toLastRunView(loop.lastRun),
    completionReasonLabel: loop.completionReason ?? NONE_TEXT,
    pending: entry.pending.map(toActivityLine),
    running: entry.running.map(toActivityLine),
    capabilityWarning: entry.terminalJournalV1 ? null : CAPABILITY_WARNING_TEXT,
  };
}

export function buildDashboardPageModel(snapshot: DashboardSnapshot): DashboardPageModel {
  const shown = snapshot.loops.length;
  const atCap = shown >= snapshot.listCap;

  return {
    generatedAtLabel: formatUtc(snapshot.generatedAt),
    rangeNotice: `按最近更新时间倒序显示，最多 ${snapshot.listCap} 条，当前 ${shown} 条；以下时间均为 UTC。`,
    truncationNotice: atCap ? "已达显示上限，可能还有更早更新的 Loop 未显示。" : null,
    emptyNotice: shown === 0 ? "暂无 Loop。通过管理 API 创建 Loop 后会显示在这里。" : null,
    loops: snapshot.loops.map(toLoopCard),
  };
}

// ---- slice 7 artifact page models (ADR-010 决策 27) ----

/** The config form's field name — the ONLY field besides the token that
 *  `checkCsrfFormFields` admits for this form. */
export const ARTIFACT_DIR_FIELD = "artifactDir";

const ARTIFACT_UNCONFIGURED_TEXT = "未配置";
const STALE_NOTICE_TEXT = "配置代际已变更：当前文件视图仍属于旧代际的同步结果，新的同步成功后自动替换。";
const ARTIFACT_SYNC_ERROR_PREFIX = "同步失败";

/** Labels for the `?config=` banner token. Unknown tokens render NO banner —
 *  the set is fixed here so a hostile query value can only ever be inert
 *  text (still escaped by the template). */
export const CONFIG_BANNER_LABELS: Record<string, string> = {
  updated: "Artifact 目录已更新。",
  cleared: "Artifact 目录已清除。",
  unchanged: "Artifact 目录无变化。",
  artifact_config_conflict: "保存被拒绝：配置冲突或代际耗尽，请刷新后重试。",
  artifact_validation_failed: "保存被拒绝：目录非法（需要绝对路径，或相对路径需 Loop 配置 workdir）。",
  not_found: "保存被拒绝：Loop 不存在。",
};

/** The page's default diff baseline (the stop-boundary rule): the MOST RECENT
 *  bound Run snapshot whose manifestRevision is SMALLER than the target's;
 *  `null` = the empty-set baseline (the first-snapshot convention). Pure. */
export function defaultDiffBaseline(
  target: { manifestRevision: number },
  bound: ReadonlyArray<{ manifestRevision: number; committedAt: string }>,
): number | null {
  const older = bound.filter((s) => s.manifestRevision < target.manifestRevision);
  if (older.length === 0) return null;
  older.sort((a, b) => b.manifestRevision - a.manifestRevision || (a.committedAt < b.committedAt ? 1 : -1));
  return older[0]!.manifestRevision;
}

/** One option of the two diff dropdowns. `value` is the snapshot id, or ""
 *  for the empty-set baseline. */
export interface DiffSelectOption {
  value: string;
  label: string;
  selected: boolean;
}

/** The shared diff form model (rendered on the artifact page and the diff
 *  page). `selectedFrom`/`selectedTo` are the current selections ("" = empty
 *  baseline for from). */
export interface DiffFormModel {
  action: string;
  fromOptions: DiffSelectOption[];
  toOptions: DiffSelectOption[];
}

function snapshotLabel(snapshot: { manifestRevision: number; committedAt: string }): string {
  return `r${snapshot.manifestRevision}（${formatUtc(snapshot.committedAt)}）`;
}

function buildDiffFormModel(
  loopId: string,
  bound: ReadonlyArray<DashboardBoundSnapshotRef>,
  selectedFrom: string,
  selectedTo: string,
): DiffFormModel {
  const fromOptions: DiffSelectOption[] = [
    { value: "", label: "（空集合）", selected: selectedFrom === "" },
    ...bound.map((s) => ({ value: s.snapshotId, label: snapshotLabel(s), selected: selectedFrom === s.snapshotId })),
  ];
  const toOptions: DiffSelectOption[] = bound.map((s) => ({
    value: s.snapshotId,
    label: snapshotLabel(s),
    selected: selectedTo === s.snapshotId,
  }));
  return { action: dashboardArtifactDiffPath(loopId), fromOptions, toOptions };
}

/** The artifact overview page: config form, sync state, the current view,
 *  the bound-Run snapshot list and the diff form. */
export interface LoopArtifactsPageModel {
  loopId: string;
  configAction: string;
  configBanner: string | null;
  artifactDirLabel: string;
  /** The raw current dir for the form input ("" when unconfigured). */
  artifactDirValue: string;
  stale: boolean;
  staleNotice: string | null;
  manifestRevision: number;
  committedAtLabel: string;
  fileCountLabel: string;
  totalBytesLabel: string;
  sync: { attemptedAtLabel: string; succeededAtLabel: string; errorLabel: string | null };
  /** One row per current-view file; `downloadLink` is present only when a
   *  manifest is bound (unconfigured loops have no snapshot to address). */
  files: Array<{ path: string; hash: string; size: number; downloadLink: string | null }>;
  snapshots: Array<{ runId: string; snapshotId: string; manifestRevision: number; committedAtLabel: string; href: string }>;
  diff: DiffFormModel;
  /** The plan's page default: the newest bound snapshot is the pre-selected
   *  diff target, its default baseline pre-selected in `diff`. */
  hasSnapshots: boolean;
}

export function buildLoopArtifactsPageModel(input: {
  loopId: string;
  view: LoopArtifactsResponse;
  bound: ReadonlyArray<DashboardBoundSnapshotRef>;
  configToken: string | null;
}): LoopArtifactsPageModel {
  const { loopId, view, bound, configToken } = input;
  const newest = bound[0] ?? null;
  const defaultTo = newest?.snapshotId ?? "";
  const defaultBaselineRevision = newest === null ? null : defaultDiffBaseline(newest, bound);
  const defaultFrom =
    defaultBaselineRevision === null
      ? ""
      : (bound.find((s) => s.manifestRevision === defaultBaselineRevision)?.snapshotId ?? "");

  return {
    loopId,
    configAction: dashboardArtifactConfigPath(loopId),
    configBanner: configToken === null ? null : (CONFIG_BANNER_LABELS[configToken] ?? null),
    artifactDirLabel: view.artifactDir ?? ARTIFACT_UNCONFIGURED_TEXT,
    artifactDirValue: view.artifactDir ?? "",
    stale: view.stale,
    staleNotice: view.stale ? STALE_NOTICE_TEXT : null,
    manifestRevision: view.manifestRevision,
    committedAtLabel: formatUtc(view.committedAt),
    fileCountLabel: String(view.fileCount),
    totalBytesLabel: String(view.totalBytes),
    sync: {
      attemptedAtLabel: formatUtc(view.sync.attemptedAt),
      succeededAtLabel: formatUtc(view.sync.succeededAt),
      errorLabel: view.sync.error === null ? null : `${ARTIFACT_SYNC_ERROR_PREFIX}：${view.sync.error}`,
    },
    files: view.files.map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
      downloadLink: view.manifestId === null ? null : artifactDownloadLink(loopId, view.manifestId, f.path),
    })),
    snapshots: bound.map((s) => ({
      runId: s.runId,
      snapshotId: s.snapshotId,
      manifestRevision: s.manifestRevision,
      committedAtLabel: formatUtc(s.committedAt),
      href: dashboardRunArtifactsPath(loopId, s.runId),
    })),
    diff: buildDiffFormModel(loopId, bound, defaultFrom, defaultTo),
    hasSnapshots: bound.length > 0,
  };
}

/** The run-snapshot page: the bound snapshot's file table with per-file
 *  download links, or the explicit missing state. */
export interface RunArtifactsPageModel {
  loopId: string;
  runId: string;
  backPath: string;
  state: "bound" | "missing";
  snapshotId: string | null;
  manifestRevisionLabel: string;
  committedAtLabel: string;
  fileCountLabel: string;
  files: Array<{ path: string; hash: string; size: number; downloadLink: string | null }>;
}

export function buildRunArtifactsPageModel(input: {
  response: RunArtifactsResponse;
}): RunArtifactsPageModel {
  const { response } = input;
  const backPath = dashboardArtifactsPath(response.loopId);
  if (response.state === "missing") {
    return {
      loopId: response.loopId,
      runId: response.runId,
      backPath,
      state: "missing",
      snapshotId: null,
      manifestRevisionLabel: NONE_TEXT,
      committedAtLabel: NONE_TEXT,
      fileCountLabel: NONE_TEXT,
      files: [],
    };
  }
  return {
    loopId: response.loopId,
    runId: response.runId,
    backPath,
    state: "bound",
    snapshotId: response.snapshotId,
    manifestRevisionLabel: `r${response.manifestRevision}`,
    committedAtLabel: formatUtc(response.committedAt),
    fileCountLabel: String(response.fileCount),
    files: response.files.map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
      downloadLink: artifactDownloadLink(response.loopId, response.snapshotId, f.path),
    })),
  };
}

/** The diff result page: the three change classes, before/after hash+size
 *  only — no content preview, no text diff (the stop boundary). */
export interface ArtifactDiffPageModel {
  loopId: string;
  backPath: string;
  fromLabel: string;
  toLabel: string;
  empty: boolean;
  added: Array<{ path: string; hash: string; size: number }>;
  modified: Array<{ path: string; beforeHash: string; beforeSize: number; afterHash: string; afterSize: number }>;
  removed: Array<{ path: string; hash: string; size: number }>;
  diff: DiffFormModel;
}

export function buildArtifactDiffPageModel(input: {
  loopId: string;
  response: ArtifactDiffResponse;
  bound: ReadonlyArray<DashboardBoundSnapshotRef>;
  selectedFrom: string;
  selectedTo: string;
}): ArtifactDiffPageModel {
  const { loopId, response, bound, selectedFrom, selectedTo } = input;
  const refLabel = (ref: { manifestRevision: number } | null): string =>
    ref === null ? "（空集合）" : `r${ref.manifestRevision}`;
  return {
    loopId,
    backPath: dashboardArtifactsPath(loopId),
    fromLabel: refLabel(response.from),
    toLabel: refLabel(response.to),
    empty: response.added.length === 0 && response.modified.length === 0 && response.removed.length === 0,
    added: response.added,
    modified: response.modified,
    removed: response.removed,
    diff: buildDiffFormModel(loopId, bound, selectedFrom, selectedTo),
  };
}
