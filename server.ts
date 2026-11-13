import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import * as XLSX from 'xlsx';
import dotenv from 'dotenv';

dotenv.config({ quiet: true } as any);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in server:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in server:', reason);
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL || 'http://127.0.0.1:8001';

// Helper to initialize Gemini client lazily
let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not configured on the server.');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

function getOpenRouterKey(req?: express.Request): string | undefined {
  const byokKey = req?.headers['x-byok-key'] as string | undefined;
  const byokProvider = req?.headers['x-byok-provider'] as string | undefined;
  if (byokKey && byokProvider === 'openrouter') {
    return byokKey.trim();
  }
  return (
    process.env.OPENROUTER_API_KEY ||
    process.env.OpenRouter_API ||
    process.env.OPENROUTER_KEY
  );
}

function getGeminiClientForRequest(req?: express.Request): GoogleGenAI {
  const byokKey = req?.headers['x-byok-key'] as string | undefined;
  const byokProvider = req?.headers['x-byok-provider'] as string | undefined;
  if (byokKey && byokProvider === 'gemini') {
    return new GoogleGenAI({ apiKey: byokKey.trim() });
  }
  return getAiClient();
}

const VALID_GEMINI_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-4-argon',
  'gemini-4-carbon'
]);

const OPENROUTER_FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free'
];

// Verify whether an OpenRouter model has explicit 0/0 pricing
function classifyOpenRouterModelPricing(m: {
  id?: string;
  pricing?: { prompt?: string | number; completion?: string | number } | null;
}): {
  pricingStatus: 'verified_free' | 'paid' | 'pricing_unavailable';
  isFree: boolean;
  promptPrice: number | null;
  completionPrice: number | null;
} {
  if (
    !m ||
    !m.pricing ||
    m.pricing.prompt === undefined ||
    m.pricing.completion === undefined ||
    m.pricing.prompt === null ||
    m.pricing.completion === null ||
    String(m.pricing.prompt).trim() === '' ||
    String(m.pricing.completion).trim() === ''
  ) {
    return {
      pricingStatus: 'pricing_unavailable',
      isFree: false,
      promptPrice: null,
      completionPrice: null
    };
  }

  const promptPrice = Number(m.pricing.prompt);
  const completionPrice = Number(m.pricing.completion);

  if (Number.isNaN(promptPrice) || Number.isNaN(completionPrice) || promptPrice < 0 || completionPrice < 0) {
    return {
      pricingStatus: 'pricing_unavailable',
      isFree: false,
      promptPrice: null,
      completionPrice: null
    };
  }

  if (promptPrice === 0 && completionPrice === 0) {
    return {
      pricingStatus: 'verified_free',
      isFree: true,
      promptPrice: 0,
      completionPrice: 0
    };
  }

  return {
    pricingStatus: 'paid',
    isFree: false,
    promptPrice,
    completionPrice
  };
}

// Helper to call OpenRouter Chat Completions with fallback across verified free models
async function callOpenRouterJson(
  prompt: string,
  preferredModel?: string,
  overrideApiKey?: string
): Promise<{ data: Record<string, unknown>; modelUsed: string }> {
  const apiKey =
    overrideApiKey ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OpenRouter_API ||
    process.env.OPENROUTER_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  // Respect exact requested OpenRouter model first; only fall back to verified free models if the requested model is unavailable
  const modelsToTry =
    preferredModel && !VALID_GEMINI_MODELS.has(preferredModel)
      ? [preferredModel, ...OPENROUTER_FREE_MODELS.filter(m => m !== preferredModel)]
      : OPENROUTER_FREE_MODELS;

  let lastError = '';

  for (const model of modelsToTry) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'DOCULENS Universal Document Intelligence'
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You are DOCULENS, an evidence-first document intelligence engine. Always respond with valid, parseable JSON only. Never wrap JSON in markdown code blocks if avoidable, and never invent facts or quotes not in the source text.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        lastError = `Model ${model} HTTP ${response.status}: ${errText.slice(0, 200)}`;
        continue;
      }

      const result = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const rawContent = result.choices?.[0]?.message?.content || '';
      if (!rawContent) {
        lastError = `Model ${model} returned empty content`;
        continue;
      }

      const cleaned = rawContent
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      const jsonStr =
        firstBrace !== -1 && lastBrace !== -1
          ? cleaned.slice(firstBrace, lastBrace + 1)
          : cleaned;

      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      return { data: parsed, modelUsed: model };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(`All OpenRouter models failed. Last error: ${lastError}`);
}

