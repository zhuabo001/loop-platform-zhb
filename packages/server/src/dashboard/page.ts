/**
 * The Dashboard SSR template: `hono/html` tagged templates, server-rendered,
 * ZERO client-side JavaScript (no `<script>` anywhere, by plan §1/§2).
 *
 * Every dynamic value goes through `${...}` interpolation, which escapes
 * `& < > " '` — so a Loop name, goal, path, message or run error containing
 * markup is rendered as text, in text and attribute position alike. `raw()`
 * is never called. The one interactive control is the Run Now form (the CSRF
 * token rides in a hidden field; the action is a percent-encoded path).
 *
 * `DASHBOARD_CSS` is a frozen constant with TWO invariants, both pinned by
 * tests in page.test.ts:
 *  1. it contains no `& < > " '`, so auto-escaping is a byte-for-byte no-op
 *     (this is why the stylesheet needs no `raw()` escape hatch), and
 *  2. it is a compile-time literal, so slice 2 can authorize the single inline
 *     `<style>` by a stable content SHA-256 without `unsafe-inline`.
 * Changing the stylesheet means re-deriving that hash — deliberately so.
 */
import { html } from "hono/html";

import { CSRF_FIELD } from "./csrf.js";
import type {
  ArtifactDiffPageModel,
  DashboardPageModel,
  DiffSelectOption,
  LoopActivityLine,
  LoopArtifactsPageModel,
  LoopCard,
  LoopLastRunView,
  RunArtifactsPageModel,
} from "./view.js";
import { ARTIFACT_DIR_FIELD, NONE_TEXT } from "./view.js";

export const DASHBOARD_CSS = `:root {
  color-scheme: light dark;
  --fg: #16181d;
  --muted: #5b6472;
  --bg: #f6f7f9;
  --card: #ffffff;
  --line: #d8dee7;
  --warn-bg: #fff6e5;
  --warn-line: #d9a441;
  --warn-fg: #6b4708;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6e9ef;
    --muted: #9aa4b2;
    --bg: #14161a;
    --card: #1c1f26;
    --line: #2e3440;
    --warn-bg: #3a2f14;
    --warn-line: #d9a441;
    --warn-fg: #f2d9a0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 16px 48px;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}
header, main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0; }
.meta { margin: 0 0 4px; color: var(--muted); }
.warn {
  margin: 8px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--warn-line);
  border-radius: 6px;
  background: var(--warn-bg);
  color: var(--warn-fg);
}
.empty { margin: 24px 0; color: var(--muted); }
.loops { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: 1fr; gap: 16px; }
.card { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 16px; }
.card-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.id { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.tag { display: inline-block; padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; }
.fields { display: grid; grid-template-columns: 1fr; gap: 2px 16px; margin: 12px 0 0; }
.fields div { display: flex; flex-wrap: wrap; gap: 0 8px; }
.fields dt { color: var(--muted); min-width: 10em; }
.fields dd { margin: 0; }
.wrap { overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
.runs { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.run { border-left: 3px solid var(--line); padding: 4px 0 4px 10px; }
.run-pending { border-left-color: #7a8699; }
.run-running { border-left-color: #2f7d4f; }
.run-head { display: flex; flex-wrap: wrap; gap: 0 8px; }
.run-form { margin: 12px 0 0; }
.run-form button { font: inherit; padding: 4px 14px; cursor: pointer; }
.run-form button:disabled { cursor: not-allowed; opacity: 0.6; }
.run-note { margin: 6px 0 0; color: var(--muted); }
.back { margin: 0 0 12px; }
.config-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 0; }
.config-form input[type=text] { font: inherit; padding: 4px 8px; min-width: 24em; }
.config-form button, .diff-form button { font: inherit; padding: 4px 14px; cursor: pointer; }
.config-hint { margin: 4px 0 0; color: var(--muted); }
.diff-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 0; }
.diff-form select { font: inherit; }
table.files { width: 100%; margin: 12px 0 0; border-collapse: collapse; }
table.files th, table.files td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.files th { color: var(--muted); font-weight: normal; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.diff-added { color: #2f7d4f; }
.diff-removed { color: #b3261e; }
@media (max-width: 640px) {
  .fields dt { min-width: 0; }
  .config-form input[type=text] { min-width: 0; width: 100%; }
}
`;

