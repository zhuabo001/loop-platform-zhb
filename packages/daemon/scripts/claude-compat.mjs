/**
 * Claude Runner sandbox-compat diagnostic driver (Issue #50, plan
 * `docs/plan/codex-fix-claude-sandbox-compat-plan.md` §2 — Phase 1).
 *
 * One invocation = ONE real Claude call of ONE experiment variant:
 *
 *   A  production baseline — no change (OpenSSL abort / cwd EPERM still
 *      reproduce on this exact binary+OS?)
 *   B  run temp dir      — a private short canonical tmp root is minted and
 *      injected as CLAUDE_CODE_TMPDIR plus precise allowRead/allowWrite
 *      grants (do the per-command `cwd-*` dirs migrate and does Bash status
 *      become accurate?)
 *   C  wrapper launch    — the `loopzhb` entry is replaced by a thin shell
 *      launcher `exec <canonical node> --openssl-config=<empty cfg> <bundle>`
 *      (does Node start under the seatbelt profile and write a valid record?)
 *   D  combined          — B and C together (one-shot success, no retries?)
 *
 * The variants exist ONLY in this helper: production code gains no switches.
 * B/D apply their delta through the runner's documented TEST-ONLY `spawnImpl`
 * seam (the same standing as SpawnOptions.killImpl); C/D rebuild the control
 * root's wrapper entry in-place after createControlRoot verified the bundle
 * digest. Everything else is the untouched production path: provider
 * bootstrap (resolveClaudeProviderEnv), probe-pinned binary identity,
 * createClaudeRunner, the static wrapper bundle and spawnWithTimeout's
 * process-group reaping.
 *
 * Budget (plan §1): at most 8 real calls / ~90 min / a $3 cumulative cost
 * TARGET across the whole matrix. The cumulative ledger lives in the
 * evidence dir and blocks a new call once the target is reached. Each call
 * is capped at 180s. When a completed Claude conversation reports NO cost,
 * the driver refuses further paid experiments (exit 3) — cost that cannot
 * be observed cannot be budgeted.
 *
 * Evidence (plan §2): one redacted JSON per run in the persistent evidence
 * dir (default ~/loopzhb-compat-evidence, NEVER /tmp): config summary,
 * binary identity, the actual Bash inputs/results extracted from the
 * stream-json capture, file side effects, the journal verdict, duration and
 * cost. Raw credentials and unredacted transcripts are never written.
 *
 * Usage:
 *   LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved hash> \
 *     pnpm test:claude:compat --variant A
 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectSecretValues, redactSecrets } from "../dist/agent-env.js";
import { resolveClaudeProviderEnv } from "../dist/claude-provider-env.js";
import { createClaudeRunner } from "../dist/claude-runner.js";
import { createControlRoot, releaseControlRoot } from "../dist/control-root.js";
import { createWorkdirJail } from "../dist/jail.js";
import { probeClaudeBinary } from "../dist/probe-claude.js";
import { spawnWithTimeout } from "../dist/subprocess.js";
import { WRAPPER_BUNDLE_FILE, WRAPPER_BUNDLE_SHA256 } from "../dist/wrapper-artifact.generated.js";

const CALL_TIMEOUT_MS = 180_000;
const COST_TARGET_USD = 3.0;
const LEDGER_FILE = "spend-ledger.json";

const VARIANTS = new Set(["A", "B", "C", "D", "R"]);

function parseArgs(argv) {
  const out = { variant: undefined, evidenceDir: path.join(os.homedir(), "loopzhb-compat-evidence") };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue; // pnpm may forward a bare separator
    if (token === "--variant") out.variant = argv[++i];
    else if (token === "--evidence-dir") out.evidenceDir = argv[++i];
    else throw new Error(`unknown argument: ${token}`);
  }
  if (out.variant === undefined || !VARIANTS.has(out.variant)) {
    throw new Error("usage: claude-compat.mjs --variant A|B|C|D|R [--evidence-dir <path>]");
  }
  return out;
}

async function readLedger(evidenceDir) {
  try {
    const rows = JSON.parse(await fs.readFile(path.join(evidenceDir, LEDGER_FILE), "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** The variant-C/D launcher (macOS-26 corrected form): a tiny ESM file whose
 *  shebang names the CANONICAL Node binary directly and carries
 *  `--openssl-config=<readonly cfg>` as the kernel's single shebang argument
 *  (no spaces tolerated — paths are daemon-generated and verified here), then
 *  imports the digest-verified bundle. A `#!/bin/sh` script does NOT work:
 *  the seatbelt profile denyReads `/`, which blocks the script interpreter
 *  `/bin/sh` → `/private/var/select/sh` (observed in variant C attempt 1);
 *  a direct Mach-O interpreter needs only execute permission. */
