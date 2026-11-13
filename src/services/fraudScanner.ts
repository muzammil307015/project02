/**
 * DOCULENS File Authenticity & Fraud Signals Engine
 *
 * Performs 100% deterministic, evidence-grounded inspection of:
 * 1. Binary magic-byte signatures vs declared file extensions
 * 2. PDF internal structure (PDF version, /Encrypt, /Sig indicators, %%EOF incremental revisions, /URI links, CreationDate/ModDate)
 * 3. Image binary headers & EXIF/chunk metadata (PNG IHDR/tEXt, JPEG SOF/EXIF tags, WebP dimensions) without external packages
 * 4. Text-based scam & fraud risk signals (advance-fee demands, coercive urgency, bank-change notices, OTP/password harvesting, guaranteed-return claims)
 * 5. Link & contact consistency checks (free email domain mismatch with official authority, raw IP URLs, unencrypted HTTP submission portals, URL shorteners)
 *
 * Strictly adheres to DOCULENS anti-fabrication rules:
 * - Never claims "This document is 100% genuine" or "This document is definitely fake"
 * - Never claims a digital signature is cryptographically valid without certificate chain verification
 * - Never treats a missing metadata field as proof of fraud
 */

import {
  ExtractedDocumentMetadata,
  FraudAnalysisReport,
  FraudSignalFinding,
  FraudWarningLabel,
  ParsedDocumentData,
} from "../types";

/**
 * Parses PDF date strings like "D:20210607090000-05'00'" or "D:20261015123000Z" into ISO-like readable format
 */
export function parsePdfDateString(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const cleaned = raw.trim().replace(/^D:/i, "");
  const match = cleaned.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return raw.trim();
  const year = match[1];
  const month = match[2] || "01";
  const day = match[3] || "01";
  const hour = match[4] || "00";
  const min = match[5] || "00";
  const sec = match[6] || "00";
  return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
}

/**
 * Inspects binary buffer for magic signature, PDF structural indicators, and image dimensions/EXIF
 */
