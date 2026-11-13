import {
  DocumentCategory,
  DocumentPage,
  ExtractedDocumentMetadata,
  ExtractionAudit,
  ParsedDocumentData,
  SpreadsheetAnalysisData,
} from "../../types";
import { parsePdfBuffer } from "./pdfParser";
import { parseDocxBuffer } from "./docxParser";
import { parseSpreadsheetBuffer } from "./sheetParser";
import { parseImageWithOcr, parseScannedPdfPagesWithOcr } from "./ocrParser";
import { parsePlainText } from "./textParser";
import { parseRtfBuffer } from "./rtfParser";
import { parseOdtArchiveBuffer } from "./odtParser";
import { parsePptxBuffer } from "./pptxParser";
import { parseLegacyDocBuffer } from "./docParser";
import { convertWithDocling } from "./doclingClient";
import { scanSensitiveEntities } from "../privacyService";
import { inspectBinaryMetadata, analyzeDocumentFraudSignals } from "../fraudScanner";

export type ParseProgressCallback = (stage: string, progressPercent: number) => void;

export function detectDocumentCategoryFromText(
  text: string,
  fileName: string
): DocumentCategory {
  const lowerName = fileName.toLowerCase();
  const lower = (text || "").slice(0, 12000).toLowerCase();

  if (/\.(xlsx|xls|csv|ods)$/i.test(lowerName)) {
    return "spreadsheet";
  }
  if (
    /\b(?:request\s+for\s+proposals?|rfp|request\s+for\s+quotations?|rfq|notice\s+inviting\s+tender|solicitation|earnest\s+money\s+deposit|proposers?\s+must|bidders?\s+shall)\b/i.test(
      lower
    )
  ) {
    return "rfp_tender";
  }
  if (
    /\b(?:scholarship|fellowship|stipend|merit\s+grant|financial\s+aid|tuition\s+waiver|bursary)\b/i.test(
      lower
    )
  ) {
    return "scholarship";
  }
  if (
    /\b(?:admission\s+circular|entrance\s+examination|semester\s+fee|undergraduate\s+admission|prospectus)\b/i.test(
      lower
    )
  ) {
    return "admission";
  }
  if (
    /\b(?:master\s+services\s+agreement|this\s+agreement\s+is\s+entered\s+into|indemnification|governing\s+law|termination\s+for\s+convenience)\b/i.test(
      lower
    )
  ) {
    return "contract";
  }
  if (
    /\b(?:job\s+description|role\s+overview|key\s+responsibilities|base\s+salary\s+range|employment\s+type)\b/i.test(
      lower
    )
  ) {
    return "job";
  }
  if (/\b(?:yojana|ministry\s+of|citizen\s+welfare|beneficiary\s+scheme|subsidy)\b/i.test(lower)) {
    return "scheme";
  }
  return "general";
}

