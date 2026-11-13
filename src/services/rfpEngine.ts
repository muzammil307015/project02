import {
  ParsedDocumentData,
  RfpIntelligenceData,
  RfpSnapshot,
  RfpOpportunitySummary,
  RfpScheduleItem,
  RfpScopeItem,
  RfpEligibilityItem,
  RfpResponseChecklistItem,
  RfpKeyPersonnelRole,
  RfpCommercialTerms,
  RfpEvaluationMatrix,
  RfpComplianceObligation,
  RfpRiskItem,
  RfpMissingItem,
  RfpQaItem,
  RfpBidderRecommendation,
  ImportantDateItem,
  FinancialItem,
  RequirementItem,
  FullDocumentAnalysis,
} from '../types';

export function extractRfpIntelligence(
  doc: ParsedDocumentData,
  importantDates: ImportantDateItem[] = [],
  primaryDeadline: FullDocumentAnalysis['primaryDeadline'] = null,
  financials: FinancialItem[] = [],
  requirements: RequirementItem[] = []
): RfpIntelligenceData {
  const pages = doc.pages || [];

  const snapshot = extractDynamicSnapshot(doc, primaryDeadline, financials);
  if (doc.isDemo) {
    snapshot.rfpTitle = `${snapshot.rfpTitle} [DEMO FIXTURE]`;
  }
  const schedule = extractDynamicSchedule(pages, importantDates, primaryDeadline);
  const scopeOfWork = extractDynamicScope(pages);
  const eligibilityQualifications = extractDynamicEligibility(pages, requirements);
  const responseChecklist = extractDynamicChecklist(pages, requirements);
  const keyPersonnel = extractDynamicPersonnel(pages);
  const commercials = extractDynamicCommercials(pages, financials);
  const evaluationMatrix = extractDynamicEvaluation(pages);
  const complianceObligations = extractDynamicCompliance(pages, requirements);
  const risksAndRedFlags = extractDynamicRisks(pages, snapshot, schedule, commercials);
  const missingInformation = extractDynamicMissingInfo(snapshot, schedule, commercials, evaluationMatrix);
  const qaItems = extractDynamicQaItems(schedule, commercials, missingInformation);
  const bidderRecommendations = extractDynamicRecommendations(snapshot, schedule, eligibilityQualifications, risksAndRedFlags);
  const opportunitySummary = extractOpportunitySummary(doc, snapshot, schedule, scopeOfWork, commercials);

  return {
    snapshot,
    opportunitySummary,
    schedule,
    scopeOfWork,
    eligibilityQualifications,
    responseChecklist,
    keyPersonnel,
    commercials,
    evaluationMatrix,
    complianceObligations,
    risksAndRedFlags,
    missingInformation,
    qaItems,
    bidderRecommendations,
  };
}

function findLineAndPage(
  pages: { pageNumber: number; text: string }[],
  regex: RegExp
): { match: RegExpExecArray; line: string; pageNumber: number } | null {
  for (const p of pages) {
    const lines = (p.text || '').split(/\n+/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      regex.lastIndex = 0;
      const m = regex.exec(line);
      if (m) {
        return { match: m, line, pageNumber: p.pageNumber };
      }
    }
  }
  return null;
}

