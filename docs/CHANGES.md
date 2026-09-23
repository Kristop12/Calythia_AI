# Calythia — recent additions & changes

Notes for what landed in the Jarvis / multi-provider workstream. See also [README](../README.md) and [`.env.example`](../.env.example).

---

## 2026-09 — Grok cloud brain + native tools + voice

### Added

| Item | Where | Purpose |
|------|--------|---------|
| **Grok (xAI) provider** | `lib/llmProvider.ts`, `lib/llmProviderClient.ts` | Switch Calythia’s LLM between Local (LM Studio) and Grok cloud. Calythia still owns tool execution on the Mac. |
| **Model list API** | `GET /api/models?provider=lmstudio\|grok` | Populate Provider / Model dropdowns in chat. |
| **UI provider + model pickers** | `components/ApexChat.tsx` | Persist choice in `localStorage` (`calythia-llm-provider`, `calythia-llm-model`); send `provider` + `model` on each chat request. |
| **xAI env vars** | `.env.example` / `.env.local` | `XAI_API_KEY`, `XAI_MODEL`, optional `XAI_BASE_URL`. |
| **Native tool registry** | `lib/tools/*`, `lib/agentLoop.ts` | Jarvis-style loop: LLM requests tools → Next.js runs them → results go back → final spoken answer. |
| **Native tools** | `open_url`, `run_terminal`, `read_file`, `list_directory`, `youtube_info`, `youtube_transcript`, `browse_web`, `run_agent_task` | PC / browser / files / YouTube / Open Interpreter. |
| **Agent modes** | `lib/agentMode.ts` | Auto / Agent / PC / Chat in the Messages header. |
| **MCP examples** | `docs/mcp.json.example`, `docs/open-interpreter.config.example.toml` | Sample LM Studio MCP + Open Interpreter config. |
| **Browser Use helper** | `scripts/browser_task.py` | Sidecar script for `browse_web`. |

### Changed

| Change | Detail |
|--------|--------|
| **`POST /api/chat`** | Accepts `provider` + `model`. Resolves LLM via `resolveLlmTarget`. Native tool loop first; MCP fallback only for **Local**. |
| **Agent loop streaming** | `lib/agentLoop.ts` opens SSE **immediately**, emits tool status (`tool_start` / `tool_done`), keepalives while tools run, and only streams the **final** answer after tool results are applied. Turn no longer ends before tools finish. |
| **Chat UI while tools run** | Shows `Running open_url…` / `…done — waiting for result…`; does **not** speak until the model answers from results. |
| **Text / XML tool-call fallback** | Parses `<tool_call>` / `<function=…>` content when local models don’t return structured `tool_calls`. |
| **Chat max duration** | `maxDuration = 300` on `/api/chat` for long browser / script tools. |
| **Wake words** | `lib/wake.ts` — `Caly`, `Calythia`, `Thia`, `Eli` (+ STT mishearings), optional `Hi` / `Hello` before the name. |
| **Voice session** | After one wake (“Eli” or “Eli, …”), follow-ups work **without** repeating the wake word until voice mode is stopped. |
| **Mic resume** | `scheduleListen` retries until streaming + TTS are idle so listening comes back after she speaks. |
| **Kokoro TTS** | More resilient load (WebGPU → wasm/q8 retry), clearer status in UI. |
| **System / tool hints** | Model is told to **call tools and wait for results** before claiming success. |

### Env checklist

```bash
# Local brain
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=          # pin loaded model id
LM_STUDIO_API_TOKEN=      # for MCP fallback
LM_STUDIO_MCP=1

# Native tools (recommended)
CALYTHIA_NATIVE_TOOLS=1

# Optional Grok brain
XAI_API_KEY=
XAI_MODEL=grok-4.6
```

### How to try it

1. `npm run dev` (restart after any `.env.local` change).
2. Chat header: **Local** or **Grok** → pick a model → **Auto** or **Agent**.
3. Voice: start talk mode → say **“Eli, open YouTube”** → wait for tool status → spoken reply after the tool result → follow-ups without saying Eli again.
4. Debug tools: [http://localhost:3000/api/mcp?q=open%20youtube&mode=auto](http://localhost:3000/api/mcp?q=open%20youtube&mode=auto)

### Not changed (by design)

- Browser Use / Open Interpreter still use **LM Studio** for their own LLM calls even when chat brain is Grok.
- MCP / `personal-pc` only when provider is **Local**.
- Project memory still lives under `memory/` + `lib/rag.ts`.
