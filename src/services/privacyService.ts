/**
 * DOCULENS Deterministic Client-Side Privacy & Redaction Engine
 *
 * Scans text for sensitive entities before any external AI call:
 * - companyName (single-line bounded regex, never spans newlines or captures clauses)
 * - personName
 * - emailAddress
 * - phoneNumber (US, international, Indian +91, extensions)
 * - personalAddress
 * - governmentId (SSN, PAN, Aadhaar, EIN, GSTIN, Passport)
 * - bankAccount (Account numbers, IBAN, IFSC, Routing)
 * - paymentCard (Luhn-checked 13-19 digit cards)
 * - passwordOrToken (API keys, Bearer tokens, secret keys)
 */

import { APP_CONFIG } from "../config/appConfig";
import {
  SensitiveCategory,
  SensitiveDetection,
  VisibilityState,
} from "../types";

export function verifyLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  // Reject all-zeros or repeated single digit
  if (/^(\d)\1+$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const NON_PERSON_TITLE_PHRASES = new Set([
  "Western Climate",
  "Climate Initiative",
  "Technical Proposal",
  "Cost Proposal",
  "Executive Summary",
  "Project Manager",
  "Program Manager",
  "Solutions Architect",
  "Request For",
  "Table Of",
  "Scope Of",
  "Master Services",
  "Services Agreement",
  "Notice Inviting",
  "Smart City",
  "Future Leaders",
  "Global Tech",
]);

export function scanSensitiveEntities(
  textOrPages: string | Array<{ text?: string }>,
  customVisibilityPolicy?: Partial<Record<SensitiveCategory, VisibilityState>>
): {
  detections: SensitiveDetection[];
  redactedText: string;
} {
  const text = Array.isArray(textOrPages)
    ? textOrPages.map((p) => p.text || "").join("\n\n")
    : textOrPages;
  if (!text) {
    return { detections: [], redactedText: "" };
  }

  const policy = {
    ...APP_CONFIG.defaultVisibilityPolicy,
    ...(customVisibilityPolicy || {}),
  };

  const detections: SensitiveDetection[] = [];
  let counter = 1;

  const addDetection = (
    category: SensitiveCategory,
    rawText: string,
    start: number,
    end: number,
    extra?: Partial<SensitiveDetection>
  ) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    // Prevent overlapping duplicate detections
    if (detections.some(d => start < d.end && end > d.start)) {
      return;
    }
    const visibility = policy[category] || "HIDDEN";
    const tagPrefix = category.replace(/([A-Z])/g, "_$1").toUpperCase();
    const maskedText = `[REDACTED_${tagPrefix}_${counter}]`;

    detections.push({
      id: `sens_${counter++}`,
      category,
      rawText: trimmed,
      maskedText,
      start,
      end,
      visibility,
      ...extra,
    });
  };

  // 1. Passwords, API keys & Bearer tokens
  const secretRegex =
    /\b(?:sk-or-v1-[A-Za-z0-9]{20,}|AIzaSy[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._\-]{20,}|(?:password|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?([^\s'"]{8,60})['"]?)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = secretRegex.exec(text)) !== null) {
    addDetection("passwordOrToken", match[0], match.index, match.index + match[0].length);
  }

  // 2. Email addresses
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  while ((match = emailRegex.exec(text)) !== null) {
    addDetection("emailAddress", match[0], match.index, match.index + match[0].length);
  }

  // 3. Government IDs (SSN, PAN, GSTIN, Aadhaar, EIN)
  const govIdRegex =
    /\b(?:\d{3}-\d{2}-\d{4}|[A-Z]{5}[0-9]{4}[A-Z]|\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]|(?:EIN|FEIN|TIN|SSN|Aadhaar|Passport\s*No\.?)\s*[:#-]?\s*[A-Z0-9-]{6,15})\b/g;
  while ((match = govIdRegex.exec(text)) !== null) {
    addDetection("governmentId", match[0], match.index, match.index + match[0].length);
  }

  // 4. Bank accounts / IBAN / IFSC
  const bankRegex =
    /\b(?:(?:Account\s*(?:No\.?|Number|#)|IBAN|IFSC|Routing\s*(?:No\.?|Number))\s*[:#-]?\s*[A-Z0-9 -]{6,28}|[A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/gi;
  while ((match = bankRegex.exec(text)) !== null) {
    addDetection("bankAccount", match[0], match.index, match.index + match[0].length);
  }

  // 5. Payment Cards (13-19 digits with Luhn verification)
  const cardCandidateRegex = /\b(?:\d[ -]*?){13,19}\b/g;
  while ((match = cardCandidateRegex.exec(text)) !== null) {
    const raw = match[0];
    if (verifyLuhn(raw)) {
      addDetection("paymentCard", raw, match.index, match.index + raw.length, {
        isLuhnValid: true,
      });
    }
  }

  // 6. Phone numbers (US, International, Indian +91, UK +44)
  const phoneRegex =
    /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?|\b\d{3,5}[\s.-])\d{3,4}[\s.-]\d{3,4}\b|\b\+\d{1,3}\s?\d{8,12}\b/g;
  while ((match = phoneRegex.exec(text)) !== null) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15 && !/^(19|20)\d{2}(19|20)\d{2}$/.test(digits)) {
      addDetection("phoneNumber", match[0], match.index, match.index + match[0].length);
    }
  }

  // 7. Personal / Street Addresses (single-line bounded)
  const addressRegex =
    /\b\d{1,6}[ \t]+[A-Z][A-Za-z0-9 .,'-]{2,35}[ \t]+(?:Street|St\.|Avenue|Ave\.|Boulevard|Blvd\.|Road|Rd\.|Drive|Dr\.|Lane|Ln\.|Way|Court|Ct\.|Suite|Ste\.|Parkway|Pkwy\.)(?:,[ \t]*[A-Za-z .]+)?(?:,[ \t]*[A-Z]{2}[ \t]+\d{5}(?:-\d{4})?)?\b/g;
  while ((match = addressRegex.exec(text)) !== null) {
    if (!match[0].includes("\n")) {
      addDetection("personalAddress", match[0], match.index, match.index + match[0].length);
    }
  }

  // 8. Company / Organization Names (Strictly single-line, max 5 words before legal suffix, stops at verbs)
  const orgRegex =
    /\b([A-Z][A-Za-z0-9&'-]*(?:[ \t]+[A-Z][A-Za-z0-9&'-]*){0,4}[ \t]+(?:Pvt\.?[ \t]+Ltd\.?|Private[ \t]+Limited|Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|L\.L\.C\.?|P\.C\.?|LLP|GmbH|PLC))/g;
  while ((match = orgRegex.exec(text)) !== null) {
    const candidate = match[1];
    if (candidate.includes("\n") || candidate.includes("\r") || candidate.length > 65) {
      continue;
    }
    if (
      /\b(?:is|are|was|were|must|shall|will|may|can|has|have|had|inviting|requesting|submitting|located|established|including|under|for|with|from|that|which)\b/i.test(
        candidate
      )
    ) {
      continue;
    }
    addDetection("companyName", candidate, match.index, match.index + candidate.length);
  }

  // 9. Person Names (Preceded by explicit salutation or role label on the same line)
  const personRegex =
    /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Attn:|Contact\s+Person:|Prepared\s+by:|Submitted\s+by:|Authorized\s+Signatory:)[ \t]+([A-Z][a-z]{1,20}[ \t]+(?:[A-Z]\.?[ \t]+)?[A-Z][a-z]{1,25})\b/g;
  while ((match = personRegex.exec(text)) !== null) {
    const personName = match[1];
    if (!NON_PERSON_TITLE_PHRASES.has(personName)) {
      const nameStart = match.index + match[0].indexOf(personName);
      addDetection("personName", personName, nameStart, nameStart + personName.length);
    }
  }

  const redactedText = buildRedactedText(text, detections);
  return { detections, redactedText };
}

export function buildRedactedText(
  originalText: string,
  detections: SensitiveDetection[]
): string {
  if (!originalText || detections.length === 0) return originalText;

  const hiddenDetections = detections
    .filter(d => d.visibility === "HIDDEN")
    .sort((a, b) => b.start - a.start);

  let output = originalText;
  for (const d of hiddenDetections) {
    if (d.start >= 0 && d.end <= output.length && d.start < d.end) {
      output = output.slice(0, d.start) + d.maskedText + output.slice(d.end);
    } else if (d.rawText) {
      output = output.split(d.rawText).join(d.maskedText);
    }
  }
  return output;
}
