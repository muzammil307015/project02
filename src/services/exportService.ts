import { FullDocumentAnalysis } from '../types';

export function exportAnalysisAsJson(analysis: FullDocumentAnalysis): void {
  const fileNameBase = analysis.originalFilename || analysis.title || 'document';
  const jsonString = JSON.stringify(analysis, null, 2);
  downloadBlob(
    jsonString,
    `${sanitizeFilename(fileNameBase)}_doculens_report.json`,
    'application/json'
  );
}

export function exportAnalysisAsMarkdown(analysis: FullDocumentAnalysis): string {
  const fileNameBase = analysis.originalFilename || analysis.title || 'document';
  const md = generateMarkdownReport(analysis);
  downloadBlob(
    md,
    `${sanitizeFilename(fileNameBase)}_doculens_report.md`,
    'text/markdown'
  );
  return md;
}

export function downloadFile(
  content: string,
  filename: string,
  contentType: string = 'text/plain;charset=utf-8;'
): void {
  downloadBlob(content, filename, contentType);
}

export function exportChecklistAsCsv(analysisOrItems: FullDocumentAnalysis | any[]): void {
  if (Array.isArray(analysisOrItems)) {
    const headers = ['Task / Requirement', 'Category', 'Status', 'Mandatory'];
    const rows = analysisOrItems.map(item => [
      escapeCsv(item.title || item.name || item.task || ''),
      escapeCsv(item.category || 'General'),
      escapeCsv(item.completed ? 'Completed' : item.status || 'Pending'),
      item.mandatory ? 'YES' : 'NO',
    ]);
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadBlob(csvContent, 'checklist.csv', 'text/csv;charset=utf-8;');
  } else {
    const analysis = analysisOrItems as FullDocumentAnalysis;
    const fileNameBase = analysis.originalFilename || analysis.title || 'doc';
    const items =
      analysis.actionPlan && analysis.actionPlan.length > 0
        ? analysis.actionPlan.map(act => ({
            title: act.title,
            category: 'Action Step',
            mandatory: act.priority === 'high',
            status: act.status,
            classification: act.priority.toUpperCase(),
          }))
        : (analysis.requirements || []).map(r => ({
            title: r.name || r.title || '',
            category: r.category || 'Requirement',
            mandatory: r.mandatory,
            status: r.evidenceStatus || r.verificationStatus || 'Pending',
            classification: r.classification || (r.mandatory ? 'Mandatory' : 'Informational'),
          }));
    const headers = ['Task / Requirement', 'Category', 'Classification', 'Status', 'Mandatory'];
    const rows = items.map((item: any) => [
      escapeCsv(item.title || item.task || ''),
      escapeCsv(item.category || 'General'),
      escapeCsv(item.classification || (item.mandatory ? 'Mandatory' : 'Informational')),
      escapeCsv(item.completed ? 'Completed' : item.status || 'Pending'),
      item.mandatory ? 'YES' : 'NO',
    ]);
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadBlob(csvContent, `${sanitizeFilename(fileNameBase)}_checklist.csv`, 'text/csv;charset=utf-8;');
  }
}

