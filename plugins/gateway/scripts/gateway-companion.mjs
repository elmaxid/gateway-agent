#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString, validateTimeoutOption } from "./lib/args.mjs";
import { chatCompletion, runDirectReview, testConnectivity, listModels, extractJson } from "./lib/api-client.mjs";
import { runAgenticReview } from "./lib/agentic-review.mjs";
import { runClaudeTask } from "./lib/claude-subprocess.mjs";
import { runTask } from "./lib/codex-harness.mjs";
import { loadTranscript, parseTranscript, buildMessages } from "./lib/claude-session-transfer.mjs";
import { runDebate, renderDebateOutput, preflightProfiles } from "./lib/debate.mjs";
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
import { applyPersona, getValidPersonas, matchPersona } from "./lib/personas.mjs";
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
import {
  parsePlanFile,
  parseInlineTasks,
  parseAssignment,
  parseModelOverrides,
  buildTaskList,
  runDispatch,
  runCrossReview,
  renderDispatchOutput,
} from "./lib/dispatch.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gateway-companion setup <add|remove|list|test|set-default|set-review-profile|set-task-profile|set-model|doctor|models> [args]",
      "  gateway-companion review [--profile NAME] [--model MODEL] [--base REF] [--scope auto|working-tree|branch] [--timeout MS] [--include-diff] [--no-tools] [--json]",
      "  gateway-companion adversarial-review [--profile NAME] [--model MODEL] [--base REF] [--scope auto|working-tree|branch] [--timeout MS] [--include-diff] [--no-tools] [--json] [focus]",
      "  gateway-companion staged-review [--profile NAME] [--model MODEL] [--base REF] [--scope auto|working-tree|branch] [--timeout MS] [--include-diff] [--json] [intent]",
      "  gateway-companion task [--profile NAME] [--model MODEL] [--harness claude|codex] [--as PERSONA] [--background] [--write|--no-write] [--prompt-file FILE] [prompt]",
  `                          PERSONA: ${getValidPersonas().join("|")}`,
      "  gateway-companion task-worker --job-id ID [--profile NAME] [--model MODEL] [--harness claude|codex] [--write|--no-write] [prompt]",
      "  gateway-companion debate [--models P1,P2,...] [--rounds N] [--synthesizer NAME] [--mode relaxed|strict]",
      "                           [--timeout MS] [--max-concurrency N] [--base REF] [--scope auto|working-tree|branch]",
      "                           [--include-diff] [--json] [question]",
      "  gateway-companion dispatch [--plan FILE|--task PROMPT:PROFILE...] [--assign RANGES] [--model-override PROF:MODEL...]",
      "                             [--max-concurrency N] [--timeout MS] [--harness claude|codex] [--write|--no-write]",
      "                             [--cross-review PROFILE] [--cross-review-model MODEL] [--fail-fast] [--dry-run] [--json]",
      "                             [--background (not yet implemented)]",
      "  gateway-companion transfer [--profile NAME] [--turns N] [prompt]",
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

