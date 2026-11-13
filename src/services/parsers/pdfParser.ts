import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ParsedPage, ExtractedDocumentMetadata } from '../../types';

if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface PdfExtractionResult {
  pages: ParsedPage[];
  fullText: string;
  pageCount: number;
  title?: string;
  author?: string;
  creationDate?: string;
  metadata?: ExtractedDocumentMetadata;
  extractedTables: {
    tableIndex: number;
    page: number;
    pageNumber: number;
    headers: string[];
    rows: string[][];
    markdown: string;
  }[];
  hasEmptyPages: boolean;
  emptyPageNumbers: number[];
}

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

export async function parsePdfFile(
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<PdfExtractionResult> {
  const arrayBuffer = await file.arrayBuffer();
  return parsePdfBuffer(arrayBuffer, onProgress);
}

export async function parsePdfBuffer(
  buffer: ArrayBuffer | Uint8Array,
  onProgress?: (current: number, total: number) => void
): Promise<PdfExtractionResult> {
  const uint8 = buffer instanceof Uint8Array
    ? new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    : new Uint8Array(buffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useSystemFonts: true
  });

  const pdfDocument = await loadingTask.promise;
  const pageCount = pdfDocument.numPages;
  const pages: ParsedPage[] = [];
  const emptyPageNumbers: number[] = [];
  const extractedTables: {
    tableIndex: number;
    page: number;
    pageNumber: number;
    headers: string[];
    rows: string[][];
    markdown: string;
  }[] = [];

  let title: string | undefined;
  let author: string | undefined;
  let creationDate: string | undefined;
  let creator: string | undefined;
  let producer: string | undefined;
  let subject: string | undefined;
  let keywords: string | undefined;
  let modificationDate: string | undefined;
  let pdfVersion: string | undefined;
  let isEncrypted = false;
  let isLinearized = false;

  try {
    const meta = await pdfDocument.getMetadata();
    const info = meta?.info as Record<string, unknown> | undefined;
    if (info) {
      if (typeof info.Title === 'string' && info.Title.trim()) title = info.Title.trim();
      if (typeof info.Author === 'string' && info.Author.trim()) author = info.Author.trim();
      if (typeof info.Creator === 'string' && info.Creator.trim()) creator = info.Creator.trim();
      if (typeof info.Producer === 'string' && info.Producer.trim()) producer = info.Producer.trim();
      if (typeof info.Subject === 'string' && info.Subject.trim()) subject = info.Subject.trim();
      if (typeof info.Keywords === 'string' && info.Keywords.trim()) keywords = info.Keywords.trim();
      if (typeof info.CreationDate === 'string' && info.CreationDate.trim()) creationDate = info.CreationDate.trim();
      if (typeof info.ModDate === 'string' && info.ModDate.trim()) modificationDate = info.ModDate.trim();
      if (typeof info.PDFFormatVersion === 'string') pdfVersion = info.PDFFormatVersion;
      if (typeof info.IsAcroFormPresent === 'boolean' || typeof info.IsLinearized === 'boolean') {
        isLinearized = Boolean(info.IsLinearized);
      }
      if (info.Encrypt) {
        isEncrypted = true;
      }
    }
  } catch {
    // Metadata optional
  }

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    if (onProgress) onProgress(pageNum, pageCount);

    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Collect positioned text items and sort by Y descending (top-to-bottom), then X ascending (left-to-right)
    const items: PositionedTextItem[] = [];
    for (const rawItem of textContent.items as Record<string, unknown>[]) {
      const str = typeof rawItem.str === 'string' ? rawItem.str : '';
      if (!str) continue;
      const transform = Array.isArray(rawItem.transform) ? (rawItem.transform as number[]) : [1, 0, 0, 1, 0, 0];
      const x = typeof transform[4] === 'number' ? transform[4] : 0;
      const y = typeof transform[5] === 'number' ? transform[5] : 0;
      const width = typeof rawItem.width === 'number' ? rawItem.width : str.length * 5;
      items.push({ str, x, y, width });
    }

    // Group items into horizontal lines using Y tolerance (within 4pt)
    const lineGroups: { y: number; items: PositionedTextItem[] }[] = [];
    for (const item of items) {
      let matchedGroup = lineGroups.find(g => Math.abs(g.y - item.y) <= 4);
      if (!matchedGroup) {
        matchedGroup = { y: item.y, items: [] };
        lineGroups.push(matchedGroup);
      }
      matchedGroup.items.push(item);
    }

    // Sort lines top-to-bottom (higher Y is higher on standard PDF page)
    lineGroups.sort((a, b) => b.y - a.y);

    const reconstructedLines: string[] = [];
    const candidateTableRows: string[][] = [];

    for (let i = 0; i < lineGroups.length; i++) {
      const group = lineGroups[i];
      // Sort items left-to-right by X coordinate
      group.items.sort((a, b) => a.x - b.x);

      let lineStr = '';
      const rowCells: string[] = [];
      let currentCell = '';

      for (let j = 0; j < group.items.length; j++) {
        const curr = group.items[j];
        const prev = j > 0 ? group.items[j - 1] : null;
        if (!prev) {
          lineStr += curr.str;
          currentCell = curr.str;
        } else {
          const gap = curr.x - (prev.x + prev.width);
          if (gap > 18) {
            // Column gap in table or wide tab
            lineStr += ' | ' + curr.str;
            if (currentCell.trim()) rowCells.push(currentCell.trim());
            currentCell = curr.str;
          } else if (gap > 2 && !lineStr.endsWith(' ') && !curr.str.startsWith(' ')) {
            lineStr += ' ' + curr.str;
            currentCell += ' ' + curr.str;
          } else {
            lineStr += curr.str;
            currentCell += curr.str;
          }
        }
      }
      if (currentCell.trim()) rowCells.push(currentCell.trim());

      const cleanedLine = lineStr.replace(/[ \t]+/g, ' ').trim();
      if (cleanedLine) {
        reconstructedLines.push(cleanedLine);
      }
      if (rowCells.length >= 2) {
        candidateTableRows.push(rowCells);
      }
    }

    if (candidateTableRows.length >= 2) {
      const headers = candidateTableRows[0];
      const rows = candidateTableRows.slice(1);
      const mdHeader = `| ${headers.join(' | ')} |`;
      const mdSep = `| ${headers.map(() => '---').join(' | ')} |`;
      const mdRows = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
      extractedTables.push({
        tableIndex: extractedTables.length + 1,
        page: pageNum,
        pageNumber: pageNum,
        headers,
        rows,
        markdown: [mdHeader, mdSep, mdRows].filter(Boolean).join('\n')
      });
    }

    const cleanedText = reconstructedLines.join('\n').trim();
    const wordCount = cleanedText ? cleanedText.split(/\s+/).length : 0;

    if (wordCount < 5) {
      emptyPageNumbers.push(pageNum);
    }

    // Calculate measured confidence from text density and printable character ratio
    const printableChars = cleanedText.replace(/[^\x20-\x7E\u00A0-\u024F]/g, '').length;
    const printableRatio = cleanedText.length > 0 ? printableChars / cleanedText.length : 0;
    const measuredConfidence =
      wordCount >= 5 ? Math.round(Math.min(0.99, Math.max(0.65, printableRatio)) * 100) / 100 : 0.1;

    pages.push({
      pageNumber: pageNum,
      text: cleanedText,
      wordCount,
      sourceType: 'pdf_text',
      confidence: measuredConfidence
    });
  }

  const fullText = pages
    .map(p => `--- [Page ${p.pageNumber}] ---\n${p.text}`)
    .join('\n\n');

  const metadata: ExtractedDocumentMetadata = {
    title,
    author,
    creator,
    producer,
    subject,
    keywords,
    creationDate,
    modificationDate,
    pdfVersion,
    isEncrypted,
    isLinearized
  };

  return {
    pages,
    fullText,
    pageCount,
    title,
    author,
    creationDate,
    metadata,
    extractedTables,
    hasEmptyPages: emptyPageNumbers.length > 0,
    emptyPageNumbers
  };
}

