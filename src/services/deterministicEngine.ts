/**
 * DOCULENS Universal Deterministic Document Intelligence Engine
 *
 * Runs 100% locally and offline without requiring an external AI key.
 * Genuinely parses extracted document text and tables to dynamically identify:
 * 1. Headings, programme names & structural sections
 * 2. Context-aware events, milestones & primary submission deadlines (20 distinct event types)
 * 3. Financial figures, currencies (₹, $, €, £, CAD), Indian lakh/crore formats & 22 financial categories
 * 4. Evidence-grounded requirements (Mandatory, Conditional, Recommended, Informational) — NEVER invents requirements
 * 5. Risk warnings, conflicting deadlines, penalty clauses & File Authenticity integration
 * 6. Prioritized action checklist with source citations
 * 7. Indexed Q&A search with page/cell provenance
 */

import {
  ActionChecklistItem,
  DeadlineTemporalStatus,
  DetailedDateEventType,
  DetailedFinancialCategory,
  DocumentCategory,
  DocumentQAPair,
  FinancialItem,
  FullDocumentAnalysis,
  ImportantDateItem,
  ParsedDocumentData,
  RequirementClassification,
  RequirementItem,
  RiskWarningItem,
  SourceLocation,
} from "../types";
import { CATEGORY_TEMPLATES } from "./templateEngine";
import { extractRfpIntelligence } from "./rfpEngine";
import { analyzeDocumentFraudSignals } from "./fraudScanner";

/**
 * Date regex patterns covering month-name dates, ranges, ISO dates, and numeric dates
 */
const DATE_PATTERNS = [
  // Date ranges e.g. "August 30 – Sept 10, 2021" or "September 13 to October 8, 2021"
  /\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\s*(?:[-–—]|to)\s*(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?\d{1,2},?\s+\d{4})\b/gi,
  // Day Month Year e.g. "30th December 2026", "15 October 2026"
  /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s+\d{4})\b/gi,
  // Month Day, Year e.g. "August 20, 2021", "Dec 30, 2026"
  /\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/gi,
  // ISO YYYY-MM-DD
  /\b(?:\d{4}[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01]))\b/g,
  // DD-MMM-YYYY e.g. 15-Nov-2026
  /\b(?:\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4})\b/gi,
  // Numeric DD/MM/YYYY or MM/DD/YYYY with 4-digit year
  /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/g,
  // Day Month without year when preceded by deadline/date context
  /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))\b/gi,
];

/**
 * Multi-currency and Indian format patterns
 * Captures: ₹50,000 | ₹1,50,000 | ₹5 lakh | ₹2.5 crore | Rs. 2,00,000 | INR 50,000 | $3,500,000 | $355 million | £10,000 | €12,500
 */
const CURRENCY_AND_AMOUNT_REGEX =
  /(?:(₹|\$|€|£|Rs\.?|INR|USD|EUR|GBP|CAD)(?:\s*[$₹€£])?\s*)([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(lakh|lakhs|lac|lacs|crore|crores|cr|million|billion|thousand|k)\b)?/gi;

/**
 * Dynamically extracts all headings and numbered sections from document text
 */
export function extractDocumentSections(text: string): { title: string; lineIndex: number; page?: number }[] {
  const lines = text.split(/\r?\n/);
  const sections: { title: string; lineIndex: number; page?: number }[] = [];
  let currentPage = 1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    if (rawLine.includes("--- [Page") || rawLine.includes("[Page")) {
      const match = rawLine.match(/\[Page\s+(\d+)\]/i);
      if (match) currentPage = parseInt(match[1], 10);
      continue;
    }

    if (
      /^(?:#+\s+|SECTION\s+\d+[:.]?|\d+(?:\.\d+)?[\.\)]\s+|ARTICLE\s+[IVXLCDM\d]+[:.]?)\s*([A-Z0-9][A-Za-z0-9\s,&/\-–—()]{3,85})$/i.test(
        rawLine
      )
    ) {
      sections.push({
        title: rawLine.replace(/^[#\s]+/, "").trim(),
        lineIndex: i,
        page: currentPage,
      });
    }
  }

  return sections;
}

/**
 * Classifies a date occurrence based on its immediate line, table row, and section context.
 * Never defaults to "official_deadline" without explicit evidence.
 */
function classifyDateFromContext(
  rawDate: string,
  lineContext: string,
  widerContext: string,
  sectionTitle?: string
): {
  label: string;
  eventType: DetailedDateEventType;
  legacyType: ImportantDateItem["type"];
  isExplicit: boolean;
  confidence: number;
} {
  const ctx = `${lineContext} ${sectionTitle || ""}`.toLowerCase();
  const fullCtx = `${lineContext} ${widerContext}`.toLowerCase();

  // 1. Check for historical / lookback / background references FIRST
  // e.g. "as of January 1, 2021", "from January 1, 2018", "established in 2013", "since January 1, 2013", "prior to"
  if (
    /\b(?:as\s+of|since|established\s+in|founded\s+in|incorporated\s+in|from\s+[a-z]+\s+\d{1,2},?\s+\d{4}\s+through|within\s+the\s+past|preceding|historical|in\s+fiscal\s+year|for\s+example\s+in)\b/i.test(
      lineContext
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Historical / Baseline Reference Date",
      eventType: "historical_event",
      legacyType: "reminder_date",
      isExplicit: true,
      confidence: 0.92,
    };
  }

  // 2. RFP Release Date (must NOT be classified as submission deadline)
  if (/\b(?:rfp\s+release|release\s+date|solicitation\s+release|tender\s+release|date\s+of\s+issue|issued\s+on)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "RFP / Solicitation Release Date",
      eventType: "rfp_release_date",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.96,
    };
  }

  // 3. Publication / Notification / Q&A Responses Release Date (must NOT be submission deadline)
  if (
    /\b(?:date\s+of\s+notification|publication\s+date|published\s+on|responses?\s+released|q\s*&\s*a\s+responses?|addendum\s+issued|clarification\s+responses?)\b/i.test(
      ctx
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Publication / Responses Release Date",
      eventType: "publication_date",
      legacyType: "reminder_date",
      isExplicit: true,
      confidence: 0.94,
    };
  }

  // 4. Written Questions / Inquiries / Clarification Deadline (must NOT be final proposal deadline)
  if (
    /\b(?:written\s+questions?|questions?\s+cutoff|questions?\s+due|questions?\s+deadline|inquiries?\s+deadline|clarification\s+deadline|request\s+for\s+clarification)\b/i.test(
      ctx
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Questions & Clarifications Cutoff",
      eventType: "question_clarification_deadline",
      legacyType: "reminder_date",
      isExplicit: true,
      confidence: 0.95,
    };
  }

  // 5. Pre-bid Conference / Informational Presentation
  if (
    /\b(?:pre[-\s]?bid|informational\s+presentation|proposers?\s+conference|bidders?\s+conference|site\s+visit|webinar|briefing\s+session)\b/i.test(
      ctx
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Pre-Bid / Informational Conference",
      eventType: "pre_bid_conference",
      legacyType: "reminder_date",
      isExplicit: true,
      confidence: 0.95,
    };
  }

  // 6. Confirmation of Intent to Bid / Intent to Participate
  if (
    /\b(?:intent\s+to\s+participate|intent\s+to\s+bid|confirmation\s+of\s+intent)\b/i.test(
      ctx
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Confirmation of Intent to Bid Due",
      eventType: "intent_to_bid_deadline",
      legacyType: "reminder_date",
      isExplicit: true,
      confidence: 0.95,
    };
  }

  // 6b. Standard Agreement Exceptions / Redlines / Document Verification
  if (
    /\b(?:exceptions?\s*\/?\s*redlines?\s+due|agreement\s+exceptions|agreement\s+revisions|document\s+verification)\b/i.test(
      ctx
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Interim Document / Notice Deadline",
      eventType: "document_submission_deadline",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.94,
    };
  }

  // 7. Technical Conference / Vendor Interviews / Oral Presentation
  if (/\b(?:technical\s+conference|vendor\s+interviews?|shortlisted\s+interviews?|interview\s+date|oral\s+presentation)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Interviews / Technical Conference",
      eventType: "interview_date",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.94,
    };
  }

  // 8. Evaluation Period
  if (/\b(?:evaluation\s+period|scoring\s+review|evaluation\s+committee|bid\s+evaluation|technical\s+evaluation)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Evaluation & Scoring Period",
      eventType: "evaluation_period",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.93,
    };
  }

  // 9. Award Announcement / Notice of Intent to Award
  if (/\b(?:intent\s+to\s+award|award\s+announcement|award\s+notification|award\s+date|selection\s+result|merit\s+list)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Award / Selection Announcement",
      eventType: "award_announcement",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.94,
    };
  }

  // 10. Final Proposal / Bid Submission Deadline (RFP/Tender primary cutoff)
  if (
    /\b(?:final\s+date\s+(?:for\s+)?submission\s+of\s+proposals|submission\s+of\s+proposals|final\s+proposal\s+submission|proposal\s+submission\s+deadline|proposal\s+submittal\s+deadline|submittal\s+deadline|proposal\s+due|bid\s+submission\s+deadline|tender\s+closing|proposals?\s+must\s+be\s+received\s+by)\b/i.test(
      ctx
    )
  ) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Final Proposal Submission Deadline",
      eventType: "proposal_submission_deadline",
      legacyType: "official_deadline",
      isExplicit: true,
      confidence: 0.98,
    };
  }

  // 11. Application / General Submission Deadline (Scholarship, Admission, Job, Scheme, or general RFP)
  if (
    /\b(?:application\s+deadline|submission\s+deadline|last\s+date\s+(?:of|for|to)\s+(?:online\s+)?(?:application(?:\s+submission)?|submission|apply|receiving)|closing\s+date|due\s+date|apply\s+by|apply\s+on\s+or\s+before|final\s+cutoff|deadline\s*:)\b/i.test(
      ctx
    )
  ) {
    const isProposalContext = /\b(?:proposal|bid|tender|rfp|solicitation)\b/i.test(fullCtx);
    return {
      label:
        extractCleanEventTitle(lineContext, rawDate) ||
        (isProposalContext ? "Proposal Submission Deadline" : "Application Submission Deadline"),
      eventType: isProposalContext ? "proposal_submission_deadline" : "application_submission_deadline",
      legacyType: "official_deadline",
      isExplicit: true,
      confidence: 0.96,
    };
  }

  // 12. Application Opening / Portal Opening
  if (/\b(?:opening\s+date|portal\s+opens|applications?\s+open|registration\s+opens|online\s+submission\s+starts)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Application Opening Date",
      eventType: "application_opening",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.94,
    };
  }

  // 13. Examination Date
  if (/\b(?:examination\s+date|entrance\s+exam|written\s+test|exam\s+schedule|test\s+date)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Examination / Test Date",
      eventType: "examination_date",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.94,
    };
  }

  // 14. Fee Payment Deadline
  if (/\b(?:fee\s+payment|last\s+date\s+for\s+fee|payment\s+deadline|emd\s+submission|tuition\s+due)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Fee Payment Deadline",
      eventType: "fee_payment_deadline",
      legacyType: "official_deadline",
      isExplicit: true,
      confidence: 0.93,
    };
  }

  // 15. Contract Commencement / Effective Date
  if (/\b(?:commencement\s+date|contract\s+start|work\s+begins|project\s+kickoff)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Contract Commencement Date",
      eventType: "contract_commencement",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.92,
    };
  }

  if (/\b(?:effective\s+date|effective\s+from|comes\s+into\s+force)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Effective Date",
      eventType: "effective_date",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.92,
    };
  }

  // 16. Contract Expiry / Validity / Renewal
  if (/\b(?:expiry|expiration|valid\s+upto|valid\s+until|contract\s+end)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Expiry / Validity Date",
      eventType: "contract_expiry",
      legacyType: "expiry_date",
      isExplicit: true,
      confidence: 0.92,
    };
  }

  if (/\b(?:renewal\s+date|extension\s+date)\b/i.test(ctx)) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || "Renewal Date",
      eventType: "renewal_date",
      legacyType: "reminder_date",
      isExplicit: true,
      confidence: 0.9,
    };
  }

  // 17. Check if date year is far in the past (< 2020) without an explicit deadline keyword -> Historical Event
  const yearMatch = rawDate.match(/\b(19\d{2}|20(?:0\d|1\d))\b/);
  if (yearMatch) {
    return {
      label: extractCleanEventTitle(lineContext, rawDate) || `Historical Date (${yearMatch[1]})`,
      eventType: "historical_event",
      legacyType: "reminder_date",
      isExplicit: false,
      confidence: 0.85,
    };
  }

  // 18. Otherwise: Do NOT guess "official_deadline"! Use "Unclassified Date" or table event title
  const extractedTitle = extractCleanEventTitle(lineContext, rawDate);
  if (extractedTitle && extractedTitle.length > 4) {
    return {
      label: extractedTitle,
      eventType: "other_important_date",
      legacyType: "target_date",
      isExplicit: true,
      confidence: 0.82,
    };
  }

  return {
    label: "Unclassified Date",
    eventType: "unknown_ambiguous_date",
    legacyType: "reminder_date",
    isExplicit: false,
    confidence: 0.65,
  };
}