function field(term: string, value: unknown, wrap = false) {
  if (!wrap) return html`<div><dt>${term}</dt><dd>${value}</dd></div>`;
  return html`<div><dt>${term}</dt><dd class="wrap">${value}</dd></div>`;
}

function activityLine(line: LoopActivityLine) {
  return html`<li class="run run-${line.phase}" data-phase="${line.phase}">
<div class="run-head"><strong>${line.phaseLabel}</strong><span class="tag">${line.role}</span><span>最近状态变更：${line.transitionLabel}</span></div>
<div class="wrap">进度：${line.progressLabel}</div>
<div class="wrap">message：${line.messageLabel}</div>
<div class="wrap">error：${line.errorLabel}</div>
</li>`;
}

function lastRunBlock(lastRun: LoopLastRunView | null) {
  if (lastRun === null) {
    return html`<div><dt>最新 exec Run</dt><dd>${NONE_TEXT}</dd></div>`;
  }
  return html`<div><dt>最新 exec Run</dt><dd>
<span class="tag">${lastRun.phase}</span>
<span>status：${lastRun.statusLabel}</span>
<span>最近状态变更：${lastRun.transitionLabel}</span>
</dd></div>
<div><dt>最新 exec Run message</dt><dd class="wrap">${lastRun.messageLabel}</dd></div>
<div><dt>最新 exec Run error</dt><dd class="wrap">${lastRun.errorLabel}</dd></div>`;
}

/** The ONLY interactive control on the page (roadmap: one button). The form
 *  carries exactly ONE named control — the hidden token — because the server
 *  rejects any submission with a field other than `csrf` (400). A named submit
 *  button would therefore break every real click; page.test.ts pins that.
 *
 *  The disabled state (Batch 3 切片三) rides the button ATTRIBUTE, not a hidden
 *  field: the rule is advisory, the backend's `pendingPolicy: "skip"` is the
 *  authority. The reason is rendered as text so a disabled control is never
 *  signalled by colour alone — and `lifecycle`/`pending`/`running` are all the
 *  view model needs, so the template stays dumb. An enabled card's bytes are
 *  unchanged from before this existed. */
function runForm(item: LoopCard, csrfToken: string) {
  return html`<form class="run-form" method="post" action="${item.runAction}">
<input type="hidden" name="${CSRF_FIELD}" value="${csrfToken}">
<button type="submit"${item.runDisabled ? html` disabled` : ""}>Run Now</button>
</form>
${item.runDisabledReason === null ? "" : html`<p class="run-note">${item.runDisabledReason}</p>`}`;
}

function card(item: LoopCard, csrfToken: string) {
  return html`<li class="card" data-lifecycle="${item.lifecycle}">
<div class="card-head">
<h2 class="wrap">${item.nameLabel}</h2>
<span class="tag" data-lifecycle="${item.lifecycle}">${item.lifecycleLabel}</span>
<span class="tag">${item.typeLabel}</span>
<span class="id wrap">${item.id}</span>
</div>
<dl class="fields">
${field("机器", item.machineId)}
${field("Goal", item.goalLabel, true)}
${field("Cron", item.scheduleLabel, true)}
${field("时区", item.timezone)}
${field("下次触发", item.nextFireAtLabel)}
${field("Task File", item.taskFilePathLabel, true)}
${field("最近成功同步", item.taskFileSyncedAtLabel)}
${field("最近失败尝试", item.taskFileFailedAtLabel)}
${item.taskFileErrorLabel === null ? "" : field("同步告警", item.taskFileErrorLabel, true)}
${lastRunBlock(item.lastRun)}
${field("完成原因", item.completionReasonLabel, true)}
</dl>
${item.pending.length === 0 ? "" : html`<ul class="runs"><li><strong>等待中 Run（Pending）</strong></li>${item.pending.map(activityLine)}</ul>`}
${item.running.length === 0 ? "" : html`<ul class="runs"><li><strong>运行中 Run（Running）</strong></li>${item.running.map(activityLine)}</ul>`}
${item.pending.length === 0 && item.running.length === 0 ? html`<p class="meta">暂无活跃 Run。</p>` : ""}
${item.capabilityWarning === null ? "" : html`<p class="warn">${item.capabilityWarning}</p>`}
${runForm(item, csrfToken)}
</li>`;
}

/** The CSRF token is a REQUIRED argument with no default: a defaulted token
 *  would be a silent failure mode, and the caller (routes.ts) is the only
 *  place that legitimately holds it. */
export interface DashboardPageOptions {
  csrfToken: string;
}

