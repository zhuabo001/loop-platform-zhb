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
import type { LoopSummary, RunRole, RunSummary, TaskFileSyncError } from "@loopzhb/protocol";

import type { DashboardActiveRun, DashboardLoop, DashboardSnapshot, LoopLifecycle } from "./index.js";

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
  /** The Run Now form action. Slice 2 renders the button ALWAYS ENABLED: the
   *  disabled rules and the atomic no-supersede policy land in slice 3, so the
   *  backend rule and the button rule ship together (batch plan §3). */
  runAction: string;
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

  return {
    id: loop.id,
    machineId: loop.machineId,
    runAction: dashboardRunAction(loop.id),
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
