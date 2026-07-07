# gateway-plugin-cc

Claude Code plugin que delega code reviews y tareas a endpoints LLM alternativos (Ollama, gateways custom) usando la API compatible con OpenAI.

## Qué hace

Agrega 12 comandos `/gateway:*` a Claude Code. Siete operaciones principales:

| Operación | Backend | Cuándo usar |
|-----------|---------|-------------|
| **Review** | HTTP + agentic loop (tool-use multi-turn) | Revisar código; modelo explora repo con git/fs tools |
| **Staged Review** | HTTP directo 2-fases | Fase 1: spec compliance, Fase 2: code quality adversarial |
| **Task** | Subprocess `claude -p` o `codex exec` (dual-harness) | Delegación completa con herramientas |
| **Dispatch** | Worktrees git paralelas, un task runner (claude/codex) por tarea | Distribuir varias tareas de un plan across modelos en paralelo, con cross-review opcional |
| **Work** | Auto-routing → persona especializada | Detecta tipo de tarea por keywords |
| **Debate** | HTTP paralelo multi-modelo con preflight + quorum | Posiciones independientes + crítica cruzada + síntesis |
| **Transfer** | HTTP directo con contexto de sesión inyectado | Continuar sesión actual en modelo gateway |

La diferencia clave con otros plugins: no hay broker ni servidor. Reviews usan un loop agentic (tool-use multi-turn) por defecto; `--no-tools` cambia a HTTP directo con diff pre-inyectado. Tasks spawnan un proceso aislado apuntando al endpoint configurado.

## Quick Start (5 minutos)

Para alguien nuevo en el proyecto, el camino más corto a "estoy usando el plugin":

```bash
# 1. Instalar (dentro de Claude Code no hace falta reiniciar si usás /gateway:setup después)
claude plugin marketplace add https://github.com/elmaxid/gateway-agent.git
claude plugin install gateway@agent-gateway
# reiniciar Claude Code

# 2. Configurar un perfil (mínimo uno; ver "Configuración inicial" para el setup completo con 11 perfiles)
node plugins/gateway/scripts/bootstrap-profiles.mjs --url http://TU_GATEWAY:4000 --api-key sk-...
```

Dentro de Claude Code:

```
# 3. Verificar que conecta
/gateway:setup test --profile minimax

# 4. Primer review — revisa el diff actual de tu working tree
/gateway:review

# 5. Primera delegación de tarea completa (el modelo puede escribir archivos)
/gateway:task "agregá un test para la función X"

# 6. Primer dispatch — distribuye varias tareas de un plan entre modelos en paralelo
/gateway:dispatch --task "explica qué hace config.mjs:minimax" --dry-run
```

De acá en adelante, cada comando tiene su propia sección más abajo con flags completos y ejemplos. `/gateway:work "<lo que necesites>"` es el punto de entrada más simple si no estás seguro de qué comando usar — hace auto-routing por keywords.

### Personas especializadas

5 subagentes con prompt-shaping por dominio y harness óptimo:

| Persona | Dominio | Harness | Modo |
|---------|---------|---------|------|
| `gateway-coder` | Implementación, refactoring | codex (stateful) | write |
| `gateway-debugger` | Bugs, test failures | codex (stateful) | write |
| `gateway-reviewer` | Code review, audit | claude (stateless) | read-only |
| `gateway-researcher` | Research, exploración | claude (stateless) | read-only |
| `security` | Vulnerabilidades, CVE, OWASP | gateway-rescue + `--as security` | read-only |

Las personas están definidas en archivos `personas/*.md` con frontmatter YAML. Cada archivo declara `name`, `description`, `activation_keywords` y el cuerpo del system prompt. Para agregar una nueva persona basta con crear un archivo `.md` nuevo — no requiere cambios en código.

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

### Opción A: bootstrap script (recomendado para máquina nueva)

```bash
cd /your/checkout/of/agent-plugin-cc
node plugins/gateway/scripts/bootstrap-profiles.mjs \
  --url http://TU_GATEWAY:4000 \
  --api-key sk-...
```

Crea los 11 perfiles estándar con roles correctos de una vez:

| Perfil | Modelo | Uso |
|--------|--------|-----|
| `minimax` | `minimax-m3` | default + task — análisis, síntesis |
| `deepseek-pro` | `deepseek-v4-pro` | review — razonamiento profundo |
| `deepseek-flash` | `deepseek-v4-flash` | iteración rápida |
| `glm` | `glm-5.2` | coding, research — large context |
| `nemotron` | `nemotron-3-ultra` | seguridad, razonamiento |
| `kimi-think` | `kimi-k2-thinking` | debug, análisis profundo |
| `kimi-code` | `kimi-k2.6` | coding |
| `devstral` | `devstral-2:123b` | coding especializado |
| `cogito` | `cogito-2.1:671b` | debate, seguridad, adversarial |
| `gemini-flash` | `gemini-flash` | iteración rápida, bajo costo |
| `gemini-pro` | `gemini-pro` | razonamiento general, largo contexto |

También acepta variables de entorno: `GATEWAY_URL` y `GATEWAY_API_KEY`.

### Opción B: configurar vía comandos