/**
 * Extracts a clean event description from a schedule line or table row (e.g. "RFP Release Date: June 7, 2021")
 */
function extractCleanEventTitle(line: string, rawDate: string): string | null {
  const withoutDate = line
    .replace(rawDate, "")
    .replace(/^[•\-*\d.)\s|]+/, "")
    .replace(/[:|\-–—\s]+$/, "")
    .replace(/\b(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:Eastern|Pacific|Central|Mountain|IST|UTC|GMT)?(?:\s*Time)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (withoutDate.length >= 4 && withoutDate.length <= 75 && !/^(?:on|by|from|to|the|and|in|of)$/i.test(withoutDate)) {
    return withoutDate.replace(/[:\-–—]\s*$/, "").trim();
  }
  return null;
}

/**
 * Checks whether a numeric date like "04/05/2026" is ambiguous (both first and second parts <= 12 and != each other)
 */
function isAmbiguousNumericDate(rawDate: string): boolean {
  const m = rawDate.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  return a >= 1 && a <= 12 && b >= 1 && b <= 12 && a !== b;
}

/**
 * Parses a date or date-range string into a timestamp and temporal status relative to current time
 */
function evaluateDateTemporalStatus(
  rawDate: string,
  eventType: DetailedDateEventType
): {
  isoDate?: string;
  daysRemaining?: number;
  isExpired: boolean;
  isUrgent: boolean;
  status: DeadlineTemporalStatus;
} {
  // Check if year is missing
  const hasFourDigitYear = /\b(19\d{2}|20\d{2})\b/.test(rawDate);
  if (!hasFourDigitYear) {
    return {
      isExpired: false,
      isUrgent: false,
      status: "Date unclear",
    };
  }

  // If it's a range like "August 30 – Sept 10, 2021", parse the end date or start date
  let parseCandidate = rawDate;
  const rangeParts = rawDate.split(/\s*(?:[-–—]|to)\s*/i);
  if (rangeParts.length === 2) {
    const yearMatch = rawDate.match(/\b(20\d{2}|19\d{2})\b/);
    const firstPart = rangeParts[0].trim();
    parseCandidate = /\b\d{4}\b/.test(firstPart) ? firstPart : `${firstPart}, ${yearMatch ? yearMatch[1] : ""}`;
  }

  // Remove ordinal suffixes (1st, 2nd, 3rd, 4th) before Date.parse
  const cleanForParse = parseCandidate.replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1");
  const parsedTimestamp = Date.parse(cleanForParse);

  if (isNaN(parsedTimestamp)) {
    return {
      isExpired: false,
      isUrgent: false,
      status: "Date unclear",
    };
  }

  const isoDate = new Date(parsedTimestamp).toISOString().split("T")[0];
  const nowMs = Date.now();
  const diffMs = parsedTimestamp - nowMs;
  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (eventType === "historical_event") {
    return {
      isoDate,
      daysRemaining,
      isExpired: daysRemaining < 0,
      isUrgent: false,
      status: "Historical",
    };
  }

  if (daysRemaining < 0) {
    // If more than 180 days in the past, mark Historical; otherwise Passed
    const status: DeadlineTemporalStatus = daysRemaining < -180 ? "Historical" : "Passed";
    return {
      isoDate,
      daysRemaining,
      isExpired: true,
      isUrgent: false,
      status,
    };
  }

  if (daysRemaining === 0) {
    return {
      isoDate,
      daysRemaining: 0,
      isExpired: false,
      isUrgent: true,
      status: "Due today",
    };
  }

  return {
    isoDate,
    daysRemaining,
    isExpired: false,
    isUrgent: daysRemaining <= 7,
    status: "Upcoming",
  };
}

/**
 * Extracts important dates with context-aware semantic labeling, table row preservation, and urgency arithmetic
 */
export function extractDynamicDates(doc: ParsedDocumentData): ImportantDateItem[] {
  const dates: ImportantDateItem[] = [];
  let idCount = 1;

  // 1. First extract structured dates from extractedTables if available (preserves Event column <-> Date column)
  if (doc.extractedTables && doc.extractedTables.length > 0) {
    for (const table of doc.extractedTables) {
      const headersLower = table.headers.map(h => h.toLowerCase());
      const dateColIdx = headersLower.findIndex(h => /date|deadline|schedule|timeline|when|cutoff/i.test(h));
      const eventColIdx = headersLower.findIndex(h => /event|milestone|activity|description|stage|phase|item|programme|scholarship/i.test(h));

      if (dateColIdx !== -1) {
        for (let rIdx = 0; rIdx < table.rows.length; rIdx++) {
          const row = table.rows[rIdx];
          const rawCellDate = (row[dateColIdx] || "").trim();
          if (!rawCellDate) continue;

          const eventName = eventColIdx !== -1 ? (row[eventColIdx] || "").trim() : row.filter((_, idx) => idx !== dateColIdx).join(" - ").trim();
          const rowContext = `${eventName}: ${rawCellDate}`;

          for (const pattern of DATE_PATTERNS) {
            pattern.lastIndex = 0;
            const m = pattern.exec(rawCellDate);
            if (m) {
              const matchedDateStr = m[0].trim();
              const classification = classifyDateFromContext(matchedDateStr, rowContext, rowContext, `Table ${table.tableIndex}`);
              const temporal = evaluateDateTemporalStatus(matchedDateStr, classification.eventType);
              const ambiguous = isAmbiguousNumericDate(matchedDateStr);

              if (!dates.some(d => d.rawText === matchedDateStr && d.sourceLocation.page === table.page && d.label === (eventName || classification.label))) {
                dates.push({
                  id: `date_${idCount++}`,
                  label: eventName && eventName.length >= 3 ? eventName : classification.label,
                  rawText: matchedDateStr,
                  isoDate: temporal.isoDate,
                  type: classification.legacyType,
                  eventType: classification.eventType,
                  status: temporal.status,
                  associatedProgrammeOrEntity: doc.issuingOrganisation || doc.extractedTitle,
                  confidence: ambiguous ? 0.7 : classification.confidence,
                  isExplicit: true,
                  verificationStatus: ambiguous ? "Ambiguous" : "Verified in text",
                  sourceLocation: {
                    page: table.page,
                    table: `Table ${table.tableIndex}`,
                    row: rIdx + 1,
                    snippet: rowContext,
                  },
                  isExpired: temporal.isExpired,
                  isUrgent: temporal.isUrgent,
                  daysRemaining: temporal.daysRemaining,
                });
              }
              break;
            }
          }
        }
      }
    }
  }

  // 2. Scan page-by-page line-by-line so table rows and schedule lines stay intact
  for (const page of doc.pages) {
    const pageText = page.text || "";
    if (!pageText.trim()) continue;

    const lines = pageText.split(/\r?\n/);
    let currentSection = page.pageLabel || `Page ${page.pageNumber}`;
    let currentProgramme = doc.issuingOrganisation || doc.extractedTitle;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx].trim();
      if (!line) continue;

      // Track section or programme heading
      if (/^(?:#+\s+|SECTION\s+\d+[:.]?|\d+[\.\)]\s+)[A-Z]/i.test(line) && line.length < 90) {
        currentSection = line.replace(/^[#\s]+/, "").trim();
        if (/scholarship|fellowship|programme|program|scheme|grant|award|rfp|tender/i.test(currentSection)) {
          currentProgramme = currentSection;
        }
      }

      const prevLine = lineIdx > 0 ? lines[lineIdx - 1].trim() : "";
      const nextLine = lineIdx + 1 < lines.length ? lines[lineIdx + 1].trim() : "";
      const widerContext = `${prevLine} ${line} ${nextLine}`.replace(/\s+/g, " ").trim();

      for (const pattern of DATE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const rawDate = match[0].trim();

          // Skip if this exact date on this page was already captured as part of a longer date range (e.g. "August 30 – Sept 10, 2021")
          if (
            dates.some(
              d =>
                d.sourceLocation.page === page.pageNumber &&
                (d.rawText === rawDate || (d.rawText.includes(rawDate) && d.rawText.length > rawDate.length))
            )
          ) {
            continue;
          }

          // Skip dateless day-month matches unless the line explicitly mentions a date/deadline event
          const hasYear = /\b(19\d{2}|20\d{2})\b/.test(rawDate);
          if (!hasYear && !/deadline|due\s*date|closing\s*date|last\s*date|opening\s*date|exam\s*date/i.test(line)) {
            continue;
          }

          const classification = classifyDateFromContext(rawDate, line, widerContext, currentSection);
          const temporal = evaluateDateTemporalStatus(rawDate, classification.eventType);
          const ambiguous = isAmbiguousNumericDate(rawDate);

          dates.push({
            id: `date_${idCount++}`,
            label: classification.label,
            rawText: rawDate,
            isoDate: temporal.isoDate,
            type: classification.legacyType,
            eventType: classification.eventType,
            status: temporal.status,
            associatedProgrammeOrEntity: currentProgramme,
            confidence: ambiguous ? 0.68 : classification.confidence,
            isExplicit: classification.isExplicit,
            verificationStatus: ambiguous
              ? "Ambiguous"
              : classification.isExplicit
              ? "Verified in text"
              : "Needs verification",
            sourceLocation: {
              page: page.pageNumber,
              section: currentSection,
              snippet: widerContext.slice(0, 220),
            },
            isExpired: temporal.isExpired,
            isUrgent: temporal.isUrgent,
            daysRemaining: temporal.daysRemaining,
          });
        }
      }
    }
  }

  return dates.slice(0, 60);
}

