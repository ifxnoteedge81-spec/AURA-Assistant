import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Lock,
  RefreshCw,
  Save,
  Settings,
  Terminal,
  AlertTriangle,
} from 'lucide-react';
import { authFetch } from '../lib/api';
import type { BotConfig, SystemEnvStatusResponse } from '../types';

interface SettingsPanelProps {
  config: BotConfig;
  onUpdateConfig: (patch: Partial<BotConfig>) => Promise<void>;
  onLockNow: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  config,
  onUpdateConfig,
  onLockNow,
}) => {
  const [envStatus, setEnvStatus] = useState<SystemEnvStatusResponse | null>(null);
  const [loadingEnv, setLoadingEnv] = useState(false);

  const [ownerName, setOwnerName] = useState(config.ownerName);
  const [ownerProfession, setOwnerProfession] = useState(config.ownerProfession);
  const [ownerLocation, setOwnerLocation] = useState(config.ownerLocation);
  const [dailyLimit, setDailyLimit] = useState(config.dailyReplyLimit);
  const [cooldownSec, setCooldownSec] = useState(Math.round((config.cooldownMs || 0) / 1000));
  const [takeoverMin, setTakeoverMin] = useState(
    Math.max(1, Math.round((config.takeoverPauseMs || 1800000) / 60000))
  );

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [newPin, setNewPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  useEffect(() => {
    setOwnerName(config.ownerName);
    setOwnerProfession(config.ownerProfession);
    setOwnerLocation(config.ownerLocation);
    setDailyLimit(config.dailyReplyLimit);
    setCooldownSec(Math.round((config.cooldownMs || 0) / 1000));
    setTakeoverMin(Math.max(1, Math.round((config.takeoverPauseMs || 1800000) / 60000)));
  }, [config]);

  const loadEnvStatus = useCallback(async () => {
    setLoadingEnv(true);
    try {
      const res = await authFetch('/api/system/env-status');
      if (res.ok) {
        setEnvStatus((await res.json()) as SystemEnvStatusResponse);
      }
    } catch {
      // ignore transient poll failure
    } finally {
      setLoadingEnv(false);
    }
  }, []);

  useEffect(() => {
    void loadEnvStatus();
  }, [loadEnvStatus]);

  async function handleSaveRuntimeSettings(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    setSaveErr(null);
    try {
      await onUpdateConfig({
        ownerName: ownerName.trim() || 'Sir',
        ownerProfession: ownerProfession.trim(),
        ownerLocation: ownerLocation.trim(),
        dailyReplyLimit: Math.max(10, Math.min(1000, Number(dailyLimit) || 120)),
        cooldownMs: Math.max(0, Math.min(300, Number(cooldownSec) || 0)) * 1000,
        takeoverPauseMs: Math.max(1, Math.min(240, Number(takeoverMin) || 30)) * 60000,
      });
      setSaveMsg('Settings saved cleanly.');
    } catch (err) {
      setSaveErr((err as Error).message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(patch: Partial<BotConfig>, label: string) {
    setSaveErr(null);
    setSaveMsg(null);
    try {
      await onUpdateConfig(patch);
      setSaveMsg(`${label} updated.`);
    } catch (err) {
      setSaveErr((err as Error).message || 'Failed to update toggle.');
    }
  }

  async function handleSavePin(e: React.FormEvent) {
    e.preventDefault();
    setPinErr(null);
    setPinMsg(null);
    try {
      const res = await authFetch('/api/security/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', pin: newPin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPinErr(data.error || 'Could not update PIN.');
        return;
      }
      setNewPin('');
      setPinMsg('Dashboard PIN saved.');
      void loadEnvStatus();
    } catch (err) {
      setPinErr((err as Error).message || 'Could not update PIN.');
    }
  }

  function handleCopy(id: string, text: string) {
    void navigator.clipboard?.writeText(text);
    setCopiedCmd(id);
    setTimeout(() => setCopiedCmd(null), 2000);
  }

  const termuxWizardCmd = 'bash setup-termux.sh';
  const termuxSingleVarCmd = 'bash setup-termux.sh --env-only';
  const termuxBootCmd = 'NODE_ENV=production npx tsx server.ts';

  return (
    <div className="space-y-6">
      {/* Runtime Summary Header */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500">Runtime Environment</div>
          <div className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <Settings className="w-4 h-4 text-emerald-600" />
            {envStatus?.runtime.isTermux ? 'Android Termux' : envStatus?.runtime.platform || 'Node.js'} ·{' '}
            {envStatus?.runtime.nodeVersion || 'v22'}
          </div>
          <div className="text-xs text-slate-600">
            Port {envStatus?.runtime.port || 3000} · RAM {envStatus?.runtime.memoryMb ?? '—'} MB
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500">AI Keys Active (Env)</div>
          <div className="text-base font-semibold text-slate-900">
            Gemini Pool: {envStatus?.geminiKeysCount ?? 0} · OpenRouter: {envStatus?.openRouterKeysCount ?? 0}
          </div>
          <div className="text-xs text-slate-600">
            Owner Lock: {envStatus?.runtime.ownerEmail || 'ifxnoteedge81@gmail.com'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500">Firestore &amp; Keep-Alive</div>
          <div className="text-base font-semibold text-slate-900">
            DB: {envStatus?.firestore.configuredProjectId || 'gen-lang-client-0860563178'}
          </div>
          <div className="text-xs text-slate-600">
            Self-Ping: {envStatus?.runtime.selfPingEnabled ? 'Active (Every 4m)' : 'Off'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Bot & Dashboard Operational Settings */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Dashboard &amp; Bot Settings</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Adjust owner profile, reply safety caps, and automation switches live.
              </p>
            </div>
            <button
              type="button"
              onClick={onLockNow}
              className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              Lock
            </button>
          </div>

          <form onSubmit={handleSaveRuntimeSettings} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Owner Name</label>
                <input
                  type="text"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Location</label>
                <input
                  type="text"
                  value={ownerLocation}
                  onChange={(e) => setOwnerLocation(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Profession / Role</label>
              <input
                type="text"
                value={ownerProfession}
                onChange={(e) => setOwnerProfession(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Daily Reply Cap</label>
                <input
                  type="number"
                  min={10}
                  max={1000}
                  value={dailyLimit}
                  onChange={(e) => setDailyLimit(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">DM Cooldown (sec)</label>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={cooldownSec}
                  onChange={(e) => setCooldownSec(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Takeover Pause (min)</label>
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={takeoverMin}
                  onChange={(e) => setTakeoverMin(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save Runtime Settings'}
            </button>
          </form>

          {/* Quick Automation Switches */}
          <div className="pt-4 border-t border-slate-200 space-y-2.5 text-xs">
            {[
              {
                key: 'aiAssistantEnabled' as const,
                label: 'AI Assistant Smart Replies',
                value: config.aiAssistantEnabled,
              },
              {
                key: 'selfChatCopilotEnabled' as const,
                label: 'WhatsApp Self-Chat Command Copilot',
                value: config.selfChatCopilotEnabled,
              },
              {
                key: 'humanTypingEnabled' as const,
                label: 'Human-Like Typing & Anti-Ban Presence',
                value: config.humanTypingEnabled,
              },
              {
                key: 'storyAutoReadEnabled' as const,
                label: 'Status / Story Auto-Read',
                value: config.storyAutoReadEnabled,
              },
            ].map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-3">
                <span className="font-medium text-slate-800">{item.label}</span>
                <button
                  type="button"
                  onClick={() => void handleToggle({ [item.key]: !item.value }, item.label)}
                  className={`px-3 py-1.5 rounded-lg font-medium border cursor-pointer ${
                    item.value
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {item.value ? 'ON' : 'OFF'}
                </button>
              </div>
            ))}
          </div>

          {saveErr && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{saveErr}</div>
          )}
          {saveMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {saveMsg}
            </div>
          )}

          {/* Quick 2FA PIN */}
          <form onSubmit={handleSavePin} className="pt-4 border-t border-slate-200 space-y-2.5">
            <label className="block text-xs font-medium text-slate-700 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-emerald-600" />
              Update Dashboard Access PIN (4–8 digits)
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                inputMode="numeric"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder="e.g. 482910"
                className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50"
              />
              <button
                type="submit"
                disabled={!newPin.trim()}
                className="px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
              >
                Save PIN
              </button>
            </div>
            {pinErr && <div className="text-xs text-red-600">{pinErr}</div>}
            {pinMsg && <div className="text-xs text-emerald-700">{pinMsg}</div>}
          </form>
        </section>

        {/* Right: Termux Interactive Env Wizard & Readiness Status */}
        <section className="lg:col-span-6 space-y-6">
          {/* Environment Variables Readiness Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Environment Variables Status</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Secret keys stay securely inside Termux <span className="font-mono">.env</span> (never stored in browser UI).
                </p>
              </div>
              <button
                type="button"
                onClick={loadEnvStatus}
                disabled={loadingEnv}
                className="p-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 cursor-pointer"
                title="Refresh Environment Status"
              >
                <RefreshCw className={`w-4 h-4 ${loadingEnv ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="divide-y divide-slate-100 text-xs">
              {(envStatus?.envItems || []).map((item) => (
                <div key={item.key} className="py-2.5 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono font-semibold text-slate-900">{item.key}</div>
                    <div className="text-[11px] text-slate-500">
                      {item.category} · {item.detail}
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
                      item.configured
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}
                  >
                    {item.configured ? (
                      <>
                        <CheckCircle2 className="w-3 h-3" /> Configured
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-3 h-3" /> Not Set
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Termux One-by-One Env Setup Wizard Guide */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-600" />
              <h2 className="text-base font-semibold text-slate-900">
                Termux Env Wizard (একটা একটা করে কী সেট করুন)
              </h2>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              মোবাইল ফোনে <span className="font-mono">nano</span> এডিট করার ঝামেলা ছাড়াই Termux-এর ভেতর একটি একটি করে সব
              Environment Variable সেট করতে নিচের কমান্ডটি চালান:
            </p>

            {[
              {
                id: 'wizard',
                title: '১. Termux-এ স্টেপ-বাই-স্টেপ সব কী সেট ও সার্ভার চালু:',
                cmd: termuxWizardCmd,
              },
              {
                id: 'single',
                title: '২. শুধু যেকোনো ১টি নির্দিষ্ট ভেরিয়েবল পরিবর্তন করতে:',
                cmd: termuxSingleVarCmd,
              },
              {
                id: 'start',
                title: '৩. পরবর্তীতে শুধু সার্ভার স্টার্ট করতে (Dashboard -> http://localhost:3000):',
                cmd: termuxBootCmd,
              },
            ].map((block) => (
              <div key={block.id} className="space-y-1.5">
                <div className="text-xs font-medium text-slate-800">{block.title}</div>
                <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-900 text-slate-100 px-3 py-2 font-mono text-xs">
                  <span className="truncate">{block.cmd}</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(block.id, block.cmd)}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] flex items-center gap-1 shrink-0 cursor-pointer"
                  >
                    {copiedCmd === block.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copiedCmd === block.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