Desde Claude Code, usar `/gateway:setup add` para cada endpoint:

```
/gateway:setup add --profile minimax --url http://GATEWAY:4000 --model minimax-m3:cloud --kind claude-gateway --api-key sk-...
/gateway:setup add --profile deepseek-pro --url http://GATEWAY:4000 --model deepseek-v4-pro:cloud --kind claude-gateway --api-key sk-...
/gateway:setup add --profile deepseek-flash --url http://GATEWAY:4000 --model deepseek-v4-flash:cloud --kind claude-gateway --api-key sk-...
/gateway:setup set-default --profile minimax
/gateway:setup set-review-profile --profile deepseek-pro
/gateway:setup set-task-profile --profile minimax
```

### Listar perfiles configurados

```
/gateway:setup list
```

### Probar conectividad

```
/gateway:setup test --profile minimax
```

### Establecer perfil por defecto

```
/gateway:setup set-default --profile minimax
```

### Configurar perfiles separados para review y task

```
/gateway:setup set-review-profile --profile deepseek-flash
/gateway:setup set-task-profile --profile minimax
```

### Eliminar un perfil

```
/gateway:setup remove --profile deepseek-flash
```

### Cambiar modelo de un perfil (sin remove+add)

```
/gateway:setup set-model --profile minimax --model minimax-m3:cloud-v2
/gateway:setup set-model --profile deepseek-pro --model deepseek-v4-pro:latest
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
- `ANTHROPIC_API_KEY` → credenciales para el gateway (usa `profile.apiKey`, con fallback a `profile.authToken`)

> **Nota:** `ANTHROPIC_API_KEY` siempre se setea con el token del gateway. Usar solo `authToken` en el perfil (sin `apiKey`) es válido — el subprocess lo recibe correctamente como API key. Si `ANTHROPIC_API_KEY` quedara vacío el subprocess usaría las credenciales de `~/.claude/` y se conectaría a Anthropic real en lugar del gateway.

## Comandos

### `/gateway:review`

Review del diff actual usando el LLM configurado.

```
/gateway:review
/gateway:review --profile deepseek-flash
/gateway:review --profile minimax --model minimax-m3:cloud
/gateway:review --base main --head HEAD
/gateway:review --scope branch
/gateway:review --json
```

**Flags:**
- `--profile NAME` — perfil a usar (default: perfil configurado como reviewProfile, o defaultProfile)
- `--model MODEL` — override del modelo
- `--base REF` — ref base para el diff
- `--head REF` — ref head para el diff
- `--scope auto|working-tree|branch` — qué diff revisar:
  - `auto` (default): staged/unstaged si los hay, sino branch diff contra rama base
  - `working-tree`: solo cambios sin commitear
  - `branch`: diff desde merge-base contra rama principal
- `--no-tools` — desactiva el loop agentic; usa HTTP directo con diff pre-inyectado en el prompt (más rápido, menos contexto)
- `--include-diff` — fuerza inclusión del diff completo en el contexto pre-inyectado (solo tiene efecto con `--no-tools`)
- `--timeout MS` — timeout HTTP por request en milisegundos (default: 60000). Útil con modelos lentos (ej. minimax-m3). En modo `--no-tools` es 1 request; en modo agentic default puede ser hasta `maxIterations` requests, cada una bounded por este valor (el deadline interno del loop escala como `max(120000, timeout × 2)`, worst-case wall-clock ≈ deadline + hasta 4×timeout). Si el modelo devuelve output que no tiene forma de review válida (no-JSON, o JSON sin verdict/summary/findings) dos veces seguidas en el mismo turno terminal, la review reintenta automáticamente una vez por punto de fallo; si persiste, falla explícito (`exitStatus` no-cero, render dice "FAILED") en vez de renderizar el garbage como si fuera un review real.
- `--json` — output estructurado JSON

**Modos de review:**
- **Default (agentic)**: el modelo explora el repo incrementalmente via tool-use (`read_file`, `git_diff`, `list_changed_files`, `git_log`, `git_show`). Más contexto, más lento.
- **`--no-tools`**: HTTP directo sin tools; el modelo recibe solo el contexto pre-calculado. Más rápido.
- **`--no-tools --include-diff`**: igual que `--no-tools` pero fuerza incluir el diff completo en el prompt inicial.

**Output:** Structured review con `verdict` (`approve|request-changes|comment`), findings con severity (`critical|warning|suggestion|nitpick`), recomendaciones.

---

### `/gateway:adversarial-review`

Review de dos pasadas: primera encuentra issues, segunda filtra falsos positivos.

```
/gateway:adversarial-review
/gateway:adversarial-review --profile minimax "focus en seguridad"
/gateway:adversarial-review --base main
/gateway:adversarial-review --include-diff "verificar cambios de seguridad"
/gateway:adversarial-review --profile minimax --timeout 120000 --include-diff
```

Mismos flags que `/gateway:review` (incluyendo `--include-diff`, `--timeout`). Más lento pero más preciso — útil antes de merge a main. Hace 2 requests HTTP secuenciales (primera pasada + filtro adversarial), así que el peor caso con modelos lentos es ≈2×`--timeout`.

---

### `/gateway:staged-review`

Review de 2 fases: Fase 1 evalúa spec compliance (¿el código hace lo que dice?), Fase 2 corre un review adversarial de calidad de código (encuentra issues, luego filtra falsos positivos).

```
/gateway:staged-review --include-diff "v0.3.1 robustness improvements"
/gateway:staged-review --profile minimax --include-diff
/gateway:staged-review --json --include-diff
/gateway:staged-review --base main --scope branch "verificar feature branch"
```

**Flags:**
- `--profile NAME` — perfil a usar (default: reviewProfile o defaultProfile)
- `--model MODEL` — override del modelo
- `--base REF` — ref base para el diff
- `--scope auto|working-tree|branch` — qué diff revisar
- `--include-diff` — incluye el diff completo en el contexto
- `--timeout MS` — timeout HTTP por request en milisegundos (default: 60000). Hace 3 requests secuenciales (fase 1 + review + filtro adversarial), peor caso ≈3×`--timeout` con modelos lentos
- `--json` — output estructurado JSON con `{ phase1, phase2, meta }`
- Texto libre después de los flags → descripción del intent (se inyecta como contexto de la Fase 1)

**Fases:**
1. **Spec compliance:** Evalúa si los cambios de código coinciden con el intent declarado. Detecta funcionalidad faltante, scope creep, implementaciones incompletas, y mismatch entre descripción y cambios reales. Retorna JSON con `verdict` (`pass|partial|fail`) y `findings`.
2. **Code quality adversarial:** Dos pasadas — primera busca issues usando `REVIEW_SYSTEM_PROMPT`, segunda filtra falsos positivos con `ADVERSARIAL_SYSTEM_PROMPT`. Reutiliza los mismos prompts que `/gateway:review` y `/gateway:adversarial-review`.

**Output JSON (con `--json`):**
```json
{
  "phase1": { "type": "spec-compliance", "content": "...", "model": "..." },
  "phase2": {
    "type": "code-quality-adversarial",
    "firstPass": { "content": "...", "model": "..." },
    "filtered": { "content": "...", "model": "..." }
  },
  "meta": { "profile": "minimax", "model": "minimax-m3", "target": "working-tree" }
}
```

---

### `/gateway:task`

Delega una tarea al LLM via subprocess. Soporta dual-harness (claude o codex).

```
/gateway:task "explica qué hace este proyecto"
/gateway:task --background "encuentra todos los TODOs en el código"
/gateway:task --profile deepseek-pro "implementa tests para api-client.mjs"
/gateway:task --no-write "analiza la arquitectura sin hacer cambios"
/gateway:task --harness codex "debug este test que falla"
```

**Flags:**
- `--background` — lanza en background, retorna job ID inmediatamente
- `--wait` — foreground bloqueante (default)
- `--profile NAME` — perfil a usar (debe ser `claude-gateway`)
- `--model MODEL` — override del modelo
- `--harness claude|codex` — harness de ejecución (default: claude). Codex ofrece threads persistentes y sandbox real
- `--as PERSONA` — inyecta system prompt de una persona antes de la tarea (`reviewer`, `debugger`, `security`, `researcher`, `coder`). Si no se especifica, se intenta auto-match: el prompt se compara contra `activation_keywords` de cada persona y se selecciona la de mayor score (vía `matchPersona()`). Usar `--as` explícito para forzar una persona concreta.
- `--write` — permite escritura de archivos (default)
- `--no-write` — modo lectura, sin edits

**Foreground:** Stream del output del subprocess en tiempo real.

**Background:** Retorna `task-XXXXX-YYYYYY`. Usar `/gateway:status` y `/gateway:result` para seguimiento.

---

### `/gateway:dispatch`

Distribuye varias tareas de implementación across múltiples modelos gateway en paralelo, cada una en su propia worktree git aislada, con cross-review opcional. Ideal para ejecutar un plan (`## Task N`) repartiendo tareas entre modelos.

