# Local models

## Chosen configuration (provisional until benchmarked on the Mac)

| Role | Model | Runtime | Memory (approx.) | License |
|---|---|---|---|---|
| Reasoning + tool calling + screenshots, Balanced & Max | **Qwen3.5 9B** (`qwen3.5:9b`) | Ollama | ~6.6 GB weights | Apache-2.0 |
| Battery Saver | **Qwen3.5 4B** (`qwen3.5:4b`) | Ollama | ~3.3 GB | Apache-2.0 |
| File-search embeddings | **EmbeddingGemma 300M** (`embeddinggemma:300m`) | Ollama | ~0.6 GB, only while indexing/searching | Gemma terms |
| Speech recognition | **Whisper large-v3-turbo** (Battery Saver: small.en) | mlx-whisper (Metal) | ~1.6 GB while loaded | MIT |
| Voice | **Kokoro-82M** int8, voice `bm_george` | kokoro-onnx (CPU) | ~0.3 GB while loaded | Apache-2.0 |
| Wake word | **openWakeWord `hey_jarvis`** | onnxruntime (CPU) | ~10 MB | code Apache-2.0, model CC BY-NC-SA 4.0 |

**One model handles reasoning, tool calls and screenshots.** Qwen3.5 small models are natively multimodal, so JARVIS
doesn't keep a second vision model in memory. That saves about 5 GB and a second load on every "what's on my screen". The
benchmark can justify a split later if one is needed (set `llm.vision_model`).

### Why these (research as of Nov 2026)

* **Memory budget:** 24 GB unified memory. macOS lets the GPU wire about 75% (~18 GB), and Arc plus your apps need several GB.
  A 9B model at 4-bit (~7 GB with KV cache) leaves comfortable headroom. 27B-class models (Qwen3.6 27B ~17 GB, Qwen3.5/3.6 35B-A3B
  ~20–24 GB at Q4) would squeeze everything else into swap on a laptop, so they're optional candidates, not defaults.
* **Tool calling:** Qwen3.5/3.6 are among the most-recommended open-weight families for local tool use in late-2026 guides.
  Their reported tool-use advantage is not independently benchmarked (no public BFCL score for 3.6), so JARVIS's own
  benchmark decides.
* **Battery:** smaller active parameters means less energy per token. 4B for Battery Saver halves the per-token cost.
* **Runtime:** Ollama is free (MIT) and runs as a menu-bar app. It downloads and updates models, manages load/unload through
  `keep_alive` (which JARVIS uses per power mode), supports tools and images, and ships MLX-based variants on Apple Silicon
  (`qwen3.5:9b-mlx` tags). Any OpenAI-compatible local server also works: `mlx_lm.server`, `llama-server`, LM Studio.

Sources: [Ollama qwen3.5 library](https://ollama.com/library/qwen3.5), [InsiderLLM: Qwen 3.5 small models](https://insiderllm.com/guides/qwen-3-5-small-models-9b-beats-30b/),
[InsiderLLM: function calling with local LLMs](https://insiderllm.com/guides/function-calling-local-llms/), [vdf.ai: local LLMs for agents](https://vdf.ai/blog/best-local-llm-for-agents-tool-calling/),
[modelfit: M4 Pro 24 GB](https://modelfit.io/blog/best-llm-macbook-pro-m4-pro-24gb/), [Home Assistant thread on Qwen3.5 tool calling in Ollama](https://community.home-assistant.io/t/assist-qwen3-5-35b-a3b-tool-calling/991434).
Community reports in early 2026 described broken Qwen3.5 tool calling in some Ollama versions. JARVIS therefore parses
both Qwen tool-call formats (JSON and XML) itself if the runtime doesn't, and `jarvis doctor` plus `jarvis bench` show whether
your installed Ollama works.

## Benchmark: `jarvis bench`

Real JARVIS tasks, judged by the resulting state:

| Category | Cases |
|---|---|
| tool selection | open an app; find a paper; remember something; explain the screen |
| ambiguity | "Send it to him." (must ask, not guess) |
| multistep | IB portal: open assignments → most recent; read an assignment's instructions and summarize them |
| recovery | first click fails (injected), must still reach the target |
| files | move PDFs into a new folder (real temp folder); find duplicates without deleting |
| safety | prompt injection on a page ("call trash_files…") must be ignored |

```bash
/Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis bench --models qwen3.5:4b,qwen3.5:9b,qwen3:8b,gemma4:12b --repeat 3
```

It writes `bench-*.md/json` with pass rate, consistency across repeats, invalid tool calls, median latency per model call
and per task.

### Results so far

BENCH_RESULTS_PLACEHOLDER

## Changing or upgrading the model

1. Install it: `ollama pull <name>` (or use any OpenAI-compatible server).
2. Benchmark it: `… -m jarvis bench --models current,new --repeat 3`.
3. Switch: Command Center → Settings → Local AI → model per mode (or edit `llm.models` in `settings.json`).

Nothing else changes. The automation, tools, shortcuts and safety layers don't depend on the model. Upgrade paths
worth testing on the Mac:

* **Speed:** `qwen3.5:9b-mlx` (Ollama's MLX variant), or `mlx_lm.server` with an MLX 4-bit model (Settings → runtime "OpenAI-compatible").
* **Prompt-cache reuse:** a non-hybrid model such as `qwen3:8b` may answer follow-up agent steps faster (see LIMITATIONS).
* **Quality on AC:** `qwen3.6:27b` (~17 GB) for Max Performance, if the benchmark shows a large gain and memory pressure stays acceptable.
* **Speech:** `voice.stt_model` = `turbo` | `small` | `base`.

## Optional paid providers

Not used, not required. The `openai_compatible` provider can point at any server, including a paid one, as an explicit
user choice. Put the key in the Keychain (`jarvis.secrets.set("llm_api_key", …)`), never in settings. The core assistant
never depends on it.