export function inspectBinaryMetadata(
  bufferOrName: ArrayBuffer | Uint8Array | string,
  fileNameOrBuffer: string | ArrayBuffer | Uint8Array,
  existingMeta?: ExtractedDocumentMetadata
): {
  detectedSignature: string;
  declaredExtension: string;
  extensionMatchesSignature: boolean;
  metadata: ExtractedDocumentMetadata;
} {
  let fileName: string;
  let rawBuffer: ArrayBuffer | Uint8Array;

  if (typeof bufferOrName === "string") {
    fileName = bufferOrName;
    rawBuffer = fileNameOrBuffer as (ArrayBuffer | Uint8Array);
  } else {
    rawBuffer = bufferOrName;
    fileName = typeof fileNameOrBuffer === "string" ? fileNameOrBuffer : "unknown";
  }

  const bytes = rawBuffer instanceof Uint8Array
    ? rawBuffer
    : new Uint8Array(rawBuffer);

  const lastDot = fileName.lastIndexOf(".");
  const declaredExtension = lastDot !== -1 ? fileName.slice(lastDot + 1).toLowerCase() : "unknown";

  const metadata: ExtractedDocumentMetadata = {
    ...(existingMeta || {}),
  };

  let detectedSignature = "unknown";
  const headSlice = bytes.slice(0, Math.min(2048, bytes.byteLength));
  const headAscii = new TextDecoder("latin1").decode(headSlice);

  // 0. Detect MZ Windows Executable signature
  if (bytes.byteLength >= 2 && bytes[0] === 0x4D && bytes[1] === 0x5A) {
    detectedSignature = "dos_mz_executable";
  } else if (headAscii.includes("%PDF-")) {
    detectedSignature = "pdf";
    const verMatch = headAscii.match(/%PDF-(\d+\.\d+)/);
    if (verMatch) {
      metadata.pdfVersion = verMatch[1];
    }

    // Scan full PDF latin1 string (bounded to first & last 512KB for huge files) for structural tags
    const scanBytes = bytes.byteLength <= 1024 * 1024
      ? bytes
      : new Uint8Array([
          ...bytes.slice(0, 512 * 1024),
          ...bytes.slice(bytes.byteLength - 512 * 1024),
        ]);
    const pdfRaw = new TextDecoder("latin1").decode(scanBytes);

    metadata.isEncrypted = /\/Encrypt\b/.test(pdfRaw);
    metadata.isLinearized = /\/Linearized\b/.test(headAscii);

    const hasSig = /\/Type\s*\/Sig\b|\/SigFlags\b|\/SubFilter\s*\/adbe\.pkcs7/i.test(pdfRaw);
    metadata.hasSignatureIndicators = hasSig;
    metadata.signatureStatusNote = hasSig
      ? "Digital signature dictionary markers (/Sig) detected in PDF structure. Cryptographic certificate-chain validity has NOT been verified offline."
      : "No digital signature dictionary detected in PDF.";

    // Count %%EOF markers to estimate incremental revisions
    const eofMatches = pdfRaw.match(/%%EOF/g);
    if (eofMatches) {
      metadata.incrementalRevisionCount = eofMatches.length;
    }

    // Extract PDF Info dictionary strings if not already populated by pdfjs
    if (!metadata.creator) {
      const creatorMatch = pdfRaw.match(/\/Creator\s*\(([^)\\]{1,120})\)/);
      if (creatorMatch) metadata.creator = creatorMatch[1].trim();
    }
    if (!metadata.producer) {
      const prodMatch = pdfRaw.match(/\/Producer\s*\(([^)\\]{1,120})\)/);
      if (prodMatch) metadata.producer = prodMatch[1].trim();
    }
    if (!metadata.author) {
      const authMatch = pdfRaw.match(/\/Author\s*\(([^)\\]{1,120})\)/);
      if (authMatch) metadata.author = authMatch[1].trim();
    }
    if (!metadata.title) {
      const titleMatch = pdfRaw.match(/\/Title\s*\(([^)\\]{1,120})\)/);
      if (titleMatch) metadata.title = titleMatch[1].trim();
    }
    if (!metadata.creationDate) {
      const cDateMatch = pdfRaw.match(/\/CreationDate\s*\(([^)\\]{1,60})\)/);
      if (cDateMatch) metadata.creationDate = cDateMatch[1].trim();
    }
    if (!metadata.modificationDate) {
      const mDateMatch = pdfRaw.match(/\/ModDate\s*\(([^)\\]{1,60})\)/);
      if (mDateMatch) metadata.modificationDate = mDateMatch[1].trim();
    }

    // Extract embedded /URI (...) links
    const uriRegex = /\/URI\s*\(([^)\\]{4,250})\)/g;
    const uris = new Set<string>();
    let uMatch: RegExpExecArray | null;
    while ((uMatch = uriRegex.exec(pdfRaw)) !== null) {
      const u = uMatch[1].trim();
      if (/^https?:\/\/|^mailto:/i.test(u)) {
        uris.add(u);
      }
    }
    if (uris.size > 0) {
      metadata.embeddedUrls = Array.from(uris);
    }
  } else if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    detectedSignature = "zip_openxml_or_odf";
  } else if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    detectedSignature = "ole2_compound";
  } else if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    detectedSignature = "png";
    // PNG IHDR chunk starts at byte 8 (4 bytes length, 4 bytes 'IHDR', 4 bytes width, 4 bytes height)
    if (bytes.byteLength >= 24) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0 && width < 50000 && height < 50000) {
        metadata.imageDimensions = { width, height };
        metadata.imageFormatDetails = `PNG (${width}×${height} px)`;
      }
    }
    // Scan first 64KB of PNG for tEXt Software / Author / Creation Time
    const pngAscii = new TextDecoder("latin1").decode(bytes.slice(0, Math.min(65536, bytes.byteLength)));
    const swMatch = pngAscii.match(/Software\x00([A-Za-z0-9 .,_\-/()]{2,80})/);
    if (swMatch) metadata.exifSoftware = swMatch[1].trim();
    const ctMatch = pngAscii.match(/Creation Time\x00([A-Za-z0-9 :,\-/]{4,40})/);
    if (ctMatch) metadata.exifDateTime = ctMatch[1].trim();
  } else if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    detectedSignature = "jpeg";
    // Parse JPEG markers for SOF dimensions and APP1 EXIF strings
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 4 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2 || offset + 2 + segLen > bytes.byteLength) break;

      // SOF0 / SOF1 / SOF2 markers for dimensions
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 9 < bytes.byteLength) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) {
          metadata.imageDimensions = { width, height };
          metadata.imageFormatDetails = `JPEG (${width}×${height} px)`;
        }
      }

      // APP1 (0xFFE1) EXIF segment
      if (marker === 0xe1) {
        const segAscii = new TextDecoder("latin1").decode(
          bytes.slice(offset + 4, offset + 2 + Math.min(segLen, 8192))
        );
        if (segAscii.startsWith("Exif")) {
          const dtMatch = segAscii.match(/\b(20\d{2}:[01]\d:[0-3]\d\s+[0-2]\d:[0-5]\d:[0-5]\d)\b/);
          if (dtMatch) metadata.exifDateTime = dtMatch[1];
          const swMatch = segAscii.match(
            /\b(Adobe Photoshop[^\x00]{0,40}|GIMP[^\x00]{0,30}|Canva[^\x00]{0,30}|Lightroom[^\x00]{0,30}|Paint\.NET[^\x00]{0,30}|iPhone[^\x00]{0,25}|Samsung[^\x00]{0,25}|Canon[^\x00]{0,25}|Nikon[^\x00]{0,25})\b/i
          );
          if (swMatch) metadata.exifSoftware = swMatch[1].trim();
        }
      }

      offset += 2 + segLen;
    }
  } else if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    detectedSignature = "webp";
  } else if (headAscii.startsWith("{\\rtf")) {
    detectedSignature = "rtf";
  } else {
    // Check if printable UTF-8 / ASCII text
    let hasNull = false;
    for (let i = 0; i < Math.min(1024, bytes.byteLength); i++) {
      if (bytes[i] === 0x00) {
        hasNull = true;
        break;
      }
    }
    detectedSignature = hasNull ? "binary_unknown" : "text";
  }

  // Check if declared extension matches detected signature
  const extToSignatureMap: Record<string, string[]> = {
    pdf: ["pdf"],
    docx: ["zip_openxml_or_odf"],
    xlsx: ["zip_openxml_or_odf"],
    pptx: ["zip_openxml_or_odf"],
    odt: ["zip_openxml_or_odf"],
    ods: ["zip_openxml_or_odf"],
    odp: ["zip_openxml_or_odf"],
    doc: ["ole2_compound", "text", "zip_openxml_or_odf"],
    xls: ["ole2_compound", "text", "zip_openxml_or_odf"],
    ppt: ["ole2_compound", "zip_openxml_or_odf"],
    csv: ["text"],
    txt: ["text"],
    md: ["text"],
    html: ["text"],
    rtf: ["rtf", "text"],
    png: ["png"],
    jpg: ["jpeg"],
    jpeg: ["jpeg"],
    webp: ["webp"],
  };

  const allowedSigs = extToSignatureMap[declaredExtension];
  const extensionMatchesSignature = allowedSigs
    ? allowedSigs.includes(detectedSignature)
    : true;

  metadata.signatureMatchesExtension = extensionMatchesSignature;

  return {
    detectedSignature,
    declaredExtension,
    extensionMatchesSignature,
    metadata,
  };
}