```
/gateway:dispatch --plan tasks/plan.md
/gateway:dispatch --plan tasks/plan.md --assign "1-3:minimax,4-6:glm" --cross-review deepseek-pro
/gateway:dispatch --task "add retry:minimax" --task "fix auth:glm"
/gateway:dispatch --plan tasks/plan.md --model-override minimax:minimax-m3 --max-concurrency 4
/gateway:dispatch --plan tasks/plan.md --dry-run
```

**Flags:**
- `--plan FILE` — archivo de plan; cada sección `## Task N` se convierte en una tarea. Mutuamente excluyente con `--task`
- `--task PROMPT:PROFILE` — tarea inline (repetible). El sufijo `:PROFILE` es opcional (usa el taskProfile por defecto). Mutuamente excluyente con `--plan`
- `--assign RANGES` — asigna rangos de task IDs a perfiles, ej. `1-3:minimax,4-6:glm`. Solo válido con `--plan`
- `--model-override PROF:MODEL` — override de modelo para un perfil (repetible)
- `--max-concurrency N` — máximo de tareas concurrentes por endpoint (1-16, default 3)
- `--harness claude|codex` — harness de ejecución por tarea (default `codex`; codex requiere el CLI instalado)
- `--timeout MS` — timeout por tarea en ms. Si expira, esa tarea se marca `FAILED (timeout)` (no aborta las demás)
- `--cross-review PROFILE` — tras completar, revisa el diff de cada tarea con este perfil y agrega los findings al manifest
- `--cross-review-model MODEL` — override de modelo para el cross-review
- `--fail-fast` — aborta las tareas pendientes tras el primer fallo
- `--write` / `--no-write` — permitir/impedir escritura de archivos (default `--write`)
- `--dry-run` — muestra el mapeo tarea→perfil/modelo sin ejecutar nada
- `--json` — output estructurado
- `--background` — aún no implementado; corre en foreground con un warning

