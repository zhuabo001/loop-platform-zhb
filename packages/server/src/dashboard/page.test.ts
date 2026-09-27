/**
 * The rendering half of the D-group: escaping, the fixed copy, UTC labelling,
 * and the two structural invariants slice 2 depends on (a CSS constant that
 * survives auto-escaping byte-for-byte, and a page with zero client-side JS).
 */
import { describe, expect, it } from "vitest";

import type { LoopSummary, RunSummary } from "@loopzhb/protocol";

import type { DashboardActiveRun, DashboardLoop, DashboardSnapshot } from "./index.js";
import { DASHBOARD_CSS, renderDashboardPage } from "./page.js";
import { buildDashboardPageModel, classifyDisplayLifecycle, formatUtc, NONE_TEXT } from "./view.js";

const iso = (seconds: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + seconds * 1000).toISOString();

function loopSummary(overrides: Partial<LoopSummary> & { id: string }): LoopSummary {
  const { id, ...rest } = overrides;
  return {
    id,
    machineId: "m-test",
    name: null,
    workdir: null,
    taskFile: null,
    agent: "claude-code",
    allowControl: true,
    enabled: true,
    createdAt: iso(0),
    updatedAt: iso(0),
    lastRun: null,
    cron: null,
    timezone: "UTC",
    nextFireAt: null,
    goal: null,
    completedAt: null,
    completionReason: null,
    taskFileSyncedAt: null,
    taskFileSyncAttemptedAt: null,
    taskFileSyncError: null,
    ...rest,
  };
}

function runSummary(overrides: Partial<RunSummary> & { id: string }): RunSummary {
  const { id, ...rest } = overrides;
  return {
    id,
    loopId: "loop-1",
    machineId: "m-test",
    phase: "done",
    role: "exec",
    ts: iso(0),
    outcome: null,
    status: null,
    message: null,
    error: null,
    durationMs: null,
    progress: null,
    ...rest,
  };
}

function dashLoop(loop: LoopSummary, extra: Partial<DashboardLoop> = {}): DashboardLoop {
  return { loop, lifecycle: "open", pending: [], running: [], terminalJournalV1: true, ...extra };
}

/** One in-flight Run, for the button-rule fixtures. */
function activity(phase: "pending" | "running", role: DashboardActiveRun["role"]): DashboardActiveRun {
  return { id: `run-${phase}`, role, phase, ts: iso(1), progress: null, message: null, error: null };
}

const TEST_CSRF = "test-csrf-token";

function render(loops: DashboardLoop[], listCap = 100): string {
  const snapshot: DashboardSnapshot = { generatedAt: iso(0), loops, listCap };
  return renderDashboardPage(buildDashboardPageModel(snapshot), { csrfToken: TEST_CSRF });
}

describe("formatUtc", () => {
  it("renders an explicit UTC label and degrades every missing value to 暂无", () => {
    expect(formatUtc(iso(0))).toBe("2026-07-01 00:00:00 UTC");
    expect(formatUtc(null)).toBe(NONE_TEXT);
    expect(formatUtc(undefined)).toBe(NONE_TEXT);
    expect(formatUtc("")).toBe(NONE_TEXT);
    expect(formatUtc("not-a-timestamp")).toBe(NONE_TEXT);
  });
});

