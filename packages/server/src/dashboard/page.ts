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
import type { DashboardPageModel, LoopActivityLine, LoopCard, LoopLastRunView } from "./view.js";
import { NONE_TEXT } from "./view.js";

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
@media (max-width: 640px) {
  .fields dt { min-width: 0; }
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