**Requisitos:** todos los perfiles usados (tasks, `--assign`, `--model-override`, `--cross-review`) deben existir y ser `kind: claude-gateway`.

**Flujo:**
1. **Parse:** extrae tareas del `--plan` o de los `--task`, y resuelve perfil y modelo por tarea (`--assign` / `--model-override`).
2. **Preflight:** valida que cada perfil exista y sea `claude-gateway`, health check de conectividad, y warn si el working tree tiene cambios sin commitear (las worktrees se crean desde HEAD).
3. **Ejecución:** cada tarea corre en una worktree git aislada creada desde HEAD, bajo `.gateway-dispatch/<jobId>/`. El diff resultante se guarda como patch en `patches/`; los logs en `logs/`.
4. **Cross-review (opcional):** revisa cada diff completado con el perfil de `--cross-review`.
5. **Cleanup:** cada worktree se elimina en un `finally` (éxito, fallo o timeout).

**Output:** progreso por tarea (`done Ns` / `FAILED (razón)` / `no changes`), summary con conteos, y rutas de patches para aplicar con `git apply`. Los patches NO se aplican automáticamente — se dejan en disco para revisión manual.

**Exit codes:** `0` OK · `1` una o más tareas fallaron · `2` argumentos inválidos, error de config o preflight.

#### Ejemplo end-to-end

1. Escribir un plan con secciones `## Task N` (cualquier markdown, el parser solo lee los headers):

   ```markdown
   <!-- tasks/refactor-plan.md -->
   ## Task 1: Extraer helper de validación
   Mover la lógica de validación de email de `signup.mjs` a `lib/validators.mjs`.

   ## Task 2: Agregar tests para validators.mjs
   Cubrir casos edge: email vacío, sin @, dominios inválidos.

   ## Task 3: Actualizar README con la nueva API
   Documentar `validators.mjs` en el README del módulo.
   ```

2. Repartir las 3 tareas entre 2 perfiles y pedir cross-review con un tercero:

   ```bash
   /gateway:dispatch --plan tasks/refactor-plan.md --assign "1-2:minimax,3:glm" --cross-review deepseek-pro
   ```

3. Salida esperada (resumida):

   ```
   [dispatch] job dispatch-mfx2a1-k9j3lp — 3 tasks, base a1b2c3d
   [dispatch] task 1 (minimax): done 12s — patch task-001.patch
   [dispatch] task 2 (minimax): done 18s — patch task-002.patch
   [dispatch] task 3 (glm): no changes
   [dispatch] Cross-review: 2 tasks by deepseek-pro
   [dispatch] task 1: 0 findings — task 2: 1 finding (minor)

   Summary: 2 completed, 1 no-changes, 0 failed
   Patches: .gateway-dispatch/dispatch-mfx2a1-k9j3lp/patches/
   Reviews: .gateway-dispatch/dispatch-mfx2a1-k9j3lp/reviews/
   Manifest: .gateway-dispatch/dispatch-mfx2a1-k9j3lp/manifest.json
   ```

4. Revisar y aplicar los patches manualmente (nunca se aplican solos):

   ```bash
   cat .gateway-dispatch/dispatch-mfx2a1-k9j3lp/patches/task-001.patch
   git apply --check .gateway-dispatch/dispatch-mfx2a1-k9j3lp/patches/task-001.patch  # dry-run
   git apply .gateway-dispatch/dispatch-mfx2a1-k9j3lp/patches/task-001.patch
   ```

5. Si algo falla, el log de esa tarea puntual está en `.gateway-dispatch/<jobId>/logs/task-00N.log`; el resto de las tareas no se ven afectadas (excepto con `--fail-fast`).

**Notas prácticas:**
- `--max-concurrency` es por endpoint (por `baseUrl` normalizado), no global — si `minimax` y `glm` apuntan a gateways distintos, cada uno tiene su propio límite de tareas concurrentes.
- Si el working tree tiene cambios sin commitear, el preflight avisa: las worktrees se crean desde `HEAD`, así que uncommitted changes no viajan a las tareas.
- `--task "prompt:profile"` sin `:profile` usa el `taskProfile` configurado por defecto — útil para pruebas rápidas como el paso 6 del Quick Start.
- Dos `dispatch` corriendo al mismo tiempo sobre el mismo repo no se pisan: cada job activo se marca con un `active.lock` (PID) bajo `.gateway-dispatch/<jobId>/`; un job nuevo salta los directorios de jobs activos de otro proceso al limpiar worktrees huérfanas, y nunca borra `patches/`, `logs/`, `reviews/` ni `manifest.json` de jobs ya completados — solo las worktrees huérfanas.
- `dispatch` marca `.gateway-dispatch/` como ignorado vía `.git/info/exclude` (local al checkout), nunca toca tu `.gitignore` trackeado.

