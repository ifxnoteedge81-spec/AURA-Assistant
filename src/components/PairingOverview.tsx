import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { BotStatusResponse } from '../types';

interface PairingOverviewProps {
  botState: BotStatusResponse;
  onRefresh: () => Promise<void>;
  onPair: (phoneNumber: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onResetSession: () => Promise<void>;
  onToggleAutoreply: (enabled: boolean) => Promise<void>;
  onNavigate: (section: 'simulator' | 'rules' | 'source') => void;
}

export function PairingOverview({
  botState,
  onRefresh,
  onPair,
  onDisconnect,
  onResetSession,
  onToggleAutoreply,
  onNavigate,
}: PairingOverviewProps) {
  const [phoneInput, setPhoneInput] = useState(botState.pairingPhone || '');
  const [isPairing, setIsPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (!phoneInput && botState.pairingPhone) {
      setPhoneInput(botState.pairingPhone);
    }
  }, [botState.pairingPhone]);

  const activeGroupCount = Object.values(botState.config.antilinkGroups).filter(Boolean).length;

  async function handlePairSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPairError(null);
    setIsPairing(true);
    try {
      await onPair(phoneInput);
    } catch (err) {
      setPairError((err as Error).message);
    } finally {
      setIsPairing(false);
    }
  }

  async function handleCopyPairingCode() {
    if (!botState.pairingCode) return;
    await navigator.clipboard.writeText(botState.pairingCode.replace(/-/g, ''));
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  }

  const statusMeta = {
    disconnected: { label: 'Disconnected', tone: 'text-slate-700' },
    connecting: { label: 'Connecting to WhatsApp', tone: 'text-amber-700' },
    awaiting_pairing: { label: 'Awaiting 8-Digit Pairing', tone: 'text-amber-700' },
    connected: { label: 'Connected & Online', tone: 'text-emerald-700' },
  }[botState.status];

  return (
    <div className="space-y-8">
      {/* Top Metric Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-slate-200 bg-white rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Socket State</div>
          <div className={`mt-1.5 text-lg font-semibold ${statusMeta.tone}`}>
            {statusMeta.label}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums truncate">
            {botState.connectedUser || (botState.sessionExists ? 'Saved MultiFileAuthState' : 'No saved session')}
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Gemini AI Engine</div>
          <div className="mt-1.5 text-lg font-semibold text-slate-900">
            {botState.geminiConfigured ? 'Ready' : 'API Key Missing'}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono">
            .ai &middot; .gemini (gemini-4-hydrogen)
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Group Anti-Link</div>
          <div className="mt-1.5 text-lg font-semibold text-slate-900 tabular-nums">
            {activeGroupCount} {activeGroupCount === 1 ? 'Group' : 'Groups'} Protected
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono">
            .antilink delete on
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Private Auto-Reply</div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className={`text-lg font-semibold ${botState.config.autoreply ? 'text-emerald-700' : 'text-slate-700'}`}>
              {botState.config.autoreply ? 'Active (ON)' : 'Standby (OFF)'}
            </span>
            <button
              type="button"
              onClick={async () => {
                setPairError(null);
                try {
                  await onToggleAutoreply(!botState.config.autoreply);
                } catch (err) {
                  setPairError((err as Error).message || 'Could not update auto-reply setting.');
                }
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                botState.config.autoreply
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {botState.config.autoreply ? 'Turn Off' : 'Turn On'}
            </button>
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono">
            .autoreply on / off
          </div>
        </div>
      </div>

      {/* Main Split: Pairing Code Workbench + Capabilities Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  WhatsApp 8-Digit Pairing Code Login
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Connect your WhatsApp account using Baileys <span className="font-mono text-xs text-slate-800">MultiFileAuthState</span> and phone-number pairing without QR scanning.
                </p>
              </div>
              <button
                type="button"
                onClick={onRefresh}
                className="p-2 text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer shrink-0"
                title="Refresh status"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handlePairSubmit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="pairing-phone" className="block text-sm font-medium text-slate-700">
                  WhatsApp Phone Number (Country code + number, digits only)
                </label>
                <div className="mt-2 flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Smartphone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="pairing-phone"
                      type="text"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="e.g. 8801712345678"
                      className="w-full pl-10 pr-4 py-2.5 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isPairing || botState.status === 'connected'}
                    className="px-4 py-2.5 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <KeyRound className="w-4 h-4" />
                    {isPairing ? 'Requesting Code...' : 'Generate Pairing Code'}
                  </button>
                </div>
              </div>
            </form>

            {(pairError || botState.lastError) && (
              <div className="mt-4 p-3.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                {pairError || botState.lastError}
              </div>
            )}

            {botState.pairingCode && (
              <div className="mt-6 p-5 rounded-xl border border-emerald-200 bg-emerald-50/60">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs font-medium text-emerald-800">
                      8-Digit Linking Code
                    </div>
                    <div className="mt-1 text-3xl font-mono font-semibold tracking-widest text-slate-900 tabular-nums">
                      {botState.pairingCode}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyPairingCode}
                    className="px-3.5 py-2 text-xs font-medium bg-white text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCode ? 'Copied' : 'Copy Code'}
                  </button>
                </div>
                <ol className="mt-4 text-xs text-slate-700 space-y-1 list-decimal list-inside">
                  <li>Open WhatsApp on your phone and tap <strong>Linked Devices</strong>.</li>
                  <li>Tap <strong>Link a Device</strong> and choose <strong>Link with phone number instead</strong>.</li>
                  <li>Enter the 8-digit code shown above before it expires.</li>
                </ol>
              </div>
            )}
          </div>

          <div className="mt-6 pt-5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              Session folder: <span className="font-mono text-slate-700">./auth_info_baileys</span>
            </div>
            <div className="flex items-center gap-2">
              {botState.status !== 'disconnected' && (
                <button
                  type="button"
                  onClick={onDisconnect}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              )}
              <button
                type="button"
                onClick={onResetSession}
                className="px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-slate-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Reset Session
              </button>
            </div>
          </div>
        </section>

        {/* Feature Summary & Quick Actions */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Core Bot Modules
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Prefix <span className="font-mono font-semibold text-slate-900">.</span> triggers commands across groups and private chats.
            </p>

            <div className="mt-5 divide-y divide-slate-200">
              <div className="py-3.5 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                    Gemini AI Chat
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    <span className="font-mono text-slate-800">.ai &lt;query&gt;</span> or <span className="font-mono text-slate-800">.gemini &lt;query&gt;</span> via <span className="font-mono">@google/genai</span>.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('simulator')}
                  className="text-xs font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Test AI
                </button>
              </div>

              <div className="py-3.5 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                    Group Anti-Link Shield
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    <span className="font-mono text-slate-800">.antilink delete on</span> instantly deletes links when bot is group admin.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('rules')}
                  className="text-xs font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Configure
                </button>
              </div>

              <div className="py-3.5 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    Bengali Private Inbox Assistant
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    <span className="font-mono text-slate-800">.autoreply on</span> replies politely in Bengali to private DMs only.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('rules')}
                  className="text-xs font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Inspect
                </button>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-5 border-t border-slate-200 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              Ready for Render Web Service deployment
            </span>
            <button
              type="button"
              onClick={() => onNavigate('source')}
              className="px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              View Bot Files
            </button>
          </div>
        </section>
      </div>

      {/* Live Event Log Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Recent Bot Activity</h2>
            <p className="text-xs text-slate-500">Live events from Baileys socket and Command Simulator</p>
          </div>
          <span className="text-xs font-mono text-slate-500 tabular-nums">
            {botState.logs.length} {botState.logs.length === 1 ? 'event' : 'events'}
          </span>
        </div>

        {botState.logs.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No events recorded yet. Test a command in the Simulator or pair a WhatsApp device.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-6">Time</th>
                  <th className="py-2.5 px-4">Module</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Summary</th>
                  <th className="py-2.5 px-6 text-right">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {botState.logs.slice(0, 12).map((entry) => {
                  const outcomeColor =
                    entry.outcome === 'success'
                      ? 'text-emerald-700'
                      : entry.outcome === 'blocked'
                        ? 'text-amber-700'
                        : entry.outcome === 'error'
                          ? 'text-red-700'
                          : 'text-slate-600';
                  return (
                    <tr key={entry.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2.5 px-6 text-xs font-mono text-slate-500 tabular-nums whitespace-nowrap">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="py-2.5 px-4 text-xs font-mono text-slate-700 whitespace-nowrap">
                        {entry.category}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-700 whitespace-nowrap">
                        {entry.actor}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-800 max-w-md truncate">
                        {entry.summary}
                      </td>
                      <td className={`py-2.5 px-6 text-xs font-medium text-right whitespace-nowrap ${outcomeColor}`}>
                        {entry.outcome}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
