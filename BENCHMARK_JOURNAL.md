# Benchmark Journal

## 2026-05-22

### What went wrong

- I misread early `ollama run` timeouts as evidence that some installed models were impractical on this Mac mini.
- The later direct test showed that was incorrect: `397106818/qwen3.5:latest` returned the simple probe quickly and `ollama ps` reported `100% GPU`.
- I created temporary `local-bench-*` Ollama aliases to bound generation. That was not acceptable for this machine because the user has tight disk constraints and asked for current installed models, not derived model entries.
- I added skip-after-timeout behavior, which effectively excluded models after one bad probe. That hid data instead of measuring it.

### Cleanup performed

- Removed all `local-bench-*` aliases from Ollama.
- Verified `ollama list` only shows the original installed models.
- Verified `/Users/scottkollarik/.ollama/models` reports `37G` after cleanup.
- Removed temporary Modelfiles and the `.bench-modelfiles` directory.
- Removed all `ollama create` / alias creation logic from the benchmark runner.

### Corrected benchmark rules

- Do not pull, create, copy, quantize, delete, or mutate Ollama models during benchmarking.
- Include every model returned by `ollama list` unless the user explicitly scopes `BENCH_MODELS`.
- Do not exclude a model after a timeout. Record the timeout for that probe and continue to the next probe.
- Use direct mode with `--think=false` for worker and interactive-agent suitability.
- Use deliberate mode with `--think=true` for orchestrator, critic, batch, and unattended-agent suitability.
- Add a bounded fanout probe for `# agents` suitability using 1, 2, and 3 parallel same-model calls.
- Treat `ollama ps` as the local source of truth for processor placement during diagnostics.

### Open technical notes

- `ollama run` from Node must be kept simple and sequential for quality probes. Parallelism should only be used inside the explicit fanout probe.
- If a prompt stalls, diagnose the invocation path before concluding the model is too slow.
- The final report should clearly distinguish model capability, latency, deliberate reasoning value, and safe concurrent sub-agent fanout.

### Sandbox finding

- Direct shell `ollama run ...` works and shows GPU use through `ollama ps`.
- Node `execFile("ollama", ...)` from this Codex environment can hang or fail because the spawned process does not behave like the known-good Terminal path.
- The benchmark runner has been split accordingly:
  - `scripts/run-ollama-benchmarks.sh` executes all Ollama calls directly from the shell and writes raw output files.
  - `scripts/compile-results.mjs` parses raw files and generates `src/data/benchmark-results.json`.
- This preserves the React/TypeScript report pipeline without using Node for local model inference.

### Completed rerun

- Replaced `npm run benchmark` with a shell-first benchmark pipeline:
  - `scripts/run-ollama-benchmarks.sh`
  - `scripts/compile-results.mjs`
- Fixed macOS Bash compatibility by avoiding `mapfile`.
- Fixed task-loop stdin handling by redirecting each `ollama run` from `/dev/null`.
- Added per-probe timeout handling for long deliberate-mode calls.
- Completed a clean run across all 10 installed models:
  - 90 quality probe rows
  - 30 same-model fanout rows
- Generated `src/data/benchmark-results.json`.
- Verified the React/Vite build succeeds.
