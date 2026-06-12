#!/usr/bin/env bash
set -uo pipefail

RUN_DIR="benchmark-runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR/outputs" src/data
rm -f benchmark-runs/latest
ln -s "$(basename "$RUN_DIR")" benchmark-runs/latest

TIMEOUT_MS="${BENCH_TIMEOUT_MS:-120000}"
MODEL_FILTER="${BENCH_MODELS:-}"
BENCH_PROFILE="${BENCH_PROFILE:-auto}"
BENCH_FANOUT="${BENCH_FANOUT:-}"
BENCH_FANOUT_LIMIT="${BENCH_FANOUT_LIMIT:-16}"
BENCH_CALIBRATION_MODEL="${BENCH_CALIBRATION_MODEL:-}"

ms_now() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
}

safe_name() {
  printf '%s' "$1" | tr '/: .' '----' | tr -cd '[:alnum:]_-'
}

detect_profile() {
  local os arch chip memory gpu_count gpu_names profile reason

  os="$(uname -s 2>/dev/null || printf unknown)"
  arch="$(uname -m 2>/dev/null || printf unknown)"
  chip=""
  memory=""
  gpu_count="0"
  gpu_names=""
  profile="unknown_local"
  reason="general local inference profile"

  if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_names="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | paste -sd '; ' -)"
    gpu_count="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l | tr -d ' ')"
  fi

  if [[ "$os" == "Darwin" ]]; then
    chip="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    memory="$(sysctl -n hw.memsize 2>/dev/null || true)"
    gpu_names="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model|Model/ {print $2}' | paste -sd '; ' -)"
    profile="apple_silicon_compact"
    reason="Apple Silicon detected; using compact Apple Silicon local-agent probes"
  elif [[ "$gpu_count" -ge 2 ]]; then
    profile="cuda_multi_lab"
    reason="multiple CUDA GPUs detected; using multi-GPU workstation/lab orchestration probes"
  elif [[ "$gpu_count" -eq 1 ]]; then
    profile="cuda_single_workstation"
    reason="single CUDA GPU detected; using single-GPU workstation agent probes"
  else
    chip="$(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null || true)"
    memory="$(awk '/MemTotal/ {print $2 * 1024; exit}' /proc/meminfo 2>/dev/null || true)"
    profile="cpu_only"
    reason="CPU-only local inference detected; using sanity probes"
  fi

  if [[ "$BENCH_PROFILE" != "auto" ]]; then
    profile="$BENCH_PROFILE"
    reason="BENCH_PROFILE override"
  fi

  case "$profile" in
    lite) profile="apple_silicon_compact" ;;
    standard) profile="cuda_single_workstation" ;;
    workstation) profile="cuda_multi_lab" ;;
  esac

  DETECTED_PROFILE="$profile"
  DETECTED_OS="$os"
  DETECTED_ARCH="$arch"
  DETECTED_CHIP="$chip"
  DETECTED_MEMORY_BYTES="$memory"
  DETECTED_GPU_COUNT="$gpu_count"
  DETECTED_GPU_NAMES="$gpu_names"
  DETECTED_REASON="$reason"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_profile_json() {
  cat >"$RUN_DIR/benchmark-profile.json" <<JSON
{
  "requested": "$(json_escape "$BENCH_PROFILE")",
  "selected": "$(json_escape "$DETECTED_PROFILE")",
  "reason": "$(json_escape "$DETECTED_REASON")",
  "os": "$(json_escape "$DETECTED_OS")",
  "arch": "$(json_escape "$DETECTED_ARCH")",
  "chip": "$(json_escape "$DETECTED_CHIP")",
  "memoryBytes": ${DETECTED_MEMORY_BYTES:-0},
  "gpuCount": ${DETECTED_GPU_COUNT:-0},
  "gpuNames": "$(json_escape "$DETECTED_GPU_NAMES")",
  "fanoutCalibrationModel": "$(json_escape "${FANOUT_CALIBRATION_MODEL:-}")",
  "fanoutCeiling": ${FANOUT_CEILING:-0},
  "timeoutMs": ${TIMEOUT_MS}
}
JSON
}