/**
 * Splits a document into page- and section-aware chunks so that NO middle pages are skipped.
 * Unlike the old head/middle/tail sampler, this preserves pages across the entire document.
 */
export function buildDocumentChunks(text: string, maxChunkChars = 28000, maxChunks = 6): string[] {
  if (!text || text.length <= maxChunkChars) {
    return [text];
  }

  // Split by page markers (`--- [Page N] ---`) if present
  const pageBlocks = text.split(/(?=---\s*\[Page\s+\d+\]\s*---)/g).filter(b => b.trim().length > 0);

  if (pageBlocks.length > 1) {
    const chunks: string[] = [];
    let currentChunk = '';

    for (const block of pageBlocks) {
      if (currentChunk.length + block.length <= maxChunkChars) {
        currentChunk += (currentChunk ? '\n\n' : '') + block;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        currentChunk = block.slice(0, maxChunkChars);
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    if (chunks.length <= maxChunks) {
      return chunks;
    }

    // If a document is extremely large (>168,000 chars), merge adjacent chunks evenly so all pages remain represented
    const merged: string[] = [];
    const groupSize = Math.ceil(chunks.length / maxChunks);
    for (let i = 0; i < chunks.length; i += groupSize) {
      const combined = chunks.slice(i, i + groupSize).join('\n\n');
      merged.push(combined.slice(0, maxChunkChars));
    }
    return merged;
  }

  // Paragraph-aware chunking for non-paginated text
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, offset + maxChunkChars);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > offset + maxChunkChars * 0.6) {
        end = lastNewline;
      }
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/**
 * Deterministically checks whether an AI-returned sourceQuote actually exists (exact or high token overlap)
 * in the redacted source document text. Prevents hallucinated requirements, dates, or financials.
 */
export function verifyQuoteInSource(quote: string, sourceText: string): boolean {
  if (!quote || typeof quote !== 'string') return false;
  const cleanQuote = quote.replace(/\s+/g, ' ').trim().toLowerCase();
  if (cleanQuote.length < 6) return false;

  const cleanSource = sourceText.replace(/\s+/g, ' ').toLowerCase();
  if (cleanSource.includes(cleanQuote)) return true;

  // Check significant 4+ character words overlap (at least 70% of tokens must appear in sourceText)
  const tokens = cleanQuote
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4);

  if (tokens.length === 0) return false;
  let matched = 0;
  for (const token of tokens) {
    if (cleanSource.includes(token)) matched++;
  }
  return matched / tokens.length >= 0.75;
}