export function renderDashboardPage(model: DashboardPageModel, options: DashboardPageOptions): string {
  const { csrfToken } = options;
  const page = html`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>Loop Dashboard</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header>
<h1>Loop Dashboard</h1>
<p class="meta">页面生成时间：${model.generatedAtLabel}</p>
<p class="meta">${model.rangeNotice}</p>
${model.truncationNotice === null ? "" : html`<p class="warn">${model.truncationNotice}</p>`}
</header>
<main>
${model.emptyNotice === null ? "" : html`<p class="empty">${model.emptyNotice}</p>`}
<ul class="loops">
${model.loops.map((item) => card(item, csrfToken))}
</ul>
</main>
</body>
</html>`;

  // The template is synchronous by construction (no Promise or callback is
  // ever interpolated). Fail loudly rather than render "[object Promise]" —
  // this page is CSP-hashed and security-relevant, so a silent shape change
  // must not reach a browser. (Note `html` yields a `String` OBJECT, not a
  // primitive, so this is an instanceof check rather than a typeof one.)
  if (page instanceof Promise) throw new Error("dashboard template must render synchronously");
  return page.toString();
}

// ---- slice 7 artifact pages (ADR-010 决策 27) ----
// Sibling render functions: the frozen index-page template above is untouched.
// Same contract — zero client JS, escape-by-interpolation only (raw() never),
// synchronous render guarded loudly. These pages carry NO meta refresh: they
// hold a form a refresh would wipe.


/** The shared shell: head, inline (CSP-hashed) stylesheet, header, main.
 *  Every dynamic value is interpolated — escaped in text and attribute
 *  position alike. */
function artifactPageShell(title: string, body: unknown): string {
  const page = html`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header>
<h1>${title}</h1>
<p class="back"><a href="/">← 返回 Dashboard</a></p>
</header>
<main>
${body}
</main>
</body>
</html>`;
  if (page instanceof Promise) throw new Error("dashboard template must render synchronously");
  return page.toString();
}

function fileTable(files: LoopArtifactsPageModel["files"] | RunArtifactsPageModel["files"]) {
  if (files.length === 0) return html`<p class="meta">暂无文件。</p>`;
  return html`<table class="files">
<thead><tr><th>路径</th><th>大小（字节）</th><th>SHA-256</th><th>下载</th></tr></thead>
<tbody>
${files.map(
  (f) => html`<tr>
<td class="wrap">${f.path}</td>
<td>${f.size}</td>
<td class="mono wrap">${f.hash}</td>
<td>${f.downloadLink === null ? NONE_TEXT : html`<a href="${f.downloadLink}">下载</a>`}</td>
</tr>`,
)}
</tbody>
</table>`;
}

function configForm(model: LoopArtifactsPageModel, csrfToken: string) {
  return html`<form class="config-form" method="post" action="${model.configAction}">
<input type="hidden" name="${CSRF_FIELD}" value="${csrfToken}">
<label>Artifact 目录 <input type="text" name="${ARTIFACT_DIR_FIELD}" value="${model.artifactDirValue}"></label>
<button type="submit">保存</button>
</form>
<p class="config-hint">留空并保存 = 清除配置；相对路径仅在 Loop 配置 workdir 时合法。</p>
${model.configBanner === null ? "" : html`<p class="warn">${model.configBanner}</p>`}`;
}

function diffOption(option: DiffSelectOption) {
  return html`<option value="${option.value}"${option.selected ? html` selected` : ""}>${option.label}</option>`;
}

function diffForm(diff: { action: string; fromOptions: DiffSelectOption[]; toOptions: DiffSelectOption[] }) {
  return html`<form class="diff-form" method="get" action="${diff.action}">
<label>基线 <select name="from">${diff.fromOptions.map(diffOption)}</select></label>
<label>目标 <select name="to">${diff.toOptions.map(diffOption)}</select></label>
<button type="submit">比较</button>
</form>
<p class="config-hint">结构 diff 只显示新增／修改／删除与前后 hash、大小，不含文件内容。</p>`;
}

function snapshotTable(model: LoopArtifactsPageModel) {
  if (!model.hasSnapshots) return html`<p class="meta">尚无已绑定快照的 Run。</p>`;
  return html`<table class="files">
<thead><tr><th>Run</th><th>快照</th><th>提交时间</th><th>操作</th></tr></thead>
<tbody>
${model.snapshots.map(
  (s) => html`<tr>
<td class="mono wrap">${s.runId}</td>
<td>r${s.manifestRevision}</td>
<td>${s.committedAtLabel}</td>
<td><a href="${s.href}">查看快照文件</a></td>
</tr>`,
)}
</tbody>
</table>`;
}

