import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  Chrome,
  Copy,
  Download,
  Globe,
  KeyRound,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  ShieldAlert,
  Square,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { authFetch } from '../lib/api';
import type { ChromeStatusSnapshot } from '../types';

const CHROME_PRESETS = [
  {
    label: 'New Account Signup',
    goal: 'এই সাইটে আমার Identity Profile দিয়ে একটি নতুন একাউন্ট (Sign Up / Register) খুলে দাও। OTP বা Captcha এলে আমাকে জানাবে।',
  },
  {
    label: 'Auto Login & Check',
    goal: 'আমার Saved Account দিয়ে এই ওয়েবসাইটে লগইন করো এবং হোমপেজ/ড্যাশবোর্ডে ঢুকেছে কিনা যাচাই করে রিপোর্ট দাও।',
  },
  {
    label: 'Fill Web Form',
    goal: 'পেজের ফর্মটি আমার প্রোফাইল তথ্য দিয়ে সঠিকভাবে পূরণ করে সাবমিট করো।',
  },
];

export const ChromeHandsPanel: React.FC = () => {
  const [status, setStatus] = useState<ChromeStatusSnapshot | null>(null);
  const [goalInput, setGoalInput] = useState('');
  const [startUrlInput, setStartUrlInput] = useState('');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Manual Chrome Screen Controls
  const [navUrl, setNavUrl] = useState('');
  const [manualText, setManualText] = useState('');
  const [humanOtpReply, setHumanOtpReply] = useState('');

  // Engine Connection Config
  const [wsEndpointInput, setWsEndpointInput] = useState('');
  const [companionScript, setCompanionScript] = useState('');
  const [copiedScript, setCopiedScript] = useState(false);
  const [showSetupDrawer, setShowSetupDrawer] = useState(false);

  // Vault: Account form
  const [accLabel, setAccLabel] = useState('');
  const [accUrl, setAccUrl] = useState('');
  const [accUser, setAccUser] = useState('');
  const [accPass, setAccPass] = useState('');
  const [accHint, setAccHint] = useState('');

  // Vault: Signup Identity form
  const [idFullName, setIdFullName] = useState('');
  const [idEmail, setIdEmail] = useState('');
  const [idPhone, setIdPhone] = useState('');
  const [idPrefix, setIdPrefix] = useState('');
  const [idDob, setIdDob] = useState('');
  const [idDefaultPass, setIdDefaultPass] = useState('');
  const [identityInitialized, setIdentityInitialized] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await authFetch('/api/chrome/status');
      if (!res.ok) return;
      const data = (await res.json()) as ChromeStatusSnapshot;
      setStatus(data);
      if (data.currentUrl && !navUrl) {
        setNavUrl(data.currentUrl);
      }
      if (!identityInitialized && data.identity) {
        setIdFullName(data.identity.fullName || '');
        setIdEmail(data.identity.defaultEmail || '');
        setIdPhone(data.identity.defaultPhone || '');
        setIdPrefix(data.identity.usernamePrefix || '');
        setIdDob(data.identity.dateOfBirth || '');
        setIdentityInitialized(true);
      }
    } catch {
      // keep UI stable on poll error
    }
  }, [identityInitialized, navUrl]);

  useEffect(() => {
    void loadStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadStatus();
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  async function handleRunChrome(presetGoal?: string) {
    const goal = (presetGoal ?? goalInput).trim();
    if (!goal || running) return;
    setRunning(true);
    setNotice(null);
    try {
      const res = await authFetch('/api/chrome/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal,
          startUrl: startUrlInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error || 'Chrome task could not start.');
      } else if (data.queuedBackground) {
        setNotice('Chrome Hands task started on Netlify 15-min background runner — watching live screen...');
      } else {
        setNotice(data.task?.finalSummary || 'Chrome task finished.');
      }
      await loadStatus();
    } finally {
      setRunning(false);
    }
  }

  async function handleResumeOtp() {
    if (!status?.activeTask) return;
    setRunning(true);
    setNotice(null);
    try {
      const res = await authFetch('/api/chrome/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: status.activeTask.id,
          humanReply: humanOtpReply.trim() || 'Manual step completed by owner, continue.',
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setHumanOtpReply('');
        setNotice(data.queuedBackground ? 'Resumed Chrome task in background...' : data.task?.finalSummary || 'Resumed.');
      } else {
        setNotice(data.error || 'Resume failed.');
      }
      await loadStatus();
    } finally {
      setRunning(false);
    }
  }

  async function handleStopChrome() {
    await authFetch('/api/chrome/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: status?.activeTask?.id }),
    });
    setNotice('Chrome task stop signal sent.');
    await loadStatus();
  }

  async function sendManual(payload: Record<string, unknown>) {
    setNotice(null);
    const res = await authFetch('/api/chrome/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setNotice(data.error || 'Manual Chrome control failed.');
    } else if (data.status) {
      setStatus(data.status);
      if (data.status.currentUrl) setNavUrl(data.status.currentUrl);
    }
  }

  async function handleViewportClick(e: React.MouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 720);
    await sendManual({ type: 'click_xy', x, y });
  }

  async function handleSaveWsEndpoint(e: React.FormEvent) {
    e.preventDefault();
    const res = await authFetch('/api/chrome/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customWsEndpoint: wsEndpointInput.trim() }),
    });
    const data = await res.json();
    if (res.ok) {
      setWsEndpointInput('');
      setStatus(data.status);
      setNotice('Remote Chrome WebSocket endpoint saved securely (AES-256-GCM).');
    } else {
      setNotice(data.error || 'Could not save endpoint.');
    }
  }

  async function handleClearWsEndpoint() {
    const res = await authFetch('/api/chrome/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearWsEndpoint: true }),
    });
    if (res.ok) {
      const data = await res.json();
      setStatus(data.status);
      setNotice('Cleared custom Chrome WebSocket endpoint.');
    }
  }

  async function handleToggleHeadless() {
    const res = await authFetch('/api/chrome/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless: !(status?.headless !== false) }),
    });
    if (res.ok) {
      const data = await res.json();
      setStatus(data.status);
    }
  }

  async function handleLoadCompanionScript() {
    const res = await authFetch('/api/chrome/companion-script');
    if (res.ok) {
      const data = await res.json();
      setCompanionScript(data.script || '');
      setShowSetupDrawer(true);
    }
  }

  async function handleCopyScript() {
    if (!companionScript) return;
    await navigator.clipboard.writeText(companionScript);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 2000);
  }

  function handleDownloadScript() {
    if (!companionScript) return;
    const blob = new Blob([companionScript], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chrome-companion.mjs';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!accLabel.trim() || !accUrl.trim() || !accUser.trim()) return;
    const res = await authFetch('/api/chrome/vault/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: accLabel.trim(),
        loginUrl: accUrl.trim(),
        username: accUser.trim(),
        password: accPass,
        totpHint: accHint.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setAccLabel('');
      setAccUrl('');
      setAccUser('');
      setAccPass('');
      setAccHint('');
      setNotice('Account saved to AES-256-GCM Vault.');
      await loadStatus();
    } else {
      setNotice(data.error || 'Failed to save account.');
    }
  }

  async function handleDeleteAccount(id: string) {
    await authFetch(`/api/chrome/vault/account/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadStatus();
  }

  async function handleSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    const res = await authFetch('/api/chrome/vault/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: idFullName,
        defaultEmail: idEmail,
        defaultPhone: idPhone,
        usernamePrefix: idPrefix,
        dateOfBirth: idDob,
        defaultSignupPassword: idDefaultPass || undefined,
      }),
    });
    if (res.ok) {
      setIdDefaultPass('');
      setNotice('Signup Identity Profile updated securely.');
      await loadStatus();
    }
  }

  const backendBadge = (() => {
    switch (status?.backendMode) {
      case 'remote_cdp':
        return { text: 'Remote CDP Chrome Connected', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'local_chrome':
        return { text: 'Local Chrome Profile Ready', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'companion_bridge':
        return { text: 'Companion PC Chrome Online', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      default:
        return { text: 'Chrome Setup Required', cls: 'bg-amber-50 text-amber-800 border-amber-200' };
    }
  })();

  const activeTask = status?.activeTask;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center shrink-0">
              <Chrome className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">
                Chrome Autonomous Hands &amp; Feet (ব্রাউজার অটোমেশন)
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                আসল Google Chrome নিয়ন্ত্রণ করে যেকোনো ওয়েবসাইটে নতুন একাউন্ট খোলা, অটো-লগইন, ফর্ম পূরণ ও লাইভ স্ক্রিন কন্ট্রোল।
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${backendBadge.cls}`}>
              {backendBadge.text}
            </span>
            <button
              type="button"
              onClick={handleLoadCompanionScript}
              className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 cursor-pointer"
            >
              <Monitor className="w-3.5 h-3.5" />
              Connect PC / Cloud Chrome
            </button>
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="p-1.5 text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              title="Refresh Status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {notice && (
          <div className="mt-4 px-3.5 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 whitespace-pre-wrap">
            {notice}
          </div>
        )}
      </div>

      {/* Engine Connection Drawer (Remote CDP OR Free PC Companion Chrome Bridge) */}
      {(showSetupDrawer || status?.backendMode === 'unconfigured') && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Chrome কানেকশন সেটআপ (২টি উপায়ের যেকোনো ১টি ব্যবহার করুন)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {status?.isServerless
                  ? 'Netlify সার্ভারলেসে সরাসরি Chrome থাকে না, তাই আপনার পিসির আসল Chrome অথবা Cloud Browserless সংযুক্ত করুন।'
                  : 'লোকাল বা VPS সার্ভারে সিস্টেম Chrome অটো-ডিটেক্ট হয়, অথবা নিচে Remote Chrome যুক্ত করতে পারেন।'}
              </p>
            </div>
            {showSetupDrawer && (
              <button
                type="button"
                onClick={() => setShowSetupDrawer(false)}
                className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                Hide
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Option 1: Free PC Companion Chrome */}
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-900">
                  উপায় ১: আপনার নিজের পিসি/ল্যাপটপ Chrome (১০০% ফ্রি &amp; রিয়েল IP)
                </div>
                <span
                  className={`text-[11px] font-medium px-2 py-0.5 rounded ${
                    status?.companionOnline ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {status?.companionOnline ? 'Connected' : 'Offline'}
                </span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                নিচের <code className="bg-white px-1 py-0.5 rounded border border-slate-200">chrome-companion.mjs</code> স্ক্রিপ্টটি পিসিতে <code className="bg-white px-1 py-0.5 rounded border border-slate-200">npm install playwright-core &amp;&amp; node chrome-companion.mjs</code> দিয়ে চালালেই আপনার আসল Chrome (কুকি ও লগইনসহ) WaNexus-এর হাত-পা হয়ে কাজ করবে!
              </p>
              <div className="flex flex-wrap gap-2">
                {!companionScript ? (
                  <button
                    type="button"
                    onClick={handleLoadCompanionScript}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    Generate Bridge Script
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleDownloadScript}
                      className="px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download chrome-companion.mjs
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyScript}
                      className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedScript ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedScript ? 'Copied!' : 'Copy Code'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Option 2: Remote Cloud Chrome CDP WebSocket */}
            <form onSubmit={handleSaveWsEndpoint} className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-900">
                  উপায় ২: 24/7 Cloud Chrome (Browserless / Steel / CDP WebSocket)
                </div>
                {status?.remoteCdpConfigured && (
                  <button
                    type="button"
                    onClick={handleClearWsEndpoint}
                    className="text-[11px] text-red-600 hover:underline cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-600">
                Browserless.io / Browserbase / দূরবর্তী Chrome CDP-এর <code className="bg-white px-1 rounded border border-slate-200">wss://...</code> URL দিন (বা Netlify Env-এ <code className="bg-white px-1 rounded border border-slate-200">CHROME_WS_ENDPOINT</code> সেট করুন)।
              </p>
              {status?.remoteCdpMasked && (
                <div className="text-[11px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded">
                  Active: {status.remoteCdpMasked}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="password"
                  value={wsEndpointInput}
                  onChange={(e) => setWsEndpointInput(e.target.value)}
                  placeholder="wss://chrome.browserless.io?token=..."
                  className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Save
                </button>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={status?.headless !== false}
                  onChange={handleToggleHeadless}
                />
                Headless Mode (Local/VPS Chrome ব্যাকগ্রাউন্ডে চালাবে)
              </label>
            </form>
          </div>
        </div>
      )}

      {/* OTP / CAPTCHA Human Intervention Alert */}
      {activeTask?.status === 'waiting_human_input' && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-amber-900">
                আপনার হস্তক্ষেপ প্রয়োজন ({activeTask.pauseKind?.toUpperCase() || 'VERIFICATION'})
              </div>
              <p className="text-xs text-amber-800 mt-1">{activeTask.pauseReasonBn}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={humanOtpReply}
              onChange={(e) => setHumanOtpReply(e.target.value)}
              placeholder="OTP / 2FA কোড লিখুন (অথবা নিচের স্ক্রিনে Captcha সমাধান করে খালি রেখে Resume দিন)"
              className="flex-1 min-w-[240px] px-3 py-2 text-xs bg-white border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-600"
            />
            <button
              type="button"
              onClick={handleResumeOtp}
              disabled={running}
              className="px-4 py-2 text-xs font-semibold bg-amber-700 text-white rounded-lg hover:bg-amber-800 disabled:opacity-50 cursor-pointer"
            >
              Submit &amp; Resume AI
            </button>
          </div>
        </div>
      )}

      {/* Mission Bar + Quick Presets */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {CHROME_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setGoalInput(p.goal)}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 cursor-pointer"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="text"
            value={startUrlInput}
            onChange={(e) => setStartUrlInput(e.target.value)}
            placeholder="Starting URL (e.g. https://github.com/signup)"
            className="px-3.5 py-2.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
          <input
            type="text"
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            placeholder="কাজ লিখুন: যেমন — আমার জন্য এই সাইটে নতুন একাউন্ট খুলে লগইন করো..."
            className="md:col-span-2 px-3.5 py-2.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500">
            টেলিগ্রাম থেকেও চালাতে পারেন: <code className="bg-slate-100 px-1.5 py-0.5 rounded">/chrome https://... একাউন্ট খুলে দাও</code>
          </div>
          <div className="flex items-center gap-2">
            {(activeTask?.status === 'running' || activeTask?.status === 'waiting_human_input') && (
              <button
                type="button"
                onClick={handleStopChrome}
                className="px-3.5 py-2 text-xs font-medium bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 flex items-center gap-1.5 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                Stop Chrome
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleRunChrome()}
              disabled={running || !goalInput.trim()}
              className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              {running ? 'Running Chrome...' : 'Run in Chrome'}
            </button>
          </div>
        </div>
      </div>

      {/* Live Chrome Viewport + Timeline */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          {/* Browser Address Toolbar */}
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void sendManual({ type: 'back' })}
              className="p-1.5 text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
              title="Back"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void sendManual({ type: 'reload' })}
              className="p-1.5 text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
              title="Reload"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
            <form
              className="flex-1 flex gap-1.5 min-w-[200px]"
              onSubmit={(e) => {
                e.preventDefault();
                if (navUrl.trim()) void sendManual({ type: 'goto', url: navUrl.trim() });
              }}
            >
              <div className="flex-1 relative flex items-center">
                <Globe className="w-3.5 h-3.5 text-slate-400 absolute left-2.5" />
                <input
                  type="text"
                  value={navUrl}
                  onChange={(e) => setNavUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <button
                type="submit"
                className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                Go
              </button>
            </form>
            <button
              type="button"
              onClick={() => void sendManual({ type: 'screenshot' })}
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              Snap Screen
            </button>
          </div>

          {/* Interactive Chrome Viewport */}
          <div className="bg-slate-950 aspect-video relative flex items-center justify-center overflow-hidden">
            {status?.screenshotDataUrl ? (
              <img
                src={status.screenshotDataUrl}
                alt="Live Chrome Browser Screen"
                onClick={handleViewportClick}
                className="w-full h-full object-contain cursor-crosshair select-none"
                title="Click anywhere on Chrome screen to click inside browser"
              />
            ) : (
              <div className="text-center px-6 py-10 space-y-2">
                <Chrome className="w-8 h-8 text-slate-600 mx-auto" />
                <div className="text-xs text-slate-400">
                  কোনো লাইভ Chrome স্ক্রিন এখনো আসেনি। উপরে URL লিখে <strong>Go</strong> চাপুন অথবা একটি টাস্ক চালান।
                </div>
              </div>
            )}
          </div>

          {/* Manual Type & Scroll Controls */}
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center gap-2">
            <form
              className="flex-1 flex gap-2 min-w-[220px]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!manualText) return;
                void sendManual({ type: 'type', text: manualText, submitEnter: true });
                setManualText('');
              }}
            >
              <input
                type="text"
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="স্ক্রিনে ক্লিক করার পর এখানে টেক্সট বা OTP লিখে Enter চাপুন..."
                className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
              <button
                type="submit"
                className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
              >
                <Send className="w-3 h-3" />
                Type
              </button>
            </form>
            <button
              type="button"
              onClick={() => void sendManual({ type: 'scroll', direction: 'up' })}
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg hover:bg-slate-100 flex items-center gap-1 cursor-pointer"
            >
              <ArrowUpDown className="w-3 h-3" />
              Up
            </button>
            <button
              type="button"
              onClick={() => void sendManual({ type: 'scroll', direction: 'down' })}
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg hover:bg-slate-100 flex items-center gap-1 cursor-pointer"
            >
              <ArrowUpDown className="w-3 h-3" />
              Down
            </button>
          </div>
        </div>

        {/* Right Column: Action Steps & History */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col max-h-[540px]">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Chrome Action Log ({status?.tasks?.length || 0})
          </h3>
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {(status?.tasks || []).length === 0 ? (
              <div className="text-xs text-slate-400 py-8 text-center">
                এখনো কোনো Chrome মিশন চালানো হয়নি।
              </div>
            ) : (
              status!.tasks.map((t) => (
                <div key={t.id} className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                      {t.status} · {t.backendUsed}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {new Date(t.updatedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-slate-900">{t.goal}</div>
                  {t.finalSummary && (
                    <div className="text-xs text-slate-700 bg-white p-2 rounded border border-slate-200 whitespace-pre-wrap">
                      {t.finalSummary}
                    </div>
                  )}
                  {t.steps.length > 0 && (
                    <div className="space-y-1 pt-1">
                      {t.steps.slice(-5).map((s) => (
                        <div key={s.stepNumber} className="text-[11px] text-slate-600 flex items-start gap-1.5">
                          <span className="font-mono text-slate-400">#{s.stepNumber}</span>
                          <span>
                            <strong>{s.action}</strong> — {s.reasonBn}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Encrypted Account Vault & Signup Identity Profile */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Saved Account Credentials Vault */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-slate-700" />
            <h2 className="text-sm font-semibold text-slate-900">
              Encrypted Account Vault (লগইন ভল্ট — AES-256-GCM)
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            সেভ করা পাসওয়ার্ড এনক্রিপ্ট অবস্থায় সার্ভারে থাকে এবং ড্যাশবোর্ড বা AI প্রম্পটে কখনো প্লেইনটেক্সটে দেখায় না—শুধু Chrome-এ লগইনের সময় সরাসরি ইনপুট ফিল্ডে টাইপ হয়।
          </p>

          <form onSubmit={handleAddAccount} className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <input
              type="text"
              value={accLabel}
              onChange={(e) => setAccLabel(e.target.value)}
              placeholder="Account Name (e.g. Facebook / GitHub)"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg"
              required
            />
            <input
              type="text"
              value={accUrl}
              onChange={(e) => setAccUrl(e.target.value)}
              placeholder="Login URL (https://...)"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg"
              required
            />
            <input
              type="text"
              value={accUser}
              onChange={(e) => setAccUser(e.target.value)}
              placeholder="Email / Username / Phone"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg"
              required
            />
            <input
              type="password"
              value={accPass}
              onChange={(e) => setAccPass(e.target.value)}
              placeholder="Password (encrypted on save)"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg"
            />
            <input
              type="text"
              value={accHint}
              onChange={(e) => setAccHint(e.target.value)}
              placeholder="2FA/Note hint (optional)"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg sm:col-span-2"
            />
            <button
              type="submit"
              className="sm:col-span-2 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Save Login to Encrypted Vault
            </button>
          </form>

          <div className="space-y-2 pt-2">
            {(status?.accounts || []).map((acc) => (
              <div
                key={acc.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 truncate">
                    {acc.label} <span className="font-normal text-slate-500">({acc.domain})</span>
                  </div>
                  <div className="text-[11px] text-slate-600 truncate">
                    {acc.username} · {acc.hasPassword ? '••••••••' : 'No password stored'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDeleteAccount(acc.id)}
                  className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                  title="Remove saved account"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Signup Identity Profile (For opening new accounts automatically) */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-slate-700" />
            <h2 className="text-sm font-semibold text-slate-900">
              New Account Signup Identity Profile (নতুন একাউন্ট খোলার তথ্য)
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            যখন Chrome-কে বলবেন *"আমার জন্য এই সাইটে নতুন একাউন্ট খুলে দাও"*, AI নিচের প্রোফাইল থেকে নাম, ইমেইল, ফোন ও ডিফল্ট পাসওয়ার্ড নিয়ে ফর্ম পূরণ করবে।
          </p>

          <form onSubmit={handleSaveIdentity} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Full Name</label>
              <input
                type="text"
                value={idFullName}
                onChange={(e) => setIdFullName(e.target.value)}
                placeholder="Your Full Name"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Default Email</label>
              <input
                type="email"
                value={idEmail}
                onChange={(e) => setIdEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Phone Number</label>
              <input
                type="text"
                value={idPhone}
                onChange={(e) => setIdPhone(e.target.value)}
                placeholder="+8801..."
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Username Prefix</label>
              <input
                type="text"
                value={idPrefix}
                onChange={(e) => setIdPrefix(e.target.value)}
                placeholder="wanexus_user"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Date of Birth</label>
              <input
                type="text"
                value={idDob}
                onChange={(e) => setIdDob(e.target.value)}
                placeholder="1999-05-15"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Default Signup Password {status?.identity.hasDefaultPassword ? '(Saved ✓)' : ''}
              </label>
              <input
                type="password"
                value={idDefaultPass}
                onChange={(e) => setIdDefaultPass(e.target.value)}
                placeholder={status?.identity.hasDefaultPassword ? 'Leave blank to keep existing' : 'Optional strong password'}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="sm:col-span-2 px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 cursor-pointer"
            >
              Save Signup Identity Profile
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
