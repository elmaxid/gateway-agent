import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const TASK_HEADER_RE = /^##\s+Task\s+(\d+)[\s:>\-]/i;

export function parsePlanFile(content) {
  const lines = content.split(/\r?\n/);
  const tasks = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(TASK_HEADER_RE);
    if (match) {
      if (current) tasks.push(current);
      const id = parseInt(match[1], 10);
      current = { id, header: line, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) tasks.push(current);

  if (tasks.length === 0) {
    throw new Error("No tasks found in plan file. Expected ## Task N headers.");
  }

  const seenIds = new Set();
  for (const t of tasks) {
    if (seenIds.has(t.id)) {
      throw new Error(`Duplicate task ID ${t.id} in plan file.`);
    }
    seenIds.add(t.id);
  }

  return tasks.map((t) => ({
    id: t.id,
    prompt: `${t.header}\n${t.bodyLines.join("\n")}`.trim(),
  }));
}

export function parseInlineTasks(taskArgs, defaultProfile) {
  return taskArgs.map((raw, index) => {
    const lastColon = raw.lastIndexOf(":");
    if (lastColon === -1 || lastColon === 0) {
      return { id: index + 1, prompt: raw, profile: defaultProfile };
    }
    const afterColon = raw.slice(lastColon + 1).trim();
    if (afterColon.includes("/") || afterColon.includes(" ")) {
      return { id: index + 1, prompt: raw, profile: defaultProfile };
    }
    return {
      id: index + 1,
      prompt: raw.slice(0, lastColon).trim(),
      profile: afterColon || defaultProfile,
    };
  });
}

export function parseAssignment(assignStr, taskCount) {
  const assigned = new Map();
  const segments = assignStr.split(",").map((s) => s.trim()).filter(Boolean);

  for (const segment of segments) {
    const colonIdx = segment.lastIndexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid assignment segment "${segment}". Expected "range:profile".`);
    }
    const rangeStr = segment.slice(0, colonIdx).trim();
    const profile = segment.slice(colonIdx + 1).trim();
    if (!profile) {
      throw new Error(`Empty profile in assignment segment "${segment}".`);
    }

    const dashIdx = rangeStr.indexOf("-");
    let start, end;
    if (dashIdx === -1) {
      start = end = parseInt(rangeStr, 10);
    } else {
      start = parseInt(rangeStr.slice(0, dashIdx), 10);
      end = parseInt(rangeStr.slice(dashIdx + 1), 10);
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      throw new Error(`Invalid range "${rangeStr}" in assignment. Expected positive integers.`);
    }
    if (start > end) {
      throw new Error(`Invalid range "${rangeStr}": start (${start}) > end (${end}).`);
    }
    if (end > taskCount) {
      throw new Error(`Assignment range ${start}-${end} exceeds task count (${taskCount}).`);
    }

    for (let i = start; i <= end; i++) {
      if (assigned.has(i)) {
        throw new Error(`Overlapping assignment: task ${i} assigned to both "${assigned.get(i)}" and "${profile}".`);
      }
      assigned.set(i, profile);
    }
  }

  return assigned;
}

export function parseModelOverrides(overrideArgs) {
  const map = new Map();
  for (const arg of overrideArgs) {
    const colonIdx = arg.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid --model-override "${arg}". Expected "profile:model".`);
    }
    map.set(arg.slice(0, colonIdx).trim(), arg.slice(colonIdx + 1).trim());
  }
  return map;
}

export function buildTaskList(rawTasks, assignment, overrides, defaultProfile) {
  return rawTasks.map((t) => {
    const profile = t.profile ?? assignment?.get(t.id) ?? defaultProfile;
    const model = (profile && overrides?.get(profile)) ?? null;
    return { id: t.id, prompt: t.prompt, profile, model };
  });
}