export function renderLoopArtifactsPage(model: LoopArtifactsPageModel, options: DashboardPageOptions): string {
  const { csrfToken } = options;
  const body = html`<section class="card">
<h2>配置</h2>
<dl class="fields">
${field("Loop", model.loopId)}
${field("当前目录", model.artifactDirLabel, true)}
${field("当前视图", `r${model.manifestRevision} · ${model.fileCountLabel} 个文件 · ${model.totalBytesLabel} 字节 · 提交于 ${model.committedAtLabel}`)}
${field("最近同步尝试", model.sync.attemptedAtLabel)}
${field("最近同步成功", model.sync.succeededAtLabel)}
${model.sync.errorLabel === null ? "" : field("同步状态", model.sync.errorLabel, true)}
</dl>
${model.staleNotice === null ? "" : html`<p class="warn">${model.staleNotice}</p>`}
${configForm(model, csrfToken)}
</section>
<section class="card">
<h2>当前文件视图</h2>
${fileTable(model.files)}
</section>
<section class="card">
<h2>Run 快照</h2>
${snapshotTable(model)}
</section>
<section class="card">
<h2>结构 diff</h2>
${diffForm(model.diff)}`;
  return artifactPageShell(`Loop ${model.loopId} · Artifact`, body);
}

export function renderRunArtifactsPage(model: RunArtifactsPageModel): string {
  const body =
    model.state === "missing"
      ? html`<p class="empty">该 Run 未绑定 Artifact 快照（未配置同步，或该次 Run 未携带快照）。</p>`
      : html`<dl class="fields">
${field("Run", model.runId)}
${field("快照", `${model.snapshotId}（${model.manifestRevisionLabel} · ${model.fileCountLabel} 个文件 · 提交于 ${model.committedAtLabel}）`)}
</dl>
${fileTable(model.files)}`;
  return artifactPageShell(`Run ${model.runId} · Artifact 快照`, body);
}

export function renderArtifactDiffPage(model: ArtifactDiffPageModel): string {
  const body = html`<p class="meta">${model.fromLabel} → ${model.toLabel}</p>
${model.empty ? html`<p class="empty">两个快照之间没有结构变化。</p>` : ""}
${model.added.length === 0 ? "" : html`<h2>新增（${model.added.length}）</h2>
<table class="files"><thead><tr><th>路径</th><th>SHA-256</th><th>大小（字节）</th></tr></thead><tbody>
${model.added.map((e) => html`<tr class="diff-added"><td class="wrap">${e.path}</td><td class="mono wrap">${e.hash}</td><td>${e.size}</td></tr>`)}
</tbody></table>`}
${model.modified.length === 0 ? "" : html`<h2>修改（${model.modified.length}）</h2>
<table class="files"><thead><tr><th>路径</th><th>前 SHA-256</th><th>前大小</th><th>后 SHA-256</th><th>后大小</th></tr></thead><tbody>
${model.modified.map((e) => html`<tr><td class="wrap">${e.path}</td><td class="mono wrap">${e.beforeHash}</td><td>${e.beforeSize}</td><td class="mono wrap">${e.afterHash}</td><td>${e.afterSize}</td></tr>`)}
</tbody></table>`}
${model.removed.length === 0 ? "" : html`<h2>删除（${model.removed.length}）</h2>
<table class="files"><thead><tr><th>路径</th><th>SHA-256</th><th>大小（字节）</th></tr></thead><tbody>
${model.removed.map((e) => html`<tr class="diff-removed"><td class="wrap">${e.path}</td><td class="mono wrap">${e.hash}</td><td>${e.size}</td></tr>`)}
</tbody></table>`}
<section class="card">
<h2>重新比较</h2>
${diffForm(model.diff)}
</section>`;
  return artifactPageShell(`Loop ${model.loopId} · 结构 diff`, body);
}

/** The fixed-string error page for artifact read failures (404/403). The
 *  message is one of the module's own constants — never failure detail from
 *  the domain. */
export function renderDashboardErrorPage(title: string, message: string): string {
  return artifactPageShell(title, html`<p class="empty">${message}</p>`);
}
