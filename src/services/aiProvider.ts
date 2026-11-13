import {
  AIModelCatalogueItem,
  DocumentQAPair,
  FinancialItem,
  FullDocumentAnalysis,
  ImportantDateItem,
  RequirementItem,
  RiskWarningItem,
} from "../types";
import { getActiveSessionKey } from "./byokVault";

export interface AiAnalysisResponse {
  executiveSummary?: string;
  importantDates?: Array<{
    id?: string;
    label: string;
    date: string;
    type?: string;
    eventType?: string;
    urgency?: string;
    pageNumber?: number;
    sourceQuote: string;
  }>;
  financialInformation?: Array<{
    id?: string;
    description: string;
    amount: number;
    currency: string;
    type?: string;
    detailedCategory?: string;
    pageNumber?: number;
    sourceQuote: string;
  }>;
  requirements?: Array<{
    id?: string;
    title: string;
    description: string;
    category?: string;
    classification?: string;
    mandatory?: boolean;
    pageNumber?: number;
    sourceQuote: string;
  }>;
  risksAndGaps?: Array<{
    id?: string;
    title: string;
    description: string;
    severity?: string;
    recommendation?: string;
    pageNumber?: number;
    sourceQuote: string;
  }>;
  modelUsed?: string;
  chunksProcessed?: number;
  verifiedQuotesCount?: number;
}

const SELECTED_MODEL_STORAGE_KEY = "doculens_selected_ai_model";
const DEFAULT_AI_MODEL = "gemini-3.8-flash";

export function getSelectedAiModel(): string {
  try {
    const saved = localStorage.getItem(SELECTED_MODEL_STORAGE_KEY);
    if (saved && saved.trim().length > 0) {
      return saved.trim();
    }
  } catch {
    // Ignore storage errors in non-browser context
  }
  return DEFAULT_AI_MODEL;
}

export function setSelectedAiModel(modelId: string): void {
  try {
    if (modelId && modelId.trim().length > 0) {
      localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, modelId.trim());
    }
  } catch {
    // Ignore storage errors
  }
}

export const STATIC_FALLBACK_MODELS: AIModelCatalogueItem[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Primary Server AI)",
    provider: "gemini",
    contextLength: 1000000,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    pricingStatus: "verified_free",
    modalities: ["text", "json"],
    description: "High-speed structured document intelligence with 1M context window.",
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite (Fast Fallback)",
    provider: "gemini",
    contextLength: 1000000,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    pricingStatus: "verified_free",
    modalities: ["text", "json"],
    description: "Low-latency model for rapid Q&A and instant summaries.",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Llama 3.3 70B Instruct (Free Tier)",
    provider: "openrouter",
    contextLength: 128000,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    pricingStatus: "verified_free",
    modalities: ["text"],
    description: "Open-weights 70B reasoning model via OpenRouter Free Routing.",
  },
  {
    id: "qwen/qwen-2.5-72b-instruct:free",
    name: "Qwen 2.5 72B Instruct (Free Tier)",
    provider: "openrouter",
    contextLength: 128000,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    pricingStatus: "verified_free",
    modalities: ["text"],
    description: "Strong multilingual & tabular extraction model via OpenRouter.",
  },
  {
    id: "google/gemma-3-27b-it:free",
    name: "Gemma 3 27B IT (Free Tier)",
    provider: "openrouter",
    contextLength: 96000,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    isFree: true,
    pricingStatus: "verified_free",
    modalities: ["text"],
    description: "Compact instruction-tuned model for structured compliance tasks.",
  },
];

function getByokHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const sessionKey = getActiveSessionKey();
  if (sessionKey) {
    headers["x-byok-key"] = sessionKey.key;
    headers["x-byok-provider"] = sessionKey.provider;
  }
  return headers;
}

export async function getAvailableAiModels(
  freeOnly = false
): Promise<AIModelCatalogueItem[]> {
  try {
    const response = await fetch(`/api/ai/models?freeOnly=${freeOnly}`, {
      headers: getByokHeaders(),
    });
    if (!response.ok) return STATIC_FALLBACK_MODELS;
    const data = await response.json();
    if (Array.isArray(data.models) && data.models.length > 0) {
      return data.models.map((m: Record<string, unknown>) => ({
        id: String(m.id || ""),
        name: String(m.name || m.id || ""),
        provider: String(m.provider || "").toLowerCase().includes("gemini")
          ? "gemini"
          : "openrouter",
        contextLength: Number(m.contextLength) || 32000,
        promptPricePerMillion: Number(m.promptPrice ?? 0) * 1000000,
        completionPricePerMillion: Number(m.completionPrice ?? 0) * 1000000,
        isFree: Boolean(m.isFree && m.pricingStatus === "verified_free"),
        pricingStatus: (m.pricingStatus as AIModelCatalogueItem["pricingStatus"]) || "unknown",
        modalities: ["text"],
        description: String(m.description || ""),
      }));
    }
    return STATIC_FALLBACK_MODELS;
  } catch {
    return STATIC_FALLBACK_MODELS;
  }
}

