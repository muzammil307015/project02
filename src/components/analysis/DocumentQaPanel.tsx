import React, { useState } from "react";
import {
  MessageSquare,
  Send,
  Sparkles,
  BookOpen,
  ShieldCheck,
  Loader2,
  CornerDownRight,
} from "lucide-react";
import { DocumentQAPair, FullDocumentAnalysis, ParsedDocumentData, SourceLocation } from "../../types";
import { askDocumentQuestion, getSelectedAiModel } from "../../services/aiProvider";
import { answerQuestionDeterministically } from "../../services/deterministicEngine";

interface DocumentQaPanelProps {
  doc: ParsedDocumentData;
  analysis: FullDocumentAnalysis;
  onOpenSourceModal: (source: SourceLocation) => void;
}

export const DocumentQaPanel: React.FC<DocumentQaPanelProps> = ({
  doc,
  analysis,
  onOpenSourceModal,
}) => {
  const [qaList, setQaList] = useState<DocumentQAPair[]>(analysis.qaHistory || []);
  const [input, setInput] = useState("");
  const [isAsking, setIsAsking] = useState(false);

  const suggestedQuestions = [
    "What is the primary submission deadline?",
    "What are the mandatory eligibility and submission requirements?",
    "What financial figures, awards, or fees are stated?",
  ];

  const handleSend = async (questionText?: string) => {
    const query = (questionText || input).trim();
    if (!query || isAsking) return;

    if (!questionText) setInput("");
    setIsAsking(true);

    try {
      const historyForApi = qaList.flatMap(item => [
        { role: "user" as const, content: item.question },
        { role: "assistant" as const, content: item.answer },
      ]);

      const aiPair = await askDocumentQuestion(
        doc.redactedText || doc.fullText,
        query,
        historyForApi,
        getSelectedAiModel()
      );
      setQaList(prev => [...prev, aiPair]);
    } catch {
      // Fallback to 100% deterministic offline search when AI is unavailable
      const detPair = answerQuestionDeterministically(query, doc, analysis);
      setQaList(prev => [...prev, detPair]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl flex flex-col h-[600px] overflow-hidden">
      <div className="p-4 border-b border-[#252A38] bg-[#08090D] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#E5C158]/10 border border-[#E5C158]/30 flex items-center justify-center text-[#E5C158]">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              Evidence-First Document Q&A
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <ShieldCheck className="w-3 h-3" /> Redacted Context Only
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              Active Model:{" "}
              <span className="font-mono text-[#E5C158]">{getSelectedAiModel()}</span>
            </p>
          </div>
        </div>
      </div>

      {qaList.length === 0 && (
        <div className="p-3 bg-[#0E1017] border-b border-[#252A38]">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3 text-[#E5C158]" /> Suggested Questions
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestedQuestions.map((q, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(q)}
                disabled={isAsking}
                className="text-left text-xs px-2.5 py-1.5 rounded-lg bg-[#141822] hover:bg-[#E5C158]/15 text-slate-300 hover:text-[#E5C158] border border-[#252A38] transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <CornerDownRight className="w-3 h-3 text-[#E5C158] shrink-0" />
                <span className="line-clamp-1">{q}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {qaList.length === 0 && (
          <div className="text-xs text-slate-400 bg-[#141822] border border-[#252A38] rounded-xl p-3.5">
            Ask any question about deadlines, fees, eligibility, or clauses. Answers are grounded strictly in the redacted text with source page citations, with automatic deterministic fallback if offline.
          </div>
        )}

        {qaList.map(pair => (
          <div key={pair.id} className="space-y-2">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-xs bg-[#E5C158] text-black font-medium px-3.5 py-2.5 text-xs">
                {pair.question}
              </div>
            </div>

            <div className="flex justify-start">
              <div className="max-w-[90%] rounded-2xl rounded-bl-xs bg-[#141822] text-slate-200 border border-[#252A38] p-3.5 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-slate-400">
                  <span>
                    Mode:{" "}
                    {pair.mode === "ai_assisted"
                      ? `AI-Assisted (${getSelectedAiModel()})`
                      : "Deterministic Search"}
                  </span>
                  <span>{Math.round(pair.confidence * 100)}% confidence</span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{pair.answer}</p>

                {pair.citations && pair.citations.length > 0 && (
                  <div className="pt-2 border-t border-[#252A38] space-y-1.5">
                    <div className="text-[10px] font-semibold text-[#E5C158] uppercase tracking-wider flex items-center gap-1">
                      <BookOpen className="w-3 h-3" /> Source Citations
                    </div>
                    {pair.citations.map((cit, i) => (
                      <div
                        key={i}
                        className="p-2 rounded-lg bg-[#08090D] border border-[#1E2838] text-[11px]"
                      >
                        <button
                          onClick={() => onOpenSourceModal(cit)}
                          className="font-semibold text-[#E5C158] hover:underline cursor-pointer"
                        >
                          Page {cit.page || 1} →
                        </button>
                        {cit.snippet && (
                          <p className="text-slate-400 italic line-clamp-2 mt-0.5">
                            &ldquo;{cit.snippet}&rdquo;
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {isAsking && (
          <div className="flex items-center gap-2 text-xs text-slate-400 p-2">
            <Loader2 className="w-4 h-4 animate-spin text-[#E5C158]" />
            Searching redacted document chunks & verifying citations...
          </div>
        )}
      </div>

      <form
        onSubmit={e => {
          e.preventDefault();
          handleSend();
        }}
        className="p-3 border-t border-[#252A38] bg-[#08090D] flex items-center gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask about deadlines, clauses, fees, or requirements..."
          className="flex-1 bg-[#141822] border border-[#252A38] rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#E5C158]"
        />
        <button
          type="submit"
          disabled={!input.trim() || isAsking}
          className="p-2.5 rounded-xl bg-[#E5C158] hover:bg-[#F3E3AD] disabled:opacity-40 text-black transition-colors cursor-pointer"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
