import { describe, expect, it } from "vitest";
import { assertBatch3StateSource, buildBatch3AcceptanceTask } from "./phase4-batch3-acceptance-task.js";

describe("Batch 3 real gate task protocol", () => {
  const a = "mk-a-offline";
  const b = "mk-b-offline";
  const task = buildBatch3AcceptanceTask(a, b);
  const rewritten = task.split("\n").filter((line) => !line.startsWith("- step-1 marker:")).join("\n");

  it("places A only in the removable line, and excludes shell diagnostic suffixes", () => {
    expect(task.split(a)).toHaveLength(2);
    expect(task).toContain(`- step-1 marker: ${a}`);
    expect(task).not.toContain("$?");
    const command = task.split("\n").find((line) => line.startsWith("    loopzhb finish"));
    expect(command).toBe('    loopzhb finish --reason "goal met; state-marker=<marker from prev-state.json>; timeline-marker=<keep marker from Timeline>"');
    expect(task).toContain("loopzhb --help");
    expect(() => assertBatch3StateSource(rewritten, a, b)).not.toThrow();
  });

  it("fails before Run 2 if A survives in any line, including a command or notes", () => {
    for (const content of [task, `${rewritten}\ncommand: ${a}`, `${rewritten}\nnotes: ${a}`]) {
      expect(() => assertBatch3StateSource(content, a, b)).toThrow("state marker still present");
    }
  });

  it("requires B to remain in the Timeline", () => {
    expect(() => assertBatch3StateSource(rewritten.replace(`- keep marker: ${b}`, b), a, b)).toThrow("Timeline marker missing");
  });
});
