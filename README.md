# gateway-plugin-cc

Claude Code plugin que delega code reviews y tareas a endpoints LLM alternativos (Ollama, gateways custom) usando la API compatible con OpenAI.

## Qué hace

Agrega 9 comandos `/gateway:*` a Claude Code. Cuatro operaciones principales:

| Operación | Backend | Cuándo usar |
|-----------|---------|-------------|
| **Review** | HTTP directo a `/v1/chat/completions` | Revisar código rápido, sin overhead |
| **Task** | Subprocess `claude -p` o `codex exec` (dual-harness) | Delegación completa con herramientas |
| **Work** | Auto-routing → persona especializada | Detecta tipo de tarea por keywords |
| **Debate** | HTTP paralelo multi-modelo | Posiciones independientes + crítica cruzada + síntesis |

La diferencia clave con otros plugins: no hay broker ni servidor. Reviews van por HTTP directo. Tasks spawnan un proceso aislado apuntando al endpoint configurado.

### Personas especializadas

4 subagentes con prompt-shaping por dominio y harness óptimo:

| Persona | Dominio | Harness | Modo |
|---------|---------|---------|------|
| `gateway-coder` | Implementación, refactoring | codex (stateful) | write |
| `gateway-debugger` | Bugs, test failures | codex (stateful) | write |
| `gateway-reviewer` | Code review, audit | claude (stateless) | read-only |
| `gateway-researcher` | Research, exploración | claude (stateless) | read-only |

### Dual-harness

| Harness | Comando | Ventaja |
|---------|---------|---------|
| **claude** | `claude -p --bare` | Stateless, rápido, 0 overhead |
| **codex** | `codex exec --json` | Threads persistentes, reasoning traces, sandbox real |

Si codex no está instalado, fallback automático a claude.

## Requisitos

