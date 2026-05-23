import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Clock,
  Cpu,
  GitBranch,
  Gauge,
  History,
  Layers3,
  Network,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Tag,
  TimerReset,
  TrendingUp,
  Workflow
} from "lucide-react";
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LineChart,
  Line,
  ResponsiveContainer
} from "recharts";
import data from "./data/benchmark-results.json";
import "./styles.css";

type Mode = "all" | "direct" | "low" | "medium" | "high";
type View = "dashboard" | "knowledge";

type RunSummary = {
  runId: string;
  generatedAt: string;
  quality: number;
  directQuality: number;
  deliberateQuality: number;
  orchestratorScore: number;
  workerScore: number;
  criticScore?: number;
  topologyScore?: number;
  avgMs: number;
  directMs: number;
  deliberateMs: number;
  lowQuality: number | null;
  mediumQuality: number | null;
  highQuality: number | null;
  lowMs: number | null;
  mediumMs: number | null;
  highMs: number | null;
  avgEvalRate: number;
  maxRecommendedAgents: number;
  maxCoResidentAgents?: number;
};

type ModelSummary = RunSummary & {
  model: string;
  size: string;
  metadata: ModelMetadata;
  archived: boolean;
  specialty?: ModelSpecialty;
  runs: RunSummary[];
};

type ModelMetadata = {
  architecture: string;
  parameters: string;
  contextLength: string;
  embeddingLength: string;
  quantization: string;
  capabilities: string[];
  parametersRaw: string[];
  license: string;
};

type ModelSpecialty = {
  category: string;
  role: string;
  testFamily: string;
  recommendation: string;
};

type UtilityModel = {
  model: string;
  size: string;
  metadata: Partial<ModelMetadata>;
  archived: boolean;
  specialty: ModelSpecialty;
};

type ResultRow = {
  runId: string;
  generatedAt: string;
  model: string;
  taskId: string;
  taskName: string;
  mode: "direct" | "low" | "medium" | "high";
  roleSignal: string;
  standard: string;
  score: number;
  durationMs: number;
  evalRate: number | null;
  ok: boolean;
  sample: string;
};

type FanoutRow = {
  runId: string;
  generatedAt: string;
  model: string;
  orchModel?: string;
  agents: number;
  ok: boolean;
  successRate: number;
  wallMs: number;
  throughputPerSecond: number;
};

const benchmark = data as {
  lastUpdated: string;
  allRuns: { runId: string; generatedAt: string; modelCount: number; profile?: string }[];
  currentModels: string[];
  host: {
    runner: string;
    timeoutMs: number;
    benchmarkProfile?: {
      requested: string;
      selected: string;
      reason: string;
      os: string;
      arch: string;
      chip: string;
      memoryBytes: number;
      gpuCount: number;
      gpuNames: string;
      fanoutCalibrationModel?: string;
      fanoutCeiling?: number;
      timeoutMs: number;
    };
    machine: { name: string; chip: string; memory: string };
    system: {
      disk: { total: number; used: number; free: number };
      memory: { total: number; free: number };
      ollamaModelsBytes: number;
    };
  };
  models: ModelSummary[];
  utilityModels?: UtilityModel[];
  results: ResultRow[];
  concurrency: FanoutRow[];
  coResidentConcurrency?: FanoutRow[];
};

const COLORS = {
  primary:       "#2e8b5d", // forest green — direct quality anchor
  orchestrator:  "#3d6b8c", // steel blue
  worker:        "#b85c38", // burnt sienna
  direct:        "#2e8b5d", // forest green (same as primary)
  deliberate:    "#7a6b3a", // warm olive
  speed:         "#c4943a", // amber
  grid:          "#e0e8df",
  muted:         "#60756a",
  fg:            "#17211d"
};

const FAMILY_COLORS = ["#3d6b8c", "#b85c38", "#2e8b5d", "#c4943a", "#7a6b3a", "#8b4f71", "#536f3f", "#5b6478"];
const RADAR_COLORS = ["#3d6b8c", "#b85c38", "#2e8b5d", "#8b4f71"];

const PROFILE_DEFINITIONS = {
  apple_silicon_compact: {
    label: "compact Apple Silicon local-agent probes",
    intensity: "compact",
    concurrency: "a calibrated same-model fanout benchmark measured at run start",
    topology: "favor a small topology: one orchestrator, one or two workers, and a selective critic",
    description: "Shorter local probes tuned for Apple Silicon unified memory and Metal-backed inference."
  },
  cuda_single_workstation: {
    label: "single-GPU workstation agent probes",
    intensity: "standard workstation",
    concurrency: "a calibrated same-model fanout benchmark measured at run start",
    topology: "use a stronger planner plus several direct workers; reserve deliberate calls for planning and review",
    description: "Expanded probes for a CUDA workstation where longer prompts are reasonable and fanout is calibrated at run start."
  },
  cuda_multi_lab: {
    label: "multi-GPU workstation/lab orchestration probes",
    intensity: "expanded lab",
    concurrency: "a calibrated same-model fanout benchmark measured at run start",
    topology: "test lab-style topologies with orchestrator, specialized workers, critic, summarizer, and retry lanes",
    description: "Heavier orchestration probes for multi-GPU CUDA systems where parallel agent experiments are expected."
  },
  cpu_only: {
    label: "CPU-only local inference sanity probes",
    intensity: "sanity",
    concurrency: "a calibrated same-model fanout benchmark measured at run start",
    topology: "favor sequential worker calls and avoid autonomous multi-agent fanout",
    description: "Minimal probes intended to confirm basic local usefulness without overloading CPU inference."
  },
  unknown_local: {
    label: "general local inference probes",
    intensity: "general local",
    concurrency: "a calibrated same-model fanout benchmark measured at run start",
    topology: "start with one orchestrator and one worker; expand only after fanout results are stable",
    description: "Portable local probes used when accelerator capabilities cannot be determined."
  },
  legacy: {
    label: "legacy local inference probes",
    intensity: "legacy",
    concurrency: "historical fanout rows are interpreted as measured same-model concurrency probes",
    topology: "interpret results as historical local signals rather than profile-specific recommendations",
    description: "This run predates adaptive hardware profile metadata."
  }
} as const;

