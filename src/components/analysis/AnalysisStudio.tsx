import React, { useState, useEffect } from "react";
import {
  FileText,
  CheckCircle2,
  AlertTriangle,
  Calendar,
  DollarSign,
  ShieldAlert,
  Sparkles,
  Download,
  RefreshCw,
  FileSearch,
  CheckSquare,
  ListChecks,
  BarChart3,
  Briefcase,
  Eye,
  X,
  Lock,
  ShieldCheck,
  Award,
  FileSpreadsheet,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  ParsedDocumentData,
  FullDocumentAnalysis,
  UserProfile,
  EvidenceDocument,
  AIModelCatalogueItem,
  SourceLocation,
} from "../../types";
import {
  getAvailableAiModels,
  getSelectedAiModel,
  setSelectedAiModel,
  enhanceWithAi,
  mergeAiIntoAnalysis,
  generateChartInsights,
} from "../../services/aiProvider";
import { compareRequirementsWithEvidence } from "../../services/comparisonEngine";
import {
  exportAnalysisAsMarkdown,
  exportRequirementsAsCsv,
  exportAnalysisAsJson,
  exportAnalysisAsPrintableHtml,
  downloadFile,
} from "../../services/exportService";
import { RfpIntelligenceView } from "./RfpIntelligenceView";
import { SpreadsheetView } from "./SpreadsheetView";
import { FraudSignalsView } from "./FraudSignalsView";
import { DocumentQaPanel } from "./DocumentQaPanel";

interface AnalysisStudioProps {
  document: ParsedDocumentData;
  analysis: FullDocumentAnalysis;
  profile: UserProfile | null;
  evidenceDocs: EvidenceDocument[];
  onUpdateAnalysis: (updated: FullDocumentAnalysis) => void;
  onOpenRedactionModal: () => void;
  onBack: () => void;
}

type StudioTab =
  | "overview"
  | "rfp_command"
  | "spreadsheet"
  | "requirements"
  | "dates"
  | "financials"
  | "authenticity"
  | "risks"
  | "readiness"
  | "charts"
  | "source";

const CHART_COLORS = ["#D4AF37", "#E5E4E2", "#10B981", "#F59E0B", "#EF4444", "#6366F1"];