export async function testAiConnection(
  modelId?: string
): Promise<{ ok: boolean; provider: string; modelUsed?: string; message: string }> {
  const targetModel = modelId || getSelectedAiModel();
  try {
    const response = await fetch("/api/ai/test-connection", {
      method: "POST",
      headers: getByokHeaders(),
      body: JSON.stringify({ modelId: targetModel }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        provider: data.provider || "Unknown",
        modelUsed: targetModel,
        message: data.error || `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      provider: data.provider || "Active AI Engine",
      modelUsed: data.modelUsed || targetModel,
      message: data.message || "Connection verified!",
    };
  } catch (err) {
    return {
      ok: false,
      provider: "Network",
      modelUsed: targetModel,
      message: err instanceof Error ? err.message : "Connection failed",
    };
  }
}

export async function enhanceWithAi(
  redactedText: string,
  fileName: string,
  category: string,
  modelId?: string,
  onProgress?: (stage: string) => void
): Promise<AiAnalysisResponse> {
  const selectedModel = modelId || getSelectedAiModel();
  if (onProgress) {
    onProgress(`Preparing redacted document chunks for ${selectedModel}...`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  try {
    if (onProgress) {
      onProgress(`Sending chunked analysis request to ${selectedModel}...`);
    }

    const response = await fetch("/api/ai/analyze", {
      method: "POST",
      headers: getByokHeaders(),
      body: JSON.stringify({
        redactedText,
        fileName,
        category,
        modelId: selectedModel,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        errorData.error || `AI analysis request failed with status ${response.status}`
      );
    }

    if (onProgress) {
      onProgress("Validating AI evidence quotes against source text...");
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function askDocumentQuestion(
  redactedText: string,
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  modelId?: string
): Promise<DocumentQAPair> {
  const selectedModel = modelId || getSelectedAiModel();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50000);

  try {
    const response = await fetch("/api/ai/qa", {
      method: "POST",
      headers: getByokHeaders(),
      body: JSON.stringify({
        redactedText,
        question,
        history,
        modelId: selectedModel,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        errorData.error || `Q&A request failed with status ${response.status}`
      );
    }

    const data = await response.json();
    const citations = Array.isArray(data.citations)
      ? data.citations.map((c: { pageNumber?: number; quote?: string }) => ({
          page: Number(c.pageNumber) || 1,
          snippet: String(c.quote || ""),
        }))
      : [];

    return {
      id: `qa_ai_${Date.now()}`,
      question,
      answer: String(data.answer || "No answer returned."),
      mode: "ai_assisted",
      citations,
      confidence: data.confidence === "verified" ? 0.95 : 0.8,
      timestamp: new Date().toISOString(),
      notFoundInDocument: data.confidence === "not_found",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateChartInsights(
  redactedText: string,
  fileName: string
): Promise<{
  chartTitle: string;
  chartType: "bar" | "pie" | "line";
  dataPoints: { label: string; value: number; category?: string }[];
  insightSummary: string;
}> {
  const response = await fetch("/api/ai/chart", {
    method: "POST",
    headers: getByokHeaders(),
    body: JSON.stringify({
      redactedText,
      fileName,
      modelId: getSelectedAiModel(),
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to generate AI chart insights");
  }
  return await response.json();
}

export function mergeAiIntoAnalysis(
  base: FullDocumentAnalysis,
  ai: AiAnalysisResponse
): FullDocumentAnalysis {
  const mergedDates: ImportantDateItem[] = [...base.importantDates];
  if (Array.isArray(ai.importantDates)) {
    for (const d of ai.importantDates) {
      if (!d.date || !d.sourceQuote) continue;
      const exists = mergedDates.some(
        existing =>
          existing.rawText.toLowerCase() === d.date.toLowerCase() &&
          (existing.sourceLocation.page || 1) === (d.pageNumber || 1)
      );
      if (!exists) {
        mergedDates.push({
          id: d.id || `ai_date_${mergedDates.length + 1}`,
          label: d.label || "Milestone",
          rawText: d.date,
          type:
            d.type === "official_deadline"
              ? "official_deadline"
              : d.type === "expiry_date"
              ? "expiry_date"
              : "target_date",
          eventType: "other_important_date",
          status: "Upcoming",
          verificationStatus: "Verified in text",
          sourceLocation: {
            page: d.pageNumber || 1,
            snippet: d.sourceQuote,
          },
        });
      }
    }
  }

  const mergedFinancials: FinancialItem[] = [...base.financialInformation];
  if (Array.isArray(ai.financialInformation)) {
    for (const f of ai.financialInformation) {
      if (typeof f.amount !== "number" || isNaN(f.amount) || !f.sourceQuote) continue;
      const exists = mergedFinancials.some(
        existing =>
          existing.numericValue !== undefined &&
          Math.abs(existing.numericValue - f.amount) < 0.01 &&
          (existing.sourceLocation.page || 1) === (f.pageNumber || 1)
      );
      if (!exists) {
        mergedFinancials.push({
          id: f.id || `ai_fin_${mergedFinancials.length + 1}`,
          label: f.description || "Financial Item",
          amountText: `${f.currency || "USD"} ${f.amount.toLocaleString()}`,
          currency: f.currency || "USD",
          numericValue: f.amount,
          type: "other",
          detailedCategory: "other_financial_amount",
          verificationStatus: "Verified in text",
          sourceLocation: {
            page: f.pageNumber || 1,
            snippet: f.sourceQuote,
          },
        });
      }
    }
  }

  const mergedRequirements: RequirementItem[] = [...base.requirements];
  if (Array.isArray(ai.requirements)) {
    for (const r of ai.requirements) {
      if (!r.title || !r.sourceQuote) continue;
      const exists = mergedRequirements.some(
        existing =>
          (existing.sourceLocation.page || 1) === (r.pageNumber || 1) &&
          existing.name.toLowerCase().slice(0, 28) === r.title.toLowerCase().slice(0, 28)
      );
      if (!exists) {
        const isMand = Boolean(r.mandatory) && r.classification === "Mandatory";
        mergedRequirements.push({
          id: r.id || `ai_req_${mergedRequirements.length + 1}`,
          name: r.title,
          description: r.description || r.title,
          mandatory: isMand,
          classification:
            r.classification === "Mandatory" ||
            r.classification === "Conditional" ||
            r.classification === "Recommended" ||
            r.classification === "Informational"
              ? r.classification
              : isMand
              ? "Mandatory"
              : "Informational",
          category: r.category || "Submission Requirement",
          sourceLocation: {
            page: r.pageNumber || 1,
            snippet: r.sourceQuote,
          },
          confidence: 0.92,
          verificationStatus: "NOT_ASSESSED",
        });
      }
    }
  }

  const mergedRisks: RiskWarningItem[] = [...base.risksAndWarnings];
  if (Array.isArray(ai.risksAndGaps)) {
    for (const rk of ai.risksAndGaps) {
      if (!rk.title || !rk.sourceQuote) continue;
      const exists = mergedRisks.some(
        existing => existing.title.toLowerCase() === rk.title.toLowerCase()
      );
      if (!exists) {
        mergedRisks.push({
          id: rk.id || `ai_risk_${mergedRisks.length + 1}`,
          title: rk.title,
          indicator: "Needs verification",
          severity:
            rk.severity === "high" || rk.severity === "critical"
              ? "high"
              : rk.severity === "low"
              ? "low"
              : "medium",
          description: rk.description || rk.title,
          whyFired: `AI quote-verified signal on Page ${rk.pageNumber || 1}`,
          sourceLocation: {
            page: rk.pageNumber || 1,
            snippet: rk.sourceQuote,
          },
          recommendedAction: rk.recommendation || "Review source clause.",
        });
      }
    }
  }

  return {
    ...base,
    processingMode: "ai_assisted",
    modelUsed: ai.modelUsed || getSelectedAiModel(),
    aiStatus: "completed",
    executiveSummary: ai.executiveSummary || base.executiveSummary,
    importantDates: mergedDates,
    financialInformation: mergedFinancials,
    requirements: mergedRequirements,
    risksAndWarnings: mergedRisks,
  };
}
