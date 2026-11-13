import Tesseract from "tesseract.js";
import { DocumentPage } from "../../types";
import { renderPdfPageToBlob } from "./pdfParser";

export async function parseImageWithOcr(
  file: File | Blob,
  pageNumber = 1,
  onProgress?: (progress: number) => void
): Promise<DocumentPage> {
  const result = await Tesseract.recognize(file, "eng", {
    logger: m => {
      if (m.status === "recognizing text" && onProgress) {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });

  const text = (result.data.text || "").trim();
  const confidence = (result.data.confidence || 75) / 100;

  return {
    pageNumber,
    text,
    confidence,
    isOcr: true,
    ocrFailed: text.length === 0,
  };
}

export async function parseScannedPdfPagesWithOcr(
  fileOrBuffer: File | ArrayBuffer | Uint8Array,
  pageNumbers: number[],
  onPageProgress?: (current: number, total: number) => void,
  maxPagesLimit = 25
): Promise<DocumentPage[]> {
  const ocrPages: DocumentPage[] = [];
  const pagesToProcess = pageNumbers.slice(0, maxPagesLimit);
  const skippedPages = pageNumbers.slice(maxPagesLimit);

  for (let i = 0; i < pagesToProcess.length; i++) {
    const pageNum = pagesToProcess[i];
    if (onPageProgress) {
      onPageProgress(i + 1, pagesToProcess.length);
    }

    try {
      const pageBlob = await renderPdfPageToBlob(fileOrBuffer, pageNum, 2.0);
      const ocrPage = await parseImageWithOcr(pageBlob, pageNum);
      ocrPages.push(ocrPage);
    } catch (err) {
      console.warn(`OCR failed on page ${pageNum}:`, err);
      ocrPages.push({
        pageNumber: pageNum,
        text: `[OCR failed on Page ${pageNum}: ${
          err instanceof Error ? err.message : "Unable to render or recognize page"
        }]`,
        confidence: 0,
        isOcr: true,
        ocrFailed: true,
        hasExtractionWarning: true,
      });
    }
  }

  for (const skippedPageNum of skippedPages) {
    ocrPages.push({
      pageNumber: skippedPageNum,
      text: `[Page ${skippedPageNum} was not OCR-processed because browser OCR limit (${maxPagesLimit} scanned pages) was reached.]`,
      confidence: 0,
      isOcr: true,
      ocrFailed: true,
      hasExtractionWarning: true,
    });
  }

  return ocrPages;
}