write_tasks() {
  cat >"$RUN_DIR/tasks.tsv" <<'TASKS'
instruction	direct	Instruction Following	IFEval-style constraint adherence	Structured worker, router, API-facing agent	Return exactly the text READY-2 and nothing else.
reasoning	direct	Quantitative Reasoning	GSM8K-style arithmetic word problem	Planner, verifier, lightweight analyst	Compute: Monday 6. Tuesday twice Monday. Wednesday is 5 fewer than Tuesday. Remove 4 rework items. Answer only FINAL: number.
coding	direct	Code Generation	HumanEval/MBPP-style small function synthesis	Code sub-agent, patch drafter, test helper	Only code. TypeScript function dedupeSorted(nums:number[]):number[] returns unique numbers sorted ascending.
knowledge	direct	Applied Knowledge	MMLU-style technical concept check	General assistant, explainer, domain triage	In one sentence, why does TLS use asymmetric setup and symmetric bulk encryption? End: FINAL: asymmetric setup, symmetric bulk.
rag	direct	Grounded Summarization	RAGAS-style faithfulness and concise answer	RAG worker, extraction agent, report compressor	Facts: Atlas deadline May 30. Backend API complete. Mobile blocked by OAuth review. Budget risk low. Return one line: deadline=; completed=; blocker=; risk=.
agentic-direct	direct	Agentic Planning	Tool-use/orchestration planning proxy, direct mode	Fast orchestrator, router, shallow task manager	Create a compact agent plan to compare 3 local LLMs, inspect failures, and produce a dashboard. Return JSON only with orchestrator, sub_agents array, handoff_policy.
agentic-medium	medium	Deliberate Orchestration	AgentBench/WebArena-style task decomposition proxy with thinking enabled	Unattended orchestrator, batch planner, complex handoff controller	Deliberate mode. Plan an unattended local-LLM benchmark job. Return JSON only with orchestrator, sub_agents array, handoff_policy, failure_recovery, stop_conditions. Be concise.
critic-medium	medium	Critic and Repair	Reflexion/SWE-agent-style critique and repair proxy with thinking enabled	Verifier, reviewer, escalation gate	Critique this: {"winner":"fastest","reason":"lowest latency"}. User asked best orchestrator, not fastest worker. Return JSON only: errors array, repair_plan array.
a2a-medium	medium	A2A Topology Design	Multi-agent collaboration topology proxy with thinking enabled	Node-based multi-agent designer	Design node-based A2A for local models: orchestrator, two workers, critic, summarizer. Return JSON only with nodes, edges, when_to_use.
TASKS

  if [[ "$DETECTED_PROFILE" == "cuda_single_workstation" || "$DETECTED_PROFILE" == "cuda_multi_lab" ]]; then
    cat >>"$RUN_DIR/tasks.tsv" <<'TASKS'
long-context-rag	direct	Long-context Grounding	HotpotQA/NarrativeQA-style multi-fact retrieval proxy	RAG worker, synthesis agent, evidence tracker	Context: Apollo owns billing API and needs OAuth review by June 4. Borealis owns iOS and has UI tests passing. Cygnus owns Android and is blocked by billing sandbox data. Delta owns release notes and is complete. Risk register says billing sandbox is medium risk, OAuth review is high risk, budget is low risk. Return JSON only with release_blockers array, completed_tracks array, highest_risk.
multi-step-reasoning	direct	Multi-step Reasoning	BBH/GSM8K-style compositional reasoning proxy	Planner, verifier, capacity estimator	A batch job has 4 stages. Stage A creates 18 files. Stage B removes one third and adds 7. Stage C duplicates the remaining files for two regions. Stage D archives 5 per region. Answer only FINAL: total active files.
code-repair	direct	Code Repair	SWE-bench-style localized patch reasoning proxy	Code reviewer, repair agent, test helper	Given buggy TypeScript: function pct(done,total){return done/total*100}. Requirement: return 0 when total is 0 and round to one decimal. Return only the corrected function.
TASKS
  fi

  if [[ "$DETECTED_PROFILE" == "cuda_multi_lab" ]]; then
    cat >>"$RUN_DIR/tasks.tsv" <<'TASKS'
tool-routing-medium	medium	Tool Routing	ToolBench/AgentBench-style tool selection proxy	Orchestrator, tool router, escalation planner	Plan tool use for: inspect failed CI, identify flaky tests, patch code, rerun only failed jobs, and summarize risk. Return JSON only with tools array, sequence array, escalation_rules array.
stress-synthesis	medium	Structured Synthesis	MT-Bench/arena-style instruction synthesis proxy	Batch summarizer, report writer, final answer agent	Synthesize an executive summary from: qwen3 has best orchestrator score; qwen2.5-coder is faster but weaker medium planner; archived models remain useful history; CUDA hosts should run heavier fanout. Return JSON only with headline, findings array, caveats array.
TASKS
  fi
}