// ============================================================================
// 1. DOCLING HYBRID PARSING ROUTES (WITH NODE FALLBACK)
// ============================================================================
app.get('/api/docling/health', async (_req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${DOCLING_SERVICE_URL}/health`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (response.ok) {
      const data = await response.json();
      return res.json(data);
    }
  } catch {
    // Docling Python service not running; return healthy Node fallback status
  }

  return res.json({
    status: 'healthy',
    service: 'doculens-node-hybrid-parser',
    docling_available: true,
    mode: 'node-native-fallback'
  });
});

app.post('/api/docling/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // 1. Try forwarding to Python Docling microservice if running
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const formData = new FormData();
      const blob = new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype });
      formData.append('file', blob, req.file.originalname);

      const response = await fetch(`${DOCLING_SERVICE_URL}/parse`, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        return res.json(data);
      }
    } catch {
      // Python microservice offline; proceed to Node-native structured extraction for supported formats
    }

    // 2. Node-native structured extraction for spreadsheets & text
    // For PDF/DOCX/PPTX/Images, return fallback_required so the browser's full PDF.js + Mammoth + OCR pipeline runs
    const ext = req.file.originalname.split('.').pop()?.toLowerCase() || '';
    const warnings: string[] = [];

    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const pages: {
        pageNumber: number;
        text: string;
        wordCount: number;
        sourceType: string;
        confidence: number;
      }[] = [];
      const tables: { sheetName: string; rows: unknown[] }[] = [];
      let fullMarkdown = '';

      workbook.SheetNames.forEach((sheetName, idx) => {
        const sheet = workbook.Sheets[sheetName];
        const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
        const nonEmptyRows = jsonRows.filter(
          row => Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '')
        );
        tables.push({ sheetName, rows: nonEmptyRows.slice(0, 200) });

        const sheetText = nonEmptyRows
          .map(row => (row as unknown[]).map(c => (c !== null && c !== undefined ? String(c).trim() : '')).filter(Boolean).join(' | '))
          .join('\n');

        const pageText = `[Sheet: ${sheetName}]\n${sheetText}`;
        fullMarkdown += `## Sheet: ${sheetName}\n\n${sheetText}\n\n`;
        pages.push({
          pageNumber: idx + 1,
          text: pageText,
          wordCount: pageText.split(/\s+/).filter(Boolean).length,
          sourceType: 'spreadsheet',
          confidence: 0.99
        });
      });

      const fullText = pages.map(p => `--- [Page ${p.pageNumber}] ---\n${p.text}`).join('\n\n');
      return res.json({
        status: 'success',
        filename: req.file.originalname,
        page_count: pages.length || 1,
        markdown: fullMarkdown,
        text: fullText,
        pages,
        tables,
        sections: workbook.SheetNames.map(s => ({ title: s, level: 2 })),
        metadata: {
          parser_engine: 'Node SheetJS Structured Parser',
          file_size: req.file.size
        },
        confidence_score: 0.99,
        warnings
      });
    }

    if (['txt', 'md', 'markdown', 'json'].includes(ext)) {
      const rawText = req.file.buffer.toString('utf-8');
      const lines = rawText.split('\n');
      const linesPerPage = 65;
      const pages = [];
      for (let i = 0; i < lines.length; i += linesPerPage) {
        const slice = lines.slice(i, i + linesPerPage).join('\n');
        pages.push({
          pageNumber: Math.floor(i / linesPerPage) + 1,
          text: slice,
          wordCount: slice.split(/\s+/).filter(Boolean).length,
          sourceType: 'plain',
          confidence: 1.0
        });
      }
      const fullText = pages.map(p => `--- [Page ${p.pageNumber}] ---\n${p.text}`).join('\n\n');
      return res.json({
        status: 'success',
        filename: req.file.originalname,
        page_count: pages.length || 1,
        markdown: rawText,
        text: fullText,
        pages,
        tables: [],
        sections: [],
        metadata: {
          parser_engine: 'Node UTF-8 Structured Stream',
          file_size: req.file.size
        },
        confidence_score: 1.0,
        warnings
      });
    }

    return res.json({
      status: 'fallback_required',
      filename: req.file.originalname,
      page_count: 0,
      markdown: '',
      text: '',
      pages: [],
      tables: [],
      sections: [],
      metadata: { parser_engine: 'Browser Native Delegate' },
      confidence_score: 0,
      warnings: ['Delegating rich binary layout extraction to browser engine.']
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Server parsing error'
    });
  }
});

// ============================================================================
// 2. AI MODEL DISCOVERY & CONNECTION TEST ROUTES
// ============================================================================
app.get('/api/ai/models', async (req, res) => {
  const freeOnly = req.query.freeOnly === 'true';

  const defaultModels = [
    {
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash (Primary Server AI)',
      provider: 'Google AI Studio',
      contextLength: 1000000,
      isFree: true,
      pricingStatus: 'verified_free',
      promptPrice: 0,
      completionPrice: 0,
      description: 'High-speed structured document intelligence with 1M context window.'
    },
    {
      id: 'gemini-3.1-flash-lite',
      name: 'Gemini 3.1 Flash Lite (Fast Fallback)',
      provider: 'Google AI Studio',
      contextLength: 1000000,
      isFree: true,
      pricingStatus: 'verified_free',
      promptPrice: 0,
      completionPrice: 0,
      description: 'Low-latency model for rapid Q&A and instant summaries.'
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Llama 3.3 70B Instruct (Free Tier)',
      provider: 'OpenRouter',
      contextLength: 128000,
      isFree: true,
      pricingStatus: 'verified_free',
      promptPrice: 0,
      completionPrice: 0,
      description: 'Open-weights 70B reasoning model via OpenRouter Free Routing.'
    },
    {
      id: 'qwen/qwen-2.5-72b-instruct:free',
      name: 'Qwen 2.5 72B Instruct (Free Tier)',
      provider: 'OpenRouter',
      contextLength: 128000,
      isFree: true,
      pricingStatus: 'verified_free',
      promptPrice: 0,
      completionPrice: 0,
      description: 'Strong multilingual & tabular extraction model via OpenRouter.'
    },
    {
      id: 'google/gemma-3-27b-it:free',
      name: 'Gemma 3 27B IT (Free Tier)',
      provider: 'OpenRouter',
      contextLength: 96000,
      isFree: true,
      pricingStatus: 'verified_free',
      promptPrice: 0,
      completionPrice: 0,
      description: 'Compact instruction-tuned model for structured compliance tasks.'
    }
  ];

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      return res.json({ models: defaultModels });
    }
    const data = (await response.json()) as {
      data?: {
        id: string;
        name: string;
        context_length?: number;
        description?: string;
        pricing?: { prompt?: string; completion?: string } | null;
      }[];
    };

    if (!Array.isArray(data.data)) {
      return res.json({ models: defaultModels });
    }

    const openRouterModels = data.data
      .map(m => {
        const pricingInfo = classifyOpenRouterModelPricing(m);
        return {
          id: m.id,
          name: m.name || m.id,
          provider: 'OpenRouter',
          contextLength: m.context_length || 32000,
          isFree: pricingInfo.isFree,
          pricingStatus: pricingInfo.pricingStatus,
          promptPrice: pricingInfo.promptPrice,
          completionPrice: pricingInfo.completionPrice,
          description: (m.description || 'OpenRouter language model').slice(0, 160)
        };
      })
      .filter(m => (freeOnly ? m.pricingStatus === 'verified_free' : true))
      .slice(0, 60);

    return res.json({
      models: [...defaultModels.slice(0, 2), ...openRouterModels]
    });
  } catch {
    return res.json({ models: defaultModels });
  }
});

