import {
  extractDynamicDates,
  selectPrimaryDeadline,
  extractDynamicFinancials,
  extractDynamicRequirements,
  runDeterministicAnalysis,
} from "../src/services/deterministicEngine";
import { analyzeDocumentFraudSignals } from "../src/services/fraudScanner";
import { scanSensitiveEntities, verifyLuhn } from "../src/services/privacyService";
import { compareRequirementsWithEvidence } from "../src/services/comparisonEngine";
import {
  ParsedDocumentData,
  UserProfile,
  EvidenceDocument,
  DocumentPage,
  DocumentCategory,
} from "../src/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, details?: string) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${testName}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

function makeTestDoc(
  pages: DocumentPage[],
  category: DocumentCategory = "scholarship"
): ParsedDocumentData {
  const fullText = pages.map((p) => p.text).join("\n\n");
  return {
    id: `test_${Date.now()}`,
    fileName: "test_doc.pdf",
    fileType: "PDF",
    fileSizeBytes: fullText.length,
    detectedFormat: "PDF",
    pages,
    fullText,
    redactedText: fullText,
    sensitiveDetections: [],
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
    tableCount: 0,
    sheetCount: 0,
    extractionQualityScore: 98,
    parserEngineUsed: "Digital PDF Parser",
    ocrApplied: false,
    extractionWarnings: [],
    detectedCategory: category,
    extractedTitle: "Test Document",
    uploadedAt: new Date().toISOString(),
  };
}

console.log("=== DOCULENS COMPREHENSIVE VERIFICATION SUITE ===\n");

// 1. Date & Primary Deadline Tests
{
  const doc = makeTestDoc([
    {
      pageNumber: 1,
      text: `
        Notification Published Date: 12 January 2026
        Online Application Portal Opens: 15 January 2026
        Last Date for Online Application Submission: 28 February 2026 at 17:00 IST
        Document Verification Window: 10 March 2026
        Final Merit List Announcement Date: 25 March 2026
      `,
      confidence: 0.98,
      isOcr: false,
    },
  ]);
  const dates = extractDynamicDates(doc);
  const primary = selectPrimaryDeadline(dates);

  assert(
    dates.length >= 4,
    "Extracts multiple distinct dates from scholarship/notification text",
    `Got ${dates.length}`
  );
  assert(
    primary !== null &&
      primary !== undefined &&
      primary.rawText.includes("28 February 2026"),
    "Selects Application Submission Deadline (28 February 2026) over publication or announcement dates",
    `Selected: ${primary?.rawText} (${primary?.eventType})`
  );
}

// 2. Financial Extraction & Indian Lakh / Crore Normalization Tests
{
  const doc = makeTestDoc([
    {
      pageNumber: 1,
      text: `
        1. Annual Family Income Ceiling: Applicant family income must not exceed Rs. 8.00 Lakh per annum.
        2. Undergraduate Maintenance Allowance: INR 75,000 per year.
        3. Research Contingency Grant: ₹ 1.5 Crore total allocation.
        4. Non-refundable Application Fee: USD 50.
        5. Bid Security / EMD: $25,000.
      `,
      confidence: 0.98,
      isOcr: false,
    },
  ]);
  const financials = extractDynamicFinancials(doc);
  const lakhItem = financials.find((f) => f.numericValue === 800000);
  const croreItem = financials.find((f) => f.numericValue === 15000000);
  const incomeCapItem = financials.find(
    (f) => f.type === "turnover" && f.label.includes("Family Income")
  );

  assert(
    financials.length >= 4,
    "Extracts multiple currency formats (Rs. Lakh, INR, ₹ Crore, USD, $)",
    `Got ${financials.length}`
  );
  assert(
    Boolean(lakhItem),
    "Correctly normalizes 'Rs. 8.00 Lakh' to numericValue = 800,000"
  );
  assert(
    Boolean(croreItem),
    "Correctly normalizes '₹ 1.5 Crore' to numericValue = 15,000,000"
  );
  assert(
    Boolean(incomeCapItem),
    "Classifies family income ceiling as 'Maximum Family Income Eligibility Threshold'"
  );
}

