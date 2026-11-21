import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Database,
  Play,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  Wrench,
} from 'lucide-react';
import { authFetch } from '../lib/api';
import {
  getLocalDeviceInfo,
  pollAndRunNextOffloadJob,
  sendMobileOffloadHeartbeat,
} from '../lib/mobileOffloadWorker';
import type {
  AgentRunRecord,
  AgentScheduleItem,
  FirestoreAdminDiagnostics,
  MobileOffloadStatusSnapshot,
  WatchdogStatusSnapshot,
} from '../types';

interface AutonomousAgentPanelProps {
  mobileOffloadEnabled: boolean;
  onToggleMobileOffload: (enabled: boolean) => void;
}

const PRESET_MISSIONS = [
  {
    label: 'Research & Verify Dhaka Leads',
    goal: 'Dhaka IT software agency contact email ও phone খুঁজে বের করে WhatsApp নাম্বারগুলো ভেরিফাই করো এবং সারসংক্ষেপ জানাও।',
  },
  {
    label: 'Inbox Urgent Briefing',
    goal: 'সিস্টেম ইনবক্সের সব আনরিড নোট ও রিসেন্ট চ্যাট পড়ে আমাকে একটি পরিষ্কার বাংলা এক্সিকিউটিভ রিপোর্ট দাও।',
  },
  {
    label: '5-Min System Self-Heal',
    goal: 'সিস্টেম সেলফ হিল চালিয়ে RAM, WhatsApp সকেট ও ফায়ারবেস কানেকশন চেক করে রিপোর্ট দাও।',
  },
];