function extractRepeatableFlags(argv) {
  const tasks = [];
  const modelOverrides = [];
  const cleaned = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task" && i + 1 < argv.length) {
      tasks.push(argv[++i]);
    } else if (argv[i] === "--model-override" && i + 1 < argv.length) {
      modelOverrides.push(argv[++i]);
    } else {
      cleaned.push(argv[i]);
    }
  }
  return { tasks, modelOverrides, cleaned };
}

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

    case "doctor": {
      const { options } = parseArgs(rest, { booleanOptions: ["json"] });

      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Config error: ${err.message}`);
        process.exitCode = 2;
        break;
      }

      function checkBinary(name) {
        const r = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 5000 });
        if (r.status === 0) {
          const version = (r.stdout || r.stderr || "").trim().split("\n")[0];
          return { ok: true, version };
        }
        return { ok: false, error: r.error?.code || `exit ${r.status}` };
      }

      const profileNames = Object.keys(config.profiles ?? {});

      // spawnSync is synchronous — run sequentially, NOT in Promise.all
      const claudeCheck = checkBinary("claude");
      const codexCheck  = checkBinary("codex");
      const profileResults = profileNames.length > 0
        ? await preflightProfiles(profileNames, config)
        : [];

      const anyProfileFail = profileResults.some(p => !p.ok);
      if (!claudeCheck.ok || anyProfileFail) process.exitCode = 1;

      const roles = {
        default: config.defaultProfile ?? null,
        review:  config.reviewProfile  ?? null,
        task:    config.taskProfile    ?? null,
      };

      if (options.json) {
        const profilesMap = {};
        for (const p of profileResults) {
          profilesMap[p.name] = {
            ok: p.ok,
            latency_ms: p.latencyMs,
            model: p.model,
            ...(p.error && { error: p.error }),
          };
        }
        const checks = {
          claude: claudeCheck.ok
            ? { ok: true, version: claudeCheck.version }
            : { ok: false, error: claudeCheck.error },
          codex: codexCheck.ok
            ? { ok: true, version: codexCheck.version }
            : { ok: false, warning: "not found — fallback to claude harness active" },
        };
        outputResult({ checks, profiles: profilesMap, roles }, true);
      } else {
        const ok = "✓", fail = "✗", warn = "⚠";
        const lines = [];

        lines.push("[harness]");
        lines.push(`  claude  ${claudeCheck.ok ? ok : fail}  ${claudeCheck.ok ? claudeCheck.version : claudeCheck.error}`);
        lines.push(`  codex   ${codexCheck.ok ? ok : warn}  ${codexCheck.ok ? codexCheck.version : "not found (fallback: claude harness active)"}`);

        lines.push("");
        lines.push("[profiles]");
        if (profileResults.length === 0) {
          lines.push("  (no profiles configured — run `setup add` first)");
        } else {
          const nameW = Math.max(4, ...profileResults.map(p => p.name.length)) + 2;
          lines.push(`  ${"NAME".padEnd(nameW)}  STATUS    LATENCY    MODEL`);
          for (const p of profileResults) {
            const marker = p.name === config.defaultProfile ? " *" : "  ";
            const status = p.ok ? `${ok} OK  ` : `${fail} FAIL`;
            const latency = p.ok ? `${p.latencyMs}ms` : "";
            const model = p.model ?? p.error ?? "";
            lines.push(`  ${(p.name + marker).padEnd(nameW)}  ${status}  ${latency.padEnd(8)}  ${model}`);
          }
        }

        lines.push("");
        lines.push("[roles]");
        lines.push(`  default → ${roles.default ?? "(unset)"}`);
        lines.push(`  review  → ${roles.review  ?? "(unset)"}`);
        lines.push(`  task    → ${roles.task    ?? "(unset)"}`);

        console.log(lines.join("\n"));
      }
      break;
    }

    case "models": {
      const { options } = parseArgs(rest, { valueOptions: ["profile"], booleanOptions: ["json"] });

      let config;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(`Config error: ${err.message}`);
        process.exitCode = 2;
        break;
      }

      let profile;
      try {
        profile = resolveProfile(options.profile, config);
      } catch (err) {
        console.error(`Profile error: ${err.message}`);
        process.exitCode = 2;
        break;
      }

      let models;
      try {
        models = await listModels(profile);
      } catch (err) {
        console.error(`Failed to list models from ${profile.baseUrl}: ${err.message}`);
        process.exitCode = 1;
        break;
      }

      const payload = {
        profile:          profile.name,
        endpoint:         profile.baseUrl,
        configured_model: profile.defaultModel,
        models,
      };

      if (options.json) {
        outputResult(payload, true);
      } else {
        if (models.length === 0) {
          console.log(`No models returned by ${profile.name} (${profile.baseUrl})`);
        } else {
          console.log(`Models available at ${profile.name} (${profile.baseUrl}):`);
          for (const m of models) {
            const marker = m === profile.defaultModel ? "  ← configured" : "";
            console.log(`  ${m}${marker}`);
          }
        }
      }
      break;
    }

    default:
      throw new Error(`Unknown setup action: ${action}. Use add, remove, list, test, set-default, set-review-profile, set-task-profile, set-model, doctor, or models.`);
  }
}

// ---------------------------------------------------------------------------
// Review subcommand
// ---------------------------------------------------------------------------

export async function executeReviewRun(request) {
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
      response_format: { type: "json_object" },
      timeoutMs: request.timeoutMs
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

  // maxTime is a soft deadline checked between tool-loop iterations, not a hard cutoff.
  // Worst-case wall-clock ceiling: maxTime + 4×timeoutMs — the call already in flight
  // when the deadline is crossed (+timeoutMs), plus the main loop's own terminal-turn
  // retry-on-malformed-output before falling through to forceFinish (+timeoutMs), plus
  // forceFinish()'s own call with its one retry-on-malformed-output (+2×timeoutMs).
  const { content, messages: msgHistory, ok: contentOk } = await runAgenticReview(profile, request.cwd, target, {
    model,
    maxIterations: 10,
    maxTime: request.timeoutMs ? Math.max(120_000, request.timeoutMs * 2) : 120_000,
    timeoutMs: request.timeoutMs,
  });

  if (!contentOk) {
    const RAW_OUTPUT_LIMIT = 4000;
    const truncatedContent = content.length > RAW_OUTPUT_LIMIT
      ? `${content.slice(0, RAW_OUTPUT_LIMIT)}\n... [truncated, ${content.length} bytes total]`
      : content;
    const rendered = [
      `# Gateway Review — FAILED`,
      ``,
      `Target: ${target.label}`,
      `Profile: ${profile.name} (${model})`,
      ``,
      `${profile.name} returned malformed output twice in a row instead of a valid JSON review or a structured tool call (retried automatically once). This is not a review — treat this run as failed, not completed.`,
      ``,
      `Raw model output:`,
      "```",
      truncatedContent,
      "```",
    ].join("\n");
    return {
      exitStatus: 1,
      payload: {
        review: "Review",
        target,
        profile: profile.name,
        model,
        usage: null,
        result: content,
        messages: msgHistory,
        error: "malformed_model_output",
      },
      rendered,
      summary: `Review failed: ${profile.name} returned malformed output twice`,
      jobTitle: "Gateway Review",
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const { value: parsed } = extractJson(content);

  const rendered = renderReviewOutput(
    { content: parsed ?? content, model, usage: null, parsed: true },
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
    valueOptions: ["profile", "model", "base", "scope", "cwd", "timeout"],
    booleanOptions: ["json", "include-diff", "no-tools"],
    aliasMap: { m: "model", p: "profile" }
  });

  const timeoutMs = validateTimeoutOption(options.timeout, "timeout");

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
        timeoutMs,
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
    response_format: { type: "json_object" },
    timeoutMs: request.timeoutMs
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
    response_format: { type: "json_object" },
    timeoutMs: request.timeoutMs
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
    valueOptions: ["profile", "model", "base", "scope", "cwd", "timeout"],
    booleanOptions: ["json", "include-diff", "no-tools"],
    aliasMap: { m: "model", p: "profile" }
  });

  const timeoutMs = validateTimeoutOption(options.timeout, "timeout");

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
        timeoutMs,
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
        persona: (() => {
          if (options.as === "auto") {
            const matched = matchPersona(prompt);
            if (matched) {
              process.stderr.write(`[task] auto-matched persona: ${matched}\n`);
            }
            return matched ?? undefined;
          }
          return options.as;
        })(),
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
    valueOptions: ["models", "rounds", "synthesizer", "base", "scope", "cwd", "mode", "timeout", "max-concurrency"],
    booleanOptions: ["json", "include-diff"]
  });

  const question = positionals.join(" ").trim();
  if (!question) {
    throw new Error("Provide a question or topic to debate.");
  }

  const timeoutMs = validateTimeoutOption(options.timeout, "timeout");
  if (options["max-concurrency"] !== undefined && (!Number.isInteger(Number(options["max-concurrency"])) || Number(options["max-concurrency"]) < 1)) {
    throw new Error(`Invalid --max-concurrency "${options["max-concurrency"]}". Expected an integer >= 1.`);
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
  const mode = options.mode || "relaxed";

  // Pre-flight health check — includes synthesizer if different from debate profiles
  const synthesizerName = options.synthesizer || profileNames[0];
  const allProfilesToCheck = [...new Set([...profileNames, synthesizerName])];

  if (!options.json) console.error("[debate] Running preflight health check...");
  const health = await preflightProfiles(allProfilesToCheck, config, timeoutMs);
  const unhealthy = health.filter((h) => !h.ok);

  if (unhealthy.length > 0) {
    for (const h of unhealthy) {
      console.error(`[debate] ⚠️ ${h.name}: ${h.error}`);
    }
  }

  const synthHealth = health.find((h) => h.name === synthesizerName);
  if (synthHealth && !synthHealth.ok && rounds >= 3) {
    throw new Error(
      `Preflight failed: synthesizer profile "${synthesizerName}" is unreachable. ` +
      `Cannot complete Round 3 synthesis. Error: ${synthHealth.error}`
    );
  }

  const healthyDebate = health.filter((h) => h.ok && profileNames.includes(h.name));
  const quorumRequired = mode === "relaxed"
    ? Math.ceil(profileNames.length / 2)
    : profileNames.length;

  if (healthyDebate.length < quorumRequired) {
    throw new Error(
      `Preflight failed: ${healthyDebate.length}/${profileNames.length} debate profiles reachable, ` +
      `need ${quorumRequired} (mode=${mode}). ` +
      `Unreachable: ${unhealthy.filter(h => profileNames.includes(h.name)).map((h) => h.name).join(", ")}`
    );
  }

  const activeProfileNames = healthyDebate.map((h) => h.name);
  if (activeProfileNames.length < profileNames.length && !options.json) {
    console.error(`[debate] Continuing with ${activeProfileNames.length} healthy profiles: ${activeProfileNames.join(", ")}`);
  }

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
    profileNames: activeProfileNames,
    rounds,
    synthesizerProfile: synthesizerName,
    onProgress: (msg) => console.error(msg),
    json: options.json,
    mode,
    timeoutMs,
    maxConcurrency: options["max-concurrency"] !== undefined ? Number(options["max-concurrency"]) : undefined
  });

  if (options.json) {
    outputResult(result, true);
  } else if (typeof result === "string") {
    console.log(result);
  } else {
    console.log(renderDebateOutput(result));
  }
}