- **Node.js** ≥ 18.18.0
- **Claude Code CLI** (cualquier versión con soporte de plugins)
- Al menos un endpoint compatible con OpenAI (Ollama, gateway custom, etc.)
- **Opcional:** [Codex CLI](https://github.com/openai/codex) para el harness codex (si no está, usa claude subprocess como fallback)
  > ⚠️ **Nota:** Codex requiere que el directorio de trabajo sea un repositorio git. Si no lo es, ejecutar `git init` antes de usar harness codex.

## Instalación

### Opción 1: Directo desde GitHub (recomendado)

```bash
claude plugin marketplace add https://github.com/elmaxid/gateway-agent.git
claude plugin install gateway@agent-gateway
```

Reiniciar Claude Code para que cargue los comandos `/gateway:*`.

### Opción 2: Desde clon local

```bash
git clone https://github.com/elmaxid/gateway-agent.git
cd gateway-agent
claude plugin marketplace add "$(pwd)"
claude plugin install gateway@agent-gateway
```

Reiniciar Claude Code.

### Verificar instalación

Dentro de Claude Code:
```
/gateway:setup list
```

Debe responder (vacío si es primera vez, o con perfiles si ya configuraste).

## Configuración inicial

Hay un `config.example.json` en la raíz del repo con la estructura completa. Dos formas de configurar:

### Opción A: copiar config de ejemplo

```bash
mkdir -p ~/.gateway-plugin
cp config.example.json ~/.gateway-plugin/config.json
chmod 600 ~/.gateway-plugin/config.json
# editar con tus URLs, modelos y keys
```

### Opción B: configurar vía comandos (recomendado)

Desde Claude Code, usar `/gateway:setup add` para cada endpoint (ver ejemplos abajo).

### Agregar un perfil Ollama

```
/gateway:setup add --profile ollama-minimax --url http://192.0.2.20:11434 --model minimax-m3:cloud --kind claude-gateway
```

### Agregar un perfil con autenticación

```
/gateway:setup add --profile mi-gateway --url http://192.0.2.10:20128 --model ollamacloud/deepseek-v4-pro --kind claude-gateway --auth-token sk-...
```

### Listar perfiles configurados

```
/gateway:setup list
```

### Probar conectividad

```
/gateway:setup test --profile ollama-minimax
```

### Establecer perfil por defecto

```
/gateway:setup set-default --profile ollama-minimax
```

### Configurar perfiles separados para review y task

```
/gateway:setup set-review-profile --profile gateway-flash
/gateway:setup set-task-profile --profile ollama-minimax
```

### Cambiar modelo de un perfil (sin remove+add)

```
/gateway:setup set-model --profile ollama-minimax --model minimax-m3:cloud-v2
/gateway:setup set-model --profile gateway-deepseek --model deepseek-v4-pro:latest
```

## Perfiles: `claude-gateway` vs `openai-chat`

| Kind | Reviews | Tasks | Cuándo usar |
|------|---------|-------|-------------|
| `claude-gateway` | ✓ | ✓ | Endpoints que pueden actuar como backend de Claude CLI |
| `openai-chat` | ✓ | ✗ | Solo HTTP directo, sin subprocess delegation |

Para tasks (`/gateway:task`), el perfil **debe** ser `kind: claude-gateway`. Los perfiles `openai-chat` solo sirven para reviews.

### Cómo funciona `claude-gateway`

El subprocess hereda estas variables del perfil:
- `ANTHROPIC_BASE_URL` → URL del endpoint
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` → credenciales
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` → habilita traducción Anthropic→OpenAI en Claude CLI

Sin `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` el subprocess no puede conectar al endpoint alternativo.

## Comandos

### `/gateway:review`

Review del diff actual usando el LLM configurado.

```
/gateway:review
/gateway:review --profile gateway-flash
/gateway:review --profile ollama-minimax --model minimax-m3:cloud
/gateway:review --base main --head HEAD
/gateway:review --scope branch
/gateway:review --json
```

**Flags:**
- `--profile NAME` — perfil a usar (default: perfil configurado como reviewProfile, o defaultProfile)
- `--model MODEL` — override del modelo
- `--base REF` — ref base para el diff
- `--head REF` — ref head para el diff
- `--scope auto|working-tree|branch` — qué diff revisar
- `--include-diff` — fuerza inclusión del diff completo en el prompt aunque el repo sea grande (bypassa el límite de 2 archivos por defecto)
- `--json` — output estructurado JSON

**Output:** Structured review con `verdict` (`approve|request-changes|comment`), findings con severity (`critical|warning|suggestion|nitpick`), recomendaciones.

---

### `/gateway:adversarial-review`

Review de dos pasadas: primera encuentra issues, segunda filtra falsos positivos.

```
/gateway:adversarial-review
/gateway:adversarial-review --profile ollama-minimax "focus en seguridad"
/gateway:adversarial-review --base main
/gateway:adversarial-review --include-diff "verificar cambios de seguridad"
```

Mismos flags que `/gateway:review` (incluyendo `--include-diff`). Más lento pero más preciso — útil antes de merge a main.

---

### `/gateway:task`

Delega una tarea al LLM via subprocess. Soporta dual-harness (claude o codex).

```
/gateway:task "explica qué hace este proyecto"
/gateway:task --background "encuentra todos los TODOs en el código"
/gateway:task --profile gateway-deepseek "implementa tests para api-client.mjs"
/gateway:task --no-write "analiza la arquitectura sin hacer cambios"
/gateway:task --harness codex "debug este test que falla"
```

**Flags:**
- `--background` — lanza en background, retorna job ID inmediatamente
- `--wait` — foreground bloqueante (default)
- `--profile NAME` — perfil a usar (debe ser `claude-gateway`)
- `--model MODEL` — override del modelo
- `--harness claude|codex` — harness de ejecución (default: claude). Codex ofrece threads persistentes y sandbox real
- `--write` — permite escritura de archivos (default)
- `--no-write` — modo lectura, sin edits

**Foreground:** Stream del output del subprocess en tiempo real.

**Background:** Retorna `task-XXXXX-YYYYYY`. Usar `/gateway:status` y `/gateway:result` para seguimiento.

---

### `/gateway:work`

Auto-routing inteligente. Detecta el tipo de tarea por keywords y delega a la persona especializada correcta.

```
/gateway:work "encontrá el bug en api-client.mjs"           → gateway-debugger
/gateway:work "implementá tests para config.mjs"             → gateway-coder
/gateway:work "analizá la arquitectura de este proyecto"     → gateway-researcher
/gateway:work "revisá el PR diff"                             → gateway-reviewer
```

El routing es determinístico por keywords, no por LLM. Pasa `--profile`, `--model`, `--harness` al agente seleccionado.

---

### `/gateway:debate`

Debate multi-modelo entre endpoints configurados. HTTP puro, sin subprocesses.

```
/gateway:debate "¿usar sqlite o postgres para este proyecto?"
/gateway:debate --models gateway-deepseek,ollama-minimax "arquitectura propuesta"
/gateway:debate --rounds 2 --synthesizer gateway-deepseek "REST vs GraphQL"
/gateway:debate --json "mejor approach para caching"
/gateway:debate --include-diff "revisar estos cambios entre los modelos"
/gateway:debate --include-diff --base main "¿estos cambios tienen problemas de seguridad?"
```

**Flags:**
- `--models profile1,profile2` — perfiles a usar (default: primeros 2 configurados)
- `--rounds N` — número de rondas (default: 3)
- `--synthesizer PROFILE` — perfil para síntesis final (default: primer perfil)
- `--include-diff` — inyecta el diff del working tree en la pregunta (requiere repo git)
- `--base REF` — ref base para el diff (implica inclusión de contexto git)
- `--scope auto|working-tree|branch` — qué diff incluir
- `--json` — output estructurado

**Flujo:** Round 1 (posiciones paralelas) → Round 2 (crítica cruzada) → Round 3 (síntesis).

---

### `/gateway:status`

Muestra estado de jobs en la sesión actual.

```
/gateway:status
/gateway:status task-mpx1vsel-84ta3y
/gateway:status --all
/gateway:status --json
```

**Output:**
```
| Job ID                  | Status    | Kind | Duration | Summary              |
|-------------------------|-----------|------|----------|----------------------|
| task-mpx5a9tt-6y65u1   | completed | task | 9s       | ## Archivos .mjs ... |
```

---

### `/gateway:result`

Recupera el resultado completo de un job terminado.

```
/gateway:result task-mpx5a9tt-6y65u1
```

Incluye output completo del modelo, incluyendo texto, código, y cualquier artefacto generado.

---

### `/gateway:cancel`

Cancela un job en ejecución.

```
/gateway:cancel task-mpx5a9tt-6y65u1
```

Envía SIGTERM al proceso, escala a SIGKILL si no termina en 2s.

---

## Archivo de configuración

Guardado en `~/.gateway-plugin/config.json` (o `$CLAUDE_PLUGIN_DATA/config.json`).

```json
{
  "profiles": {
    "ollama-minimax": {
      "kind": "claude-gateway",
      "baseUrl": "http://192.0.2.20:11434",
      "defaultModel": "minimax-m3:cloud",
      "authToken": "ollama"
    },
    "gateway-deepseek": {
      "kind": "claude-gateway",
      "baseUrl": "http://192.0.2.10:20128",
      "defaultModel": "ollamacloud/deepseek-v4-pro",
      "apiKey": "sk-..."
    },
    "gateway-flash": {
      "kind": "openai-chat",
      "baseUrl": "http://192.0.2.10:20128",
      "defaultModel": "ollamacloud/deepseek-v4-flash",
      "apiKey": "sk-..."
    }
  },
  "defaultProfile": "ollama-minimax",
  "reviewProfile": null,
  "taskProfile": null
}
```

El archivo tiene permisos `0o600` (solo lectura para el owner).

## Prefijos de modelos en gateways

Algunos gateways requieren prefijos especiales en el nombre del modelo:

```
ollamacloud/deepseek-v4-pro      # gateway custom con OllamaCloud
minimax-m3:cloud                  # Ollama directo
chat                              # modelo base del gateway
```

Para descubrir modelos disponibles en un endpoint:

```bash
curl http://TU_GATEWAY/v1/models -H "Authorization: Bearer TU_TOKEN"
```

## Estructura del proyecto

```
/opt/agent-plugin-cc/
├── .claude-plugin/marketplace.json      # Manifiesto del marketplace
├── package.json
├── plugins/gateway/
│   ├── .claude-plugin/plugin.json       # Manifiesto del plugin
│   ├── commands/                        # 9 comandos slash
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── task.md
│   │   ├── work.md                     # Auto-routing por keywords → persona correcta
│   │   ├── debate.md                   # Debate multi-modelo HTTP puro
│   │   ├── setup.md
│   │   ├── status.md
│   │   ├── result.md
│   │   └── cancel.md
│   ├── agents/
│   │   ├── gateway-rescue.md            # Subagente forwarding genérico (fallback)
│   │   ├── gateway-coder.md             # Implementación/refactoring (codex harness)
│   │   ├── gateway-debugger.md          # Debug/test failures (codex harness)
│   │   ├── gateway-reviewer.md          # Code review/audit (claude harness, read-only)
│   │   └── gateway-researcher.md        # Research/exploración (claude harness, read-only)
│   ├── hooks/hooks.json                 # SessionStart / SessionEnd / Stop
│   ├── prompts/
│   │   ├── adversarial-review.md        # Template prompt segunda pasada
│   │   └── stop-review-gate.md
│   ├── skills/
│   │   ├── gateway-cli-runtime/SKILL.md # Skill interno (contrato de runtime)
│   │   └── gateway-prompt-shaper/SKILL.md # Enriquecimiento de prompts por dominio
│   └── scripts/
│       ├── gateway-companion.mjs        # CLI principal (~1000 líneas)
│       ├── session-lifecycle-hook.mjs   # Limpieza de jobs al cerrar sesión
│       ├── stop-review-gate-hook.mjs    # Espera jobs activos en Stop
│       └── lib/
│           ├── api-client.mjs           # HTTP + SSE streaming (OpenAI-compat)
│           ├── claude-subprocess.mjs    # Spawn claude -p con env custom
│           ├── codex-harness.mjs       # Spawn codex exec (harness alternativo)
│           ├── debate.mjs              # Motor de debate multi-modelo HTTP
│           ├── config.mjs               # Sistema de perfiles multi-endpoint
│           ├── args.mjs                 # Parser de flags CLI
│           ├── fs.mjs                   # Helpers de filesystem
│           ├── git.mjs                  # Git diff, workspace root
│           ├── job-control.mjs          # Estado enriquecido de jobs
│           ├── process.mjs              # terminateProcessTree con SIGKILL escalation
│           ├── prompts.mjs              # Construcción de prompts
│           ├── render.mjs               # Markdown render de reviews
│           ├── state.mjs                # Estado persistente de jobs (atomic writes)
│           ├── tracked-jobs.mjs         # Logging por job
│           └── workspace.mjs            # Resolución de workspace root
└── tests/
    ├── api-client.test.mjs
    ├── claude-subprocess.test.mjs
    └── config.test.mjs
```

## Tests

```bash
cd /opt/agent-plugin-cc
node --test tests/*.test.mjs
```

30 tests: config (13), api-client (9), claude-subprocess (8).

## Hooks del ciclo de sesión

| Hook | Archivo | Qué hace |
|------|---------|----------|
| `SessionStart` | `session-lifecycle-hook.mjs` | Registra session ID; inyecta routing rules de gateway en el contexto vía `additionalContext` |
| `SessionEnd` | `session-lifecycle-hook.mjs` | Termina jobs activos, actualiza estado a `cancelled` |
| `Stop` | `stop-review-gate-hook.mjs` | Espera hasta 120s que terminen jobs activos antes de cerrar |

## Logs de jobs

Cada job background genera un log en:

```
/tmp/claude-0/gateway-companion/<workspace-hash>/jobs/<job-id>.log
```

Formato: una línea por entrada con timestamp ISO.

```
[2026-06-02T21:23:49.708Z] Starting Gateway Task.
[2026-06-02T21:23:49.881Z] Delegating task to ollama-minimax (minimax-m3:cloud)...
[2026-06-02T21:23:58.528Z] ## Archivos .mjs del proyecto
...
[2026-06-02T21:23:59.106Z] Final output
```

## Troubleshooting

### Los comandos `/gateway:*` no aparecen

```bash
claude plugin marketplace add https://github.com/elmaxid/gateway-agent.git
claude plugin install gateway@agent-gateway
# Reiniciar Claude Code
```

### "No credentials for provider" en task

El modelo necesita prefijo correcto. Verificar con:

```bash
curl http://TU_GATEWAY/v1/models -H "Authorization: Bearer TU_TOKEN"
```

Actualizar `defaultModel` en el perfil con el nombre exacto que devuelve `/v1/models`.

### Task subprocess no conecta al endpoint

Verificar que el perfil tiene `kind: claude-gateway`. Los perfiles `openai-chat` no soportan subprocess delegation.

### Job queda en `running` indefinidamente

```
/gateway:cancel <job-id>
```

Si el proceso no responde a SIGTERM, el plugin escala a SIGKILL automáticamente después de 2s.

### Resetear configuración

```bash
rm ~/.gateway-plugin/config.json
```

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `CLAUDE_PLUGIN_DATA` | Override del directorio de config (default: `~/.gateway-plugin`) |
| `CLAUDE_PLUGIN_ROOT` | Seteado automáticamente por Claude Code al cargar el plugin |
| `GATEWAY_COMPANION_SESSION_ID` | Seteado por el hook SessionStart, identifica la sesión actual |
