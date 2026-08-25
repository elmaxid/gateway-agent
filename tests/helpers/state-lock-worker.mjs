#!/usr/bin/env node
// Test helper for Task 21 (state.mjs concurrency safety) — spawned as a real
// child process so upsertJob() calls genuinely interleave with other
// processes' calls at the OS level. In-process "concurrent" calls to
// synchronous fs functions never actually race, so the plan's own test
// directive requires real child processes, not just parallel promises.
//
// Usage: node state-lock-worker.mjs <workspaceRoot> <idPrefix> <count> <mode>
//   mode "create" — writes <count> distinct jobs (idPrefix-0 .. idPrefix-N-1),
//                    each with its own job file (writeJobFile), then upserts
//                    the index entry.
//   mode "update" — repeatedly upserts the SAME job id (idPrefix) <count>
//                    times with an incrementing counter field, to race
//                    updates rather than creates.
import { upsertJob, writeJobFile } from "../../plugins/gateway/scripts/lib/state.mjs";

const [, , workspaceRoot, idPrefix, countArg, mode] = process.argv;
const count = Number(countArg);

for (let i = 0; i < count; i++) {
  if (mode === "update") {
    upsertJob(workspaceRoot, { id: idPrefix, status: "running", counter: i, pid: process.pid });
  } else {
    const id = `${idPrefix}-${i}`;
    writeJobFile(workspaceRoot, id, { id, seededBy: process.pid, i });
    upsertJob(workspaceRoot, { id, status: "queued", kind: "task", jobClass: "task", title: "t", workspaceRoot });
  }
}
