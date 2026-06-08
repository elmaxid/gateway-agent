#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { chatCompletion, runDirectReview, testConnectivity, listModels } from "./lib/api-client.mjs";
import { runAgenticReview } from "./lib/agentic-review.mjs";
import { runClaudeTask } from "./lib/claude-subprocess.mjs";
import { runTask } from "./lib/codex-harness.mjs";
import { runDebate, renderDebateOutput } from "./lib/debate.mjs";
import {
  loadConfig,
  saveConfig,
  resolveProfile,
  resolveReviewProfile,
  resolveTaskProfile,
  addProfile,
  removeProfile,
  listProfiles,
  validateProfile
} from "./lib/config.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { terminateProcessTree, terminateProcessTreeAsync } from "./lib/process.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { applyPersona, getValidPersonas } from "./lib/personas.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderProfilesTable,
  renderReviewOutput,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gateway-companion setup <add|remove|list|test|set-default|set-review-profile|set-task-profile> [args]",
      "  gateway-companion review [--profile NAME] [--model MODEL] [--base REF] [--scope auto|working-tree|branch] [--json]",
      "  gateway-companion adversarial-review [--profile NAME] [--model MODEL] [--base REF] [--scope auto|working-tree|branch] [--json] [focus]",
      "  gateway-companion task [--profile NAME] [--model MODEL] [--as PERSONA] [--background] [--write|--no-write] [prompt]",
  `                          PERSONA: ${getValidPersonas().join("|")}`,
      "  gateway-companion task-worker --job-id ID [--profile NAME] [--model MODEL] [--write|--no-write] [prompt]",
      "  gateway-companion status [job-id] [--all] [--json]",
      "  gateway-companion result [job-id] [--json]",
      "  gateway-companion cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .find(Boolean);
  return line ?? fallback;
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) return jobs;
  return jobs.filter((job) => job.sessionId === sessionId);
}

