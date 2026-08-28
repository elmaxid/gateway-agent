// dsh-gateway-agent bundle entry point.
//
// Registers the gateway-workflows skill (how/when to invoke the gateway-companion
// CLI) as one on-demand agent skill named `dsh-gateway-agent`. The skill body is
// this package's SKILL.md; its relative references resolve against the package
// directory through the directory resourceBase, so the agent loads it only when
// a task needs it (progressive disclosure) -- same mechanism as the Codex-side
// gateway-workflows skill (plugins/gateway-codex/skills/gateway-workflows/SKILL.md),
// just wired for DSH's Cordis skill service instead of a Codex .codex-plugin manifest.
//
// The package imports nothing from the harness: it only consumes the `skills`
// service at apply time, so no cordis copy is brought in and the peer
// dependency on `@deepseek-ai/dsh` is metadata-only (optional).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-gateway-agent'
export const inject = ['skills']

const packageRoot = dirname(fileURLToPath(import.meta.url))

/**
 * Strip the YAML frontmatter block from SKILL.md and return the description
 * plus the instruction body. A malformed or missing block fails loud through
 * the read itself or falls back to the full text as the body.
 * @param text - raw SKILL.md content.
 * @returns parsed description (when the frontmatter carries one) and body.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { description: undefined, body: text }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { description: undefined, body: text }
  const meta = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const match = /^description:\s*(.+)$/m.exec(meta)
  return { description: match?.[1]?.trim(), body }
}

/**
 * Register the gateway-workflows skill. Registration is an effect: the disposer
 * returned by `ctx.skills.register()` removes the contribution on unload.
 * @param ctx - Cordis context with the injected `skills` service.
 */
export function apply(ctx) {
  const skillPath = join(packageRoot, 'SKILL.md')
  const { description, body } = splitFrontmatter(readFileSync(skillPath, 'utf8'))
  ctx.effect(() =>
    ctx.skills.register({
      name: 'dsh-gateway-agent',
      source: 'bundled',
      description:
        description
        ?? 'Delegar tareas, reviews, debates y dispatch paralelo a LLMs del gateway (DeepSeek, MiniMax, Ollama, otros) via el CLI gateway-companion.',
      content: body,
      resourceBase: { kind: 'directory', path: packageRoot },
    }),
  )
}
