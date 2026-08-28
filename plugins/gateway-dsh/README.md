# dsh-gateway-agent

Delegate tasks, reviews, and multi-model debates from a DeepSeek Harness (DSH) session to
DeepSeek, MiniMax, Ollama, and other OpenAI-compatible models via the `gateway-companion` CLI —
no MCP server involved, just shell.

## What this is

A DSH bundle plugin (Cordis, no Schemastery config). It registers one on-demand skill
(`dsh-gateway-agent`) that teaches the DSH agent when and how to invoke `gateway-companion`
(`task` / `review` / `debate` / `dispatch`) to delegate work to alternative LLMs configured as
gateway profiles. The agent runs the CLI with its own bash/shell tool — this package only ships
the instructions, not a runtime.

Same design as the Codex-side variant of this plugin:
[`gateway-codex`](https://github.com/elmaxid/gateway-agent/tree/main/plugins/gateway-codex).

## Prerequisite

`gateway-companion` must already be on PATH:

```bash
npm install -g github:elmaxid/gateway-agent
```

## Install

```bash
dsh plugin --profile <your-profile> add dsh-gateway-agent
```

Then restart the profile and verify it loaded:

```bash
dsh --profile <your-profile> --dump-config | grep -A3 'id: dsh-gateway-agent'
```

## Configuration

No Schemastery config, no tunable keys. Gateway profiles (model endpoints, API keys) are
configured separately via `gateway-companion setup`, shared with the Claude Code and Codex
variants of this plugin — see the [project README](https://github.com/elmaxid/gateway-agent).

## Source

Full project: https://github.com/elmaxid/gateway-agent — this package lives at
`plugins/gateway-dsh/` in that monorepo.

## License

MIT