/**
 * Dedicated Primary Deadline Selector (Part 2.1)
 *
 * - For RFPs/Tenders: Prioritises final proposal submission deadline. Never selects release date, questions cutoff, pre-bid meeting, interview date, evaluation period, or award announcement.
 * - For Scholarships/Admissions/Jobs: Prioritises application submission deadline. Never selects historical events or publication dates.
 * - Marks the winning date item with `isPrimaryDeadline = true`.
 * - Returns null if no genuine submission deadline exists in the document.
 */
export function selectPrimaryDeadline(
  dates: ImportantDateItem[],
  category: DocumentCategory = "general"
): FullDocumentAnalysis["primaryDeadline"] {
  if (!dates || dates.length === 0) return null;

  // Exclude non-deadline event types that must NEVER be selected as the primary submission deadline
  const excludedEventTypes = new Set<DetailedDateEventType | string>([
    "rfp_release_date",
    "intent_to_bid_deadline",
    "publication_date",
    "question_clarification_deadline",
    "pre_bid_conference",
    "interview_date",
    "evaluation_period",
    "award_announcement",
    "application_opening",
    "contract_commencement",
    "effective_date",
    "historical_event",
    "unknown_ambiguous_date",
    "other_important_date",
  ]);

  const candidates = dates.filter(d => d.eventType && !excludedEventTypes.has(d.eventType));
  if (candidates.length === 0) {
    return null;
  }

  // Score candidates based on category priority
  const scoreCandidate = (d: ImportantDateItem): number => {
    let score = 0;
    const lbl = d.label.toLowerCase();

    if (category === "rfp_tender" || category === "contract") {
      if (d.eventType === "proposal_submission_deadline") score += 100;
      else if (d.eventType === "application_submission_deadline") score += 80;
      else if (d.eventType === "document_submission_deadline") score += 30;
      else if (d.eventType === "fee_payment_deadline") score += 20;
    } else {
      if (d.eventType === "application_submission_deadline") score += 100;
      else if (d.eventType === "proposal_submission_deadline") score += 85;
      else if (d.eventType === "document_submission_deadline") score += 45;
      else if (d.eventType === "fee_payment_deadline") score += 35;
    }

    if (/\b(?:final\s+proposal|proposal\s+submission|submission\s+of\s+proposals|submittal\s+deadline|application\s+deadline|last\s+date|closing\s+date)\b/i.test(lbl)) {
      score += 25;
    }
    if (/\b(?:exceptions|redlines|intent\s+to\s+participate|intent\s+to\s+bid|verification\s+window)\b/i.test(lbl)) {
      score -= 40;
    }
    // If an amendment/extension is explicitly noted, slightly prefer the amended deadline
    if (/\b(?:amended|extended|revised|corrigendum)\b/i.test(lbl)) {
      score += 15;
    }

    return score;
  };

  const sorted = [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const best = sorted[0];

  if (!best || scoreCandidate(best) < 30) {
    return null;
  }

  // Mark primary on the array item
  for (const d of dates) {
    d.isPrimaryDeadline = d.id === best.id;
  }

  return {
    date: best.rawText,
    rawText: best.rawText,
    isoDate: best.isoDate,
    label: best.label,
    eventType: best.eventType || "proposal_submission_deadline",
    status: best.status || "Date unclear",
    page: best.sourceLocation.page,
    snippet: best.sourceLocation.snippet,
    confidence: best.confidence || 0.95,
  };
}

/**
 * Parses numeric amount and currency multiplier accurately, supporting Indian Lakh/Crore and Million/Billion
 */
function parseNormalizedAmountAndCurrency(
  rawSymbol: string,
  rawDigits: string,
  rawMultiplier?: string
): { currency: string; numericValue?: number } {
  const sym = (rawSymbol || "").trim();
  let currency = sym;
  if (/^(?:₹|Rs\.?|INR)$/i.test(sym)) currency = "INR (₹)";
  else if (/^(?:\$|USD)$/i.test(sym)) currency = "USD ($)";
  else if (/^(?:€|EUR)$/i.test(sym)) currency = "EUR (€)";
  else if (/^(?:£|GBP)$/i.test(sym)) currency = "GBP (£)";
  else if (/^CAD$/i.test(sym)) currency = "CAD ($)";

  const cleanDigits = rawDigits.replace(/,/g, "");
  const baseVal = parseFloat(cleanDigits);
  if (isNaN(baseVal)) {
    return { currency };
  }

  let mult = 1;
  const mLower = (rawMultiplier || "").toLowerCase();
  if (mLower === "lakh" || mLower === "lakhs" || mLower === "lac" || mLower === "lacs") {
    mult = 100000;
  } else if (mLower === "crore" || mLower === "crores" || mLower === "cr") {
    mult = 10000000;
  } else if (mLower === "million") {
    mult = 1000000;
  } else if (mLower === "billion") {
    mult = 1000000000;
  } else if (mLower === "thousand" || mLower === "k") {
    mult = 1000;
  }

  return {
    currency,
    numericValue: Math.round(baseVal * mult * 100) / 100,
  };
}

/**
 * Classifies a financial figure into one of the 22 structured categories without conflating fees, tuition examples, or awards.
 */
function classifyFinancialContext(
  rawText: string,
  numericValue: number | undefined,
  lineContext: string,
  widerContext: string
): {
  label: string;
  legacyType: FinancialItem["type"];
  detailedCategory: DetailedFinancialCategory;
  isRecurring: boolean;
  isEstimateOrCeiling: boolean;
  confidence: number;
  verificationStatus: "Verified in text" | "Needs verification";
} {
  const ctx = lineContext.toLowerCase();
  const fullCtx = `${lineContext} ${widerContext}`.toLowerCase();
  const isRecurring = /\b(?:per\s+annum|annually|per\s+year|per\s+month|monthly|per\s+semester|every\s+year)\b/i.test(fullCtx);
  const isEstimateOrCeiling = /\b(?:up\s+to|maximum|ceiling|not\s+to\s+exceed|estimated|approximate|cap\s+of)\b/i.test(fullCtx);

  // 1. $0 Master Services Agreement / Zero-Dollar Baseline
  if (numericValue === 0 || /\$0\b|zero[-\s]dollar|master\s*services?\s*agreement/i.test(ctx)) {
    return {
      label: "Contractual Baseline ($0 Master Agreement — Task-Order Funded, No Guaranteed Volume)",
      legacyType: "other",
      detailedCategory: "financial_baseline",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.96,
      verificationStatus: "Verified in text",
    };
  }

  // 2. Family Income / Turnover Eligibility Threshold
  if (/\b(?:family\s+income|household\s+income|income\s+limit|income\s+ceiling|annual\s+income)\b/i.test(ctx)) {
    return {
      label: "Maximum Family Income Eligibility Threshold",
      legacyType: "turnover",
      detailedCategory: "other_financial_amount",
      isRecurring: true,
      isEstimateOrCeiling: true,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:turnover|annual\s+revenue|gross\s+receipt|financial\s+capacity|net\s+worth)\b/i.test(ctx)) {
    return {
      label: "Minimum Annual Turnover / Revenue Requirement",
      legacyType: "turnover",
      detailedCategory: "revenue",
      isRecurring: true,
      isEstimateOrCeiling: false,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  // 3. Insurance Requirement (e.g. $2,000,000 CGL, $5,000,000 Cyber Liability)
  if (/\b(?:insurance|liability\s+coverage|general\s+liability|cyber\s+liability|errors\s+and\s+omissions|workers'?\s+compensation|per\s+occurrence|aggregate\s+limit)\b/i.test(ctx)) {
    return {
      label: extractFinancialLabelPrefix(lineContext, rawText) || "Mandatory Insurance Coverage Limit",
      legacyType: "other",
      detailedCategory: "insurance_requirement",
      isRecurring: false,
      isEstimateOrCeiling: true,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  // 4. Earnest Money Deposit (EMD) / Bid Bond / Bid Security
  if (/\b(?:emd|earnest\s+money|bid\s+security|bid\s+bond)\b/i.test(ctx)) {
    return {
      label: "Bid Security / Earnest Money Deposit (EMD)",
      legacyType: "emd",
      detailedCategory: "bid_bond",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.96,
      verificationStatus: "Verified in text",
    };
  }

  // 5. Performance Bond / Performance Security
  if (/\b(?:performance\s+security|performance\s+bond|performance\s+guarantee|security\s+deposit)\b/i.test(ctx)) {
    return {
      label: "Performance Security / Bond",
      legacyType: "emd",
      detailedCategory: "performance_security",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  // 6. Application / Tender / Registration / Examination Fee (kept strictly separate from Tuition!)
  if (/\b(?:application\s+fee|processing\s+fee|tender\s+fee|document\s+fee|filing\s+fee)\b/i.test(ctx)) {
    return {
      label: "Application / Processing Fee",
      legacyType: "fee",
      detailedCategory: "application_fee",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:registration\s+fee|enrollment\s+fee)\b/i.test(ctx)) {
    return {
      label: "Registration Fee",
      legacyType: "fee",
      detailedCategory: "registration_fee",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:examination\s+fee|exam\s+fee|test\s+fee)\b/i.test(ctx)) {
    return {
      label: "Examination Fee",
      legacyType: "fee",
      detailedCategory: "examination_fee",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  // 7. Tuition Fee (distinct from scholarship award unless line explicitly says scholarship/financial assistance for tuition)
  if (
    /\b(?:tuition\s+fee|semester\s+fee|course\s+fee|cost\s+of\s+attendance|college\s+tuition)\b/i.test(ctx) &&
    !/\b(?:scholarship|financial\s+assistance|stipend|grant|award|fellowship)\b/i.test(ctx)
  ) {
    return {
      label: "Tuition / Academic Fee",
      legacyType: "fee",
      detailedCategory: "tuition_fee",
      isRecurring,
      isEstimateOrCeiling,
      confidence: 0.92,
      verificationStatus: "Verified in text",
    };
  }

  // 8. Scholarship / Fellowship / Stipend / Grant Amount
  if (/\b(?:scholarship|fellowship|stipend|financial\s+assistance|contingency\s+allowance|merit\s+award|award\s+amount|award\s+of)\b/i.test(ctx)) {
    // Guard against aggregate historical program statistics like "$355 million distributed since 1995"
    if (numericValue && numericValue >= 5000000 && /\b(?:million|billion|distributed|total\s+awarded|across|program\s+budget)\b/i.test(fullCtx)) {
      return {
        label: "Aggregate Programme Funding / Historical Disbursal",
        legacyType: "other",
        detailedCategory: "other_financial_amount",
        isRecurring: false,
        isEstimateOrCeiling: true,
        confidence: 0.85,
        verificationStatus: "Needs verification",
      };
    }
    return {
      label: extractFinancialLabelPrefix(lineContext, rawText) || "Scholarship / Fellowship Award Amount",
      legacyType: "grant_amount",
      detailedCategory: "scholarship_amount",
      isRecurring,
      isEstimateOrCeiling,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:grant\s+amount|research\s+grant|seed\s+grant)\b/i.test(ctx)) {
    return {
      label: "Grant Funding Amount",
      legacyType: "grant_amount",
      detailedCategory: "grant_amount",
      isRecurring,
      isEstimateOrCeiling,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  // 9. Contract Ceiling / Estimated Value / Project Budget
  if (/\b(?:contract\s+ceiling|maximum\s+contract\s+value|budget\s+ceiling|not[-\s]to[-\s]exceed)\b/i.test(ctx)) {
    return {
      label: "Maximum Contract Ceiling",
      legacyType: "tender_value",
      detailedCategory: "contract_ceiling",
      isRecurring: false,
      isEstimateOrCeiling: true,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:tender\s+value|estimated\s+cost|work\s+value|project\s+estimate|estimated\s+contract\s+value)\b/i.test(ctx)) {
    return {
      label: "Estimated Contract / Tender Value",
      legacyType: "tender_value",
      detailedCategory: "estimated_contract_value",
      isRecurring: false,
      isEstimateOrCeiling: true,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:project\s+budget|approved\s+budget|total\s+contract\s+value)\b/i.test(ctx)) {
    return {
      label: "Project Budget / Contract Value",
      legacyType: "tender_value",
      detailedCategory: "actual_project_budget",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.93,
      verificationStatus: "Verified in text",
    };
  }

  // 10. Hourly Rate / Salary / Monthly Payment
  if (/\b(?:hourly\s+rate|rate\s+per\s+hour|\/hr\b|burdened\s+rate)\b/i.test(ctx)) {
    return {
      label: "Hourly Rate",
      legacyType: "salary",
      detailedCategory: "hourly_rate",
      isRecurring: true,
      isEstimateOrCeiling: false,
      confidence: 0.95,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:salary|ctc|remuneration|compensation\s+package|monthly\s+retainer|pay\s+scale)\b/i.test(ctx)) {
    return {
      label: "Salary / Remuneration",
      legacyType: "salary",
      detailedCategory: isRecurring ? "annual_recurring_cost" : "monthly_payment",
      isRecurring: true,
      isEstimateOrCeiling: false,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  // 11. Penalty / Liquidated Damages / Retainage / Refund
  if (/\b(?:penalty|liquidated\s+damages|fine|forfeiture|deduction)\b/i.test(ctx)) {
    return {
      label: "Penalty / Liquidated Damages Provision",
      legacyType: "penalty",
      detailedCategory: "penalty",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.94,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:retainage|holdback|retention\s+money)\b/i.test(ctx)) {
    return {
      label: "Retainage / Holdback Provision",
      legacyType: "other",
      detailedCategory: "retainage",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.93,
      verificationStatus: "Verified in text",
    };
  }

  if (/\b(?:refund|reimbursement)\b/i.test(ctx)) {
    return {
      label: "Refund / Reimbursement Amount",
      legacyType: "other",
      detailedCategory: "refund",
      isRecurring: false,
      isEstimateOrCeiling: false,
      confidence: 0.9,
      verificationStatus: "Verified in text",
    };
  }

  // 12. Unclear / Other amount (e.g., illustrative examples in a guidebook)
  const prefixLabel = extractFinancialLabelPrefix(lineContext, rawText);
  return {
    label: prefixLabel ? `${prefixLabel} (Needs Verification)` : "Other Financial Amount — Needs Verification",
    legacyType: "other",
    detailedCategory: "other_financial_amount",
    isRecurring,
    isEstimateOrCeiling,
    confidence: 0.72,
    verificationStatus: "Needs verification",
  };
}

function extractFinancialLabelPrefix(line: string, rawAmount: string): string | null {
  const idx = line.indexOf(rawAmount);
  if (idx <= 0) return null;
  const before = line
    .slice(0, idx)
    .replace(/^[•\-*\d.)\s|]+/, "")
    .replace(/[:=\-–—\s]+$/, "")
    .trim();
  if (before.length >= 4 && before.length <= 65) {
    return before;
  }
  return null;
}

/**
 * Extracts structured financial figures directly from document body and tables without combining unrelated programmes
 */
export function extractDynamicFinancials(doc: ParsedDocumentData): FinancialItem[] {
  const financials: FinancialItem[] = [];
  let idCount = 1;

  for (const page of doc.pages) {
    const pageText = page.text || "";
    if (!pageText.trim()) continue;

    const lines = pageText.split(/\r?\n/);
    let currentSection = page.pageLabel || `Page ${page.pageNumber}`;
    let currentProgramme = doc.issuingOrganisation || doc.extractedTitle;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (/^(?:#+\s+|SECTION\s+\d+[:.]?|\d+[\.\)]\s+)[A-Z]/i.test(line) && line.length < 90) {
        currentSection = line.replace(/^[#\s]+/, "").trim();
        if (/scholarship|fellowship|programme|program|scheme|grant|award|rfp|tender/i.test(currentSection)) {
          currentProgramme = currentSection;
        }
      }

      const prevLine = i > 0 ? lines[i - 1].trim() : "";
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
      const widerContext = `${prevLine} ${line} ${nextLine}`.replace(/\s+/g, " ").trim();

      CURRENCY_AND_AMOUNT_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CURRENCY_AND_AMOUNT_REGEX.exec(line)) !== null) {
        const rawText = match[0].trim();
        const rawSymbol = match[1] || "";
        const rawDigits = match[2] || "";
        const rawMult = match[3] || undefined;

        const { currency, numericValue } = parseNormalizedAmountAndCurrency(rawSymbol, rawDigits, rawMult);

        // Filter out false positives like "Rs. 4" or "$1" from broken OCR/numbering unless explicitly $0 MSA or explicit fee
        if (numericValue !== undefined && numericValue <= 10 && !rawDigits.includes(".") && !rawMult) {
          const isMsa = /master\s*services?\s*agreement|\$0\s*contract|zero[-\s]dollar/i.test(widerContext);
          const isExplicitZeroFee = /(?:application|tender|registration)\s*fee\s*(?:is|:)?\s*(?:\$0|₹0|rs\.?\s*0)/i.test(widerContext);
          if (!isMsa && !isExplicitZeroFee) {
            continue;
          }
        }

        const classified = classifyFinancialContext(rawText, numericValue, line, widerContext);

        // Deduplicate identical amount + label on the same page
        if (
          !financials.some(
            f => f.amountText === rawText && f.sourceLocation.page === page.pageNumber && f.label === classified.label
          )
        ) {
          let categoryLabel = classified.detailedCategory as string;
          if (classified.detailedCategory === "scholarship_amount" || classified.detailedCategory === "grant_amount") {
            categoryLabel = "Scholarship / fellowship award";
          } else if (classified.detailedCategory === "tuition_fee") {
            categoryLabel = "Tuition fee";
          } else if (classified.detailedCategory === "application_fee") {
            categoryLabel = "Application fee";
          }

          financials.push({
            id: `fin_${idCount++}`,
            label: classified.label,
            amount: numericValue,
            amountText: rawText,
            currency,
            numericValue,
            type: classified.legacyType,
            detailedCategory: categoryLabel,
            associatedProgrammeOrEntity: currentProgramme,
            isRecurring: classified.isRecurring,
            isEstimateOrCeiling: classified.isEstimateOrCeiling,
            confidence: classified.confidence,
            verificationStatus: classified.verificationStatus,
            sourceLocation: {
              page: page.pageNumber,
              section: currentSection,
              snippet: widerContext.slice(0, 220),
            },
          });
        }
      }
    }
  }

  return financials.slice(0, 45);
}

/**
 * Checks whether a line of text is general advice, tips, or informational prose rather than an actual requirement
 */
function isGeneralAdviceOrInformationalHeading(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.length < 4 || cleaned.length > 240) return true;

  // Reject advice phrases observed in scholarship guides and general articles
  const advicePatterns = [
    /\b(?:show\s+that\s+you\s+are\s+well\s+rounded|add\s+a\s+personal\s+touch|choose\s+your\s+field\s+of\s+study)\b/i,
    /\b(?:proofread\s+your\s+essay|start\s+early|ask\s+for\s+help|tailor\s+your\s+application|be\s+honest|stay\s+organized|keep\s+copies)\b/i,
    /\b(?:tips\s+for\s+winning|how\s+to\s+write\s+a\s+great|what\s+judges\s+look\s+for|common\s+mistakes\s+to\s+avoid|why\s+apply\s+for)\b/i,
    /^(?:introduction|overview|background|about\s+us|our\s+mission|table\s+of\s+contents|disclaimer|frequently\s+asked\s+questions)$/i,
  ];

  return advicePatterns.some(pat => pat.test(cleaned));
}

/**
 * Determines whether a checklist/bullet item is genuinely a Mandatory submission item, Conditional, or Recommended
 */
function classifyRequirementEvidence(
  itemText: string,
  sectionHeading: string,
  surroundingLine: string
): {
  classification: RequirementClassification;
  mandatory: boolean;
  condition?: string;
  confidence: number;
} {
  const combined = `${sectionHeading} ${itemText} ${surroundingLine}`.toLowerCase();

  if (isGeneralAdviceOrInformationalHeading(itemText)) {
    return {
      classification: "Recommended",
      mandatory: false,
      confidence: 0.75,
    };
  }

  // Check for conditional clauses ("if applicable", "if claiming quota", "if applying under...", "for consortiums", "where applicable")
  const condMatch = `${itemText} ${surroundingLine}`.match(
    /\b((?:if|where)\s+(?:applicable|claiming\s+[^),.]+|applying\s+[^),.]+|available|registered)|for\s+(?:joint\s+ventures|consortiums|foreign\s+applicants|reserved\s+categories))\b/i
  );
  if (condMatch) {
    return {
      classification: "Conditional",
      mandatory: false,
      condition: condMatch[1].trim(),
      confidence: 0.92,
    };
  }

  // Check for explicit mandatory language or explicit mandatory document nouns
  const hasExplicitMandatoryKeyword =
    /\b(?:mandatory|required|must\s+(?:submit|provide|have|possess|include|attach|furnish)|shall\s+(?:submit|provide|have|include|furnish)|compulsory|pass\s*\/\s*fail|disqualification)\b/i.test(
      combined
    );

  const hasConcreteDocumentOrCredentialNoun =
    /\b(?:certificate|marksheet|transcript|degree|diploma|affidavit|undertaking|pan\s+card|aadhaar|gst|incorporation|balance\s+sheet|audit(?:ed)?\s+financial|tax\s+return|itr|bank\s+guarantee|emd|resume|curriculum\s+vitae|cv|reference|proposal|cover\s+letter|questionnaire|attachment|appendix|annexure|form|declaration|disclosure|cheque|receipt|id\s+proof|passport|license|iso\s+\d+|cmmi|pmp)\b/i.test(
      itemText
    );

  if (hasExplicitMandatoryKeyword && hasConcreteDocumentOrCredentialNoun) {
    return {
      classification: "Mandatory",
      mandatory: true,
      confidence: 0.96,
    };
  }

  if (hasExplicitMandatoryKeyword) {
    return {
      classification: "Mandatory",
      mandatory: true,
      confidence: 0.9,
    };
  }

  if (/\b(?:recommended|encouraged|optional|preferred|desirable|may\s+also\s+include)\b/i.test(combined)) {
    return {
      classification: "Recommended",
      mandatory: false,
      confidence: 0.88,
    };
  }

  return {
    classification: "Informational",
    mandatory: false,
    confidence: 0.78,
  };
}

/**
 * Dynamically extracts eligibility criteria and required documents strictly from source text.
 * NEVER invents template requirements when the document does not contain them.
 */
export function extractDynamicRequirements(
  doc: ParsedDocumentData,
  _category: DocumentCategory = "general"
): { requirements: RequirementItem[]; eligibility: string[]; requiredDocs: string[] } {
  const requirements: RequirementItem[] = [];
  const eligibilityList: string[] = [];
  const requiredDocsList: string[] = [];
  let reqCount = 1;

  // 1. Scan pages for explicit Required / Mandatory Documents sections & checklists
  for (const page of doc.pages) {
    const lines = (page.text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let inDocSection = false;
    let activeHeading = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect section headers
      if (
        /^(?:(?:#+\s*)|(?:SECTION\s+\d+[:.]?)|(?:\d+(?:\.\d+)?[\.\)]\s*))?\s*(?:MANDATORY\s+(?:SUBMISSION\s+)?DOCUMENTS?(?:\s+CHECKLIST)?|REQUIRED\s+DOCUMENTS?|DOCUMENTS?\s+REQUIRED|SUBMISSION\s+CHECKLIST|(?:MANDATORY\s+)?(?:ELIGIBILITY\s+&\s+SUBMISSION\s+REQUIREMENTS?|TECHNICAL\s+&\s+STATUTORY\s+ELIGIBILITY|SUBMISSION\s+REQUIREMENTS?|ELIGIBILITY\s+REQUIREMENTS?|QUALIFICATIONS?\s+&\s+REQUIREMENTS?)|PROPOSAL\s+CONTENTS?\s+&\s+PAGE\s+LIMITS|ATTACHMENTS?\s+AND\s+ENCLOSURES?)\s*:?$/i.test(
          line
        )
      ) {
        inDocSection = true;
        activeHeading = line;
        continue;
      }

      if (inDocSection) {
        // Exit section if a new numbered major section starts
        if (
          /^(?:#+\s+|SECTION\s+\d+|ARTICLE\s+[IVXLCDM\d]+|\d+\.\s+[A-Z][A-Za-z\s]{3,50}:?$)/i.test(line) &&
          !/^(?:\d+[\.\)]\s+)(?:Marksheet|Valid|Bank|College|Caste|Income|Title\s+Page|Cover\s+Letter|Table\s+of\s+Contents|Executive\s+Summary|Corporate|Technical|Key\s+Personnel|Client\s+References|Attachment|Fee\s+Proposal|Standard\s+Agreement|Conflict\s+of\s+Interest|ISO|GST|Audited|Minimum|Non-blacklisting|OEM|Proof|Official|Personal|Two|Mandatory|Experience|Core)/i.test(
            line
          )
        ) {
          inDocSection = false;
          activeHeading = "";
        } else {
          const itemMatch = line.match(/^(?:(?:\d+[\.\)]|[a-z][\.\)]|[-•*])\s+)(.+)$/);
          if (itemMatch && itemMatch[1].trim().length > 4) {
            const docName = itemMatch[1].trim();
            const classified = classifyRequirementEvidence(docName, activeHeading, line);

            if (!isGeneralAdviceOrInformationalHeading(docName) && !requiredDocsList.includes(docName)) {
              if (classified.mandatory || classified.classification === "Conditional") {
                requiredDocsList.push(docName);
              }
              requirements.push({
                id: `req_${reqCount++}`,
                title: docName,
                name: docName,
                description: line,
                sourceQuote: line,
                mandatory: classified.mandatory,
                classification: classified.classification,
                condition: classified.condition,
                category: classified.mandatory ? "Mandatory Document" : `${classified.classification} Item`,
                sourceLocation: {
                  page: page.pageNumber,
                  section: activeHeading || `Page ${page.pageNumber}`,
                  snippet: line,
                },
                confidence: classified.confidence,
                verificationStatus: classified.mandatory ? "MISSING_EVIDENCE" : "NEEDS_VERIFICATION",
                evidenceStatus: classified.mandatory ? "Missing evidence" : "Not assessed",
              });
            }
          }
        }
      }

      // Also detect inline explicit mandatory/conditional submission sentences
      const inlineMustSubmitMatch = line.match(
        /\b(?:all\s+bids?|bidders?|proposers?|(?:international\s+)?applicants?|candidates?|vendors?)\s+(?:must|shall|are\s+required\s+to)\s+(?:submit|provide|furnish|attach|include|upload)\s+([^.;\n]{6,140})/i
      );
      if (inlineMustSubmitMatch) {
        const extractedClause = inlineMustSubmitMatch[1].trim();
        const classifiedInline = classifyRequirementEvidence(extractedClause, activeHeading, line);
        if (
          !isGeneralAdviceOrInformationalHeading(extractedClause) &&
          !requirements.some(r => (r.name || r.title || '').toLowerCase().includes(extractedClause.slice(0, 22).toLowerCase()))
        ) {
          requiredDocsList.push(extractedClause);
          requirements.push({
            id: `req_${reqCount++}`,
            title: extractedClause,
            name: extractedClause,
            description: line,
            sourceQuote: line,
            mandatory: classifiedInline.mandatory,
            classification: classifiedInline.classification,
            condition: classifiedInline.condition,
            category: classifiedInline.mandatory ? "Mandatory Submission Requirement" : `${classifiedInline.classification} Item`,
            sourceLocation: {
              page: page.pageNumber,
              section: activeHeading || `Page ${page.pageNumber}`,
              snippet: line,
            },
            confidence: classifiedInline.confidence,
            verificationStatus: classifiedInline.mandatory ? "MISSING_EVIDENCE" : "NEEDS_VERIFICATION",
            evidenceStatus: classifiedInline.mandatory ? "Missing evidence" : "Not assessed",
          });
        }
      }
    }
  }

  // 2. Dynamic scan for Explicit Eligibility & Qualification Rules
  const eligibilityPatterns = [
    {
      pattern: /(?:minimum\s+(?:qualifying\s+)?(?:aggregate\s+)?(?:\d+(?:\.\d+)?%\s+)?marks|cgpa\s+of\s+\d+(?:\.\d+)?|gpa\s+of\s+\d+(?:\.\d+)?|minimum\s+\d+(?:\.\d+)?%\s+marks)[^.;\n]{0,90}/gi,
      label: "Academic / Marks Threshold",
    },
    {
      pattern: /(?:annual\s+(?:family\s+|gross\s+)?income|household\s+income)\s*(?:limit|threshold|ceiling|must\s+not\s+exceed)?\s*[:=]?\s*[^.;\n]{4,90}/gi,
      label: "Family Income Eligibility Limit",
    },
    {
      pattern: /(?:minimum\s+(?:average\s+)?annual\s+turnover|annual\s+turnover\s+limit)\s*[:=]?\s*[^.;\n]{4,90}/gi,
      label: "Annual Turnover Mandate",
    },
    {
      pattern: /(?:minimum\s+(?:of\s+)?(?:\w+\s+)?(?:\(\d+\)\s+)?(?:\d+\+?\s+)?(?:consecutive\s+)?years\s+of\s+(?:demonstrated\s+|commercial\s+|direct\s+|professional\s+)?experience)[^.;\n]{0,90}/gi,
      label: "Experience Qualification",
    },
    {
      pattern: /(?:no\s+bankruptcy\s+filings|zero\s+bankruptcy|no\s+active,\s+pending,\s+or\s+settled\s+material\s+litigation)[^.;\n]{0,90}/gi,
      label: "Legal & Solvency Standing",
    },
    {
      pattern: /(?:mandatory\s+iso\s+\d+|iso\s+\d+\s+certificat(?:e|ion)|cmmi\s+level\s+\d+|mandatory\s+gst\s+registration)[^.;\n]{0,80}/gi,
      label: "Statutory / Technical Certification",
    },
    {
      pattern: /(?:applicant\s+must\s+be\s+a\s+citizen\s+of\s+[A-Za-z\s]+|age\s+limit\s*[:=]\s*[^.;\n]{3,60})/gi,
      label: "Citizenship / Age Eligibility",
    },
  ];

  for (const page of doc.pages) {
    const pageText = page.text || "";
    if (!pageText.trim()) continue;

    for (const ep of eligibilityPatterns) {
      ep.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ep.pattern.exec(pageText)) !== null) {
        const fullClause = match[0].replace(/\s+/g, " ").trim();
        if (isGeneralAdviceOrInformationalHeading(fullClause)) continue;

        const start = Math.max(0, match.index - 30);
        const end = Math.min(pageText.length, match.index + fullClause.length + 50);
        const snippet = pageText.substring(start, end).replace(/\s+/g, " ").trim();

        if (!eligibilityList.some(e => e.toLowerCase().includes(fullClause.slice(0, 24).toLowerCase()))) {
          eligibilityList.push(fullClause);
          requirements.push({
            id: `req_${reqCount++}`,
            title: `${ep.label}: ${fullClause}`,
            name: `${ep.label}: ${fullClause}`,
            description: snippet,
            sourceQuote: snippet,
            mandatory: true,
            classification: "Mandatory",
            category: "Eligibility Qualification",
            sourceLocation: {
              page: page.pageNumber,
              snippet,
            },
            confidence: 0.94,
            verificationStatus: "NEEDS_VERIFICATION",
            evidenceStatus: "Needs verification",
          });
        }
      }
    }
  }

  return { requirements, eligibility: eligibilityList, requiredDocs: requiredDocsList };
}

/**
 * Extracts risk warnings, penalty clauses, conflicting deadlines, and integrates Fraud Signals
 */
export function extractDynamicRisks(
  doc: ParsedDocumentData,
  dates: ImportantDateItem[],
  primaryDeadline: FullDocumentAnalysis["primaryDeadline"]
): RiskWarningItem[] {
  const risks: RiskWarningItem[] = [];
  let idCount = 1;

  // 1. Primary Deadline Lapsed Warning (only check actual submission deadlines, not historical/release dates!)
  if (primaryDeadline && (primaryDeadline.status === "Passed" || primaryDeadline.status === "Historical")) {
    risks.push({
      id: `risk_${idCount++}`,
      title: "Primary Submission Deadline Has Passed",
      indicator: "Expired",
      severity: "high",
      description: `The primary submission deadline (${primaryDeadline.rawText} — ${primaryDeadline.label}) has passed relative to the current date.`,
      whyFired: `Primary deadline evaluator identified "${primaryDeadline.rawText}" on Page ${primaryDeadline.page || 1} as ${primaryDeadline.status}.`,
      sourceLocation: { page: primaryDeadline.page || 1, snippet: primaryDeadline.snippet || primaryDeadline.rawText },
      recommendedAction: "Verify on the official portal whether an addendum or extension corrigendum has been issued.",
    });
  }

  // 2. Approaching Cutoff Warning (< 7 days)
  const urgentDeadlines = dates.filter(
    d => d.type === "official_deadline" && d.isUrgent && !d.isExpired
  );
  if (urgentDeadlines.length > 0) {
    risks.push({
      id: `risk_${idCount++}`,
      title: "Submission Cutoff Approaching (< 7 Days)",
      indicator: "Needs verification",
      severity: "medium",
      description: `Submission cutoff (${urgentDeadlines[0].rawText}) is within ${urgentDeadlines[0].daysRemaining} day(s).`,
      whyFired: `Timeframe calculation indicates fewer than 7 calendar days remaining before "${urgentDeadlines[0].label}".`,
      sourceLocation: urgentDeadlines[0].sourceLocation,
      recommendedAction: "Expedite document attestations, signatures, and portal uploads immediately.",
    });
  }

  // 3. Liquidated Damages / Forfeiture / Unilateral Termination Clauses
  for (const page of doc.pages) {
    const pText = page.text || "";
    const match = pText.match(
      /(?:liquidated\s*damages|forfeiture\s*of\s*(?:emd|deposit|bid\s*security)|penalty\s*of\s*\d+%|unilateral\s*termination|holdback\s*from\s*each\s*monthly\s*invoice)[^\n.;]{10,140}/i
    );
    if (match) {
      risks.push({
        id: `risk_${idCount++}`,
        title: "Penalty, Holdback, or Forfeiture Clause Detected",
        indicator: "Needs verification",
        severity: "high",
        description: match[0].replace(/\s+/g, " ").trim(),
        whyFired: `Document text on Page ${page.pageNumber} contains an explicit financial penalty, retainage holdback, or deposit forfeiture condition.`,
        sourceLocation: { page: page.pageNumber, snippet: match[0].replace(/\s+/g, " ").trim() },
        recommendedAction: "Review cash-flow impact and delivery buffer timelines before committing.",
      });
      break;
    }
  }

  // 4. Conflicting Submission Deadlines Detection (only compare actual submission deadlines of the same event type)
  const submissionDeadlines = dates.filter(
    d =>
      d.eventType === "proposal_submission_deadline" ||
      d.eventType === "application_submission_deadline"
  );
  const distinctSubmissionDates = Array.from(new Set(submissionDeadlines.map(d => d.rawText)));
  if (distinctSubmissionDates.length >= 2) {
    const first = submissionDeadlines[0];
    const second = submissionDeadlines.find(d => d.rawText !== first.rawText)!;
    // Only flag if they belong to the same programme/entity
    if (first.associatedProgrammeOrEntity === second.associatedProgrammeOrEntity) {
      risks.push({
        id: `risk_${idCount++}`,
        title: "Multiple Submission Deadlines Detected — Verify Authoritative Cutoff",
        indicator: "Inconsistent",
        severity: "medium",
        description: `Found differing submission dates: "${first.rawText}" (${first.label}, Page ${first.sourceLocation.page}) vs "${second.rawText}" (${second.label}, Page ${second.sourceLocation.page}).`,
        whyFired: `Multiple submission deadline dates were extracted within the document.`,
        sourceLocation: second.sourceLocation,
        recommendedAction: "Check whether an addendum amended the original deadline or whether separate tracks apply.",
      });
    }
  }

  // 5. Proposal Validity Discrepancy (e.g., 108 days vs 180 days)
  const validityMatches: { days: string; page: number; snippet: string }[] = [];
  for (const page of doc.pages) {
    const m = (page.text || "").match(/\b(\d{2,3})\s*(?:calendar\s+)?days\b[^.\n]{0,60}\b(?:validity|remain\s+valid|binding)\b|\b(?:validity|remain\s+valid)\b[^.\n]{0,60}\b(\d{2,3})\s*(?:calendar\s+)?days\b/i);
    if (m) {
      const daysVal = m[1] || m[2];
      if (daysVal && !validityMatches.some(v => v.days === daysVal)) {
        validityMatches.push({ days: daysVal, page: page.pageNumber, snippet: m[0].replace(/\s+/g, " ").trim() });
      }
    }
  }
  if (validityMatches.length >= 2) {
    risks.push({
      id: `risk_${idCount++}`,
      title: `Proposal Validity Period Discrepancy (${validityMatches.map(v => `${v.days} Days`).join(" vs ")})`,
      indicator: "Inconsistent",
      severity: "high",
      description: `Document specifies conflicting validity periods across sections: ${validityMatches.map(v => `${v.days} days (Page ${v.page})`).join(" vs ")}.`,
      whyFired: `Detected differing numeric day counts associated with proposal validity.`,
      sourceLocation: { page: validityMatches[0].page, snippet: validityMatches[0].snippet },
      recommendedAction: "Commit to the longer validity period in your cover letter to prevent compliance rejection.",
    });
  }

  return risks;
}

/**
 * Builds actionable step-by-step checklist strictly grounded in extracted findings
 */
export function buildDynamicActionPlan(
  requirements: RequirementItem[],
  primaryDeadline: FullDocumentAnalysis["primaryDeadline"],
  financials: FinancialItem[]
): ActionChecklistItem[] {
  const plan: ActionChecklistItem[] = [];
  let step = 1;

  const mainDeadline = primaryDeadline?.rawText;

  // Step 1: Scrutiny
  plan.push({
    id: `act_${step}`,
    title: "Verify Eligibility & Mandatory Requirements Against Source Citations",
    description:
      requirements.length > 0
        ? `Cross-check the ${requirements.filter(r => r.mandatory).length} extracted mandatory requirement(s) against your credentials before preparing your submission.`
        : "Review the extracted document sections and verify whether any external annexures or addenda apply.",
    stepNumber: step++,
    status: "in_progress",
    priority: "high",
    officialDeadline: mainDeadline,
    notes: "Every requirement in DOCULENS links directly to the page and quote where it was detected.",
  });

  // Steps for genuine mandatory documents extracted from the document
  const mandatoryDocs = requirements.filter(r => r.mandatory);
  for (const docItem of mandatoryDocs.slice(0, 8)) {
    plan.push({
      id: `act_${step}`,
      title: `Prepare & Verify: ${docItem.name}`,
      description: docItem.description,
      stepNumber: step++,
      status: "pending",
      priority: "high",
      officialDeadline: mainDeadline,
      sourceLocation: docItem.sourceLocation,
      linkedRequirementId: docItem.id,
      notes: `Source: Page ${docItem.sourceLocation.page || 1}`,
    });
  }

  // Only add a Fee / EMD step if an actual fee or bid security was extracted from the document!
  const feeOrEmd = financials.find(
    f =>
      f.detailedCategory === "application_fee" ||
      f.detailedCategory === "registration_fee" ||
      f.detailedCategory === "examination_fee" ||
      f.detailedCategory === "bid_bond" ||
      f.detailedCategory === "performance_security"
  );
  if (feeOrEmd) {
    plan.push({
      id: `act_${step}`,
      title: `Arrange ${feeOrEmd.label} (${feeOrEmd.amountText})`,
      description: `Prepare official payment instrument or remittance as specified on Page ${feeOrEmd.sourceLocation.page || 1}.`,
      stepNumber: step++,
      status: "pending",
      priority: "medium",
      officialDeadline: mainDeadline,
      sourceLocation: feeOrEmd.sourceLocation,
      notes: "Retain official payment receipt and transaction reference.",
    });
  }

  // Final submission step
  plan.push({
    id: `act_${step}`,
    title: mainDeadline
      ? `Complete Final Submission Prior to Cutoff (${mainDeadline})`
      : "Complete Final Review & Submission Verification",
    description: "Assemble all required forms and supporting evidence and submit through the official channel stated in the document.",
    stepNumber: step++,
    status: "pending",
    priority: "high",
    officialDeadline: mainDeadline,
    notes: mainDeadline
      ? "Submit well ahead of the stated cutoff time to avoid portal congestion."
      : "Primary submission deadline was not explicitly stated in the extracted text; verify on the official portal.",
  });

  return plan;
}

/**
 * Deterministic Q&A search over extracted text
 */
export function answerDeterministicQuestion(
  question: string,
  doc: ParsedDocumentData,
  analysis: FullDocumentAnalysis
): DocumentQAPair {
  const qLower = question.toLowerCase().trim();

  // 1. Deadline inquiries
  if (/last\s*date|deadline|when\s*to\s*apply|cutoff|submission\s*date|due\s*date/i.test(qLower)) {
    if (analysis.primaryDeadline) {
      const pd = analysis.primaryDeadline;
      return {
        id: `qa_${Date.now()}`,
        question,
        answer: `Primary Submission Deadline: ${pd.rawText} (${pd.label}, Status: ${pd.status}), located on Page ${pd.page || 1}.`,
        mode: "deterministic",
        citations: [{ page: pd.page || 1, snippet: pd.snippet || pd.rawText }],
        confidence: pd.confidence,
        timestamp: new Date().toISOString(),
      };
    }
    if (analysis.importantDates.length > 0) {
      const dateList = analysis.importantDates
        .slice(0, 6)
        .map(d => `• ${d.label}: ${d.rawText} (Page ${d.sourceLocation.page || 1})`)
        .join("\n");
      return {
        id: `qa_${Date.now()}`,
        question,
        answer: `No single primary submission deadline was confirmed, but the following dates were extracted from the document:\n${dateList}`,
        mode: "deterministic",
        citations: analysis.importantDates.slice(0, 3).map(d => d.sourceLocation),
        confidence: 0.85,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // 2. Required documents inquiries
  if (/documents?\s*(?:needed|required|to\s*submit)|attachments?|enclosures?|mandatory/i.test(qLower)) {
    const mandatoryReqs = analysis.requirements.filter(r => r.mandatory);
    if (mandatoryReqs.length > 0) {
      const docList = mandatoryReqs.map((r, i) => `${i + 1}. ${r.name} (Page ${r.sourceLocation.page || 1})`).join("\n");
      return {
        id: `qa_${Date.now()}`,
        question,
        answer: `The document specifies ${mandatoryReqs.length} mandatory requirement(s):\n${docList}`,
        mode: "deterministic",
        citations: mandatoryReqs.map(r => r.sourceLocation).slice(0, 4),
        confidence: 0.95,
        timestamp: new Date().toISOString(),
      };
    }
    return {
      id: `qa_${Date.now()}`,
      question,
      answer: "No explicit mandatory document checklist was stated in the extracted text of this document.",
      mode: "deterministic",
      citations: [],
      confidence: 0.9,
      timestamp: new Date().toISOString(),
      notFoundInDocument: true,
    };
  }

  // 3. Financial and turnover inquiries
  if (/fee|cost|amount|turnover|emd|salary|stipend|penalty|money|budget|scholarship\s+amount/i.test(qLower)) {
    if (analysis.financialInformation.length > 0) {
      const summary = analysis.financialInformation
        .slice(0, 8)
        .map(f => `• ${f.label}: ${f.amountText} (Page ${f.sourceLocation.page || 1})`)
        .join("\n");
      return {
        id: `qa_${Date.now()}`,
        question,
        answer: `The document contains the following extracted financial figures:\n${summary}`,
        mode: "deterministic",
        citations: analysis.financialInformation.map(f => f.sourceLocation).slice(0, 3),
        confidence: 0.94,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // 4. Eligibility & minimum marks inquiries
  if (/eligib|who\s*can\s*apply|qualification|criteria|marks|percentage|cgpa|income/i.test(qLower)) {
    if (analysis.eligibilityConditions.length > 0) {
      return {
        id: `qa_${Date.now()}`,
        question,
        answer: `The eligibility conditions explicitly stated in the document include:\n${analysis.eligibilityConditions.map((e, i) => `${i + 1}. ${e}`).join("\n")}`,
        mode: "deterministic",
        citations: analysis.requirements.filter(r => r.category === "Eligibility Qualification").map(r => r.sourceLocation),
        confidence: 0.93,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // 5. Keyword search over pages
  const searchWords = qLower
    .split(/\s+/)
    .filter(w => w.length > 3 && !["what", "when", "where", "which", "does", "have", "this", "tell", "from", "with", "that"].includes(w));

  let bestPage: { pageNum: number; snippet: string; score: number } | null = null;

  for (const page of doc.pages) {
    const pLower = (page.text || "").toLowerCase();
    let score = 0;
    for (const w of searchWords) {
      if (pLower.includes(w)) score += 10;
    }
    if (score > 0 && (!bestPage || score > bestPage.score)) {
      const firstWord = searchWords.find(w => pLower.includes(w));
      const idx = firstWord ? pLower.indexOf(firstWord) : 0;
      const snippet = page.text.substring(Math.max(0, idx - 60), Math.min(page.text.length, idx + 160)).replace(/\s+/g, " ");
      bestPage = { pageNum: page.pageNumber, snippet, score };
    }
  }

  if (bestPage) {
    return {
      id: `qa_${Date.now()}`,
      question,
      answer: `Found on Page ${bestPage.pageNum}: "...${bestPage.snippet}..."`,
      mode: "deterministic",
      citations: [{ page: bestPage.pageNum, snippet: bestPage.snippet }],
      confidence: 0.85,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    id: `qa_${Date.now()}`,
    question,
    answer: "Not stated in source: The requested information was not detected in the extracted text of this document. DOCULENS deterministic search never fabricates facts or citations.",
    mode: "deterministic",
    citations: [],
    confidence: 0.98,
    timestamp: new Date().toISOString(),
    notFoundInDocument: true,
  };
}

export const answerQuestionDeterministically = answerDeterministicQuestion;

function detectCategoryFromDoc(doc: ParsedDocumentData): DocumentCategory {
  if (doc.category) return doc.category;
  if (doc.userCategory) return doc.userCategory;
  if (doc.detectedCategory) return doc.detectedCategory;
  const probe = `${doc.fileName || ''} ${doc.extractedTitle || ''} ${(doc as any).title || ''} ${doc.fullText || ''}`.toLowerCase();
  if (/\b(?:rfp|tender|request\s+for\s+proposals?|solicitation|notice\s+inviting\s+tender|bidding\s+document)\b/i.test(probe)) {
    return 'rfp_tender';
  }
  if (/\b(?:scholarship|fellowship|grant\s+application|student\s+aid|academic\s+bursary)\b/i.test(probe)) {
    return 'scholarship';
  }
  if (/\b(?:job\s+description|position\s+overview|employment\s+agreement|job\s+spec|hiring)\b/i.test(probe)) {
    return 'job';
  }
  if (/\b(?:agreement|contract|lease|terms\s+of\s+service|nda|memorandum\s+of\s+understanding)\b/i.test(probe)) {
    return 'contract';
  }
  if (/\b(?:spreadsheet|worksheet|ledger|balance\s+sheet|tabular|csv|xlsx)\b/i.test(probe)) {
    return 'spreadsheet';
  }
  return 'general';
}

/**
 * Main Deterministic Analysis Runner
 */
export function runDeterministicAnalysis(doc: ParsedDocumentData): FullDocumentAnalysis {
  const category = detectCategoryFromDoc(doc);
  const template = CATEGORY_TEMPLATES[category] || CATEGORY_TEMPLATES.general;

  const importantDates = extractDynamicDates(doc);
  const primaryDeadline = selectPrimaryDeadline(importantDates, category);
  const financialInformation = extractDynamicFinancials(doc);
  const { requirements, eligibility, requiredDocs } = extractDynamicRequirements(doc, category);
  const fraudAnalysis = doc.fraudAnalysis || analyzeDocumentFraudSignals(doc);
  doc.fraudAnalysis = fraudAnalysis;

  // RFP Intelligence extraction if document is an RFP or Tender
  const rfpIntelligence = category === "rfp_tender" ? extractRfpIntelligence(doc, importantDates, primaryDeadline, financialInformation, requirements) : undefined;

  const risksAndWarnings = extractDynamicRisks(doc, importantDates, primaryDeadline);
  const actionPlan = buildDynamicActionPlan(requirements, primaryDeadline, financialInformation);

  // Dynamic clause & condition extraction strictly from actual document pages (NO invented fallback clauses!)
  const simplifiedTerms: { clauseTitle: string; explanation: string; source: SourceLocation }[] = [];
  const clausePatterns: { title: string; regex: RegExp }[] = [
    { title: "Submission & Cutoff Adherence", regex: /(?:late\s+(?:submissions?|proposals?|applications?)|received\s+after\s+the\s+deadline|cutoff\s+time)[^.\n]{10,180}\./i },
    { title: "Indemnification & Liability Allocation", regex: /(?:indemnif(?:y|ication)|hold\s+harmless|limitation\s+of\s+liability)[^.\n]{10,180}\./i },
    { title: "Termination & Cancellation Rights", regex: /(?:termination\s+for\s+(?:convenience|cause)|may\s+terminate\s+this|cancellation\s+of\s+award)[^.\n]{10,180}\./i },
    { title: "Renewal, Attendance & Academic Standing", regex: /(?:renewal\s+of\s+scholarship|minimum\s+attendance|detain(?:ed|ment)|academic\s+standing)[^.\n]{10,180}\./i },
    { title: "Payment, Holdback & Refund Terms", regex: /(?:holdback|retention|net\s+\d+\s+days|refund\s+of\s+fee|forfeiture\s+of\s+emd)[^.\n]{10,180}\./i },
    { title: "Governing Law & Dispute Jurisdiction", regex: /(?:governed\s+by\s+the\s+laws|exclusive\s+jurisdiction|arbitration\s+shall)[^.\n]{10,180}\./i },
  ];

  for (const page of doc.pages) {
    for (const pat of clausePatterns) {
      if (simplifiedTerms.some(t => t.clauseTitle === pat.title)) continue;
      const match = (page.text || "").match(pat.regex);
      if (match) {
        simplifiedTerms.push({
          clauseTitle: pat.title,
          explanation: match[0].replace(/\s+/g, " ").trim(),
          source: { page: page.pageNumber, section: `Page ${page.pageNumber}`, snippet: match[0].trim() },
        });
      }
    }
  }

  // Extract issuing organisation from document text if not already set
  let issuingOrg = doc.issuingOrganisation;
  if (!issuingOrg) {
    if (rfpIntelligence && rfpIntelligence.snapshot.issuingAuthority !== "Not stated in source") {
      issuingOrg = rfpIntelligence.snapshot.issuingAuthority;
    } else {
      const orgMatch = doc.fullText.match(
        /(?:issued\s+by|issuing\s+authority|ministry\s+of|government\s+of|department\s+of|procuring\s+entity)\s*[:=\-]?\s*([A-Z][A-Za-z0-9\s,&.()\-]{3,70})/i
      );
      issuingOrg = orgMatch ? orgMatch[1].split(/\r?\n/)[0].trim() : "Not stated in source";
    }
  }

  // Extract reference number from text if present (never invent fake REF-xxxx!)
  const refMatch = doc.fullText.match(
    /(?:reference\s*(?:no\.?|number|id)|rfp\s*(?:no\.?|number|#)|tender\s*(?:no\.?|number|ref)|solicitation\s*(?:no\.?|number)|notice\s*no\.?)\s*[:=\-]?\s*([A-Z0-9][A-Z0-9\-\/_]{3,35})/i
  );
  const extractedRefNumber =
    rfpIntelligence?.snapshot.rfpNumber && rfpIntelligence.snapshot.rfpNumber !== "Not stated in source"
      ? rfpIntelligence.snapshot.rfpNumber
      : refMatch
      ? refMatch[1].trim()
      : "Not stated in source";

  // Extract contact information from text if present
  const emailMatch = doc.fullText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const extractedContact =
    rfpIntelligence?.snapshot.mainContact && rfpIntelligence.snapshot.mainContact !== "Not stated in source"
      ? rfpIntelligence.snapshot.mainContact
      : emailMatch
      ? emailMatch[0]
      : "Not stated in source";

  // Publication date vs Primary deadline
  const pubDateItem = importantDates.find(
    d => d.eventType === "publication_date" || d.eventType === "rfp_release_date"
  );
  const documentDateStr = doc.documentDate || pubDateItem?.rawText || "Not stated in source";
  const primaryDeadlineStr = primaryDeadline
    ? `${primaryDeadline.rawText} (${primaryDeadline.label})`
    : "Not clearly stated in the document";

  // Plain language executive summary grounded in actual extracted counts
  const safeWordCount = doc.wordCount ?? (doc.pages || []).reduce((acc, p) => acc + (p.text ? p.text.split(/\s+/).filter(Boolean).length : 0), 0);
  const mandatoryCount = requirements.filter(r => r.mandatory).length;
  let executiveSummary = "";
  if (rfpIntelligence && rfpIntelligence.opportunitySummary.plainLanguageSummary) {
    executiveSummary = rfpIntelligence.opportunitySummary.plainLanguageSummary;
  } else {
    const dlSummary = primaryDeadline
      ? `Primary submission deadline: ${primaryDeadline.rawText} (${primaryDeadline.label}, Page ${primaryDeadline.page || 1}). `
      : `Primary submission deadline: Not clearly stated in the document (${importantDates.length} other date reference(s) detected). `;
    const finSummary =
      financialInformation.length > 0
        ? `Extracted ${financialInformation.length} financial figure(s), including ${financialInformation[0].label} (${financialInformation[0].amountText}). `
        : "No explicit financial figures were stated in the extracted text. ";
    const reqSummary =
      requirements.length > 0
        ? `Identified ${requirements.length} source-grounded requirement(s) (${mandatoryCount} mandatory).`
        : "No explicit mandatory submission checklist was detected in the source text.";
    executiveSummary = `This ${template.name} document ("${doc.extractedTitle || 'Document'}") comprises ${doc.pages.length} page(s) (${safeWordCount.toLocaleString()} words). ${dlSummary}${finSummary}${reqSummary}`;
  }

  // Separate Extraction Completeness, Analysis Completeness, and Applicant/Bidder Evidence Fit (Part 6.3)
  const totalPages = Math.max(1, doc.pages.length);
  const pagesWithUsableText = doc.pages.filter(p => (p.text || "").trim().length > 0).length;
  const emptyPagesCount = totalPages - pagesWithUsableText;
  const ocrPagesCount = doc.pages.filter(p => p.isOcr && (p.text || "").trim().length > 0).length;
  const ocrFailedPagesCount = doc.pages.filter(p => p.ocrFailed).length;

  const extractionCompletenessScore = safeWordCount === 0
    ? 0
    : Math.round((pagesWithUsableText / totalPages) * 100);

  const analysisCompletenessScore = safeWordCount === 0 ? 0 : 100;

  return {
    id: `analysis_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    docId: doc.id,
    title: doc.extractedTitle,
    category,
    processingMode: "deterministic",
    aiStatus: "not_requested",
    analyzedAt: new Date().toISOString(),
    contentHash: doc.contentHash,
    originalFilename: doc.originalFilename || doc.fileName,
    isDemo: doc.isDemo,
    isRestoredWithoutSource: doc.isRestoredWithoutSource,
    extractionAudit: doc.extractionAudit,
    rfpIntelligence,
    fraudAnalysis,
    primaryDeadline,
    executiveSummary,
    keyInfo: {
      title: doc.extractedTitle,
      type: template.name,
      issuingOrganisation: issuingOrg,
      documentDate: documentDateStr,
      primaryDeadlineText: primaryDeadlineStr,
      referenceNumber: extractedRefNumber,
      primaryContact: extractedContact,
    },
    requirements,
    eligibilityConditions: eligibility,
    requiredDocuments: requiredDocs,
    importantDates: importantDates.map(d => {
      let formattedEventType = d.eventType ? String(d.eventType) : 'Important date';
      if (d.eventType === 'historical_event') formattedEventType = 'Historical reference';
      else if (d.eventType === 'rfp_release_date') formattedEventType = 'Release date';
      else if (d.eventType === 'intent_to_bid_deadline') formattedEventType = 'Intent to bid deadline';
      else if (d.eventType === 'question_clarification_deadline') formattedEventType = 'Question submission deadline';
      else if (d.eventType === 'proposal_submission_deadline') formattedEventType = 'Proposal submission deadline';
      else if (d.eventType === 'application_submission_deadline') formattedEventType = 'Application submission deadline';
      else if (d.eventType === 'pre_bid_conference') formattedEventType = 'Pre-bid conference';
      else if (d.eventType === 'interview_date') formattedEventType = 'Interviews / Presentation';
      else if (d.eventType === 'evaluation_period') formattedEventType = 'Evaluation window';
      else if (d.eventType === 'award_announcement') formattedEventType = 'Award announcement';
      return {
        ...d,
        date: d.rawText,
        eventType: formattedEventType
      };
    }),
    financialInformation,
    simplifiedTerms,
    risksAndWarnings,
    actionPlan,
    qaHistory: [],
    spreadsheetStats: doc.spreadsheetData,
    extractionVerification: {
      wordCount: doc.wordCount,
      pageCount: doc.pages.length,
      pagesWithUsableText,
      emptyPagesCount,
      ocrPagesCount,
      ocrFailedPagesCount,
      tableCount: doc.tableCount,
      sheetCount: doc.sheetCount,
      ocrStatus:
        ocrFailedPagesCount > 0 && ocrPagesCount === 0
          ? "ocr_failed"
          : ocrFailedPagesCount > 0 && ocrPagesCount > 0
          ? "partial_ocr"
          : ocrPagesCount > 0
          ? "applied"
          : emptyPagesCount > 0 && pagesWithUsableText === 0
          ? "restricted_scan"
          : "not_needed",
      qualityScore: doc.extractionQualityScore,
      engineUsed: doc.parserEngineUsed,
      warnings: doc.extractionWarnings,
      sourceCoveragePercent: extractionCompletenessScore,
    },
    readinessScore: {
      score: extractionCompletenessScore,
      extractionCompletenessScore,
      analysisCompletenessScore,
      evidenceFitScore: null,
      formulaExplanation: `Extraction Completeness: ${extractionCompletenessScore}% (${pagesWithUsableText}/${totalPages} pages with usable text). Deterministic Analysis: ${analysisCompletenessScore}% complete (${mandatoryCount} mandatory requirement(s) identified). Applicant/Bidder Evidence Fit: Not assessed until profile or Evidence Vault documents are linked.`,
      foundCount: 0,
      totalMandatoryCount: mandatoryCount,
      missingCount: mandatoryCount,
      needsVerificationCount: requirements.filter(r => !r.mandatory).length,
    },
  };
}