// ---------------------------------------------------------------------------
// Staged-review subcommand — 2-phase review
// ---------------------------------------------------------------------------

const PHASE1_SYSTEM = `You are a spec compliance reviewer. Given a diff and optional description of intent, evaluate whether the code changes match the stated goals. Check for:
1. Missing functionality described in the intent
2. Extra functionality not mentioned in the intent (scope creep)
3. Incomplete implementations (TODOs, stubs, half-finished logic)
4. Mismatch between commit message/PR description and actual changes

Return a JSON object: { "phase": "spec-compliance", "verdict": "pass"|"partial"|"fail", "findings": [{ "severity": "critical"|"warning"|"suggestion", "file": "path", "description": "..." }], "summary": "..." }`;

async function handleStagedReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["profile", "model", "base", "scope", "cwd", "timeout"],
    booleanOptions: ["json", "include-diff"],
    aliasMap: { p: "profile", m: "model" }
  });

  const timeoutMs = validateTimeoutOption(options.timeout, "timeout");

  const description = positionals.join(" ").trim();
  const config = loadConfig();
  const profile = resolveProfile(
    options.profile || resolveReviewProfile(config)?.name || config.defaultProfile,
    config
  );
  const model = options.model || undefined;
  const cwd = resolveCommandCwd(options);

  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  if (!options.json) console.error("[staged-review] Collecting diff context...");
  const context = collectReviewContext(cwd, target, {
    includeDiff: options["include-diff"] || undefined
  });

  const userContent = description
    ? `Intent: ${description}\n\n${context.content}`
    : context.content;

  // Phase 1: Spec compliance
  if (!options.json) console.error("[staged-review] Phase 1: spec compliance...");
  const phase1 = await runDirectReview(profile, PHASE1_SYSTEM, userContent, { model, timeoutMs });

  // Phase 2: Adversarial code quality (reuse existing prompts)
  if (!options.json) console.error("[staged-review] Phase 2: code quality (first pass)...");
  const pass1 = await runDirectReview(profile, REVIEW_SYSTEM_PROMPT, userContent, { model, timeoutMs });

  if (!options.json) console.error("[staged-review] Phase 2: adversarial filter...");
  const pass1Str = typeof pass1.content === "string"
    ? pass1.content
    : JSON.stringify(pass1.content, null, 2);
  const changedFilesList = context.changedFiles?.length > 0
    ? context.changedFiles.join("\n")
    : "(no files listed)";
  const adversarialPrompt = `Original review findings:\n${pass1Str}\n\nChanged files (${context.fileCount}):\n${changedFilesList}\n\nContext: ${context.summary}`;
  const pass2 = await runDirectReview(profile, ADVERSARIAL_SYSTEM_PROMPT, adversarialPrompt, { model, timeoutMs });

  const result = {
    phase1: { ...phase1, type: "spec-compliance" },
    phase2: { type: "code-quality-adversarial", firstPass: pass1, filtered: pass2 },
    meta: { profile: profile.name, model: model || profile.defaultModel, target: target.label }
  };

  if (options.json) {
    outputResult(result, true);
  } else {
    console.log("# Staged Review\n");
    console.log("## Phase 1: Spec Compliance\n");
    console.log(typeof phase1.content === "string" ? phase1.content : JSON.stringify(phase1.content, null, 2));
    console.log("\n## Phase 2: Code Quality (Adversarial)\n");
    console.log("### First Pass\n");
    console.log(typeof pass1.content === "string" ? pass1.content : JSON.stringify(pass1.content, null, 2));
    console.log("\n### Adversarial Filter\n");
    console.log(typeof pass2.content === "string" ? pass2.content : JSON.stringify(pass2.content, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Dispatch subcommand
// ---------------------------------------------------------------------------

async function handleDispatch(argv) {
  const { tasks: rawTaskArgs, modelOverrides: rawOverrides, cleaned } = extractRepeatableFlags(argv);
  const { options, positionals } = parseCommandInput(cleaned, {
    valueOptions: ["plan", "assign", "max-concurrency", "timeout", "harness", "cross-review", "cross-review-model", "cwd"],
    booleanOptions: ["json", "write", "no-write", "fail-fast", "dry-run", "background"],
  });

  const timeoutMs = validateTimeoutOption(options.timeout, "timeout");
  const cwd = resolveCommandCwd(options);

  if (options.background) {
    console.error("[dispatch] Note: --background is not yet implemented; running in foreground.");
  }

  // --- Validation (exit code 2 per §3.2) ---
  function validationError(msg) { process.exitCode = 2; throw new Error(msg); }

  const hasPlan = Boolean(options.plan);
  const hasTasks = rawTaskArgs.length > 0;
  if (hasPlan && hasTasks) validationError("--plan and --task are mutually exclusive. Use one, not both.");
  if (!hasPlan && !hasTasks) validationError("Provide --plan <file> or at least one --task.");
  if (options.assign && !hasPlan) validationError("--assign is only valid with --plan.");

  const maxConcurrency = options["max-concurrency"] !== undefined ? Number(options["max-concurrency"]) : 3;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    validationError(`Invalid --max-concurrency "${options["max-concurrency"]}". Expected 1-16.`);
  }

  const harness = options.harness || "codex";
  if (!["claude", "codex"].includes(harness)) {
    validationError(`Unknown --harness "${harness}". Valid: claude, codex.`);
  }

  const write = options["no-write"] ? false : true;
  const config = loadConfig();
  let defaultProfile;
  try {
    defaultProfile = resolveTaskProfile(config);
  } catch (err) {
    validationError(err.message);
  }

  // --- Parse input ---
  let rawTasks;
  if (hasPlan) {
    const planPath = path.resolve(cwd, options.plan);
    const content = fs.readFileSync(planPath, "utf8");
    rawTasks = parsePlanFile(content);
  } else {
    rawTasks = parseInlineTasks(rawTaskArgs, defaultProfile.name);
  }

  const assignment = options.assign ? parseAssignment(options.assign, rawTasks.length) : null;
  const overrides = rawOverrides.length > 0 ? parseModelOverrides(rawOverrides) : null;
  const tasks = buildTaskList(rawTasks, assignment, overrides, defaultProfile.name);

  // --- Resolve and validate all profiles ---
  // Covers every profile name that will actually be used: --task prompt:profile,
  // --assign mappings, and --model-override profile:model all flow into
  // tasks[].profile via buildTaskList(); the --cross-review profile is added
  // explicitly below. Per spec §3.1, every one of these must exist in config
  // AND have kind === "claude-gateway" — checked here, in preflight, before
  // any task starts executing.
  const profileNames = [...new Set(tasks.map((t) => t.profile).filter(Boolean))];
  if (options["cross-review"]) profileNames.push(options["cross-review"]);
  for (const name of profileNames) {
    let profile;
    try {
      profile = resolveProfile(name, config);
    } catch (err) {
      validationError(err.message);
    }
    if (profile.kind !== "claude-gateway") {
      validationError(`Profile "${name}" has kind "${profile.kind}" — dispatch requires kind "claude-gateway".`);
    }
  }

  // --- Dry run ---
  if (options["dry-run"]) {
    const matrix = tasks.map((t) => ({ id: t.id, prompt: shorten(t.prompt, 80), profile: t.profile, model: t.model || "(default)" }));
    if (options.json) {
      outputResult({ dryRun: true, tasks: matrix, crossReview: options["cross-review"] || null }, true);
    } else {
      console.log("Dispatch dry-run:");
      for (const t of matrix) console.log(`  Task ${t.id}: ${t.prompt} → ${t.profile}/${t.model}`);
      if (options["cross-review"]) console.log(`  Cross-review: ${options["cross-review"]}`);
    }
    return;
  }

  // --- Preflight ---
  ensureGitRepository(cwd);

  // §2.0: warn on dirty working tree (use spawnSync — already imported, unlike execSync)
  const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).stdout.trim();
  if (porcelain) {
    console.error("[dispatch] ⚠ Working tree has uncommitted changes. Worktrees are created from HEAD; uncommitted changes are not included.");
  }

  if (!options.json) console.error("[dispatch] Preflight: checking profiles...");
  const health = await preflightProfiles(profileNames, config, timeoutMs);
  const unhealthy = health.filter((h) => !h.ok);
  if (unhealthy.length > 0) {
    const names = unhealthy.map((h) => `${h.name}: ${h.error}`).join("; ");
    process.exitCode = 2;
    throw new Error(`Preflight failed: ${names}`);
  }

  if (harness === "codex") {
    const { isCodexAvailable } = await import("./lib/codex-harness.mjs");
    if (!await isCodexAvailable()) {
      process.exitCode = 2;
      throw new Error("--harness codex requires codex CLI. Install: npm i -g @anthropic-ai/codex");
    }
  }

  // --- Execute ---
  if (!options.json) console.error(`[dispatch] Starting ${tasks.length} tasks across ${new Set(tasks.map((t) => t.profile)).size} profiles (max-concurrency: ${maxConcurrency}/endpoint)`);

  const resolveProfileFn = (name) => resolveProfile(name, config);
  const taskRunnerFn = harness === "codex" ? runTask : runClaudeTask;

  const result = await runDispatch(tasks, {
    cwd,
    harness,
    write,
    maxConcurrency,
    timeoutMs,
    failFast: options["fail-fast"],
    taskRunner: taskRunnerFn,
    resolveProfileFn,
    onProgress: options.json ? null : (evt) => console.error(`[dispatch] ${evt.message}`),
  });

  // --- Cross-review ---
  if (options["cross-review"]) {
    const reviewProfile = resolveProfile(options["cross-review"], config);
    if (!options.json) console.error(`[dispatch] Cross-review: ${result.tasks.filter((t) => t.status === "completed" && !t.noChanges).length} tasks by ${reviewProfile.name}`);

    // Read patches for review input
    for (const task of result.tasks) {
      if (task.patchFile && fs.existsSync(task.patchFile)) {
        task.patch = fs.readFileSync(task.patchFile, "utf8");
      }
    }

    await runCrossReview(result.tasks, {
      reviewProfile,
      reviewModel: options["cross-review-model"],
      timeoutMs,
      maxConcurrency,
      reviewFn: runDirectReview,
      onProgress: options.json ? null : (evt) => console.error(`[dispatch] ${evt.message}`),
      outputDir: result.outputDir,
    });

    // Update manifest with review data
    const manifestPath = path.join(result.outputDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.tasks = result.tasks;
    const totalFindings = result.tasks.reduce((sum, t) => sum + (t.review?.findings?.length ?? 0), 0);
    manifest.summary.reviewFindings = totalFindings;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    result.summary.reviewFindings = totalFindings;
  }

  // --- Output ---
  if (options.json) {
    outputResult(result, true);
  } else {
    console.log(renderDispatchOutput(result));
  }

  if (result.summary.failed > 0) process.exitCode = 1;
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
// Transfer subcommand
// ---------------------------------------------------------------------------

async function handleTransfer(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["profile", "turns"],
    aliasMap: { p: "profile" }
  });

  try {
    const transcriptPath = process.env.GATEWAY_TRANSCRIPT_PATH;
    const raw = loadTranscript(transcriptPath);
    const turns = parseTranscript(raw);
    const transferPrompt = positionals.join(" ") || "Continue from where we left off.";
    const maxTurns = Math.max(1, parseInt(options.turns, 10) || 30);
    const messages = buildMessages(turns, { maxTurns, transferPrompt });

    const config = loadConfig();
    const profile = resolveProfile(options.profile, config);

    process.stderr.write(
      `[gateway:transfer] ${turns.length} turns parsed, ${Math.min(turns.length, maxTurns)} sent to ${profile.defaultModel}\n`
    );

    const response = await chatCompletion(profile, messages);
    const content = response.choices?.[0]?.message?.content ?? "";
    if (!content) {
      process.stderr.write(`[gateway:transfer] empty response from ${profile.defaultModel} — check gateway endpoint\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(content + "\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gateway:transfer] ${message}\n`);
    process.exitCode = 1;
  }
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
  "staged-review": handleStagedReview,
  dispatch: handleDispatch,
  task: handleTask,
  "task-worker": handleTaskWorker,
  debate: handleDebate,
  transfer: handleTransfer,
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
  // Preserve a more specific exit code a handler already set (e.g. dispatch's
  // validation/preflight errors use 2) instead of always forcing 1.
  process.exitCode = process.exitCode || 1;
});
