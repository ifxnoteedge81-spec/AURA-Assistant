import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, Lock, Play, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { ActiveTakeoverItem, BotConfig, DailyReplyStats } from '../types';

interface SecurityAntiBanPanelProps {
  config: BotConfig;
  onUpdateConfig: (patch: Partial<BotConfig>) => Promise<void>;
  onLockNow: () => void;
}

interface SecurityStatsResponse {
  ownerEmail: string;
  pinConfigured: boolean;
  envPinActive: boolean;
  dailyReplyStats: DailyReplyStats;
  activeTakeovers: ActiveTakeoverItem[];
  humanTypingEnabled: boolean;
  dailyReplyLimit: number;
  markOnlineOnConnect: boolean;
}

export function SecurityAntiBanPanel({
  config,
  onUpdateConfig,
  onLockNow,
}: SecurityAntiBanPanelProps) {
  const [stats, setStats] = useState<SecurityStatsResponse | null>(null);
  const [newPin, setNewPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [savingPin, setSavingPin] = useState(false);
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const [engineMsg, setEngineMsg] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await authFetch('/api/security/stats');
      if (res.ok) {
        setStats((await res.json()) as SecurityStatsResponse);
      }
    } catch {
      // ignore transient poll error
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  async function safeUpdateConfig(patch: Partial<BotConfig>, label: string) {
    setEngineErr(null);
    setEngineMsg(null);
    try {
      await onUpdateConfig(patch);
      setEngineMsg(label);
    } catch (err) {
      setEngineErr((err as Error).message || 'Could not update Anti-Ban settings.');
    }
  }

  async function handleSavePin(e: React.FormEvent) {
    e.preventDefault();
    setPinErr(null);
    setPinMsg(null);
    setSavingPin(true);
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
      setPinMsg('2FA Security PIN saved. Future logins will require this PIN.');
      await loadStats();
    } catch (err) {
      setPinErr((err as Error).message || 'Could not update PIN.');
    } finally {
      setSavingPin(false);
    }
  }

  async function handleRemovePin() {
    setPinErr(null);
    setPinMsg(null);
    try {
      const res = await authFetch('/api/security/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPinErr(data.error || 'Could not remove custom PIN.');
        return;
      }
      setPinMsg('Custom Security PIN cleared.');
      await loadStats();
    } catch (err) {
      setPinErr((err as Error).message || 'Could not remove custom PIN.');
    }
  }

  async function handleResumeTakeover(jid?: string) {
    setEngineErr(null);
    try {
      const res = await authFetch('/api/security/resume-takeover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: jid || '' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEngineErr(data.error || 'Could not resume AI takeover.');
        return;
      }
      await loadStats();
    } catch (err) {
      setEngineErr((err as Error).message || 'Could not resume AI takeover.');
    }
  }

  const dailyCount = stats?.dailyReplyStats.count ?? 0;
  const dailyLimit = config.dailyReplyLimit || 120;

  return (
    <div className="space-y-8">
      {/* Top Security & Anti-Ban Status Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-slate-200 bg-white rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Dashboard Access Lock</div>
          <div className="mt-1.5 text-lg font-semibold text-emerald-700">Owner Protected</div>
          <div className="mt-1 text-xs text-slate-500 truncate">{stats?.ownerEmail || 'ifxnoteedge81@gmail.com'}</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">2FA Security PIN</div>
          <div className={`mt-1.5 text-lg font-semibold ${stats?.pinConfigured ? 'text-emerald-700' : 'text-amber-700'}`}>
            {stats?.pinConfigured ? 'Enabled' : 'Not Set'}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {stats?.pinConfigured ? 'Required alongside Google Auth' : 'Recommended extra lock'}
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Daily Safe Reply Cap</div>
          <div className="mt-1.5 text-lg font-semibold text-slate-900 tabular-nums font-mono">
            {dailyCount} / {dailyLimit}
          </div>
          <div className="mt-1 text-xs text-slate-500">Prevents WhatsApp spam throttling</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Stealth &amp; Takeover Pauses</div>
          <div className="mt-1.5 text-lg font-semibold text-slate-900 tabular-nums">
            {stats?.activeTakeovers.length ?? 0} Paused Chats
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Online indicator hidden (always-online OFF)
          </div>
        </div>
      </div>

      {/* Main Split: 2FA PIN & Lock + Human-Like Anti-Ban Engine */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Dashboard 2FA PIN Setup */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-emerald-600" />
                Dashboard 2FA Security PIN
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                Add a 4–8 digit PIN so anyone trying to open your public URL needs your Google Account AND your secret PIN.
              </p>
            </div>
            <button
              type="button"
              onClick={onLockNow}
              className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              Lock Now
            </button>
          </div>

          <form onSubmit={handleSavePin} className="space-y-3">
            <label htmlFor="new-security-pin" className="block text-xs font-medium text-slate-700">
              Set / Update 4–8 Digit Security PIN
            </label>
            <div className="flex gap-2.5">
              <input
                id="new-security-pin"
                type="password"
                inputMode="numeric"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder="e.g. 482910"
                className="flex-1 px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
              <button
                type="submit"
                disabled={savingPin || !newPin.trim()}
                className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
              >
                {savingPin ? 'Saving...' : 'Save 2FA PIN'}
              </button>
            </div>
          </form>

          {pinErr && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{pinErr}</div>
          )}
          {pinMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>{pinMsg}</span>
            </div>
          )}

          {stats?.pinConfigured && !stats.envPinActive && (
            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={handleRemovePin}
                className="px-3 py-1.5 text-xs font-medium text-red-700 border border-slate-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove Custom PIN
              </button>
            </div>
          )}
        </section>

        {/* Human Behavior & Anti-Ban Controls */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="pb-4 border-b border-slate-200">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              Human-Like Anti-Ban Engine
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              Simulates real human reading &amp; typing speeds so WhatsApp does not flag your account as an instant spam bot.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900">Instant Typing &amp; Read Presence</div>
              <div className="text-xs text-slate-500">
                Sends read receipt and composing indicator in parallel while AI generates in milliseconds—zero artificial pause added.
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                void safeUpdateConfig(
                  { humanTypingEnabled: !config.humanTypingEnabled },
                  !config.humanTypingEnabled ? 'Human typing simulation enabled.' : 'Human typing simulation disabled.'
                )
              }
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border whitespace-nowrap shrink-0 cursor-pointer ${
                config.humanTypingEnabled
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.humanTypingEnabled ? 'Enabled (Safe)' : 'Disabled'}
            </button>
          </div>

          <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900">Daily Automated Reply Limit</div>
              <div className="text-xs text-slate-500">
                Automatically pauses AI replies if daily limit is hit to protect account health.
              </div>
            </div>
            <select
              value={config.dailyReplyLimit}
              onChange={(e) => {
                const limit = Number(e.target.value);
                void safeUpdateConfig({ dailyReplyLimit: limit }, `Daily safe reply limit updated to ${limit}.`);
              }}
              className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value={50}>50 replies / day (Ultra Safe)</option>
              <option value={80}>80 replies / day (New Number)</option>
              <option value={120}>120 replies / day (Recommended)</option>
              <option value={200}>200 replies / day (Aged Number)</option>
              <option value={350}>350 replies / day (High Volume)</option>
            </select>
          </div>

          {engineErr && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{engineErr}</div>
          )}
          {engineMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>{engineMsg}</span>
            </div>
          )}

          <ul className="pt-3 border-t border-slate-200 space-y-2 text-xs text-slate-700">
            <li className="flex justify-between">
              <span>Group Chats Auto-Reply</span>
              <span className="font-medium text-emerald-700">Strictly Blocked (DM Only)</span>
            </li>
            <li className="flex justify-between">
              <span>Duplicate Reply Filter</span>
              <span className="font-medium text-emerald-700">Active (Never Repeats Same SMS)</span>
            </li>
            <li className="flex justify-between">
              <span>24/7 Always-Online Flag</span>
              <span className="font-medium text-emerald-700">Disabled (markOnlineOnConnect: false)</span>
            </li>
          </ul>
        </section>
      </div>

      {/* Active Human Takeover Pauses */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Active Human Takeover Pauses ({Math.round(config.takeoverPauseMs / 60000)}m Rule)
            </h2>
            <p className="text-xs text-slate-600">
              Chats automatically paused because you typed manually from your phone keyboard. AI resumes automatically when the timer expires.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(stats?.activeTakeovers.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => handleResumeTakeover()}
                className="px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 cursor-pointer whitespace-nowrap"
              >
                Resume All Now
              </button>
            )}
            <button
              type="button"
              onClick={loadStats}
              className="p-2 text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {!stats || stats.activeTakeovers.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No private chats are currently paused. Whenever you type a manual message in any DM, it appears here until AI resumes.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {stats.activeTakeovers.map((item) => (
              <div key={item.jid} className="px-6 py-3.5 flex items-center justify-between gap-4 text-xs">
                <div>
                  <span className="font-mono font-semibold text-slate-900">+{item.phone}</span>
                  <span className="mx-2 text-slate-300">&middot;</span>
                  <span className="text-slate-600">
                    AI paused for {Math.max(1, Math.ceil(item.remainingMs / 60000))}m more (resumes{' '}
                    {new Date(item.resumeAt).toLocaleTimeString()})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleResumeTakeover(item.jid)}
                  className="px-3 py-1.5 font-medium text-emerald-700 border border-slate-200 rounded-lg hover:bg-emerald-50 flex items-center gap-1 cursor-pointer"
                >
                  <Play className="w-3 h-3" />
                  Resume AI
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Practical WhatsApp Anti-Ban Field Guide */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-amber-600" />
          <h2 className="text-base font-semibold text-slate-900">
            WhatsApp Anti-Ban Safety Guide (অ্যাকাউন্ট নিরাপদ রাখার নিয়ম)
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-700 leading-relaxed">
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="font-semibold text-slate-900">১. শুধুমাত্র প্রাইভেট ইনবক্স — গ্রুপ থেকে ১০০% দূরে</div>
            <p>
              গ্রুপে অটো-রিপ্লাই দিলে অপরিচিত মেম্বাররা স্প্যাম রিপোর্ট করে, যা ব্যান হওয়ার সবচেয়ে বড় কারণ। এই বট কোড লেভেল থেকেই গ্রুপে কোনো এআই রিপ্লাই দেবে না।
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="font-semibold text-slate-900">২. মানুষের মতো টাইপিং ও রিড ডিলে</div>
            <p>
              সেকেন্ডের মধ্যে জবাব দিলে হোয়াটসঅ্যাপ সেটাকে বট ধরে। Human Typing চালু রাখায় বট আগে ২.৬ সেকেন্ড অপেক্ষা করে, মেসেজ সিন করে, তারপর আসল মানুষের মতো টাইপিং দেখিয়ে রিপ্লাই দেয়।
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="font-semibold text-slate-900">৩. কখনো নিজে থেকে বাল্ক/আগে মেসেজ দেবেন না</div>
            <p>
              অ্যাসিস্ট্যান্ট শুধুমাত্র কেউ আপনাকে মেসেজ দিলে উত্তর দেবে। নতুন বা অপরিচিত নম্বরে কখনো নিজে থেকে অটো-মেসেজ বা প্রমোশনাল লিংক পাঠাবেন না।
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="font-semibold text-slate-900">৪. নতুন নম্বর হলে প্রথম ৭ দিন সীমা কম রাখুন</div>
            <p>
              একদম নতুন সিম হলে Daily Cap ৫০–৮০ রাখুন এবং দিনে অন্তত কয়েকবার নিজে হাতে পরিচিত বন্ধুদের সাথে স্বাভাবিক চ্যাট বা কল করুন।
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
