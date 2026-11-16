import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, RefreshCw, Search, Shield, Smartphone } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { ClientBotItem, ClientKnownGroup } from '../types';
import { ClientBotControlsEditor } from './ClientBotControlsEditor';

interface ClientBotsPanelProps {
  onCloudSyncBot?: (bot: ClientBotItem) => Promise<void>;
  onCloudDeleteBot?: (botId: string) => Promise<void>;
}

export function ClientBotsPanel({ onCloudSyncBot, onCloudDeleteBot }: ClientBotsPanelProps) {
  const [bots, setBots] = useState<ClientBotItem[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [newSavedReply, setNewSavedReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedBotId, setCopiedBotId] = useState<string | null>(null);

  const fetchBots = useCallback(async () => {
    try {
      const res = await authFetch('/api/client-bots');
      if (res.ok) {
        const data = (await res.json()) as { bots: ClientBotItem[] };
        setBots(data.bots || []);
        setSelectedBotId((prev) => {
          if (prev && data.bots.some((b) => b.botId === prev)) return prev;
          return data.bots[0]?.botId || '';
        });
      }
    } catch {
      // ignore transient poll errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBots();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchBots();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchBots]);

  function replaceBotInState(updated: ClientBotItem) {
    setBots((prev) => prev.map((b) => (b.botId === updated.botId ? updated : b)));
    if (onCloudSyncBot) {
      void onCloudSyncBot(updated).catch(() => {});
    }
  }

  async function handleCreateBot(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newClientName.trim();
    if (!trimmed) return;
    setCreating(true);
    setErrorMsg(null);
    try {
      const res = await authFetch('/api/client-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: trimmed,
          moderateAllGroups: true,
          savedReplyEnabled: Boolean(newSavedReply.trim()),
          savedReplyMessage: newSavedReply.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create client bot slot.');
      const created = data.bot as ClientBotItem;
      setBots((prev) => [created, ...prev]);
      setSelectedBotId(created.botId);
      setNewClientName('');
      setNewSavedReply('');
      if (onCloudSyncBot) {
        void onCloudSyncBot(created).catch(() => {});
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyQuickLink(bot: ClientBotItem) {
    const url = `${window.location.origin}/?portal=${encodeURIComponent(bot.botId)}&access=${encodeURIComponent(bot.clientAccessKey)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedBotId(bot.botId);
      setTimeout(() => setCopiedBotId(null), 1800);
    } catch {
      // ignore
    }
  }

  const filteredBots = bots.filter((b) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      b.clientName.toLowerCase().includes(q) ||
      b.botId.toLowerCase().includes(q) ||
      (b.phoneNumber || '').includes(q)
    );
  });

  const selectedBot = bots.find((b) => b.botId === selectedBotId) || null;
  const activeCount = bots.filter((b) => b.active).length;
  const connectedCount = bots.filter((b) => b.status === 'connected').length;
  const totalModerated = bots.reduce((sum, b) => sum + b.stats.deletedCount + b.stats.warnedCount, 0);

  return (
    <div className="space-y-6">
      {/* Top Overview & RAM Capacity Guide */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Multi-Number Client Bots (Zero-AI Engine)
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Unlimited client slots with 0 Gemini/OpenRouter usage. Complete isolation from your private AI Brain.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchBots()}
            className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh Slots
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-3 border-t border-slate-100 text-xs">
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="text-slate-500">Total Client Slots</div>
            <div className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">{bots.length}</div>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="text-slate-500">Active / Connected</div>
            <div className="text-lg font-bold text-emerald-700 tabular-nums mt-0.5">
              {activeCount} / {connectedCount}
            </div>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="text-slate-500">Total Moderated Actions</div>
            <div className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">{totalModerated}</div>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="text-slate-500">Server Capacity Guide</div>
            <div className="text-xs font-semibold text-slate-800 mt-1">
              512MB RAM: 3–5 live · Unlimited on RAM upgrade
            </div>
          </div>
        </div>
      </div>

      {/* Create New Client Bot Slot */}
      <form
        onSubmit={handleCreateBot}
        className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Plus className="w-4 h-4 text-emerald-600" />
          Add New Client Bot Slot (Unlimited)
        </div>
        {errorMsg && (
          <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {errorMsg}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="text"
            required
            value={newClientName}
            onChange={(e) => setNewClientName(e.target.value)}
            placeholder="Client / Business Name (e.g. Dhaka Buy-Sell Group)"
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
          />
          <input
            type="text"
            value={newSavedReply}
            onChange={(e) => setNewSavedReply(e.target.value)}
            placeholder="Optional initial Saved DM SMS"
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
          />
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            {creating ? 'Creating Slot...' : 'Create Client Bot Slot'}
          </button>
        </div>
      </form>

      {/* Split Master-Detail Control Plane */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
          Loading client bot slots...
        </div>
      ) : bots.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <Smartphone className="w-7 h-7 text-slate-400 mx-auto" />
          <div className="text-sm font-semibold text-slate-900">No client bot slots created yet</div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Create a client slot above to pair their WhatsApp number, customize group rules (links, stickers, media, warning limits), or share a scoped Client Portal Link.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Master List */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-3 border-b border-slate-200">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search client or phone..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                />
              </div>
            </div>

            <div className="divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
              {filteredBots.map((bot) => {
                const isSelected = bot.botId === selectedBotId;
                return (
                  <div
                    key={bot.botId}
                    onClick={() => setSelectedBotId(bot.botId)}
                    className={`p-3.5 cursor-pointer transition-colors ${
                      isSelected ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">
                          {bot.clientName}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 truncate mt-0.5 tabular-nums">
                          {bot.phoneNumber ? `+${bot.phoneNumber}` : 'Unpaired'} ·{' '}
                          <span
                            className={
                              bot.status === 'connected'
                                ? 'text-emerald-700 font-semibold'
                                : bot.status === 'suspended'
                                ? 'text-red-700 font-semibold'
                                : 'text-slate-600'
                            }
                          >
                            {bot.status}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleCopyQuickLink(bot);
                        }}
                        className="px-2 py-1 text-[11px] font-medium bg-white border border-slate-200 rounded-md hover:bg-slate-100 text-slate-700 flex items-center gap-1 shrink-0 cursor-pointer"
                        title="Copy Client Self-Service Portal Link"
                      >
                        <Copy className="w-3 h-3" />
                        {copiedBotId === bot.botId ? 'Copied' : 'Link'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Detail Editor */}
          <div className="lg:col-span-8">
            {selectedBot ? (
              <ClientBotControlsEditor
                bot={selectedBot}
                mode="owner"
                onUpdate={async (patch) => {
                  const res = await authFetch(`/api/client-bots/${encodeURIComponent(selectedBot.botId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Update failed.');
                  replaceBotInState(data.bot as ClientBotItem);
                }}
                onPair={async (phoneNumber) => {
                  const res = await authFetch(
                    `/api/client-bots/${encodeURIComponent(selectedBot.botId)}/pair`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ phoneNumber }),
                    }
                  );
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Pairing failed.');
                  replaceBotInState(data.bot as ClientBotItem);
                }}
                onDisconnect={async () => {
                  const res = await authFetch(
                    `/api/client-bots/${encodeURIComponent(selectedBot.botId)}/disconnect`,
                    { method: 'POST' }
                  );
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Disconnect failed.');
                  replaceBotInState(data.bot as ClientBotItem);
                }}
                onResetSession={async () => {
                  const res = await authFetch(
                    `/api/client-bots/${encodeURIComponent(selectedBot.botId)}/reset-session`,
                    { method: 'POST' }
                  );
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Reset failed.');
                  replaceBotInState(data.bot as ClientBotItem);
                }}
                onFetchGroups={async () => {
                  const res = await authFetch(
                    `/api/client-bots/${encodeURIComponent(selectedBot.botId)}/groups`
                  );
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Failed to load groups.');
                  return (data.groups || []) as ClientKnownGroup[];
                }}
                onResetWarnings={async (groupJid, userKey) => {
                  const res = await authFetch(
                    `/api/client-bots/${encodeURIComponent(selectedBot.botId)}/groups/${encodeURIComponent(
                      groupJid
                    )}/reset-warnings`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ userKey }),
                    }
                  );
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Failed to reset warnings.');
                  replaceBotInState(data.bot as ClientBotItem);
                }}
                onRotateKey={async () => {
                  const res = await authFetch(
                    `/api/client-bots/${encodeURIComponent(selectedBot.botId)}/rotate-key`,
                    { method: 'POST' }
                  );
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Key rotation failed.');
                  replaceBotInState(data.bot as ClientBotItem);
                }}
                onDeleteBot={async () => {
                  const deletedId = selectedBot.botId;
                  const res = await authFetch(`/api/client-bots/${encodeURIComponent(deletedId)}`, {
                    method: 'DELETE',
                  });
                  if (!res.ok) throw new Error('Delete failed.');
                  setBots((prev) => {
                    const next = prev.filter((b) => b.botId !== deletedId);
                    setSelectedBotId(next[0]?.botId || '');
                    return next;
                  });
                  if (onCloudDeleteBot) {
                    void onCloudDeleteBot(deletedId).catch(() => {});
                  }
                }}
              />
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
                <Shield className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                Select a client bot slot from the left to manage pairing, moderation, and saved SMS.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
