# ollama-agent-bench

> Benchmark your local Ollama models as orchestrator + worker agents — quality scores, think-level comparisons, and concurrent fanout, all visualized in a browser UI.

![Requires Ollama](https://img.shields.io/badge/requires-Ollama_%E2%89%A5_0.6-blue)
![Node.js](https://img.shields.io/badge/node-%E2%89%A518-green)
![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)

---

## What you get

Run `npm run benchmark` and open the browser. The UI shows:

- **Quality scores** per model across task types (instruction following, reasoning, coding, RAG, tool use)
- **Think-level breakdown** — Direct vs Low / Medium / High thinking, side by side
- **Fanout chart** — concurrent throughput (req/s) standalone vs co-resident with an orchestrator model loaded
- **Hardware profile** — auto-detected concurrency ceilings so tests are safe for your machine

Everything runs on-device. No cloud, no API keys.

---

## What this measures

| Category | What it tests |
|---|---|
| **Task quality** | Instruction following, reasoning, coding, knowledge retrieval, RAG, agentic tool use |
| **Think levels** | Direct (no thinking), Low, Medium, High — skipped if the model lacks the capability |
| **Fanout** | How many concurrent agents the host can sustain before throughput degrades |
| **Co-resident fanout** | Worker fanout while an orchestrator model is already loaded in memory |

Scores are 0–100% based on response quality evaluated against expected outputs.
Latency is measured end-to-end (prompt → last token).

---

## Requirements

- **Ollama** ≥ 0.6 — [ollama.com](https://ollama.com)
- **Node.js** ≥ 18
- **bash** (macOS, Linux, or WSL on Windows)
- At least one model pulled locally (`ollama pull <model>`)

---

## Quick start

```bash
# Install UI dependencies
npm install

# Run benchmarks + compile results
npm run benchmark

# View results in the browser
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) in your browser.

---

## Running benchmarks

```bash
npm run benchmark
```

This runs two steps in sequence:
1. `bash scripts/run-ollama-benchmarks.sh` — probes each locally-installed model
2. `node scripts/compile-results.mjs` — aggregates raw TSV output into `src/data/results.json`

Each run is saved under `benchmark-runs/YYYYMMDD-HHMMSS/` so historical runs are preserved.

### Benchmark-only (no UI recompile)

```bash
bash scripts/run-ollama-benchmarks.sh && node scripts/compile-results.mjs
```

### Recompile without re-running benchmarks

```bash
node scripts/compile-results.mjs
```

---

## Configuration

All settings are optional environment variables.

| Variable | Default | Description |
|---|---|---|
| `BENCH_TIMEOUT_MS` | `120000` | Per-probe timeout in milliseconds |
| `BENCH_MODELS` | _(all local models)_ | Comma-separated model filter, e.g. `qwen3:14b,llama3.2` |
| `BENCH_ORCHESTRATOR_MODEL` | _(last generative model)_ | Override which model is pre-warmed as the co-resident orchestrator |
| `BENCH_PROFILE` | `auto` | Hardware profile: `auto`, `apple_silicon_compact`, `cuda_single_workstation`, `cuda_multi_lab`, `cpu_only` |
| `BENCH_FANOUT_LIMIT` | `16` | Maximum concurrent agents to test during fanout calibration |
| `BENCH_FANOUT` | _(auto-calibrated)_ | Explicit comma-separated fanout steps, e.g. `1,2,4,8` |
| `BENCH_CALIBRATION_MODEL` | _(auto)_ | Override which model is used for initial fanout calibration |

Example — benchmark only the qwen3 model with a 30s timeout:

```bash
BENCH_MODELS=qwen3:14b BENCH_TIMEOUT_MS=30000 npm run benchmark
```

---

## Understanding results

### Quality scores

Each task returns a 0–100% quality score. The **orchestrator score** shown for a model is the
best available think-level score (`High > Medium > Low > Direct`).

### Think levels

Models are probed at multiple Ollama thinking depths:

| Level | Ollama flag | When run |
|---|---|---|
| Direct | `--think=false` | Always |
| Low | `--think=low` | Only if model has `thinking` capability |
| Medium | `--think=medium` | Only if model has `thinking` capability |
| High | `--think=high` | Only if model has `thinking` capability |

The UI shows `n/a` for levels that were not run (capability not present, or not yet benchmarked).

### Fanout chart

The fanout section shows two series:

- **Standalone** — concurrent throughput (req/s) with only that model in memory
- **Co-resident** — same measurement while an orchestrator model is also loaded

A meaningful gap between the two series indicates memory pressure from holding two models
simultaneously. No gap means the host has enough memory to run both without contention.

### Hardware profiles

The benchmark auto-detects the host hardware and sets safe concurrency ceilings:

| Profile | Detected when |
|---|---|
| `apple_silicon_compact` | Apple Silicon, ≤ 36 GB unified memory |
| `apple_silicon_pro` | Apple Silicon, > 36 GB unified memory |
| `cuda_single_workstation` | Single NVIDIA GPU |
| `cuda_multi_lab` | Multiple NVIDIA GPUs |
| `cpu_only` | No GPU detected |

---

## Architecture

```
scripts/run-ollama-benchmarks.sh   Shell harness — probes models, writes TSV + metadata
scripts/compile-results.mjs        Aggregates benchmark-runs/ → src/data/results.json
src/main.tsx                       React + Recharts visualization UI
```

Results flow:

```
Ollama CLI → TSV files → compile-results.mjs → results.json → Vite/React UI
```

---

## Building for static hosting

```bash
npm run build      # outputs to dist/
npm run preview    # local preview of the static build
```

The `dist/` folder is a self-contained static site — copy it anywhere.

---

## Benchmark journal

Notable benchmark runs and observations are recorded in [BENCHMARK_JOURNAL.md](BENCHMARK_JOURNAL.md).