**Errores comunes (`dispatch` sale con exit code 2 — ver el `Troubleshooting` general más abajo para el resto de los comandos):**
- `--plan` y `--task` juntos, o ninguno de los dos → son mutuamente excluyentes, uno es obligatorio.
- `--assign` sin `--plan` → solo tiene sentido con un plan file.
- `--write` y `--no-write` juntos → mutuamente excluyentes.
- `--max-concurrency` fuera de 1-16, o `--harness` que no sea `claude`/`codex`.
- Un perfil (de `--task`, `--assign`, `--model-override` o `--cross-review`) no existe en config, o existe pero no es `kind: claude-gateway`.
- El archivo de `--plan` no se puede leer.
- `--model-override` referencia un perfil que ninguna tarea usa realmente → no es error fatal, pero avisa por stderr (`Warning: --model-override references profile "X" which is not used by any task`) — típico de un typo en el nombre del perfil.

---

### `/gateway:work`

Auto-routing inteligente. Detecta el tipo de tarea por keywords y delega a la persona especializada correcta.

```
/gateway:work "encontrá el bug en api-client.mjs"           → gateway-debugger
/gateway:work "implementá tests para config.mjs"             → gateway-coder
/gateway:work "analizá la arquitectura de este proyecto"     → gateway-researcher
/gateway:work "revisá el PR diff"                             → gateway-reviewer
/gateway:work "auditá vulnerabilidades CVE en este módulo"   → gateway-rescue --as security
```

El routing es determinístico por keywords (definidas en `personas/*.md`), no por LLM. Orden de prioridad: debug → review → security → research → coder → fallback. Pasa `--profile`, `--model`, `--harness` al agente seleccionado.

---

### `/gateway:debate`

Debate multi-modelo entre endpoints configurados. HTTP puro, sin subprocesses.

```
/gateway:debate "¿usar sqlite o postgres para este proyecto?"
/gateway:debate --models deepseek-pro,minimax "arquitectura propuesta"
/gateway:debate --rounds 2 --synthesizer deepseek-pro "REST vs GraphQL"
/gateway:debate --json "mejor approach para caching"
/gateway:debate --include-diff "revisar estos cambios entre los modelos"
/gateway:debate --include-diff --base main "¿estos cambios tienen problemas de seguridad?"
```

**Flags:**
- `--models profile1,profile2` — perfiles a usar (default: primeros 2 configurados)
- `--rounds N` — número de rondas (default: 3)
- `--synthesizer PROFILE` — perfil para síntesis final (default: primer perfil)
- `--mode relaxed|standard` — quorum mode (default: `relaxed`)
  - `relaxed`: mayoría (ceil(n/2)) de perfiles deben responder — si 1 de 2 falla, debate continúa
  - `standard`: todos los perfiles deben responder — falla si alguno no responde
- `--include-diff` — inyecta el diff del working tree en la pregunta (requiere repo git)
- `--base REF` — ref base para el diff (implica inclusión de contexto git)
- `--scope auto|working-tree|branch` — qué diff incluir
- `--json` — output estructurado

**Flujo:**
1. **Preflight:** Health check de conectividad a todos los perfiles (incluyendo synthesizer). Filtra perfiles inactivos si el quorum lo permite; falla rápido si no hay quorum o el synthesizer está caído.
2. **Round 1:** Posiciones paralelas de cada modelo.
3. **Quorum check:** Si menos de `quorumRequired` modelos respondieron, retorna resultado parcial con `quorum_failed: true` (no lanza excepción).
4. **Round 2:** Crítica cruzada — cada modelo critica las posiciones de los otros.
5. **Round 3:** Síntesis — el synthesizer produce un resumen equilibrado.

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

### `/gateway:transfer`

Transfiere el contexto de la sesión actual de Claude Code a un modelo gateway. Window transfer: el modelo gateway ve los últimos N turnos de conversación.

```
/gateway:transfer
/gateway:transfer --profile deepseek-pro
/gateway:transfer --turns 50 "resumí lo que estábamos haciendo"
/gateway:transfer --profile glm --turns 20
```

**Flags:**
- `--profile NAME` — perfil a usar (default: defaultProfile)
- `--turns N` — cantidad de turnos a enviar (default: 30)
- Texto libre después de los flags → prompt de continuación (default: "Continue from where we left off.")

**Cómo funciona:**
1. Lee el transcript de la sesión actual (`$GATEWAY_TRANSCRIPT_PATH`, seteado por SessionStart hook)
2. Parsea turnos user/assistant, filtra tool_use/tool_result/thinking
3. Merge turnos consecutivos del mismo rol (evita errores 400 en APIs estrictas)
4. Envía los últimos N turnos como contexto al endpoint gateway
5. Devuelve la respuesta del modelo

**Seguridad:** El transcript path se valida contra `~/.claude/` y debe ser `.jsonl`. Paths fuera del directorio de Claude o symlinks son rechazados.

