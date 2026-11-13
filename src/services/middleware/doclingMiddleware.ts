import { ExtractionAudit, ParsedDocumentData } from "../../types";
import { parseDocumentFile, ParseProgressCallback } from "../parsers/unifiedParser";

class DoclingMiddlewareService {
  private activeJobs: Map<string, ExtractionAudit> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private maxFileSizeBytes = 50 * 1024 * 1024; // 50MB hard limit

  public validateFileBeforeIngestion(file: File): { valid: boolean; error?: string } {
    if (!file) {
      return { valid: false, error: "No file provided for ingestion." };
    }
    if (file.size === 0) {
      return { valid: false, error: `File "${file.name}" is empty (0 bytes).` };
    }
    if (file.size > this.maxFileSizeBytes) {
      return {
        valid: false,
        error: `File "${file.name}" exceeds maximum allowed size of 50MB.`,
      };
    }
    return { valid: true };
  }

  public async processDocumentWithGuardrails(
    file: File,
    onProgress?: ParseProgressCallback
  ): Promise<{ document: ParsedDocumentData; audit: ExtractionAudit }> {
    const validation = this.validateFileBeforeIngestion(file);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);

    try {
      const timeoutMs = 120000;
      const parsePromise = parseDocumentFile(file, (stage, pct) => {
        if (controller.signal.aborted) {
          throw new Error(`Extraction job "${jobId}" was cancelled by user.`);
        }
        if (onProgress) onProgress(stage, pct);
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Document extraction timed out after 120 seconds.")),
          timeoutMs
        )
      );

      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Extraction job "${jobId}" was cancelled.`));
        });
      });

      const parsedDoc = await Promise.race([parsePromise, timeoutPromise, abortPromise]);
      const audit = parsedDoc.extractionAudit!;
      this.activeJobs.set(jobId, audit);
      this.abortControllers.delete(jobId);

      return { document: parsedDoc, audit };
    } catch (err) {
      this.abortControllers.delete(jobId);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  public cancelJob(jobId: string): boolean {
    const controller = this.abortControllers.get(jobId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(jobId);
      return true;
    }
    return false;
  }
}

export const doclingMiddleware = new DoclingMiddlewareService();