export async function parseDocumentFile(
  file: File,
  onProgress?: ParseProgressCallback
): Promise<ParsedDocumentData> {
  const startTime = Date.now();
  const id = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const uploadedAt = new Date().toISOString();
  const ext = file.name.split(".").pop()?.toLowerCase() || "txt";

  if (onProgress) onProgress("Inspecting binary signature & structure...", 8);
  const arrayBuffer = await file.arrayBuffer();
  const binaryCheck = inspectBinaryMetadata(arrayBuffer, file.name);

  let pages: DocumentPage[] = [];
  let fullText = "";
  let markdownText: string | undefined;
  let spreadsheetData: SpreadsheetAnalysisData | undefined;
  let extractedTables: ParsedDocumentData["extractedTables"] = [];
  let documentMetadata: ExtractedDocumentMetadata = { ...binaryCheck.metadata };
  let parserEngineUsed = "Native Browser Extractor";
  let ocrApplied = false;
  const extractionWarnings: string[] = [];

  if (!binaryCheck.extensionMatchesSignature) {
    extractionWarnings.push(
      `File extension (.${binaryCheck.declaredExtension}) does not match binary magic signature (${binaryCheck.detectedSignature}).`
    );
  }

  try {
    // 1. Try Docling microservice first if reachable
    if (["pdf", "docx", "pptx", "xlsx", "xls", "csv", "odt", "rtf", "png", "jpg", "jpeg"].includes(ext)) {
      if (onProgress) onProgress("Checking Docling hybrid service...", 16);
      const doclingResult = await convertWithDocling(file, file.name);
      if (doclingResult && doclingResult.fullText.trim().length > 20) {
        parserEngineUsed = doclingResult.engine || "Docling Hybrid Service";
        fullText = doclingResult.fullText;
        markdownText = doclingResult.markdown;
        extractedTables = doclingResult.tables;
        ocrApplied = doclingResult.ocrApplied;
        extractionWarnings.push(...doclingResult.warnings);
        pages =
          doclingResult.pages.length > 0
            ? doclingResult.pages.map(p => ({
                pageNumber: p.pageNumber,
                text: p.text,
                confidence: 0.96,
                isOcr: doclingResult.ocrApplied,
              }))
            : [
                {
                  pageNumber: 1,
                  text: fullText,
                  confidence: 0.96,
                },
              ];

        // If mixed PDF has empty pages from Docling, run browser OCR on those pages
        if (ext === "pdf") {
          const emptyPageNums = pages
            .filter(p => (p.text || "").trim().split(/\s+/).filter(Boolean).length < 5)
            .map(p => p.pageNumber);
          if (emptyPageNums.length > 0) {
            ocrApplied = true;
            if (onProgress) {
              onProgress(`Running OCR on ${emptyPageNums.length} scanned PDF page(s)...`, 78);
            }
            const ocrPages = await parseScannedPdfPagesWithOcr(file, emptyPageNums);
            for (const op of ocrPages) {
              const idx = pages.findIndex(p => p.pageNumber === op.pageNumber);
              if (idx !== -1 && (op.text || "").length > (pages[idx].text || "").length) {
                pages[idx] = op;
              }
            }
            fullText = pages.map(p => `--- [Page ${p.pageNumber}] ---\n${p.text}`).join("\n\n");
          }
        }
      }
    }

    // 2. Native format-specific extraction when Docling was offline or skipped
    if (pages.length === 0) {
      if (ext === "pdf" || binaryCheck.detectedSignature === "pdf") {
        parserEngineUsed = "PDF.js Coordinate Line & Table Extractor";
        if (onProgress) onProgress("Extracting PDF pages, tables & metadata...", 30);
        const pdfRes = await parsePdfBuffer(arrayBuffer, (curr, total) => {
          if (onProgress) {
            onProgress(
              `Reading PDF page ${curr} of ${total}...`,
              30 + Math.round((curr / Math.max(1, total)) * 35)
            );
          }
        });
        pages = pdfRes.pages;
        fullText = pdfRes.fullText;
        extractedTables = pdfRes.extractedTables;
        documentMetadata = {
          ...documentMetadata,
          ...pdfRes.metadata,
        };

        if (pdfRes.hasEmptyPages && pdfRes.emptyPageNumbers.length > 0 && typeof window !== "undefined") {
          ocrApplied = true;
          extractionWarnings.push(
            `${pdfRes.emptyPageNumbers.length} of ${pdfRes.pageCount} page(s) contained sparse/no selectable text and triggered OCR recovery.`
          );
          if (onProgress) {
            onProgress(
              `Running OCR on ${pdfRes.emptyPageNumbers.length} scanned page(s)...`,
              70
            );
          }
          const ocrPages = await parseScannedPdfPagesWithOcr(
            file,
            pdfRes.emptyPageNumbers,
            (curr, total) => {
              if (onProgress) {
                onProgress(
                  `OCR page ${curr} of ${total}...`,
                  70 + Math.round((curr / Math.max(1, total)) * 20)
                );
              }
            }
          );
          for (const op of ocrPages) {
            const idx = pages.findIndex(p => p.pageNumber === op.pageNumber);
            if (idx !== -1) {
              pages[idx] = op;
            }
          }
          fullText = pages.map(p => `--- [Page ${p.pageNumber}] ---\n${p.text}`).join("\n\n");
        }
      } else if (ext === "docx") {
        parserEngineUsed = "Mammoth DOCX Stream Extractor";
        if (onProgress) onProgress("Extracting Word (.docx) paragraphs...", 45);
        const docxRes = await parseDocxBuffer(arrayBuffer);
        pages = docxRes.pages;
        fullText = docxRes.fullText;
      } else if (ext === "doc") {
        parserEngineUsed = "OLE2 Legacy Word Extractor";
        if (onProgress) onProgress("Extracting legacy Word (.doc) stream...", 45);
        const docRes = parseLegacyDocBuffer(arrayBuffer);
        pages = docRes.pages;
        fullText = docRes.fullText;
      } else if (["xlsx", "xls", "csv", "ods"].includes(ext)) {
        parserEngineUsed = "SheetJS Multi-Sheet Tabular Engine";
        if (onProgress) onProgress("Parsing spreadsheet workbooks & formulas...", 45);
        spreadsheetData = parseSpreadsheetBuffer(arrayBuffer, file.name);
        const sheetSummaryLines = [
          `Spreadsheet Document: ${file.name}`,
          `Sheets (${spreadsheetData.sheetNames.length}): ${spreadsheetData.sheetNames.join(", ")}`,
          `Total Rows: ${spreadsheetData.rowCount} | Columns (${spreadsheetData.columnCount}): ${spreadsheetData.headers.join(", ")}`,
          ...spreadsheetData.rows
            .slice(0, 200)
            .map((r, i) => `Row ${i + 1}: ${ JSON.stringify(r)}`),
        ];
        fullText = sheetSummaryLines.join("\n");
        pages = [
          {
            pageNumber: 1,
            text: fullText,
            confidence: 0.99,
          },
        ];
      } else if (["pptx", "ppt"].includes(ext)) {
        parserEngineUsed = "PPTX Slide XML Extractor";
        if (onProgress) onProgress("Extracting presentation slides...", 45);
        const pptxRes = await parsePptxBuffer(arrayBuffer);
        pages = pptxRes.pages;
        fullText = pptxRes.fullText;
      } else if (["odt", "odp"].includes(ext)) {
        parserEngineUsed = "OpenDocument XML Extractor";
        if (onProgress) onProgress("Extracting OpenDocument XML...", 45);
        const odtRes = await parseOdtArchiveBuffer(arrayBuffer);
        pages = odtRes.pages;
        fullText = odtRes.fullText;
      } else if (ext === "rtf") {
        parserEngineUsed = "RTF Control Stream Parser";
        if (onProgress) onProgress("Parsing Rich Text Format (.rtf)...", 45);
        const rtfRes = parseRtfBuffer(arrayBuffer);
        pages = rtfRes.pages;
        fullText = rtfRes.fullText;
      } else if (["png", "jpg", "jpeg", "webp", "tiff", "bmp"].includes(ext)) {
        parserEngineUsed = "Tesseract.js Optical Character Recognition";
        ocrApplied = true;
        if (onProgress) onProgress("Running OCR on image...", 40);
        const ocrPage = await parseImageWithOcr(file, 1, pct => {
          if (onProgress) onProgress(`Running OCR (${pct}%)...`, 40 + Math.round(pct * 0.45));
        });
        pages = [ocrPage];
        fullText = ocrPage.text;
      } else {
        parserEngineUsed = "UTF-8 Text & Markdown Stream";
        if (onProgress) onProgress("Reading text stream...", 50);
        const textStr = new TextDecoder("utf-8").decode(arrayBuffer);
        const txtRes = parsePlainText(textStr);
        pages = txtRes.pages;
        fullText = txtRes.fullText;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown parsing failure";
    extractionWarnings.push(`Extraction error: ${msg}`);
    pages = [
      {
        pageNumber: 1,
        text: `[Unable to extract text from ${file.name}: ${msg}]`,
        confidence: 0.1,
        hasExtractionWarning: true,
      },
    ];
    fullText = pages[0].text;
  }

  if (onProgress) onProgress("Running deterministic privacy & fraud signal scans...", 90);

  const privacyScan = scanSensitiveEntities(fullText);
  const words = fullText.split(/\s+/).filter(Boolean).length;
  const avgConfidence =
    pages.length > 0
      ? pages.reduce((acc, p) => acc + (p.confidence ?? 0.9), 0) / pages.length
      : 0.5;
  const qualityScore = words < 10 ? Math.min(35, Math.round(avgConfidence * 100)) : Math.round(avgConfidence * 100);

  const detectedCategory = detectDocumentCategoryFromText(fullText, file.name);
  const extractedTitle =
    documentMetadata.title ||
    file.name.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ");

  const pagesWithUsableText = pages.filter(p => (p.text || "").trim().length > 0).length;
  const ocrPagesCount = pages.filter(p => p.isOcr && !p.ocrFailed).length;
  const ocrFailedPagesCount = pages.filter(p => p.ocrFailed).length;

  const extractionAudit: ExtractionAudit = {
    documentId: id,
    originalFilename: file.name,
    contentHash: `sha256_${file.size}_${pages.length}`,
    detectedFormat: binaryCheck.detectedSignature,
    parserName: parserEngineUsed,
    parserVersion: "2.4.0",
    expectedPageCount: pages.length,
    successfullyParsedPages: pagesWithUsableText,
    pagesWithUsableText,
    blankPages: pages.length - pagesWithUsableText,
    ocrPages: ocrPagesCount,
    ocrFailedPages: ocrFailedPagesCount,
    nativeTextPages: pagesWithUsableText - ocrPagesCount,
    tablesDetected: extractedTables?.length || 0,
    tablesExtracted: extractedTables?.length || 0,
    totalWordCount: words,
    tableCount: extractedTables?.length || 0,
    worksheetCount: spreadsheetData?.sheetNames.length || 0,
    extractionQualityScore: qualityScore,
    isScanned: ocrApplied,
    extractionWarnings,
    extractionTimestamp: uploadedAt,
    processingDurationMs: Date.now() - startTime,
    extractionStatus:
      pagesWithUsableText === pages.length && words >= 10
        ? "SUCCESS"
        : pagesWithUsableText > 0
        ? "PARTIAL"
        : "FAILED",
  };

  const parsedDoc: ParsedDocumentData = {
    id,
    fileName: file.name,
    fileSizeBytes: file.size,
    fileType: file.type || ext,
    detectedFormat: binaryCheck.detectedSignature,
    declaredExtension: binaryCheck.declaredExtension,
    extensionMismatch: !binaryCheck.extensionMatchesSignature,
    uploadedAt,
    pages,
    fullText,
    markdownText,
    redactedText: privacyScan.redactedText,
    sensitiveDetections: privacyScan.detections,
    spreadsheetData,
    ocrApplied,
    ocrConfidence: avgConfidence,
    wordCount: words,
    tableCount: extractedTables?.length || 0,
    sheetCount: spreadsheetData?.sheetNames.length || 0,
    extractionQualityScore: qualityScore,
    parserEngineUsed,
    extractionWarnings,
    extractedTables,
    documentMetadata,
    detectedCategory,
    extractedTitle,
    originalFilename: file.name,
    extractionAudit,
  };

  parsedDoc.fraudAnalysis = analyzeDocumentFraudSignals(parsedDoc);

  if (onProgress) onProgress("Document extraction complete!", 100);
  return parsedDoc;
}

export const parseUploadedDocument = parseDocumentFile;