export const AutonomousAgentPanel: React.FC<AutonomousAgentPanelProps> = ({
  mobileOffloadEnabled,
  onToggleMobileOffload,
}) => {
  const [goalInput, setGoalInput] = useState('');
  const [runningMission, setRunningMission] = useState(false);
  const [healingNow, setHealingNow] = useState(false);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [schedules, setSchedules] = useState<AgentScheduleItem[]>([]);
  const [watchdog, setWatchdog] = useState<WatchdogStatusSnapshot | null>(null);
  const [firestoreDiag, setFirestoreDiag] = useState<FirestoreAdminDiagnostics | null>(null);
  const [offloadStatus, setOffloadStatus] = useState<MobileOffloadStatusSnapshot | null>(null);
  const [healthInfo, setHealthInfo] = useState<{
    memoryMb?: number;
    selfPing?: { enabled: boolean; intervalMs: number; targetUrl: string; lastPingAt: string | null; lastPingOk: boolean | null };
  } | null>(null);

  // Schedule form state
  const [schedTitle, setSchedTitle] = useState('');
  const [schedGoal, setSchedGoal] = useState('');
  const [schedMinutes, setSchedMinutes] = useState(60);
  const [testOffloadUrl, setTestOffloadUrl] = useState('https://example.com');
  const [testingOffload, setTestingOffload] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const localDevice = getLocalDeviceInfo();

  const loadState = useCallback(async () => {
    try {
      const [agentRes, offloadRes, healthRes] = await Promise.all([
        authFetch('/api/agent/state'),
        authFetch('/api/offload/status'),
        fetch('/health'),
      ]);
      if (agentRes.ok) {
        const data = await agentRes.json();
        setRuns(Array.isArray(data.runs) ? data.runs : []);
        setSchedules(Array.isArray(data.schedules) ? data.schedules : []);
        setWatchdog(data.watchdog || null);
        setFirestoreDiag(data.firestoreDiagnostics || null);
      }
      if (offloadRes.ok) {
        setOffloadStatus(await offloadRes.json());
      }
      if (healthRes.ok) {
        setHealthInfo(await healthRes.json());
      }
    } catch {
      // keep existing UI state on transient poll failure
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadState();
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [loadState]);

  async function handleRunMission(customGoal?: string) {
    const goal = (customGoal ?? goalInput).trim();
    if (!goal || runningMission) return;
    setRunningMission(true);
    setNotice(null);
    try {
      const res = await authFetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error || 'Agent mission failed.');
      } else if (data.queuedBackground) {
        if (!customGoal) setGoalInput('');
        setNotice('Mission started on Netlify 15-min Background Worker — live results will update automatically.');
        await loadState();
      } else if (data.run?.status === 'failed') {
        setNotice(data.run?.error || data.run?.finalReport || 'Agent mission failed.');
        await loadState();
      } else {
        if (!customGoal) setGoalInput('');
        setNotice(`Mission finished (${data.run?.providerUsed}, ${data.run?.steps?.length || 0} steps).`);
        await loadState();
      }
    } finally {
      setRunningMission(false);
    }
  }

  async function handleHealNow() {
    setHealingNow(true);
    setNotice(null);
    try {
      const res = await authFetch('/api/watchdog/heal-now', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setWatchdog(data.status || null);
        setNotice(`Self-Heal completed: RSS ${data.event?.rssBeforeMb}MB -> ${data.event?.rssAfterMb}MB`);
        await loadState();
      }
    } finally {
      setHealingNow(false);
    }
  }

  async function handleCreateSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!schedGoal.trim()) return;
    const res = await authFetch('/api/agent/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: schedTitle.trim() || schedGoal.trim().slice(0, 36),
        goal: schedGoal.trim(),
        intervalMinutes: schedMinutes,
        notifySelfChat: true,
      }),
    });
    if (res.ok) {
      setSchedTitle('');
      setSchedGoal('');
      setNotice('Autonomous recurring mission scheduled.');
      await loadState();
    }
  }

  async function handleToggleSchedule(id: string) {
    await authFetch(`/api/agent/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST' });
    await loadState();
  }

  async function handleDeleteSchedule(id: string) {
    await authFetch(`/api/agent/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadState();
  }

  async function handleTestPhoneOffload() {
    if (!testOffloadUrl.trim()) return;
    setTestingOffload(true);
    setNotice(null);
    try {
      if (!mobileOffloadEnabled) {
        onToggleMobileOffload(true);
      }
      await sendMobileOffloadHeartbeat();
      await authFetch('/api/offload/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'scrape_url',
          payload: { url: testOffloadUrl.trim(), topic: 'Phone PWA Offload' },
        }),
      });
      const processed = await pollAndRunNextOffloadJob();
      setNotice(
        processed
          ? 'Phone PWA browser successfully extracted URL data using mobile RAM & data!'
          : 'Offload job queued for active mobile worker.'
      );
      await loadState();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setTestingOffload(false);
    }
  }

  return (
    <div className="space-y-6">
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 flex items-center justify-between">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs font-medium text-emerald-700 hover:underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top Row: 24/7 Self-Ping + 5m Self-Healing Watchdog + Firestore Project Check */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-emerald-600" />
              24/7 Forever Self-Ping
            </span>
            <span className="text-xs font-semibold text-emerald-700">
              {healthInfo?.selfPing?.enabled ? 'ACTIVE' : 'PAUSED'}
            </span>
          </div>
          <div className="text-sm font-medium text-slate-900 truncate" title={healthInfo?.selfPing?.targetUrl || ''}>
            {healthInfo?.selfPing?.targetUrl || '/health'}
          </div>
          <div className="text-xs text-slate-500">
            Every {Math.round((healthInfo?.selfPing?.intervalMs || 240000) / 60000)}m · RAM:{' '}
            <span className="font-mono font-semibold text-slate-800">{healthInfo?.memoryMb ?? '—'} MB</span> / 512 MB
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-emerald-600" />
              5-Min Self-Healing Watchdog
            </span>
            <button
              type="button"
              onClick={handleHealNow}
              disabled={healingNow}
              className="text-xs font-medium px-2.5 py-1 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
            >
              {healingNow ? 'Healing...' : 'Heal Now'}
            </button>
          </div>
          <div className="text-sm font-medium text-slate-900">
            Cycles: <span className="font-mono">{watchdog?.cycleCount ?? 0}</span> · Auto-Heals:{' '}
            <span className="font-mono">{watchdog?.totalHealsApplied ?? 0}</span>
          </div>
          <div className="text-xs text-slate-500">
            Crash Guards Caught: {watchdog?.processErrorsIntercepted ?? 0} · Auto-recovers WhatsApp &amp; RAM
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-emerald-600" />
              Firebase Admin Project Match
            </span>
            <span
              className={`text-xs font-semibold ${
                firestoreDiag?.projectMatch === false ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              {firestoreDiag?.projectMatch === true
                ? 'MATCHED'
                : firestoreDiag?.projectMatch === false
                  ? 'MISMATCH'
                  : firestoreDiag?.mode?.toUpperCase() || 'LOCAL'}
            </span>
          </div>
          <div className="text-xs text-slate-700 font-mono truncate">
            DB Project: {firestoreDiag?.configuredProjectId || '—'}
          </div>
          <div className="text-xs text-slate-500">
            {firestoreDiag?.projectMatch === false
              ? `Server key belongs to ${firestoreDiag.serviceAccountProjectId}. Replace with ${firestoreDiag.configuredProjectId} key.`
              : firestoreDiag?.hasServiceAccountEnv
                ? `Service Account verified (${firestoreDiag.mode}).`
                : 'Add FIREBASE_SERVICE_ACCOUNT_JSON in Hugging Face / Cloud Secrets for background Admin sync.'}
          </div>
        </div>
      </div>

      {/* Autonomous Action Agent ("Brain + Hands & Feet") */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Bot className="w-5 h-5 text-emerald-600" />
              Autonomous Action Agent (Gemini Pool + OpenRouter Brain)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Executes multi-step workflows across Web Search, Jina/Mobile Browser URL Reading, Lead Verification, WhatsApp, Email &amp; Groups. Also callable from WhatsApp Self-Chat with <span className="font-mono font-medium">এজেন্ট ...</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadState()}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESET_MISSIONS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => void handleRunMission(p.goal)}
              disabled={runningMission}
              className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5">
          <textarea
            rows={2}
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            placeholder='উদাহরণ: "Dhaka ecommerce agency খুঁজে ইমেইল ও নাম্বার কালেক্ট করো, WhatsApp ভেরিফাই করে আমাকে রিপোর্ট দাও"'
            className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
          />
          <button
            type="button"
            onClick={() => void handleRunMission()}
            disabled={runningMission || !goalInput.trim()}
            className="px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2 shrink-0 cursor-pointer"
          >
            <Play className="w-4 h-4" />
            {runningMission ? 'Executing Agent...' : 'Run Mission'}
          </button>
        </div>

        {runs.length > 0 && (
          <div className="space-y-3 pt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Recent Autonomous Executions ({runs.length})
            </div>
            <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
              {runs.slice(0, 6).map((run) => (
                <div key={run.id} className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/70 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900">
                      [{run.source}] {run.goal}
                    </span>
                    <span className="text-[11px] font-mono text-slate-600">
                      {run.providerUsed} · {run.steps.length} steps · {run.tokensUsed} tok ·{' '}
                      <strong className={run.status === 'completed' ? 'text-emerald-700' : 'text-amber-700'}>
                        {run.status}
                      </strong>
                    </span>
                  </div>
                  {run.steps.length > 0 && (
                    <div className="space-y-1 pl-2 border-l-2 border-emerald-500/40">
                      {run.steps.map((st) => (
                        <div key={`${run.id}-${st.stepNumber}`} className="text-xs text-slate-600">
                          <span className="font-mono font-semibold text-slate-800">{st.toolName}</span>: {st.resultSummary}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-slate-800 whitespace-pre-line bg-white border border-slate-200 rounded-md p-2.5">
                    {run.finalReport || run.error || 'Running...'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Split: Mobile Browser / PWA Offload Worker & Recurring Schedules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Mobile Browser / PWA Offload Worker */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-emerald-600" />
                Mobile Browser / PWA Offload Mode
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Offloads heavy webpage DOM fetching &amp; media canvas checks to this phone’s RAM &amp; mobile data so the cloud server stays ultra-light (512 MB safe).
              </p>
            </div>
            <button
              type="button"
              onClick={() => onToggleMobileOffload(!mobileOffloadEnabled)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition ${
                mobileOffloadEnabled
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
              }`}
            >
              {mobileOffloadEnabled ? 'Worker ON' : 'Worker OFF'}
            </button>
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-slate-900">
              <Cpu className="w-3.5 h-3.5 text-emerald-600" />
              This Device: {localDevice.deviceLabel}
            </div>
            <div>
              Device RAM: {localDevice.deviceMemoryGb ? `${localDevice.deviceMemoryGb} GB` : 'Browser Auto'} · Network:{' '}
              {localDevice.networkType}
            </div>
            <div>
              Connected Workers: <span className="font-semibold">{offloadStatus?.activeWorkers.length || 0}</span> · Completed Jobs:{' '}
              <span className="font-semibold">{offloadStatus?.completedCount || 0}</span>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              type="url"
              value={testOffloadUrl}
              onChange={(e) => setTestOffloadUrl(e.target.value)}
              placeholder="https://example.com"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
            />
            <button
              type="button"
              onClick={handleTestPhoneOffload}
              disabled={testingOffload}
              className="px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50 cursor-pointer shrink-0"
            >
              {testingOffload ? 'Running on Phone...' : 'Test Phone Offload'}
            </button>
          </div>
        </div>

        {/* Scheduled Autonomous Missions */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-emerald-600" />
              Autonomous Schedules (Auto Self-Chat Report)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Persisted to Firestore &amp; automatically executed even across Hugging Face / container restarts.
            </p>
          </div>

          <form onSubmit={handleCreateSchedule} className="space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                value={schedTitle}
                onChange={(e) => setSchedTitle(e.target.value)}
                placeholder="Task Title (e.g. Hourly Inbox)"
                className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <select
                value={schedMinutes}
                onChange={(e) => setSchedMinutes(Number(e.target.value))}
                className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs bg-white"
              >
                <option value={15}>Every 15 min</option>
                <option value={60}>Every 1 hour</option>
                <option value={360}>Every 6 hours</option>
                <option value={1440}>Every 24 hours</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={schedGoal}
                onChange={(e) => setSchedGoal(e.target.value)}
                placeholder="Mission Goal (e.g. আনরিড নোট চেক করে আমাকে জানাও)"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <button
                type="submit"
                className="px-3.5 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 flex items-center gap-1 cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </form>

          <div className="space-y-2 max-h-48 overflow-y-auto">
            {schedules.length === 0 ? (
              <div className="text-xs text-slate-500 py-3">No scheduled autonomous tasks yet.</div>
            ) : (
              schedules.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 truncate flex items-center gap-1.5">
                      <CheckCircle2 className={`w-3.5 h-3.5 ${s.enabled ? 'text-emerald-600' : 'text-slate-400'}`} />
                      {s.title} ({s.intervalMinutes}m)
                    </div>
                    <div className="text-slate-500 truncate">{s.goal}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleToggleSchedule(s.id)}
                      className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSchedule(s.id)}
                      className="p-1 rounded text-red-600 hover:bg-red-50 cursor-pointer"
                      title="Delete schedule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