// 3. Requirement Extraction vs General Advice Filtering
{
  const doc = makeTestDoc([
    {
      pageNumber: 1,
      text: `
        Applicants are advised to keep a copy of the printout for future reference.
        It is recommended to apply early to avoid last-minute server rush.
        Applicants must submit an official Income Certificate issued by a Competent Authority.
        Bidders shall provide 3 years of Audited Financial Statements (FY 2022-23, 2023-24, 2024-25).
        If applying under the Disability Reserved Category, candidates must upload a valid UDID Disability Certificate.
      `,
      confidence: 0.98,
      isOcr: false,
    },
  ]);
  const { requirements: reqs } = extractDynamicRequirements(doc);
  const hasPrintoutAdvice = reqs.some(
    (r) =>
      r.description.toLowerCase().includes("keep a copy of the printout") &&
      r.mandatory
  );
  const hasIncomeCert = reqs.some(
    (r) =>
      r.description.toLowerCase().includes("income certificate") && r.mandatory
  );
  const hasConditional = reqs.some((r) => r.classification === "Conditional");

  assert(
    !hasPrintoutAdvice,
    "Does NOT misclassify 'advised to keep a copy of the printout' as a mandatory requirement"
  );
  assert(
    hasIncomeCert,
    "Extracts mandatory Income Certificate requirement accurately"
  );
  assert(
    hasConditional,
    "Identifies conditional requirement ('If applying under...') as Conditional"
  );
}

// 4. Non-WCI RFP Fixture Isolation Test
{
  const customRfpDoc = makeTestDoc(
    [
      {
        pageNumber: 1,
        text: `
          REQUEST FOR PROPOSALS: MUNICIPAL SOLAR MICROGRID DEPLOYMENT
          Issuing Authority: City of Austin Energy Department
          Proposal Submission Deadline: 15 November 2026
          Estimated Project Budget: $1,250,000
          Bidders must hold a valid NABCEP PV Installation Professional Certification.
        `,
        confidence: 0.96,
        isOcr: false,
      },
    ],
    "rfp_tender"
  );
  customRfpDoc.isDemo = false;

  const analysis = runDeterministicAnalysis(customRfpDoc);
  const serialized = JSON.stringify(analysis);
  const hasWciLeak =
    serialized.includes("Wildlife Conservation India") ||
    serialized.includes("WCI-RFP-2025") ||
    serialized.includes("Ananya Sharma");

  assert(
    !hasWciLeak,
    "Real non-WCI RFP analysis contains ZERO leaked WCI demo fixture strings"
  );
}

// 5. File Authenticity & Fraud Signal Detection Tests
{
  const cleanDoc = makeTestDoc([
    {
      pageNumber: 1,
      text: `
        NATIONAL UNIVERSITY MERIT FELLOWSHIP 2026
        Official Portal: https://fellowships.university.edu.gov
        Contact: registrar@university.edu.gov
        No application fee is charged at any stage of the fellowship selection process.
      `,
      confidence: 0.99,
      isOcr: false,
    },
  ]);
  cleanDoc.documentMetadata = {
    creator: "Adobe InDesign 19.0",
    producer: "Adobe PDF Library 17.0",
    creationDate: "2026-01-10T09:00:00Z",
    modificationDate: "2026-01-10T09:05:00Z",
  };

  const suspiciousDoc = makeTestDoc([
    {
      pageNumber: 1,
      text: `
        MINISTRY OF HIGHER EDUCATION NATIONAL GRANT BOARD
        100% Guaranteed Approval without interview! Act immediately within 24 hours!
        To release your grant of $25,000, pay a processing fee and security deposit of $450 via Gift Card, Bitcoin, or Western Union to personal account.
        Send payment receipt to: nationalgrantboard.verify@gmail.com or WhatsApp +1-555-0199.
        Apply at: https://bit.ly/gov-grant-claim-now
      `,
      confidence: 0.95,
      isOcr: false,
    },
  ]);
  suspiciousDoc.documentMetadata = {
    creator: "Canva PDF Editor",
    producer: "ilovepdf.com",
    incrementalRevisionCount: 4,
  };

  const cleanReport = analyzeDocumentFraudSignals(cleanDoc);
  const suspiciousReport = analyzeDocumentFraudSignals(suspiciousDoc);

  assert(
    cleanReport.overallLabel === "No warning detected" &&
      cleanReport.riskScore < 20,
    "Clean official document receives 'No warning detected'",
    `Got ${cleanReport.overallLabel} (score ${cleanReport.riskScore})`
  );
  assert(
    suspiciousReport.riskScore >= 45 &&
      (suspiciousReport.overallLabel === "Potentially suspicious" ||
        suspiciousReport.overallLabel === "Strong warning signal"),
    "Suspicious advance-fee / free-webmail / gift-card document triggers elevated fraud risk signals",
    `Got ${suspiciousReport.overallLabel} (score ${suspiciousReport.riskScore})`
  );
  assert(
    suspiciousReport.suspiciousPaymentInstructions.length > 0 &&
      suspiciousReport.linkAndContactWarnings.length > 0,
    "Suspicious document flags payment red flags and official-org free-email mismatch"
  );
}

