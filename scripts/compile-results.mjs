import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus, hostname, totalmem, freemem, homedir } from "node:os";

const execFileAsync = promisify(execFile);
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 120000);

const stripAnsi = (value) =>
  value
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/g, "")
    .replace(/\r/g, "");

function parseJsonObject(output) {
  const cleaned = stripAnsi(output).trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function average(values) {
  return values.reduce((sum, v) => sum + (v ? 1 : 0), 0) / values.length;
}

const scorers = {
  instruction: (output) => (stripAnsi(output).trim() === "READY-2" ? 1 : 0),
  reasoning: (output) => (/final\s*:\s*21\b/i.test(output) || /\b21\b/.test(output) ? 1 : 0),
  coding: (output) => {
    const lower = output.toLowerCase();
    return average([
      /function\s+dedupesorted|const\s+dedupesorted|=>/.test(lower),
      /number\[\]/.test(output),
      /new\s+set|set</i.test(output),
      /\.sort\(/.test(output),
      /a\s*-\s*b|x\s*-\s*y|left\s*-\s*right/.test(output)
    ]);
  },
  knowledge: (output) => {
    const lower = output.toLowerCase();
    return average([
      lower.includes("asymmetric"),
      lower.includes("symmetric"),
      lower.includes("setup") || lower.includes("handshake") || lower.includes("key exchange"),
      lower.includes("bulk") || lower.includes("data transfer") || lower.includes("session"),
      /final\s*:/i.test(output)
    ]);
  },
  rag: (output) => {
    const lower = output.toLowerCase();
    return average([
      lower.includes("may 30"),
      lower.includes("backend") && lower.includes("complete"),
      lower.includes("oauth") && lower.includes("review"),
      lower.includes("low"),
      lower.includes("deadline") || lower.includes("completed") || lower.includes("blocker") || lower.includes("risk")
    ]);
  },
  "long-context-rag": (output) => {
    const lower = output.toLowerCase();
    const parsed = parseJsonObject(output);
    return average([
      parsed && Array.isArray(parsed.release_blockers),
      parsed && Array.isArray(parsed.completed_tracks),
      lower.includes("oauth") && lower.includes("review"),
      lower.includes("billing") && lower.includes("sandbox"),
      lower.includes("high")
    ]);
  },
  "multi-step-reasoning": (output) => (/final\s*:\s*25\b/i.test(output) || /\b25\b/.test(output) ? 1 : 0),
  "code-repair": (output) => {
    const lower = output.toLowerCase();
    return average([
      /function\s+pct|const\s+pct|=>/.test(lower),
      lower.includes("total") && lower.includes("0"),
      lower.includes("return 0") || /\?\s*0\s*:/.test(output),
      lower.includes("math.round") || lower.includes("tofixed"),
      lower.includes("10") || lower.includes("1")
    ]);
  },
  "agentic-direct": scoreAgentPlan,
  "agentic-medium": (output) => {
    const lower = output.toLowerCase();
    const parsed = parseJsonObject(output);
    return average([
      scoreAgentPlan(output) >= 0.8,
      lower.includes("failure") || lower.includes("retry") || lower.includes("recover"),
      lower.includes("stop") || lower.includes("done") || lower.includes("completion"),
      parsed && Array.isArray(parsed.sub_agents),
      parsed && typeof parsed.handoff_policy !== "undefined"
    ]);
  },
  "critic-medium": (output) => {
    const lower = output.toLowerCase();
    const parsed = parseJsonObject(output);
    return average([
      parsed && Array.isArray(parsed.errors),
      parsed && Array.isArray(parsed.repair_plan),
      lower.includes("orchestrator"),
      lower.includes("fastest") || lower.includes("latency"),
      lower.includes("quality") || lower.includes("reasoning") || lower.includes("planning")
    ]);
  },
  "a2a-medium": (output) => {
    const lower = output.toLowerCase();
    const parsed = parseJsonObject(output);
    return average([
      parsed && Array.isArray(parsed.nodes),
      parsed && Array.isArray(parsed.edges),
      lower.includes("orchestrator"),
      lower.includes("critic"),
      lower.includes("summarizer") || lower.includes("summary")
    ]);
  },
  "tool-routing-medium": (output) => {
    const lower = output.toLowerCase();
    const parsed = parseJsonObject(output);
    return average([
      parsed && Array.isArray(parsed.tools),
      parsed && Array.isArray(parsed.sequence),
      parsed && Array.isArray(parsed.escalation_rules),
      lower.includes("ci") || lower.includes("check"),
      lower.includes("rerun") || lower.includes("failed")
    ]);
  },
  "stress-synthesis": (output) => {
    const lower = output.toLowerCase();
    const parsed = parseJsonObject(output);
    return average([
      parsed && typeof parsed.headline !== "undefined",
      parsed && Array.isArray(parsed.findings),
      parsed && Array.isArray(parsed.caveats),
      lower.includes("qwen3"),
      lower.includes("cuda") || lower.includes("fanout")
    ]);
  }
};

function scoreAgentPlan(output) {
  const lower = output.toLowerCase();
  const parsed = parseJsonObject(output);
  return average([
    lower.includes("orchestrator"),
    lower.includes("sub_agents") || lower.includes("sub-agents") || lower.includes("agents"),
    lower.includes("handoff"),
    lower.includes("benchmark") || lower.includes("compare"),
    parsed && Array.isArray(parsed.sub_agents)
  ]);
}

function parseVerbose(output) {
  const get = (label) => {
    const match = output.match(new RegExp(`^${label}:\\s+([0-9.]+)`, "im"));
    return match ? Number(match[1]) : null;
  };
  return {
    promptEvalCount: get("prompt eval count"),
    evalCount: get("eval count"),
    promptEvalRate: get("prompt eval rate"),
    evalRate: get("eval rate")
  };
}

function answerOnly(output) {
  return stripAnsi(output).split(/\n\s*total duration:/i)[0].trim();
}

function mean(values) {
  const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return valid.length ? valid.reduce((sum, v) => sum + v, 0) / valid.length : 0;
}

function weighted(items) {
  return items.reduce((sum, [value, weight]) => sum + value * weight, 0);
}

function round(value) {
  return Number(value.toFixed(4));
}

function speedScore(ms) {
  if (!ms) return 0;
  return Math.max(0, Math.min(1, 1 - ms / timeoutMs));
}

function safeName(value) {
  return value.replace(/[/: .]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
}

function normalizeProfileId(value) {
  if (value === "lite") return "apple_silicon_compact";
  if (value === "standard") return "cuda_single_workstation";
  if (value === "workstation") return "cuda_multi_lab";
  return value || "unknown_local";
}

function runIdToDate(runId) {
  const match = runId.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return new Date().toISOString().slice(0, 19);
  const [, yr, mo, dy, hr, mn, sc] = match;
  return `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}`;
}

async function readModelMetadata(runDir, model) {
  const raw = await readFile(join(runDir, "ollama-show", `${safeName(model)}.txt`), "utf8").catch(() => "");
  const lines = stripAnsi(raw).split("\n");
  const metadata = {
    architecture: "", parameters: "", contextLength: "", embeddingLength: "",
    quantization: "", capabilities: [], parametersRaw: [], license: "", raw
  };
  let section = "";
  const licenseLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (["Model", "Capabilities", "Parameters", "License"].includes(trimmed)) { section = trimmed; continue; }
    if (section === "Model") {
      const match = trimmed.match(/^(.+?)\s{2,}(.+)$/);
      if (!match) continue;
      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();
      if (key === "architecture") metadata.architecture = value;
      if (key === "parameters") metadata.parameters = value;
      if (key === "context length") metadata.contextLength = value;
      if (key === "embedding length") metadata.embeddingLength = value;
      if (key === "quantization") metadata.quantization = value;
    } else if (section === "Capabilities") {
      metadata.capabilities.push(trimmed);
    } else if (section === "Parameters") {
      metadata.parametersRaw.push(trimmed);
    } else if (section === "License") {
      licenseLines.push(trimmed);
    }
  }
  metadata.license = licenseLines.slice(0, 3).join(" ");
  return metadata;
}

async function readSystemStats() {
  const ollamaDir = join(homedir(), ".ollama", "models");

  const dfOut = await execFileAsync("df", ["-k", ollamaDir])
    .then(({ stdout }) => stdout)
    .catch(() => "");
  const dfParts = (dfOut.trim().split("\n")[1] ?? "").trim().split(/\s+/);
  const diskTotal = Number(dfParts[1] ?? 0) * 1024;
  const diskUsed  = Number(dfParts[2] ?? 0) * 1024;
  const diskFree  = Number(dfParts[3] ?? 0) * 1024;

  const duOut = await execFileAsync("du", ["-sk", ollamaDir])
    .then(({ stdout }) => stdout)
    .catch(() => "0");
  const ollamaModelsBytes = Number(duOut.trim().split(/\s+/)[0] ?? 0) * 1024;

  return {
    disk: { total: diskTotal, used: diskUsed, free: diskFree },
    memory: { total: totalmem(), free: freemem() },
    ollamaModelsBytes
  };
}

async function readMachineInfo(runDir) {
  const text = await readFile(join(runDir, "system-profiler.txt"), "utf8").catch(() => "");
  const get = (label) => text.match(new RegExp(`${label}:\\s+(.+)`, "i"))?.[1]?.trim() ?? "";
  return {
    name: get("Model Name") || hostname(),
    chip: get("Chip") || cpus()[0]?.model?.replace(/\s+@\s+[\d.]+GHz$/i, "").trim() || "",
    memory: get("Memory") || `${Math.round(totalmem() / 1024 ** 3)} GB`
  };
}

async function inferProfileFromRun(runDir) {
  const text = await readFile(join(runDir, "system-profiler.txt"), "utf8").catch(() => "");
  const lower = text.toLowerCase();
  const chip = text.match(/Chip:\s+(.+)/i)?.[1]?.trim() ?? "";
  const memory = text.match(/Memory:\s+(.+)/i)?.[1]?.trim() ?? "";
  const gpuNames = Array.from(text.matchAll(/Chipset Model:\s+(.+)/gi)).map((match) => match[1].trim()).join("; ");

  if (lower.includes("apple") && (lower.includes("metal") || lower.includes("apple m"))) {
    return {
      requested: "inferred",
      selected: "apple_silicon_compact",
      reason: "inferred from archived system-profiler Apple Silicon/Metal data",
      os: "Darwin",
      arch: "",
      chip,
      memory,
      memoryBytes: 0,
      gpuCount: 0,
      gpuNames,
      fanoutCeiling: 4,
      timeoutMs
    };
  }

  return {
    requested: "unknown",
    selected: "unknown_local",
    reason: "run predates benchmark profile detection and hardware profile could not be inferred",
    os: "",
    arch: "",
    chip,
    memory,
    memoryBytes: 0,
    gpuCount: 0,
    gpuNames,
    fanoutCeiling: 4,
    timeoutMs
  };
}

async function readBenchmarkProfile(runDir) {
  const raw = await readFile(join(runDir, "benchmark-profile.json"), "utf8").catch(() => "");
  if (!raw.trim()) {
    return inferProfileFromRun(runDir);
  }
  try {
    const parsed = JSON.parse(raw);
    return { ...parsed, selected: normalizeProfileId(parsed.selected) };
  } catch {
    return {
      requested: "unknown",
      selected: "unknown",
      reason: "benchmark profile metadata could not be parsed",
      os: "",
      arch: "",
      chip: "",
      memoryBytes: 0,
      gpuCount: 0,
      gpuNames: "",
      fanoutCeiling: 4,
      timeoutMs
    };
  }
}

async function findRunDirs() {
  const entries = await readdir("benchmark-runs", { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
    .map((e) => join("benchmark-runs", e.name))
    .sort();
  const withResults = [];
  for (const dir of dirs) {
    const content = await readFile(join(dir, "results.tsv"), "utf8").catch(() => "");
    if (content.trim()) withResults.push(dir);
  }
  return withResults;
}

function parseOllamaList(text) {
  return new Set(
    text.trim().split("\n").slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)
  );
}

function modelSpecialty(model, metadata = {}) {
  const capabilities = metadata.capabilities ?? [];
  const lowerName = model.toLowerCase();
  const lowerCaps = capabilities.join(" ").toLowerCase();
  const hasCompletion = lowerCaps.includes("completion") || lowerCaps.includes("tools") || lowerCaps.includes("thinking");
  if (
    lowerCaps.includes("vision") ||
    lowerName.includes("vision") ||
    lowerName.includes("llava") ||
    lowerName.includes("bakllava") ||
    lowerName.includes("moondream")
  ) {
    return {
      category: hasCompletion ? "vision-language" : "vision",
      role: "Image reasoning and visual QA model",
      testFamily: "MMMU, MathVista, VQAv2, DocVQA, OCRBench, and chart/table understanding",
      recommendation: hasCompletion
        ? "Run normal chat probes for text behavior, then add image-grounded tests for OCR, chart reading, screenshots, and visual question answering."
        : "Use image-grounded probes instead of text-only chat scores; confirm the local runner can pass image fixtures to the model."
    };
  }
  if (
    lowerName.includes("ocr") ||
    lowerName.includes("document") ||
    lowerName.includes("docling") ||
    lowerName.includes("layout")
  ) {
    return {
      category: "document-ocr",
      role: "Document extraction and layout reader",
      testFamily: "OCRBench, DocVQA, ChartQA, PubTabNet, FUNSD, and layout-aware extraction",
      recommendation: "Evaluate with scanned pages, screenshots, tables, forms, and noisy documents. Score exact extraction, layout preservation, and grounded citations."
    };
  }
  if (
    lowerCaps.includes("audio") ||
    lowerName.includes("whisper") ||
    lowerName.includes("audio") ||
    lowerName.includes("speech")
  ) {
    return {
      category: "audio",
      role: "Speech or audio model",
      testFamily: "LibriSpeech, Common Voice, FLEURS, audio QA, transcription WER, and diarization probes",
      recommendation: "Evaluate with local audio fixtures and word-error rate or task-specific extraction; do not compare directly to text-only chat scores."
    };
  }
  if (lowerCaps.includes("embedding") || lowerName.includes("embed")) {
    return {
      category: "embedding",
      role: "Retrieval indexer",
      testFamily: "MTEB-style embedding retrieval, clustering, reranking, and semantic similarity",
      recommendation: "Use for vector search, semantic recall, deduplication, and RAG indexing. Do not score it with chat, coding, or planning probes."
    };
  }
  if (lowerCaps.includes("rerank") || lowerName.includes("rerank") || lowerName.includes("bge-reranker")) {
    return {
      category: "reranker",
      role: "Retrieval reranking model",
      testFamily: "MTEB reranking, BEIR/NDCG, recall@k, and passage ranking",
      recommendation: "Use after embedding recall to reorder candidate chunks. Score retrieval precision rather than chat quality."
    };
  }
  if (hasCompletion) {
    return {
      category: lowerCaps.includes("tools") ? "tool-capable generative" : "generative",
      role: lowerCaps.includes("tools") ? "Tool-using chat/completion model" : "Chat/completion model",
      testFamily: "Instruction, reasoning, coding, RAG, and agentic planning probes",
      recommendation: "Use the dashboard scores to place it as an orchestrator, worker, critic, or summarizer."
    };
  }
  return {
    category: "unknown",
    role: "Unclassified local model",
    testFamily: "Capability-specific tests are selected from Ollama metadata when available",
    recommendation: "Inspect `ollama show` capabilities before assigning this model to a benchmark family."
  };
}

async function getInstalledModels(fallbackRunDir = "") {
  try {
    const { stdout } = await execFileAsync("ollama", ["list"]);
    return parseOllamaList(stdout);
  } catch {
    const fallback = fallbackRunDir
      ? await readFile(join(fallbackRunDir, "ollama-list.txt"), "utf8").catch(() => "")
      : "";
    return parseOllamaList(fallback);
  }
}

async function parseRunDir(runDir) {
  const runId = basename(runDir);
  const generatedAt = runIdToDate(runId);
  const profile = await readBenchmarkProfile(runDir);

  const taskContent = await readFile(join(runDir, "tasks.tsv"), "utf8").catch(() => "");
  const taskRows = taskContent.trim().split("\n").filter(Boolean).map((line) => {
    const [id, mode, name, standard, roleSignal, prompt] = line.split("\t");
    return { id, mode, name, standard, roleSignal, prompt };
  });
  const taskById = new Map(taskRows.map((t) => [t.id, t]));

  const modelSizes = new Map(
    (await readFile(join(runDir, "ollama-list.txt"), "utf8").catch(() => ""))
      .trim().split("\n").slice(1)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return [parts[0], `${parts[2] ?? ""} ${parts[3] ?? ""}`.trim()];
      })
      .filter(([name]) => name)
  );

  const modelMetadata = {};
  for (const model of modelSizes.keys()) {
    modelMetadata[model] = await readModelMetadata(runDir, model);
  }

  const resultLines = (await readFile(join(runDir, "results.tsv"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean);

  const results = [];
  for (const line of resultLines) {
    const [model, rawTaskId, rawMode, statusText, durationText, outputFile] = line.split("\t");
    const mode = rawMode === "deliberate" ? "medium" : rawMode;
    const taskId = rawTaskId
      .replace("agentic-deliberate", "agentic-medium")
      .replace("critic-deliberate", "critic-medium")
      .replace("a2a-deliberate", "a2a-medium")
      .replace("tool-routing-deliberate", "tool-routing-medium");
    const task = taskById.get(taskId);
    const raw = await readFile(outputFile, "utf8").catch(() => "");
    const answer = answerOnly(raw);
    const verbose = parseVerbose(raw);
    const ok = statusText === "0";
    results.push({
      runId,
      generatedAt,
      model,
      modelSize: modelSizes.get(model) ?? "",
      taskId,
      taskName: task?.name ?? taskId,
      mode,
      roleSignal: task?.roleSignal ?? "",
      standard: task?.standard ?? "",
      score: ok ? (scorers[taskId]?.(answer) ?? 0) : 0,
      durationMs: Number(durationText),
      outputChars: answer.length,
      approxOutputTokens: Math.max(1, Math.round(answer.split(/\s+/).filter(Boolean).length * 1.25)),
      evalRate: verbose.evalRate,
      promptEvalRate: verbose.promptEvalRate,
      promptEvalCount: verbose.promptEvalCount,
      evalCount: verbose.evalCount,
      ok,
      skipped: false,
      error: ok ? "" : answer || raw.slice(0, 500),
      sample: answer.slice(0, 900)
    });
  }

  const concurrencyLines = (await readFile(join(runDir, "concurrency.tsv"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean);
  const concurrency = concurrencyLines.map((line) => {
    const [model, agentsText, successesText, statusText, wallText, outputDir] = line.split("\t");
    const agents = Number(agentsText);
    const successes = Number(successesText);
    return {
      runId,
      generatedAt,
      model,
      modelSize: modelSizes.get(model) ?? "",
      agents,
      ok: statusText === "0",
      successRate: round(successes / agents),
      wallMs: Number(wallText),
      avgCallMs: Number(wallText),
      throughputPerSecond: Number((successes / (Number(wallText) / 1000)).toFixed(3)),
      outputDir: outputDir?.trim() ?? "",
      error: ""
    };
  });

  const coResidentOrchModel = (await readFile(join(runDir, "coresident-orch.txt"), "utf8").catch(() => "")).trim();
  const coResidentLines = (await readFile(join(runDir, "coresident-fanout.tsv"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean);
  const coResidentConcurrency = coResidentLines.map((line) => {
    const [model, agentsText, successesText, statusText, wallText, outputDir] = line.split("\t");
    const agents = Number(agentsText);
    const successes = Number(successesText);
    return {
      runId,
      generatedAt,
      model,
      modelSize: modelSizes.get(model) ?? "",
      orchModel: coResidentOrchModel,
      agents,
      ok: statusText === "0",
      successRate: round(successes / agents),
      wallMs: Number(wallText),
      throughputPerSecond: Number((successes / (Number(wallText) / 1000)).toFixed(3)),
      outputDir: outputDir?.trim() ?? ""
    };
  });

  return { runId, generatedAt, profile, modelSizes, modelMetadata, taskRows, results, concurrency, coResidentConcurrency };
}

function nullableMean(rows) {
  if (!rows.length) return null;
  return round(mean(rows.map((r) => r.score)));
}

function nullableMeanMs(rows) {
  if (!rows.length) return null;
  return Math.round(mean(rows.map((r) => r.durationMs)));
}

function computeRunSummary(model, runData) {
  const rows = runData.results.filter((r) => r.model === model);
  const directRows = rows.filter((r) => r.mode === "direct");
  const lowRows    = rows.filter((r) => r.mode === "low");
  const mediumRows = rows.filter((r) => r.mode === "medium");
  const highRows   = rows.filter((r) => r.mode === "high");

  const directQuality = mean(directRows.map((r) => r.score));
  const lowQuality    = nullableMean(lowRows);
  const mediumQuality = nullableMean(mediumRows);
  const highQuality   = nullableMean(highRows);

  const directMs = mean(directRows.map((r) => r.durationMs));
  const lowMs    = nullableMeanMs(lowRows);
  const mediumMs = nullableMeanMs(mediumRows);
  const highMs   = nullableMeanMs(highRows);

  // Best available think quality drives orchestrator/critic scores
  const bestThinkQuality = highQuality ?? mediumQuality ?? lowQuality ?? 0;
  const bestThinkRows = highRows.length ? highRows : mediumRows.length ? mediumRows : lowRows;

  const fanoutRows = runData.concurrency.filter((r) => r.model === model && r.ok);
  const maxRecommendedAgents = fanoutRows.length ? Math.max(...fanoutRows.map((r) => r.agents)) : 0;
  const coResidentRows = runData.coResidentConcurrency.filter((r) => r.model === model && r.ok);
  const maxCoResidentAgents = coResidentRows.length ? Math.max(...coResidentRows.map((r) => r.agents)) : 0;
  const fanoutScore = maxRecommendedAgents > 0 ? Math.min(1, maxRecommendedAgents / 4) : 0;

  const criticScore = weighted([
    [bestThinkRows.find((r) => r.taskId === "critic-medium")?.score ?? 0, 0.7],
    [bestThinkQuality, 0.3]
  ]);
  const topologyScore = weighted([
    [bestThinkRows.find((r) => r.taskId === "a2a-medium")?.score ?? 0, 0.65],
    [fanoutScore, 0.35]
  ]);

  return {
    runId: runData.runId,
    generatedAt: runData.generatedAt,
    quality: round(mean(rows.map((r) => r.score))),
    directQuality: round(directQuality),
    lowQuality,
    mediumQuality,
    highQuality,
    deliberateQuality: round(bestThinkQuality), // backward-compat: best available think level
    orchestratorScore: round(weighted([
      [bestThinkQuality, 0.45],
      [directRows.find((r) => r.taskId === "agentic-direct")?.score ?? 0, 0.2],
      [directRows.find((r) => r.taskId === "instruction")?.score ?? 0, 0.2],
      [directRows.find((r) => r.taskId === "reasoning")?.score ?? 0, 0.15]
    ])),
    workerScore: round(weighted([
      [directQuality, 0.65],
      [speedScore(directMs), 0.25],
      [directRows.find((r) => r.taskId === "rag")?.score ?? 0, 0.1]
    ])),
    criticScore: round(criticScore),
    topologyScore: round(topologyScore),
    avgMs: Math.round(mean(rows.map((r) => r.durationMs))),
    directMs: Math.round(directMs),
    lowMs,
    mediumMs,
    highMs,
    deliberateMs: mediumMs ?? lowMs ?? highMs ?? 0,
    avgEvalRate: Number(mean(rows.map((r) => r.evalRate).filter((v) => typeof v === "number")).toFixed(2)),
    avgPromptEvalRate: Number(mean(rows.map((r) => r.promptEvalRate).filter((v) => typeof v === "number")).toFixed(2)),
    maxRecommendedAgents,
    maxCoResidentAgents
  };
}

async function main() {
  const runDirs = await findRunDirs();
  if (!runDirs.length) throw new Error("No benchmark run directories with results found.");

  const allRunData = [];
  for (const dir of runDirs) {
    const data = await parseRunDir(dir);
    if (data.results.length > 0) allRunData.push(data);
  }
  const latestRunData = allRunData[allRunData.length - 1];
  const currentModels = await getInstalledModels(
    latestRunData?.runId ? join("benchmark-runs", latestRunData.runId) : ""
  );

  const allModelNames = new Set(allRunData.flatMap((r) => r.results.map((row) => row.model)));
  const inventoryModelNames = new Set([
    ...Array.from(currentModels),
    ...Array.from(latestRunData.modelSizes.keys())
  ]);
  const utilityModelNames = Array.from(inventoryModelNames).filter((model) => !allModelNames.has(model));

  const models = Array.from(allModelNames).map((model) => {
    const modelRunData = allRunData.filter((r) => r.results.some((row) => row.model === model));
    const runs = modelRunData.map((rd) => computeRunSummary(model, rd));
    const latestRunData = modelRunData[modelRunData.length - 1];
    const latestSummary = runs[runs.length - 1];
    return {
      model,
      archived: !currentModels.has(model),
      size: latestRunData.modelSizes.get(model) ?? "",
      metadata: latestRunData.modelMetadata[model] ?? {},
      specialty: modelSpecialty(model, latestRunData.modelMetadata[model] ?? {}),
      ...latestSummary,
      runs: [...runs].reverse()
    };
  });

  const utilityModels = utilityModelNames.map((model) => {
    const metadata = latestRunData.modelMetadata[model] ?? {};
    return {
      model,
      archived: !currentModels.has(model),
      size: latestRunData.modelSizes.get(model) ?? "",
      metadata,
      specialty: modelSpecialty(model, metadata)
    };
  }).sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.model.localeCompare(b.model);
  });

  models.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return b.orchestratorScore - a.orchestratorScore;
  });

  const allResults = allRunData.flatMap((r) => r.results);
  const allConcurrency = allRunData.flatMap((r) => r.concurrency);
  const allCoResidentConcurrency = allRunData.flatMap((r) => r.coResidentConcurrency);

  const allRuns = allRunData.map((r) => ({
    runId: r.runId,
    generatedAt: r.generatedAt,
    modelCount: new Set(r.results.map((row) => row.model)).size,
    profile: r.profile?.selected ?? "legacy"
  }));

  const [machine, system] = await Promise.all([
    readMachineInfo(latestRunData.runId ? join("benchmark-runs", latestRunData.runId) : "."),
    readSystemStats()
  ]);

  await mkdir("src/data", { recursive: true });
  await writeFile(
    "src/data/benchmark-results.json",
    `${JSON.stringify({
      lastUpdated: new Date().toISOString(),
      allRuns,
      currentModels: Array.from(currentModels),
      host: {
        timeoutMs,
        machine,
        system,
        benchmarkProfile: latestRunData.profile,
        runner: "Shell executes Ollama directly; Node only compiles raw outputs into report JSON."
      },
      tasks: latestRunData.taskRows,
      models,
      utilityModels,
      results: allResults,
      concurrency: allConcurrency,
      coResidentConcurrency: allCoResidentConcurrency
    }, null, 2)}\n`
  );

  const archivedCount = models.filter((m) => m.archived).length;
  console.log(
    `Compiled ${allResults.length} probe results across ${allRunData.length} run(s), ` +
    `${models.length} models (${archivedCount} archived).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
