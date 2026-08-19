/**
 * Deterministic child-process fixture for subprocess.ts pins (S1–S17) and
 * the batch-2 integration pins (I1–I4). Plain ESM JavaScript, spawned as
 * `node spawn-fixture.mjs <mode> …` — no build step. Modes:
 *   exit <code>                 small stdout+stderr, exit <code>
 *   big <stdout|stderr> <bytes> exactly <bytes> of a repeating digit pattern
 *   drip <count> <intervalMs>   numbered stdout lines with delays
 *   sleep <ms>                  stay alive (default SIGTERM kills us)
 *   ignore-term <ms>            ignore SIGTERM, stay alive (SIGKILL test)
 *   grandchild                  unref a same-group sleeping child, exit 0
 *   self-signal <signal>        signal ourselves after 20ms
 *   printenv                    JSON.stringify(process.env) to stdout
 */
import { spawn } from "node:child_process";

const [mode, ...rest] = process.argv.slice(2);

function writeAll(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  switch (mode) {
    case "exit": {
      const code = Number(rest[0] ?? "0");
      await writeAll(process.stdout, `stdout-from-exit-${code}\n`);
      await writeAll(process.stderr, `stderr-from-exit-${code}\n`);
      process.exitCode = code;
      return;
    }
    case "big": {
      const stream = rest[0] === "stderr" ? process.stderr : process.stdout;
      const total = Number(rest[1]);
      const pattern = "0123456789";
      let left = total;
      while (left > 0) {
        const piece = pattern.repeat(Math.ceil(Math.min(left, 4096) / 10)).slice(0, Math.min(left, 4096));
        left -= piece.length;
        await writeAll(stream, piece);
      }
      process.exitCode = 0;
      return;
    }
    case "drip": {
      const count = Number(rest[0]);
      const intervalMs = Number(rest[1]);
      for (let i = 0; i < count; i += 1) {
        await writeAll(process.stdout, `line-${i}\n`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      process.exitCode = 0;
      return;
    }
    case "sleep": {
      await new Promise((resolve) => setTimeout(resolve, Number(rest[0])));
      process.exitCode = 0;
      return;
    }
    case "ignore-term": {
      process.on("SIGTERM", () => {}); // deliberately ignored — forces SIGKILL escalation
      await new Promise((resolve) => setTimeout(resolve, Number(rest[0] ?? 60000)));
      process.exitCode = 0;
      return;
    }
    case "grandchild": {
      // Same process group (detached: false), unref'd so WE exit while the
      // grandchild keeps the group alive — the module must reap the group.
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        detached: false,
        stdio: "ignore",
      });
      grandchild.unref();
      process.exitCode = 0;
      return;
    }
    case "self-signal": {
      const signal = rest[0] ?? "SIGUSR1";
      setTimeout(() => process.kill(process.pid, signal), 20);
      await new Promise((resolve) => setTimeout(resolve, 60000));
      return;
    }
    case "printenv": {
      await writeAll(process.stdout, JSON.stringify(process.env));
      process.exitCode = 0;
      return;
    }
    default: {
      await writeAll(process.stderr, `unknown mode: ${String(mode)}\n`);
      process.exitCode = 64;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fixture error: ${String(err)}\n`);
  process.exitCode = 70;
});