type ProfileId = keyof typeof PROFILE_DEFINITIONS;

function normalizeProfileId(value?: string): ProfileId {
  if (value === "lite") return "apple_silicon_compact";
  if (value === "standard") return "cuda_single_workstation";
  if (value === "workstation") return "cuda_multi_lab";
  if (value && value in PROFILE_DEFINITIONS) return value as ProfileId;
  return "unknown_local";
}

function profileDefinition(profile?: typeof benchmark.host.benchmarkProfile) {
  const id = normalizeProfileId(profile?.selected);
  return { id, ...PROFILE_DEFINITIONS[id] };
}

const TOOLTIP_STYLE = {
  background: "#fff",
  border: `1px solid #d8e2d8`,
  borderRadius: 8,
  fontSize: 12,
  color: COLORS.fg
};

const pct = (value: number) => `${Math.round(value * 100)}%`;
const ms = (value: number) => `${Math.round(value).toLocaleString()} ms`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const fmtBytes = (b: number) =>
  b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` :
  b >= 1e9  ? `${(b / 1e9).toFixed(1)} GB` :
  b >= 1e6  ? `${(b / 1e6).toFixed(0)} MB` : `${b} B`;

const shortName = (model: string) =>
  (model.split(":")[0].split("/").pop() ?? model).slice(0, 20);

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [selectedModel, setSelectedModel] = useState<string>(
    benchmark.models.find((m) => !m.archived)?.model ?? benchmark.models[0]?.model ?? ""
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const activeModels = useMemo(() => benchmark.models.filter((m) => !m.archived), []);
  const utilityModels = benchmark.utilityModels ?? [];
  const activeUtilityModels = useMemo(() => utilityModels.filter((m) => !m.archived), [utilityModels]);
  const archivedCount = benchmark.models.length + utilityModels.length - activeModels.length - activeUtilityModels.length;

  const ranked = useMemo(
    () =>
      benchmark.models
        .filter((m) => (showArchived || !m.archived) && m.model.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => {
          if (a.archived !== b.archived) return a.archived ? 1 : -1;
          return b.orchestratorScore - a.orchestratorScore;
        }),
    [query, showArchived]
  );
  const rankedUtility = useMemo(
    () =>
      utilityModels
        .filter((m) => (showArchived || !m.archived) && m.model.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => {
          if (a.archived !== b.archived) return a.archived ? 1 : -1;
          return a.model.localeCompare(b.model);
        }),
    [query, showArchived, utilityModels]
  );

  const selectedUtility = utilityModels.find((m) => m.model === selectedModel);
  const selected = benchmark.models.find((m) => m.model === selectedModel) ?? (selectedUtility ? undefined : ranked[0]);
  const latestRunId = selected?.runs[0]?.runId;
  const effectiveRunId = selectedRunId ?? latestRunId;

  const rows = benchmark.results.filter(
    (row) => row.model === selected?.model && row.runId === effectiveRunId
  );
  const fanout = benchmark.concurrency.filter(
    (row) => row.model === selected?.model && row.runId === effectiveRunId
  );
  const coResidentFanout = (benchmark.coResidentConcurrency ?? []).filter(
    (row) => row.model === selected?.model && row.runId === effectiveRunId
  );

  const fanoutChartData = useMemo(() => {
    const allLevels = [...new Set([...fanout, ...coResidentFanout].map((r) => r.agents))].sort((a, b) => a - b);
    return allLevels.map((agents) => {
      const s = fanout.find((r) => r.agents === agents);
      const c = coResidentFanout.find((r) => r.agents === agents);
      return {
        agents: String(agents),
        Standalone: s ? Number(s.throughputPerSecond.toFixed(2)) : undefined,
        "Co-resident": c ? Number(c.throughputPerSecond.toFixed(2)) : undefined
      };
    });
  }, [fanout, coResidentFanout]);

  const bestOrchestrator = [...activeModels].sort((a, b) => b.orchestratorScore - a.orchestratorScore)[0];
  const bestWorker = [...activeModels].sort((a, b) => b.workerScore - a.workerScore)[0];
  const fastest = [...activeModels].sort((a, b) => a.directMs - b.directMs)[0];
  const bestFanout = [...activeModels].sort((a, b) => b.maxRecommendedAgents - a.maxRecommendedAgents)[0];

  const radarData = useMemo(() => {
    if (!selected) return [];
    const speedVal = Math.max(0, Math.min(1, 1 - selected.directMs / benchmark.host.timeoutMs));
    return [
      { subject: "Orchestrator", value: selected.orchestratorScore },
      { subject: "Worker", value: selected.workerScore },
      { subject: "Critic", value: selected.criticScore ?? selected.deliberateQuality },
      { subject: "A2A", value: selected.topologyScore ?? 0 },
      { subject: "Speed", value: speedVal }
    ];
  }, [selected]);

  const evolutionData = useMemo(() =>
    benchmark.allRuns
      .map((run) => {
        const runModels = benchmark.models.flatMap((m) =>
          m.runs.filter((r) => r.runId === run.runId)
        );
        if (!runModels.length) return null;
        return {
          date: fmtDate(run.generatedAt),
          "Best Orch": Math.round(Math.max(...runModels.map((r) => r.orchestratorScore)) * 100),
          "Best Worker": Math.round(Math.max(...runModels.map((r) => r.workerScore)) * 100),
          "Avg Quality": Math.round(
            runModels.reduce((s, r) => s + r.quality, 0) / runModels.length * 100
          )
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null),
    []
  );

  const comparisonData = useMemo(() =>
    [...(showArchived ? benchmark.models : activeModels)]
      .sort((a, b) => b.orchestratorScore - a.orchestratorScore)
      .map((m) => ({
        model: shortName(m.model),
        Orchestrator: Math.round(m.orchestratorScore * 100),
        Worker: Math.round(m.workerScore * 100),
        archived: m.archived
      })),
    [showArchived, activeModels]
  );

  function selectModel(model: string) {
    setSelectedModel(model);
    setSelectedRunId(null);
  }

  const profile = benchmark.host.benchmarkProfile;
  const profileInfo = profileDefinition(profile);

  return (
    <main>
      <section className="topbar">
        <div>
          <p className="eyebrow">Local Ollama Benchmark</p>
          <h1>{benchmark.host.machine.name} model comparison</h1>
        </div>
        <div className="runMeta">
          {benchmark.host.machine.chip && (
            <span><Cpu size={16} /> {benchmark.host.machine.chip} · {benchmark.host.machine.memory}</span>
          )}
          <span>
            <Server size={16} />
            {activeModels.length + activeUtilityModels.length} active{archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
          </span>
          <span>
            <Clock size={16} /> {fmtDate(benchmark.lastUpdated)}
          </span>
        </div>
      </section>

      <nav className="viewTabs" aria-label="Report sections">
        <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
          <Activity size={16} /> Dashboard
        </button>
        <button className={view === "knowledge" ? "active" : ""} onClick={() => setView("knowledge")}>
          <BookOpen size={16} /> Knowledge Base
        </button>
      </nav>

      {view === "knowledge" ? (
        <KnowledgeArticle profile={profile} models={activeModels} utilityModels={benchmark.utilityModels ?? []} />
      ) : (
      <>

      <section className="metricGrid">
        {bestOrchestrator && <Metric icon={<Brain />} label="Best orchestrator" value={bestOrchestrator.model} detail={pct(bestOrchestrator.orchestratorScore)} iconBg="#dce8f0" iconColor={COLORS.orchestrator} />}
        {bestWorker && <Metric icon={<Bot />} label="Best worker" value={bestWorker.model} detail={pct(bestWorker.workerScore)} iconBg="#f5e8df" iconColor={COLORS.worker} />}
        {fastest && <Metric icon={<Gauge />} label="Fastest direct" value={fastest.model} detail={ms(fastest.directMs)} iconBg="#e4efe8" iconColor={COLORS.direct} />}
        {bestFanout && <Metric
          icon={<Boxes />}
          label="Fanout ceiling"
          value={`${bestFanout.maxRecommendedAgents} standalone${(bestFanout.maxCoResidentAgents ?? 0) > 0 ? ` · ${bestFanout.maxCoResidentAgents} co-resident` : ""}`}
          detail={(bestFanout.maxCoResidentAgents ?? 0) > 0 ? "agents (unloaded / with orchestrator in memory)" : "max same-model agents, standalone"}
          iconBg="#f5edd8"
          iconColor={COLORS.speed}
        />}
      </section>

      <SystemStatus system={benchmark.host.system} />

      {profile && (
        <section className="profileBanner">
          <div>
            <span>Benchmark profile</span>
            <strong>{profileInfo.label}</strong>
          </div>
          <p>{profile.reason}</p>
          <small>
            {profile.os || "unknown OS"} {profile.arch || ""}{profile.gpuCount ? ` · ${profile.gpuCount} NVIDIA GPU${profile.gpuCount > 1 ? "s" : ""}` : ""}
            {profile.gpuNames ? ` · ${profile.gpuNames}` : ""}
            {profile.fanoutCeiling ? ` · calibrated fanout ${profile.fanoutCeiling}` : ""}
            {profile.fanoutCalibrationModel ? ` · calibrated with ${profile.fanoutCalibrationModel}` : ""}
          </small>
        </section>
      )}

      <div className="overviewGrid">
        <section className="band overviewBand">
          <h3><TrendingUp size={18} /> Fleet Progress Over Time</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={evolutionData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: COLORS.muted }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} unit="%" width={36} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}%`]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="Best Orch" stroke={COLORS.orchestrator} strokeWidth={2} dot={{ r: 4, fill: COLORS.orchestrator }} />
              <Line type="monotone" dataKey="Best Worker" stroke={COLORS.worker} strokeWidth={2} dot={{ r: 4, fill: COLORS.worker }} />
              <Line type="monotone" dataKey="Avg Quality" stroke={COLORS.speed} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: COLORS.speed }} />
            </LineChart>
          </ResponsiveContainer>
        </section>

        <section className="band overviewBand">
          <h3><Activity size={18} /> Model Comparison</h3>
          <ResponsiveContainer width="100%" height={comparisonData.length * 48 + 36}>
            <BarChart data={comparisonData} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barGap={3} barCategoryGap="30%">
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} unit="%" />
              <YAxis type="category" dataKey="model" width={120} tick={{ fontSize: 11, fill: COLORS.fg }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}%`]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Orchestrator" fill={COLORS.orchestrator} radius={[0, 3, 3, 0]} />
              <Bar dataKey="Worker" fill={COLORS.worker} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>
      </div>

      <section className="layout">
        <aside className="sidebar">
          <div className="sidebarControls">
            <label className="search">
              <Search size={16} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter models" />
            </label>
            {archivedCount > 0 && (
              <button className="archiveToggle" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </button>
            )}
          </div>
          <details className="modelGroup generativeGroup" open>
            <summary>Generative models <small>{ranked.length}</small></summary>
            <div className="modelList">
              {ranked.map((model) => (
                <button
                  key={model.model}
                  className={["modelButton", "generativeButton", model.model === selected?.model ? "active" : "", model.archived ? "archived" : ""].filter(Boolean).join(" ")}
                  onClick={() => selectModel(model.model)}
                >
                  <span>
                    {model.model}
                    {model.archived && <em className="archivedBadge">archived</em>}
                  </span>
                  <small>{pct(model.orchestratorScore)} orch · {pct(model.workerScore)} worker</small>
                </button>
              ))}
            </div>
          </details>
          {rankedUtility.length > 0 && (
            <details className="modelGroup specialtyGroup" open>
              <summary>Specialty models <small>{rankedUtility.length}</small></summary>
              <div className="modelList">
                {rankedUtility.map((model) => (
                  <button
                    key={model.model}
                    className={["modelButton", "specialtyButton", model.model === selectedUtility?.model ? "active" : "", model.archived ? "archived" : ""].filter(Boolean).join(" ")}
                    onClick={() => selectModel(model.model)}
                  >
                    <span>
                      {model.model}
                      {model.archived && <em className="archivedBadge">archived</em>}
                    </span>
                    <small>{model.specialty.category} · {model.specialty.role}</small>
                  </button>
                ))}
              </div>
            </details>
          )}
        </aside>

        <section className="content">
          {selectedUtility ? (
            <SpecialtyModelPanel model={selectedUtility} />
          ) : selected && (
            <>
              <header className="modelHeader">
                <div>
                  <h2>
                    {selected.model}
                    {selected.archived && <em className="archivedBadge">archived</em>}
                  </h2>
                  <p>{recommendation(selected, profileInfo.id)}</p>
                </div>
              </header>

              <div className="scoreSection">
                <div className="scoreGrid">
                  <Score label="Orchestrator" value={selected.orchestratorScore} color={COLORS.orchestrator} />
                  <Score label="Worker" value={selected.workerScore} color={COLORS.worker} />
                  <Score label="Critic" value={selected.criticScore ?? selected.deliberateQuality} color={COLORS.deliberate} />
                  <Score label="A2A / Fanout" value={selected.topologyScore ?? 0} color={COLORS.speed} />
                </div>
                <div className="radarWrap">
                  <ResponsiveContainer width="100%" height={220}>
                    <RadarChart data={radarData} margin={{ top: 10, right: 24, left: 24, bottom: 10 }}>
                      <PolarGrid stroke={COLORS.grid} />
                      <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11, fill: COLORS.muted }} />
                      <PolarRadiusAxis domain={[0, 1]} tick={false} axisLine={false} />
                      <Radar dataKey="value" stroke={COLORS.muted} fill={COLORS.muted} fillOpacity={0.12} strokeWidth={1.5} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="modeDiagnostics">
                <span>Think-level diagnostics</span>
                <strong>Direct {pct(selected.directQuality)}</strong>
                <strong>Low {selected.lowQuality !== null ? pct(selected.lowQuality) : "n/a"}</strong>
                <strong>Medium {selected.mediumQuality !== null ? pct(selected.mediumQuality) : "n/a"}</strong>
                <strong>High {selected.highQuality !== null ? pct(selected.highQuality) : "n/a"}</strong>
                <small>Per-level averages. n/a means that think level has not been benchmarked yet. Role scores use the best available think level.</small>
              </div>

              <section className="band">
                <h3><Tag size={18} /> Ollama Model Metadata</h3>
                <div className="metadataGrid">
                  <Meta label="Capabilities" value={selected.metadata.capabilities.join(", ")} />
                  <Meta label="Architecture" value={selected.metadata.architecture} />
                  <Meta label="Parameters" value={selected.metadata.parameters} />
                  <Meta label="Quantization" value={selected.metadata.quantization} />
                  <Meta label="Context" value={selected.metadata.contextLength} />
                  <Meta label="Embedding length" value={selected.metadata.embeddingLength} />
                </div>
                {selected.metadata.license && <p className="licenseLine">{selected.metadata.license}</p>}
              </section>

              <section className="band">
                <h3><Workflow size={18} /> Agent Use Profile</h3>
                <div className="agentGrid">
                  <AgentRole icon={<GitBranch />} title="Orchestrator" text={orchestratorText(selected, profileInfo.id)} />
                  <AgentRole icon={<Layers3 />} title="Sub-agent" text={workerText(selected, profileInfo.id)} />
                  <AgentRole icon={<ShieldCheck />} title="Critic" text={criticText(selected, profileInfo.id)} />
                  <AgentRole icon={<Network />} title="A2A layout" text={a2aText(selected, profileInfo.id)} />
                </div>
              </section>

              {selected.runs.length > 1 && (
                <section className="band">
                  <h3><History size={18} /> Run History</h3>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart
                      data={[...selected.runs].reverse().map((r) => ({
                        date: fmtDate(r.generatedAt),
                        runId: r.runId,
                        Quality: Math.round(r.quality * 100),
                        Direct: Math.round(r.directQuality * 100),
                        Medium: Math.round(r.deliberateQuality * 100)
                      }))}
                      margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
                      barGap={2}
                      barCategoryGap="25%"
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: COLORS.muted }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: COLORS.muted }} unit="%" width={36} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}%`]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Quality" fill={COLORS.primary} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Direct" fill={COLORS.orchestrator} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Medium" fill={COLORS.deliberate} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="table" style={{ marginTop: 12 }}>
                    <div className="thead historyRow">
                      <span>Run</span>
                      <span>Quality</span>
                      <span>Direct</span>
                      <span>Medium</span>
                      <span>Orchestrator</span>
                      <span>Worker</span>
                    </div>
                    {selected.runs.map((run) => (
                      <button
                        key={run.runId}
                        className={["trow historyRow", run.runId === effectiveRunId ? "activeRun" : ""].filter(Boolean).join(" ")}
                        onClick={() => setSelectedRunId(run.runId === effectiveRunId ? null : run.runId)}
                        title="Click to view this run's probe results"
                      >
                        <span>{fmtDate(run.generatedAt)}<small>{run.runId}</small></span>
                        <span>{pct(run.quality)}</span>
                        <span>{pct(run.directQuality)}</span>
                        <span>{pct(run.deliberateQuality)}</span>
                        <span>{pct(run.orchestratorScore)}</span>
                        <span>{pct(run.workerScore)}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="band">
                <h3>
                  <Activity size={18} /> Probe Results
                  {effectiveRunId && effectiveRunId !== latestRunId && (
                    <small className="runLabel">
                      {fmtDate(selected.runs.find((r) => r.runId === effectiveRunId)?.generatedAt ?? "")}
                    </small>
                  )}
                </h3>
                <div className="table">
                  <div className="thead">
                    <span>Probe</span>
                    <span>Mode</span>
                    <span>Score</span>
                    <span>Latency</span>
                    <span>Role signal</span>
                  </div>
                  {rows.map((row) => (
                    <button className="trow" key={`${row.model}-${row.taskId}-${row.runId}`} title={row.sample}>
                      <span>{row.taskName}<small>{row.standard}</small></span>
                      <span>{row.mode}</span>
                      <span>{pct(row.score)}</span>
                      <span>{ms(row.durationMs)}</span>
                      <span>{row.roleSignal}</span>
                    </button>
                  ))}
                </div>
              </section>

              {fanoutChartData.length > 0 && (
              <section className="band">
                <h3><TimerReset size={18} /> Same-model Fanout</h3>
                {coResidentFanout.length > 0 && coResidentFanout[0].orchModel && (
                  <p className="fanoutLabel">Co-resident series: orchestrator <em>{coResidentFanout[0].orchModel}</em> held in memory during worker probe.</p>
                )}
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={fanoutChartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barGap={4} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} vertical={false} />
                    <XAxis dataKey="agents" tick={{ fontSize: 11, fill: COLORS.muted }} label={{ value: "agents", position: "insideBottomRight", offset: -4, fontSize: 11, fill: COLORS.muted }} />
                    <YAxis tick={{ fontSize: 11, fill: COLORS.muted }} label={{ value: "req/s", angle: -90, position: "insideLeft", offset: 8, fontSize: 11, fill: COLORS.muted }} width={40} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v} req/s`]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Standalone" fill={COLORS.orchestrator} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Co-resident" fill={COLORS.worker} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </section>
              )}
            </>
          )}
        </section>
      </section>

      <section className="standards">
        <h3><Sparkles size={18} /> Benchmark Standards Used</h3>
        <p>
          These are {profileInfo.label} inspired by IFEval, GSM8K, HumanEval/MBPP, MMLU, RAGAS,
          AgentBench/WebArena, Reflexion/SWE-agent critique, and multi-agent topology design.
          They are not full benchmark-suite scores; they are practical {benchmark.host.machine.name} signals for local agent design.
        </p>
        <p>
          Mode means how the model was asked to work: direct probes use `--think=false` for fast worker behavior,
          while medium probes use `--think=medium` for planning, critique, and orchestration behavior. Medium probes
          only run on models that report a thinking capability in `ollama show`.
        </p>
        <p>{benchmark.host.runner}</p>
      </section>
      </>
      )}
    </main>
  );
}

function KnowledgeArticle({
  profile,
  models,
  utilityModels
}: {
  profile?: typeof benchmark.host.benchmarkProfile;
  models: ModelSummary[];
  utilityModels: UtilityModel[];
}) {
  const profileInfo = profileDefinition(profile);
  const selected = profileInfo.id;
  const families = [
    {
      title: "Instruction Following",
      standard: "IFEval-style probes",
      tests: "Whether a model can satisfy explicit formatting and constraint requirements.",
      localUse: "Useful for routers, API-facing workers, and any agent that must emit exact JSON, labels, or command-shaped text."
    },
    {
      title: "Quantitative Reasoning",
      standard: "GSM8K, BBH, and related arithmetic reasoning suites",
      tests: "Multi-step arithmetic, variable tracking, and resistance to plausible but wrong shortcuts.",
      localUse: "A signal for planners, verifiers, and capacity-estimation agents."
    },
    {
      title: "Code Generation and Repair",
      standard: "HumanEval, MBPP, and SWE-bench-style localized repair",
      tests: "Small function synthesis, type awareness, edge-case handling, and patch reasoning.",
      localUse: "A signal for code sub-agents, patch drafters, test helpers, and reviewer assistants."
    },
    {
      title: "Applied Knowledge",
      standard: "MMLU-style domain concept checks",
      tests: "Whether a model can explain common technical concepts without drifting away from the requested answer shape.",
      localUse: "Useful for triage, explanations, and general assistant work where factual grounding still matters."
    },
    {
      title: "Grounded Summarization",
      standard: "RAGAS, HotpotQA, and NarrativeQA-inspired retrieval synthesis",
      tests: "Faithfulness to supplied facts, extraction of blockers and risks, and compact synthesis.",
      localUse: "A signal for RAG workers, report compressors, and evidence-tracking agents."
    },
    {
      title: "Agentic Planning",
      standard: "AgentBench, WebArena, ToolBench, and orchestration proxies",
      tests: "Task decomposition, handoff policy, tool sequencing, failure recovery, and stop conditions.",
      localUse: "A signal for orchestrators that coordinate sub-agents instead of simply answering directly."
    },
    {
      title: "Critic and Repair",
      standard: "Reflexion and SWE-agent-style self-review loops",
      tests: "Whether a model catches objective mismatches, repairs bad plans, and identifies missing evaluation criteria.",
      localUse: "Useful as an escalation gate before a final answer, patch, or automation step is accepted."
    },
    {
      title: "Multi-agent Topology",
      standard: "A2A and collaborative-agent design proxies",
      tests: "Whether a model can describe node roles, edges, handoffs, and coordination patterns clearly.",
      localUse: "A signal for designing orchestrator-worker-critic-summarizer layouts."
    }
  ];
  const modalityFamilies = [
    {
      category: "Embedding",
      tests: "MTEB, BEIR, semantic textual similarity, clustering, retrieval recall",
      fixture: "query/document pairs, duplicate passages, hard negatives, domain-specific snippets"
    },
    {
      category: "Vision-language",
      tests: "MMMU, MathVista, VQAv2, image captioning, screenshot QA",
      fixture: "charts, diagrams, UI screenshots, product photos, maps, visual reasoning cards"
    },
    {
      category: "Document OCR",
      tests: "OCRBench, DocVQA, ChartQA, PubTabNet, FUNSD",
      fixture: "scanned pages, forms, receipts, tables, slide screenshots, low-quality text crops"
    },
    {
      category: "Audio",
      tests: "LibriSpeech, Common Voice, FLEURS, WER, diarization and spoken QA",
      fixture: "short WAV/MP3 clips, noisy speech, speaker changes, timestamps, command audio"
    },
    {
      category: "Reranking",
      tests: "MTEB reranking, BEIR NDCG, recall@k and precision@k",
      fixture: "one query plus candidate passages already retrieved by an embedding model"
    },
    {
      category: "Tool-capable",
      tests: "ToolBench, function-call validity, argument grounding, recovery from tool errors",
      fixture: "JSON schemas, fake tool responses, failed-call transcripts, constrained routing tasks"
    }
  ];
  const radarModels = [...models]
    .sort((a, b) => b.orchestratorScore - a.orchestratorScore)
    .slice(0, 4);
  const multiModelRadar = ["Orchestrator", "Worker", "Critic", "A2A", "Speed"].map((subject) => {
    const row: Record<string, string | number> = { subject };
    for (const model of radarModels) {
      const speedVal = Math.max(0, Math.min(1, 1 - model.directMs / benchmark.host.timeoutMs));
      row[shortName(model.model)] =
        subject === "Orchestrator" ? model.orchestratorScore :
        subject === "Worker" ? model.workerScore :
        subject === "Critic" ? (model.criticScore ?? model.deliberateQuality) :
        subject === "A2A" ? (model.topologyScore ?? 0) :
        speedVal;
    }
    return row;
  });

  return (
    <article className="article">
      <header className="articleHero">
        <p className="eyebrow">Knowledge Base</p>
        <h2>How this local benchmark maps to industry LLM evaluations</h2>
        <p>
          This report uses {profileInfo.label} inspired by established benchmark families. The goal is not to claim
          official benchmark scores; it is to translate those ideas into practical signals for choosing local Ollama
          models as orchestrators, workers, critics, and summarizers.
        </p>
      </header>

      {radarModels.length > 0 && (
        <section className="articleBand recallBand">
          <div>
            <h3><Network size={18} /> Multi-model spider chart</h3>
            <p>
              The spider chart is the memory hook for the report: wide shapes indicate balanced local usefulness,
              while lopsided shapes show models that are better as specialists. Orchestrator, critic, worker, and A2A
              are role scores; direct and medium mode are lower-level diagnostics shown in the probe table.
            </p>
          </div>
          <div className="articleRadar">
            <ResponsiveContainer width="100%" height={280}>
              <RadarChart data={multiModelRadar} margin={{ top: 20, right: 42, left: 42, bottom: 20 }}>
                <PolarGrid stroke={COLORS.grid} />
                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12, fill: COLORS.fg }} />
                <PolarRadiusAxis domain={[0, 1]} tick={false} axisLine={false} />
                {radarModels.map((model, index) => (
                  <Radar
                    key={model.model}
                    name={shortName(model.model)}
                    dataKey={shortName(model.model)}
                    stroke={RADAR_COLORS[index % RADAR_COLORS.length]}
                    fill={RADAR_COLORS[index % RADAR_COLORS.length]}
                    fillOpacity={0.08}
                    strokeWidth={2}
                  />
                ))}
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="articleBand">
        <h3><Cpu size={18} /> Platform-aware test selection</h3>
        <p>
          The runner selects a benchmark profile before it writes `tasks.tsv`. The selected profile changes the
          benchmark description, workload intensity, concurrency assumptions, and agent topology recommendations.
          This artifact is using <strong>{profileInfo.label}</strong>: {profileInfo.description}
        </p>
        <div className="profileCards">
          <ProfileCard name="Apple Silicon" text="compact Apple Silicon local-agent probes; shorter prompts and host-calibrated fanout." active={selected === "apple_silicon_compact"} />
          <ProfileCard name="Single CUDA" text="single-GPU workstation agent probes; longer grounding, repair, and host-calibrated fanout." active={selected === "cuda_single_workstation"} />
          <ProfileCard name="Multi CUDA" text="multi-GPU workstation/lab orchestration probes; heavier routing, synthesis, and host-calibrated fanout." active={selected === "cuda_multi_lab"} />
          <ProfileCard name="CPU only" text="CPU-only local inference sanity probes; sequential workload with host-calibrated fanout." active={selected === "cpu_only"} />
          <ProfileCard name="Unknown local" text="general local inference probes; portable baseline until hardware behavior is known." active={selected === "unknown_local" || selected === "legacy"} />
        </div>
        {profile && (
          <p className="profileNote">
            Current artifact profile: <strong>{profileInfo.id}</strong>. {profile.reason || profileInfo.description}
          </p>
        )}
      </section>

      <section className="articleBand">
        <h3><Workflow size={18} /> Direct vs medium mode</h3>
        <p>
          The mode field describes the execution posture of a probe, not a separate model family. Direct mode asks
          for the shortest useful path through the task and disables model thinking with `--think=false`. Medium
          mode enables `--think=medium` and asks questions where planning, critique, recovery, or handoff design matter.
          Medium-think probes are only run on models that report a <strong>thinking</strong> capability in `ollama show`.
        </p>
        <div className="modeExplainer">
          <article>
            <strong>Direct</strong>
            <span>Fast worker posture</span>
            <p>Best signal for extraction, formatting, short coding, grounded summaries, and repeated sub-agent calls.</p>
          </article>
          <article>
            <strong>Medium</strong>
            <span>Planner and critic posture</span>
            <p>Best signal for orchestration, task decomposition, failure recovery, A2A topology, and final review gates.</p>
          </article>
        </div>
      </section>

      <section className="articleGrid">
        {families.map((family, index) => (
          <article className="articleCard" key={family.title} style={{ borderTopColor: FAMILY_COLORS[index % FAMILY_COLORS.length] }}>
            <i style={{ background: FAMILY_COLORS[index % FAMILY_COLORS.length] }} />
            <span>{family.standard}</span>
            <h3>{family.title}</h3>
            <p>{family.tests}</p>
            <small>{family.localUse}</small>
          </article>
        ))}
      </section>

      {utilityModels.length > 0 && (
        <section className="articleBand">
          <h3><DatabaseIcon /> Specialty and non-chat models</h3>
          <p>
            Not every local model should be judged by chat benchmarks. Embedding models are retrieval infrastructure:
            their natural benchmark family is closer to MTEB, semantic textual similarity, retrieval recall, clustering,
            and reranking quality. The runner now skips non-generative models for chat probes and keeps them in the
            artifact as specialty inventory.
          </p>
          <div className="specialtyGrid">
            {utilityModels.map((model) => (
              <article className="specialtyCard" key={model.model}>
                <span>{model.specialty.category}</span>
                <h4>{model.model}</h4>
                <p>{model.specialty.recommendation}</p>
                <small>{model.specialty.testFamily}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="articleBand">
        <h3><Sparkles size={18} /> Future model categories</h3>
        <p>
          As the local model inventory grows, new categories should not be forced into the same text-only score.
          The artifact now treats capability as the first fork: completion models get chat and agent probes, while
          embedding, vision, OCR, audio, reranking, and tool-specialized models need fixtures that match the work they do.
        </p>
        <div className="modalityGrid">
          {modalityFamilies.map((family, index) => (
            <article className="modalityCard" key={family.category} style={{ borderTopColor: FAMILY_COLORS[index % FAMILY_COLORS.length] }}>
              <strong>{family.category}</strong>
              <span>{family.tests}</span>
              <small>{family.fixture}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="articleBand">
        <h3><ShieldCheck size={18} /> How to read the scores</h3>
        <p>
          The percentages are rubric scores from {profileInfo.intensity} probes, not official IFEval, GSM8K, HumanEval, MMLU, RAGAS,
          AgentBench, or SWE-bench results. Latency and fanout are measured locally through Ollama, so they are specific
          to the machine, model quantization, memory pressure, backend placement, and measured saturation behavior.
        </p>
        <p>
          Use the dashboard as an engineering decision aid: high orchestrator scores suggest stronger planning and
          handoff behavior, high worker scores favor repeated direct tasks, high critic scores favor review gates,
          and high A2A/fanout scores favor broader agent layouts. High medium-think latency means the model
          may still be useful but should be reserved for fewer, more valuable calls. For this profile, concurrency is
          {profileInfo.concurrency}; recommended topology is to {profileInfo.topology}.
        </p>
      </section>
    </article>
  );
}

function DatabaseIcon() {
  return <Server size={18} />;
}

function ProfileCard({ name, text, active }: { name: string; text: string; active: boolean }) {
  return (
    <div className={["profileCard", active ? "active" : ""].filter(Boolean).join(" ")}>
      <strong>{name}</strong>
      <p>{text}</p>
    </div>
  );
}

function SystemStatus({ system }: { system: typeof benchmark.host.system }) {
  const diskPct  = system.disk.total  > 0 ? system.disk.used / system.disk.total : 0;
  const memUsed  = system.memory.total - system.memory.free;
  const memPct   = system.memory.total > 0 ? memUsed / system.memory.total : 0;

  return (
    <div className="systemGrid">
      <SystemBar
        label="Storage"
        pct={diskPct}
        primary={`${fmtBytes(system.disk.used)} used of ${fmtBytes(system.disk.total)}`}
        detail={system.ollamaModelsBytes > 0 ? `${fmtBytes(system.ollamaModelsBytes)} in Ollama models` : undefined}
      />
      <SystemBar
        label="Memory"
        pct={memPct}
        primary={`${fmtBytes(memUsed)} used of ${fmtBytes(system.memory.total)}`}
        detail={`${fmtBytes(system.memory.free)} free`}
      />
    </div>
  );
}

function SystemBar({ label, pct, primary, detail }: {
  label: string; pct: number; primary: string; detail?: string;
}) {
  const color = pct > 0.85 ? COLORS.worker : pct > 0.65 ? COLORS.speed : COLORS.direct;
  return (
    <div className="systemBar">
      <div className="systemBarHeader">
        <span>{label}</span>
        <strong>{primary}</strong>
      </div>
      <div className="systemBarTrack">
        <div className="systemBarFill" style={{ width: `${Math.round(pct * 100)}%`, background: color }} />
      </div>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Metric({ icon, label, value, detail, iconBg, iconColor }: {
  icon: React.ReactNode; label: string; value: string; detail: string;
  iconBg?: string; iconColor?: string;
}) {
  return (
    <article className="metric">
      <div className="metricIcon" style={iconBg ? { background: iconBg, color: iconColor } : undefined}>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Score({ label, value, color = COLORS.primary }: { label: string; value: number; color?: string }) {
  return (
    <div className="score" style={{ borderLeftColor: color, borderLeftWidth: 3, borderLeftStyle: "solid" }}>
      <span>{label}</span>
      <strong style={{ color }}>{pct(value)}</strong>
      <div><i style={{ width: `${Math.round(value * 100)}%`, background: color }} /></div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="metaItem">
      <span>{label}</span>
      <strong>{value || "n/a"}</strong>
    </div>
  );
}

function AgentRole({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <article className="agentRole">
      <div>{icon}<strong>{title}</strong></div>
      <p>{text}</p>
    </article>
  );
}

function SpecialtyModelPanel({ model }: { model: UtilityModel }) {
  const capability = model.metadata.capabilities?.join(", ") || model.specialty.category;
  return (
    <>
      <header className="modelHeader">
        <div>
          <h2>
            {model.model}
            {model.archived && <em className="archivedBadge">archived</em>}
          </h2>
          <p>{model.specialty.recommendation}</p>
        </div>
      </header>

      <div className="specialtyMetricGrid">
        <Metric icon={<Search />} label="Category" value={model.specialty.category} detail={model.specialty.role} iconBg="#f2e5ee" iconColor="#8b4f71" />
        <Metric icon={<DatabaseIcon />} label="Benchmark family" value="Specialty" detail={model.specialty.testFamily} iconBg="#e4efe8" iconColor={COLORS.direct} />
        <Metric icon={<Tag />} label="Model size" value={model.size || "n/a"} detail={capability} iconBg="#dce8f0" iconColor={COLORS.orchestrator} />
      </div>

      <section className="band">
        <h3><Tag size={18} /> Ollama Model Metadata</h3>
        <div className="metadataGrid">
          <Meta label="Capabilities" value={capability} />
          <Meta label="Architecture" value={model.metadata.architecture || ""} />
          <Meta label="Parameters" value={model.metadata.parameters || ""} />
          <Meta label="Quantization" value={model.metadata.quantization || ""} />
          <Meta label="Context" value={model.metadata.contextLength || ""} />
          <Meta label="Embedding length" value={model.metadata.embeddingLength || ""} />
        </div>
      </section>

      <section className="band">
        <h3><Workflow size={18} /> Suitable Evaluation Surface</h3>
        <div className="agentGrid">
          <AgentRole icon={<Search />} title="Retrieval" text="Evaluate query-to-document recall, hard-negative separation, and semantic similarity rather than chat quality." />
          <AgentRole icon={<Layers3 />} title="Indexing" text="Measure chunk embedding throughput, dimensionality, context limits, and storage cost for local RAG pipelines." />
          <AgentRole icon={<ShieldCheck />} title="Grounding" text="Pair with a generative model and score whether retrieved evidence improves final answers." />
          <AgentRole icon={<Network />} title="Pipeline role" text="Use as infrastructure in an agent topology: retrieve candidates, then hand off to a worker or critic model." />
        </div>
      </section>
    </>
  );
}

function recommendation(model: ModelSummary, profile: ProfileId) {
  const prefix =
    profile === "cuda_multi_lab" ? "In a multi-GPU lab topology, " :
    profile === "cuda_single_workstation" ? "On a single-GPU workstation, " :
    profile === "cpu_only" ? "On CPU-only inference, " :
    profile === "apple_silicon_compact" ? "On compact Apple Silicon, " :
    "";
  if (model.orchestratorScore >= 0.85) return `${prefix}strong candidate for orchestrator and deliberate planning work.`;
  if (model.workerScore >= 0.85) return `${prefix}best treated as a responsive worker or fast direct-mode agent.`;
  if (model.deliberateMs > 30000) return `${prefix}useful in direct mode, but deliberate planning has a high latency cost.`;
  return "Best used selectively for narrow sub-agent tasks and checked by a stronger critic.";
}

function orchestratorText(model: ModelSummary, profile: ProfileId) {
  if (model.orchestratorScore < 0.8) return "Use only for shallow routing unless paired with a stronger critic or planner.";
  if (profile === "cuda_multi_lab") return "Use as the planner for multi-lane decomposition, handoffs, retries, critic routing, and final synthesis.";
  if (profile === "cuda_single_workstation") return "Use as the planner for decomposition and handoffs, but keep deliberate calls focused so workers can share the GPU.";
  if (profile === "cpu_only") return "Use sparingly as a sequential planner; avoid broad autonomous loops.";
  return "Use as the planner for compact decomposition, handoffs, retries, and final synthesis.";
}

function workerText(model: ModelSummary, profile: ProfileId) {
  if (model.workerScore < 0.8) return "Assign narrow tasks with clear outputs; avoid broad autonomy.";
  if (profile === "cuda_multi_lab") return "Good fit for parallel extraction, summarization, formatting, coding, and batch sub-agent lanes.";
  if (profile === "cuda_single_workstation") return "Good fit for repeated worker calls, with fanout bounded by host calibration and measured GPU contention.";
  if (profile === "cpu_only") return "Good fit for sequential extraction and formatting; keep calls short.";
  return "Good fit for extraction, summarization, formatting, short coding tasks, and compact repeated sub-agent calls.";
}

function criticText(model: ModelSummary, profile: ProfileId) {
  return model.deliberateQuality >= 0.7
    ? profile === "cuda_multi_lab"
      ? "Use as a dedicated review lane for plan critique, retry gates, and escalation decisions."
      : "Can review plans and catch role mismatches when deliberate mode latency is acceptable."
    : "Use a different model for verification when correctness matters.";
}

function a2aText(model: ModelSummary, profile: ProfileId) {
  if (model.maxRecommendedAgents >= 3) {
    if (profile === "cuda_multi_lab") return "Can support broader same-model fanout within the calibrated host limit; validate cross-GPU placement, memory pressure, and queueing.";
    if (profile === "cuda_single_workstation") return "Can support moderate same-model fanout within the calibrated host limit; monitor GPU memory and queueing.";
    return "Can support a small same-model fanout; still monitor memory and queueing.";
  }
  if (profile === "cpu_only") return "Prefer sequential handoffs; parallelism is a latency and resource risk.";
  return "Prefer sequential handoffs or mixed-model teams with limited parallelism.";
}

createRoot(document.getElementById("root")!).render(<App />);
