// Multi-model debate engine — HTTP-pure, no subprocesses.
// Flow: parallel positions → cross-critique → synthesis.
import { chatCompletion, sanitizeError, testConnectivity } from "./api-client.mjs";
import { loadConfig, resolveProfile } from "./config.mjs";

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

function normalizeBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl;
  }
}

function extractResponseText(completion) {
  return completion?.choices?.[0]?.message?.content ?? "";
}

async function safeCompletion(profile, messages, label, onProgress, callOpts = {}) {
  const { timeoutMs, sem } = callOpts;
  if (sem) await sem.acquire();
  try {
    return extractResponseText(await chatCompletion(profile, messages, { timeoutMs }));
  } catch (err) {
    const msg = sanitizeError(err);
    console.error(`[debate] ${label} failed: ${msg}`);
    if (onProgress) onProgress({ type: "error", label, message: msg });
    return null;
  } finally {
    if (sem) sem.release();
  }
}

export async function runDebate(options) {
  const {
    question,
    profileNames,
    rounds = 3,
    synthesizerProfile: synthName,
    onProgress,
    json = false,
    mode = "relaxed",
    timeoutMs,
    maxConcurrency = 1
  } = options;

  const config = loadConfig();
  const profiles = profileNames.map((n) => resolveProfile(n, config));
  const synthProfile = resolveProfile(synthName || profileNames[0], config);

  const semaphores = new Map();
  const getSemaphore = (baseUrl) => {
    const key = normalizeBaseUrl(baseUrl);
    if (!semaphores.has(key)) semaphores.set(key, new Semaphore(maxConcurrency));
    return semaphores.get(key);
  };

  const quorumRequired = mode === "relaxed"
    ? Math.ceil(profiles.length / 2)
    : profiles.length;

  const progress = (msg) => {
    console.error(`[debate] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  // Round 1 -- Independent positions (parallel)
  progress("Round 1: gathering positions");
  const positions = await Promise.all(
    profiles.map(async (p) => ({
      profile: p.name,
      model: p.defaultModel,
      response: await safeCompletion(
        p,
        [{ role: "user", content: question }],
        `position from ${p.name}`,
        onProgress,
        { timeoutMs, sem: getSemaphore(p.baseUrl) }
      )
    }))
  );

  const validPositions = positions.filter((p) => p.response !== null);
  if (validPositions.length === 0) throw new Error("All debate participants failed to respond");

  if (validPositions.length < quorumRequired) {
    const partial = {
      question,
      positions: validPositions,
      critiques: [],
      synthesis: null,
      synthProfile: null,
      quorum_failed: true,
      quorum: { got: validPositions.length, need: quorumRequired, mode }
    };
    progress(`Quorum not met: ${validPositions.length}/${quorumRequired} (mode=${mode})`);
    return json ? partial : `⚠️ Quorum not met: ${validPositions.length}/${quorumRequired} responses (mode=${mode})\n\n` +
      renderDebateOutput(partial);
  }

  if (rounds < 2) {
    const result = { question, positions: validPositions, critiques: [], synthesis: null, synthProfile: null };
    return json ? result : renderDebateOutput(result);
  }

  // Round 2 -- Cross-critique (parallel per model)
  progress("Round 2: cross-critiques");
  const critiqueJobs = [];
  for (const reviewer of profiles) {
    for (const target of validPositions) {
      if (target.profile === reviewer.name) continue;
      critiqueJobs.push({ reviewer, target });
    }
  }

  const critiques = await Promise.all(
    critiqueJobs.map(async ({ reviewer, target }) => ({
      from: reviewer.name,
      about: target.profile,
      critique: await safeCompletion(
        reviewer,
        [{
          role: "user",
          content: `You previously answered a question. Now critique this alternative answer. Be specific about flaws, gaps, and strengths.\n\nOriginal question: ${question}\n\nAnswer to critique:\n${target.response}`
        }],
        `${reviewer.name} critiques ${target.profile}`,
        onProgress,
        { timeoutMs, sem: getSemaphore(reviewer.baseUrl) }
      )
    }))
  );

  const validCritiques = critiques.filter((c) => c.critique !== null);

  if (rounds < 3) {
    const result = { question, positions: validPositions, critiques: validCritiques, synthesis: null, synthProfile: null };
    return json ? result : renderDebateOutput(result);
  }

  // Round 3 -- Synthesis
  progress("Round 3: synthesis");
  const synthPrompt = [
    "You are synthesizing a multi-model debate.",
    "",
    `Original question: ${question}`,
    "",
    "Positions:",
    ...validPositions.map((p) => `[${p.profile}]: ${p.response}`),
    "",
    "Critiques:",
    ...validCritiques.map((c) => `[${c.from} critiques ${c.about}]: ${c.critique}`),
    "",
    "Synthesize: What is the best answer? What did each model get right and wrong? Give a clear final recommendation."
  ].join("\n");

  const synthesis = await safeCompletion(
    synthProfile,
    [{ role: "user", content: synthPrompt }],
    "synthesis",
    onProgress,
    { timeoutMs, sem: getSemaphore(synthProfile.baseUrl) }
  );

  const result = {
    question,
    positions: validPositions,
    critiques: validCritiques,
    synthesis,
    synthProfile: { name: synthProfile.name, model: synthProfile.defaultModel }
  };

  return json ? result : renderDebateOutput(result);
}

export function renderDebateOutput(result) {
  const { question, positions, critiques, synthesis, synthProfile } = result;
  const models = positions.map((p) => `${p.profile} (${p.model})`).join(", ");
  const roundCount = synthesis ? 3 : critiques.length ? 2 : 1;

  const lines = [
    "# Gateway Debate",
    "",
    `**Question:** ${question}`,
    `**Models:** ${models}`,
    `**Rounds:** ${roundCount}`,
    "",
    "## Round 1 -- Positions",
    ""
  ];

  for (const p of positions) {
    lines.push(`### [${p.profile}] (${p.model})`, "", p.response, "");
  }

  if (critiques.length) {
    lines.push("## Round 2 -- Critiques", "");
    for (const c of critiques) {
      lines.push(`### ${c.from} critiques ${c.about}`, "", c.critique, "");
    }
  }

  if (synthesis) {
    lines.push(
      "## Round 3 -- Synthesis",
      "",
      `**Synthesizer:** ${synthProfile.name} (${synthProfile.model})`,
      "",
      synthesis,
      ""
    );
  }

  return lines.join("\n");
}

export async function preflightProfiles(profileNames, config) {
  const resolvedConfig = config ?? loadConfig();
  const results = await Promise.all(
    profileNames.map(async (name) => {
      const profile = resolveProfile(name, resolvedConfig);
      const result = await testConnectivity(profile);
      return { name, ...result };
    })
  );
  return results;
}