fanout_candidate_limit() {
  if [[ -n "$BENCH_FANOUT" ]]; then
    printf '%s\n' "$BENCH_FANOUT" | tr ',' '\n' | awk 'max < $1 {max = $1} END {print max + 0}'
  else
    printf '%s\n' "$BENCH_FANOUT_LIMIT"
  fi
}

fanout_candidates() {
  local ceiling level
  if [[ -n "$BENCH_FANOUT" ]]; then
    printf '%s\n' "$BENCH_FANOUT" | tr ',' '\n'
    return
  fi

  ceiling="${FANOUT_CEILING:-$(fanout_candidate_limit)}"
  level=1
  while [[ "$level" -le "$ceiling" ]]; do
    printf '%s\n' "$level"
    if [[ "$level" -eq 1 ]]; then
      level=2
    else
      level=$((level * 2))
    fi
  done

  if [[ "$((level / 2))" -ne "$ceiling" ]]; then
    printf '%s\n' "$ceiling"
  fi
}

run_ollama() {
  local model="$1"
  local task_id="$2"
  local mode="$3"
  local prompt="$4"
  local safe_model output_file think_arg start_ms end_ms status

  safe_model="$(safe_name "$model")"
  output_file="$RUN_DIR/outputs/${safe_model}__${task_id}__${mode}.txt"
  think_arg="--think=false"
  if [[ "$mode" == "medium" ]]; then
    think_arg="--think=medium"
  fi

  printf 'Running %s / %s / %s... ' "$model" "$task_id" "$mode"
  start_ms="$(ms_now)"
  (
    ollama run --verbose --nowordwrap --hidethinking "$think_arg" --keepalive 2m "$model" "$prompt" >"$output_file" 2>&1 </dev/null
  ) &
  local pid=$!
  status=0
  while kill -0 "$pid" 2>/dev/null; do
    end_ms="$(ms_now)"
    if [[ "$((end_ms - start_ms))" -ge "$TIMEOUT_MS" ]]; then
      printf '\nTIMEOUT after %sms\n' "$TIMEOUT_MS" >>"$output_file"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      ollama stop "$model" >/dev/null 2>&1 || true
      status=124
      break
    fi
    sleep 1
  done
  if [[ "$status" == "0" ]]; then
    wait "$pid"
    status=$?
  else
    wait "$pid" >/dev/null 2>&1 || true
  fi
  end_ms="$(ms_now)"
  printf '%sms\n' "$((end_ms - start_ms))"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$model" "$task_id" "$mode" "$status" "$((end_ms - start_ms))" "$output_file" >>"$RUN_DIR/results.tsv"
}