function buildLauncher(nodePath, configPath) {
  for (const p of [nodePath, configPath]) {
    if (typeof p !== "string" || !path.isAbsolute(p) || /[\s"'\\]/.test(p)) {
      throw new Error("launcher paths must be absolute and free of whitespace/quotes (single kernel shebang argument)");
    }
  }
  return `#!${nodePath} --openssl-config=${configPath}\nimport "./loopzhb-bundle.mjs";\n`;
}

/** Extract the observable Bash traffic from the captured stream-json. */
function analyzeStream(stdoutText) {
  const bashCalls = [];
  const toolResults = [];
  let terminal = null;
  for (const line of stdoutText.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "tool_use" && block.name === "Bash") {
          bashCalls.push(String(block.input?.command ?? ""));
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "tool_result") {
          const content = block.content;
          const text =
            typeof content === "string"
              ? content
              : (content ?? [])
                  .filter((part) => part?.type === "text")
                  .map((part) => part.text)
                  .join("\n");
          toolResults.push({ isError: block.is_error === true, preview: text.slice(0, 300) });
        }
      }
    } else if (event.type === "result") {
      terminal = event;
    }
  }
  return { bashCalls, toolResults, terminal };
}

async function main() {
  const { variant, evidenceDir } = parseArgs(process.argv.slice(2));
  const expectedSha = process.env.LOOPZHB_EXPECTED_CLAUDE_SHA256;
  if (expectedSha === undefined || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error("LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved sha256> is required (operator-pinned binary identity)");
  }
  const claudeBin = process.env.LOOPZHB_CLAUDE_BIN ?? "claude";

  await fs.mkdir(evidenceDir, { recursive: true });
  const ledger = await readLedger(evidenceDir);
  const spent = ledger.reduce((sum, row) => sum + (typeof row.usd === "number" ? row.usd : 0), 0);
  if (spent >= COST_TARGET_USD) {
    console.error(`budget target reached ($${spent.toFixed(4)} >= $${COST_TARGET_USD}) — no further paid experiments`);
    process.exit(3);
  }

  // Production startup sequence, unchanged: provider bootstrap THEN probe.
  const envSource = resolveClaudeProviderEnv(process.env);
  const probe = await probeClaudeBinary(claudeBin, process.env);
  if (probe.binary.sha256 !== expectedSha) {
    throw new Error(
      `claude binary sha256 ${probe.binary.sha256} does not match the operator-approved LOOPZHB_EXPECTED_CLAUDE_SHA256`,
    );
  }

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const runId = `compat-${variant}-${stamp}`;
  // The workdir lives INSIDE the evidence dir so agent file side effects
  // persist after the run as evidence (a scratch cwd would be released).
  const workRoot = await fs.realpath(await fs.mkdtemp(path.join(evidenceDir, `work-${variant}-`)));
  const taskFilePath = path.join(workRoot, "TASK.md");
  // Variant R (plan §4.3): REAL refusal checks on the final production path —
  // an escape write to the un-granted shared temp parent and a tamper append
  // to the read-only wrapper must both be DENIED, alongside the standard
  // success/failure/journal probes.
  const specLines =
    variant === "R"
      ? [
          "## Spec",
          "Run exactly these five commands, in this order, each exactly once:",
          "",
          "1. `echo compat-ok > compat-ok.txt`",
          "2. `cat no-such-compat-file.txt` — EXPECTED to fail; do NOT retry it.",
          "3. `echo escape > /private/tmp/loopzhb-escape-attempt.txt` — EXPECTED to be denied; do NOT retry and do NOT try alternatives.",
          '4. `echo tamper >> "$(command -v loopzhb)"` — EXPECTED to be denied; do NOT retry and do NOT try alternatives.',
          `5. \`loopzhb report --status nothing-new --message "compat R done"\``,
          "",
          "No other commands. No retries. If a command fails, note the failure and",
          "move IMMEDIATELY to the next step — never investigate or diagnose a failure.",
        ]
      : [
          "## Spec",
          "Run exactly these three commands, in this order, each exactly once:",
          "",
          "1. `echo compat-ok > compat-ok.txt`",
          "2. `cat no-such-compat-file.txt` — this is EXPECTED to fail; do NOT retry it and do NOT try alternatives.",
          `3. \`loopzhb report --status nothing-new --message "compat ${variant} done"\``,
          "",
          "No other commands. No retries. If a command fails, note the failure and",
          "move IMMEDIATELY to the next step — never investigate or diagnose a failure.",
        ];
  await fs.writeFile(
    taskFilePath,
    [
      `# Compat probe ${variant}`,
      "",
      ...specLines,
      "",
      "## Current understanding",
      "Nothing has run yet.",
      "",
      "## Timeline",
      "(empty)",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const ESCAPE_PROBE = "/private/tmp/loopzhb-escape-attempt.txt";
  if (variant === "R") await fs.rm(ESCAPE_PROBE, { force: true });

  const scratchBase = await fs.mkdtemp(path.join(os.tmpdir(), "lzc-scratch-"));
  const controlBase = await fs.mkdtemp(path.join(os.tmpdir(), "lzc-control-"));
  const jail = await createWorkdirJail({ allowedRoots: [workRoot], scratchBase });
  const controlRoot = await createControlRoot(controlBase);

  // Variant B/D: the private short canonical run temp root (plan §3 每 Run
  // 的临时文件能力, diagnostic form — macOS mints under canonical
  // /private/tmp with a short prefix, 0700, credential-free name).
  let runTmpRoot = null;
  if (variant === "B" || variant === "D") {
    runTmpRoot = await fs.mkdtemp(path.join("/private/tmp", "lzc-"));
    await fs.chmod(runTmpRoot, 0o700);
  }

  // Variant C/D: rebuild the wrapper entry as the thin launcher around the
  // digest-verified bundle (plan §3 Wrapper 启动依赖, diagnostic form). The
  // bundle bytes come from the digest-pinned install artifact — the minted
  // wrapperPath itself is 0500 (execute-only) by design.
  if (variant === "C" || variant === "D") {
    const bundle = await fs.readFile(new URL(`../dist/${WRAPPER_BUNDLE_FILE}`, import.meta.url));
    const digest = createHash("sha256").update(bundle).digest("hex");
    if (digest !== WRAPPER_BUNDLE_SHA256) {
      throw new Error("wrapper bundle digest mismatch — rebuild @loopzhb/daemon");
    }
    const bundlePath = path.join(controlRoot.wrapperDir, WRAPPER_BUNDLE_FILE);
    const configPath = path.join(controlRoot.wrapperDir, "openssl.cnf");
    await fs.writeFile(bundlePath, bundle, { mode: 0o400 });
    await fs.chmod(bundlePath, 0o400);
    await fs.writeFile(configPath, "", { mode: 0o400 });
    await fs.chmod(configPath, 0o400);
    // The minted entry is 0500 — replace, don't overwrite.
    await fs.rm(controlRoot.wrapperPath);
    await fs.writeFile(controlRoot.wrapperPath, buildLauncher(controlRoot.nodePath, configPath), {
      mode: 0o500,
    });
    await fs.chmod(controlRoot.wrapperPath, 0o500);
  }

  const redact = (text) => redactSecrets(text, [...collectSecretValues(envSource), "compat-local-run-token"]);
  let capturedStdout = "";
  let capturedStderr = "";
  // Variant R: the wrapper entry's content is captured for a post-run
  // integrity comparison (read by the owner — 0500 carries the read bit).
  const wrapperBefore = variant === "R" ? await fs.readFile(controlRoot.wrapperPath, "utf8") : null;

  // The ONLY variant injection point: the runner's documented test-only
  // spawn seam. B/D add the run temp root to the child env AND the sandbox
  // profile; every variant captures stdout/stderr for evidence.
  const spawnImpl = async (options) => {
    let next = {
      ...options,
      onStdout: (chunk) => {
        capturedStdout += chunk;
        options.onStdout(chunk);
      },
    };
    if (runTmpRoot !== null) {
      const args = [...next.args];
      const flagIndex = args.indexOf("--settings");
      const settings = JSON.parse(args[flagIndex + 1]);
      settings.sandbox.filesystem.allowRead.push(runTmpRoot);
      settings.sandbox.filesystem.allowWrite.push(runTmpRoot);
      args[flagIndex + 1] = JSON.stringify(settings);
      next = { ...next, args, env: { ...next.env, CLAUDE_CODE_TMPDIR: runTmpRoot } };
    }
    const result = await spawnWithTimeout(next);
    capturedStderr = result.stderr;
    return result;
  };

  const runner = createClaudeRunner({
    jail,
    claudeBin,
    timeoutMs: CALL_TIMEOUT_MS,
    envSource,
    controlRoot,
    probedBinary: probe.binary,
    spawnImpl,
  });
  const delivery = {
    runId,
    runToken: "compat-local-run-token",
    role: "exec",
    loop: {
      id: "compat-loop",
      name: "compat",
      workdir: workRoot,
      taskFile: taskFilePath,
      workflow: null,
      model: null,
      allowControl: false,
      agent: "claude-code",
      goal: null,
    },
    prevState: null,
    roots: [workRoot],
    systemPrompt: "",
    task: "(replaced by the v1 prompt builder)",
    terminalProtocol: 1,
  };

  const startedAt = Date.now();
  let report;
  let runThrew = null;
  let wrapperIntact = null;
  try {
    report = await runner.run(delivery, {
      signal: new AbortController().signal,
      onProgress: () => {},
    });
  } catch (err) {
    runThrew = err instanceof Error ? err.message : String(err);
  } finally {
    if (wrapperBefore !== null) {
      try {
        wrapperIntact = (await fs.readFile(controlRoot.wrapperPath, "utf8")) === wrapperBefore;
      } catch {
        wrapperIntact = false;
      }
    }
    await releaseControlRoot(controlRoot).catch(() => {});
    await jail.dispose().catch(() => {});
    if (runTmpRoot !== null) await fs.rm(runTmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratchBase, { recursive: true, force: true }).catch(() => {});
    await fs.rm(controlBase, { recursive: true, force: true }).catch(() => {});
  }
  const durationMs = Date.now() - startedAt;

  const stream = analyzeStream(capturedStdout);
  const combined = `${capturedStdout}\n${capturedStderr}`;
  const markers = {
    opensslAbort: /openssl|OPENSSL|Abort trap|exit 134/i.test(combined),
    cwdEperm: /operation not permitted[^\n]*cwd-|cwd-[^\n]*operation not permitted/i.test(combined),
    anyEperm: /operation not permitted|EPERM/i.test(combined),
  };
  const loopzhbCalls = stream.bashCalls.filter((c) => c.includes("loopzhb")).length;
  const expectedFailCalls = stream.bashCalls.filter((c) => c.includes("no-such-compat-file")).length;

  let sideEffectOk = null;
  try {
    sideEffectOk = (await fs.readFile(path.join(workRoot, "compat-ok.txt"), "utf8")) === "compat-ok\n";
  } catch {
    sideEffectOk = false;
  }

  // Variant R refusal evidence (plan §4.3): the escape write must NOT have
  // landed, the wrapper must be byte-identical, and both denial commands
  // must surface as tool errors.
  let refusal = null;
  if (variant === "R") {
    const denied = (needle) => {
      const idx = stream.bashCalls.findIndex((c) => c.includes(needle));
      return idx === -1 ? null : stream.toolResults[idx]?.isError === true;
    };
    refusal = {
      escapeDenied: denied("loopzhb-escape-attempt"),
      tamperDenied: denied("echo tamper"),
      escapeFileCreated: existsSync(ESCAPE_PROBE),
      wrapperIntact,
    };
  }

  // Cost bookkeeping (plan §1): a completed conversation that reports NO
  // cost blocks further paid experiments. A run that never reached the API
  // (no terminal event at all) could not have incurred model cost.
  const costUsd = report?.cost?.usd ?? stream.terminal?.total_cost_usd ?? null;
  const costUnknown = stream.terminal !== null && costUsd === null;
  await fs.writeFile(
    path.join(evidenceDir, LEDGER_FILE),
    `${JSON.stringify([...ledger, { variant, runId, at: new Date().toISOString(), usd: costUsd }], null, 2)}\n`,
    { mode: 0o600 },
  );

  const evidence = {
    variant,
    runId,
    at: new Date().toISOString(),
    config: {
      claudeBin: probe.binary.resolvedPath,
      claudeVersion: probe.version,
      claudeSha256: probe.binary.sha256,
      nodePath: controlRoot.nodePath,
      nodeVersion: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      variantChanges:
        variant === "A"
          ? "none (production baseline)"
          : variant === "B"
            ? "CLAUDE_CODE_TMPDIR=private canonical tmp root + precise allowRead/allowWrite grant"
            : variant === "C"
              ? "loopzhb entry = thin shell launcher: exec <canonical node> --openssl-config=<empty cfg> <bundle>"
              : "B and C combined",
    },
    report: report ?? null,
    runThrew,
    durationMs,
    costUsd,
    bashCalls: stream.bashCalls.map(redact),
    toolResults: stream.toolResults.map((r) => ({ isError: r.isError, preview: redact(r.preview) })),
    markers,
    loopzhbCalls,
    expectedFailCalls,
    sideEffects: { compatOkFile: sideEffectOk, taskFilePersisted: true },
    refusal,
    journalVerdict: report?.ok === true ? "ok" : (report?.error ?? runThrew ?? "unknown"),
  };
  const evidencePath = path.join(evidenceDir, `compat-${variant}-${stamp}.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  console.log(`variant ${variant} done in ${(durationMs / 1000).toFixed(1)}s — evidence: ${evidencePath}`);
  console.log(
    `VERDICT ${variant}: report.ok=${report?.ok ?? false} journal=${evidence.journalVerdict} ` +
      `bashCalls=${stream.bashCalls.length} loopzhbCalls=${loopzhbCalls} expectedFailCalls=${expectedFailCalls} ` +
      `sideEffectOk=${sideEffectOk} opensslAbort=${markers.opensslAbort} cwdEperm=${markers.cwdEperm} ` +
      (refusal !== null
        ? `escapeDenied=${refusal.escapeDenied} tamperDenied=${refusal.tamperDenied} escapeFileCreated=${refusal.escapeFileCreated} wrapperIntact=${refusal.wrapperIntact} `
        : "") +
      `cost=${costUsd === null ? "unknown" : `$${costUsd.toFixed(4)}`} cumulative=$${(spent + (costUsd ?? 0)).toFixed(4)}`,
  );
  if (costUnknown) {
    console.error("cost unavailable for a completed conversation — stopping paid experiments (plan §1)");
    process.exit(3);
  }
  process.exit(report?.ok === true ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