// ---------------------------------------------------------------------------
// Review prompts
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer. Review the following diff. Provide structured feedback with severity (critical/warning/suggestion), file, line, and description for each finding. Return a JSON object with this shape:
{
  "verdict": "approve|request_changes|comment",
  "summary": "one-paragraph summary",
  "findings": [
    { "severity": "critical|warning|suggestion", "file": "path", "line_start": N, "line_end": N, "title": "short title", "body": "details", "recommendation": "fix suggestion" }
  ],
  "next_steps": ["action item 1", "..."]
}
Return ONLY the JSON object, no markdown fences.`;

const ADVERSARIAL_SYSTEM_PROMPT = `You are an adversarial code reviewer. You have been given a prior review with findings. Your job is to critically examine each finding and determine which are genuine issues and which are false positives. For each finding, state whether it is VALID or FALSE_POSITIVE with a brief justification. Then produce a refined final review with only the valid findings. Return a JSON object with the same shape as the original review.`;

// ---------------------------------------------------------------------------
// Setup subcommand
// ---------------------------------------------------------------------------

async function handleSetup(argv) {
  const [action, ...rest] = argv;

  if (!action) {
    const config = loadConfig();
    const profiles = listProfiles(config);
    const payload = {
      profiles,
      defaultProfile: config.defaultProfile,
      reviewProfile: config.reviewProfile,
      taskProfile: config.taskProfile
    };
    outputResult(renderSetupReport(payload), false);
    return;
  }

  switch (action) {
    case "add": {
      const { options } = parseArgs(rest, {
        valueOptions: ["profile", "url", "model", "kind", "auth-token", "api-key", "max-context", "max-output"],
        booleanOptions: []
      });

      if (!options.profile || !options.url || !options.model) {
        throw new Error("Required: --profile NAME --url URL --model MODEL");
      }

      const profileData = {
        kind: options.kind || "openai-chat",
        baseUrl: options.url,
        defaultModel: options.model,
        ...(options["auth-token"] && { authToken: options["auth-token"] }),
        ...(options["api-key"] && { apiKey: options["api-key"] }),
        ...(options["max-context"] && { maxContext: Number(options["max-context"]) }),
        ...(options["max-output"] && { maxOutput: Number(options["max-output"]) })
      };

      const validation = validateProfile(profileData);
      if (!validation.valid) {
        throw new Error(`Invalid profile: ${validation.errors.join(", ")}`);
      }

      let config = loadConfig();
      config = addProfile(config, options.profile, profileData);
      if (!config.defaultProfile) {
        config.defaultProfile = options.profile;
      }
      saveConfig(config);
      console.log(`Profile "${options.profile}" added.`);
      break;
    }

    case "remove": {
      const { options } = parseArgs(rest, { valueOptions: ["profile"] });
      if (!options.profile) throw new Error("Required: --profile NAME");
      let config = loadConfig();
      if (!config.profiles[options.profile]) {
        throw new Error(`Profile "${options.profile}" not found.`);
      }
      config = removeProfile(config, options.profile);
      saveConfig(config);
      console.log(`Profile "${options.profile}" removed.`);
      break;
    }

    case "list": {
      const { options } = parseArgs(rest, { booleanOptions: ["json"] });
      const config = loadConfig();
      const profiles = listProfiles(config);
      const payload = {
        profiles,
        defaultProfile: config.defaultProfile,
        reviewProfile: config.reviewProfile,
        taskProfile: config.taskProfile
      };
      outputCommandResult(payload, renderProfilesTable(payload), options.json);
      break;
    }

    case "test": {
      const { options } = parseArgs(rest, { valueOptions: ["profile"], booleanOptions: ["json"] });
      const config = loadConfig();
      const profile = resolveProfile(options.profile, config);
      console.error(`Testing connectivity to ${profile.baseUrl} (${profile.name})...`);
      const result = await testConnectivity(profile);
      const payload = { profile: profile.name, ...result };
      if (options.json) {
        outputResult(payload, true);
      } else if (result.ok) {
        console.log(`OK - ${profile.name} responded in ${result.latencyMs}ms (model: ${result.model})`);
      } else {
        console.error(`FAIL - ${profile.name}: ${result.error}`);
        process.exitCode = 1;
      }
      break;
    }

    case "set-default": {
      const { options } = parseArgs(rest, { valueOptions: ["profile"] });
      if (!options.profile) throw new Error("Required: --profile NAME");
      const config = loadConfig();
      if (!config.profiles[options.profile]) {
        throw new Error(`Profile "${options.profile}" not found.`);
      }
      config.defaultProfile = options.profile;
      saveConfig(config);
      console.log(`Default profile set to "${options.profile}".`);
      break;
    }

    case "set-review-profile": {
      const { options } = parseArgs(rest, { valueOptions: ["profile"] });
      if (!options.profile) throw new Error("Required: --profile NAME");
      const config = loadConfig();
      if (!config.profiles[options.profile]) {
        throw new Error(`Profile "${options.profile}" not found.`);
      }
      config.reviewProfile = options.profile;
      saveConfig(config);
      console.log(`Review profile set to "${options.profile}".`);
      break;
    }

    case "set-task-profile": {
      const { options } = parseArgs(rest, { valueOptions: ["profile"] });
      if (!options.profile) throw new Error("Required: --profile NAME");
      const config = loadConfig();
      if (!config.profiles[options.profile]) {
        throw new Error(`Profile "${options.profile}" not found.`);
      }
      config.taskProfile = options.profile;
      saveConfig(config);
      console.log(`Task profile set to "${options.profile}".`);
      break;
    }

    case "set-model": {
      const { options } = parseArgs(rest, { valueOptions: ["profile", "model"] });
      if (!options.profile || !options.model) throw new Error("Required: --profile NAME --model MODEL");
      const config = loadConfig();
      if (!config.profiles[options.profile]) {
        throw new Error(`Profile "${options.profile}" not found.`);
      }
      config.profiles[options.profile].defaultModel = options.model;
      saveConfig(config);
      console.log(`Model for "${options.profile}" set to "${options.model}".`);
      break;
    }

    default:
      throw new Error(`Unknown setup action: ${action}. Use add, remove, list, test, set-default, set-review-profile, set-task-profile, or set-model.`);
  }
}

// ---------------------------------------------------------------------------
// Review subcommand
// ---------------------------------------------------------------------------

async function executeReviewRun(request) {
  ensureGitRepository(request.cwd);

  const config = loadConfig();
  const profile = request.profile ?? resolveReviewProfile(config);
  const model = request.model || profile.defaultModel;
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  // Fallback to pre-injected diff if --no-tools requested
  if (request.noTools) {
    const context = collectReviewContext(request.cwd, target, {
      includeDiff: request.includeDiff
    });
    const userPrompt = `Review target: ${target.label}\n\n${context.content}`;
    request.onProgress?.({ message: `Sending review to ${profile.name} (${model})...`, phase: "reviewing" });
    const result = await runDirectReview(profile, REVIEW_SYSTEM_PROMPT, userPrompt, {
      model,
      response_format: { type: "json_object" }
    });
    const rendered = renderReviewOutput(result, {
      reviewLabel: "Review",
      targetLabel: target.label,
      profileName: profile.name,
      model: result.model
    });
    return {
      exitStatus: 0,
      payload: { review: "Review", target, profile: profile.name, model: result.model, usage: result.usage, result: result.content },
      rendered,
      summary: (result.parsed && result.content?.summary) || firstMeaningfulLine(String(result.content), "Review completed."),
      jobTitle: "Gateway Review",
      jobClass: "review",
      targetLabel: target.label
    };
  }

  // Agentic path — model self-collects via tools
  request.onProgress?.({ message: `Starting agentic review via ${profile.name} (${model})...`, phase: "reviewing" });

  const { content, messages: msgHistory } = await runAgenticReview(profile, request.cwd, target, {
    model,
    maxIterations: 10,
    maxTime: 120_000,
  });

  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = null; }

  const rendered = renderReviewOutput(
    { content: parsed ?? content, model, usage: null, parsed },
    { reviewLabel: "Review", targetLabel: target.label, profileName: profile.name, model }
  );

  return {
    exitStatus: 0,
    payload: {
      review: "Review",
      target,
      profile: profile.name,
      model,
      usage: null,
      result: parsed ?? content,
      messages: msgHistory,
    },
    rendered,
    summary: parsed?.summary ?? firstMeaningfulLine(content, "Review completed."),
    jobTitle: "Gateway Review",
    jobClass: "review",
    targetLabel: target.label
  };
}

async function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["profile", "model", "base", "scope", "cwd"],
    booleanOptions: ["json", "include-diff", "no-tools"],
    aliasMap: { m: "model", p: "profile" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  const config = loadConfig();
  const profile = options.profile ? resolveProfile(options.profile, config) : resolveReviewProfile(config);

  const job = createCompanionJob({
    prefix: "review",
    kind: "review",
    title: "Gateway Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Review ${resolveReviewTarget(cwd, { base: options.base, scope: options.scope }).label}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        profile,
        model: options.model,
        base: options.base,
        scope: options.scope,
        includeDiff: options["include-diff"] || undefined,
        noTools: options["no-tools"] || undefined,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// ---------------------------------------------------------------------------
// Adversarial review subcommand
// ---------------------------------------------------------------------------

async function executeAdversarialReviewRun(request) {
  ensureGitRepository(request.cwd);

  const config = loadConfig();
  const profile = request.profile ?? resolveReviewProfile(config);
  const model = request.model || profile.defaultModel;
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  const context = collectReviewContext(request.cwd, target, {
    includeDiff: request.includeDiff
  });
  const focusText = request.focusText?.trim() ?? "";
  const userPrompt = `Review target: ${target.label}\n${focusText ? `Focus: ${focusText}\n` : ""}\n${context.content}`;

  request.onProgress?.({ message: `Pass 1: initial review via ${profile.name} (${model})...`, phase: "reviewing" });

  const firstPass = await runDirectReview(profile, REVIEW_SYSTEM_PROMPT, userPrompt, {
    model,
    response_format: { type: "json_object" }
  });

  request.onProgress?.({ message: "Pass 2: adversarial false-positive analysis...", phase: "reviewing" });

  const changedFilesList = context.changedFiles.length > 0
    ? context.changedFiles.join("\n")
    : "(no files listed)";
  const adversarialUserPrompt = `Original review findings:\n${JSON.stringify(firstPass.content, null, 2)}\n\nChanged files (${context.fileCount}):\n${changedFilesList}\n\nContext: ${context.summary}`;

  const secondPass = await chatCompletion(profile, [
    { role: "system", content: ADVERSARIAL_SYSTEM_PROMPT },
    { role: "user", content: adversarialUserPrompt }
  ], {
    model,
    response_format: { type: "json_object" }
  });

  const choice = secondPass.choices?.[0];
  let refinedContent = choice?.message?.content ?? "";
  let parsed = false;
  try {
    refinedContent = JSON.parse(refinedContent);
    parsed = true;
  } catch {
    // not JSON
  }

  const rendered = renderReviewOutput(
    { content: parsed ? refinedContent : refinedContent, model: secondPass.model ?? model, usage: secondPass.usage, parsed },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: target.label,
      profileName: profile.name,
      model: secondPass.model ?? model
    }
  );

  return {
    exitStatus: 0,
    payload: {
      review: "Adversarial Review",
      target,
      profile: profile.name,
      model: secondPass.model ?? model,
      firstPass: firstPass.content,
      refinedResult: parsed ? refinedContent : refinedContent,
      usage: secondPass.usage
    },
    rendered,
    summary: (parsed && refinedContent?.summary) || firstMeaningfulLine(String(refinedContent), "Adversarial review completed."),
    jobTitle: "Gateway Adversarial Review",
    jobClass: "review",
    targetLabel: target.label
  };
}

async function handleAdversarialReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["profile", "model", "base", "scope", "cwd"],
    booleanOptions: ["json", "include-diff", "no-tools"],
    aliasMap: { m: "model", p: "profile" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();

  const config = loadConfig();
  const profile = options.profile ? resolveProfile(options.profile, config) : resolveReviewProfile(config);

  const job = createCompanionJob({
    prefix: "review",
    kind: "adversarial-review",
    title: "Gateway Adversarial Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Adversarial review ${resolveReviewTarget(cwd, { base: options.base, scope: options.scope }).label}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeAdversarialReviewRun({
        cwd,
        profile,
        model: options.model,
        base: options.base,
        scope: options.scope,
        focusText,
        includeDiff: options["include-diff"] || undefined,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// ---------------------------------------------------------------------------
// Task subcommand
// ---------------------------------------------------------------------------

async function executeTaskRun(request) {
  const profile = request.profile;
  const model = request.model || profile.defaultModel;
  const write = request.write !== false;

  request.onProgress?.({ message: `Delegating task to ${profile.name} (${model})...`, phase: "starting" });

  const harness = request.harness || "claude";
  const VALID_HARNESSES = new Set(["claude", "codex"]);
  if (!VALID_HARNESSES.has(harness)) {
    throw new Error(`Unknown --harness "${harness}". Valid: ${[...VALID_HARNESSES].join(", ")}`);
  }
  const taskRunner = harness === "codex" ? runTask : runClaudeTask;
  const prompt = applyPersona(request.prompt, request.persona);

  const result = await taskRunner(profile, prompt, {
    model,
    write,
    harness,
    cwd: request.cwd,
    onStdout: (line) => {
      request.onProgress?.({ message: line, phase: "running" });
    },
    onStderr: (chunk) => {
      request.onProgress?.({ stderrMessage: chunk.trim(), phase: "running" });
    }
  });

  const rawOutput = result.stdout || "";
  const failureMessage = result.stderr?.trim() || "";
  const exitStatus = result.exitCode ?? (result.signal ? 1 : 0);

  const rendered = renderTaskResult(
    { rawOutput, failureMessage },
    { title: request.jobTitle ?? "Gateway Task", jobId: request.jobId ?? null, write }
  );

  return {
    exitStatus,
    payload: {
      status: exitStatus === 0 ? "completed" : "failed",
      rawOutput,
      stderr: failureMessage
    },
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, "Task finished.")),
    jobTitle: request.jobTitle ?? "Gateway Task",
    jobClass: "task",
    write
  };
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["profile", "model", "cwd", "prompt-file", "harness", "as"],
    booleanOptions: ["json", "write", "no-write", "background"],
    aliasMap: { m: "model", p: "profile" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const config = loadConfig();
  const profileResolved = options.profile
    ? resolveProfile(options.profile, config)
    : resolveTaskProfile(config);

  let prompt;
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  } else {
    prompt = positionals.join(" ") || readStdinIfPiped();
  }

  if (!prompt) {
    throw new Error("Provide a prompt, a --prompt-file, or pipe stdin.");
  }

  const write = options["no-write"] ? false : (options.write !== undefined ? Boolean(options.write) : true);
  const harness = options.harness || "claude";
  const taskTitle = "Gateway Task";
  const taskSummary = shorten(prompt);

  if (options.background) {
    const job = createCompanionJob({
      prefix: "task",
      kind: "task",
      title: taskTitle,
      workspaceRoot,
      jobClass: "task",
      summary: taskSummary,
      write
    });

    const { logFile } = createTrackedProgress(job);
    appendLogLine(logFile, "Queued for background execution.");

    const child = spawnDetachedTaskWorker(cwd, job.id, {
      profile: profileResolved.name,
      model: options.model,
      write,
      prompt,
      persona: options.as,
      harness
    });

    const queuedRecord = {
      ...job,
      status: "queued",
      phase: "queued",
      pid: child.pid ?? null,
      logFile,
      request: {
        cwd,
        profile: profileResolved.name,
        model: options.model,
        write,
        prompt,
        persona: options.as,
        harness
      }
    };
    writeJobFile(workspaceRoot, job.id, queuedRecord);
    upsertJob(workspaceRoot, queuedRecord);

    const payload = {
      jobId: job.id,
      status: "queued",
      title: taskTitle,
      summary: taskSummary,
      logFile
    };
    outputCommandResult(
      payload,
      `${taskTitle} started in the background as ${job.id}. Check /gateway:status ${job.id} for progress.\n`,
      options.json
    );
    return;
  }

  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskTitle,
    workspaceRoot,
    jobClass: "task",
    summary: taskSummary,
    write
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        profile: profileResolved,
        model: options.model,
        prompt,
        write,
        harness,
        persona: options.as,
        jobId: job.id,
        jobTitle: taskTitle,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// ---------------------------------------------------------------------------
// Task worker (background)
// ---------------------------------------------------------------------------

async function handleTaskWorker(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["job-id", "profile", "model", "cwd", "harness"],
    booleanOptions: ["write", "no-write"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const config = loadConfig();
  const profile = resolveProfile(request.profile, config);
  const write = request.write !== false;
  const prompt = request.prompt || positionals.join(" ");

  if (!prompt) {
    throw new Error("No prompt in stored job request.");
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );

  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () =>
      executeTaskRun({
        cwd: request.cwd || cwd,
        profile,
        model: request.model,
        prompt,
        write,
        harness: request.harness,
        persona: request.persona,
        jobId: storedJob.id,
        jobTitle: storedJob.title || "Gateway Task",
        onProgress: progress
      }),
    { logFile }
  );
}

// ---------------------------------------------------------------------------
// Status, result, cancel
// ---------------------------------------------------------------------------

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });

  await terminateProcessTreeAsync(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

// ---------------------------------------------------------------------------
// Debate subcommand
// ---------------------------------------------------------------------------

async function handleDebate(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["models", "rounds", "synthesizer", "base", "scope", "cwd"],
    booleanOptions: ["json", "include-diff"]
  });

  const question = positionals.join(" ").trim();
  if (!question) {
    throw new Error("Provide a question or topic to debate.");
  }

  const config = loadConfig();
  const profileNames = options.models
    ? options.models.split(",").map(s => s.trim())
    : getDefaultDebateProfiles(config);

  if (profileNames.length < 2) {
    throw new Error("Debate requires at least 2 profiles. Use --models profile1,profile2 or configure multiple profiles.");
  }

  for (const name of profileNames) {
    resolveProfile(name, config);
  }

  const rounds = options.rounds ? Number(options.rounds) : 3;

  let fullQuestion = question;
  if (options["include-diff"] || options.base || options.scope) {
    const cwd = resolveCommandCwd(options);
    ensureGitRepository(cwd);
    const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
    if (!options.json) console.error(`[debate] Collecting diff context (${target.label})...`);
    const context = collectReviewContext(cwd, target, { includeDiff: options["include-diff"] || undefined });
    fullQuestion = `${question}\n\n${context.content}`;
  }

  const result = await runDebate({
    question: fullQuestion,
    profileNames,
    rounds,
    synthesizerProfile: options.synthesizer || profileNames[0],
    onProgress: (msg) => console.error(msg),
    json: options.json
  });

  if (options.json) {
    outputResult(result, true);
  } else if (typeof result === "string") {
    console.log(result);
  } else {
    console.log(renderDebateOutput(result));
  }
}

function getDefaultDebateProfiles(config) {
  const names = Object.keys(config.profiles || {});
  if (config.defaultProfile && names.includes(config.defaultProfile)) {
    const rest = names.filter(n => n !== config.defaultProfile);
    return [config.defaultProfile, ...rest].slice(0, 2);
  }
  return names.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Job infrastructure helpers
// ---------------------------------------------------------------------------

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: jobClass === "review" ? (kind === "adversarial-review" ? "adversarial-review" : "review") : "task",
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId, request) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gateway-companion.mjs");
  const args = [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId];
  if (request.profile) {
    args.push("--profile", request.profile);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.write === false) {
    args.push("--no-write");
  } else {
    args.push("--write");
  }
  if (request.persona) {
    args.push("--as", request.persona);
  }
  if (request.harness) {
    args.push("--harness", request.harness);
  }

  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

const SUBCOMMANDS = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  debate: handleDebate,
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel
};

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }

  await handler(argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