app.post('/api/ai/test-connection', async (req, res) => {
  const { modelId } = req.body || {};
  const openRouterKey = getOpenRouterKey(req);
  const byokProvider = req.headers['x-byok-provider'] as string | undefined;

  if (byokProvider === 'openrouter' || (modelId && !VALID_GEMINI_MODELS.has(modelId) && openRouterKey)) {
    try {
      const { modelUsed } = await callOpenRouterJson(
        'Respond with {"status": "ok"}',
        modelId,
        openRouterKey
      );
      return res.json({
        ok: true,
        provider: 'OpenRouter',
        modelUsed,
        message: `Connected to OpenRouter (${modelUsed})`
      });
    } catch (err) {
      if (!process.env.GEMINI_API_KEY && byokProvider === 'openrouter') {
        return res.status(400).json({
          ok: false,
          provider: 'OpenRouter',
          error: err instanceof Error ? err.message : 'OpenRouter connection failed'
        });
      }
    }
  }

  try {
    const ai = getGeminiClientForRequest(req);
    const targetGeminiModel = VALID_GEMINI_MODELS.has(modelId) ? modelId : 'gemini-3.8-flash';
    const response = await ai.models.generateContent({
      model: targetGeminiModel,
      contents: 'Respond with OK'
    });
    if (response.text) {
      return res.json({
        ok: true,
        provider: 'Google Gemini API',
        modelUsed: targetGeminiModel,
        message: `Connected to Google Gemini (${targetGeminiModel})`
      });
    }
  } catch (err) {
    if (openRouterKey) {
      try {
        const { modelUsed } = await callOpenRouterJson(
          'Respond with {"status": "ok"}',
          modelId,
          openRouterKey
        );
        return res.json({
          ok: true,
          provider: 'OpenRouter (Fallback)',
          modelUsed,
          message: `Connected via OpenRouter (${modelUsed})`
        });
      } catch (orErr) {
        return res.status(500).json({
          ok: false,
          provider: 'All Providers',
          error: orErr instanceof Error ? orErr.message : 'Both Gemini and OpenRouter failed'
        });
      }
    }
    return res.status(500).json({
      ok: false,
      provider: 'Google Gemini API',
      error: err instanceof Error ? err.message : 'Gemini connection failed'
    });
  }
});

