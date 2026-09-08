/**
 * Claude Runner sandbox-compat diagnostic driver (Issue #50, plan
 * `docs/plan/codex-fix-claude-sandbox-compat-plan.md` §2 — Phase 1).
 *
 * One invocation = ONE real Claude call of ONE experiment variant:
 *
 *   A  frozen legacy wrapper + legacy temp profile (negative control)
 *   B  legacy wrapper + fixed private run temp (isolates cwd fix)
 *   C  fixed launcher + legacy temp profile (isolates wrapper fix)
 *   D  fixed launcher + fixed private run temp (combined diagnostic)
 *   P  untouched current production path (acceptance smoke)
 *   R  current production path plus complete refusal probes
 *
 * The variants exist ONLY in this helper: production code gains no switches.
 * A/B restore the digest-pinned legacy entry, while A/C use the existing
 * spawnImpl diagnostic seam to remove the production temp env/grants from
 * the actual spawn. P/R modify neither capability. Everything
 * else is the untouched production path: provider
 * bootstrap (resolveClaudeProviderEnv), probe-pinned binary identity,
 * createClaudeRunner, the static wrapper bundle and spawnWithTimeout's
 * process-group reaping.
 *
 * Budget (plan §1): A-D share at most 8 real calls / 90 min / a $3
 * cumulative diagnostic target. P/R have an independent at-most-4-call /
 * 90-minute ledger and additionally require an explicit positive acceptance
 * budget. Each call is capped at 180s. A started call whose cost cannot be
 * observed persists as blocking evidence (exit 3); it is never treated as
 * free or silently discarded.
 *
 * Evidence (plan §2): one redacted JSON per run in the persistent evidence
 * dir (default ~/loopzhb-compat-evidence, NEVER /tmp): config summary,
 * binary identity, the actual Bash inputs/results extracted from the
 * stream-json capture, file side effects, the journal verdict, duration and
 * cost. Raw credentials and unredacted transcripts are never written.
 *
 * Usage:
 *   LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved hash> \
 *   LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD=<approved target> \
 *     pnpm test:claude:compat --variant P
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSecretValues, redactSecrets } from "../dist/agent-env.js";
import { resolveClaudeProviderEnv } from "../dist/claude-provider-env.js";
import { createClaudeRunner } from "../dist/claude-runner.js";
import { createControlRoot, releaseControlRoot } from "../dist/control-root.js";
import { createWorkdirJail } from "../dist/jail.js";
import { probeClaudeBinary } from "../dist/probe-claude.js";
import { prepareClaudeRunTemp, releaseClaudeRunTemp } from "../dist/run-temp.js";
import { spawnWithTimeout } from "../dist/subprocess.js";
import { WRAPPER_BUNDLE_FILE, WRAPPER_BUNDLE_SHA256 } from "../dist/wrapper-artifact.generated.js";
import {
  VARIANT_PROFILES,
  analyzeStream,
  assessBudget,
  evaluateCompatVerdict,
} from "./claude-compat-lib.mjs";

const CALL_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_LEDGER_FILE = "spend-ledger.json";
const ACCEPTANCE_LEDGER_FILE = "acceptance-spend-ledger.json";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const POLICY_PATH = fileURLToPath(new URL("./claude-compat-lib.mjs", import.meta.url));
const VARIANTS = new Set(Object.keys(VARIANT_PROFILES));

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
    throw new Error("usage: claude-compat.mjs --variant A|B|C|D|P|R [--evidence-dir <path>]");
  }
  return out;
}

async function readLedger(evidenceDir, ledgerFile) {
  try {
    const rows = JSON.parse(await fs.readFile(path.join(evidenceDir, ledgerFile), "utf8"));
    if (!Array.isArray(rows)) throw new Error("invalid spend ledger: expected an array");
    return rows;
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`cannot read spend ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeLedger(evidenceDir, ledgerFile, rows) {
  const ledgerPath = path.join(evidenceDir, ledgerFile);
  const pendingPath = path.join(evidenceDir, `.${ledgerFile}.${process.pid}.tmp`);
  await fs.writeFile(pendingPath, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(pendingPath, ledgerPath);
}

async function main() {
  const { variant, evidenceDir } = parseArgs(process.argv.slice(2));
  const profile = VARIANT_PROFILES[variant];
  const expectedSha = process.env.LOOPZHB_EXPECTED_CLAUDE_SHA256;
  if (expectedSha === undefined || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error("LOOPZHB_EXPECTED_CLAUDE_SHA256=<approved sha256> is required (operator-pinned binary identity)");
  }
  const claudeBin = process.env.LOOPZHB_CLAUDE_BIN ?? "claude";

  await fs.mkdir(evidenceDir, { recursive: true });
  const isAcceptance = profile.purpose !== "diagnostic";
  const acceptanceBudgetRaw = process.env.LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD;
  const acceptanceBudgetUsd = acceptanceBudgetRaw === undefined ? Number.NaN : Number(acceptanceBudgetRaw);
  if (isAcceptance && (!Number.isFinite(acceptanceBudgetUsd) || acceptanceBudgetUsd <= 0)) {
    console.error("P/R requires explicit LOOPZHB_COMPAT_ACCEPTANCE_BUDGET_USD=<positive usd target>");
    process.exit(3);
  }
  const ledgerFile = isAcceptance ? ACCEPTANCE_LEDGER_FILE : DIAGNOSTIC_LEDGER_FILE;
  const ledger = await readLedger(evidenceDir, ledgerFile);
  const budget = assessBudget(
    ledger,
    Date.now(),
    isAcceptance ? { maxCalls: 4, costTargetUsd: acceptanceBudgetUsd, label: "acceptance" } : {},
  );
  if (!budget.ok) {
    console.error(`${budget.reason} — no further paid experiments`);
    process.exit(3);
  }
  const spent = budget.spent;

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
  const scratchBase = await fs.mkdtemp(path.join(os.tmpdir(), "lzc-scratch-"));
  const controlBase = await fs.mkdtemp(path.join(os.tmpdir(), "lzc-control-"));
  const jail = await createWorkdirJail({ allowedRoots: [workRoot], scratchBase });
  const controlRoot = await createControlRoot(controlBase);

  // A/B are a frozen copy of the old self-contained bundle entry. C/D/P/R
  // keep the current launcher produced by createControlRoot. The same
  // digest-pinned bundle is used on both sides, so the launcher is the only
  // wrapper variable.
  const bundle = await fs.readFile(controlRoot.bundlePath);
  if (createHash("sha256").update(bundle).digest("hex") !== WRAPPER_BUNDLE_SHA256) {
    throw new Error("wrapper bundle digest mismatch — rebuild @loopzhb/daemon");
  }
  if (profile.wrapper === "legacy") {
    await fs.rm(controlRoot.wrapperPath);
    await fs.writeFile(controlRoot.wrapperPath, bundle, { mode: 0o500 });
    await fs.chmod(controlRoot.wrapperPath, 0o500);
  }
  const wrapperBytes = await fs.readFile(controlRoot.wrapperPath);
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const wrapperSha256 = createHash("sha256").update(wrapperBytes).digest("hex");
  const wrapperConfigured =
    profile.wrapper === "legacy"
      ? wrapperBytes.equals(bundle)
      : !wrapperBytes.equals(bundle) &&
        wrapperBytes.toString("utf8").includes(`--openssl-config=${controlRoot.opensslConfigPath}`) &&
        wrapperBytes.toString("utf8").includes(`import "./${WRAPPER_BUNDLE_FILE}"`);
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path.dirname(SCRIPT_PATH), encoding: "utf8" }).trim();
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoRoot, encoding: "utf8" });
  const runtimeArtifactSha256 = {};
  for (const name of [
    "agent-env.js",
    "claude-provider-env.js",
    "claude-runner.js",
    "control-root.js",
    "jail.js",
    "probe-claude.js",
    "run-temp.js",
    "subprocess.js",
    "wrapper-artifact.generated.js",
  ]) {
    const artifact = fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
    runtimeArtifactSha256[name] = createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
  }
  const sourceIdentity = {
    head: sourceHead,
    dirty: sourceStatus !== "",
    worktreeStatusSha256: createHash("sha256").update(sourceStatus).digest("hex"),
    scriptSha256: createHash("sha256").update(await fs.readFile(SCRIPT_PATH)).digest("hex"),
    policySha256: createHash("sha256").update(await fs.readFile(POLICY_PATH)).digest("hex"),
    runtimeArtifactSha256,
  };
  const nodeSha256 = createHash("sha256").update(await fs.readFile(controlRoot.nodePath)).digest("hex");

  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  let otherRunTemp = null;
  const commands = {
    success: "echo compat-ok > compat-ok.txt",
    expectedFailure: "cat no-such-compat-file.txt",
    terminal: `loopzhb report --status nothing-new --message "compat ${variant} done"`,
    denials: [],
  };
  const refusalTargets = [];
  if (variant === "R") {
    // A second run-shaped temp root is live while the current Run executes.
    // Direct and in-root-symlink access must both be denied by the current
    // sandbox even though the host process has the same UID.
    otherRunTemp = await prepareClaudeRunTemp();
    const otherRead = path.join(otherRunTemp.tmpRoot, "sentinel.txt");
    const otherWrite = path.join(otherRunTemp.tmpRoot, "write-target.txt");
    await fs.writeFile(otherRead, "other-run-secret\n", { mode: 0o600 });
    await fs.writeFile(otherWrite, "original\n", { mode: 0o600 });
    const readLink = path.join(workRoot, "outside-read-link");
    const writeLink = path.join(workRoot, "outside-write-link");
    await fs.symlink(otherRead, readLink);
    await fs.symlink(otherWrite, writeLink);
    commands.denials.push(
      `cat ${shellQuote(otherRead)}`,
      `echo tamper > ${shellQuote(otherWrite)}`,
      `echo tamper >> ${shellQuote(controlRoot.wrapperPath)}`,
      `echo tamper >> ${shellQuote(controlRoot.opensslConfigPath)}`,
      "cat outside-read-link",
      "echo tamper > outside-write-link",
    );
    refusalTargets.push(
      { name: "other-run-read", kind: "file", path: otherRead, before: await fs.readFile(otherRead) },
      { name: "other-run-write", kind: "file", path: otherWrite, before: await fs.readFile(otherWrite) },
      { name: "wrapper", kind: "file", path: controlRoot.wrapperPath, before: await fs.readFile(controlRoot.wrapperPath) },
      { name: "openssl-config", kind: "file", path: controlRoot.opensslConfigPath, before: await fs.readFile(controlRoot.opensslConfigPath) },
      { name: "outside-read-link", kind: "symlink", path: readLink, before: await fs.readlink(readLink) },
      { name: "outside-write-link", kind: "symlink", path: writeLink, before: await fs.readlink(writeLink) },
    );
  }

  const numberedCommands = [commands.success, commands.expectedFailure, ...commands.denials, commands.terminal];
  await fs.writeFile(
    taskFilePath,
    [
      `# Compat probe ${variant}`,
      "",
      "## Spec",
      `Run exactly these ${numberedCommands.length} commands, in this order, each exactly once:`,
      "",
      ...numberedCommands.map((command, index) => {
        const expected = index === 1 ? " — EXPECTED to fail." : index >= 2 && index < numberedCommands.length - 1 ? " — EXPECTED to be denied." : "";
        return `${index + 1}. \`${command}\`${expected}`;
      }),
      "",
      "No retries or alternatives. After any expected failure, move immediately to the next numbered command.",
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

  const redact = (text) => redactSecrets(text, [...collectSecretValues(envSource), "compat-local-run-token"]);
  let capturedStdout = "";
  let capturedStderr = "";
  let capturedCapability = null;
  let runnerMintedTmp = null;
  const spawnImpl = async (options) => {
    let spawnOptions = options;
    runnerMintedTmp = options.env.CLAUDE_CODE_TMPDIR ?? null;
    if (profile.runTemp === "legacy" && runnerMintedTmp !== null) {
      const args = [...options.args];
      const settingsIndex = args.indexOf("--settings");
      const settings = JSON.parse(args[settingsIndex + 1]);
      settings.sandbox.filesystem.allowRead = settings.sandbox.filesystem.allowRead.filter(
        (entry) => entry !== runnerMintedTmp,
      );
      settings.sandbox.filesystem.allowWrite = settings.sandbox.filesystem.allowWrite.filter(
        (entry) => entry !== runnerMintedTmp,
      );
      args[settingsIndex + 1] = JSON.stringify(settings);
      const env = { ...options.env };
      delete env.CLAUDE_CODE_TMPDIR;
      spawnOptions = { ...options, args, env };
    }
    const settingsIndex = spawnOptions.args.indexOf("--settings");
    const settings = settingsIndex === -1 ? null : JSON.parse(spawnOptions.args[settingsIndex + 1]);
    capturedCapability = {
      claudeCodeTmpdir: spawnOptions.env.CLAUDE_CODE_TMPDIR ?? null,
      opensslConfPresent: spawnOptions.env.OPENSSL_CONF !== undefined,
      filesystem: settings?.sandbox?.filesystem ?? null,
    };
    const result = await spawnWithTimeout({
      ...spawnOptions,
      onStdout: (chunk) => {
        capturedStdout += chunk;
        options.onStdout(chunk);
      },
    });
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
  const callRow = { variant, runId, at: new Date(startedAt).toISOString(), usd: null, status: "started" };
  await writeLedger(evidenceDir, ledgerFile, [...ledger, callRow]);
  let report;
  let runThrew = null;
  const cleanupFailures = [];
  let refusal = null;
  try {
    report = await runner.run(delivery, {
      // No external abort — the 180s per-call cap governs; this controller's
      // signal is deliberately never fired.
      signal: new AbortController().signal,
      onProgress: () => {},
    });
  } catch (err) {
    runThrew = err instanceof Error ? err.message : String(err);
  } finally {
    if (variant === "R") {
      const targets = [];
      for (const target of refusalTargets) {
        let intact = false;
        try {
          intact =
            target.kind === "symlink"
              ? (await fs.readlink(target.path)) === target.before
              : (await fs.readFile(target.path)).equals(target.before);
        } catch {
          intact = false;
        }
        targets.push({ name: target.name, intact });
      }
      refusal = { targets, allTargetsIntact: targets.every((target) => target.intact) };
    }
    const release = async (label, promise) => {
      try {
        await promise;
      } catch (err) {
        const detail = `${label}: ${err instanceof Error ? err.message : String(err)}`;
        cleanupFailures.push(detail);
        console.error(`release failed: ${detail}`);
      }
    };
    await release("controlRoot", releaseControlRoot(controlRoot));
    await release("jail", jail.dispose());
    if (otherRunTemp !== null) await release("otherRunTemp", releaseClaudeRunTemp(otherRunTemp));
    await release("scratchBase", fs.rm(scratchBase, { recursive: true, force: true }));
    await release("controlBase", fs.rm(controlBase, { recursive: true, force: true }));
  }
  const durationMs = Date.now() - startedAt;

  const stream = analyzeStream(capturedStdout);
  const combined = `${capturedStdout}\n${capturedStderr}`;
  const markers = {
    opensslAbort: /openssl|OPENSSL|Abort trap|exit 134/i.test(combined),
    cwdEperm: /operation not permitted[^\n]*cwd-|cwd-[^\n]*operation not permitted/i.test(combined),
    anyEperm: /operation not permitted|EPERM/i.test(combined),
  };
  const loopzhbCalls = stream.terminalCalls.length;
  const expectedFailCalls = stream.calls.filter((call) => call.command.trim() === commands.expectedFailure).length;

  let sideEffectOk = null;
  try {
    sideEffectOk = (await fs.readFile(path.join(workRoot, "compat-ok.txt"), "utf8")) === "compat-ok\n";
  } catch {
    sideEffectOk = false;
  }

  // A started call is billable even if it times out before a terminal event.
  // Unknown cost is persisted and blocks every subsequent invocation.
  const costUsd = report?.cost?.usd ?? stream.terminal?.total_cost_usd ?? null;
  const costUnknown = costUsd === null;
  const completedRow = { ...callRow, usd: costUsd, status: costUnknown ? "cost-unknown" : "complete" };
  await writeLedger(evidenceDir, ledgerFile, [...ledger, completedRow]);

  const tmpRoot = capturedCapability?.claudeCodeTmpdir ?? null;
  const runTempConfigured =
    profile.runTemp === "legacy"
      ? tmpRoot === null &&
        (runnerMintedTmp === null ||
          (capturedCapability?.filesystem?.allowRead?.includes(runnerMintedTmp) !== true &&
            capturedCapability?.filesystem?.allowWrite?.includes(runnerMintedTmp) !== true))
      : typeof tmpRoot === "string" &&
        capturedCapability?.filesystem?.allowRead?.includes(tmpRoot) === true &&
        capturedCapability?.filesystem?.allowWrite?.includes(tmpRoot) === true;
  const runTempReleased = runnerMintedTmp === null || !existsSync(runnerMintedTmp);
  const strictVerdict = evaluateCompatVerdict({
    variant,
    reportOk: report?.ok === true,
    stream,
    markers,
    sideEffectOk,
    commands,
    refusal,
  });
  if (!runTempConfigured) strictVerdict.failures.push("run-temp profile did not match the selected variant");
  if (!runTempReleased) strictVerdict.failures.push("runner temp root was not released");
  if (!wrapperConfigured) strictVerdict.failures.push("wrapper profile did not match the selected variant");
  strictVerdict.failures.push(...cleanupFailures.map((failure) => `cleanup failed: ${failure}`));
  strictVerdict.ok = strictVerdict.failures.length === 0;

  const diagnosticExpected =
    variant === "A"
      ? !report?.ok && markers.cwdEperm && markers.opensslAbort
      : variant === "B"
        ? !report?.ok && !markers.cwdEperm && markers.opensslAbort
        : variant === "C"
          ? !report?.ok && markers.cwdEperm && !markers.opensslAbort
          : strictVerdict.ok;
  const matrixFailures = [];
  if (!runTempConfigured) matrixFailures.push("run-temp profile did not match the selected variant");
  if (!runTempReleased) matrixFailures.push("runner temp root was not released");
  if (!wrapperConfigured) matrixFailures.push("wrapper profile did not match the selected variant");
  matrixFailures.push(...cleanupFailures.map((failure) => `cleanup failed: ${failure}`));
  const isNegativeControl = variant === "A" || variant === "B" || variant === "C";
  const verdict = isNegativeControl
    ? {
        ok: diagnosticExpected && matrixFailures.length === 0,
        failures: [...matrixFailures, ...(diagnosticExpected ? [] : ["diagnostic signature did not match the selected variant"])],
      }
    : strictVerdict;

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
      nodeSha256,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      profile,
      sourceIdentity,
      observedCapability: capturedCapability,
      bundleSha256,
      wrapperSha256,
      wrapperConfigured,
      runTempConfigured,
      runTempReleased,
    },
    report: report ?? null,
    runThrew,
    durationMs,
    costUsd,
    budget: { kind: isAcceptance ? "acceptance" : "diagnostic", ledgerFile, targetUsd: isAcceptance ? acceptanceBudgetUsd : 3 },
    bashCalls: stream.calls.map((call) => ({
      id: call.id,
      command: redact(call.command),
      result: call.result === null ? null : { isError: call.result.isError, preview: redact(call.result.preview) },
    })),
    markers,
    loopzhbCalls,
    expectedFailCalls,
    sideEffects: { compatOkFile: sideEffectOk, taskFilePersisted: true },
    refusal,
    cleanupFailures,
    verdict,
    journalVerdict: report?.ok === true ? "ok" : (report?.error ?? runThrew ?? "unknown"),
  };
  const evidencePath = path.join(evidenceDir, `compat-${variant}-${stamp}.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  console.log(`variant ${variant} done in ${(durationMs / 1000).toFixed(1)}s — evidence: ${evidencePath}`);
  console.log(
    `VERDICT ${variant}: report.ok=${report?.ok ?? false} journal=${evidence.journalVerdict} ` +
      `ok=${verdict.ok} bashCalls=${stream.calls.length} loopzhbCalls=${loopzhbCalls} expectedFailCalls=${expectedFailCalls} ` +
      `sideEffectOk=${sideEffectOk} opensslAbort=${markers.opensslAbort} cwdEperm=${markers.cwdEperm} ` +
      (refusal !== null
        ? `refusalIntact=${refusal.allTargetsIntact} `
        : "") +
      `cost=${costUsd === null ? "unknown" : `$${costUsd.toFixed(4)}`} cumulative=$${(spent + (costUsd ?? 0)).toFixed(4)}`,
  );
  if (costUnknown) {
    console.error("cost unavailable after a started call — ledger is permanently blocked pending operator reconciliation (plan §1)");
    process.exit(3);
  }
  if (!verdict.ok) console.error(`acceptance failed: ${verdict.failures.join("; ")}`);
  process.exit(verdict.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
