import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Cloud,
  Code2,
  Inbox,
  LayoutDashboard,
  Lock,
  LogIn,
  LogOut,
  MessageSquare,
  Shield,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import { AssistantBrainPanel } from './components/AssistantBrainPanel';
import { ClientBotsPanel } from './components/ClientBotsPanel';
import { ClientPortalView } from './components/ClientPortalView';
import { CommandSimulator } from './components/CommandSimulator';
import { InboxMemoryPanel } from './components/InboxMemoryPanel';
import { LockScreen } from './components/LockScreen';
import { ModerationRules } from './components/ModerationRules';
import { PairingOverview } from './components/PairingOverview';
import { SecurityAntiBanPanel } from './components/SecurityAntiBanPanel';
import { SourceExplorer } from './components/SourceExplorer';
import {
  authFetch,
  clearStoredSession,
  getStoredSessionEmail,
  getStoredSessionToken,
} from './lib/api';
import {
  deleteCloudClientBot,
  deleteCloudDictionaryEntry,
  fetchAllCloudData,
  saveCloudClientBot,
  saveCloudDictionaryEntry,
  saveCloudSettings,
  signInWithGoogle,
  signOutFirebase,
  subscribeAuthState,
} from './lib/firebase';
import {
  BENGALI_AUTOREPLY_EXACT,
  type BotConfig,
  type BotStatusResponse,
  type DictionaryEntry,
  type NavSection,
} from './types';

const NAV_ITEMS: { id: NavSection; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Pairing & Status', icon: LayoutDashboard },
  { id: 'assistant', label: 'AI Brain & Dictionary', icon: BookOpen },
  { id: 'inbox', label: 'Notes & Chat Memory', icon: Inbox },
  { id: 'simulator', label: 'Command Simulator', icon: MessageSquare },
  { id: 'rules', label: 'Anti-Link & Auto-Reply', icon: Shield },
  { id: 'clients', label: 'Client Bots (Multi)', icon: Smartphone },
  { id: 'security', label: 'Security & Anti-Ban', icon: ShieldCheck },
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
    aiAssistantEnabled: true,
    autoreplyMessage: BENGALI_AUTOREPLY_EXACT,
    firstGreetingTemplate:
      'স্যার এই মুহূর্তে অফলাইনে বা ব্যস্ত আছেন—আমি ওনার পার্সোনাল অ্যাসিস্ট্যান্ট বলছি। স্যারের জন্য কোনো জরুরি বার্তা থাকলে আমাকে বলতে পারেন, অথবা চাইলে আমার সাথেও যেকোনো বিষয়ে কথা বলতে পারেন!',
    ownerName: 'Sir',
    ownerProfession: 'Software & Automation Developer',
    ownerLocation: 'Dhaka, Bangladesh',
    ownerBio:
      'স্যার একজন প্রযুক্তিপ্রেমী, দায়িত্বশীল এবং পেশাদার মানুষ। তিনি নিজের কাজ ও প্রজেক্ট নিয়ে বেশিরভাগ সময় ব্যস্ত থাকেন, তবে পরিচিতজন ও ক্লায়েন্টদের যথেষ্ট গুরুত্ব দেন।',
    ownerBoundaries:
      'স্যার বাসা/ফ্ল্যাট/রুম ভাড়া বা মেস খোঁজার কাজ করেন না। টাকা ধার দেওয়া, অজানা বিনিয়োগ বা অপ্রাসঙ্গিক ব্যক্তিগত অনুরোধ স্যার গ্রহণ করেন না—কেউ এসব চাইলে ভদ্রভাবে না করে দেবেন।',
    strictLogicRules:
      '১. যুক্তি ও বুদ্ধিমত্তা: অন্ধভাবে হ্যাঁ-তে হ্যাঁ মেলাবেন না। কেউ ভুল দাবি, অযৌক্তিক কথা বা মজা করলে চ্যাট মেমোরি ও বাস্তব যুক্তি দিয়ে বুদ্ধিদীপ্ত ও মধুরভাবে পাল্টা যুক্তি/তর্ক করুন।\n২. আবেগ ও হিউম্যান টাচ: মেসেজের পেছনের আসল অনুভূতি ধরে হুবহু মানুষের মতো হৃদয়গ্রাহী ও প্রাকৃতিক ভাষায় কথা বলুন।\n৩. পূর্ণ ইনবক্স ধারাবাহিকতা: শুধু শেষ মেসেজ নয়—পুরো ইনবক্স সামারি ও স্যার নিজে আগে কী বলেছিলেন তা ধরে কথা বলুন।\n৪. টাইম-ল্যাপস ও সময় জ্ঞান: বাংলাদেশ সময় ও শেষ মেসেজের সময়ের ব্যবধান বুঝে বাস্তবসম্মতভাবে প্রতিক্রিয়া দিন।',
    assistantTone: 'witty_flirty',
    cooldownMs: 0,
    takeoverPauseMs: 1800000,
    humanTypingEnabled: true,
    dailyReplyLimit: 120,
    antilinkGroups: {},
    groupAiEnabled: false,
    groupAiMode: 'smart_blend',
    groupReactionEnabled: true,
    groupCooldownMs: 6000,
    groupAiGroups: {},
    groupDirectives: {},
    configUpdatedAt: '',
  },
  logs: [],
};

