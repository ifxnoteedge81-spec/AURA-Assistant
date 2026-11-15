import { useCallback, useEffect, useState } from 'react';
import { Code2, LayoutDashboard, MessageSquare, Shield } from 'lucide-react';
import { CommandSimulator } from './components/CommandSimulator';
import { ModerationRules } from './components/ModerationRules';
import { PairingOverview } from './components/PairingOverview';
import { SourceExplorer } from './components/SourceExplorer';
import type { BotConfig, BotStatusResponse, NavSection } from './types';

const NAV_ITEMS: { id: NavSection; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Pairing & Status', icon: LayoutDashboard },
  { id: 'simulator', label: 'Command Simulator', icon: MessageSquare },
  { id: 'rules', label: 'Anti-Link & Auto-Reply', icon: Shield },
  { id: 'source', label: 'Render Source Code', icon: Code2 },
];

const DEFAULT_STATUS: BotStatusResponse = {
  status: 'disconnected',
  connectedUser: null,
  pairingCode: null,
  pairingPhone: null,
  sessionExists: false,
  lastError: null,
  geminiConfigured: true,
  config: {
    autoreply: false,
    cooldownMs: 60_000,
    antilinkGroups: {},
  },
  logs: [],
};

export default function App() {
  const [section, setSection] = useState<NavSection>('overview');
  const [botState, setBotState] = useState<BotStatusResponse>(DEFAULT_STATUS);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/status');
      if (res.ok) {
        const data = (await res.json()) as BotStatusResponse;
        setBotState(data);
      }
    } catch {
      // keep existing state on transient network errors
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 5000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  async function handlePair(phoneNumber: string) {
    const res = await fetch('/api/bot/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to generate pairing code.');
    }
    await fetchStatus();
  }

  async function handleDisconnect() {
    await fetch('/api/bot/disconnect', { method: 'POST' });
    await fetchStatus();
  }

  async function handleResetSession() {
    await fetch('/api/bot/reset-session', { method: 'POST' });
    await fetchStatus();
  }

  async function handleUpdateConfig(patch: Partial<BotConfig>) {
    await fetch('/api/bot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await fetchStatus();
  }

  const activeLabel = NAV_ITEMS.find((n) => n.id === section)?.label || 'Overview';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Sidebar Navigation (240px on desktop) */}
      <aside className="w-full lg:w-60 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col justify-between">
        <div>
          <div className="h-16 px-5 border-b border-slate-200 flex items-center">
            <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
              WaNexus Studio
            </span>
          </div>

          <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`px-3 py-2.5 text-sm font-medium rounded-lg flex items-center gap-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-emerald-600/10 text-emerald-800'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-emerald-700' : 'text-slate-500'}`} />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="hidden lg:block p-4 border-t border-slate-200 text-xs text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">Baileys + Gemini Bot</div>
          <div className="font-mono">Prefix: . &middot; MultiFileAuth</div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumbs left, 1 primary action right */}
        <header className="h-16 px-6 lg:px-8 bg-white border-b border-slate-200 flex items-center justify-between gap-8">
          <div className="text-sm text-slate-500 truncate">
            <span>WaNexus</span>
            <span className="mx-2 text-slate-300">/</span>
            <span className="font-medium text-slate-900">{activeLabel}</span>
          </div>

          <div className="shrink-0">
            {section !== 'source' ? (
              <button
                type="button"
                onClick={() => setSection('source')}
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Export Bot Code
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSection('simulator')}
                className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Open Simulator
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8 max-w-[1280px] w-full mx-auto">
          {section === 'overview' && (
            <PairingOverview
              botState={botState}
              onRefresh={fetchStatus}
              onPair={handlePair}
              onDisconnect={handleDisconnect}
              onResetSession={handleResetSession}
              onToggleAutoreply={(enabled) => handleUpdateConfig({ autoreply: enabled })}
              onNavigate={(target) => setSection(target)}
            />
          )}

          {section === 'simulator' && (
            <CommandSimulator
              config={botState.config}
              onConfigUpdated={fetchStatus}
            />
          )}

          {section === 'rules' && (
            <ModerationRules
              config={botState.config}
              onUpdateConfig={handleUpdateConfig}
            />
          )}

          {section === 'source' && <SourceExplorer />}
        </main>
      </div>
    </div>
  );
}
