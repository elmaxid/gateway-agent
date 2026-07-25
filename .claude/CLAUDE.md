# agent-plugin-cc — Gateway Plugin Project

## Setup en máquina nueva

### 0. Instalador (fast path)

```bash
node scripts/install-plugins.mjs
```

Detecta los harnesses presentes (`claude`, `codex`) e instala/actualiza el plugin en cada uno — mismo comando para la primera instalación y para resincronizar después de un `git pull`. `--dry-run` muestra el plan sin ejecutar nada. No configura perfiles ni credenciales (pasos 2/2-bis/3 más abajo). Ver `node scripts/install-plugins.mjs --help` para el resto de flags.

Los pasos manuales de abajo siguen disponibles para quien quiera entender/controlar cada paso por separado.

### 1. Instalar el plugin
```bash
claude plugin install /path/to/agent-plugin-cc
```

### 2. Configurar perfiles del gateway
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup add \
  --profile profile-a --url <GATEWAY_URL> --model model-a \
  --kind claude-gateway --api-key <API_KEY>

node plugins/gateway/scripts/gateway-companion.mjs setup add \
  --profile profile-b --url <GATEWAY_URL> --model model-b \
  --kind claude-gateway --api-key <API_KEY>

node plugins/gateway/scripts/gateway-companion.mjs setup set-default --profile profile-a
```

### 2-bis. (Opcional) Configurar zero como tercer harness
```bash
npm i -g @gitlawb/zero
node plugins/gateway/scripts/gateway-companion.mjs setup zero-init
```
> Crea el provider de zero apuntando al gateway con la key referenciada por env var
> (`GATEWAY_API_KEY`, inyectada por el harness en cada spawn — no se duplica en disco).
> No correr `zero-init` mientras haya un dispatch `--harness zero` activo.

### 3. Verificar conectividad
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup list
node plugins/gateway/scripts/gateway-companion.mjs setup test --profile profile-a
node plugins/gateway/scripts/gateway-companion.mjs setup test --profile profile-b
```

> La config de perfiles vive en `~/.gateway-plugin/config.json` — no se commitea.

### 4. (Opcional) Instalar también para Codex
```bash
codex plugin marketplace add /path/to/agent-plugin-cc
codex plugin add gateway-codex@agent-gateway
```
> Plugin nativo de Codex (sin MCP): `plugins/gateway-codex/`, un solo skill
> (`gateway-workflows`) que documenta cómo invocar `gateway-companion` por shell.
> Usa los mismos perfiles del paso 2 — no hay config separada.
> `codex plugin add` corrido desde Claude Code se bloquea por el hook
> `codex-exec-guard` del plugin octo (solo permite `codex exec|--version|--help|-h|login|auth|completion`
> como subcomando bare) — correrlo con `!` o directo en tu propia terminal.

---

## Routing rules para este proyecto

| Tarea | Herramienta |
|-------|-------------|
| Research / investigación / spec / planes | `Task(research-planner)` — model Opus fijo, no gastar tokens de gateway ahí |
| Code review antes de commit | `/gateway:review --include-diff` |
| Review 2-fases (spec + adversarial) | `/gateway:staged-review --include-diff` |
| Debate arquitectura / decisión técnica | `/gateway:debate --include-diff` |
| Revisión adversarial (2-pass false-positive filter) | `/gateway:adversarial-review --include-diff` |
| Implementación + auto cross-review | `/gateway:task-review --review <profile>` |
| Implementación / feature nueva (spec ya cerrado) | `gateway:gateway-coder` (codex harness) |
| Debug / investigación de bug | `gateway:gateway-debugger` (codex harness) |
| Exploración de código | `gateway:gateway-researcher` |
| Window transfer a gateway model | `/gateway:transfer` |
| Task con harness zero | `task --harness zero` / `dispatch --harness zero` |

**Antes de cada commit**: correr adversarial review con `--include-diff` para validar cambios.

---

## Perfiles configurados

> `profile-a`/`profile-b` y `model-a`/`model-b` son placeholders — reemplazar por tus nombres de perfil y modelo reales.

- **profile-a** (`model-a`) — análisis estructurado, reviews detallados, sintetizador de debates
- **profile-b** (`model-b`) — razonamiento profundo, debug, segunda opinión técnica

Para cambiar modelo sin recrear perfil:
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup set-model --profile profile-a --model <MODEL>
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