run_concurrency() {
  local model="$1"
  local agents="$2"
  local output_file="${3:-$RUN_DIR/concurrency.tsv}"
  local safe_model output_dir start_ms end_ms successes idx pids pid status alive

  safe_model="$(safe_name "$model")"
  output_dir="$RUN_DIR/outputs/${safe_model}__concurrency_${agents}"
  mkdir -p "$output_dir"
  printf 'Running %s / concurrency x%s... ' "$model" "$agents"
  start_ms="$(ms_now)"
  pids=()
  for idx in $(seq 1 "$agents"); do
    (
      ollama run --verbose --nowordwrap --hidethinking --think=false --keepalive 2m "$model" "Return exactly OK." >"$output_dir/agent_${idx}.txt" 2>&1 </dev/null
    ) &
    pids+=("$!")
  done

  status=0
  while true; do
    alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=$((alive + 1))
      fi
    done
    [[ "$alive" -eq 0 ]] && break

    end_ms="$(ms_now)"
    if [[ "$((end_ms - start_ms))" -ge "$TIMEOUT_MS" ]]; then
      for pid in "${pids[@]}"; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 1
      for pid in "${pids[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
      done
      ollama stop "$model" >/dev/null 2>&1 || true
      status=124
      break
    fi
    sleep 1
  done

  successes=0
  for pid in "${pids[@]}"; do
    if wait "$pid"; then
      successes=$((successes + 1))
    fi
  done
  end_ms="$(ms_now)"
  if [[ "$status" == "0" && "$successes" != "$agents" ]]; then
    status=1
  fi
  printf '%s/%s ok, %sms\n' "$successes" "$agents" "$((end_ms - start_ms))"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$model" "$agents" "$successes" "$status" "$((end_ms - start_ms))" "$output_dir" >>"$output_file"
  return "$status"
}

run_fanout_benchmark() {
  local model="$1"
  local agents status
  while IFS= read -r agents; do
    [[ -z "$agents" || "$agents" -lt 1 ]] && continue
    run_concurrency "$model" "$agents"
    status=$?
    if [[ "$status" != "0" ]]; then
      break
    fi
  done < <(fanout_candidates)
}

prewarm_model() {
  local model="$1"
  printf 'Pre-warming orchestrator %s for co-resident probe... ' "$model"
  ollama run --keepalive 5m --nowordwrap --think=false "$model" "Return OK." >/dev/null 2>&1
  printf 'warm\n'
}

