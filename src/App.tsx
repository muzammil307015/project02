import React, { useState, useEffect } from "react";
import { Navbar } from "./components/layout/Navbar";
import { Footer } from "./components/layout/Footer";
import { LandingPage } from "./components/landing/LandingPage";
import { DashboardHome } from "./components/dashboard/DashboardHome";
import { UploadZone } from "./components/analysis/UploadZone";
import { ScanningOverlay } from "./components/analysis/ScanningOverlay";
import { RedactionReviewModal } from "./components/analysis/RedactionReviewModal";
import { AnalysisStudio } from "./components/analysis/AnalysisStudio";
import { EvidenceVaultView } from "./components/vault/EvidenceVaultView";
import { MyDocumentsView } from "./components/documents/MyDocumentsView";
import { DeadlinesView } from "./components/deadlines/DeadlinesView";
import { ChecklistsView } from "./components/checklists/ChecklistsView";
import { PrivacyCenterView } from "./components/settings/PrivacyCenterView";
import { AiSettingsView } from "./components/settings/AiSettingsView";
import { DocumentMemoryView } from "./components/memory/DocumentMemoryView";
import { MultiDocComparison } from "./components/comparison/MultiDocComparison";
import { AccountModal } from "./components/modals/AccountModal";
import { VaultModal } from "./components/modals/VaultModal";

import {
  ParsedDocumentData,
  FullDocumentAnalysis,
  UserProfile,
  EvidenceDocument,
  DocumentMemoryItem,
  VisibilityState,
  DocumentPage,
} from "./types";
import { DemoDocumentSpec } from "./services/demoData";
import { parseUploadedDocument } from "./services/parsers/unifiedParser";
import { scanSensitiveEntities, buildRedactedText } from "./services/privacyService";
import { runDeterministicAnalysis } from "./services/deterministicEngine";
import { compareRequirementsWithEvidence } from "./services/comparisonEngine";
import { analyzeDocumentFraudSignals } from "./services/fraudScanner";
import { storage } from "./services/storageAdapter";
import { getActiveSessionKey } from "./services/byokVault";

