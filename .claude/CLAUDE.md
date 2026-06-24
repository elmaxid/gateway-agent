# agent-plugin-cc — Gateway Plugin Project

## Setup en máquina nueva

### 1. Instalar el plugin
```bash
claude plugin install /path/to/agent-plugin-cc
```

### 2. Configurar perfiles del gateway
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup add \
  --profile ollama-minimax --url <GATEWAY_URL> --model minimax-agentic \
  --kind claude-gateway --api-key <API_KEY>

node plugins/gateway/scripts/gateway-companion.mjs setup add \
  --profile ollama-deepseek --url <GATEWAY_URL> --model deepseek-research \
  --kind claude-gateway --api-key <API_KEY>

node plugins/gateway/scripts/gateway-companion.mjs setup set-default --profile ollama-minimax
```

### 3. Verificar conectividad
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup list
node plugins/gateway/scripts/gateway-companion.mjs setup test --profile ollama-minimax
node plugins/gateway/scripts/gateway-companion.mjs setup test --profile ollama-deepseek
```

> La config de perfiles vive en `~/.gateway-plugin/config.json` — no se commitea.

---

## Routing rules para este proyecto

| Tarea | Herramienta |
|-------|-------------|
| Code review antes de commit | `/gateway:review --include-diff` |
| Debate arquitectura / decisión técnica | `/gateway:debate --include-diff` |
| Revisión adversarial (2-pass false-positive filter) | `/gateway:adversarial-review --include-diff` |
| Implementación / feature nueva | `gateway:gateway-coder` (codex harness) |
| Debug / investigación de bug | `gateway:gateway-debugger` (codex harness) |
| Exploración de código | `gateway:gateway-researcher` |
| Window transfer a gateway model | `/gateway:transfer` |

**Antes de cada commit**: correr adversarial review con `--include-diff` para validar cambios.

---

## Perfiles configurados

- **ollama-minimax** (`minimax-agentic`) — análisis estructurado, reviews detallados, sintetizador de debates
- **ollama-deepseek** (`deepseek-research`) — razonamiento profundo, debug, segunda opinión técnica

Para cambiar modelo sin recrear perfil:
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup set-model --profile ollama-minimax --model <MODEL>
```

---

## Estructura del proyecto

```
plugins/gateway/
  scripts/
    gateway-companion.mjs     # CLI principal — subcomandos: review, debate, task, setup, status
    lib/
      api-client.mjs          # HTTP hacia endpoints OpenAI-compatible
      debate.mjs              # Motor de debate multi-modelo
      git.mjs                 # Colección de contexto git (diff, stats)
      config.mjs              # Carga/guarda ~/.gateway-plugin/config.json
      claude-subprocess.mjs   # Harness claude (stateless)
      codex-harness.mjs       # Harness codex (stateful threads)
      render.mjs              # Formateo de output
      args.mjs                # Parser de argumentos CLI
      claude-session-transfer.mjs # Parser de transcripts + window transfer
.claude-plugin/
  manifest.json               # Manifiesto del plugin (skills, metadata)
```

---

## Convenciones de desarrollo

- Confirmar plan antes de tocar código (3+ pasos = planificar primero)
- No commitear sin verificar funcionamiento real
- Fix que toca >3 archivos o agrega >50 líneas: replanificar
- Re-leer archivos antes de editar en sesiones largas (context decay)