export function exportRequirementsAsCsv(analysis: FullDocumentAnalysis): void {
  const fileNameBase = analysis.originalFilename || analysis.title || 'document';
  const headers = [
    'ID',
    'Title',
    'Category',
    'Classification',
    'Mandatory',
    'Status',
    'Page Number',
    'Description',
    'Source Quote',
  ];

  const rows = (analysis.requirements || []).map(req => [
    escapeCsv(req.id),
    escapeCsv(req.name || req.title || ''),
    escapeCsv(req.category || 'Requirement'),
    escapeCsv(req.classification || (req.mandatory ? 'Mandatory' : 'Informational')),
    req.mandatory ? 'YES' : 'NO',
    escapeCsv(req.evidenceStatus || req.verificationStatus || ''),
    String(req.sourceLocation?.page || req.pageNumber || 1),
    escapeCsv(req.description),
    escapeCsv(req.sourceLocation?.snippet || req.sourceQuote || ''),
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  downloadBlob(
    csvContent,
    `${sanitizeFilename(fileNameBase)}_requirements_checklist.csv`,
    'text/csv;charset=utf-8;'
  );
}

export function exportAnalysisAsPrintableHtml(analysis: FullDocumentAnalysis): void {
  const fileNameBase = analysis.originalFilename || analysis.title || 'document';
  const pageCount = analysis.extractionVerification?.pageCount ?? 1;
  const completeness =
    analysis.readinessScore?.extractionCompletenessScore ??
    analysis.extractionVerification?.sourceCoveragePercent ??
    100;
  const primaryDeadlineStr = analysis.primaryDeadline
    ? `${analysis.primaryDeadline.rawText || analysis.primaryDeadline.date} (${analysis.primaryDeadline.label})`
    : 'Not clearly stated in the document';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>DOCULENS Intelligence Report — ${escapeHtml(analysis.title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
      background: #ffffff;
      max-width: 920px;
      margin: 0 auto;
      padding: 40px 24px;
      line-height: 1.6;
    }
    h1 { font-size: 26px; margin-bottom: 4px; color: #1e1b4b; }
    h2 { font-size: 18px; margin-top: 32px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; color: #312e81; }
    .meta { font-size: 13px; color: #475569; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #e0e7ff; color: #3730a3; margin-right: 6px; }
    .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; background: #f8fafc; }
    .quote { font-size: 12px; color: #475569; font-style: italic; border-left: 3px solid #6366f1; padding-left: 10px; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
  </style>
</head>
<body>
  <h1>DOCULENS Intelligence Dossier: ${escapeHtml(analysis.title)}</h1>
  <div class="meta">
    <span class="badge">${escapeHtml(analysis.category.toUpperCase())}</span>
    <span class="badge">Primary Deadline: ${escapeHtml(primaryDeadlineStr)}</span>
    <span class="badge">Extraction Completeness: ${completeness}%</span>
    <div>File: ${escapeHtml(fileNameBase)} • Pages: ${pageCount} • Generated: ${new Date(analysis.analyzedAt).toLocaleString()}</div>
  </div>

  <h2>Executive Summary</h2>
  <p>${escapeHtml(analysis.executiveSummary)}</p>

  <h2>Important Dates & Deadlines (${analysis.importantDates.length})</h2>
  <table>
    <thead>
      <tr><th>Event / Milestone</th><th>Date</th><th>Event Type</th><th>Status</th><th>Page</th><th>Source Evidence</th></tr>
    </thead>
    <tbody>
      ${analysis.importantDates
        .map(
          d =>
            `<tr><td><strong>${escapeHtml(d.label)}</strong></td><td>${escapeHtml(d.rawText || d.date || '')}</td><td>${escapeHtml(String(d.eventType || d.type))}</td><td>${escapeHtml(d.status || '')}</td><td>Page ${d.sourceLocation?.page || 1}</td><td>${escapeHtml(d.sourceLocation?.snippet || '')}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>

  <h2>Financial Breakdown (${analysis.financialInformation.length})</h2>
  <table>
    <thead>
      <tr><th>Category</th><th>Amount</th><th>Programme / Scope</th><th>Page</th><th>Source Evidence</th></tr>
    </thead>
    <tbody>
      ${analysis.financialInformation
        .map(
          f =>
            `<tr><td>${escapeHtml(String(f.detailedCategory || f.label))}</td><td><strong>${escapeHtml(f.amountText)}</strong></td><td>${escapeHtml(f.associatedProgrammeOrEntity || '-')}</td><td>Page ${f.sourceLocation?.page || 1}</td><td>${escapeHtml(f.sourceLocation?.snippet || '')}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>

  <h2>Requirements & Obligations Checklist (${analysis.requirements.length})</h2>
  ${analysis.requirements
    .map(
      r => `<div class="card">
        <div><strong>[${escapeHtml((r.classification || (r.mandatory ? 'Mandatory' : 'Informational')).toUpperCase())}] ${escapeHtml(r.name || r.title || '')}</strong> (Page ${r.sourceLocation?.page || 1})</div>
        <div>${escapeHtml(r.description)}</div>
        <div class="quote">"${escapeHtml(r.sourceLocation?.snippet || r.sourceQuote || '')}"</div>
      </div>`
    )
    .join('')}

  ${
    analysis.fraudAnalysis
      ? `<h2>File Authenticity & Fraud Signals</h2>
  <div class="card">
    <div><strong>Warning Level:</strong> ${escapeHtml(analysis.fraudAnalysis.overallLabel)} (Risk Index: ${analysis.fraudAnalysis.riskScore}/100)</div>
    <div>${escapeHtml(analysis.fraudAnalysis.summaryStatement)}</div>
  </div>`
      : ''
  }

  <h2>Risks, Ambiguities & Red Flags (${(analysis.risksAndWarnings || []).length})</h2>
  ${(analysis.risksAndWarnings || [])
    .map(
      rk => `<div class="card">
        <div><strong>[${escapeHtml(rk.severity.toUpperCase())}] ${escapeHtml(rk.title)}</strong> (Page ${rk.sourceLocation?.page || 1})</div>
        <div>${escapeHtml(rk.description)}</div>
        <div><em>Recommendation: ${escapeHtml(rk.recommendedAction)}</em></div>
        <div class="quote">"${escapeHtml(rk.sourceLocation?.snippet || '')}"</div>
      </div>`
    )
    .join('')}

  <h2>Action Playbook</h2>
  <ol>
    ${(analysis.actionPlan || []).map(step => `<li><strong>${escapeHtml(step.title)}</strong>: ${escapeHtml(step.description)}</li>`).join('')}
  </ol>
</body>
</html>`;

  downloadBlob(
    html,
    `${sanitizeFilename(fileNameBase)}_printable_dossier.html`,
    'text/html;charset=utf-8'
  );
}

function generateMarkdownReport(a: FullDocumentAnalysis): string {
  const fileNameBase = a.originalFilename || a.title || 'document';
  const pageCount = a.extractionVerification?.pageCount ?? 1;
  const primaryDeadlineStr = a.primaryDeadline
    ? `${a.primaryDeadline.rawText || a.primaryDeadline.date} (${a.primaryDeadline.label})`
    : 'Not clearly stated in the document';

  const lines: string[] = [];
  lines.push(`# DOCULENS Intelligence Report: ${a.title}`);
  lines.push(
    `**File:** \`${fileNameBase}\` | **Category:** \`${a.category.toUpperCase()}\` | **Pages:** ${pageCount} | **Primary Deadline:** ${primaryDeadlineStr}\n`
  );

  lines.push(`## 1. Executive Summary`);
  lines.push(`${a.executiveSummary}\n`);

  lines.push(`## 2. Important Dates & Deadlines (${a.importantDates.length})`);
  a.importantDates.forEach(d => {
    lines.push(
      `- **${d.label}**: \`${d.rawText || d.date || ''}\` [${d.eventType || d.type} | ${d.status || ''}] (Page ${
        d.sourceLocation?.page || 1
      })\n  > *"${d.sourceLocation?.snippet || ''}"*`
    );
  });
  lines.push('');

  lines.push(`## 3. Financial Information (${a.financialInformation.length})`);
  a.financialInformation.forEach(f => {
    lines.push(
      `- **${f.label}**: **${f.amountText}**${
        f.associatedProgrammeOrEntity ? ` (${f.associatedProgrammeOrEntity})` : ''
      } (Page ${f.sourceLocation?.page || 1})\n  > *"${f.sourceLocation?.snippet || ''}"*`
    );
  });
  lines.push('');

  lines.push(`## 4. Requirements Checklist (${a.requirements.length})`);
  a.requirements.forEach(r => {
    const tag = r.classification || (r.mandatory ? 'Mandatory' : 'Informational');
    lines.push(
      `- [ ] **[${tag.toUpperCase()}] ${r.name || r.title || ''}** (${r.category || 'Requirement'}, Page ${
        r.sourceLocation?.page || 1
      })\n  ${r.description}\n  > *"${r.sourceLocation?.snippet || ''}"*`
    );
  });
  lines.push('');

  if (a.fraudAnalysis) {
    lines.push(`## 5. File Authenticity & Fraud Signals`);
    lines.push(
      `- **Warning Label:** ${a.fraudAnalysis.overallLabel} (Deterministic Risk Index: ${a.fraudAnalysis.riskScore}/100)`
    );
    lines.push(`- **Summary:** ${a.fraudAnalysis.summaryStatement}`);
    lines.push('');
  }

  lines.push(`## 6. Risks & Warnings (${(a.risksAndWarnings || []).length})`);
  (a.risksAndWarnings || []).forEach(rk => {
    lines.push(
      `- **[${rk.severity.toUpperCase()}] ${rk.title}** (Page ${rk.sourceLocation?.page || 1})\n  - Issue: ${
        rk.description
      }\n  - Action: ${rk.recommendedAction}\n  > *"${rk.sourceLocation?.snippet || ''}"*`
    );
  });
  lines.push('');

  lines.push(`## 7. Recommended Action Playbook`);
  (a.actionPlan || []).forEach((step, idx) => {
    lines.push(`${idx + 1}. **${step.title}** — ${step.description}`);
  });

  return lines.join('\n');
}

function downloadBlob(content: string, filename: string, contentType: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return (name || 'document').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function escapeCsv(val: string): string {
  const cleaned = (val || '').replace(/"/g, '""').replace(/\r?\n/g, ' ');
  return `"${cleaned}"`;
}

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
