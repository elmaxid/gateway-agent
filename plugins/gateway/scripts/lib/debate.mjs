// Multi-model debate engine — HTTP-pure, no subprocesses.
// Flow: parallel positions → cross-critique → synthesis.
import { chatCompletion } from "./api-client.mjs";
import { loadConfig, resolveProfile } from "./config.mjs";

function extractResponseText(completion) {
  return completion?.choices?.[0]?.message?.content ?? "";
}

function sanitizeError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

async function safeCompletion(profile, messages, label, onProgress) {
  try {
    return extractResponseText(await chatCompletion(profile, messages));
  } catch (err) {
    const msg = sanitizeError(err);
    console.error(`[debate] ${label} failed: ${msg}`);
    if (onProgress) onProgress({ type: "error", label, message: msg });
    return null;
  }
}

export async function runDebate(options) {
  const {
    question,
    profileNames,
    rounds = 3,
    synthesizerProfile: synthName,
    onProgress,
    json = false
  } = options;

  const config = loadConfig();
  const profiles = profileNames.map((n) => resolveProfile(n, config));
  const synthProfile = resolveProfile(synthName || profileNames[0], config);

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
        onProgress
      )
    }))
  );

  const validPositions = positions.filter((p) => p.response !== null);
  if (validPositions.length === 0) throw new Error("All debate participants failed to respond");

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
        onProgress
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
    onProgress
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
