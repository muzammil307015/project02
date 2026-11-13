import React, { useState, useEffect } from "react";
import {
  Cpu,
  Key,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  Sparkles,
  Server,
} from "lucide-react";
import {
  getAvailableAiModels,
  testAiConnection,
  getSelectedAiModel,
  setSelectedAiModel,
} from "../../services/aiProvider";
import {
  encryptAndSaveKey,
  getEncryptedVaultRecord,
  deleteVaultKey,
  isVaultUnlocked,
} from "../../services/byokVault";
import { AIModelCatalogueItem, EncryptedVaultRecord } from "../../types";

export const AiSettingsView: React.FC = () => {
  const [models, setModels] = useState<AIModelCatalogueItem[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [freeOnly, setFreeOnly] = useState(true);
  const [selectedModel, setSelectedModelState] = useState<string>(() =>
    getSelectedAiModel()
  );

  const [vaultRecord, setVaultRecord] = useState<EncryptedVaultRecord | null>(() =>
    getEncryptedVaultRecord()
  );
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [providerInput, setProviderInput] = useState<"openrouter" | "gemini">(
    vaultRecord?.provider || "openrouter"
  );
  const [passphraseInput, setPassphraseInput] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    provider: string;
    modelUsed?: string;
    message: string;
  } | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const handleSelectModel = (modelId: string) => {
    setSelectedModelState(modelId);
    setSelectedAiModel(modelId);
    setStatusBanner(
      `Selected model "${modelId}" saved as active AI engine for Analysis & Q&A.`
    );
  };

  const loadModels = async (onlyFree: boolean) => {
    setLoadingModels(true);
    try {
      const list = await getAvailableAiModels(onlyFree);
      setModels(list);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    loadModels(freeOnly);
  }, [freeOnly]);

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    try {
      const pwd = passphraseInput.trim().length >= 6 ? passphraseInput.trim() : "doculens-session-key";
      const record = await encryptAndSaveKey(apiKeyInput.trim(), pwd, providerInput);
      setVaultRecord(record);
      setApiKeyInput("");
      setStatusBanner("API Key encrypted with AES-GCM and unlocked for this session.");
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : "Failed to encrypt key.");
    }
  };

  const handleClearKey = () => {
    deleteVaultKey();
    setVaultRecord(null);
    setApiKeyInput("");
    setStatusBanner("Encrypted BYOK credentials wiped.");
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testAiConnection(selectedModel);
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#252A38] pb-6">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#E5C158]/10 border border-[#E5C158]/30 text-[#E5C158] text-xs font-semibold mb-2">
            <Cpu className="w-3.5 h-3.5" />
            AI Model Routing & AES-GCM BYOK Vault
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">
            AI Intelligence & Key Vault
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure server-side Gemini & OpenRouter models, verify zero-cost pricing, or supply your own AES-GCM encrypted key (BYOK).
          </p>
        </div>

        <button
          onClick={handleTestConnection}
          disabled={testing}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#E5C158] hover:bg-[#F3E3AD] disabled:opacity-50 text-black text-sm font-bold transition-all cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${testing ? "animate-spin" : ""}`} />
          {testing ? "Testing Active Model..." : "Test AI Connection"}
        </button>
      </div>

      {statusBanner && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{statusBanner}</span>
          </div>
          <button
            onClick={() => setStatusBanner(null)}
            className="text-xs underline hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {testResult && (
        <div
          className={`p-4 rounded-xl border text-sm flex items-center gap-3 ${
            testResult.ok
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : "bg-rose-500/10 border-rose-500/30 text-rose-300"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
          ) : (
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
          )}
          <div>
            <span className="font-bold">{testResult.provider}: </span>
            <span>{testResult.message}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: BYOK Vault */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-[#E5C158]/10 text-[#E5C158]">
                  <Key className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">AES-GCM BYOK Vault</h2>
                  <p className="text-xs text-slate-400">
                    PBKDF2 + AES-256-GCM Web Crypto Encryption
                  </p>
                </div>
              </div>
              {vaultRecord && (
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  {isVaultUnlocked() ? "Unlocked" : "Encrypted"} ({vaultRecord.provider})
                </span>
              )}
            </div>

            {vaultRecord && (
              <div className="p-4 rounded-xl bg-[#08090D] border border-[#252A38] flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-500 uppercase font-semibold">
                    Stored Encrypted Key ({vaultRecord.provider})
                  </div>
                  <div className="text-sm font-mono text-slate-200 mt-0.5">
                    {vaultRecord.maskedKey}
                  </div>
                </div>
                <button
                  onClick={handleClearKey}
                  className="p-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-colors cursor-pointer"
                  title="Wipe Key"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}

            <form onSubmit={handleSaveKey} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  AI Provider
                </label>
                <select
                  value={providerInput}
                  onChange={e =>
                    setProviderInput(e.target.value as "openrouter" | "gemini")
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#08090D] border border-[#252A38] text-slate-200 text-sm focus:outline-none focus:border-[#E5C158]"
                >
                  <option value="openrouter">
                    OpenRouter (Supports 200+ Models & Free Tier)
                  </option>
                  <option value="gemini">Google Gemini Studio API Key</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKeyInput}
                    onChange={e => setApiKeyInput(e.target.value)}
                    placeholder={
                      providerInput === "openrouter" ? "sk-or-v1-..." : "AIzaSy..."
                    }
                    className="w-full pl-3.5 pr-10 py-2.5 rounded-xl bg-[#08090D] border border-[#252A38] text-slate-200 text-sm font-mono focus:outline-none focus:border-[#E5C158]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Vault Password (Min 6 chars)
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={passphraseInput}
                    onChange={e => setPassphraseInput(e.target.value)}
                    placeholder="Enter master password for AES-GCM encryption"
                    className="w-full pl-3.5 pr-10 py-2.5 rounded-xl bg-[#08090D] border border-[#252A38] text-slate-200 text-sm focus:outline-none focus:border-[#E5C158]"
                  />
                  <Lock className="w-4 h-4 text-slate-600 absolute right-3 top-1/2 -translate-y-1/2" />
                </div>
              </div>

              <button
                type="submit"
                disabled={!apiKeyInput.trim()}
                className="w-full py-2.5 px-4 rounded-xl bg-[#E5C158] hover:bg-[#F3E3AD] disabled:opacity-40 text-black font-bold text-sm transition-all cursor-pointer"
              >
                Encrypt & Save Key
              </button>
            </form>

            <div className="p-3.5 rounded-xl bg-[#08090D] border border-[#252A38] text-xs text-slate-400 space-y-1">
              <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Zero Plaintext Persistence
              </div>
              <p>
                Plaintext keys are never written to disk or server storage.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Model Directory & Router */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-[#0E1017] border border-[#252A38] rounded-2xl p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-[#E5C158]/10 text-[#E5C158]">
                  <Server className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">
                    Available Intelligence Models
                  </h2>
                  <p className="text-xs text-slate-400">
                    Active Model:{" "}
                    <span className="text-[#E5C158] font-mono">{selectedModel}</span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={freeOnly}
                    onChange={e => setFreeOnly(e.target.checked)}
                    className="rounded bg-[#08090D] border-slate-700"
                  />
                  Verified Free Models Only
                </label>
                <button
                  onClick={() => loadModels(freeOnly)}
                  className="p-2 rounded-lg bg-[#141822] hover:bg-[#1E293B] text-slate-300 cursor-pointer"
                  title="Refresh Model Catalog"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingModels ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
              {models.map(m => {
                const isSelected = selectedModel === m.id;
                const isVerifiedFree = m.pricingStatus === "verified_free" && m.isFree;

                return (
                  <div
                    key={m.id}
                    onClick={() => handleSelectModel(m.id)}
                    className={`p-4 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? "bg-[#E5C158]/10 border-[#E5C158]/60 shadow-md"
                        : "bg-[#08090D] border-[#252A38] hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-white text-sm">{m.name}</span>
                          {isVerifiedFree ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                              Verified Free ($0 / $0)
                            </span>
                          ) : m.pricingStatus === "pricing_unavailable" ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/15 text-amber-300 border border-amber-500/30">
                              Pricing Unverified
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-800 text-slate-300 border border-slate-700">
                              Paid Tier
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#141822] text-slate-300 uppercase">
                            {m.provider}
                          </span>
                        </div>
                        <div className="text-xs font-mono text-slate-500 mt-0.5">
                          {m.id}
                        </div>
                        {m.description && (
                          <p className="text-xs text-slate-400 mt-1.5 line-clamp-2">
                            {m.description}
                          </p>
                        )}
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-xs font-mono text-slate-400">
                          {Math.round((m.contextLength || 32000) / 1000)}k ctx
                        </span>
                        {isSelected && (
                          <div className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#E5C158]">
                            <Sparkles className="w-3.5 h-3.5" />
                            Selected
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