describe("classifyDisplayLifecycle", () => {
  const base = { goal: null, completedAt: null, completionReason: null, enabled: true };

  it("applies the ADR-009 fixed priority and tolerates absent optional wire fields", () => {
    expect(classifyDisplayLifecycle(base)).toBe("open");
    expect(classifyDisplayLifecycle({ ...base, goal: "g" })).toBe("closed");
    expect(classifyDisplayLifecycle({ ...base, enabled: false })).toBe("paused");
    // Completed outranks Paused.
    expect(classifyDisplayLifecycle({ ...base, goal: "g", completedAt: iso(1), completionReason: "r", enabled: false })).toBe(
      "completed",
    );
    // A half-completion (impossible under the DB CHECK) must NOT read as Completed.
    expect(classifyDisplayLifecycle({ ...base, goal: "g", completedAt: iso(1), enabled: false })).toBe("paused");
    // Optional fields absent on the additive wire DTO.
    const legacy = { enabled: true } as Pick<LoopSummary, "goal" | "completedAt" | "completionReason" | "enabled">;
    expect(classifyDisplayLifecycle(legacy)).toBe("open");
    expect(classifyDisplayLifecycle({ ...legacy, goal: "g" })).toBe("closed");
  });
});

describe("DASHBOARD_CSS", () => {
  it("contains no HTML-escapable character, so interpolation is a byte-for-byte no-op", () => {
    // This is why the stylesheet needs no `raw()` escape hatch: the `html`
    // template escapes `& < > " '`, and none of them occur here.
    for (const ch of ["&", "<", ">", '"', "'"]) {
      expect(DASHBOARD_CSS).not.toContain(ch);
    }
  });

  it("is self-contained: no external URL, no import, single column with wrapping", () => {
    expect(DASHBOARD_CSS).not.toContain("url(");
    expect(DASHBOARD_CSS).not.toContain("@import");
    expect(DASHBOARD_CSS).toContain("grid-template-columns: 1fr");
    expect(DASHBOARD_CSS).toContain("overflow-wrap: anywhere");
  });

  it("reaches the page verbatim, inside exactly one style element", () => {
    const page = render([dashLoop(loopSummary({ id: "loop-1" }))]);
    expect(page).toContain(`<style>${DASHBOARD_CSS}</style>`);
    expect(page.match(/<style>/g)).toHaveLength(1);
  });
});