---

## Archivo de configuración

Guardado en `~/.gateway-plugin/config.json` (o `$GATEWAY_PLUGIN_CONFIG_DIR/config.json`).

> **Ejemplo:** El repo incluye `config.example.json` en la raíz con una plantilla de perfiles lista para copiar y editar.

```json
{
  "profiles": {
    "minimax": {
      "kind": "claude-gateway",
      "baseUrl": "http://GATEWAY:4000",
      "defaultModel": "minimax-m3",
      "authToken": "YOUR_API_KEY_HERE"
    },
    "deepseek-pro": {
      "kind": "claude-gateway",
      "baseUrl": "http://GATEWAY:4000",
      "defaultModel": "deepseek-v4-pro",
      "authToken": "YOUR_API_KEY_HERE"
    },
    "glm": {
      "kind": "claude-gateway",
      "baseUrl": "http://GATEWAY:4000",
      "defaultModel": "glm-5.2",
      "authToken": "YOUR_API_KEY_HERE"
    }
  },
  "defaultProfile": "minimax",
  "reviewProfile": "deepseek-pro",
  "taskProfile": "minimax"
}
```

El archivo tiene permisos `0o600` (solo lectura para el owner).

> **Importante:** `taskProfile` requiere `kind: claude-gateway`. No uses `openai-chat` para tasks.

## Modelos disponibles

El gateway expone modelos vía `GET /v1/models`. Modelos confirmados en producción:

| Modelo | Uso recomendado | Notas |
|--------|----------------|-------|
| `minimax-m3` | Análisis estructurado, reviews, síntesis | default + taskProfile |
| `deepseek-v4-pro` | Razonamiento profundo, review, segunda opinión | reviewProfile |
| `deepseek-v4-flash` | Tareas rápidas, iteración | — |
| `glm-5.2` | Coding, research — large context | thinking model: output en `reasoning_content` |
| `nemotron-3-ultra` | Seguridad, razonamiento, análisis adversarial | — |
| `kimi-k2-thinking` | Debug, razonamiento paso a paso | thinking model |
| `kimi-k2.6` | Coding general | — |
| `devstral-2:123b` | Coding especializado (Mistral, 123B) | — |
| `cogito-2.1:671b` | Debate, seguridad, crítica (671B) | — |
| `gemini-flash` | Iteración rápida, bajo costo | — |
| `gemini-pro` | Razonamiento general, largo contexto | — |

Para listar modelos disponibles en tu gateway:

```bash
curl http://TU_GATEWAY/v1/models -H "Authorization: Bearer TU_TOKEN"
```

Los nombres son exactos — sin prefijos adicionales.

## Estructura del proyecto