/**
 * Generates the comprehensive File Authenticity & Fraud Signals Report
 * Works 100% deterministically without an AI API key.
 */
export function analyzeDocumentFraudSignals(doc: ParsedDocumentData): FraudAnalysisReport {
  const meta: ExtractedDocumentMetadata = doc.documentMetadata || {};
  const fileName = doc.originalFilename || doc.fileName || "Document";
  const lastDot = fileName.lastIndexOf(".");
  const declaredExt = doc.declaredExtension || (lastDot !== -1 ? fileName.slice(lastDot + 1).toLowerCase() : "txt");
  const detectedSig = doc.detectedFormat || declaredExt;

  // Synthetic demo files intentionally use UTF-8 text streams with .pdf/.docx names; do not flag demo fixtures as spoofed extensions
  const extensionMatches = doc.isDemo ? true : doc.extensionMismatch !== true;

  const metadataFields: { key: string; value: string; note?: string }[] = [];
  const metadataInconsistencies: FraudSignalFinding[] = [];
  const fileConsistencyChecks: FraudSignalFinding[] = [];
  const contentRiskSignals: FraudSignalFinding[] = [];
  const suspiciousPaymentInstructions: FraudSignalFinding[] = [];
  const linkAndContactWarnings: FraudSignalFinding[] = [];

  let findingCounter = 1;

  // 1. Populate Metadata Fields
  if (meta.title) metadataFields.push({ key: "Document Title", value: meta.title });
  if (meta.author) metadataFields.push({ key: "Author", value: meta.author });
  if (meta.subject) metadataFields.push({ key: "Subject", value: meta.subject });
  if (meta.creator) metadataFields.push({ key: "Creator Application", value: meta.creator });
  if (meta.producer) metadataFields.push({ key: "PDF Producer", value: meta.producer });
  if (meta.creationDate) {
    const iso = parsePdfDateString(meta.creationDate);
    metadataFields.push({
      key: "Embedded Creation Date",
      value: iso && iso !== meta.creationDate ? `${iso} (Raw: ${meta.creationDate})` : meta.creationDate,
      note: "Embedded metadata timestamp (can be modified by authoring tools; does not prove when content was authored).",
    });
  }
  if (meta.modificationDate) {
    const iso = parsePdfDateString(meta.modificationDate);
    metadataFields.push({
      key: "Embedded Modification Date",
      value: iso && iso !== meta.modificationDate ? `${iso} (Raw: ${meta.modificationDate})` : meta.modificationDate,
    });
  }
  if (meta.pdfVersion) metadataFields.push({ key: "PDF Specification Version", value: `PDF ${meta.pdfVersion}` });
  if (meta.isEncrypted !== undefined) {
    metadataFields.push({ key: "Encryption Flag", value: meta.isEncrypted ? "Encrypted / Permission-Restricted" : "Unencrypted" });
  }
  if (meta.incrementalRevisionCount !== undefined) {
    metadataFields.push({
      key: "PDF EOF Revision Markers",
      value: `${meta.incrementalRevisionCount} revision marker(s)`,
      note: meta.incrementalRevisionCount > 2 ? "Multiple incremental saves detected in PDF trailer." : "Single or standard save structure.",
    });
  }
  if (meta.imageDimensions) {
    metadataFields.push({
      key: "Image Dimensions",
      value: `${meta.imageDimensions.width} × ${meta.imageDimensions.height} px`,
    });
  }
  if (meta.exifSoftware) {
    metadataFields.push({ key: "Image Software / Device Tag", value: meta.exifSoftware });
  }
  if (meta.exifDateTime) {
    metadataFields.push({ key: "EXIF Timestamp", value: meta.exifDateTime });
  }

  const signatureNote =
    meta.signatureStatusNote ||
    (declaredExt === "pdf"
      ? "No cryptographic signature dictionary detected or verified. Note: DOCULENS does not perform third-party PKI certificate chain validation."
      : "Digital signature inspection is only applicable to PDF/signed container formats.");

  // 2. File Consistency Checks
  if (!extensionMatches) {
    fileConsistencyChecks.push({
      id: `fraud_cons_${findingCounter++}`,
      category: "file_consistency",
      title: "File Extension & Binary Signature Mismatch",
      label: "Strong warning signal",
      explanation: `File "${fileName}" has a ".${declaredExt}" extension, but its binary magic bytes match "${detectedSig}".`,
      whySuspicious: "Extension spoofing or file renaming can be used to disguise a file's true origin or bypass basic document filters.",
      supportingEvidence: `Declared extension: .${declaredExt} | Detected signature: ${detectedSig}`,
      recommendation: "Inspect the file in a sandboxed viewer and verify with the sender why the file format does not match its extension.",
    });
  } else {
    fileConsistencyChecks.push({
      id: `fraud_cons_${findingCounter++}`,
      category: "file_consistency",
      title: "File Signature & Extension Alignment",
      label: "No warning detected",
      explanation: `File extension (.${declaredExt}) is consistent with the detected format (${detectedSig}).`,
      supportingEvidence: `Format: ${detectedSig.toUpperCase()} (${(doc.fileSizeBytes || 0).toLocaleString()} bytes)`,
    });
  }

  // Check CreationDate vs ModDate order
  if (meta.creationDate && meta.modificationDate) {
    const cIso = parsePdfDateString(meta.creationDate);
    const mIso = parsePdfDateString(meta.modificationDate);
    const cMs = cIso ? Date.parse(cIso) : NaN;
    const mMs = mIso ? Date.parse(mIso) : NaN;
    if (!isNaN(cMs) && !isNaN(mMs)) {
      if (mMs < cMs - 60000) {
        metadataInconsistencies.push({
          id: `fraud_meta_${findingCounter++}`,
          category: "metadata_findings",
          title: "Modification Timestamp Precedes Creation Timestamp",
          label: "Potentially suspicious",
          explanation: `The embedded Modification Date (${mIso}) is earlier than the embedded Creation Date (${cIso}).`,
          whySuspicious: "Standard authoring software sets Modification Date equal to or later than Creation Date. Reversed timestamps suggest manual metadata editing or clock manipulation.",
          supportingEvidence: `CreationDate: ${meta.creationDate} | ModDate: ${meta.modificationDate}`,
          recommendation: "Request an original copy or verify the document directly from the official portal.",
        });
      }
    }
  }

  // Check image editing software tags on official documents
  const editingToolText = `${meta.creator || ""} ${meta.producer || ""} ${meta.exifSoftware || ""}`;
  if (/\b(?:photoshop|gimp|paint\.net|canva|pixlr|ilovepdf|smallpdf|sejda)\b/i.test(editingToolText)) {
    metadataInconsistencies.push({
      id: `fraud_meta_${findingCounter++}`,
      category: "metadata_findings",
      title: "Consumer Image / PDF Editing Tool Detected in Metadata",
      label: "Needs verification",
      explanation: `Document metadata indicates processing by "${editingToolText.trim()}".`,
      whySuspicious: "While legitimate teams sometimes use online PDF mergers or design tools, official certificates, bank statements, or government notices edited in raster/online editors warrant careful verification.",
      supportingEvidence: `Authoring/Producer tag: "${editingToolText.trim()}"`,
      recommendation: "Verify the document reference number and amounts against the issuing authority's official registry.",
    });
  }

  if (metadataFields.length === 0) {
    metadataInconsistencies.push({
      id: `fraud_meta_${findingCounter++}`,
      category: "metadata_findings",
      title: "Limited or Absent Embedded Metadata",
      label: "Informational",
      explanation: "No embedded author, creator, or creation timestamp metadata fields were present in this file.",
      whySuspicious: "Missing metadata is NOT proof of fraud (many plain-text exports, spreadsheets, and privacy-sanitized PDFs omit metadata by design).",
      recommendation: "Evaluate the document based on its verifiable content, reference numbers, and official source channel.",
    });
  }

  // 3. Text-Based Scam & Content Risk Signals (Page-by-Page with exact quotes)
  const paymentScamPatterns: {
    title: string;
    label: FraudWarningLabel;
    regex: RegExp;
    whySuspicious: string;
    recommendation: string;
  }[] = [
    {
      title: "Upfront / Advance Fee Demand for Scholarship, Grant, or Job",
      label: "Strong warning signal",
      regex: /(?:pay|transfer|remit|send|deposit)\s+(?:a\s+)?(?:refundable\s+|mandatory\s+)?(?:security\s+deposit|processing\s+fee|verification\s+fee|visa\s+fee|training\s+fee|award\s+release\s+fee|registration\s+charge)[^.\n]{0,90}(?:to\s+receive|before\s+disburs|to\s+claim\s+your\s+scholarship|to\s+confirm\s+your\s+job\s+offer|via\s+whatsapp|personal\s+account)/i,
      whySuspicious: "Legitimate scholarships and employers do not demand advance release fees, security deposits, or personal bank transfers to unlock awards or job offers.",
      recommendation: "Do not send funds. Contact the institution using phone numbers or emails listed on their official verified website.",
    },
    {
      title: "Untraceable Payment Method Requested (Crypto / Gift Cards / Wire)",
      label: "Strong warning signal",
      regex: /\b(?:bitcoin|usdt|ethereum|crypto\s*wallet|gift\s*cards?|itunes\s*card|steam\s*card|western\s*union|moneygram|cash\s*deposit\s*only|wire\s*to\s*personal\s*account)\b[^.\n]{0,100}/i,
      whySuspicious: "Requests for payment via cryptocurrency, gift cards, or money-transfer services are classic indicators of advance-fee fraud.",
      recommendation: "Never remit procurement, academic, or employment payments via gift cards, cryptocurrency, or personal wire transfers.",
    },
    {
      title: "Urgent Bank Account / Wire Instruction Change Notice",
      label: "Potentially suspicious",
      regex: /(?:urgent\s+notice\s*:\s*)?(?:our\s+bank\s+account\s+(?:details\s+)?have\s+changed|updated\s+(?:wire|banking|remittance)\s+instructions|disregard\s+previous\s+(?:bank|payment)\s+details|route\s+all\s+future\s+payments\s+to\s+new\s+account)[^.\n]{0,100}/i,
      whySuspicious: "Business Email Compromise (BEC) and invoice-redirection scams frequently use counterfeit addenda claiming a vendor or authority changed its bank account.",
      recommendation: "Perform out-of-band callback verification using a previously known phone number before changing any beneficiary bank account.",
    },
  ];

  const contentScamPatterns: {
    title: string;
    label: FraudWarningLabel;
    regex: RegExp;
    whySuspicious: string;
    recommendation: string;
  }[] = [
    {
      title: "Request for Passwords, OTPs, PINs, or Secret Credentials",
      label: "Strong warning signal",
      regex: /(?:provide|enter|send|share|submit|disclose)\s+(?:your\s+)?(?:online\s+banking\s+password|one[-\s]time\s+password|\botp\b|atm\s+pin|cvv\s+number|netbanking\s+login|private\s+recovery\s+phrase)[^.\n]{0,80}/i,
      whySuspicious: "No legitimate application, tender, or verification workflow requires applicants to disclose passwords, OTPs, PINs, or card CVV codes.",
      recommendation: "Never share passwords, OTPs, or PINs. Report the document as a credential-phishing attempt.",
    },
    {
      title: "High-Pressure Coercive Urgency or Threat Language",
      label: "Potentially suspicious",
      regex: /(?:pay\s+immediately\s+within\s+\d+\s+hours|failure\s+to\s+pay\s+immediately\s+will\s+result\s+in\s+(?:arrest|warrant|criminal\s+prosecution)|keep\s+this\s+transaction\s+strictly\s+secret|do\s+not\s+discuss\s+this\s+payment\s+with\s+bank\s+staff)[^.\n]{0,90}/i,
      whySuspicious: "Coercive countdown threats or instructions to hide payments from bank staff are hallmarks of social-engineering scams.",
      recommendation: "Pause immediately and verify through independent legal or institutional channels.",
    },
    {
      title: "Unsolicited Prize, Lottery, or Guaranteed-Return Claim",
      label: "Strong warning signal",
      regex: /(?:100%\s+guaranteed\s+(?:profit|return|selection|visa)|you\s+have\s+been\s+selected\s+as\s+a\s+winner\s+without\s+applying|guaranteed\s+double\s+return|risk[-\s]free\s+investment\s+guarantee)[^.\n]{0,90}/i,
      whySuspicious: "Guaranteed investment returns or unsolicited award notifications promising 100% selection without formal evaluation are deceptive.",
      recommendation: "Verify the programme in official government or institutional directories.",
    },
  ];

  for (const page of doc.pages) {
    const pText = page.text || "";
    if (!pText.trim()) continue;

    for (const pat of paymentScamPatterns) {
      const m = pText.match(pat.regex);
      if (m && !suspiciousPaymentInstructions.some(f => f.title === pat.title)) {
        suspiciousPaymentInstructions.push({
          id: `fraud_pay_${findingCounter++}`,
          category: "suspicious_payment",
          title: pat.title,
          label: pat.label,
          explanation: `Detected suspicious payment phrase on Page ${page.pageNumber}.`,
          whySuspicious: pat.whySuspicious,
          supportingEvidence: m[0].replace(/\s+/g, " ").trim(),
          sourceLocation: { page: page.pageNumber, snippet: m[0].replace(/\s+/g, " ").trim() },
          recommendation: pat.recommendation,
        });
      }
    }

    for (const pat of contentScamPatterns) {
      const m = pText.match(pat.regex);
      if (m && !contentRiskSignals.some(f => f.title === pat.title)) {
        contentRiskSignals.push({
          id: `fraud_cnt_${findingCounter++}`,
          category: "content_risk_signals",
          title: pat.title,
          label: pat.label,
          explanation: `Detected high-risk phrasing on Page ${page.pageNumber}.`,
          whySuspicious: pat.whySuspicious,
          supportingEvidence: m[0].replace(/\s+/g, " ").trim(),
          sourceLocation: { page: page.pageNumber, snippet: m[0].replace(/\s+/g, " ").trim() },
          recommendation: pat.recommendation,
        });
      }
    }
  }

  // 4. Link and Contact Consistency Checks
  // Check for free personal email domains used in official government/university/enterprise documents
  const claimsOfficialIssuer = /\b(?:ministry\s+of|government\s+of|department\s+of|national\s+authority|directorate|public\s+works|federal|university\s+admissions|procurement\s+authority)\b/i.test(
    doc.fullText
  );
  const emailRegex = /\b([A-Za-z0-9._%+-]+@(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|aol\.com|protonmail\.com|ymail\.com|rediffmail\.com))\b/gi;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = emailRegex.exec(doc.fullText)) !== null) {
    const freeEmail = emailMatch[1];
    if (claimsOfficialIssuer && !linkAndContactWarnings.some(w => w.supportingEvidence?.includes(freeEmail))) {
      // Find page number
      const matchedPage = doc.pages.find(p => p.text.includes(freeEmail))?.pageNumber || 1;
      linkAndContactWarnings.push({
        id: `fraud_lnk_${findingCounter++}`,
        category: "link_and_contact",
        title: "Free Personal Email Domain Used in Official-Looking Notice",
        label: "Potentially suspicious",
        explanation: `The document references an official authority or ministry but lists a free consumer email address (${freeEmail}) on Page ${matchedPage}.`,
        whySuspicious: "Official government ministries, universities, and corporate procurement offices typically use institutional domains (e.g., .gov, .edu, .org, or corporate domains) rather than free personal webmail accounts.",
        supportingEvidence: freeEmail,
        sourceLocation: { page: matchedPage, snippet: freeEmail },
        recommendation: "Confirm on the organisation's official website whether this email address is an authorized contact channel.",
      });
    }
  }

  // Scan URLs in text and embedded PDF URIs
  const urlRegex = /\bhttps?:\/\/[^\s)"'<>]+/gi;
  const allUrls = new Set<string>(meta.embeddedUrls || []);
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRegex.exec(doc.fullText)) !== null) {
    allUrls.add(urlMatch[0].replace(/[.,;]+$/, ""));
  }

  for (const url of allUrls) {
    const matchedPage = doc.pages.find(p => p.text.includes(url))?.pageNumber || 1;
    // Raw IP URL check
    if (/^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i.test(url)) {
      linkAndContactWarnings.push({
        id: `fraud_lnk_${findingCounter++}`,
        category: "link_and_contact",
        title: "Raw IP Address Link Detected",
        label: "Strong warning signal",
        explanation: `Link points directly to a numeric IP address (${url}) instead of a registered domain name.`,
        whySuspicious: "Legitimate portals use registered domain names with TLS certificates rather than raw IP addresses.",
        supportingEvidence: url,
        sourceLocation: { page: matchedPage, snippet: url },
        recommendation: "Do not open or submit credentials to raw IP links.",
      });
    } else if (/^http:\/\//i.test(url) && !/localhost|127\.0\.0\.1/.test(url)) {
      linkAndContactWarnings.push({
        id: `fraud_lnk_${findingCounter++}`,
        category: "link_and_contact",
        title: "Unencrypted HTTP Link Detected",
        label: "Low concern",
        explanation: `URL "${url}" uses unencrypted HTTP rather than HTTPS.`,
        whySuspicious: "Submitting personal documents or credentials over plain HTTP exposes data in transit.",
        supportingEvidence: url,
        sourceLocation: { page: matchedPage, snippet: url },
        recommendation: "Verify whether the official portal supports secure HTTPS before uploading sensitive files.",
      });
    } else if (/\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy)\//i.test(url)) {
      linkAndContactWarnings.push({
        id: `fraud_lnk_${findingCounter++}`,
        category: "link_and_contact",
        title: "Obfuscated URL Shortener Link Detected",
        label: "Needs verification",
        explanation: `Document contains a shortened link (${url}) that hides the destination domain.`,
        whySuspicious: "URL shorteners can mask phishing destinations or unauthorized third-party forms.",
        supportingEvidence: url,
        sourceLocation: { page: matchedPage, snippet: url },
        recommendation: "Preview the expanded destination domain before clicking or entering any personal data.",
      });
    } else if (/xn--/i.test(url)) {
      linkAndContactWarnings.push({
        id: `fraud_lnk_${findingCounter++}`,
        category: "link_and_contact",
        title: "Internationalized Punycode (xn--) Domain Detected",
        label: "Potentially suspicious",
        explanation: `URL (${url}) uses punycode encoding, which can be used for lookalike homograph domains.`,
        whySuspicious: "Attackers sometimes register lookalike Unicode characters to impersonate official domains.",
        supportingEvidence: url,
        sourceLocation: { page: matchedPage, snippet: url },
        recommendation: "Type the official organisation URL manually in your browser instead of clicking the embedded link.",
      });
    }
  }

  // 5. Compute Transparent Risk Score & Overall Label
  const allFindings: FraudSignalFinding[] = [
    ...metadataInconsistencies,
    ...fileConsistencyChecks,
    ...contentRiskSignals,
    ...suspiciousPaymentInstructions,
    ...linkAndContactWarnings,
  ];

  let scorePoints = 0;
  const scoreComponents: string[] = [];

  for (const f of allFindings) {
    if (f.label === "Strong warning signal") {
      scorePoints += 35;
      scoreComponents.push(`+35 (${f.title})`);
    } else if (f.label === "Potentially suspicious") {
      scorePoints += 20;
      scoreComponents.push(`+20 (${f.title})`);
    } else if (f.label === "Needs verification") {
      scorePoints += 10;
      scoreComponents.push(`+10 (${f.title})`);
    } else if (f.label === "Low concern") {
      scorePoints += 5;
      scoreComponents.push(`+5 (${f.title})`);
    }
  }

  const riskScore = Math.min(100, scorePoints);
  let overallLabel: FraudWarningLabel = "No warning detected";
  if (allFindings.some(f => f.label === "Strong warning signal") || riskScore >= 50) {
    overallLabel = "Strong warning signal";
  } else if (allFindings.some(f => f.label === "Potentially suspicious") || riskScore >= 25) {
    overallLabel = "Potentially suspicious";
  } else if (allFindings.some(f => f.label === "Needs verification") || riskScore >= 10) {
    overallLabel = "Needs verification";
  } else if (allFindings.some(f => f.label === "Low concern") || riskScore > 0) {
    overallLabel = "Low concern";
  } else if (allFindings.some(f => f.label === "Informational")) {
    overallLabel = "Informational";
  }

  const riskFormulaExplanation =
    scoreComponents.length > 0
      ? `Risk Index = ${riskScore}/100, calculated transparently from detected signals: ${scoreComponents.join(", ")}. (Strong warning = +35, Potentially suspicious = +20, Needs verification = +10, Low concern = +5, capped at 100).`
      : `Risk Index = 0/100. Zero extension mismatches, timestamp inversions, scam payment phrases, or suspicious URL patterns were detected in the file structure or extracted text.`;

  const summaryStatement =
    riskScore === 0
      ? "No structural inconsistencies or text-based scam patterns were detected. Note: Absence of warnings does not certify that a document is 100% genuine; always verify critical awards, tenders, or banking instructions through the issuing organisation's official portal."
      : `Detected ${allFindings.filter(f => f.label !== "No warning detected" && f.label !== "Informational").length} warning signal(s) requiring human verification (${overallLabel}). Review the supporting evidence quotes below before acting on payment or submission instructions.`;

  const verificationRecommendations: string[] = [
    "Cross-check the document reference number and publication notice directly on the issuing authority's official website.",
    ...(suspiciousPaymentInstructions.length > 0
      ? ["Do NOT remit any advance fees, security deposits, or wire transfers until verified via an independent phone call to the institution."]
      : []),
    ...(linkAndContactWarnings.length > 0
      ? ["Navigate to the official portal by typing the known domain into your browser rather than clicking embedded links or replying to free webmail addresses."]
      : []),
    ...( !extensionMatches
      ? ["Verify why the file extension does not match its binary container signature before opening in external desktop software."]
      : []),
    "Treat embedded PDF/image metadata as informational signals only — metadata can be stripped or edited and is neither proof of authenticity nor proof of forgery on its own.",
  ];

  return {
    overallLabel,
    warningLabel: overallLabel,
    riskScore,
    riskIndexScore: riskScore,
    riskFormulaExplanation,
    summaryStatement,
    summary: summaryStatement,
    disclaimer: "DOCULENS never declares a document '100% genuine' or 'definitely fake' and does not perform external cryptographic PKI certificate-authority validation.",
    findings: allFindings,
    methodologyAndLimitations: [
      "Deterministic inspection checks binary magic bytes, embedded PDF/image headers, timestamp ordering, URL patterns, and known advance-fee / phishing phrases.",
      "Metadata can be edited, stripped, or regenerated by standard PDF printers and document converters; missing metadata is inconclusive.",
      "DOCULENS never declares a document '100% genuine' or 'definitely fake' and does not perform external cryptographic PKI certificate-authority validation.",
    ],
    fileInformation: {
      fileName,
      declaredExtension: `.${declaredExt}`,
      declaredMimeType: doc.fileType || "application/octet-stream",
      detectedMagicSignature: detectedSig.toUpperCase(),
      extensionMatchesSignature: extensionMatches,
      fileSizeBytes: doc.fileSizeBytes || 0,
      pageCount: doc.pages.length,
      imageDimensions: meta.imageDimensions,
      sha256Hash: doc.contentHash,
    },
    metadataFindings: {
      hasMetadata: metadataFields.length > 0,
      fields: metadataFields,
      signatureNote,
      inconsistencies: metadataInconsistencies,
    },
    fileConsistencyChecks,
    contentRiskSignals,
    suspiciousPaymentInstructions,
    linkAndContactWarnings,
    verificationRecommendations,
  };
}