describe("renderDashboardPage", () => {
  it("renders a zero-JavaScript document that self-refreshes", () => {
    const page = render([dashLoop(loopSummary({ id: "loop-1" }))]);
    expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(page).toContain('<html lang="zh-CN">');
    expect(page).toContain('<meta http-equiv="refresh" content="3">');
    expect(page).not.toContain("<script");
    expect(page).not.toContain("javascript:");
    expect(page).not.toContain("onerror=");
  });

  it("explains the display range, and warns about possible truncation only when the page is full", () => {
    const one = render([dashLoop(loopSummary({ id: "loop-1" }))]);
    expect(one).toContain("最多 100 条，当前 1 条");
    expect(one).toContain("均为 UTC");
    expect(one).not.toContain("已达显示上限");

    const full = render(
      Array.from({ length: 100 }, (_, i) => dashLoop(loopSummary({ id: `loop-${i}` }))),
    );
    // A capped response cannot tell whether there is a 101st Loop, so this
    // remains deliberately conditional even when this fixture has exactly 100.
    expect(full).toContain("可能还有更早更新的 Loop 未显示");
  });

  it("renders the empty-list notice and no card", () => {
    const page = render([]);
    expect(page).toContain("暂无 Loop");
    expect(page).not.toContain('class="card"');
  });

  it("escapes every dynamic value instead of letting it reach the markup", () => {
    const page = render([
      dashLoop(
        loopSummary({
          id: "loop-1",
          name: `<script>alert("name")</script>`,
          goal: `目标 & <b>bold</b> 'quoted'`,
          taskFile: `/tmp/<img src=x onerror="alert(1)">.md`,
          completionReason: "<i>done</i>",
          lastRun: runSummary({
            id: "run-1",
            message: `<script>alert("message")</script>`,
            error: `err & "quoted"`,
          }),
        }),
        { lifecycle: "completed" },
      ),
    ]);

    // Nothing raw survives — no tag, no attribute break-out.
    expect(page).not.toContain("<script");
    expect(page).not.toContain("<b>");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<i>");
    expect(page).not.toContain('onerror="alert(1)"');
    // …and the text is present, escaped.
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("&amp;");
    expect(page).toContain("&#39;quoted&#39;");
    expect(page).toContain("目标 &amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  it("shows state as text and as a data attribute, never by colour alone", () => {
    const page = render([
      dashLoop(loopSummary({ id: "loop-open" }), { lifecycle: "open" }),
      dashLoop(loopSummary({ id: "loop-paused" }), { lifecycle: "paused" }),
      dashLoop(loopSummary({ id: "loop-closed", goal: "g" }), { lifecycle: "closed" }),
      dashLoop(loopSummary({ id: "loop-completed", goal: "g" }), { lifecycle: "completed" }),
    ]);
    for (const [code, label] of [
      ["open", "Open"],
      ["paused", "Paused"],
      ["closed", "Closed"],
      ["completed", "Completed"],
    ] as const) {
      expect(page).toContain(`data-lifecycle="${code}"`);
      expect(page).toContain(`>${label}</span>`);
    }
  });

  it("lists pending and running Runs in two labelled blocks", () => {
    const pending: DashboardActiveRun = {
      id: "run-p",
      role: "exec",
      phase: "pending",
      ts: iso(1),
      progress: { step: 1, label: "queued", at: null },
      message: null,
      error: null,
    };
    const running: DashboardActiveRun = {
      id: "run-r",
      role: "evolve",
      phase: "running",
      ts: iso(2),
      progress: { step: 3, label: "testing", at: iso(3) },
      message: "working",
      error: null,
    };
    const page = render([dashLoop(loopSummary({ id: "loop-1" }), { pending: [pending], running: [running] })]);

    expect(page).toContain("等待中 Run（Pending）");
    expect(page).toContain("运行中 Run（Running）");
    expect(page).toContain('data-phase="pending"');
    expect(page).toContain('data-phase="running"');
    expect(page).toContain("步骤 3：testing（2026-07-01 00:00:03 UTC）");
    // A pending run has no `at` stamp yet.
    expect(page).toContain(`步骤 1：queued（${NONE_TEXT}）`);
    expect(page).not.toContain("暂无活跃 Run");
  });

  it("renders exactly one Run Now form per card, with one named control", () => {
    const page = render([
      dashLoop(loopSummary({ id: "loop-1" })),
      dashLoop(loopSummary({ id: "loop-2" })),
    ]);

    expect(page.match(/<form /g)).toHaveLength(2);
    expect(page.match(/<form class="run-form" method="post" action="\/dashboard\/loops\/loop-1\/run">/g)).toHaveLength(1);
    expect(page).toContain(`<input type="hidden" name="csrf" value="${TEST_CSRF}">`);
    // An available card's bytes are exactly what they were before the disabled
    // rules existed — no stray attribute, no whitespace change.
    expect(page).toContain('<button type="submit">Run Now</button>');

    // The server rejects any submission carrying a field other than `csrf`
    // (400), so a NAMED submit button would break every real click, and a
    // second named input would break it just as silently. Exactly one named
    // control, and it is the token — `disabled` has no name, so it is free.
    const form = page.slice(page.indexOf("<form "), page.indexOf("</form>"));
    expect(form.match(/name="[^"]*"/g)).toEqual(['name="csrf"']);
    expect(form).not.toContain("<button type=\"submit\" name=");

    // Both cards are idle Open loops: available, and with no reason line.
    // (Assert on the MARKUP, not the page: `run-note` also names a CSS rule.)
    expect(page.match(/<button type="submit" disabled>/g)).toBeNull();
    expect(page).not.toContain('<p class="run-note">');
  });

  it("disables the button for Completed / Pending / Running, with the reason as text", () => {
    const page = render([
      dashLoop(loopSummary({ id: "idle" })),
      // Paused-but-not-completed with no active run: a manual trigger
      // deliberately bypasses enablement, so this MUST stay available.
      dashLoop(loopSummary({ id: "paused", enabled: false }), { lifecycle: "paused" }),
      dashLoop(
        loopSummary({ id: "completed", goal: "g", completedAt: iso(9), completionReason: "done", enabled: false }),
        { lifecycle: "completed" },
      ),
      dashLoop(loopSummary({ id: "queued" }), {
        pending: [activity("pending", "exec")],
      }),
      dashLoop(loopSummary({ id: "busy" }), {
        running: [activity("running", "exec")],
      }),
    ]);

    const button = (loopId: string): string => {
      const form = page.slice(page.indexOf(`action="/dashboard/loops/${loopId}/run"`));
      const open = form.indexOf("<button");
      return form.slice(open, form.indexOf("</button>", open) + "</button>".length);
    };

    expect(button("idle")).toBe('<button type="submit">Run Now</button>');
    expect(button("paused")).toBe('<button type="submit">Run Now</button>');
    for (const id of ["completed", "queued", "busy"]) {
      expect([id, button(id)]).toEqual([id, '<button type="submit" disabled>Run Now</button>']);
    }

    // The reason is rendered TEXT, so a disabled control never depends on
    // colour alone — and the CSS `:disabled` rule must not be the only signal.
    expect(page).toContain("Loop 已完成（Completed），Run Now 会被拒绝。");
    expect(page).toContain("已有 Pending Run，等待执行。");
    expect(page).toContain("已有 Running Run，避免重复触发。");
    // The reason is visible text inside a <p>, never an attribute.
    expect(page).toContain('<p class="run-note">');
    expect(page).not.toContain('title="');
  });

  it("keeps the Completed reason ahead of an active run, and never adds a second named control", () => {
    // A late running Run can outlive completion (slice 1 keeps lifecycle and
    // activity independent) — the precedence must match the backend's check
    // order: completed (pre-transaction) > running > pending.
    const page = render([
      dashLoop(
        loopSummary({ id: "late", goal: "g", completedAt: iso(9), completionReason: "done", enabled: false }),
        {
          lifecycle: "completed",
          running: [activity("running", "exec")],
          pending: [activity("pending", "exec")],
        },
      ),
    ]);

    expect(page).toContain("Loop 已完成（Completed），Run Now 会被拒绝。");
    expect(page).not.toContain("已有 Running Run");

    // Even disabled, the form still carries exactly the one named control: the
    // server would 400 any extra field, disabled or not.
    const form = page.slice(page.indexOf("<form "), page.indexOf("</form>"));
    expect(form.match(/name="[^"]*"/g)).toEqual(['name="csrf"']);
    expect(form).toContain('<button type="submit" disabled>Run Now</button>');
  });

  it("percent-encodes the loop id in the action and pins that no style attribute exists", () => {
    const hostileId = `a"/><script>alert(1)</script>`;
    const page = render([dashLoop(loopSummary({ id: hostileId }))]);

    const action = page.match(/action="([^"]*)"/)?.[1];
    expect(action).toBe(`/dashboard/loops/${encodeURIComponent(hostileId)}/run`);
    // No raw quote or angle bracket survives inside the attribute…
    expect(action).not.toContain('"');
    expect(action).not.toContain("<");
    // …and the id is still visible as escaped TEXT in the card head.
    expect(page).toContain("&lt;script&gt;");

    // CSP hashes never cover `style="..."` attributes (that needs
    // 'unsafe-hashes'), so the page must not use any.
    expect(page).not.toContain("style=");
  });

  it("explains an absence of active Runs and of the capability, with wrap-safe text", () => {
    const page = render([dashLoop(loopSummary({ id: "loop-1" }), { terminalJournalV1: false })]);
    expect(page).toContain("暂无活跃 Run");
    expect(page).toContain("terminal-journal-v1");
    expect(page).toContain("请升级 daemon");
    // Long paths and messages must be allowed to wrap.
    expect(page).toContain('class="wrap"');
  });
});