run_coresident_fanout() {
  local orch_model worker_model agents status
  local generative_models=()

  for model in "${MODELS[@]}"; do
    if is_generative_model "$model"; then
      generative_models+=("$model")
    fi
  done

  [[ "${#generative_models[@]}" -lt 1 ]] && return

  # Default to last generative model (tends to be most capable/recently added).
  # Override with BENCH_ORCHESTRATOR_MODEL if needed.
  local last_idx=$(( ${#generative_models[@]} - 1 ))
  orch_model="${BENCH_ORCHESTRATOR_MODEL:-${generative_models[$last_idx]}}"

  printf '\n=== Co-resident fanout probe (orchestrator in memory: %s) ===\n' "$orch_model"
  prewarm_model "$orch_model"

  printf '%s\n' "$orch_model" >"$RUN_DIR/coresident-orch.txt"
  : >"$RUN_DIR/coresident-fanout.tsv"

  for worker_model in "${generative_models[@]}"; do
    printf 'Co-resident worker: %s\n' "$worker_model"
    while IFS= read -r agents; do
      [[ -z "$agents" || "$agents" -lt 1 ]] && continue
      run_concurrency "$worker_model" "$agents" "$RUN_DIR/coresident-fanout.tsv"
      status=$?
      [[ "$status" != "0" ]] && break
    done < <(fanout_candidates)
  done

  ollama stop "$orch_model" >/dev/null 2>&1 || true
}

choose_calibration_model() {
  local model
  if [[ -n "$BENCH_CALIBRATION_MODEL" ]]; then
    printf '%s\n' "$BENCH_CALIBRATION_MODEL"
    return
  fi

  for model in "${MODELS[@]}"; do
    if is_generative_model "$model"; then
      printf '%s\n' "$model"
      return
    fi
  done
}

calibrate_fanout_ceiling() {
  local model="$1"
  local limit level status measured

  if [[ -n "$BENCH_FANOUT" ]]; then
    FANOUT_CEILING="$(fanout_candidate_limit)"
    FANOUT_CALIBRATION_MODEL="manual BENCH_FANOUT"
    printf 'Fanout candidates supplied manually; ceiling %s\n' "$FANOUT_CEILING"
    return
  fi

  if [[ -z "$model" ]]; then
    FANOUT_CEILING=1
    FANOUT_CALIBRATION_MODEL=""
    printf 'No generative calibration model found; fanout ceiling set to 1\n'
    return
  fi

  FANOUT_CALIBRATION_MODEL="$model"
  limit="$(fanout_candidate_limit)"
  measured=1
  level=1
  printf 'Calibrating host fanout with %s up to %s... \n' "$model" "$limit"
  : >"$RUN_DIR/fanout-calibration.tsv"

  while [[ "$level" -le "$limit" ]]; do
    run_concurrency "$model" "$level" "$RUN_DIR/fanout-calibration.tsv"
    status=$?
    if [[ "$status" != "0" ]]; then
      break
    fi
    measured="$level"
    if [[ "$level" -eq 1 ]]; then
      level=2
    else
      level=$((level * 2))
    fi
  done

  FANOUT_CEILING="$measured"
  printf 'Measured host fanout ceiling: %s agents\n' "$FANOUT_CEILING"
}

is_generative_model() {
  local model="$1"
  local show_file="$RUN_DIR/ollama-show/$(safe_name "$model").txt"
  if awk '
    /^  Capabilities/ {section=1; next}
    /^  [A-Z]/ {section=0}
    section && /completion/ {found=1}
    END {exit found ? 0 : 1}
  ' "$show_file" 2>/dev/null; then
    return 0
  fi
  return 1
}

is_thinking_model() {
  local model="$1"
  local show_file="$RUN_DIR/ollama-show/$(safe_name "$model").txt"
  if awk '
    /^  Capabilities/ {section=1; next}
    /^  [A-Z]/ {section=0}
    section && /thinking/ {found=1}
    END {exit found ? 0 : 1}
  ' "$show_file" 2>/dev/null; then
    return 0
  fi
  return 1
}

detect_profile

ollama list >"$RUN_DIR/ollama-list.txt"
ollama ps >"$RUN_DIR/ollama-ps-start.txt"
system_profiler SPHardwareDataType SPDisplaysDataType >"$RUN_DIR/system-profiler.txt" 2>/dev/null || true
: >"$RUN_DIR/results.tsv"
: >"$RUN_DIR/concurrency.tsv"

if [[ -n "$MODEL_FILTER" ]]; then
  IFS=',' read -r -a MODELS <<<"$MODEL_FILTER"
else
  MODELS=()
  while IFS= read -r model_name; do
    MODELS+=("$model_name")
  done < <(awk 'NR > 1 {print $1}' "$RUN_DIR/ollama-list.txt")
fi

mkdir -p "$RUN_DIR/ollama-show"
for model in "${MODELS[@]}"; do
  ollama show "$model" >"$RUN_DIR/ollama-show/$(safe_name "$model").txt" 2>&1 || true
done

calibrate_fanout_ceiling "$(choose_calibration_model)"
write_profile_json
write_tasks

for model in "${MODELS[@]}"; do
  if ! is_generative_model "$model"; then
    printf 'Skipping %s / non-generative specialty model\n' "$model"
    continue
  fi

  thinking=false
  is_thinking_model "$model" && thinking=true

  while IFS=$'\t' read -r task_id mode name standard role prompt; do
    if [[ "$mode" == "medium" && "$thinking" == "false" ]]; then
      printf 'Skipping %s / %s / medium (no thinking capability)\n' "$model" "$task_id"
      continue
    fi
    run_ollama "$model" "$task_id" "$mode" "$prompt"
    ollama ps >"$RUN_DIR/ollama-ps-after-$(safe_name "$model")-${task_id}.txt" || true
  done <"$RUN_DIR/tasks.tsv"

  run_fanout_benchmark "$model"
done

run_coresident_fanout

ollama ps >"$RUN_DIR/ollama-ps-end.txt"
printf '%s\n' "$RUN_DIR" > benchmark-runs/latest-path.txt
printf 'Raw benchmark output written to %s\n' "$RUN_DIR"

if command -v node >/dev/null 2>&1; then
  printf 'Compiling results...\n'
  node "$(dirname "$0")/compile-results.mjs"
fi
