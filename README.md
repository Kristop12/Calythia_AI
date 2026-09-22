# Calythia UI

An animated **autonomous-agent orb + reasoning-graph** interface — based on the open-source
front-end of [Apex](https://reznikov-engineering.com/apex), rebranded as **Calythia**.

Tap the orb to cycle its state (idle → thinking → speaking); the reasoning web reacts,
agent nodes orbit the core, and clicking any node opens an overview card. Chat with a
**local LM Studio** model to drive the same states for real, with replies spoken via
the browser’s Web Speech TTS. The orb ring, agent graph and status bar are
**hand-written SVG / CSS**; the cyan particle core is a small `react-three-fiber`
scene (skipped under `prefers-reduced-motion`); and the WebGL shader backdrop + the
overview lamp panel are **MIT community components from
[21st.dev](https://21st.dev/community/components)** (see [CREDITS](./CREDITS.md)).

> Built with Next.js 15 + React 19. Runtime deps: `lucide-react` (icons) and
> `three` / `@react-three/fiber` / `@react-three/postprocessing` (the particle core) —
> all MIT-licensed.

## Demo

```bash
npm install
npm run dev
# open http://localhost:3000
```

Then `npm run build` for a production build, or deploy to Vercel in one click.

## Local LLM (LM Studio) + TTS

1. Install [LM Studio](https://lmstudio.ai), download a model, and start **Developer → Local Server** (default `http://127.0.0.1:1234`).
2. Copy env defaults and adjust if needed:

```bash
cp .env.example .env.local
```

| Variable | Default | Notes |
|----------|---------|--------|
| `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible base |
| `LM_STUDIO_MODEL` | _(empty)_ | Pin your **already-loaded** model id — keeps MCP on the same model (no extra load) |
| `LM_STUDIO_WHISPER_MODEL` | _(empty)_ | Optional Whisper model id for mic transcription |
| `LM_STUDIO_API_TOKEN` | _(empty)_ | Required for MCP via API (see below) |
| `LM_STUDIO_MCP` | `1` | Set `0` to disable MCP and use plain chat completions |

3. Open the bottom-right **Calythia chat** panel:
   - **Type** or tap **Mic** → speak → **Done** (records locally, then Whisper transcription)
   - orb → **listening** while recording → **thinking** while the LLM runs → **speaking** while tokens / TTS play
4. **TTS** uses **Kokoro** in the browser (`kokoro-js`, voice **af_heart** by default). First load downloads the ONNX model from Hugging Face (one-time). Pick other Kokoro voices in the chat header. If Kokoro fails, Calythia falls back to the system Web Speech API.

### MCP tools (LM Studio 0.4+)

Calythia can call the same MCP servers you configured in LM Studio (`~/.lmstudio/mcp.json`) — currently **`personal-pc`**.

1. In **LM Studio → Developer → Server Settings**:
   - Enable **Require Authentication**
   - Enable **Allow calling servers from mcp.json**
   - **Manage Tokens** → create a token → put it in `.env.local` as `LM_STUDIO_API_TOKEN=...`
2. Restart `npm run dev` after editing env.
3. Check wiring: open [http://localhost:3000/api/mcp](http://localhost:3000/api/mcp) — you should see `integrations` like `mcp/personal-pc`.

Without those server settings, chat still works via `/v1/chat/completions` (no tools). With MCP on, chat uses `POST /api/v1/chat` and streams replies the same way in the UI.

### Jarvis native tools (recommended)

Calythia owns a **native tool registry** — the LLM is only the brain; the Next.js server runs tools and feeds results back (same pattern as coding agents).

```
Calythia (voice, memory, tool router)
        │
        ▼
   Local LM Studio ──or── Grok (xAI API)
        │
   ┌────┴────┬────────────┬──────────┐
   ▼         ▼            ▼          ▼
open_url  run_terminal  browse_web  youtube_info
   │         │            │          │
 Browser    shell      Browser Use  yt-dlp
```

In the Messages header, pick **Local** or **Grok**, then a model. Native tools still run on your Mac either way.

| Agent mode | Execution |
|------------|-----------|
| **Auto** | Native tools when your message needs PC/browser/files/scripts |
| **Agent** | Full native tool set every turn |
| **PC** | Legacy `personal-pc` MCP only (fallback; Local provider only) |
| **Chat** | No tools |

**Native tools:** `open_url`, `run_terminal`, `read_file`, `list_directory`, `youtube_info`, `youtube_transcript`, `browse_web`, `run_agent_task` (Open Interpreter exec).

Preview: `http://localhost:3000/api/mcp?q=open%20youtube&mode=auto` — check `nativeToolNames` and `useNativeTools`.

**Setup:**

1. `CALYTHIA_NATIVE_TOOLS=1` in `.env.local` (see [`.env.example`](.env.example))
2. **yt-dlp:** `brew install yt-dlp` (YouTube metadata — not AI browser)
3. **Open Interpreter:** `curl -fsSL https://www.openinterpreter.com/install | sh` — used by `run_agent_task`
4. **Browser Use:** Python 3.12 venv at `~/.venvs/browser-use` with `uv pip install browser-use` + `uvx browser-use install`
5. **Local model:** Prefer a **tool-calling / coder model** in LM Studio (Qwen3-Coder, etc.)

### Grok (xAI) cloud brain

1. Create an API key at [console.x.ai](https://console.x.ai)
2. In `.env.local`:
   ```bash
   XAI_API_KEY=xai-...
   XAI_MODEL=grok-4.6
   ```
3. Restart `npm run dev`
4. In chat: set provider to **Grok**, pick a model (list from `/api/models?provider=grok`)

MCP / personal-pc integrations apply only when provider is **Local**. Browser Use / Open Interpreter sidecars still use LM Studio for their own LLM calls.

### Open Interpreter + MCP (fallback)

**Mic / STT:** Chrome’s built-in speech recognition talks to Google and often fails with `network`. Calythia records audio in the browser and sends it to LM Studio’s **`/v1/audio/transcriptions`** instead. Load a **Whisper** (speech-to-text) model in LM Studio; optionally set `LM_STUDIO_WHISPER_MODEL` in `.env.local`.

The Next.js route `POST /api/chat` proxies chat (with optional MCP), and `POST /api/transcribe` proxies Whisper, so the browser never talks to LM Studio directly (avoids CORS).

## What's inside

| Piece | What it does |
|-------|--------------|
| `ApexOrb` | The golden ring frame, waveform and orbit dots (pure SVG) |
| `ApexCore3D` | The cyan particle core (`react-three-fiber` + bloom) |
| `ApexHeroOrb` | Stacks the SVG ring + the particle core, scaled to fit |
| `ReasoningWeb` | The agent constellation — circuit traces, orbit rings, 18-node roster |
| `OrbStatusBar` | The equalizer + STANDBY cluster along the bottom |
| `ShaderBackground` | Animated WebGL "plasma waves" backdrop (MIT component from 21st.dev — see CREDITS) |
| `ApexWorld` | Composes the above; owns orb state, chat wiring, and agent overview cards |
| `ApexChat` | LM Studio chat panel — streams replies and drives orb + TTS |
| `ApexOverviewPanel` | Top-left HUD: live clock, weather, and social links |
| `app/api/chat` | LM Studio or Grok + native tool loop + RAG; MCP fallback (Local only) |
| `app/api/models` | List LM Studio / Grok models for the UI picker |
| `app/api/mcp` | Debug: MCP servers + native tool routing preview |
| `lib/agentLoop.ts` | Tool-calling loop against `/v1/chat/completions` |
| `lib/llmProvider.ts` | Resolve Local vs Grok OpenAI-compatible targets |
| `lib/tools/` | Native Jarvis tool registry (browser, terminal, yt-dlp, OI) |
| `app/api/memory` | List / append project memory notes |
| `lib/rag.ts` | Load `memory/*.md`, retrieve top chunks for each query |
| `lib/lmstudio.ts` | LM Studio origin helpers + mcp.json → integrations |
| `memory/` | Durable notes (Christopher, Calythia, free-form notes) |
| `app/api/transcribe` | Whisper proxy for mic voice-to-text |
| `app/api/weather` | Keyless [open-meteo](https://open-meteo.com) proxy for the panel's weather |

## Customise

- **Social links** → edit `TILES` in `components/ApexOverviewPanel.tsx`.
- **Weather** → auto-detects the **visitor's** city on Vercel (geo headers); off-Vercel / localhost shows "your town".
- **Agents & copy** → the `ROSTER` and `INFO` maps in `components/ApexWorld.tsx`.
- **Backdrop** → the shader in `components/ShaderBackground.jsx`; its opacity/tint are set where `<ShaderBackground>` is used in `ApexWorld.tsx`.
- **LM Studio** → `.env.local` (`LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`).
- **RAG memory** → put notes in [`memory/`](./memory/). Each chat turn retrieves relevant chunks into the prompt (no second model). Say **“remember …”** in chat/voice to append to `memory/notes.md`.

## Accessibility

The decorative SVG graph is mirrored by a real, keyboard-navigable agent list
(`.visually-hidden`), the orb and every control are focusable, and the whole thing
respects `prefers-reduced-motion` (including muting TTS).

## Not included (on purpose)

This repo is the **UI + local LLM bridge**. The production Apex page also has a
spoken-voice layer and a "story" narrative built from personal recordings — those
are intentionally left out. Browser TTS covers spoken replies for local demos.