function extractDynamicSnapshot(
  doc: ParsedDocumentData,
  primaryDeadline: FullDocumentAnalysis['primaryDeadline'],
  financials: FinancialItem[]
): RfpSnapshot {
  const pages = doc.pages || [];
  const firstPages = pages.slice(0, 5);

  const rfpNumHit = findLineAndPage(
    firstPages,
    /\b(?:RFP|RFQ|RFI|Tender|Solicitation|Bid)\s*(?:No\.?|Number|ID|#|:|-)\s*([A-Z0-9][A-Z0-9._/-]{2,30})/i
  );

  const orgHit =
    findLineAndPage(
      firstPages,
      /(?:issued\s+by|issuing\s+(?:organization|agency|authority)|published\s+by|client|buyer|procuring\s+entity)\s*[:\-]\s*([^\n]{3,90})/i
    ) ||
    findLineAndPage(
      firstPages,
      /\b([A-Z][A-Za-z0-9&.,' -]{2,60}(?:Inc\.|LLC|Ltd\.|Corporation|Department|Ministry|Authority|Agency|University|Commission|Institute|Board))\b/
    );

  const contactHit = findLineAndPage(
    pages,
    /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/
  );

  const termHit = findLineAndPage(
    pages,
    /\b(?:contract\s+term|initial\s+term|duration\s+of\s+(?:contract|agreement)|period\s+of\s+performance)\s*[:\-]?\s*([^\n.;]{3,80})/i
  );

  const contractTypeHit = findLineAndPage(
    pages,
    /\b(Master\s+Services\s+Agreement|Fixed\s+Price|Time\s+and\s+Materials|Indefinite\s+Delivery|Task\s+Order)\b/i
  );

  const pubDate = extractReleaseDate(doc);
  const proposalDeadlineStr = primaryDeadline
    ? `${primaryDeadline.rawText}${primaryDeadline.label ? ` (${primaryDeadline.label})` : ''}`
    : 'Not clearly stated in the document';

  let opportunityStatus: RfpSnapshot['opportunityStatus'] = 'Status unclear';
  if (primaryDeadline) {
    if (primaryDeadline.status === 'Passed' || primaryDeadline.status === 'Historical') {
      opportunityStatus = 'Historical / Expired';
    } else if (primaryDeadline.status === 'Due today') {
      opportunityStatus = 'Closing soon';
    } else if (primaryDeadline.status === 'Upcoming') {
      opportunityStatus = 'Open';
    }
  }

  void financials;

  return {
    issuingAuthority: doc.issuingOrganisation || (orgHit ? orgHit.match[1].trim() : 'Not stated in source'),
    rfpTitle: doc.extractedTitle || doc.title || doc.fileName.replace(/\.[^/.]+$/, ''),
    rfpNumber: rfpNumHit ? rfpNumHit.match[1].trim() : 'Not stated in source',
    publicationDate: pubDate,
    proposalDeadline: proposalDeadlineStr,
    submissionChannel: contactHit ? `Electronic submission (${contactHit.match[1].trim()})` : 'See solicitation instructions',
    mainContact: contactHit ? contactHit.match[1].trim() : 'Not stated in source',
    procurementCategory: 'Professional / Technical Services',
    contractType: contractTypeHit ? contractTypeHit.match[1].trim() : 'Standard Procurement Contract',
    contractTerm: termHit ? termHit.match[1].trim() : 'Not stated in source',
    opportunityStatus,
    sourceCitation: {
      page: rfpNumHit ? rfpNumHit.pageNumber : 1,
      section: 'Solicitation Overview',
      snippet: rfpNumHit ? rfpNumHit.line : (pages[0]?.text || '').slice(0, 200),
    },
  };
}

function extractReleaseDate(doc: ParsedDocumentData): string {
  const firstPagesText = (doc.pages || [])
    .slice(0, 5)
    .map(p => p.text)
    .join('\n');
  const m = firstPagesText.match(
    /(?:release\s+date|issue\s+date|published\s+on|date\s+of\s+issue|rfp\s+release)\s*[:\-–]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})/i
  );
  if (m) return m[1].trim();
  return 'Not stated in source';
}

function extractOpportunitySummary(
  doc: ParsedDocumentData,
  snapshot: RfpSnapshot,
  schedule: RfpScheduleItem[],
  scope: RfpScopeItem[],
  commercials: RfpCommercialTerms
): RfpOpportunitySummary {
  const isZeroMsa = /\$0|zero[-\s]dollar|does\s+not\s+guarantee/i.test(commercials.contractValue);
  const pageCount = doc.pages?.length || 1;
  const plainLanguageSummary = [
    `Solicitation "${snapshot.rfpTitle}" (${pageCount} page${pageCount === 1 ? '' : 's'}) issued by ${snapshot.issuingAuthority}.`,
    `Primary submission deadline: ${snapshot.proposalDeadline}.`,
    `Extracted ${schedule.length} schedule milestone(s) and ${scope.length} scope/deliverable item(s) directly from the document.`,
  ].join(' ');

  return {
    issuingOrg: snapshot.issuingAuthority,
    primaryObjective: scope[0]?.description || `Deliver requested scope of work under ${snapshot.rfpTitle}.`,
    requestedServices: scope.length > 0 ? scope.slice(0, 6).map(s => `${s.title}: ${s.description}`) : ['Refer to detailed Scope of Work sections in document.'],
    vendorProfile: 'Qualified bidder meeting mandatory statutory and technical eligibility requirements.',
    procurementStructure: snapshot.contractType,
    budgetDisclosed: commercials.contractValue !== 'Not stated in source',
    budgetNotes: commercials.contractValue,
    guaranteedWork: !isZeroMsa,
    guaranteedWorkCaveat: isZeroMsa
      ? 'Zero-dollar ($0) Master Services Agreement baseline; work is allocated via competitive Task Orders with no guaranteed volume.'
      : 'Subject to final contract award and execution.',
    postSelectionNextSteps: 'Technical evaluation, fee scoring, and contract execution per solicitation schedule.',
    plainLanguageSummary,
  };
}

function extractDynamicSchedule(
  pages: { pageNumber: number; text: string }[],
  importantDates: ImportantDateItem[],
  primaryDeadline: FullDocumentAnalysis['primaryDeadline']
): RfpScheduleItem[] {
  const items: RfpScheduleItem[] = [];
  const seen = new Set<string>();

  const rangeOrDateRegex =
    /^([^\n:;|]{4,90}?)\s*(?:[:|–—-]|\s{2,})\s*((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z.,\s0-9–—/-]{4,60}\d{4})/i;

  for (const page of pages) {
    const lines = (page.text || '').split(/\n+/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.length > 220) continue;
      const m = rangeOrDateRegex.exec(line);
      if (m) {
        const eventName = m[1].replace(/^[\d.\-*•()]+\s*/, '').trim();
        const dateStr = m[2].trim();
        if (eventName.length < 3) continue;
        const key = `${eventName.toLowerCase()}__${dateStr.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const isFinal =
          /proposal\s+(?:submission\s+)?deadline|final\s+date\s+for\s+submission|proposals?\s+due|closing\s+date|bid\s+submission|submittal\s+deadline/i.test(
            eventName
          );
        const isMandatory =
          isFinal || /intent\s+to\s+bid|question|clarification|mandatory/i.test(eventName);

        items.push({
          event: eventName,
          date: dateStr,
          nature: isMandatory ? 'Mandatory' : 'Informational',
          page: page.pageNumber,
          status: 'Upcoming',
          snippet: line.slice(0, 200),
          isPrimarySubmissionDeadline: isFinal,
        });
      }
    }
  }

  for (const d of importantDates) {
    const dLabel = d.label || 'Milestone';
    const dDate = d.rawText || d.date || '';
    if (!dDate) continue;
    const key = `${dLabel.toLowerCase()}__${dDate.toLowerCase()}`;
    const alreadyCovered = items.some(
      e =>
        e.date.toLowerCase().includes(dDate.toLowerCase()) &&
        (e.event.toLowerCase().includes(dLabel.toLowerCase().slice(0, 10)) ||
          dLabel.toLowerCase().includes(e.event.toLowerCase().slice(0, 10)))
    );
    if (seen.has(key) || alreadyCovered) continue;
    seen.add(key);

    const isPrimary = Boolean(
      d.isPrimaryDeadline ||
        (primaryDeadline && primaryDeadline.rawText === dDate && primaryDeadline.label === dLabel)
    );

    items.push({
      event: dLabel,
      date: dDate,
      nature: isPrimary || d.type === 'official_deadline' ? 'Mandatory' : 'Informational',
      page: d.sourceLocation?.page || 1,
      status:
        d.status === 'Historical' || d.status === 'Passed'
          ? 'Historical / Passed'
          : d.isUrgent
          ? 'Urgent'
          : d.status === 'Upcoming'
          ? 'Upcoming'
          : 'Date unclear',
      snippet: d.sourceLocation?.snippet || `${dLabel}: ${dDate}`,
      isPrimarySubmissionDeadline: isPrimary,
    });
  }

  return items;
}

function extractDynamicScope(pages: { pageNumber: number; text: string }[]): RfpScopeItem[] {
  const scopeItems: RfpScopeItem[] = [];
  const headingRegex =
    /^(?:section\s+\d+|task\s+\d+|workstream\s+\d+|phase\s+\d+|\d+\.\d+)\s*[:\-–.]?\s*([A-Z][A-Za-z0-9 &/,()-]{4,80})$/i;

  for (const page of pages) {
    const lines = (page.text || '').split(/\n+/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = headingRegex.exec(line);
      if (
        m &&
        /scope|service|hosting|support|security|development|implementation|deliverable|maintenance|training|transition|operations|architecture|platform/i.test(
          line
        )
      ) {
        const snippetLines = lines
          .slice(i + 1, i + 5)
          .map(l => l.trim())
          .filter(Boolean);
        if (snippetLines.length === 0) continue;
        const desc = snippetLines.join(' ').slice(0, 240);
        scopeItems.push({
          category: /security/i.test(line)
            ? 'Security'
            : /technical|architecture/i.test(line)
            ? 'Technical'
            : /deliverable/i.test(line)
            ? 'Deliverable'
            : 'Workstream',
          title: line,
          description: desc,
          page: page.pageNumber,
          snippet: `${line} — ${desc}`.slice(0, 240),
        });
      }
    }
  }

  return scopeItems.slice(0, 12);
}

function extractDynamicEligibility(
  pages: { pageNumber: number; text: string }[],
  requirements: RequirementItem[]
): RfpEligibilityItem[] {
  const items: RfpEligibilityItem[] = [];
  const eligReqs = requirements.filter(
    r =>
      (r.category || '').toLowerCase().includes('eligibility') ||
      /eligible|qualification|experience|certified|incorporat|conflict of interest|minimum\s+\d+\s+years|turnover/i.test(
        r.description
      )
  );

  for (const req of eligReqs.slice(0, 12)) {
    const reqTitle = req.name || req.title || 'Qualification Requirement';
    items.push({
      requirement: reqTitle,
      explanation: req.description,
      mandatory: req.mandatory,
      passFail: req.mandatory,
      evidenceNeeded: req.description,
      page: req.sourceLocation?.page || req.pageNumber || 1,
      snippet: req.sourceLocation?.snippet || req.sourceQuote || req.description,
    });
  }

  if (items.length === 0) {
    for (const p of pages) {
      const lines = (p.text || '').split(/\n+/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (
          line.length >= 25 &&
          line.length <= 240 &&
          /\b(?:bidders?\s+must|offerors?\s+shall|minimum\s+qualifications?|eligibility\s+criteria)\b/i.test(line)
        ) {
          items.push({
            requirement: line.slice(0, 90),
            explanation: line,
            mandatory: /\b(?:must|shall|mandatory)\b/i.test(line),
            passFail: /\b(?:must|shall|mandatory)\b/i.test(line),
            evidenceNeeded: 'Documentary proof as specified in solicitation',
            page: p.pageNumber,
            snippet: line,
          });
          if (items.length >= 8) break;
        }
      }
      if (items.length >= 8) break;
    }
  }

  return items;
}

function extractDynamicChecklist(
  _pages: { pageNumber: number; text: string }[],
  requirements: RequirementItem[]
): RfpResponseChecklistItem[] {
  const checklist: RfpResponseChecklistItem[] = [];

  for (const req of requirements) {
    if (req.classification === 'Informational' || req.classification === 'Not applicable') continue;
    const reqTitle = req.name || req.title || 'Submission Item';
    checklist.push({
      component: reqTitle,
      description: req.description,
      format: 'PDF / Standard Submission Package',
      page: req.sourceLocation?.page || req.pageNumber || 1,
      mandatory: req.mandatory,
      snippet: req.sourceLocation?.snippet || req.sourceQuote || req.description,
    });
  }

  return checklist.slice(0, 20);
}

function extractDynamicPersonnel(pages: { pageNumber: number; text: string }[]): RfpKeyPersonnelRole[] {
  const roles: RfpKeyPersonnelRole[] = [];
  const roleRegex =
    /\b(Project\s+Manager|Program\s+Manager|Technical\s+Lead|Lead\s+Architect|Solutions?\s+Architect|Security\s+Officer|CISO|Key\s+Personnel|Account\s+Manager|Quality\s+Assurance\s+Lead|DevOps\s+Engineer|Business\s+Analyst)\b/i;

  for (const page of pages) {
    const lines = (page.text || '').split(/\n+/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const m = roleRegex.exec(line);
      if (m && line.length >= 20 && line.length <= 240) {
        if (roles.some(r => r.roleTitle.toLowerCase() === m[1].toLowerCase())) continue;
        const yrsMatch = line.match(/(\d+)\+?\s*years/i);
        roles.push({
          roleTitle: m[1],
          minExperienceYears: yrsMatch ? parseInt(yrsMatch[1], 10) : 5,
          requiredQualifications: line,
          page: page.pageNumber,
          snippet: line,
        });
        if (roles.length >= 8) break;
      }
    }
    if (roles.length >= 8) break;
  }

  return roles;
}

function extractDynamicCommercials(
  pages: { pageNumber: number; text: string }[],
  financials: FinancialItem[]
): RfpCommercialTerms {
  const baselineOrBudget = financials.find(
    f =>
      f.detailedCategory === 'financial_baseline' ||
      f.detailedCategory === 'contract_ceiling' ||
      f.detailedCategory === 'estimated_contract_value' ||
      f.detailedCategory === 'actual_project_budget' ||
      f.type === 'tender_value'
  );

  const holdbackItem = financials.find(f => f.detailedCategory === 'retainage' || /holdback|retainage/i.test(f.label));
  const insuranceItems = financials.filter(f => f.detailedCategory === 'insurance_requirement');

  let paymentSnippet = baselineOrBudget?.sourceLocation?.snippet || 'See commercial terms section in document.';
  let paymentPage = baselineOrBudget?.sourceLocation?.page || 1;

  for (const p of pages) {
    const m = (p.text || '').match(/([^\n.]*\b(?:hourly\s+rate|time\s+and\s+materials|holdback|retainage|invoic)[^\n.]*\.)/i);
    if (m) {
      paymentSnippet = m[1].trim();
      paymentPage = p.pageNumber;
      break;
    }
  }

  return {
    contractValueType: baselineOrBudget ? baselineOrBudget.label : 'As specified in solicitation',
    contractValue: baselineOrBudget ? `${baselineOrBudget.amountText} (${baselineOrBudget.label})` : 'Not stated in source',
    hourlyRateRequirement: 'Proposers must provide fully burdened hourly rates by labor category where applicable.',
    onshoreOffshoreSplit: false,
    paymentTerms: 'Milestone / task-order invoicing subject to verification',
    retainageHoldback: holdbackItem ? `${holdbackItem.amountText} (${holdbackItem.label})` : 'None explicitly stated',
    insuranceRequirements:
      insuranceItems.length > 0
        ? insuranceItems.map(i => `${i.label}: ${i.amountText}`).join('; ')
        : undefined,
    taxesAndCurrency: financials[0]?.currency || 'USD ($)',
    page: paymentPage,
    snippet: paymentSnippet,
  };
}

function extractDynamicEvaluation(pages: { pageNumber: number; text: string }[]): RfpEvaluationMatrix {
  const categories: RfpEvaluationMatrix['categories'] = [];

  for (const page of pages) {
    const lines = (page.text || '').split(/\n+/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const ptsMatch = line.match(/^([A-Za-z0-9 &/,()-]{4,70}?)\s*[:\-–]?\s*(\d{1,3})\s*(?:points|pts|%)\b/i);
      if (ptsMatch) {
        const catName = ptsMatch[1].trim();
        const pts = parseInt(ptsMatch[2], 10);
        if (!isNaN(pts) && pts > 0 && pts <= 1000 && !categories.some(c => c.category === catName)) {
          categories.push({
            category: catName,
            maxPoints: pts,
            description: line,
            page: page.pageNumber,
          });
        }
      }
    }
  }

  const totalPoints = categories.reduce((sum, c) => sum + c.maxPoints, 0) || 100;
  const feeCat = categories.find(c => /fee|cost|price|commercial/i.test(c.category));
  const feeMaxPoints = feeCat ? feeCat.maxPoints : Math.round(totalPoints * 0.25);
  const technicalMaxPoints = totalPoints - feeMaxPoints;

  return {
    totalPoints,
    technicalMaxPoints,
    feeMaxPoints,
    minimumQualifyingScore: Math.round(totalPoints * 0.7),
    feeScoringFormula: 'Lowest Priced Qualifying Proposal receives maximum fee points; other proposals scored proportionally.',
    categories,
    notes:
      categories.length > 0
        ? `Extracted ${categories.length} evaluation scoring category/categories from solicitation text.`
        : 'No explicit numerical point table detected in source text.',
  };
}

function extractDynamicCompliance(
  pages: { pageNumber: number; text: string }[],
  requirements: RequirementItem[]
): RfpComplianceObligation[] {
  const obligations: RfpComplianceObligation[] = [];

  for (const page of pages) {
    const lines = (page.text || '').split(/\n+/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (
        line.length >= 25 &&
        line.length <= 240 &&
        /\b(?:ISO\s*27001|SOC\s*2|NIST|WCAG|GDPR|HIPAA|FedRAMP|indemnif|insurance|liability|confidentiality|work\s+made\s+for\s+hire|intellectual\s+property|termination)\b/i.test(
          line
        )
      ) {
        if (obligations.some(o => o.snippet === line)) continue;
        let topic: RfpComplianceObligation['topic'] = 'Data Protection / Privacy';
        if (/intellectual\s+property|work\s+made\s+for\s+hire/i.test(line)) topic = 'IP Ownership';
        else if (/confidential/i.test(line)) topic = 'Confidentiality';
        else if (/insurance/i.test(line)) topic = 'Insurance';
        else if (/indemnif|liability/i.test(line)) topic = 'Indemnification';
        else if (/termination/i.test(line)) topic = 'Termination';

        obligations.push({
          clause: `Page ${page.pageNumber} Provision`,
          topic,
          summary: line,
          flagForLegalReview: /indemnif|unlimited|termination|work\s+made\s+for\s+hire/i.test(line),
          page: page.pageNumber,
          snippet: line,
        });
        if (obligations.length >= 12) break;
      }
    }
    if (obligations.length >= 12) break;
  }

  void requirements;
  return obligations;
}

function extractDynamicRisks(
  pages: { pageNumber: number; text: string }[],
  snapshot: RfpSnapshot,
  schedule: RfpScheduleItem[],
  commercials: RfpCommercialTerms
): RfpRiskItem[] {
  const risks: RfpRiskItem[] = [];

  if (snapshot.proposalDeadline === 'Not clearly stated in the document') {
    risks.push({
      id: 'risk_missing_deadline',
      title: 'Primary Submission Deadline Not Explicitly Found',
      severity: 'high',
      reason: 'Cannot confirm exact submission cutoff from extracted text alone.',
      page: 1,
      snippet: 'No explicit submission deadline phrase detected in parsed text.',
      recommendation: 'Verify the submission deadline in the cover notice or procurement portal.',
    });
  }

  for (const page of pages) {
    const lines = (page.text || '').split(/\n+/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (
        line.length >= 25 &&
        line.length <= 240 &&
        /\b(?:liquidated\s+damages|termination\s+for\s+convenience|unlimited\s+liability|no\s+price\s+escalation|sole\s+discretion|disqualif|late\s+proposals?\s+will\s+not\s+be\s+accepted|does\s+not\s+guarantee\s+any\s+work)\b/i.test(
          line
        )
      ) {
        risks.push({
          id: `risk_${risks.length + 1}`,
          title: line.slice(0, 75),
          severity: /unlimited|disqualif|liquidated/i.test(line) ? 'high' : 'medium',
          reason: line,
          page: page.pageNumber,
          snippet: line,
          recommendation: 'Review clause with legal/commercial team before submission.',
        });
        if (risks.length >= 8) break;
      }
    }
    if (risks.length >= 8) break;
  }

  void schedule;
  void commercials;
  return risks;
}

function extractDynamicMissingInfo(
  snapshot: RfpSnapshot,
  schedule: RfpScheduleItem[],
  commercials: RfpCommercialTerms,
  evaluationMatrix: RfpEvaluationMatrix
): RfpMissingItem[] {
  const missing: RfpMissingItem[] = [];

  if (commercials.contractValue === 'Not stated in source') {
    missing.push({
      item: 'Budget Cap / Contract Value Ceiling',
      category: 'Commercial',
      impact: 'No explicit budget ceiling or contract cap was stated in the extracted text.',
      recommendation: 'Submit written inquiry asking whether an estimated budget range or ceiling applies.',
      status: 'Not specified in this document',
    });
  }

  if (evaluationMatrix.categories.length === 0) {
    missing.push({
      item: 'Explicit Evaluation Weightings',
      category: 'Evaluation',
      impact: 'No numerical point breakdown for evaluation criteria was detected in the document.',
      recommendation: 'Request clarification on relative weighting between technical merit and cost scoring.',
      status: 'Not specified in this document',
    });
  }

  if (schedule.length === 0 && snapshot.proposalDeadline === 'Not clearly stated in the document') {
    missing.push({
      item: 'Procurement Schedule Table',
      category: 'Timeline',
      impact: 'No dated procurement schedule milestones were found in the document text.',
      recommendation: 'Confirm key procurement milestones and submission deadline on the official portal.',
      status: 'Not specified in this document',
    });
  }

  return missing;
}

function extractDynamicQaItems(
  schedule: RfpScheduleItem[],
  commercials: RfpCommercialTerms,
  missing: RfpMissingItem[]
): RfpQaItem[] {
  return missing.map((m, idx) => ({
    number: idx + 1,
    question: `Clarification Inquiry — ${m.item}: ${m.recommendation}`,
    answer: `Impact: ${m.impact} (${m.status})`,
    page: schedule[0]?.page || commercials.page || 1,
  }));
}

function extractDynamicRecommendations(
  snapshot: RfpSnapshot,
  schedule: RfpScheduleItem[],
  eligibility: RfpEligibilityItem[],
  risks: RfpRiskItem[]
): RfpBidderRecommendation[] {
  const recs: RfpBidderRecommendation[] = [];

  if (snapshot.proposalDeadline !== 'Not clearly stated in the document') {
    recs.push({
      priority: 'High',
      step: `Lock Proposal Calendar Around ${snapshot.proposalDeadline}`,
      action: `Schedule internal red-team review and final package verification prior to ${snapshot.proposalDeadline}.`,
      rationale: `Primary deadline extracted from Page ${snapshot.sourceCitation.page || 1}.`,
      sourceOrigin: 'Direct RFP Requirement',
    });
  }

  if (eligibility.length > 0) {
    recs.push({
      priority: 'High',
      step: `Verify ${eligibility.length} Extracted Eligibility & Compliance Gate(s)`,
      action: 'Confirm documentary proof exists in the Evidence Vault for each mandatory requirement before committing bid resources.',
      rationale: `Based on ${eligibility.length} extracted requirement item(s).`,
      sourceOrigin: 'Direct RFP Requirement',
    });
  }

  if (risks.length > 0) {
    recs.push({
      priority: 'Medium',
      step: `Address ${risks.length} Identified Clause / Timeline Signal(s)`,
      action: 'Review highlighted terms and prepare clarification questions or contract exceptions prior to the cutoff.',
      rationale: `Based on ${risks.length} extracted risk item(s).`,
      sourceOrigin: 'DOCULENS Automated Advisory',
    });
  }

  void schedule;
  return recs;
}
