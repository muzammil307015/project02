import React from "react";
import {
  ShieldAlert,
  ShieldCheck,
  FileSearch,
  Lock,
  AlertTriangle,
  CheckCircle2,
  Info,
  Fingerprint,
  Globe,
  Cpu,
  CreditCard,
} from "lucide-react";
import { FraudAnalysisReport, FraudSignalFinding, SourceLocation } from "../../types";

interface FraudSignalsViewProps {
  report: FraudAnalysisReport;
  onOpenSourceModal?: (source: SourceLocation) => void;
}

export const FraudSignalsView: React.FC<FraudSignalsViewProps> = ({
  report,
  onOpenSourceModal,
}) => {
  const getWarningBadgeClasses = (label: FraudAnalysisReport["overallLabel"]) => {
    switch (label) {
      case "No warning detected":
        return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
      case "Informational":
        return "bg-sky-500/15 text-sky-300 border-sky-500/40";
      case "Low concern":
        return "bg-amber-500/15 text-amber-200 border-amber-500/30";
      case "Needs verification":
        return "bg-amber-500/20 text-amber-300 border-amber-500/40";
      case "Potentially suspicious":
        return "bg-orange-500/20 text-orange-300 border-orange-500/40";
      case "Strong warning signal":
        return "bg-rose-500/20 text-rose-300 border-rose-500/40";
      default:
        return "bg-slate-800 text-slate-300 border-slate-700";
    }
  };

  const allFindings: FraudSignalFinding[] = [
    ...report.fileConsistencyChecks,
    ...report.metadataFindings.inconsistencies,
    ...report.contentRiskSignals,
    ...report.suspiciousPaymentInstructions,
    ...report.linkAndContactWarnings,
  ];

  const nonBenignFindings = allFindings.filter(f => f.label !== "No warning detected");

  return (
    <div className="space-y-6">
      {/* Top Executive Summary Card */}
      <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-[#E5C158]/15 text-[#E5C158] border border-[#E5C158]/35">
                <Fingerprint className="w-3.5 h-3.5" />
                File Authenticity & Fraud Signals
              </span>
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${getWarningBadgeClasses(
                  report.overallLabel
                )}`}
              >
                {report.riskScore >= 35 ? (
                  <ShieldAlert className="w-3.5 h-3.5" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                {report.overallLabel}
              </span>
            </div>
            <h3 className="text-xl font-bold text-white">{report.summaryStatement}</h3>
            <p className="text-xs text-slate-400 font-mono">{report.riskFormulaExplanation}</p>
          </div>

          <div className="flex items-center gap-4 bg-[#08090D] border border-[#252A38] rounded-xl p-4 shrink-0">
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                Deterministic Risk Score
              </div>
              <div className="text-3xl font-black text-white">
                {report.riskScore}
                <span className="text-sm text-slate-500 font-normal"> / 100</span>
              </div>
              <div className="text-[11px] text-slate-400">
                {nonBenignFindings.length} warning signal(s)
              </div>
            </div>
            <div
              className={`w-14 h-14 rounded-xl flex items-center justify-center border ${getWarningBadgeClasses(
                report.overallLabel
              )}`}
            >
              {report.riskScore >= 35 ? (
                <ShieldAlert className="w-7 h-7" />
              ) : (
                <ShieldCheck className="w-7 h-7" />
              )}
            </div>
          </div>
        </div>

        {/* Scope & Honest Proof Boundary Notice */}
        <div className="mt-5 p-4 rounded-xl bg-[#08090D] border border-[#252A38] space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-bold text-[#E5C158]">
            <Info className="w-4 h-4 shrink-0" />
            <span>What This Check Can & Cannot Prove (Methodology & Limitations)</span>
          </div>
          <ul className="text-xs text-slate-300 space-y-1 list-disc list-inside">
            {report.methodologyAndLimitations.map((lim, i) => (
              <li key={i}>{lim}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Binary File Information & Embedded Metadata */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold uppercase tracking-wider text-[#E5C158] flex items-center gap-2">
              <Cpu className="w-4 h-4" />
              File Signature & Binary Inspection
            </h4>
            <span className="text-xs text-slate-400 font-mono">
              {(report.fileInformation.fileSizeBytes / 1024).toFixed(1)} KB
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-[#08090D] border border-[#252A38]">
              <div className="text-slate-400 mb-1">Declared Extension</div>
              <div className="font-semibold text-white">
                .{report.fileInformation.declaredExtension} ({report.fileInformation.fileName})
              </div>
            </div>

            <div className="p-3 rounded-xl bg-[#08090D] border border-[#252A38]">
              <div className="text-slate-400 mb-1">Detected Magic Signature</div>
              <div className="font-semibold text-white flex items-center gap-1.5">
                {report.fileInformation.extensionMatchesSignature ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                )}
                <span>{report.fileInformation.detectedMagicSignature}</span>
              </div>
            </div>

            {report.metadataFindings.fields.map((fld, idx) => (
              <div key={idx} className="p-3 rounded-xl bg-[#08090D] border border-[#252A38]">
                <div className="text-slate-400 mb-1">{fld.key}</div>
                <div className="font-semibold text-slate-200 break-words">{fld.value}</div>
                {fld.note && <div className="text-[10px] text-slate-500 mt-1">{fld.note}</div>}
              </div>
            ))}
          </div>

          <div className="p-3 rounded-xl bg-[#08090D] border border-[#252A38] text-xs flex items-start gap-2">
            <Lock className="w-4 h-4 text-[#E5C158] shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-white">Digital Signature Inspection: </span>
              <span className="text-slate-300">{report.metadataFindings.signatureNote}</span>
            </div>
          </div>
        </div>

        {/* Verification Recommendations */}
        <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl p-6 space-y-4">
          <h4 className="text-sm font-bold uppercase tracking-wider text-[#E5C158] flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Recommended Verification Steps
          </h4>
          <ul className="space-y-2.5">
            {report.verificationRecommendations.map((step, i) => (
              <li
                key={i}
                className="flex items-start gap-2.5 text-xs text-slate-200 bg-[#08090D] border border-[#252A38] p-3 rounded-xl"
              >
                <span className="w-5 h-5 rounded-full bg-[#E5C158]/20 text-[#E5C158] font-bold flex items-center justify-center shrink-0 text-[11px]">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ul>

          {/* Summary counts by category */}
          <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
            <div className="p-3 rounded-xl bg-[#08090D] border border-[#252A38] flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <CreditCard className="w-3.5 h-3.5 text-amber-400" />
                Payment Signals
              </span>
              <span className="font-mono font-bold text-white">
                {report.suspiciousPaymentInstructions.length}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#08090D] border border-[#252A38] flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                Link / Contact Signals
              </span>
              <span className="font-mono font-bold text-white">
                {report.linkAndContactWarnings.length}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Detailed Findings List */}
      <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl p-6 space-y-4">
        <h4 className="text-sm font-bold uppercase tracking-wider text-[#E5C158] flex items-center gap-2">
          <FileSearch className="w-4 h-4" />
          Detailed Technical, Content & Link Findings ({allFindings.length})
        </h4>

        <div className="space-y-3">
          {allFindings.map(finding => (
            <div
              key={finding.id}
              className="p-4 rounded-xl bg-[#08090D] border border-[#252A38] space-y-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${getWarningBadgeClasses(
                      finding.label
                    )}`}
                  >
                    {finding.label}
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono bg-[#141822] text-slate-300">
                    {finding.category.replace(/_/g, " ")}
                  </span>
                  <h5 className="text-sm font-bold text-white">{finding.title}</h5>
                </div>

                {finding.sourceLocation?.page && onOpenSourceModal && (
                  <button
                    onClick={() => onOpenSourceModal(finding.sourceLocation!)}
                    className="text-xs font-mono px-2.5 py-1 rounded-lg bg-[#E5C158]/10 hover:bg-[#E5C158]/20 text-[#E5C158] border border-[#E5C158]/30 transition-colors cursor-pointer"
                  >
                    Page {finding.sourceLocation.page} →
                  </button>
                )}
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">{finding.explanation}</p>

              {finding.whySuspicious && (
                <p className="text-xs text-amber-200/90">
                  <strong>Why Flagged:</strong> {finding.whySuspicious}
                </p>
              )}

              {finding.supportingEvidence && (
                <div className="p-2.5 rounded-lg bg-[#0E1017] border border-[#1E2838] text-xs font-mono text-slate-300">
                  <span className="text-slate-500 select-none">Supporting Evidence: </span>
                  &ldquo;{finding.supportingEvidence}&rdquo;
                </div>
              )}

              {finding.recommendation && (
                <div className="text-xs text-emerald-300 pt-1">
                  <strong>Recommended Action:</strong> {finding.recommendation}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
