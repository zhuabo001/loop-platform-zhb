/** Test-only task protocol shared by the real gate and its offline checks.
 * Marker A occurs only in the removable Timeline line, never in a command.
 * The Run 2 command is standalone: shell diagnostics have their own permission
 * checks and must not change whether a terminal record can be written. */
export function buildBatch3AcceptanceTask(markerA: string, markerB: string): string {
  return [
    "# Batch 3 Dashboard acceptance task",
    "",
    "## Spec",
    "Each Run must execute EXACTLY ONE terminal report or finish command.",
    "First run `loopzhb --help` as a separate Bash call. This explicit help",
    "probe is record-free; it does not count as the terminal command.",
    "Then read prev-state.json at the absolute path in your run prompt.",
    "Select exactly ONE branch. Use standalone Bash commands, without a",
    "trailing echo, shell exit-status expansion, retries, or outbox writes.",
    "",
    "Branch A: previous state is null.",
    "Read the step-1 marker from the Timeline below and substitute it into:",
    '    loopzhb report --status new --message "step 1 recorded the task file" --state \'{"step":1,"marker":"<step-1 marker from Timeline>"}\'',
    "Execute that command once. Then remove the entire `- step-1 marker:`",
    "line from this file and append `- step 1 recorded` to the Timeline.",
    "Do not copy the removed marker into any other file or any other line.",
    "",
    "Branch B: previous state is not null.",
    "Read `marker` from prev-state.json and keep marker from the Timeline.",
    "Substitute both actual values into this command and execute it once:",
    '    loopzhb finish --reason "goal met; state-marker=<marker from prev-state.json>; timeline-marker=<keep marker from Timeline>"',
    "Then write RUN-NOTES.md beside this file with four lines:",
    "marker-read: <the marker read from prev-state.json>",
    "command: <the exact standalone command submitted to Bash>",
    "tool-result: <success, failure, or denied, from the Bash tool response>",
    "output: <the tool output, or (nothing) if empty>",
    "Do not invent an exit code. Host validation of the journal and database",
    "determines success, not these notes. A silent command is not a retry signal.",
    "",
    "If prev-state.json cannot be read, report the failure once with:",
    '    loopzhb report --status new --message "cannot read previous state"',
    "Do not finish or invent markers. Never use --state-file or --message-file.",
    "",
    "## Current understanding",
    "Unknown: read previous state and select Branch A or B.",
    "",
    "## Timeline",
    `- step-1 marker: ${markerA}`,
    `- keep marker: ${markerB}`,
    "",
  ].join("\n");
}

/** Called before triggering the paid second Run. */
export function assertBatch3StateSource(taskFile: string, markerA: string, markerB: string): void {
  if (taskFile.includes(markerA)) throw new Error("state marker still present in Task File");
  if (!taskFile.includes(`- keep marker: ${markerB}`)) throw new Error("Timeline marker missing");
}