export default function App() {
  const portalParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const portalBotId = portalParams?.get('portal')?.trim() || '';
  const portalAccessKey = portalParams?.get('access')?.trim() || '';

  const [unlockedEmail, setUnlockedEmail] = useState<string | null>(() =>
    getStoredSessionToken() ? getStoredSessionEmail() || 'ifxnoteedge81@gmail.com' : null
  );
  const [section, setSection] = useState<NavSection>('overview');
  const [botState, setBotState] = useState<BotStatusResponse>(DEFAULT_STATUS);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [cloudStatusMsg, setCloudStatusMsg] = useState<string | null>(null);

  const configMutationVersionRef = useRef(0);

  const handleLockDashboard = useCallback(() => {
    clearStoredSession();
    setUnlockedEmail(null);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setUnlockedEmail(null);
    };
    window.addEventListener('wanexus:unauthorized', onUnauthorized);
    return () => window.removeEventListener('wanexus:unauthorized', onUnauthorized);
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!getStoredSessionToken()) return;
    const startMutationVersion = configMutationVersionRef.current;
    try {
      const res = await authFetch('/api/bot/status');
      if (res.ok) {
        const data = (await res.json()) as BotStatusResponse;
        setBotState((prev) => {
          // Never let a stale status poll revert an in-flight or newer config save
          if (configMutationVersionRef.current !== startMutationVersion) {
            return {
              ...data,
              config: prev.config,
            };
          }
          const incomingTs = Date.parse(data.config?.configUpdatedAt || '') || 0;
          const prevTs = Date.parse(prev.config?.configUpdatedAt || '') || 0;
          if (prevTs > incomingTs && incomingTs > 0) {
            return {
              ...data,
              config: prev.config,
            };
          }
          return {
            ...data,
            config:
              JSON.stringify(prev.config) === JSON.stringify(data.config)
                ? prev.config
                : data.config,
          };
        });
      }
    } catch {
      // keep existing state on transient errors
    }
  }, []);

  useEffect(() => {
    if (!unlockedEmail) return;
    void fetchStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchStatus();
      }
    }, 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchStatus();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [unlockedEmail, fetchStatus]);

  // Listen for Firebase Google Sign-In and reconcile cloud data <-> server once unlocked
  useEffect(() => {
    const unsubscribe = subscribeAuthState(async (user) => {
      setFirebaseUser(user);
      if (user && unlockedEmail) {
        try {
          const cloudData = await fetchAllCloudData(user.uid);
          if (
            cloudData.settings ||
            cloudData.dictionary.length > 0 ||
            cloudData.memories.length > 0 ||
            cloudData.notes.length > 0
          ) {
            const syncRes = await authFetch('/api/cloud/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ownerId: user.uid, ...cloudData }),
            });
            if (syncRes.ok) {
              const syncJson = await syncRes.json().catch(() => ({}));
              const serverConfig = syncJson?.config as BotConfig | undefined;
              if (serverConfig) {
                configMutationVersionRef.current += 1;
                setBotState((prev) => ({ ...prev, config: serverConfig }));
                const serverTs = Date.parse(serverConfig.configUpdatedAt || '') || 0;
                const cloudTs = Date.parse(cloudData.settings?.configUpdatedAt || '') || 0;
                // Push newer server config back up to Firestore so cloud never stays stale
                if (serverTs > cloudTs) {
                  await saveCloudSettings(user.uid, serverConfig).catch(() => {});
                }
              }
            }
            await fetchStatus();
            setCloudStatusMsg('Firestore synced');
          } else {
            const liveRes = await authFetch('/api/bot/status');
            if (liveRes.ok) {
              const liveStatus = await liveRes.json();
              if (liveStatus?.config) {
                await saveCloudSettings(user.uid, liveStatus.config);
              }
            }
            setCloudStatusMsg('Firestore connected');
          }
        } catch (err) {
          setCloudStatusMsg((err as Error).message.slice(0, 80));
        }
      } else if (!user) {
        setCloudStatusMsg(null);
      }
    });
    return () => unsubscribe();
  }, [unlockedEmail, fetchStatus]);

  if (portalBotId && portalAccessKey) {
    return <ClientPortalView botId={portalBotId} accessKey={portalAccessKey} />;
  }

  if (!unlockedEmail) {
    return (
      <LockScreen
        onUnlocked={(email) => {
          setUnlockedEmail(email);
        }}
      />
    );
  }

  async function handlePair(phoneNumber: string) {
    const res = await authFetch('/api/bot/pair', {
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
    await authFetch('/api/bot/disconnect', { method: 'POST' });
    await fetchStatus();
  }

  async function handleResetSession() {
    await authFetch('/api/bot/reset-session', { method: 'POST' });
    await fetchStatus();
  }

  async function handleUpdateConfig(patch: Partial<BotConfig>) {
    configMutationVersionRef.current += 1;
    const optimisticTs = new Date().toISOString();
    setBotState((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        ...patch,
        configUpdatedAt: optimisticTs,
      },
    }));

    const res = await authFetch('/api/bot/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Revert back to authoritative server status if save failed
      await fetchStatus();
      throw new Error(data.error || 'Failed to save configuration to bot server.');
    }
    if (data.config) {
      configMutationVersionRef.current += 1;
      setBotState((prev) => ({ ...prev, config: data.config as BotConfig }));
      if (firebaseUser) {
        try {
          await saveCloudSettings(firebaseUser.uid, data.config as BotConfig);
          setCloudStatusMsg('Saved to Firestore');
        } catch (err) {
          setCloudStatusMsg((err as Error).message.slice(0, 80));
        }
      }
    }
  }

  async function handleSyncDictionaryEntry(entry: DictionaryEntry) {
    if (!firebaseUser) return;
    await saveCloudDictionaryEntry(firebaseUser.uid, entry);
  }

  async function handleDeleteDictionaryEntry(id: string) {
    if (!firebaseUser) return;
    await deleteCloudDictionaryEntry(id);
  }

  async function handleGoogleLogin() {
    setCloudStatusMsg(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setCloudStatusMsg((err as Error).message);
    }
  }

  const activeLabel = NAV_ITEMS.find((n) => n.id === section)?.label || 'Overview';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Sidebar Navigation */}
      <aside className="w-full lg:w-64 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col justify-between">
        <div>
          <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between">
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
                  className={`px-3 py-2.5 text-sm font-medium rounded-lg flex items-center justify-between gap-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-emerald-600/10 text-emerald-800'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-emerald-700' : 'text-slate-500'}`} />
                    {item.label}
                  </span>
                  {item.id === 'inbox' && (botState.unreadNotesCount || 0) > 0 && (
                    <span className="text-xs font-mono font-semibold text-emerald-700 tabular-nums">
                      {botState.unreadNotesCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Firebase Firestore Cloud Sync Footer */}
        <div className="p-4 border-t border-slate-200 space-y-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-slate-700">
            <Cloud className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span>Firebase Firestore</span>
          </div>

          {firebaseUser ? (
            <div className="space-y-2">
              <div className="text-slate-600 truncate" title={firebaseUser.email || ''}>
                {firebaseUser.email}
              </div>
              {cloudStatusMsg && (
                <div className="text-[11px] text-emerald-700 truncate">{cloudStatusMsg}</div>
              )}
              <button
                type="button"
                onClick={signOutFirebase}
                className="w-full px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out Cloud
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[11px] text-slate-500 leading-relaxed">
                Sign in with Google to sync Persona, 64-District Dictionary &amp; Memories to Firestore.
              </div>
              {cloudStatusMsg && (
                <div className="text-[11px] text-red-600 break-words">{cloudStatusMsg}</div>
              )}
              <button
                type="button"
                onClick={handleGoogleLogin}
                className="w-full px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                Connect Google Cloud
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 px-6 lg:px-8 bg-white border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="text-sm text-slate-500 truncate">
            <span>WaNexus</span>
            <span className="mx-2 text-slate-300">/</span>
            <span className="font-medium text-slate-900">{activeLabel}</span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {section !== 'simulator' ? (
              <button
                type="button"
                onClick={() => setSection('simulator')}
                className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Open Simulator
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSection('assistant')}
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Edit AI Persona
              </button>
            )}
            <button
              type="button"
              onClick={handleLockDashboard}
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              title="Lock Dashboard"
            >
              <Lock className="w-3.5 h-3.5" />
              Lock
            </button>
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

          {section === 'assistant' && (
            <AssistantBrainPanel
              config={botState.config}
              onUpdateConfig={handleUpdateConfig}
              onSyncDictionaryEntry={handleSyncDictionaryEntry}
              onDeleteDictionaryEntry={handleDeleteDictionaryEntry}
            />
          )}

          {section === 'inbox' && <InboxMemoryPanel />}

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

          {section === 'clients' && (
            <ClientBotsPanel
              onCloudSyncBot={
                firebaseUser ? (bot) => saveCloudClientBot(firebaseUser.uid, bot) : undefined
              }
              onCloudDeleteBot={
                firebaseUser ? (botId) => deleteCloudClientBot(botId) : undefined
              }
            />
          )}

          {section === 'security' && (
            <SecurityAntiBanPanel
              config={botState.config}
              onUpdateConfig={handleUpdateConfig}
              onLockNow={handleLockDashboard}
            />
          )}

          {section === 'source' && <SourceExplorer />}
        </main>
      </div>
    </div>
  );
}