// 6. Privacy & Redaction Precision Tests
{
  const pages = [
    {
      pageNumber: 1,
      text: `
        The Vendor shall indemnify the Client against all third-party claims and liabilities.
        Vendor Legal Name: Apex Horizon Technologies Pvt. Ltd.
        Contact Email: compliance@apexhorizon.in
        Invalid Card Sequence: 4111 1111 1111 1112
      `,
      confidence: 0.99,
      isOcr: false,
    },
  ];
  const { detections } = scanSensitiveEntities(pages);
  const orgDetections = detections.filter((d) => d.category === "companyName");
  const overmatchedClause = orgDetections.some((d) =>
    d.rawText.toLowerCase().includes("shall indemnify")
  );
  const matchedRealCompany = orgDetections.some((d) =>
    d.rawText.includes("Apex Horizon Technologies")
  );

  assert(
    !overmatchedClause,
    "Company name regex does NOT overmatch legal sentences ('The Vendor shall indemnify...')"
  );
  assert(
    matchedRealCompany,
    "Company name detector captures actual company with legal suffix ('Apex Horizon Technologies Pvt. Ltd.')"
  );
  assert(
    !verifyLuhn("4111111111111112"),
    "Luhn validator rejects invalid 16-digit card number"
  );
}

// 7. Evidence Vault Fact Verification & 3-Metric Readiness Separation
{
  const sampleDoc = makeTestDoc([
    {
      pageNumber: 1,
      text: `
        Applicants must submit an official Income Certificate.
        Applicants must provide an Academic Transcript / Marksheet.
        Applicants must submit a Valid Passport Copy.
      `,
      confidence: 0.98,
      isOcr: false,
    },
  ]);

  const baseAnalysis = runDeterministicAnalysis(sampleDoc);
  const profile: UserProfile = {
    id: "prof_1",
    profileType: "student",
    displayName: "Aarav Verma",
    organizationName: "IIT Delhi",
    fieldOrIndustry: "Computer Science",
    experienceYears: 2,
    qualifications: ["M.Tech 1st Year", "9.1 CGPA"],
    skills: ["Machine Learning"],
    certifications: [],
    annualTurnover: "INR 4,50,000",
    updatedAt: new Date().toISOString(),
  };
  const evidenceDocs: EvidenceDocument[] = [
    {
      id: "ev_1",
      fileName: "Official_Income_Certificate_2026.pdf",
      fileType: "application/pdf",
      fileSize: 124000,
      uploadedAt: new Date().toISOString(),
      category: "Financial / Tax",
      facts: [
        {
          id: "fact_1",
          field: "Annual Family Income",
          value: "INR 4,50,000",
          sourceDocumentName: "Official_Income_Certificate_2026.pdf",
          sourceLocation: { page: 1, snippet: "Annual family income Rs. 4,50,000" },
          extractionDate: new Date().toISOString(),
          confidence: 0.98,
          verificationStatus: "user_confirmed",
          category: "Financial",
        },
      ],
      verificationStatus: "user_confirmed",
    },
  ];

  const compared = compareRequirementsWithEvidence(
    baseAnalysis,
    profile,
    evidenceDocs
  );
  const rs = compared.readinessScore!;

  assert(
    typeof rs.extractionCompletenessScore === "number" &&
      typeof rs.analysisCompletenessScore === "number" &&
      typeof rs.evidenceFitScore === "number",
    "Readiness score separates Extraction Completeness, Analysis Completeness, and Evidence Fit Score"
  );
}

console.log(`\n=== SUMMARY: ${passed} PASSED, ${failed} FAILED ===`);
if (failed > 0) {
  process.exit(1);
}