export const AnalysisStudio: React.FC<AnalysisStudioProps> = ({
  document,
  analysis,
  profile,
  evidenceDocs,
  onUpdateAnalysis,
  onOpenRedactionModal,
  onBack,
}) => {
  const [activeTab, setActiveTab] = useState<StudioTab>(
    document.spreadsheetData
      ? "spreadsheet"
      : analysis.rfpIntelligence
      ? "rfp_command"
      : "overview"
  );

  // AI Model & Enhancement State
  const [models, setModels] = useState<AIModelCatalogueItem[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(getSelectedAiModel());
  const [isAiRunning, setIsAiRunning] = useState(false);
  const [aiStageMessage, setAiStageMessage] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Requirement classification filter
  const [reqFilter, setReqFilter] = useState<string>("ALL");

  // Source Modal State
  const [sourceModalPage, setSourceModalPage] = useState<number | null>(null);
  const [sourceModalSnippet, setSourceModalSnippet] = useState<string | undefined>(undefined);
  const [selectedReaderPage, setSelectedReaderPage] = useState<number>(1);

  // Charts AI Insight state
  const [chartAiInsight, setChartAiInsight] = useState<string | null>(null);
  const [isGeneratingChartInsight, setIsGeneratingChartInsight] = useState(false);

  const pageCount = Math.max(1, document.pages.length);

  useEffect(() => {
    getAvailableAiModels().then((list) => {
      setModels(list);
    });
  }, []);

  const handleModelSelectChange = (newModelId: string) => {
    setSelectedModel(newModelId);
    setSelectedAiModel(newModelId);
  };

  const handleRunAiEnhancement = async () => {
    setIsAiRunning(true);
    setAiError(null);
    setAiStageMessage("Stage 1/3: Building multi-section document chunks & redacting sensitive items...");

    try {
      const aiResponse = await enhanceWithAi(
        document.redactedText || document.fullText,
        document.fileName,
        analysis.category,
        selectedModel,
        (stage) => setAiStageMessage(stage)
      );

      setAiStageMessage("Stage 3/3: Performing deterministic quote verification against source pages...");
      const merged = mergeAiIntoAnalysis(analysis, aiResponse);
      const compared = compareRequirementsWithEvidence(merged, profile, evidenceDocs);

      onUpdateAnalysis(compared);
      setAiStageMessage(null);
    } catch (err: any) {
      setAiError(err.message || "AI enhancement failed. Deterministic analysis remains intact.");
      setAiStageMessage(null);
    } finally {
      setIsAiRunning(false);
    }
  };

  const handleOpenSourceModal = (sourceOrPage: SourceLocation | number, snippetArg?: string) => {
    const rawPage =
      typeof sourceOrPage === "number" ? sourceOrPage : sourceOrPage.page || 1;
    const rawSnippet =
      typeof sourceOrPage === "number" ? snippetArg : sourceOrPage.snippet;
    const validPage = Math.max(1, Math.min(rawPage, pageCount));
    setSourceModalPage(validPage);
    setSourceModalSnippet(rawSnippet);
  };

  const handleGenerateChartAiInsight = async () => {
    setIsGeneratingChartInsight(true);
    try {
      const summary = JSON.stringify({
        category: analysis.category,
        requirementsCount: analysis.requirements.length,
        mandatoryCount: analysis.requirements.filter((r) => r.mandatory).length,
        datesCount: analysis.importantDates.length,
        financialItems: analysis.financialInformation.map((f) => ({
          label: f.label,
          amount: f.amountText,
          category: f.detailedCategory,
        })),
        readiness: analysis.readinessScore,
      });
      const insight = await generateChartInsights(summary, selectedModel);
      setChartAiInsight(insight.insightSummary);
    } catch (e: any) {
      setChartAiInsight(`Unable to generate AI chart synthesis: ${e.message}`);
    } finally {
      setIsGeneratingChartInsight(false);
    }
  };

  // Filtered requirements
  const filteredRequirements = analysis.requirements.filter((req) => {
    if (reqFilter === "ALL") return true;
    if (reqFilter === "MANDATORY") return req.mandatory;
    return req.classification === reqFilter;
  });

  // Chart data preparation
  const reqByClassData = [
    {
      name: "Mandatory",
      count: analysis.requirements.filter((r) => r.classification === "Mandatory" || r.mandatory).length,
    },
    {
      name: "Conditional",
      count: analysis.requirements.filter((r) => r.classification === "Conditional").length,
    },
    {
      name: "Recommended",
      count: analysis.requirements.filter((r) => r.classification === "Recommended").length,
    },
    {
      name: "Informational",
      count: analysis.requirements.filter((r) => r.classification === "Informational").length,
    },
  ].filter((d) => d.count > 0);

  const financialChartData = analysis.financialInformation
    .filter((f) => typeof f.numericValue === "number" && f.numericValue > 0)
    .slice(0, 8)
    .map((f, idx) => ({
      name: f.label.length > 22 ? f.label.slice(0, 20) + "…" : f.label || `Item ${idx + 1}`,
      value: f.numericValue || 0,
      raw: f.amountText,
      category: f.detailedCategory || f.type,
    }));

  const readinessBreakdown = analysis.readinessScore || {
    score: 0,
    foundCount: 0,
    totalMandatoryCount: 0,
    missingCount: 0,
    needsVerificationCount: 0,
    extractionCompletenessScore: document.extractionQualityScore || 100,
    analysisCompletenessScore: 100,
    evidenceFitScore: 0,
    formulaExplanation: "No mandatory requirements evaluated.",
  };

  const fraudLabel = analysis.fraudAnalysis?.overallLabel || "No warning detected";
  const fraudBadgeStyle =
    fraudLabel === "Strong warning signal"
      ? "bg-red-500/15 text-red-300 border-red-500/40"
      : fraudLabel === "Potentially suspicious"
      ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
      : fraudLabel === "Needs verification" || fraudLabel === "Low concern"
      ? "bg-yellow-500/15 text-yellow-200 border-yellow-500/40"
      : "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";

  const activeSourcePageObj =
    document.pages.find((p) => p.pageNumber === selectedReaderPage) || document.pages[0];

  const modalPageObj =
    sourceModalPage !== null
      ? document.pages.find((p) => p.pageNumber === sourceModalPage) || document.pages[0]
      : null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Incomplete Restored Analysis Warning Banner */}
      {document.isRestoredWithoutSource && (
        <div className="p-4 rounded-xl bg-amber-950/60 border border-amber-500/40 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200 leading-relaxed">
            <span className="font-bold text-amber-300 uppercase tracking-wider block mb-0.5">
              Restored Historical Analysis Snapshot (Original Binary Not Attached)
            </span>
            This analysis record was restored from saved history without the original uploaded binary file in local memory.
            Structured intelligence is displayed as saved, but full page-by-page source text verification and fresh OCR re-scanning require re-uploading the original document.
          </div>
        </div>
      )}

      {/* Top Executive Command Bar */}
      <div className="rounded-2xl bg-[#141418] border border-[#D4AF37]/30 p-6 shadow-2xl space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={onBack}
                className="text-xs font-medium text-slate-400 hover:text-[#D4AF37] transition-colors mr-2"
              >
                ← Back to Workspace
              </button>
              <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30">
                {analysis.category}
              </span>
              <span className="px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-white/5 text-slate-300 border border-white/10">
                {pageCount} {pageCount === 1 ? "Page" : "Pages"} • {document.parserEngineUsed}
              </span>
              <span
                onClick={() => setActiveTab("authenticity")}
                className={`cursor-pointer px-2.5 py-0.5 rounded-md text-[11px] font-semibold border flex items-center gap-1.5 ${fraudBadgeStyle}`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                {fraudLabel}
              </span>
              {document.isDemo && (
                <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                  Demo Fixture
                </span>
              )}
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              {analysis.title || document.fileName}
            </h1>
            <p className="text-xs text-slate-400">
              File: <span className="text-slate-300 font-mono">{document.fileName}</span> • Extraction Quality:{" "}
              <span className="text-[#D4AF37] font-semibold">{document.extractionQualityScore}%</span> • Mode:{" "}
              <span className="text-slate-200">{analysis.processingMode === "ai_assisted" ? `AI Assisted (${analysis.modelUsed || "Model"})` : "Deterministic"}</span>
            </p>
          </div>

          {/* Actions & AI Model Controls */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center bg-[#0B0B0E] border border-white/15 rounded-xl px-2.5 py-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#D4AF37] mr-2 shrink-0" />
              <select
                value={selectedModel}
                onChange={(e) => handleModelSelectChange(e.target.value)}
                disabled={isAiRunning}
                className="bg-transparent text-xs text-slate-200 focus:outline-none max-w-[200px] truncate"
                title="Select AI Model (Persisted across sessions)"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id} className="bg-[#141418] text-slate-200">
                    {m.name} {m.pricingStatus === "verified_free" ? "(Verified Free)" : m.isFree ? "(Free)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleRunAiEnhancement}
              disabled={isAiRunning}
              className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-[#D4AF37] to-[#AA7C11] text-black font-bold text-xs flex items-center gap-1.5 hover:brightness-110 disabled:opacity-50 transition-all shadow-lg shadow-[#D4AF37]/10"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isAiRunning ? "animate-spin" : ""}`} />
              {isAiRunning ? "Enhancing..." : "Deep AI Enhance"}
            </button>

            <button
              onClick={onOpenRedactionModal}
              className="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              <Lock className="w-3.5 h-3.5 text-[#D4AF37]" />
              Privacy ({document.sensitiveDetections.length})
            </button>

            <div className="relative group">
              <button className="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 text-xs font-medium flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5 text-slate-300" />
                Export
              </button>
              <div className="absolute right-0 mt-1 w-44 rounded-xl bg-[#18181D] border border-white/15 shadow-2xl py-1.5 hidden group-hover:block z-30">
                <button
                  onClick={() => {
                    const md = exportAnalysisAsMarkdown(analysis);
                    downloadFile(md, `${analysis.title || "report"}.md`, "text/markdown;charset=utf-8;");
                  }}
                  className="w-full text-left px-3.5 py-2 text-xs text-slate-200 hover:bg-white/5"
                >
                  Export Markdown (.md)
                </button>
                <button
                  onClick={() => exportRequirementsAsCsv(analysis)}
                  className="w-full text-left px-3.5 py-2 text-xs text-slate-200 hover:bg-white/5"
                >
                  Export Requirements (.csv)
                </button>
                <button
                  onClick={() => exportAnalysisAsJson(analysis)}
                  className="w-full text-left px-3.5 py-2 text-xs text-slate-200 hover:bg-white/5"
                >
                  Export Full JSON (.json)
                </button>
                <button
                  onClick={() => exportAnalysisAsPrintableHtml(analysis)}
                  className="w-full text-left px-3.5 py-2 text-xs text-slate-200 hover:bg-white/5"
                >
                  Export Printable HTML
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Live AI Stage Progress / Warning Bar */}
        {aiStageMessage && (
          <div className="p-3 rounded-xl bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center gap-3 text-xs text-[#F3E5AB]">
            <RefreshCw className="w-4 h-4 animate-spin text-[#D4AF37] shrink-0" />
            <span>{aiStageMessage}</span>
          </div>
        )}
        {aiError && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-between gap-3 text-xs text-red-300">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{aiError}</span>
            </div>
            <button onClick={() => setAiError(null)} className="text-red-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 4-Card Key Intelligence Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 pt-2">
          {/* Primary Submission Deadline */}
          <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span className="uppercase tracking-wider font-semibold text-[10px] text-[#D4AF37]">
                Primary Submission Deadline
              </span>
              <Calendar className="w-4 h-4 text-[#D4AF37]" />
            </div>
            {analysis.primaryDeadline ? (
              <div>
                <div className="text-base font-bold text-white">
                  {analysis.primaryDeadline.rawText}
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5 flex items-center justify-between">
                  <span className="truncate">{analysis.primaryDeadline.label}</span>
                  <span className="text-[#D4AF37] font-mono ml-2">
                    p.{analysis.primaryDeadline.page || 1}
                  </span>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm font-semibold text-slate-400">
                  No Explicit Deadline Found
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {analysis.importantDates.length} total date reference(s) extracted
                </div>
              </div>
            )}
          </div>

          {/* 3-Metric Readiness & Completeness */}
          <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span className="uppercase tracking-wider font-semibold text-[10px] text-emerald-400">
                Readiness & Extraction Metrics
              </span>
              <Award className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center my-0.5">
              <div className="bg-white/[0.03] rounded-lg p-1.5 border border-white/5">
                <div className="text-sm font-bold text-white">
                  {readinessBreakdown.extractionCompletenessScore ?? document.extractionQualityScore}%
                </div>
                <div className="text-[9px] text-slate-400 uppercase">Extraction</div>
              </div>
              <div className="bg-white/[0.03] rounded-lg p-1.5 border border-white/5">
                <div className="text-sm font-bold text-[#D4AF37]">
                  {readinessBreakdown.analysisCompletenessScore ?? 100}%
                </div>
                <div className="text-[9px] text-slate-400 uppercase">Coverage</div>
              </div>
              <div className="bg-white/[0.03] rounded-lg p-1.5 border border-white/5">
                <div className="text-sm font-bold text-emerald-400">
                  {readinessBreakdown.evidenceFitScore ?? readinessBreakdown.score}%
                </div>
                <div className="text-[9px] text-slate-400 uppercase">Vault Fit</div>
              </div>
            </div>
          </div>

          {/* Mandatory Requirements Count */}
          <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span className="uppercase tracking-wider font-semibold text-[10px] text-sky-400">
                Verified Requirements
              </span>
              <ListChecks className="w-4 h-4 text-sky-400" />
            </div>
            <div>
              <div className="text-base font-bold text-white">
                {analysis.requirements.filter((r) => r.mandatory).length} Mandatory{" "}
                <span className="text-xs font-normal text-slate-400">
                  / {analysis.requirements.length} Total
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {readinessBreakdown.foundCount} matched in Evidence Vault •{" "}
                {readinessBreakdown.missingCount} missing
              </div>
            </div>
          </div>

          {/* Authenticity & Fraud Signal Status */}
          <div
            onClick={() => setActiveTab("authenticity")}
            className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 hover:border-[#D4AF37]/40 cursor-pointer transition-all flex flex-col justify-between"
          >
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span className="uppercase tracking-wider font-semibold text-[10px] text-amber-300">
                File Authenticity & Fraud Signals
              </span>
              <ShieldAlert className="w-4 h-4 text-amber-300" />
            </div>
            <div>
              <div className="text-sm font-bold text-white truncate">{fraudLabel}</div>
              <div className="text-[11px] text-slate-400 mt-0.5 flex items-center justify-between">
                <span>Risk Score: {analysis.fraudAnalysis?.riskScore ?? 0}/100</span>
                <span className="text-[#D4AF37] underline">Inspect Signals →</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2 border-b border-white/10">
        {[
          { id: "overview", label: "Executive Overview", icon: FileText },
          ...(analysis.rfpIntelligence
            ? [{ id: "rfp_command", label: "RFP Command Center", icon: Briefcase }]
            : []),
          ...(document.spreadsheetData
            ? [{ id: "spreadsheet", label: "Spreadsheet Intelligence", icon: FileSpreadsheet }]
            : []),
          {
            id: "requirements",
            label: `Requirements (${analysis.requirements.length})`,
            icon: CheckSquare,
          },
          {
            id: "dates",
            label: `Dates & Deadlines (${analysis.importantDates.length})`,
            icon: Calendar,
          },
          {
            id: "financials",
            label: `Financials (${analysis.financialInformation.length})`,
            icon: DollarSign,
          },
          {
            id: "authenticity",
            label: "File Authenticity & Fraud Signals",
            icon: ShieldCheck,
          },
          {
            id: "risks",
            label: `Risks & Warnings (${analysis.risksAndWarnings.length})`,
            icon: AlertTriangle,
          },
          { id: "readiness", label: "Vault Readiness & Action Plan", icon: Award },
          { id: "charts", label: "Visual Analytics", icon: BarChart3 },
          { id: "source", label: `Source Reader (${pageCount}p)`, icon: Eye },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as StudioTab)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap flex items-center gap-2 transition-all ${
                isActive
                  ? "bg-[#D4AF37] text-black shadow-md shadow-[#D4AF37]/20"
                  : "bg-[#141418] text-slate-300 hover:bg-white/10 border border-white/5"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Main Content + Right Q&A Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 space-y-6">
          {/* TAB: EXECUTIVE OVERVIEW */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-4">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <FileText className="w-5 h-5 text-[#D4AF37]" />
                  Plain-English Executive Summary
                </h2>
                <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">
                  {analysis.executiveSummary}
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-white/10 text-xs">
                  <div>
                    <span className="text-slate-400 block mb-1">Issuing Authority / Organisation:</span>
                    <p className="text-slate-200 font-medium">{analysis.keyInfo.issuingOrganisation}</p>
                  </div>
                  <div>
                    <span className="text-slate-400 block mb-1">Reference Number & Primary Contact:</span>
                    <p className="text-slate-200 font-medium">
                      {analysis.keyInfo.referenceNumber || "Not stated"} • {analysis.keyInfo.primaryContact || "Not stated"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Extraction Audit & Coverage Transparency */}
              {analysis.extractionAudit && (
                <div className="rounded-2xl bg-[#141418] border border-white/10 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <FileSearch className="w-4 h-4 text-[#D4AF37]" />
                      Page Extraction Coverage & Parser Audit
                    </h3>
                    <span className="text-xs text-slate-400">
                      {analysis.extractionAudit.pagesWithUsableText} / {analysis.extractionAudit.expectedPageCount} pages with usable text
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-[#0B0B0E] border border-white/5">
                      <div className="text-slate-400">Parser Engine</div>
                      <div className="text-white font-semibold mt-0.5">{analysis.extractionAudit.parserName}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0B0E] border border-white/5">
                      <div className="text-slate-400">Total Words</div>
                      <div className="text-white font-semibold mt-0.5">{document.wordCount.toLocaleString()}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0B0E] border border-white/5">
                      <div className="text-slate-400">Tables Reconstructed</div>
                      <div className="text-white font-semibold mt-0.5">{document.tableCount}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0B0E] border border-white/5">
                      <div className="text-slate-400">OCR Recovery</div>
                      <div className="text-white font-semibold mt-0.5">
                        {analysis.extractionAudit.isScanned
                          ? `${analysis.extractionAudit.ocrPages} page(s)`
                          : "Not Needed (Digital Text)"}
                      </div>
                    </div>
                  </div>
                  {document.extractionWarnings && document.extractionWarnings.length > 0 && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 space-y-1">
                      {document.extractionWarnings.map((w: string, i: number) => (
                        <div key={i}>• {w}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Top Priority Next Best Actions */}
              <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-4">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-[#D4AF37]" />
                  Prioritized Action Plan
                </h3>
                {analysis.actionPlan.length === 0 ? (
                  <p className="text-xs text-slate-400">No specific action items extracted from this document.</p>
                ) : (
                  <div className="space-y-2.5">
                    {analysis.actionPlan.map((act, idx) => (
                      <div
                        key={act.id || idx}
                        className="p-3.5 rounded-xl bg-[#0B0B0E] border border-white/10 flex items-start justify-between gap-4"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                act.priority === "high"
                                  ? "bg-red-500/20 text-red-300 border border-red-500/30"
                                  : act.priority === "medium"
                                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                  : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                              }`}
                            >
                              {act.priority} Priority
                            </span>
                            <span className="text-sm font-semibold text-white">{act.title}</span>
                          </div>
                          <p className="text-xs text-slate-300">{act.description}</p>
                        </div>
                        {act.sourceLocation?.page && (
                          <button
                            onClick={() => handleOpenSourceModal(act.sourceLocation!)}
                            className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] text-[#D4AF37] font-mono shrink-0"
                          >
                            p.{act.sourceLocation.page}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: RFP COMMAND CENTER */}
          {activeTab === "rfp_command" && analysis.rfpIntelligence && (
            <RfpIntelligenceView
              rfpData={analysis.rfpIntelligence}
              documentTitle={analysis.title || document.fileName}
              onOpenSourceModal={handleOpenSourceModal}
            />
          )}

          {/* TAB: SPREADSHEET INTELLIGENCE */}
          {activeTab === "spreadsheet" && document.spreadsheetData && (
            <SpreadsheetView data={document.spreadsheetData} />
          )}

          {/* TAB: REQUIREMENTS */}
          {activeTab === "requirements" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Extracted Requirements & Obligations ({filteredRequirements.length})
                  </h2>
                  <p className="text-xs text-slate-400">
                    Strictly grounded in document text. General advice and speculative checklist items are excluded.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: "ALL", label: "All" },
                    { id: "MANDATORY", label: "Mandatory Only" },
                    { id: "Conditional", label: "Conditional" },
                    { id: "Recommended", label: "Recommended" },
                    { id: "Informational", label: "Informational" },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setReqFilter(f.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                        reqFilter === f.id
                          ? "bg-[#D4AF37] text-black font-bold"
                          : "bg-[#0B0B0E] text-slate-300 hover:bg-white/5 border border-white/10"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {filteredRequirements.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400 bg-[#0B0B0E] rounded-xl border border-white/5">
                  No requirements match the selected classification filter in this document.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredRequirements.map((req) => (
                    <div
                      key={req.id}
                      className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 hover:border-[#D4AF37]/30 transition-all space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              req.mandatory
                                ? "bg-red-500/20 text-red-300 border border-red-500/30"
                                : "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                            }`}
                          >
                            {req.classification || (req.mandatory ? "Mandatory" : "Optional")}
                          </span>
                          {req.category && (
                            <span className="px-2 py-0.5 rounded text-[10px] bg-white/5 text-slate-300 border border-white/10">
                              {req.category}
                            </span>
                          )}
                          {req.verificationStatus && (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                req.verificationStatus === "FOUND"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-amber-500/15 text-amber-300"
                              }`}
                            >
                              {req.verificationStatus}
                            </span>
                          )}
                          {req.evidenceStatus && (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                req.evidenceStatus === "Found"
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : req.evidenceStatus === "Missing evidence"
                                  ? "bg-red-500/20 text-red-300"
                                  : "bg-amber-500/20 text-amber-300"
                              }`}
                            >
                              Vault: {req.evidenceStatus}
                            </span>
                          )}
                        </div>

                        <button
                          onClick={() => handleOpenSourceModal(req.sourceLocation)}
                          className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-[#D4AF37]/20 text-xs font-mono text-[#D4AF37] border border-[#D4AF37]/30"
                        >
                          Page {req.sourceLocation.page || 1}
                        </button>
                      </div>

                      <div className="text-sm font-bold text-white">{req.name}</div>
                      <p className="text-xs text-slate-300 leading-relaxed">{req.description}</p>
                      {req.sourceLocation.snippet && (
                        <div className="text-[11px] text-slate-400 italic bg-white/[0.02] p-2.5 rounded-lg border-l-2 border-[#D4AF37]/50">
                          “{req.sourceLocation.snippet}”
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: IMPORTANT DATES & DEADLINES */}
          {activeTab === "dates" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">
                  Dates, Milestones & Primary Submission Deadline ({analysis.importantDates.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Classified across 20 semantic event types with automatic past/upcoming status detection.
                </p>
              </div>

              {analysis.primaryDeadline && (
                <div className="p-4 rounded-xl bg-gradient-to-r from-[#D4AF37]/20 to-transparent border border-[#D4AF37]/50 flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#D4AF37]">
                      ★ Primary Submission / Closing Deadline
                    </div>
                    <div className="text-lg font-bold text-white">
                      {analysis.primaryDeadline.rawText} — {analysis.primaryDeadline.label}
                    </div>
                    <div className="text-xs text-slate-300">
                      Event Classification: <span className="font-mono">{analysis.primaryDeadline.eventType}</span> • Status:{" "}
                      <span className="font-semibold text-[#D4AF37]">{analysis.primaryDeadline.status}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleOpenSourceModal(analysis.primaryDeadline!.page || 1, analysis.primaryDeadline!.snippet)}
                    className="px-3 py-1.5 rounded-lg bg-[#D4AF37] text-black font-bold text-xs shrink-0"
                  >
                    Verify Page {analysis.primaryDeadline.page || 1}
                  </button>
                </div>
              )}

              {analysis.importantDates.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400 bg-[#0B0B0E] rounded-xl border border-white/5">
                  No explicit dates or deadlines were found in this document.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {analysis.importantDates.map((d) => (
                    <div
                      key={d.id}
                      className={`p-4 rounded-xl bg-[#0B0B0E] border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                        d.isPrimaryDeadline ? "border-[#D4AF37]/60" : "border-white/10"
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-white">{d.rawText}</span>
                          {d.isoDate && (
                            <span className="text-[11px] font-mono text-slate-400">({d.isoDate})</span>
                          )}
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30">
                            {d.eventType || d.type}
                          </span>
                          {d.status && (
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                d.status === "Passed" || d.status === "Historical"
                                  ? "bg-slate-700/60 text-slate-300"
                                  : d.status === "Due today"
                                  ? "bg-red-500/20 text-red-300"
                                  : "bg-emerald-500/20 text-emerald-300"
                              }`}
                            >
                              {d.status}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-200 font-medium">{d.label}</div>
                        {d.sourceLocation.snippet && (
                          <div className="text-[11px] text-slate-400 italic">
                            “{d.sourceLocation.snippet}”
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => handleOpenSourceModal(d.sourceLocation)}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-[#D4AF37] shrink-0 self-start sm:self-center"
                      >
                        p.{d.sourceLocation.page || 1}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: FINANCIAL INFORMATION */}
          {activeTab === "financials" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">
                  Financial Amounts, Stipends, Fees & Thresholds ({analysis.financialInformation.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Categorized across 22 semantic financial types with multi-currency and Indian Lakh/Crore normalization.
                </p>
              </div>

              {analysis.financialInformation.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400 bg-[#0B0B0E] rounded-xl border border-white/5">
                  No monetary amounts, fees, or financial figures were detected in this document.
                </div>
              ) : (
                <div className="space-y-3">
                  {analysis.financialInformation.map((fin) => (
                    <div
                      key={fin.id}
                      className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-bold text-[#D4AF37]">{fin.amountText}</span>
                          {fin.numericValue !== undefined && (
                            <span className="text-xs font-mono text-slate-400">
                              ({fin.currency || ""} {fin.numericValue.toLocaleString()})
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            {fin.detailedCategory || fin.type}
                          </span>
                          {fin.associatedProgrammeOrEntity && (
                            <span className="px-2 py-0.5 rounded text-[10px] bg-white/5 text-slate-300 border border-white/10">
                              Entity/Tier: {fin.associatedProgrammeOrEntity}
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-semibold text-white">{fin.label}</div>
                        {fin.sourceLocation.snippet && (
                          <div className="text-[11px] text-slate-400 italic">
                            “{fin.sourceLocation.snippet}”
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => handleOpenSourceModal(fin.sourceLocation)}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-[#D4AF37] shrink-0 self-start sm:self-center"
                      >
                        p.{fin.sourceLocation.page || 1}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: FILE AUTHENTICITY & FRAUD SIGNALS */}
          {activeTab === "authenticity" && analysis.fraudAnalysis && (
            <FraudSignalsView
              report={analysis.fraudAnalysis}
              onOpenSourceModal={handleOpenSourceModal}
            />
          )}

          {/* TAB: RISKS & WARNINGS */}
          {activeTab === "risks" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">
                  Contractual, Compliance & Operational Risk Signals ({analysis.risksAndWarnings.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Grounded in explicit penalty, disqualification, liability, or exclusion clauses in the document.
                </p>
              </div>

              {analysis.risksAndWarnings.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400 bg-[#0B0B0E] rounded-xl border border-white/5">
                  No specific contractual penalties or high-risk clauses were flagged in this document.
                </div>
              ) : (
                <div className="space-y-3">
                  {analysis.risksAndWarnings.map((rk) => (
                    <div
                      key={rk.id}
                      className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              rk.severity === "high" || rk.severity === "critical"
                                ? "bg-red-500/20 text-red-300 border border-red-500/30"
                                : rk.severity === "medium"
                                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                : "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                            }`}
                          >
                            {rk.severity} Severity
                          </span>
                          <span className="text-sm font-bold text-white">{rk.title}</span>
                        </div>
                        <button
                          onClick={() => handleOpenSourceModal(rk.sourceLocation)}
                          className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-[#D4AF37]"
                        >
                          p.{rk.sourceLocation.page || 1}
                        </button>
                      </div>
                      <p className="text-xs text-slate-300">{rk.description}</p>
                      <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2.5">
                        <span className="font-bold">Recommended Mitigation: </span>
                        {rk.recommendedAction}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: VAULT READINESS & 3-METRIC BREAKDOWN */}
          {activeTab === "readiness" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-6">
              <div>
                <h2 className="text-lg font-bold text-white">
                  3-Dimension Readiness & Evidence Vault Comparison
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {readinessBreakdown.formulaExplanation}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10">
                  <div className="text-xs text-slate-400">1. Extraction Completeness</div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {readinessBreakdown.extractionCompletenessScore ?? document.extractionQualityScore}%
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Measures page text recovery, OCR coverage, and parser confidence.
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10">
                  <div className="text-xs text-slate-400">2. Analysis Completeness</div>
                  <div className="text-2xl font-bold text-[#D4AF37] mt-1">
                    {readinessBreakdown.analysisCompletenessScore ?? 100}%
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Measures structured extraction across dates, financials, requirements, and source citations.
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10">
                  <div className="text-xs text-slate-400">3. Applicant / Bidder Evidence Fit</div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1">
                    {readinessBreakdown.evidenceFitScore ?? readinessBreakdown.score}%
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    {readinessBreakdown.foundCount} of {readinessBreakdown.totalMandatoryCount} mandatory requirements verified in your Evidence Vault.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB: VISUAL ANALYTICS */}
          {activeTab === "charts" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white">Document Intelligence Charts</h2>
                  <p className="text-xs text-slate-400">
                    Visual breakdown of extracted requirements and financial figures.
                  </p>
                </div>
                <button
                  onClick={handleGenerateChartAiInsight}
                  disabled={isGeneratingChartInsight}
                  className="px-3 py-1.5 rounded-xl bg-[#D4AF37]/20 hover:bg-[#D4AF37]/30 text-[#D4AF37] border border-[#D4AF37]/40 text-xs font-semibold flex items-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {isGeneratingChartInsight ? "Synthesizing..." : "AI Chart Commentary"}
                </button>
              </div>

              {chartAiInsight && (
                <div className="p-4 rounded-xl bg-[#0B0B0E] border border-[#D4AF37]/30 text-xs text-slate-200 leading-relaxed whitespace-pre-line">
                  {chartAiInsight}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 h-72 flex flex-col">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                    Requirements by Classification
                  </h3>
                  {reqByClassData.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
                      No requirement classification data available
                    </div>
                  ) : (
                    <div className="flex-1">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={reqByClassData}
                            dataKey="count"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            outerRadius={75}
                            label
                          >
                            {reqByClassData.map((_, i) => (
                              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "#141418",
                              borderColor: "rgba(255,255,255,0.1)",
                              fontSize: "12px",
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 h-72 flex flex-col">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                    Extracted Financial Figures
                  </h3>
                  {financialChartData.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
                      No numeric financial figures extracted
                    </div>
                  ) : (
                    <div className="flex-1">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={financialChartData}>
                          <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 10 }} />
                          <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "#141418",
                              borderColor: "rgba(255,255,255,0.1)",
                              fontSize: "12px",
                            }}
                          />
                          <Bar dataKey="value" fill="#D4AF37" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB: SOURCE READER */}
          {activeTab === "source" && (
            <div className="rounded-2xl bg-[#141418] border border-white/10 p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Page-by-Page Extracted Source Reader
                  </h2>
                  <p className="text-xs text-slate-400">
                    Inspect exact extracted text and reconstructed tables for each page.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Page:</span>
                  <select
                    value={selectedReaderPage}
                    onChange={(e) => setSelectedReaderPage(Number(e.target.value))}
                    className="bg-[#0B0B0E] border border-white/15 rounded-lg px-2.5 py-1 text-xs text-white"
                  >
                    {document.pages.map((p) => (
                      <option key={p.pageNumber} value={p.pageNumber}>
                        Page {p.pageNumber} ({p.isOcr ? "OCR" : "Digital"})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {activeSourcePageObj ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-[#0B0B0E] border border-white/10 font-mono text-xs text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[540px] overflow-y-auto">
                    {activeSourcePageObj.text || "[Empty Page — No extractable text on this page]"}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-400">No source pages available.</div>
              )}
            </div>
          )}
        </div>

        {/* Right Grounded Document Q&A Panel */}
        <div className="lg:col-span-4 sticky top-20">
          <DocumentQaPanel
            doc={document}
            analysis={analysis}
            onOpenSourceModal={handleOpenSourceModal}
          />
        </div>
      </div>

      {/* Source Verification Modal */}
      {sourceModalPage !== null && modalPageObj && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#141418] border border-[#D4AF37]/40 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <FileSearch className="w-4 h-4 text-[#D4AF37]" />
                  Source Verification — Page {modalPageObj.pageNumber} of {pageCount}
                </h3>
                <p className="text-[11px] text-slate-400">
                  Extraction Mode: {modalPageObj.isOcr ? "OCR" : "Digital Text"} • Confidence:{" "}
                  {Math.round((modalPageObj.confidence || 0.98) * (modalPageObj.confidence && modalPageObj.confidence <= 1 ? 100 : 1))}%
                </p>
              </div>
              <button
                onClick={() => {
                  setSourceModalPage(null);
                  setSourceModalSnippet(undefined);
                }}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {sourceModalSnippet && (
              <div className="px-4 py-2.5 bg-[#D4AF37]/10 border-b border-[#D4AF37]/30 text-xs text-[#F3E5AB]">
                <span className="font-bold text-[#D4AF37] uppercase tracking-wider text-[10px] block">
                  Cited Snippet:
                </span>
                “{sourceModalSnippet}”
              </div>
            )}

            <div className="p-5 overflow-y-auto font-mono text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">
              {modalPageObj.text || "[No text on this page]"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