```
/opt/agent-plugin-cc/
├── .claude-plugin/marketplace.json      # Manifiesto del marketplace
├── package.json
├── plugins/gateway/
│   ├── .claude-plugin/plugin.json       # Manifiesto del plugin
│   ├── personas/                        # System prompt personas (*.md con frontmatter YAML)
│   │   ├── coder.md
│   │   ├── debugger.md
│   │   ├── researcher.md
│   │   ├── reviewer.md
│   │   └── security.md
│   ├── commands/                        # 12 comandos slash
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── staged-review.md            # Review 2-fases: spec compliance + adversarial
│   │   ├── task.md
│   │   ├── dispatch.md                 # Distribuye tareas de un plan entre modelos en paralelo
│   │   ├── work.md                     # Auto-routing por keywords → persona correcta
│   │   ├── debate.md                   # Debate multi-modelo con preflight + quorum
│   │   ├── setup.md
│   │   ├── status.md
│   │   ├── result.md
│   │   ├── cancel.md
│   │   └── transfer.md                 # Window transfer de contexto a gateway
│   ├── agents/
│   │   ├── gateway-rescue.md            # Subagente forwarding genérico (fallback)
│   │   ├── gateway-coder.md             # Implementación/refactoring (codex harness)
│   │   ├── gateway-debugger.md          # Debug/test failures (codex harness)
│   │   ├── gateway-reviewer.md          # Code review/audit (claude harness, read-only)
│   │   ├── gateway-researcher.md        # Research/exploración (claude harness, read-only)
│   │   └── gateway-dispatcher.md        # Forwarder de dispatch (thin, sin prompt-shaping)
│   ├── hooks/hooks.json                 # SessionStart / SessionEnd / Stop
│   ├── prompts/
│   │   ├── adversarial-review.md        # Template prompt segunda pasada
│   │   └── stop-review-gate.md
│   ├── skills/
│   │   ├── gateway-cli-runtime/SKILL.md # Contrato de runtime para gateway-rescue (cómo invocar gateway-companion.mjs)
│   │   └── gateway-prompt-shaper/SKILL.md # Enriquecimiento de prompts por dominio para agentes gateway-coder/debugger/reviewer/researcher
│   └── scripts/
│       ├── gateway-companion.mjs        # CLI principal (~1000 líneas)
│       ├── bootstrap-profiles.mjs       # Setup de perfiles en máquina nueva (--url --api-key)
│       ├── session-lifecycle-hook.mjs   # Limpieza de jobs al cerrar sesión
│       ├── stop-review-gate-hook.mjs    # Espera jobs activos en Stop (TTY-safe)
│       └── lib/
│           ├── agentic-review.mjs       # Driver multi-turn tool-use para /gateway:review
│           ├── api-client.mjs           # HTTP + SSE streaming + per-attempt AbortController timeout
│           ├── claude-subprocess.mjs    # Spawn claude -p con env custom
│           ├── codex-harness.mjs       # Spawn codex exec (harness alternativo)
│           ├── debate.mjs              # Motor de debate multi-modelo con quorum + preflight
│           ├── concurrency.mjs         # Semaphore + normalizeBaseUrl (compartido por debate y dispatch)
│           ├── dispatch.mjs            # Parsing, worktrees, ejecución paralela, cross-review de /gateway:dispatch
│           ├── config.mjs               # Sistema de perfiles multi-endpoint
│           ├── args.mjs                 # Parser de flags CLI
│           ├── fs.mjs                   # Helpers de filesystem
│           ├── git.mjs                  # Git diff, workspace root
│           ├── job-control.mjs          # Estado enriquecido de jobs
│           ├── personas.mjs             # Carga dinámica de personas desde archivos .md
│           ├── process.mjs              # terminateProcessTree con SIGKILL escalation
│           ├── render.mjs               # Markdown render de reviews
│           ├── state.mjs                # Estado persistente de jobs (atomic writes)
│           ├── subprocess-utils.mjs     # pickEnv + terminateProcessTree (shared por claude-subprocess y codex-harness)
│           ├── tracked-jobs.mjs         # Logging por job
│           ├── workspace.mjs            # Resolución de workspace root
│           └── claude-session-transfer.mjs  # Parser de transcripts + window transfer
└── tests/
    ├── api-client.test.mjs          # HTTP client + AbortController timeout + testConnectivity timeoutMs — unit (12 tests)
    ├── debate.test.mjs              # Quorum enforcement + exports + preflight timeoutMs — unit (9 tests)
    ├── args.test.mjs                # validateTimeoutOption (--timeout de review/adversarial-review/staged-review/debate) — unit (10 tests)
    ├── agentic-review.test.mjs      # timeoutMs threading + retry-on-malformed-output + validación de forma en runToolLoop/forceFinish — unit (8 tests)
    ├── agentic-review-malformed-output.test.mjs # exitStatus/render de fallo end-to-end cuando el modelo devuelve garbage — unit (2 tests)
    ├── agentic-review-maxtime.test.mjs # maxTime scaling del loop agentic (max(120000, timeout×2)) — unit (1 test)
    ├── cli-timeout.test.mjs         # --timeout end-to-end vía CLI real, mocks HTTP stateful — unit (6 tests)
    ├── claude-subprocess.test.mjs   # Subprocess env + auth — unit (9 tests)
    ├── codex-harness.test.mjs       # Codex env + auth — unit (6 tests)
    ├── config.test.mjs              # Profile CRUD — unit (13 tests)
    ├── claude-session-transfer.test.mjs # Transcript parser + buildMessages — unit (9 tests)
    ├── session-lifecycle-hook.test.mjs  # Hook stdin + env var — unit (2 tests)
    ├── dispatch.test.mjs            # Semaphore, parsers, worktree lifecycle, execution engine, cross-review, CLI — unit (43 tests)
    └── integration.test.mjs         # Live gateway — connectivity, review, task (claude+codex)
```

## Tests

```bash
cd /opt/agent-plugin-cc

# Unit tests (sin red) — todos menos integration.test.mjs
node --test tests/claude-subprocess.test.mjs tests/codex-harness.test.mjs tests/api-client.test.mjs tests/debate.test.mjs tests/config.test.mjs tests/claude-session-transfer.test.mjs tests/session-lifecycle-hook.test.mjs tests/args.test.mjs tests/agentic-review.test.mjs tests/agentic-review-malformed-output.test.mjs tests/agentic-review-maxtime.test.mjs tests/cli-timeout.test.mjs tests/dispatch.test.mjs

# Integration tests (requiere gateway activo)
node --test --test-timeout=120000 tests/integration.test.mjs
```

**Unit tests:** 130 tests — config (13), api-client (12), debate (9), args (10), agentic-review (8), agentic-review-maxtime (1), agentic-review-malformed-output (2), cli-timeout (6), claude-subprocess (9), codex-harness (6), claude-session-transfer (9), session-lifecycle-hook (2), dispatch (43 — Semaphore/normalizeBaseUrl, parsers, worktree lifecycle, execution engine, cross-review, CLI). Sin red — todos usan `http.createServer`/`net.createServer` locales o repos git temporales cuando necesitan simular un backend, nunca el gateway real.

**Integration tests:** 12 tests contra el gateway live — conectividad, review HTTP directo, task via claude harness, task via codex harness; para los 3 modelos principales (glm-5.2, minimax-m3, deepseek-v4-pro).

## Hooks del ciclo de sesión