export async function renderPdfPageToBlob(
  fileOrBuffer: File | ArrayBuffer | Uint8Array,
  pageNumber: number,
  scale = 2.0
): Promise<Blob> {
  const data =
    fileOrBuffer instanceof Uint8Array
      ? new Uint8Array(fileOrBuffer.buffer.slice(fileOrBuffer.byteOffset, fileOrBuffer.byteOffset + fileOrBuffer.byteLength))
      : fileOrBuffer instanceof ArrayBuffer
      ? new Uint8Array(fileOrBuffer.slice(0))
      : new Uint8Array(await fileOrBuffer.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({
    data,
    useSystemFonts: true
  });
  const pdfDocument = await loadingTask.promise;
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not initialize 2D canvas context for PDF OCR rendering');
  }

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport,
    canvas
  }).promise;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to convert rendered PDF page canvas to Blob'));
    }, 'image/png');
  });
}

export function isSuspiciousPdfBinaryGarbage(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  let nonPrintableCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffd) {
      nonPrintableCount++;
    }
  }
  const ratio = nonPrintableCount / text.length;
  if (ratio > 0.15) return true;
  if (/^%PDF-\d\.\d/m.test(text) && /\b(?:endobj|xref|trailer|startxref)\b/.test(text)) {
    return true;
  }
  return false;
}
