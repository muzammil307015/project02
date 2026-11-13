import {
  RequirementItem,
  VaultDocument,
  EvidenceDocument,
  ApplicantProfile,
  UserProfile,
  ComparisonResult,
  ComparisonMatch,
  ImportantDate,
  ImportantDateItem,
  FullDocumentAnalysis,
} from '../types';

export function compareRequirementsWithEvidence(
  analysis: FullDocumentAnalysis,
  profile: UserProfile | ApplicantProfile | null,
  evidenceDocs: (EvidenceDocument | VaultDocument)[] = []
): FullDocumentAnalysis {
  const p = (profile || {}) as any;
  const hasVaultOrProfile =
    evidenceDocs.length > 0 ||
    Boolean(
      p.displayName?.trim() ||
        p.fullName?.trim() ||
        p.organizationName?.trim() ||
        p.annualTurnover?.trim() ||
        p.annualRevenueOrIncome?.trim() ||
        (Array.isArray(p.qualifications) && p.qualifications.length > 0) ||
        (Array.isArray(p.certifications) && p.certifications.length > 0)
    );

  const updatedRequirements: RequirementItem[] = (analysis.requirements || []).map(req => {
    const reqTitle = req.name || req.title || 'Requirement';
    const reqLower = `${reqTitle} ${req.description || ''}`.toLowerCase();

    if (req.classification === 'Informational' || req.classification === 'Not applicable') {
      return {
        ...req,
        verificationStatus: 'NOT_APPLICABLE',
        evidenceStatus: 'Not applicable',
      };
    }

    if (!hasVaultOrProfile) {
      return {
        ...req,
        verificationStatus: 'NOT_ASSESSED',
        evidenceStatus: 'Not assessed',
      };
    }

    // 1. Check Evidence Vault facts
    for (const doc of evidenceDocs) {
      const docFacts = (doc as any).facts || [];
      for (const fact of docFacts) {
        const factKey = fact.field || fact.key || '';
        const factVal = fact.value || '';
        const factQuote = fact.sourceLocation?.snippet || fact.sourceQuote || '';
        const factLower = `${factKey} ${factVal} ${factQuote}`.toLowerCase();
        if (doesFactSatisfyRequirement(reqLower, factLower)) {
          return {
            ...req,
            verificationStatus: 'FOUND',
            evidenceStatus: 'Found',
            matchedEvidenceId: doc.id,
            matchedEvidenceText: `${doc.fileName} — ${factKey}: ${factVal}`,
            matchedExcerpt: factQuote || `${factKey}: ${factVal}`,
          };
        }
      }

      const docMetaLower = `${doc.fileName} ${doc.category}`.toLowerCase();
      if (doesMetadataPartiallyMatch(reqLower, docMetaLower)) {
        return {
          ...req,
          verificationStatus: 'NEEDS_VERIFICATION',
          evidenceStatus: 'Needs verification',
          matchedEvidenceId: doc.id,
          matchedEvidenceText: `${doc.fileName} (Candidate document — verify specific clause)`,
        };
      }
    }

    // 2. Check UserProfile / ApplicantProfile fields
    const profileCorpus = [
      p.displayName,
      p.fullName,
      p.organizationName,
      p.fieldOrIndustry,
      p.annualTurnover,
      p.annualRevenueOrIncome,
      p.gstNumber,
      p.panNumber,
      p.companyRegistrationNumber,
      p.taxIdOrRegistrationNumber,
      ...(Array.isArray(p.qualifications) ? p.qualifications : []),
      ...(Array.isArray(p.skills) ? p.skills : []),
      ...(Array.isArray(p.certifications) ? p.certifications : []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (profileCorpus && doesFactSatisfyRequirement(reqLower, profileCorpus)) {
      return {
        ...req,
        verificationStatus: 'FOUND',
        evidenceStatus: 'Found',
        matchedEvidenceText: `Matched against Applicant/Bidder Profile (${p.displayName || p.fullName || 'Profile'})`,
      };
    }

    return {
      ...req,
      verificationStatus: req.mandatory ? 'MISSING_EVIDENCE' : 'NEEDS_VERIFICATION',
      evidenceStatus: req.mandatory ? 'Missing evidence' : 'Needs verification',
    };
  });

  const actionableReqs = updatedRequirements.filter(
    r => r.mandatory || r.classification === 'Mandatory' || r.classification === 'Conditional'
  );
  const totalMandatoryCount = actionableReqs.length;
  const foundCount = actionableReqs.filter(r => r.verificationStatus === 'FOUND').length;
  const partialCount = actionableReqs.filter(r => r.verificationStatus === 'NEEDS_VERIFICATION').length;
  const missingCount = actionableReqs.filter(r => r.verificationStatus === 'MISSING_EVIDENCE').length;

  const extractionCompletenessScore =
    analysis.readinessScore?.extractionCompletenessScore ??
    analysis.extractionVerification?.sourceCoveragePercent ??
    100;
  const analysisCompletenessScore =
    analysis.readinessScore?.analysisCompletenessScore ?? 100;

  let evidenceFitScore: number | null = null;
  if (hasVaultOrProfile) {
    evidenceFitScore =
      totalMandatoryCount > 0
        ? Math.max(0, Math.min(100, Math.round(((foundCount + partialCount * 0.5) / totalMandatoryCount) * 100)))
        : 100;
  }

  const overallScore =
    evidenceFitScore !== null
      ? Math.round(extractionCompletenessScore * 0.3 + analysisCompletenessScore * 0.2 + evidenceFitScore * 0.5)
      : extractionCompletenessScore;

  return {
    ...analysis,
    requirements: updatedRequirements,
    readinessScore: {
      score: overallScore,
      extractionCompletenessScore,
      analysisCompletenessScore,
      evidenceFitScore,
      formulaExplanation:
        evidenceFitScore !== null
          ? `Extraction Completeness: ${extractionCompletenessScore}% | Analysis Completeness: ${analysisCompletenessScore}% | Applicant/Bidder Evidence Fit: ${evidenceFitScore}% (${foundCount}/${totalMandatoryCount} mandatory requirements verified, ${partialCount} partial/needs verification, ${missingCount} missing).`
          : `Extraction Completeness: ${extractionCompletenessScore}% | Analysis Completeness: ${analysisCompletenessScore}% | Evidence Fit: Not assessed (no profile or Evidence Vault documents linked).`,
      foundCount,
      totalMandatoryCount,
      missingCount,
      needsVerificationCount: partialCount,
    },
  };
}

export function compareDocumentWithVault(
  requirements: RequirementItem[],
  importantDates: (ImportantDate | ImportantDateItem)[],
  vaultDocs: VaultDocument[],
  profile: ApplicantProfile
): ComparisonResult {
  const hasVaultOrProfile =
    vaultDocs.length > 0 ||
    Boolean(
      profile.fullName?.trim() ||
        profile.organizationName?.trim() ||
        profile.degreeLevel?.trim() ||
        profile.gpa?.trim() ||
        profile.countryOfCitizenship?.trim() ||
        (profile.CustomFacts && Object.keys(profile.CustomFacts).length > 0)
    );

  const actionableRequirements = requirements.filter(
    req =>
      req.classification === 'Mandatory' ||
      req.classification === 'Conditional' ||
      (req.mandatory && req.classification !== 'Informational' && req.classification !== 'Recommended')
  );

  const matches: ComparisonMatch[] = actionableRequirements.map(req => {
    const reqTitle = req.title || req.name || 'Requirement';
    const reqLower = `${reqTitle} ${req.description || ''}`.toLowerCase();

    if (!hasVaultOrProfile) {
      return {
        requirementId: req.id,
        requirementTitle: reqTitle,
        requirementCategory: req.category,
        mandatory: req.mandatory,
        status: 'NOT_ASSESSED',
        explanation: 'No Evidence Vault documents or applicant profile facts have been uploaded yet to assess this requirement.',
        actionNeeded: `Upload supporting evidence for: ${reqTitle}`,
      };
    }

    for (const doc of vaultDocs) {
      const docFacts = doc.facts || [];
      for (const fact of docFacts) {
        const factText = `${fact.key} ${fact.value} ${fact.sourceQuote || ''}`.toLowerCase();
        if (doesFactSatisfyRequirement(reqLower, factText)) {
          return {
            requirementId: req.id,
            requirementTitle: reqTitle,
            requirementCategory: req.category,
            mandatory: req.mandatory,
            status: 'FOUND',
            matchedVaultDocId: doc.id,
            matchedVaultDocName: doc.fileName,
            matchedFactValue: `${fact.key}: ${fact.value}`,
            explanation: `Verified against extracted fact (${fact.key}: ${fact.value}) in "${doc.fileName}".`,
          };
        }
      }

      const docMetaLower = `${doc.fileName} ${doc.category}`.toLowerCase();
      if (doesMetadataPartiallyMatch(reqLower, docMetaLower)) {
        return {
          requirementId: req.id,
          requirementTitle: reqTitle,
          requirementCategory: req.category,
          mandatory: req.mandatory,
          status: 'NEEDS_VERIFICATION',
          matchedVaultDocId: doc.id,
          matchedVaultDocName: doc.fileName,
          explanation: `Candidate file "${doc.fileName}" is present in the vault, but specific clause/fact compliance requires human verification.`,
          actionNeeded: `Verify that "${doc.fileName}" satisfies all specifics of: ${reqTitle}`,
        };
      }
    }

    if (reqLower.includes('gpa') || reqLower.includes('grade')) {
      if (profile.gpa) {
        const numMatch = reqLower.match(/(\d\.\d+)/);
        if (numMatch) {
          const reqGpa = parseFloat(numMatch[1]);
          const userGpa = parseFloat(profile.gpa);
          if (!isNaN(reqGpa) && !isNaN(userGpa)) {
            if (userGpa >= reqGpa) {
              return {
                requirementId: req.id,
                requirementTitle: reqTitle,
                requirementCategory: req.category,
                mandatory: req.mandatory,
                status: 'FOUND',
                matchedFactValue: `GPA: ${profile.gpa}`,
                explanation: `Applicant GPA (${profile.gpa}) meets or exceeds the stated threshold (${reqGpa}).`,
              };
            }
            return {
              requirementId: req.id,
              requirementTitle: reqTitle,
              requirementCategory: req.category,
              mandatory: req.mandatory,
              status: 'CONFLICT_DETECTED',
              matchedFactValue: `GPA: ${profile.gpa}`,
              explanation: `Applicant GPA (${profile.gpa}) is below the required threshold (${reqGpa}).`,
              actionNeeded: 'Provide supplemental academic explanation or verify eligibility waiver.',
            };
          }
        }
      }
    }

    if (
      (reqLower.includes('tax') || reqLower.includes('ein') || reqLower.includes('registration')) &&
      profile.taxIdOrRegistrationNumber
    ) {
      return {
        requirementId: req.id,
        requirementTitle: reqTitle,
        requirementCategory: req.category,
        mandatory: req.mandatory,
        status: 'FOUND',
        matchedFactValue: `Registration/Tax ID: ${profile.taxIdOrRegistrationNumber}`,
        explanation: 'Organization registration / Tax ID is recorded in profile.',
      };
    }

    return {
      requirementId: req.id,
      requirementTitle: reqTitle,
      requirementCategory: req.category,
      mandatory: req.mandatory,
      status: 'MISSING_EVIDENCE',
      explanation: `No matching fact or supporting document was found in the Evidence Vault for "${reqTitle}".`,
      actionNeeded: `Upload verifiable evidence for: ${reqTitle}`,
    };
  });

  const foundCount = matches.filter(m => m.status === 'FOUND').length;
  const partialCount = matches.filter(m => m.status === 'NEEDS_VERIFICATION').length;
  const missingCount = matches.filter(m => m.status === 'MISSING_EVIDENCE').length;
  const conflictCount = matches.filter(m => m.status === 'CONFLICT_DETECTED').length;

  const totalActionable = actionableRequirements.length;
  let evidenceFitScore: number | null = null;
  let readinessScore = 0;

  if (hasVaultOrProfile && totalActionable > 0) {
    evidenceFitScore = Math.max(
      0,
      Math.min(100, Math.round(((foundCount + partialCount * 0.5) / totalActionable) * 100))
    );
    readinessScore = evidenceFitScore;
  }

  const nextBestActions: string[] = [];

  matches
    .filter(m => m.status === 'CONFLICT_DETECTED')
    .forEach(m => {
      if (m.actionNeeded) nextBestActions.push(`Resolve Conflict: ${m.actionNeeded}`);
    });

  matches
    .filter(m => m.status === 'MISSING_EVIDENCE' && m.mandatory)
    .forEach(m => {
      if (m.actionNeeded) nextBestActions.push(`Missing Mandatory Evidence: ${m.actionNeeded}`);
    });

  matches
    .filter(m => m.status === 'NEEDS_VERIFICATION')
    .forEach(m => {
      if (m.actionNeeded) nextBestActions.push(`Verify Document Content: ${m.actionNeeded}`);
    });

  const criticalDates = importantDates.filter(
    (d: any) =>
      d.eventType === 'Proposal submission deadline' ||
      d.eventType === 'Application deadline' ||
      d.urgency === 'critical' ||
      d.isPrimaryDeadline
  );
  if (criticalDates.length > 0) {
    const cd = criticalDates[0] as any;
    nextBestActions.push(`Target Primary Deadline: ${cd.label} (${cd.date || cd.rawText})`);
  }

  return {
    readinessScore,
    extractionCompletenessScore: 100,
    analysisCompletenessScore: 100,
    evidenceFitScore,
    totalRequirements: totalActionable,
    foundCount,
    partialCount,
    missingCount,
    conflictCount,
    matches,
    nextBestActions: nextBestActions.slice(0, 8),
  };
}

function doesFactSatisfyRequirement(reqLower: string, factLower: string): boolean {
  const keywords = [
    'transcript',
    'marksheet',
    'degree',
    'gpa',
    'cgpa',
    'passport',
    'citizenship',
    'resume',
    'cv',
    'iso 9001',
    'iso 27001',
    'soc 2',
    'wcag',
    'insurance',
    'financial statement',
    'audited',
    'incorporation',
    'tax',
    'gst',
    'pan',
    'turnover',
    'experience',
    'income',
    'enrollment',
    'reference',
    'recommendation',
    'english',
    'ielts',
    'toefl',
  ];
  for (const kw of keywords) {
    if (reqLower.includes(kw) && factLower.includes(kw)) {
      return true;
    }
  }
  return false;
}

function doesMetadataPartiallyMatch(reqLower: string, docMetaLower: string): boolean {
  if (
    (reqLower.includes('resume') || reqLower.includes('cv') || reqLower.includes('personnel')) &&
    (docMetaLower.includes('resume') || docMetaLower.includes('cv'))
  ) {
    return true;
  }
  if (
    (reqLower.includes('transcript') || reqLower.includes('academic') || reqLower.includes('degree') || reqLower.includes('marksheet')) &&
    (docMetaLower.includes('transcript') || docMetaLower.includes('degree') || docMetaLower.includes('diploma') || docMetaLower.includes('marksheet'))
  ) {
    return true;
  }
  if (
    (reqLower.includes('financial') || reqLower.includes('audit') || reqLower.includes('balance') || reqLower.includes('income')) &&
    (docMetaLower.includes('financial') || docMetaLower.includes('audit') || docMetaLower.includes('tax') || docMetaLower.includes('income'))
  ) {
    return true;
  }
  if (
    (reqLower.includes('security') || reqLower.includes('iso') || reqLower.includes('soc')) &&
    (docMetaLower.includes('security') || docMetaLower.includes('iso') || docMetaLower.includes('compliance'))
  ) {
    return true;
  }
  return false;
}

export function compareMultipleDocuments(analyses: FullDocumentAnalysis[]): {
  deadlinesComparison: Array<{ docTitle: string; deadline: string; daysRemaining?: number }>;
  differingClauses: Array<{ clause: string; values: Array<{ docTitle: string; value: string }> }>;
  combinedChecklist: Array<{ title: string; sourceDocs: string[] }>;
} {
  const deadlinesComparison = analyses.map(a => {
    const primary = a.primaryDeadline;
    const primaryDateText = primary ? primary.date || primary.rawText : '';
    const deadline = primary
      ? `${primaryDateText} (${primary.label})`
      : a.importantDates[0]?.date || a.importantDates[0]?.rawText || 'Not specified';
    let daysRemaining: number | undefined;
    if (primaryDateText) {
      const parsed = Date.parse(primaryDateText);
      if (!isNaN(parsed)) {
        daysRemaining = Math.ceil((parsed - Date.now()) / (1000 * 60 * 60 * 24));
      }
    }
    return {
      docTitle: a.title,
      deadline,
      daysRemaining,
    };
  });

  const clauseNames = [
    'Document Type & Scope',
    'Financial / Total Value',
    'Mandatory Compliance Clauses',
    'Risk & Penalty Exposure',
    'Primary Authority',
  ];

  const differingClauses = clauseNames.map(clause => {
    const values = analyses.map(a => {
      let val = 'N/A';
      const pageCount = a.extractionVerification?.pageCount ?? 1;
      if (clause === 'Document Type & Scope') {
        val = `${a.category.toUpperCase()} • ${pageCount} pages`;
      } else if (clause === 'Financial / Total Value') {
        val = a.financialInformation[0]
          ? `${a.financialInformation[0].amountText || `${a.financialInformation[0].currency || ''} ${a.financialInformation[0].amount || ''}`}`
          : 'None specified';
      } else if (clause === 'Mandatory Compliance Clauses') {
        const mandatoryCount = a.requirements.filter(r => r.mandatory).length;
        val = `${mandatoryCount} mandatory requirements identified`;
      } else if (clause === 'Risk & Penalty Exposure') {
        val = a.risksAndWarnings?.[0]?.title || 'No critical warnings flagged';
      } else if (clause === 'Primary Authority') {
        val = a.keyInfo?.issuingOrganisation || 'Not clearly identified';
      }
      return {
        docTitle: a.title,
        value: val,
      };
    });
    return { clause, values };
  });

  const checklistMap = new Map<string, Set<string>>();
  for (const a of analyses) {
    for (const req of a.requirements) {
      const key = (req.title || req.name || 'Requirement').trim();
      if (!checklistMap.has(key)) {
        checklistMap.set(key, new Set());
      }
      checklistMap.get(key)!.add(a.title);
    }
  }

  const combinedChecklist = Array.from(checklistMap.entries()).map(([title, docSet]) => ({
    title,
    sourceDocs: Array.from(docSet),
  }));

  return {
    deadlinesComparison,
    differingClauses,
    combinedChecklist,
  };
}