| Hook | Archivo | Qué hace |
|------|---------|----------|
| `SessionStart` | `session-lifecycle-hook.mjs` | Registra session ID y transcript path; inyecta routing rules de gateway en el contexto vía `additionalContext` |
| `SessionEnd` | `session-lifecycle-hook.mjs` | Termina jobs activos, actualiza estado a `cancelled` |
| `Stop` | `stop-review-gate-hook.mjs` | Espera hasta 125s que terminen jobs activos; retorna `ALLOW` si todos terminaron, `BLOCK` si alguno sigue activo |

## Logs de jobs

Cada job background genera un log en:

```
/tmp/claude-0/gateway-companion/<workspace-hash>/jobs/<job-id>.log
```

Formato: una línea por entrada con timestamp ISO.

```
[2026-06-02T21:23:49.708Z] Starting Gateway Task.
[2026-06-02T21:23:49.881Z] Delegating task to minimax (minimax-m3:cloud)...
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

### Task responde con Sonnet en lugar del modelo configurado

El subprocess usa credenciales de `~/.claude/` en lugar del gateway. Esto ocurre si el perfil no tiene `apiKey` ni `authToken` seteados correctamente.

Verificar con:
```bash
node plugins/gateway/scripts/gateway-companion.mjs setup test --profile <perfil>
```

Si conecta al gateway correctamente (modelo retornado ≠ `claude-sonnet-*`), el problema está en otro lado. Si falla, revisar que `authToken` esté seteado en el perfil — es el token que se pasa como `ANTHROPIC_API_KEY` al subprocess para autenticar contra el gateway.

### `dispatch` sale con exit code 2 inmediatamente (sin ejecutar nada)

Exit 2 = error de validación o preflight, no de una tarea. El mensaje en stderr dice la causa exacta — casos típicos: `--plan`/`--task` juntos o ninguno, `--assign` sin `--plan`, `--write`/`--no-write` juntos, `--max-concurrency` fuera de 1-16, `--harness` inválido, un perfil que no existe o no es `kind: claude-gateway`, o el archivo de `--plan` no se puede leer. Correr con `--dry-run` primero para validar el mapeo tarea→perfil sin ejecutar nada.

### Una tarea de `dispatch` queda `FAILED (timeout)`

Superó el `--timeout` que pasaste (o corrió sin límite si no lo pasaste y el runner nunca volvió). El resto de las tareas no se ven afectadas — revisar `.gateway-dispatch/<jobId>/logs/task-00N.log` de esa tarea puntual para ver qué estaba haciendo. Con `--fail-fast` las tareas todavía no arrancadas se marcan `error: "aborted"` en vez de ejecutar.

### `dispatch` dice "Preflight failed" o tarda mucho en el chequeo de perfiles

El preflight hace un health check HTTP a cada perfil usado (tasks + `--cross-review`) antes de arrancar. Si algún perfil no responde, falla rápido con el nombre del perfil y el error de conexión — mismo diagnóstico que "No credentials for provider" arriba: probar `setup test --profile <perfil>` directamente.

### `--model-override` no parece tener efecto

Si el nombre de perfil en `--model-override PROF:MODEL` no coincide con ningún perfil realmente usado por una tarea, `dispatch` avisa por stderr (`Warning: --model-override references profile "X" which is not used by any task`) y sigue sin aplicar nada — típico de un typo. Verificar con `--dry-run` que el perfil de la tarea coincide exactamente con el de `--model-override`.

### Job queda en `running` indefinidamente

```
/gateway:cancel <job-id>
```

Si el proceso no responde a SIGTERM, el plugin escala a SIGKILL automáticamente después de 2s.

### Hook `stop-review-gate` bloquea la sesión al cerrar

El hook lee stdin con `fs.readFileSync(0)`. Si Claude Code no cierra el pipe (sesión abrupta, contexto distinto), el proceso queda bloqueado esperando EOF indefinidamente.

Fix ya aplicado en `stop-review-gate-hook.mjs`: chequea `process.stdin.isTTY` antes de leer. Si es TTY, retorna `{}` sin leer. Si el hook bloquea en tu máquina, verificar que el archivo tiene el guard:

```javascript
function readHookInput() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}
```

### Resetear configuración

```bash
rm ~/.gateway-plugin/config.json
```

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `GATEWAY_PLUGIN_CONFIG_DIR` | Override del directorio de config (default: `~/.gateway-plugin`) |
| `CLAUDE_PLUGIN_ROOT` | Seteado automáticamente por Claude Code al cargar el plugin |
| `GATEWAY_COMPANION_SESSION_ID` | Seteado por el hook SessionStart, identifica la sesión actual |
| `GATEWAY_TRANSCRIPT_PATH` | Path al transcript JSONL de la sesión actual (seteado por SessionStart hook) |

## Licencia

UNLICENSED — código privado, todos los derechos reservados al autor.

**Versión actual:** v0.4.1

## Créditos

**Autor:** Maximiliano Dobladez — [elmaxi@gmail.com](mailto:elmaxi@gmail.com)

**Organización:** [MKE Solutions](https://mkesolutions.net)

Desarrollado como plugin de Claude Code para delegar tareas de código a modelos alternativos via gateways OpenAI-compatible (Ollama, LiteLLM, proxies custom).
