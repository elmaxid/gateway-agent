// ---------------------------------------------------------------------------
// Rendering utilities for Gateway companion CLI output
// ---------------------------------------------------------------------------

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "warning":
      return 1;
    case "suggestion":
      return 2;
    case "nitpick":
      return 3;
    default:
      return 4;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "suggestion",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: (data.verdict ?? "").trim(),
    summary: (data.summary ?? "").trim(),
    findings: Array.isArray(data.findings) ? data.findings.map((f, i) => normalizeReviewFinding(f, i)) : [],
    next_steps: Array.isArray(data.next_steps)
      ? data.next_steps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : []
  };
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duration / timestamp helpers
// ---------------------------------------------------------------------------

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTimestamp(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Job status formatting
// ---------------------------------------------------------------------------

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

export function formatJobStatus(job) {
  const parts = [`${job.id}: ${job.status ?? "unknown"}`];
  if (job.title) parts.push(job.title);
  if (job.phase && job.phase !== job.status) parts.push(`(${job.phase})`);
  return parts.join(" - ");
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.profileName) {
    lines.push(`  Profile: ${job.profileName}`);
  }
  if (job.model) {
    lines.push(`  Model: ${job.model}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /gateway:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /gateway:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /gateway:review");
    lines.push("  Stricter review: /gateway:adversarial-review");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/gateway:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/gateway:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((a) => `\`${a}\``).join("<br>")} |`
    );
  }
}

// ---------------------------------------------------------------------------
// Setup / profiles rendering
// ---------------------------------------------------------------------------

export function renderSetupReport(payload) {
  const lines = [
    "# Gateway Setup",
    "",
    `Default profile: ${payload.defaultProfile ?? "(none)"}`,
    `Review profile: ${payload.reviewProfile ?? "(default)"}`,
    `Task profile: ${payload.taskProfile ?? "(default)"}`,
    ""
  ];

  if (payload.profiles.length === 0) {
    lines.push("No profiles configured.");
    lines.push("Add one with: /gateway:setup add --profile NAME --url URL --model MODEL");
  } else {
    lines.push("Profiles:");
    for (const p of payload.profiles) {
      const markers = [];
      if (p.name === payload.defaultProfile) markers.push("default");
      if (p.name === payload.reviewProfile) markers.push("review");
      if (p.name === payload.taskProfile) markers.push("task");
      const suffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
      lines.push(`- ${p.name}: ${p.baseUrl} (${p.kind}, model: ${p.defaultModel})${suffix}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderProfilesTable(payload) {
  if (payload.profiles.length === 0) {
    return "No profiles configured.\n";
  }

  const lines = [
    "| Name | URL | Kind | Model | Role |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const p of payload.profiles) {
    const roles = [];
    if (p.name === payload.defaultProfile) roles.push("default");
    if (p.name === payload.reviewProfile) roles.push("review");
    if (p.name === payload.taskProfile) roles.push("task");
    lines.push(
      `| ${escapeMarkdownCell(p.name)} | ${escapeMarkdownCell(p.baseUrl)} | ${escapeMarkdownCell(p.kind)} | ${escapeMarkdownCell(p.defaultModel)} | ${escapeMarkdownCell(roles.join(", ") || "-")} |`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Review output rendering
// ---------------------------------------------------------------------------

export function renderReviewOutput(result, meta) {
  const content = result.content;
  const lines = [
    `# Gateway ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Profile: ${meta.profileName} (${meta.model})`,
    ""
  ];

  if (!result.parsed || typeof content !== "object") {
    // Raw text response
    lines.push(typeof content === "string" ? content : JSON.stringify(content, null, 2));
    if (result.usage) {
      lines.push("", `Tokens: ${result.usage.prompt_tokens ?? "?"} prompt, ${result.usage.completion_tokens ?? "?"} completion`);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(content);
  if (validationError) {
    lines.push(`Returned JSON with unexpected shape: ${validationError}`);
    lines.push("", "Raw response:", "", "```json", JSON.stringify(content, null, 2), "```");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(content);
  const findings = [...data.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  lines.push(`Verdict: ${data.verdict}`);
  lines.push("");
  lines.push(data.summary);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  if (result.usage) {
    lines.push("", `Tokens: ${result.usage.prompt_tokens ?? "?"} prompt, ${result.usage.completion_tokens ?? "?"} completion`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Task result rendering
// ---------------------------------------------------------------------------

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Gateway task did not return output.";
  return `${message}\n`;
}

// ---------------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------------

export function renderStatusReport(report) {
  const lines = [
    "# Gateway Status",
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Gateway Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusTable(jobs) {
  if (jobs.length === 0) {
    return "No jobs.\n";
  }

  const lines = [
    "| Job | Status | Kind | Summary |",
    "| --- | --- | --- | --- |"
  ];

  for (const job of jobs) {
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.kindLabel ?? job.kind ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} |`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Stored job result rendering
// ---------------------------------------------------------------------------

export function renderStoredJobResult(job, storedJob) {
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return output;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const lines = [
    `# ${job.title ?? "Gateway Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Cancel rendering
// ---------------------------------------------------------------------------

export function renderCancelReport(job) {
  const lines = [
    "# Gateway Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/gateway:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