export function App() {
  const [currentView, setCurrentView] = useState<string>("landing");

  // Persistent State loaded from storageAdapter
  const [analyses, setAnalyses] = useState<FullDocumentAnalysis[]>([]);
  const [parsedDocs, setParsedDocs] = useState<Record<string, ParsedDocumentData>>({});
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [evidenceDocs, setEvidenceDocs] = useState<EvidenceDocument[]>([]);
  const [memoryItems, setMemoryItems] = useState<DocumentMemoryItem[]>([]);

  // Active Studio Document & Analysis
  const [activeDoc, setActiveDoc] = useState<ParsedDocumentData | null>(null);
  const [activeAnalysis, setActiveAnalysis] = useState<FullDocumentAnalysis | null>(null);

  // Upload & Processing State
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingStage, setProcessingStage] = useState<string>("");
  const [processingProgress, setProcessingProgress] = useState<number>(0);
  const [processingFileName, setProcessingFileName] = useState<string>("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Modals
  const [isRedactionModalOpen, setIsRedactionModalOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [isVaultModalOpen, setIsVaultModalOpen] = useState<boolean>(false);

  // Initial load from storage
  useEffect(() => {
    let active = true;
    Promise.all([
      storage.getAnalyses(),
      storage.getParsedDocuments(),
      storage.getProfile(),
      storage.getEvidenceDocuments(),
      storage.getMemoryItems(),
    ]).then(([savedAnalyses, savedParsedList, savedProfile, savedEvidence, savedMemory]) => {
      if (!active) return;
      setAnalyses(savedAnalyses);
      const docMap: Record<string, ParsedDocumentData> = {};
      for (const d of savedParsedList) {
        docMap[d.id] = d;
      }
      setParsedDocs(docMap);
      setProfile(savedProfile);
      setEvidenceDocs(savedEvidence);
      setMemoryItems(savedMemory);
    });
    return () => {
      active = false;
    };
  }, []);

  const persistAnalysisAndDoc = (
    doc: ParsedDocumentData,
    analysis: FullDocumentAnalysis
  ) => {
    void storage.saveParsedDocument(doc);
    void storage.saveAnalysis(analysis);
    setParsedDocs((prev) => ({ ...prev, [doc.id]: doc }));
    setAnalyses((prev) => [
      analysis,
      ...prev.filter((a) => a.docId !== analysis.docId),
    ]);
  };

  // Process Real Uploaded File
  const handleFileSelected = async (file: File) => {
    setUploadError(null);
    setIsProcessing(true);
    setProcessingFileName(file.name);
    setProcessingStage("Starting unified multi-format parser...");
    setProcessingProgress(10);

    try {
      const parsed = await parseUploadedDocument(file, (stage, progress) => {
        setProcessingStage(stage);
        setProcessingProgress(progress);
      });

      setProcessingStage("Running deterministic requirement, date, financial & fraud signal engines...");
      setProcessingProgress(92);

      const initialAnalysis = runDeterministicAnalysis(parsed);
      const comparedAnalysis = compareRequirementsWithEvidence(
        initialAnalysis,
        profile,
        evidenceDocs
      );

      persistAnalysisAndDoc(parsed, comparedAnalysis);
      setActiveDoc(parsed);
      setActiveAnalysis(comparedAnalysis);
      setIsProcessing(false);
      setCurrentView("studio");
    } catch (err: any) {
      setIsProcessing(false);
      setUploadError(
        err?.message || "Failed to parse and analyze document. Please verify the file format."
      );
    }
  };

  // Process Demo Document Selection (Isolated strictly with isDemo: true)
  const handleSelectDemoDoc = (demo: DemoDocumentSpec) => {
    setUploadError(null);
    setIsProcessing(true);
    setProcessingFileName(demo.fileName);
    setProcessingStage("Loading isolated demo document fixture...");
    setProcessingProgress(40);

    setTimeout(() => {
      try {
        const rawSegments = demo.rawText.includes("--- [Page ")
          ? demo.rawText
              .split(/---\s*\[Page\s+\d+\]\s*---/i)
              .map((s) => s.trim())
              .filter(Boolean)
          : [demo.rawText];

        const pages: DocumentPage[] = rawSegments.map((text: string, idx: number) => ({
          pageNumber: idx + 1,
          text,
          confidence: 0.99,
          isOcr: false,
        }));

        const fullRawText = pages.map((p) => p.text).join("\n\n");
        const { detections, redactedText } = scanSensitiveEntities(fullRawText);
        const ext = demo.fileName.split(".").pop()?.toUpperCase() || "PDF";

        const docId = `demo_${demo.id}_${Date.now()}`;
        const parsedDemo: ParsedDocumentData = {
          id: docId,
          fileName: demo.fileName,
          fileType: ext,
          fileSizeBytes: fullRawText.length,
          detectedFormat: `${ext} (Demo Fixture)`,
          pages,
          fullText: fullRawText,
          redactedText,
          sensitiveDetections: detections,
          wordCount: fullRawText.split(/\s+/).filter(Boolean).length,
          tableCount: 0,
          sheetCount: 0,
          extractionQualityScore: 99,
          parserEngineUsed: "Demo Fixture Loader",
          ocrApplied: false,
          extractionWarnings: [],
          detectedCategory: demo.category,
          extractedTitle: demo.title,
          uploadedAt: new Date().toISOString(),
          isDemo: true,
        };

        parsedDemo.fraudAnalysis = analyzeDocumentFraudSignals(parsedDemo);

        const initialAnalysis = runDeterministicAnalysis(parsedDemo);
        const comparedAnalysis = compareRequirementsWithEvidence(
          initialAnalysis,
          profile,
          evidenceDocs
        );

        persistAnalysisAndDoc(parsedDemo, comparedAnalysis);
        setActiveDoc(parsedDemo);
        setActiveAnalysis(comparedAnalysis);
        setIsProcessing(false);
        setCurrentView("studio");
      } catch (e: any) {
        setIsProcessing(false);
        setUploadError(e?.message || "Failed to load demo document.");
      }
    }, 350);
  };

  // Open an existing saved analysis from Dashboard / My Documents / Deadlines
  const handleOpenSavedAnalysis = (analysis: FullDocumentAnalysis) => {
    const existingDoc = parsedDocs[analysis.docId];
    if (existingDoc) {
      setActiveDoc(existingDoc);
      setActiveAnalysis(analysis);
      setCurrentView("studio");
      return;
    }

    // Restored historical analysis without raw binary/pages in memory:
    // Never fabricate a 98%-confidence fake PDF; mark isRestoredWithoutSource: true
    const restoredPlaceholderDoc: ParsedDocumentData = {
      id: analysis.docId,
      fileName: analysis.originalFilename || analysis.title,
      fileType: "RESTORED_RECORD",
      fileSizeBytes: 0,
      detectedFormat: "Restored Historical Snapshot",
      pages: [
        {
          pageNumber: 1,
          text: `[Restored Historical Analysis Snapshot for "${analysis.title}"]\n\nSummary:\n${analysis.executiveSummary}`,
          confidence: 0,
          isOcr: false,
        },
      ],
      fullText: analysis.executiveSummary,
      redactedText: analysis.executiveSummary,
      sensitiveDetections: [],
      wordCount: analysis.executiveSummary.split(/\s+/).filter(Boolean).length,
      tableCount: 0,
      sheetCount: 0,
      extractionQualityScore: analysis.extractionAudit?.extractionQualityScore || 0,
      parserEngineUsed: analysis.extractionAudit?.parserName || "Historical Snapshot",
      ocrApplied: analysis.extractionAudit?.isScanned || false,
      extractionWarnings: [
        "Original uploaded binary is not present in browser session cache. Re-upload the source document for full page-by-page text inspection.",
      ],
      detectedCategory: analysis.category,
      extractedTitle: analysis.title,
      uploadedAt: analysis.analyzedAt,
      isRestoredWithoutSource: true,
      fraudAnalysis: analysis.fraudAnalysis,
    };

    setActiveDoc(restoredPlaceholderDoc);
    setActiveAnalysis(analysis);
    setCurrentView("studio");
  };

  const handleUpdateAnalysis = (updated: FullDocumentAnalysis) => {
    setActiveAnalysis(updated);
    storage.saveAnalysis(updated);
    setAnalyses((prev) =>
      prev.map((a) => (a.docId === updated.docId ? updated : a))
    );
  };

  const handleDeleteAnalysis = (analysisOrDocId: string) => {
    storage.deleteAnalysis(analysisOrDocId);
    setAnalyses((prev) =>
      prev.filter((a) => a.id !== analysisOrDocId && a.docId !== analysisOrDocId)
    );
    if (
      activeAnalysis?.id === analysisOrDocId ||
      activeAnalysis?.docId === analysisOrDocId
    ) {
      setActiveAnalysis(null);
      setActiveDoc(null);
      setCurrentView("my_documents");
    }
  };

  // Redaction visibility updates
  const handleUpdateDetectionVisibility = (
    detectionId: string,
    newVisibility: VisibilityState
  ) => {
    if (!activeDoc) return;
    const updatedDetections = activeDoc.sensitiveDetections.map((d) =>
      d.id === detectionId ? { ...d, visibility: newVisibility } : d
    );
    const updatedRedactedText = buildRedactedText(
      activeDoc.fullText,
      updatedDetections
    );
    const updatedDoc: ParsedDocumentData = {
      ...activeDoc,
      sensitiveDetections: updatedDetections,
      redactedText: updatedRedactedText,
    };
    setActiveDoc(updatedDoc);
    storage.saveParsedDocument(updatedDoc);
    setParsedDocs((prev) => ({ ...prev, [updatedDoc.id]: updatedDoc }));
  };

  // Profile & Evidence Vault handlers
  const handleSaveProfile = (newProfile: UserProfile) => {
    storage.saveProfile(newProfile);
    setProfile(newProfile);
    if (activeAnalysis) {
      const recompared = compareRequirementsWithEvidence(
        activeAnalysis,
        newProfile,
        evidenceDocs
      );
      handleUpdateAnalysis(recompared);
    }
  };

  const handleAddEvidenceDoc = (doc: EvidenceDocument) => {
    storage.saveEvidenceDocument(doc);
    const nextDocs = [doc, ...evidenceDocs.filter((d) => d.id !== doc.id)];
    setEvidenceDocs(nextDocs);
    if (activeAnalysis) {
      const recompared = compareRequirementsWithEvidence(
        activeAnalysis,
        profile,
        nextDocs
      );
      handleUpdateAnalysis(recompared);
    }
  };

  const handleDeleteEvidenceDoc = (id: string) => {
    storage.deleteEvidenceDocument(id);
    const nextDocs = evidenceDocs.filter((d) => d.id !== id);
    setEvidenceDocs(nextDocs);
    if (activeAnalysis) {
      const recompared = compareRequirementsWithEvidence(
        activeAnalysis,
        profile,
        nextDocs
      );
      handleUpdateAnalysis(recompared);
    }
  };

  // Memory handlers
  const handleToggleMemoryReuse = (id: string) => {
    const target = memoryItems.find((m) => m.id === id);
    if (!target) return;
    const updated: DocumentMemoryItem = {
      ...target,
      userApprovedForReuse: !target.userApprovedForReuse,
    };
    storage.saveMemoryItem(updated);
    setMemoryItems((prev) => prev.map((m) => (m.id === id ? updated : m)));
  };

  const handleDeleteMemoryItem = (id: string) => {
    storage.deleteMemoryItem(id);
    setMemoryItems((prev) => prev.filter((m) => m.id !== id));
  };

  const handleClearAllMemory = () => {
    storage.clearAllMemory();
    setMemoryItems([]);
  };

  const isAiConnected = Boolean(getActiveSessionKey()) || true;

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0B0E] text-slate-100 selection:bg-[#D4AF37]/30 selection:text-[#F3E5AB]">
      <Navbar
        currentView={currentView}
        onNavigate={(view) => setCurrentView(view)}
        onOpenVaultModal={() => setIsVaultModalOpen(true)}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        isAiConnected={isAiConnected}
      />

      <main className="flex-1">
        {currentView === "landing" && (
          <LandingPage
            onStartAnalysis={() => setCurrentView("new_analysis")}
            onExplorePlatform={() => setCurrentView("overview")}
            onOpenDashboard={() => setCurrentView("overview")}
            onSelectDemoDoc={handleSelectDemoDoc}
            onNavigate={(view) => setCurrentView(view)}
          />
        )}

        {currentView === "overview" && (
          <DashboardHome
            onStartAnalysis={() => setCurrentView("new_analysis")}
            onOpenAnalysis={handleOpenSavedAnalysis}
            onSelectDemoDoc={handleSelectDemoDoc}
            onNavigate={(view) => setCurrentView(view)}
            recentAnalyses={analyses}
            profile={profile}
            vaultDocCount={evidenceDocs.length}
            isAiConnected={isAiConnected}
          />
        )}

        {(currentView === "new_analysis" || currentView === "analyze") && (
          <div className="max-w-5xl mx-auto px-4 py-10">
            <UploadZone
              onFileSelected={handleFileSelected}
              onDemoSelected={handleSelectDemoDoc}
              isProcessing={isProcessing}
              processingProgress={processingProgress}
              processingStage={processingStage}
              externalError={uploadError}
              onClearExternalError={() => setUploadError(null)}
            />
          </div>
        )}

        {currentView === "studio" && activeDoc && activeAnalysis && (
          <AnalysisStudio
            document={activeDoc}
            analysis={activeAnalysis}
            profile={profile}
            evidenceDocs={evidenceDocs}
            onUpdateAnalysis={handleUpdateAnalysis}
            onOpenRedactionModal={() => setIsRedactionModalOpen(true)}
            onBack={() => setCurrentView("overview")}
          />
        )}

        {currentView === "my_documents" && (
          <MyDocumentsView
            documents={analyses}
            onOpenDocument={handleOpenSavedAnalysis}
            onDeleteDocument={handleDeleteAnalysis}
            onNavigateToUpload={() => setCurrentView("new_analysis")}
          />
        )}

        {currentView === "compare" && (
          <MultiDocComparison
            availableAnalyses={analyses}
            onOpenAnalysis={handleOpenSavedAnalysis}
          />
        )}

        {currentView === "profile" && (
          <EvidenceVaultView
            profile={profile}
            onSaveProfile={handleSaveProfile}
            evidenceDocs={evidenceDocs}
            onAddEvidenceDoc={handleAddEvidenceDoc}
            onDeleteEvidenceDoc={handleDeleteEvidenceDoc}
          />
        )}

        {currentView === "deadlines" && (
          <DeadlinesView
            analyses={analyses}
            onOpenAnalysis={handleOpenSavedAnalysis}
          />
        )}

        {currentView === "checklists" && (
          <ChecklistsView
            analyses={analyses}
            profile={profile}
            onUpdateAnalysis={handleUpdateAnalysis}
          />
        )}

        {currentView === "privacy_center" && <PrivacyCenterView />}

        {currentView === "settings" && <AiSettingsView />}

        {currentView === "memory" && (
          <DocumentMemoryView
            memoryItems={memoryItems}
            onToggleReuse={handleToggleMemoryReuse}
            onDeleteItem={handleDeleteMemoryItem}
            onClearAll={handleClearAllMemory}
          />
        )}
      </main>

      <Footer onNavigate={(view) => setCurrentView(view)} />

      {/* Scanning Overlay */}
      {isProcessing && (
        <ScanningOverlay
          fileName={processingFileName}
          stage={processingStage}
          progress={processingProgress}
        />
      )}

      {/* Redaction Review Modal */}
      {activeDoc && (
        <RedactionReviewModal
          isOpen={isRedactionModalOpen}
          onClose={() => setIsRedactionModalOpen(false)}
          detections={activeDoc.sensitiveDetections}
          onUpdateDetection={handleUpdateDetectionVisibility}
          onConfirmAndProceed={() => setIsRedactionModalOpen(false)}
        />
      )}

      {/* Account & BYOK Vault Modals */}
      <AccountModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />
      <VaultModal
        isOpen={isVaultModalOpen}
        onClose={() => setIsVaultModalOpen(false)}
        onNavigateToSettings={() => {
          setIsVaultModalOpen(false);
          setCurrentView("settings");
        }}
      />
    </div>
  );
}

export default App;
