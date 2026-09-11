# Gemini ↔ Claude Bridge

Plugin de Claude Code que le pasa a **Google Gemini** las tareas que consumen mucho contexto: leer archivos y logs grandes, analizar muchos archivos a la vez, revisar código, generar código repetitivo o planes. Gemini corre en tu propio [`gemini` CLI](https://github.com/google-gemini/gemini-cli), ya logueado.

El bridge le manda los archivos a Gemini directamente, así que su contenido **nunca entra en el contexto de Claude**. De ahí sale el ahorro: un solo resumen delegado de un log de 4.000 líneas dejó ~68.000 tokens fuera del contexto de Claude.

El bridge nunca ve ni guarda una API key. Usa la cuenta con la que esté logueado el `gemini` CLI de cada persona.

Está inspirado en [andytargino/gemini-bridge](https://github.com/andytargino/gemini-bridge). Frente a ese, este bridge:

- **Se prende y apaga hablando.** "apagá el bridge" o "turn the Gemini bridge off", y Claude lo cambia.
- **Lee bien los archivos grandes.** El CLI de Gemini adjunta en silencio solo las primeras 2.000 líneas de un archivo. El bridge los manda completos y con números de línea, así no se pierde el error de la línea 2.817. Medido: de 95 s y medio archivo leído a 9 s y el archivo entero.
- **Cuida la calidad de las respuestas.**
  - Gemini respalda cada afirmación con `archivo:línea` y el texto exacto.
  - El bridge verifica esas citas contra el archivo real y corrige las que no coinciden.
  - Las revisiones hechas por el modelo más liviano llegan marcadas como "primera pasada".
  - Hay una segunda pasada opcional en la que Gemini revisa su propia respuesta.
- **No se traba por la cuota.**
  - Prueba los modelos en orden. Un modelo sin cuota se abandona en ~2 s y queda en espera hasta que su cuota vuelva.
  - Aprende el tope de tokens por minuto de cada modelo. No manda un archivo grande a una espera: prueba otro modelo o lo pasa a segundo plano.
- **Es rápido.** Mantiene un proceso de Gemini prendido entre llamadas, se saltea el relanzamiento del CLI y guarda en caché las preguntas repetidas.
- **No bloquea a Claude.** Las tareas largas pueden correr en segundo plano mientras Claude sigue trabajando.
- **Le avisa a Claude.** Antes de que Claude lea entero un archivo grande, le sugiere delegarlo.
- **Se instala con dos comandos** y tiene instalación guiada (`/gemini-claude-bridge:setup`). Es un plugin, funciona nativo en Windows y no hace falta copiar nada con `cp`/`chmod`.
- **Está probado.** Tiene tests unitarios y una prueba de punta a punta de los bundles compilados, que corren en Windows, Linux y macOS con cada push.

## Qué incluye

| Pieza | Qué hace |
|---|---|
| Herramienta `gemini_ask` | Le delega a Gemini una tarea (pedido + archivos/carpetas + modo + objetivo + formato) y devuelve su respuesta en texto. |
| Herramienta `gemini_result` | Levanta la respuesta de un `gemini_ask` en segundo plano, o lista los trabajos de la sesión. |
| Herramienta `gemini_bridge_status` | Muestra si el bridge está prendido, qué falta instalar (con el comando), el CLI y el login, ripgrep, los modelos en espera y los topes por minuto, la velocidad de los últimos 7 días, el uso y las preferencias. |
| Herramienta `gemini_bridge_toggle` | Prende o apaga la delegación. Queda guardado entre sesiones y proyectos. |
| `/gemini-claude-bridge:gemini-ask` | Comando explícito: `/gemini-claude-bridge:gemini-ask resumí C:\logs\build.log` |
| `/gemini-claude-bridge:setup` | Instalación guiada: revisa Node, el CLI de Gemini, el login o la key y ripgrep, y dice exactamente qué falta. |
| Aviso al iniciar sesión | `Gemini bridge: ON · Gemini CLI 0.59.0 · 12 delegated calls so far` |
| Hook de lectura | Cuando Claude va a leer entero un archivo de 800 líneas o más, le sugiere `gemini_ask`. Solo una vez por archivo y por sesión: si Claude repite el Read, pasa. |

Las herramientas están siempre registradas. Con el bridge apagado, `gemini_ask` se niega al instante sin arrancar Gemini, y Claude hace el trabajo por su cuenta.

## Requisitos

La forma más fácil de cumplirlos es instalar el plugin y correr `/gemini-claude-bridge:setup`.

1. **Claude Code** (CLI, app de escritorio o extensión del IDE).
2. **Node.js 20 o más nuevo.** Claude Code arranca el bridge con `node`. En Windows: `winget install OpenJS.NodeJS.LTS`. En macOS: `brew install node`.
3. **El CLI de Gemini, con una API key propia:**
   ```bash
   npm install -g @google/gemini-cli
   ```
   - Creala gratis en https://aistudio.google.com/apikey (con una cuenta de Google cualquiera; no hace falta tarjeta).
   - Poné `GEMINI_API_KEY=<tu key>` en `~/.gemini/.env` (en Windows: `C:\Users\<vos>\.gemini\.env`).
   - Corré `gemini` una vez y elegí **Gemini API key**.

   El bridge nunca toca la key.

   **No inicies sesión con "Sign in with Google" para esto.** Los [términos del CLI de Gemini](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) prohíben que una herramienta de terceros —este bridge incluido— use ese inicio de sesión para acceder a Gemini; su propio [FAQ](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md) nombra a Claude Code como ejemplo. Hacerlo puede terminar en la suspensión de la cuenta de Google. Por eso, aunque una suscripción **Google AI Pro/Ultra** (la que suelen dar gratis a estudiantes) te daría más cuota vía "Sign in with Google", el bridge no la usa ni la va a usar: se queda con la API key, que es el método que Google mismo recomienda para agentes de terceros. Si ya usabas `gemini` con tu cuenta de Google para vos mismo, cambiá a la API key antes de usar el bridge — `gemini_bridge_status` avisa si sigue detectando ese inicio de sesión.
4. **Acceso a este repo privado.** El dueño te agrega como colaborador, y git necesita credenciales de GitHub:
   ```bash
   gh auth login
   gh auth setup-git
   ```
5. **Opcional, recomendado: ripgrep.** Hace más rápidas las búsquedas de Gemini.
   - En **Windows** tiene que instalarse para toda la máquina, desde una terminal de **administrador**, porque el CLI de Gemini ignora una instalación de usuario:
     ```bash
     winget install --id BurntSushi.ripgrep.MSVC --scope machine
     ```
   - En macOS: `brew install ripgrep`. En Linux: `sudo apt install ripgrep`.

## Instalación

```bash
claude plugin marketplace add https://github.com/bautibuthet-git/Gemini-Claude-bridge.git
claude plugin install gemini-claude-bridge@gemini-claude-bridge
```

Después cerrá Claude Code del todo, abrilo de nuevo y corré **`/gemini-claude-bridge:setup`**, o preguntale a Claude: **"¿está funcionando el gemini bridge?"**.

- La URL HTTPS va a propósito: el atajo `dueño/repo` usa SSH por defecto, que solo funciona si tenés claves SSH configuradas en GitHub.
- La instalación sigue el último commit (`claude plugin list` muestra un SHA como versión).
- El plugin se instala para tu usuario, así que funciona en todos los proyectos.
- Cada persona usa su propia cuenta de Gemini. Compartir el plugin nunca comparte la cuota ni la key de nadie.

**Para actualizar:**

```bash
claude plugin marketplace update gemini-claude-bridge
claude plugin update gemini-claude-bridge@gemini-claude-bridge
```

Después reiniciá Claude Code.

**Opcional: que no pregunte permiso en cada llamada.** Agregá esto a `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_gemini-claude-bridge_gemini-claude-bridge__*"]
  }
}
```

## Cómo se usa

Hablale normal a Claude:

| Vos decís | Qué pasa |
|---|---|
| "Usá Gemini para resumir C:\logs\build.log" | `gemini_ask`, modo `summarize`; Claude nunca lee el log |
| "Que Gemini revise src/auth/ buscando bugs" | `gemini_ask`, modo `review`, con el modelo más fuerte que tenga cuota |
| "Preguntale a Gemini qué más falla en ese log" | Una repregunta: Gemini todavía tiene el archivo y no se reenvía nada |
| "Que Gemini arme los tests de estos 5 archivos en segundo plano" | `background: true`; Claude sigue trabajando y lo levanta con `gemini_result` |
| "¿Está prendido el gemini bridge?" | `gemini_bridge_status` |
| "Apagá el bridge" / "prendé el bridge" | `gemini_bridge_toggle` |

Claude también delega por su cuenta cuando una tarea claramente conviene, y el hook de lectura le recuerda hacerlo antes de leer entero un archivo grande. Apagar el bridge frena todo eso.

### Delegar la lectura, no el pensamiento

La regla que sigue Claude: a Gemini se le piden **hechos, ubicaciones y citas exactas**, y **las conclusiones las saca Claude**. Por ejemplo, en vez de preguntarle a Gemini "¿es seguro este código?", se le pide "mostrame cada lugar donde un dato del usuario llega a una consulta SQL, con la línea".

Esto importa porque Claude solo ve la respuesta de Gemini. Si Gemini hace una lectura superficial, esa sería la única imagen del archivo que tiene Claude. Pedir evidencia en lugar de veredictos hace que una lectura superficial se note, y la verificación de citas la atrapa.

### Parámetros de `gemini_ask`

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `prompt` | obligatorio | El pedido. Tiene que entenderse solo: Gemini ve el pedido y los archivos, no la conversación. |
| `paths` | ninguno | Hasta 20 archivos o carpetas. Los archivos van completos, con números de línea; las carpetas las lee el CLI recorriéndolas. |
| `mode` | `ask` | `ask` · `summarize` (hechos clave y errores con número de línea) · `analyze` · `review` · `refactor` · `plan` · `test`. |
| `goal` | ninguno | Para qué es la respuesta ("decidir si hay que reintentar el export"). Gemini conserva lo que importa para eso y avisa si el material no alcanza. |
| `format` | ninguno | Qué necesita Claude de vuelta: "5 viñetas", "solo problemas como archivo:línea — problema — arreglo", "máximo 200 palabras". |
| `thorough` | `false` | Segunda pasada: Gemini revisa su respuesta contra el material (citas, omisiones, exageraciones) y devuelve una versión corregida. Cuesta ~el doble de tiempo y cuota (el límite de tiempo por defecto se duplica); para revisiones grandes conviene sumarle `background: true`. |
| `followUp` | ninguno | El id que aparece al final de una respuesta; continúa esa conversación. |
| `background` | `false` | Devuelve un id de trabajo al instante; la respuesta se levanta con `gemini_result`. |
| `fresh` | `false` | Vuelve a preguntarle a Gemini aunque haya una respuesta reciente a la misma pregunta sobre los mismos archivos. |
| `model` | la cadena | Probar primero este modelo; la cadena lo respalda igual. |
| `timeoutMs` | `180000` (el doble con `thorough`) | Tiempo total, con reintentos y segunda pasada incluidos (de 5 s a 30 min). Cuando se acaba, se frena Gemini. |
| `yolo` | `false` | Aprueba solas las herramientas de Gemini (por ejemplo, buscar en la web). Solo si lo pide el usuario. |

### Qué se agrega al final de cada respuesta

- **Verificación de citas.** Por ejemplo: `[quotes checked by the bridge against the files: 4 exact · 1 misquoted]`, y por cada problema, el **texto real** de esa línea. Así se detecta, por ejemplo, un `10:58` copiado de una línea que en el archivo dice `10:57`.
- **Sin citas verificables.** Si Gemini no citó nada comprobable sobre archivos adjuntos, la respuesta queda marcada como no verificada.
- **"Primera pasada, verificá antes de actuar"** cuando una revisión, refactor, plan o tests la respondió el modelo más liviano.
- **El pie:** modo, modelo, tiempo, proceso persistente o no, cantidad de pasadas, la **confianza que declaró Gemini**, los tokens que no entraron al contexto de Claude, los modelos que se saltearon por cuota y el id para repreguntar (`followUp`).

## Cómo funciona

1. **Primero se chequea si está apagado.** Si lo está, la llamada devuelve `disabled` y no arranca ningún proceso.
2. **Los archivos van dentro del pedido, completos.** Se resuelven las rutas y los archivos de texto viajan con números de línea (hasta 6 MB por llamada). Las carpetas, los binarios (imágenes, PDFs) y los archivos enormes quedan como referencias `@"<ruta>"` para el CLI, con un aviso de que solo adjunta sus primeras 2.000 líneas. Cualquier otro `@` se escapa, para que el CLI no salga a buscar archivos que nadie pidió.
3. **El pedido se arma según el modo.** Incluye el encuadre del modo, el objetivo, el formato, reglas de respuesta (evidencia `archivo:línea` + texto exacto, cierre con `Coverage:` y `Confidence:`) y una barrera de solo lectura: Gemini no puede editar ni ejecutar nada. Si los archivos van completos en el pedido, además se le pide que responda directo, sin herramientas: cada lectura extra es otra vuelta lenta al modelo (una revisión de un archivo de 20 líneas llegó a gastar 47.000 tokens y 47 s releyendo archivos). Solo con carpetas, repreguntas o `yolo` se le permite leer y buscar, y cada archivo que lee aparece como aviso de progreso.
4. **Los modelos se prueban en cadena.**
   - Las tareas rápidas (`ask`, `summarize`, `analyze`) arrancan con `gemini-3.1-flash-lite`. Las pesadas (`review`, `refactor`, `plan`, `test`) arrancan con `pro`.
   - Ante un error de cuota, el proceso se abandona en ~2 s. El modelo queda en espera hasta que su cuota vuelva: hasta la medianoche del Pacífico si agotó la cuota diaria, 24 h si su cuota es "limit: 0", o el tiempo que indique Google si es un tope por minuto. Después se prueba el siguiente.
   - Un error pasajero tiene un reintento.
5. **Presupuesto por minuto.** El bridge aprende el tope de tokens por minuto de cada modelo del propio error de Google y lleva la cuenta de lo enviado.
   - Si mandar ahora un archivo grande obligaría a esperar, prueba primero otro modelo.
   - Si todos tendrían que esperar 20 s o más, la llamada pasa sola a segundo plano y Claude sigue trabajando.
6. **Un proceso persistente atiende la mayoría de las llamadas.** Gemini corre como un proceso `gemini --acp` que queda prendido. Cada llamada es una sesión nueva y una repregunta reutiliza la suya. Cualquier permiso que pida Gemini se rechaza. Si un modelo no da ninguna señal de vida en ~40 s (así se queda en ese proceso cuando se le terminó la cuota diaria, sin avisar), se le vuelve a preguntar con un proceso por llamada, que sí informa el error. Las llamadas con referencias `@` o `yolo` usan en cambio un proceso `gemini` por llamada:
   - Con `--output-format json --skip-trust --approval-mode=default`.
   - Con el pedido por stdin, porque cmd.exe corta los argumentos en el primer salto de línea.
   - Desde una carpeta vacía propia del bridge, sumando las carpetas necesarias con `--include-directories`.
7. **Límites de seguridad en cada llamada.**
   - Un límite de tiempo duro mata todo el árbol de procesos.
   - Las notificaciones de progreso mantienen informado a Claude Code, incluso cuando el CLI espera por la cuota por minuto.
   - Una respuesta completa se conserva aunque el CLI se caiga al cerrar (pasa en Windows desde que está ripgrep).
8. **Se verifica y se devuelve.** El bridge compara las citas contra los archivos, agrega las advertencias y el pie, y lo devuelve como texto. Las preguntas idénticas sobre archivos sin cambios se responden desde una caché de 24 h.

| `errorType` | Qué significa / qué hacer |
|---|---|
| `disabled` | El bridge está apagado. Claude hace la tarea él mismo. |
| `not_installed` | `gemini` no está en el PATH. Instalalo; el bridge también lo busca en las carpetas de instalación estándar. |
| `not_authenticated` | Configurá una API key (ver Requisitos). |
| `quota` | Todos los modelos de la cadena están sin cuota. El mensaje dice cuándo se recupera cada uno. |
| `timeout` | Achicá la tarea, usá `background: true` o subí `timeoutMs`. |
| `gemini_error` | Cualquier otro error del CLI, con su mensaje. |
| `invalid_paths` | Una ruta no existe. Claude la corrige y reintenta. |
| `unknown_job` | `gemini_result` recibió un id que esta sesión no conoce. |

## Velocidad y el plan gratuito

Medido en Windows con una API key gratuita:

| | Tiempo |
|---|---|
| Resumir un log de 4.000 líneas, archivo completo, proceso persistente | **9 s** (antes 95 s, con referencias `@`) |
| Pregunta trivial, proceso por llamada (sin relanzamiento del CLI) | ~5–8 s |
| Revisión con dos modelos sin cuota antes del que responde | 21 s; cada modelo sin cuota costó ~1–2 s |

Con una key gratuita:

- `pro` no tiene cuota, y `flash` da unos 20 pedidos por día. Las cadenas lo manejan solas, y `gemini_bridge_status` muestra qué modelos están en espera y hasta cuándo. Si `flash` agota su cuota diaria en medio de una llamada, esa llamada pierde ~40 s en darse cuenta; las siguientes lo saltean hasta la medianoche del Pacífico.
- `flash-lite` tiene un **tope de 250.000 tokens de entrada por minuto**. Un log de 4.000 líneas se come buena parte, y preguntar dos veces por él dentro del mismo minuto hacía esperar 64 s al CLI. Ahora el bridge ve venir esa espera: usa otro modelo o pasa la llamada a segundo plano. Una repregunta reenvía la conversación (archivo incluido), así que también cuenta.
- El modelo más liviano puede equivocarse en detalles (copió `10:58` en vez de `10:57`) o exagerar en una revisión. Para eso están la verificación de citas, la marca de "primera pasada", la confianza declarada y `thorough`.

**¿Se puede usar la cuota de una suscripción Google AI Pro/Ultra (la que dan gratis a estudiantes) para tener más margen?** No con este bridge. Esa cuota más alta (1.500 pedidos/día, contra 250/día de una API key gratis, según la [documentación del CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md)) solo se habilita iniciando sesión con Google, y eso es justamente lo que sus [términos](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) prohíben para una herramienta de terceros. La forma de tener más margen sin ese riesgo es habilitar facturación en la misma API key gratuita (pago por uso en Google AI Studio): no cambia nada del bridge, y los precios de Gemini son bajos — pero es plata real, así que es una decisión tuya, no algo que el bridge haga solo.

## Privacidad y seguridad

- **Qué sale de tu máquina:** el pedido, los archivos que pases y lo que Gemini lea dentro de las carpetas que se le dan (las referenciadas y la del proyecto). Todo va a Google bajo los términos de tu cuenta de Gemini. No delegues secretos.
- **Solo lectura por defecto.**
  - Las llamadas por proceso usan el modo de aprobación `default` sin interacción, que rechaza toda herramienta que necesite aprobación.
  - El proceso persistente responde con un rechazo a cualquier pedido de permiso.
  - El pedido además prohíbe editar y ejecutar.

  Claude es el único que edita tus archivos.
- **`--skip-trust` solo se aplica a la carpeta vacía propia del bridge.** Así nunca se carga el `.gemini/settings.json` de un proyecto, que podría definir servidores MCP o hooks.

## Configuración

Todo vive en `~/.gemini-claude-bridge/` (en Windows: `C:\Users\<vos>\.gemini-claude-bridge\`):

| Archivo | Contenido |
|---|---|
| `state.json` | Prendido/apagado, preferencias, modelos en espera, topes por minuto aprendidos, contadores de uso. |
| `history.jsonl` | Las últimas 500 llamadas (modelo, duración, resultado, tokens), para las estadísticas y el presupuesto por minuto. |
| `cache/` | Respuestas en caché. |
| `read-suggestions.json` | Qué archivos grandes ya mencionó el hook, por sesión. |
| `workspace/` | La carpeta vacía desde la que corre Gemini. |

Preferencias en `state.json` (se editan a mano y valen desde la llamada siguiente):

```json
{
  "preferences": {
    "model": null,
    "models": {
      "fast": ["gemini-3.1-flash-lite", "flash", "auto"],
      "strong": ["pro", "flash", "gemini-3.1-flash-lite"]
    },
    "engine": "auto",
    "timeoutMs": 180000,
    "cacheTtlMinutes": 1440,
    "suggestDelegation": { "enabled": true, "minLines": 800 },
    "approvalMode": "default"
  }
}
```

- `model` se prueba primero en todos los modos, antes que las cadenas. `"auto"`, `"pro"` y `"flash"` son alias del CLI de Gemini que siguen a sus modelos actuales.
- `engine` controla el proceso persistente: `"auto"` lo usa cuando se puede, `"acp"` lo prefiere, `"cli"` usa solo procesos por llamada.
- `cacheTtlMinutes: 0` apaga la caché.
- `suggestDelegation.enabled: false` apaga las sugerencias del hook.

Si el archivo falta o está incompleto, se usan los valores por defecto. Si está corrupto, se guarda una copia, se reinicia y se avisa una vez.

Variables de entorno:

- `GEMINI_CLAUDE_BRIDGE_HOME`: dónde se guarda todo lo anterior.
- `GEMINI_CLAUDE_BRIDGE_GEMINI_BIN`: usar un ejecutable de `gemini` específico.

## Problemas comunes

- **Las herramientas del bridge no aparecen en la app de escritorio.** La app toma el `PATH` al abrirse; si Node se instaló después, no puede arrancar el servidor. Cerrala desde la bandeja del sistema (revisá que no queden procesos `claude` en el Administrador de tareas, o reiniciá la PC) y abrí una conversación **nueva**. Para confirmar la causa, buscá `'node' is not recognized` en `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<proyecto>\mcp-logs-plugin-gemini-claude-bridge-gemini-claude-bridge\*.jsonl`. Una conexión fallida también queda en caché unos 15 minutos; `claude plugin marketplace update gemini-claude-bridge` la limpia.
- **`not_authenticated`, o `IneligibleTierError`.** Configurá una API key (ver Requisitos) — no hace falta loguearse con Google.
- **`quota`, o solo responde flash-lite.** Tus modelos están en espera; `gemini_bridge_status` dice hasta cuándo. Es el plan gratuito funcionando como corresponde.
- **`gemini_bridge_status` avisa que estás usando "Sign in with Google".** Cambiá a una API key (ver Requisitos): los términos del CLI de Gemini no permiten que una herramienta de terceros como este bridge use ese inicio de sesión, ni siquiera con una suscripción Google AI Pro/Ultra.
- **El estado dice `ripgrep: no (installed outside Program Files…)`.** Reinstalalo para toda la máquina desde una terminal de administrador (ver Requisitos).
- **Respuestas muy largas.** Claude Code corta los resultados de herramientas en unos 25.000 tokens (`MAX_MCP_OUTPUT_TOKENS`). Pedí un `format` más acotado o dividí la tarea.
- **`claude plugin marketplace add` falla con "could not read Username".** Corré `gh auth setup-git`.

## Desarrollo

```bash
git clone https://github.com/bautibuthet-git/Gemini-Claude-bridge.git
cd Gemini-Claude-bridge
npm install
npm run check
```

`npm run check` corre el typecheck, los tests unitarios, el build y la prueba de punta a punta. Esa prueba maneja los bundles compilados contra un `gemini` simulado que habla tanto el modo JSON por llamada como ACP. GitHub Actions corre lo mismo en Windows, Linux y macOS con cada push (`.github/workflows/check.yml`).

Ciclo de desarrollo:

- `claude --plugin-dir .` carga el plugin en el lugar, solo para esa sesión.
- `claude plugin marketplace add ./` seguido de `claude plugin install gemini-claude-bridge@gemini-claude-bridge` prueba la instalación real.

Reglas de la casa:

- **Commiteá `src/` y `dist/` recompilado juntos** (`npm run build`). `dist/` se commitea a propósito: instalar un plugin es un `git clone` sin paso de build. Tiene dos bundles:
  - `dist/index.js`: el servidor MCP más el aviso de inicio de sesión.
  - `dist/read-hook.js`: el hook de Read, de 5 KB, chico porque corre antes de cada Read.
- **`package-lock.json` no se commitea.** Si un plugin trae lockfile, Claude Code corre `npm ci` en la caché de cada usuario. En su lugar, las versiones están fijadas exactas en `package.json`.
- **No hay `version` en `plugin.json` ni en `marketplace.json`.** Así las instalaciones siguen el último commit.

```text
.claude-plugin/     plugin.json + marketplace.json (marketplace que se apunta a sí mismo, source "./")
mcp-servers.json    arranca node ${CLAUDE_PLUGIN_ROOT}/dist/index.js (no se llama .mcp.json, que también
                    es configuración MCP del proyecto y pediría permiso al abrir este repo)
hooks/hooks.json    aviso de SessionStart + sugerencia en PreToolUse(Read); ninguno bloquea para siempre
skills/             /gemini-claude-bridge:gemini-ask y /gemini-claude-bridge:setup
src/                servidor, tools/, gemini/ (adjuntos, prompts, citas, presupuesto, modelos, ejecutor,
                    motores por llamada y ACP, detección), state/, caché, historial, trabajos, hooks/, util/
dist/               los dos bundles, commiteados
scripts/            build, prueba de punta a punta, chequeo post-instalación
test/unit/          vitest
```

## Qué no incluye

- Otros proveedores además de Gemini.
- Forzar la delegación: el hook de lectura solo sugiere, y Claude decide.

## Licencia

MIT