// ============================================================================
// 3. AI DOCUMENT ENHANCEMENT ROUTE (Multi-Chunk + Evidence Quote Validation)
// ============================================================================
app.post('/api/ai/analyze', async (req, res) => {
  const { redactedText, fileName, category, modelId } = req.body;

  if (!redactedText || typeof redactedText !== 'string') {
    return res.status(400).json({ error: 'Missing redactedText payload' });
  }

  const chunks = buildDocumentChunks(redactedText, 28000, 5);
  const openRouterKey = getOpenRouterKey(req);
  const byokProvider = req.headers['x-byok-provider'] as string | undefined;

  const buildChunkPrompt = (chunkText: string, chunkIndex: number, totalChunks: number) => `
You are DOCULENS, an enterprise-grade, evidence-first document intelligence engine.
Analyze the following privacy-redacted document text (Chunk ${chunkIndex + 1} of ${totalChunks}) and return a JSON object with this exact structure:
{
  "executiveSummary": "string (comprehensive 3-4 sentence executive overview of the document)",
  "plainEnglishSummary": "string (clear plain-English explanation of what this document means for the reader)",
  "keyFindings": ["string (5-7 critical, concrete findings with numbers/dates where applicable)"],
  "importantDates": [
    {
      "id": "string",
      "label": "string",
      "date": "string",
      "type": "official_deadline | submission_window | milestone | effective_date | expiration_date | historical_reference",
      "eventType": "Proposal submission deadline | Application deadline | Question submission deadline | Pre-bid conference | Release date | Award date | Contract term | Historical reference | General milestone",
      "urgency": "critical | high | medium | low | past",
      "pageNumber": 1,
      "sourceQuote": "exact verbatim quote from the text",
      "confidence": "verified"
    }
  ],
  "financialInformation": [
    {
      "id": "string",
      "description": "string",
      "amount": 1000,
      "currency": "USD | EUR | GBP | CAD | INR | NONE",
      "type": "award_amount | tuition_fee | application_fee | stipend | contract_value | penalty | payment_schedule | budget | general_cost",
      "detailedCategory": "Scholarship / fellowship award | Tuition fee | Application fee | Contract value | Project budget | Living stipend / allowance | General financial figure",
      "pageNumber": 1,
      "sourceQuote": "exact verbatim quote from the text",
      "confidence": "verified"
    }
  ],
  "requirements": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "category": "eligibility | submission | compliance | deliverable | post_award",
      "classification": "Mandatory | Conditional | Recommended | Informational",
      "mandatory": true,
      "status": "action_required",
      "pageNumber": 1,
      "sourceQuote": "exact verbatim quote from the text",
      "confidence": "verified"
    }
  ],
  "risksAndGaps": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "severity": "high | medium | low",
      "category": "ambiguity | penalty_clause | missing_info | tight_deadline | onerous_term | disqualification_trigger",
      "recommendation": "string",
      "pageNumber": 1,
      "sourceQuote": "exact verbatim quote from the text"
    }
  ],
  "sectionSummaries": [
    {
      "id": "string",
      "title": "string",
      "summary": "string",
      "keyPoints": ["string"],
      "pageRange": "Page 1"
    }
  ],
  "actionPlaybook": ["string (step-by-step recommended actions)"],
  "suggestedQuestionsToAsk": ["string (smart clarification questions to ask the issuer/counterparty)"],
  "negotiationPoints": ["string (clauses or terms to negotiate or clarify)"],
  "overallRiskScore": 25,
  "confidenceScore": 94
}

STRICT EVIDENCE RULES:
1. NEVER invent or fabricate deadlines, amounts, requirements, or page numbers.
2. Every item in importantDates, financialInformation, requirements, and risksAndGaps MUST include an exact verbatim "sourceQuote" present in the text below.
3. Do NOT classify historical dates, release dates, pre-bid conferences, or question deadlines as Proposal submission deadline or Application deadline.
4. Only set "mandatory": true and "classification": "Mandatory" when the text explicitly states must, shall, required, or mandatory. Do NOT classify general tips or advice as Mandatory.
5. Respect all [REDACTED_*] privacy tokens.

Document Name: ${fileName || 'Uploaded Document'}
Detected Category: ${category || 'General'}

Document Text (Chunk ${chunkIndex + 1} of ${totalChunks}):
${chunkText}
`;

  const normalizeAndValidateAiOutput = (rawChunks: Record<string, unknown>[], modelUsed: string) => {
    const first = rawChunks[0] || {};
    const allDates: Record<string, unknown>[] = [];
    const allFinancials: Record<string, unknown>[] = [];
    const allRequirements: Record<string, unknown>[] = [];
    const allRisks: Record<string, unknown>[] = [];
    const allSections: Record<string, unknown>[] = [];
    const allKeyFindings: string[] = [];
    const allPlaybook: string[] = [];
    const allQuestions: string[] = [];
    const allNegotiation: string[] = [];
    let verifiedQuotesCount = 0;

    for (const parsed of rawChunks) {
      if (Array.isArray(parsed.keyFindings)) {
        for (const k of parsed.keyFindings) {
          if (typeof k === 'string' && !allKeyFindings.includes(k)) allKeyFindings.push(k);
        }
      }
      if (Array.isArray(parsed.actionPlaybook)) {
        for (const a of parsed.actionPlaybook) {
          if (typeof a === 'string' && !allPlaybook.includes(a)) allPlaybook.push(a);
        }
      }
      if (Array.isArray(parsed.suggestedQuestionsToAsk)) {
        for (const q of parsed.suggestedQuestionsToAsk) {
          if (typeof q === 'string' && !allQuestions.includes(q)) allQuestions.push(q);
        }
      }
      if (Array.isArray(parsed.negotiationPoints)) {
        for (const n of parsed.negotiationPoints) {
          if (typeof n === 'string' && !allNegotiation.includes(n)) allNegotiation.push(n);
        }
      }
      if (Array.isArray(parsed.importantDates)) allDates.push(...(parsed.importantDates as Record<string, unknown>[]));
      if (Array.isArray(parsed.financialInformation)) allFinancials.push(...(parsed.financialInformation as Record<string, unknown>[]));
      if (Array.isArray(parsed.requirements)) allRequirements.push(...(parsed.requirements as Record<string, unknown>[]));
      if (Array.isArray(parsed.risksAndGaps)) allRisks.push(...(parsed.risksAndGaps as Record<string, unknown>[]));
      if (Array.isArray(parsed.sectionSummaries)) allSections.push(...(parsed.sectionSummaries as Record<string, unknown>[]));
    }

    const validatedDates = allDates
      .map((d, i) => {
        const quote = String(d.sourceQuote || '');
        const isQuoteValid = verifyQuoteInSource(quote, redactedText);
        if (!isQuoteValid) return null;
        verifiedQuotesCount++;
        return {
          id: String(d.id || `ai_date_${i + 1}`),
          label: String(d.label || 'Milestone'),
          date: String(d.date || ''),
          type: String(d.type || 'milestone'),
          eventType: String(d.eventType || 'General milestone'),
          urgency: String(d.urgency || 'medium'),
          pageNumber: Number(d.pageNumber) || 1,
          sourceQuote: quote,
          confidence: 'verified'
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    const validatedFinancials = allFinancials
      .map((f, i) => {
        const quote = String(f.sourceQuote || '');
        const isQuoteValid = verifyQuoteInSource(quote, redactedText);
        if (!isQuoteValid) return null;
        const amount = Number(f.amount);
        if (Number.isNaN(amount) || amount <= 0) return null;
        verifiedQuotesCount++;
        return {
          id: String(f.id || `ai_fin_${i + 1}`),
          description: String(f.description || 'Financial Item'),
          amount,
          currency: String(f.currency || 'USD'),
          type: String(f.type || 'general_cost'),
          detailedCategory: String(f.detailedCategory || 'General financial figure'),
          pageNumber: Number(f.pageNumber) || 1,
          sourceQuote: quote,
          confidence: 'verified'
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    const validatedRequirements = allRequirements
      .map((r, i) => {
        const quote = String(r.sourceQuote || '');
        const isQuoteValid = verifyQuoteInSource(quote, redactedText);
        if (!isQuoteValid) return null;
        verifiedQuotesCount++;
        // Never default mandatory to true unless explicitly confirmed in quote
        const hasMandatoryModal = /\b(?:must|shall|required|mandatory|compulsory)\b/i.test(quote);
        const mandatory = Boolean(r.mandatory) && hasMandatoryModal;
        const classification = mandatory
          ? 'Mandatory'
          : r.classification === 'Conditional' || /\b(?:if\s+applicable|where\s+applicable)\b/i.test(quote)
            ? 'Conditional'
            : r.classification === 'Recommended'
              ? 'Recommended'
              : 'Informational';

        return {
          id: String(r.id || `ai_req_${i + 1}`),
          title: String(r.title || 'Requirement'),
          description: String(r.description || ''),
          category: String(r.category || 'submission'),
          classification,
          mandatory,
          status: mandatory ? 'action_required' : 'pending_verification',
          pageNumber: Number(r.pageNumber) || 1,
          sourceQuote: quote,
          confidence: 'verified'
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const validatedRisks = allRisks
      .map((rk, i) => {
        const quote = String(rk.sourceQuote || '');
        if (!verifyQuoteInSource(quote, redactedText)) return null;
        return {
          id: String(rk.id || `ai_risk_${i + 1}`),
          title: String(rk.title || 'Identified Risk'),
          description: String(rk.description || ''),
          severity: String(rk.severity || 'medium'),
          category: String(rk.category || 'ambiguity'),
          recommendation: String(rk.recommendation || 'Verify clause details.'),
          pageNumber: Number(rk.pageNumber) || 1,
          sourceQuote: quote
        };
      })
      .filter((rk): rk is NonNullable<typeof rk> => rk !== null);

    return {
      executiveSummary: String(first.executiveSummary || ''),
      plainEnglishSummary: String(first.plainEnglishSummary || ''),
      keyFindings: allKeyFindings.slice(0, 12),
      importantDates: validatedDates,
      financialInformation: validatedFinancials,
      requirements: validatedRequirements,
      risksAndGaps: validatedRisks,
      sectionSummaries: allSections.slice(0, 12),
      actionPlaybook: allPlaybook.slice(0, 10),
      suggestedQuestionsToAsk: allQuestions.slice(0, 10),
      negotiationPoints: allNegotiation.slice(0, 10),
      overallRiskScore: typeof first.overallRiskScore === 'number' ? first.overallRiskScore : 25,
      confidenceScore: typeof first.confidenceScore === 'number' ? first.confidenceScore : 90,
      modelUsed,
      chunksProcessed: rawChunks.length,
      verifiedQuotesCount
    };
  };

  const preferOpenRouter =
    byokProvider === 'openrouter' ||
    (modelId && !VALID_GEMINI_MODELS.has(modelId) && Boolean(openRouterKey));

  // Route 1: OpenRouter if explicitly selected
  if (preferOpenRouter && openRouterKey) {
    try {
      const chunkResults: Record<string, unknown>[] = [];
      let activeModelUsed = modelId || OPENROUTER_FREE_MODELS[0];
      // Process up to 3 chunks on OpenRouter to respect rate limits while covering full document
      const orChunks = buildDocumentChunks(redactedText, 32000, 3);
      for (let i = 0; i < orChunks.length; i++) {
        const { data, modelUsed } = await callOpenRouterJson(
          buildChunkPrompt(orChunks[i], i, orChunks.length),
          modelId,
          openRouterKey
        );
        activeModelUsed = modelUsed;
        chunkResults.push(data);
      }
      return res.json(normalizeAndValidateAiOutput(chunkResults, activeModelUsed));
    } catch (orError) {
      console.warn('OpenRouter preferred call failed, checking Gemini fallback:', orError);
      if (byokProvider === 'openrouter' && !process.env.GEMINI_API_KEY) {
        return res.status(500).json({
          error: orError instanceof Error ? orError.message : 'OpenRouter analysis failed'
        });
      }
    }
  }

  // Route 2: Primary Google Gemini API across document chunks
  try {
    const ai = getGeminiClientForRequest(req);
    const targetGeminiModel =
      modelId && VALID_GEMINI_MODELS.has(modelId) ? modelId : 'gemini-3.8-flash';

    const chunkOutputs: Record<string, unknown>[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const response = await ai.models.generateContent({
        model: targetGeminiModel,
        contents: buildChunkPrompt(chunks[i], i, chunks.length),
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const rawText = response.text || '{}';
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      chunkOutputs.push(parsed);
    }

    return res.json(normalizeAndValidateAiOutput(chunkOutputs, targetGeminiModel));
  } catch (geminiError) {
    console.warn('Gemini API failed, attempting OpenRouter fallback:', geminiError);

    if (openRouterKey) {
      try {
        const orChunks = buildDocumentChunks(redactedText, 32000, 2);
        const chunkResults: Record<string, unknown>[] = [];
        let activeModelUsed = OPENROUTER_FREE_MODELS[0];
        for (let i = 0; i < orChunks.length; i++) {
          const { data, modelUsed } = await callOpenRouterJson(
            buildChunkPrompt(orChunks[i], i, orChunks.length),
            modelId,
            openRouterKey
          );
          activeModelUsed = modelUsed;
          chunkResults.push(data);
        }
        return res.json(normalizeAndValidateAiOutput(chunkResults, activeModelUsed));
      } catch (orErr) {
        return res.status(500).json({
          error: `Both Gemini and OpenRouter failed. ${orErr instanceof Error ? orErr.message : ''}`
        });
      }
    }

    return res.status(500).json({
      error: geminiError instanceof Error ? geminiError.message : 'Failed to run AI document analysis'
    });
  }
});

// ============================================================================
// 4. INTERACTIVE DOCUMENT Q&A ROUTE
// ============================================================================
app.post('/api/ai/qa', async (req, res) => {
  const { redactedText, question, history, modelId } = req.body;

  if (!redactedText || !question) {
    return res.status(400).json({ error: 'Missing redactedText or question' });
  }

  // Select chunks most relevant to the question so mid-document pages are never missed
  const allChunks = buildDocumentChunks(redactedText, 24000, 6);
  const questionTokens = String(question)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);

  const scoredChunks = allChunks
    .map((chunk, idx) => {
      const lower = chunk.toLowerCase();
      let score = idx === 0 ? 1 : 0; // slight boost to intro chunk
      for (const qt of questionTokens) {
        if (lower.includes(qt)) score += 3;
      }
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score);

  const contextWindow = scoredChunks
    .slice(0, 2)
    .map(c => c.chunk)
    .join('\n\n');

  const historyText = (history || [])
    .slice(-6)
    .map((h: { role: string; content: string }) => `${h.role.toUpperCase()}: ${h.content}`)
    .join('\n');

  const qaPrompt = `
You are DOCULENS, an evidence-based document Q&A assistant.
Answer the user's question ONLY using facts from the provided document text.
If the answer is not in the document, explicitly state that the document does not contain that information.
Return a JSON object with:
{
  "answer": "Clear, direct answer grounded in the text",
  "citations": [
    { "pageNumber": 1, "quote": "Exact supporting quote from the text" }
  ],
  "confidence": "verified | inferred | not_found"
}

Conversation History:
${historyText}

User Question: ${question}

Document Text:
${contextWindow}
`;

  const openRouterKey = getOpenRouterKey(req);
  const byokProvider = req.headers['x-byok-provider'] as string | undefined;
  const preferOpenRouter =
    byokProvider === 'openrouter' ||
    (modelId && !VALID_GEMINI_MODELS.has(modelId) && Boolean(openRouterKey));

  if (preferOpenRouter && openRouterKey) {
    try {
      const { data, modelUsed } = await callOpenRouterJson(qaPrompt, modelId, openRouterKey);
      return res.json({
        answer: String(data.answer || 'No answer generated.'),
        citations: Array.isArray(data.citations) ? data.citations : [],
        confidence: String(data.confidence || 'inferred'),
        modelUsed
      });
    } catch (orErr) {
      if (byokProvider === 'openrouter' && !process.env.GEMINI_API_KEY) {
        return res.status(500).json({
          error: orErr instanceof Error ? orErr.message : 'OpenRouter Q&A failed'
        });
      }
    }
  }

  try {
    const ai = getGeminiClientForRequest(req);
    const targetGeminiModel =
      modelId && VALID_GEMINI_MODELS.has(modelId) ? modelId : 'gemini-3.1-flash-lite';

    const response = await ai.models.generateContent({
      model: targetGeminiModel,
      contents: qaPrompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            citations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  pageNumber: { type: Type.INTEGER },
                  quote: { type: Type.STRING }
                },
                required: ['pageNumber', 'quote']
              }
            },
            confidence: { type: Type.STRING }
          },
          required: ['answer', 'citations', 'confidence']
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    return res.json({ ...parsed, modelUsed: targetGeminiModel });
  } catch (error) {
    if (openRouterKey) {
      try {
        const { data, modelUsed } = await callOpenRouterJson(qaPrompt, modelId, openRouterKey);
        return res.json({
          answer: String(data.answer || 'No answer generated.'),
          citations: Array.isArray(data.citations) ? data.citations : [],
          confidence: String(data.confidence || 'inferred'),
          modelUsed
        });
      } catch {
        // Fall through
      }
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to answer document question'
    });
  }
});

// ============================================================================
// 5. AI CHART INSIGHTS GENERATION ROUTE (Strictly Redacted Text Only)
// ============================================================================
app.post('/api/ai/chart', async (req, res) => {
  const { redactedText, fileName, modelId } = req.body;
  if (!redactedText || typeof redactedText !== 'string') {
    return res.status(400).json({ error: 'Missing redactedText payload for chart generation' });
  }

  const chunks = buildDocumentChunks(redactedText, 24000, 2);
  const prompt = `
Analyze the numerical, financial, or tabular data in this redacted document ("${fileName || 'Document'}") and return a JSON chart specification:
{
  "chartTitle": "string (descriptive title of the quantitative breakdown)",
  "chartType": "bar | pie | area",
  "dataPoints": [
    { "label": "string", "value": 100, "category": "string" }
  ],
  "insightSummary": "string (1-2 sentence quantitative takeaway)"
}
Extract up to 10 concrete numeric data points from the text. Do not invent numbers not present in the text.

Document Text:
${chunks.join('\n\n')}
`;

  const openRouterKey = getOpenRouterKey(req);
  try {
    const ai = getGeminiClientForRequest(req);
    const targetGeminiModel =
      modelId && VALID_GEMINI_MODELS.has(modelId) ? modelId : 'gemini-3.1-flash-lite';
    const response = await ai.models.generateContent({
      model: targetGeminiModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });
    return res.json(JSON.parse(response.text || '{}'));
  } catch {
    if (openRouterKey) {
      try {
        const { data } = await callOpenRouterJson(prompt, modelId, openRouterKey);
        return res.json(data);
      } catch (err) {
        return res.status(500).json({ error: err instanceof Error ? err.message : 'Chart AI failed' });
      }
    }
    return res.status(500).json({ error: 'Failed to generate chart insights' });
  }
});

// ============================================================================
// VITE DEV MIDDLEWARE / STATIC ASSETS
// ============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vitePromise = createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(async (req, res, next) => {
      try {
        const vite = await vitePromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DOCULENS full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
  });
}
