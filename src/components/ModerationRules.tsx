import { useEffect, useState } from 'react';
import { Check, MessageSquareText, Pencil, Plus, RefreshCw, RotateCcw, Search, ShieldAlert, Trash2, Users, X } from 'lucide-react';
import { authFetch } from '../lib/api';
import { BENGALI_AUTOREPLY_EXACT, type BotConfig, type GroupAiMode, type KnownGroupItem } from '../types';

interface ModerationRulesProps {
  config: BotConfig;
  onUpdateConfig: (patch: Partial<BotConfig>) => Promise<void>;
}

export function ModerationRules({ config, onUpdateConfig }: ModerationRulesProps) {
  const activeReplyText = config.autoreplyMessage || BENGALI_AUTOREPLY_EXACT;
  const [isEditingReply, setIsEditingReply] = useState(false);
  const [replyDraft, setReplyDraft] = useState(activeReplyText);
  const [isSavingReply, setIsSavingReply] = useState(false);

  const [newGroupJid, setNewGroupJid] = useState('');
  const [newAiGroupJid, setNewAiGroupJid] = useState('');
  const [knownGroups, setKnownGroups] = useState<KnownGroupItem[]>([]);
  const [groupsConnected, setGroupsConnected] = useState(false);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [linkProbeText, setLinkProbeText] = useState('Check this out: https://youtube.com/watch?v=dQw4w9WgXcQ or t.me/mychannel');
  const [probeResult, setProbeResult] = useState<{ hasLink: boolean; matches: string[] } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditingReply) {
      setReplyDraft(config.autoreplyMessage || BENGALI_AUTOREPLY_EXACT);
    }
  }, [config.autoreplyMessage, isEditingReply]);

  async function loadGroups() {
    setIsLoadingGroups(true);
    try {
      const res = await authFetch('/api/groups');
      if (res.ok) {
        const data = await res.json();
        setGroupsConnected(Boolean(data.connected));
        setKnownGroups(Array.isArray(data.groups) ? data.groups : []);
      }
    } catch {
      // ignore initial load error
    } finally {
      setIsLoadingGroups(false);
    }
  }

  useEffect(() => {
    void loadGroups();
  }, []);

  const groupEntries = Object.entries(config.antilinkGroups);
  const groupAiMap = config.groupAiGroups || {};

  async function safeUpdate(patch: Partial<BotConfig>): Promise<boolean> {
    setRuleError(null);
    try {
      await onUpdateConfig(patch);
      return true;
    } catch (err) {
      setRuleError((err as Error).message || 'Could not save rule changes.');
      return false;
    }
  }

  async function handleAddAiGroup(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = newAiGroupJid.trim();
    if (!cleaned) return;
    const formatted = cleaned.endsWith('@g.us') ? cleaned : `${cleaned}@g.us`;
    const ok = await safeUpdate({
      groupAiEnabled: true,
      groupAiGroups: {
        ...groupAiMap,
        [formatted]: true,
      },
    });
    if (ok) {
      setNewAiGroupJid('');
      void loadGroups();
    }
  }

  async function handleToggleAiGroup(jid: string, enabled: boolean) {
    const ok = await safeUpdate({
      ...(enabled ? { groupAiEnabled: true } : {}),
      groupAiGroups: {
        ...groupAiMap,
        [jid]: enabled,
      },
    });
    if (ok) {
      setKnownGroups((prev) =>
        prev.map((g) => (g.jid === jid ? { ...g, groupAiEnabled: enabled } : g))
      );
    }
  }

  async function handleRemoveAiGroup(jid: string) {
    const next = { ...groupAiMap };
    delete next[jid];
    await safeUpdate({ groupAiGroups: next });
    void loadGroups();
  }

  async function handleSaveReply(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = replyDraft.trim();
    if (!cleaned) return;
    setIsSavingReply(true);
    try {
      const ok = await safeUpdate({ autoreplyMessage: cleaned });
      if (ok) {
        setIsEditingReply(false);
      }
    } finally {
      setIsSavingReply(false);
    }
  }

  async function handleResetReply() {
    setIsSavingReply(true);
    try {
      const ok = await safeUpdate({ autoreplyMessage: BENGALI_AUTOREPLY_EXACT });
      if (ok) {
        setReplyDraft(BENGALI_AUTOREPLY_EXACT);
        setIsEditingReply(false);
      }
    } finally {
      setIsSavingReply(false);
    }
  }

  async function handleAddGroup(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = newGroupJid.trim();
    if (!cleaned) return;
    const formatted = cleaned.endsWith('@g.us') ? cleaned : `${cleaned}@g.us`;
    const ok = await safeUpdate({
      antilinkGroups: {
        ...config.antilinkGroups,
        [formatted]: true,
      },
    });
    if (ok) {
      setNewGroupJid('');
    }
  }

  async function handleToggleGroup(jid: string, enabled: boolean) {
    await safeUpdate({
      antilinkGroups: {
        ...config.antilinkGroups,
        [jid]: enabled,
      },
    });
  }

  async function handleRemoveGroup(jid: string) {
    const next = { ...config.antilinkGroups };
    delete next[jid];
    await safeUpdate({ antilinkGroups: next });
  }

  async function handleTestLink(e: React.FormEvent) {
    e.preventDefault();
    setRuleError(null);
    setIsTesting(true);
    try {
      const res = await authFetch('/api/antilink/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: linkProbeText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRuleError(data.error || 'Could not test message links.');
        return;
      }
      setProbeResult(data);
    } catch (err) {
      setRuleError((err as Error).message || 'Could not test message links.');
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div className="space-y-8">
      {ruleError && (
        <div className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
          {ruleError}
        </div>
      )}
      {/* Private Bengali Auto-Reply Assistant */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Private Inbox Auto-Reply Assistant
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Controlled via <span className="font-mono text-slate-800">.autoreply on</span> and <span className="font-mono text-slate-800">.autoreply off</span>. Triggers strictly for incoming private DMs.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <select
              value={config.cooldownMs}
              onChange={(e) => void safeUpdate({ cooldownMs: Number(e.target.value) })}
              className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              aria-label="Cooldown interval"
            >
              <option value={0}>Instant (No Cooldown)</option>
              <option value={3000}>3s Cooldown</option>
              <option value={30000}>30s Cooldown</option>
              <option value={60000}>60s Cooldown</option>
              <option value={300000}>5m Cooldown</option>
            </select>

            <button
              type="button"
              onClick={() => void safeUpdate({ autoreply: !config.autoreply })}
              className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                config.autoreply
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.autoreply ? 'Auto-Reply: ON' : 'Auto-Reply: OFF'}
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-slate-500">
                Configured Auto-Reply Message
              </div>
              {!isEditingReply && (
                <div className="flex items-center gap-2">
                  {activeReplyText !== BENGALI_AUTOREPLY_EXACT && (
                    <button
                      type="button"
                      onClick={handleResetReply}
                      disabled={isSavingReply}
                      className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset Default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setReplyDraft(activeReplyText);
                      setIsEditingReply(true);
                    }}
                    className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit Message
                  </button>
                </div>
              )}
            </div>

            {isEditingReply ? (
              <form onSubmit={handleSaveReply} className="mt-2 space-y-3">
                <textarea
                  rows={4}
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  className="w-full p-3.5 rounded-lg border border-emerald-600 bg-white text-sm leading-relaxed text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
                  placeholder="Enter custom auto-reply message..."
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReplyDraft(activeReplyText);
                      setIsEditingReply(false);
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingReply || !replyDraft.trim()}
                    className="px-3.5 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {isSavingReply ? 'Saving...' : 'Save Message'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-2 p-4 rounded-lg border border-slate-200 bg-slate-50 text-sm leading-relaxed text-slate-900 whitespace-pre-wrap">
                {activeReplyText}
              </div>
            )}
          </div>

          <div className="lg:col-span-5">
            <div className="text-xs font-medium text-slate-500">
              Delivery Safeguards
            </div>
            <ul className="mt-2 divide-y divide-slate-200 border border-slate-200 rounded-lg text-xs text-slate-700">
              <li className="px-4 py-2.5 flex justify-between">
                <span>Private DMs (@s.whatsapp.net / @lid)</span>
                <span className="font-medium text-emerald-700">Allowed</span>
              </li>
              <li className="px-4 py-2.5 flex justify-between">
                <span>Group Chats (@g.us)</span>
                <span className="font-medium text-emerald-700">Separate Group Clone</span>
              </li>
              <li className="px-4 py-2.5 flex justify-between">
                <span>Own Messages &amp; Self-Chat</span>
                <span className="font-medium text-slate-500">Excluded</span>
              </li>
              <li className="px-4 py-2.5 flex justify-between">
                <span>Prefix Commands (.)</span>
                <span className="font-medium text-slate-500">Excluded</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Smart Group AI Clone ("আমার কপি") */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-600" />
              Smart Group AI Clone (গ্রুপে আপনার কপি)
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Reads all messages in enabled groups, observes quietly when needed, drops emoji reactions (<span className="font-mono">😂🔥💀</span>), playfully roasts/flirts/debates in first person as you—or toggle directly inside any group via <span className="font-mono text-slate-800">.groupai on</span>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => void safeUpdate({ groupReactionEnabled: !(config.groupReactionEnabled !== false) })}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                config.groupReactionEnabled !== false
                  ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Emoji Reactions: {config.groupReactionEnabled !== false ? 'ON' : 'OFF'}
            </button>

            <button
              type="button"
              onClick={() => void safeUpdate({ groupAiEnabled: !config.groupAiEnabled })}
              className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                config.groupAiEnabled
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.groupAiEnabled ? 'Group AI Clone: ON' : 'Group AI Clone: OFF'}
            </button>
          </div>
        </div>

        <div className="p-6 border-b border-slate-200 bg-slate-50/70 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-5">
            <label className="block text-xs font-medium text-slate-600">
              Group Clone Behavior Mode
            </label>
            <select
              value={config.groupAiMode || 'smart_blend'}
              onChange={(e) => void safeUpdate({ groupAiMode: e.target.value as GroupAiMode })}
              className="mt-1.5 w-full px-3.5 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            >
              <option value="smart_blend">Smart Human Blend (Observe + Emoji React + Roast/Flirt/Debate)</option>
              <option value="mention_only">Mention &amp; Reply Only (Observes all, replies when tagged/replied)</option>
              <option value="active_chat">Active Group Member (Participates in most messages)</option>
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-slate-600">
              Group Text Cooldown
            </label>
            <select
              value={config.groupCooldownMs ?? 6000}
              onChange={(e) => void safeUpdate({ groupCooldownMs: Number(e.target.value) })}
              className="mt-1.5 w-full px-3.5 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            >
              <option value={0}>Instant (No Cooldown)</option>
              <option value={3000}>3s Cooldown</option>
              <option value={6000}>6s Cooldown (Balanced)</option>
              <option value={15000}>15s Cooldown</option>
              <option value={30000}>30s Cooldown</option>
              <option value={60000}>60s Cooldown</option>
            </select>
          </div>

          <form onSubmit={handleAddAiGroup} className="md:col-span-4 flex gap-2">
            <input
              type="text"
              value={newAiGroupJid}
              onChange={(e) => setNewAiGroupJid(e.target.value)}
              placeholder="Group JID (e.g. 120363...@g.us)"
              className="flex-1 min-w-0 px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
            <button
              type="submit"
              className="px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </form>
        </div>

        <div className="px-6 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-600 flex items-center gap-2">
            <MessageSquareText className="w-3.5 h-3.5 text-slate-500" />
            <span>
              {groupsConnected
                ? `Showing participating WhatsApp groups (${knownGroups.length})`
                : `Configured / cached groups (${knownGroups.length}) — connect WhatsApp to auto-list all your groups`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void loadGroups()}
            disabled={isLoadingGroups}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingGroups ? 'animate-spin' : ''}`} />
            Refresh Groups
          </button>
        </div>

        {knownGroups.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No groups enabled yet. Send <span className="font-mono text-slate-800">.groupai on</span> inside any WhatsApp group, or add a Group JID above.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[320px]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-6">Group Name</th>
                  <th className="py-2.5 px-4">Group JID</th>
                  <th className="py-2.5 px-4">Clone Status</th>
                  <th className="py-2.5 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {knownGroups.map((grp) => {
                  const isActive = groupAiMap[grp.jid] ?? grp.groupAiEnabled;
                  return (
                    <tr key={grp.jid} className="hover:bg-slate-50/70">
                      <td className="py-3 px-6 font-medium text-slate-900">
                        {grp.name}
                        {grp.participantCount > 0 && (
                          <span className="ml-2 text-[11px] font-normal text-slate-500">
                            ({grp.participantCount} members)
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">{grp.jid}</td>
                      <td className="py-3 px-4 font-medium">
                        <span className={isActive ? 'text-emerald-700' : 'text-slate-500'}>
                          {isActive ? 'Clone Active' : 'Paused / Off'}
                        </span>
                      </td>
                      <td className="py-3 px-6 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleToggleAiGroup(grp.jid, !isActive)}
                            className={`px-2.5 py-1 text-xs font-medium border rounded-md cursor-pointer ${
                              isActive
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            {isActive ? 'Turn OFF' : 'Turn ON'}
                          </button>
                          {grp.jid in groupAiMap && (
                            <button
                              type="button"
                              onClick={() => void handleRemoveAiGroup(grp.jid)}
                              className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                              title="Remove from Group AI list"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Group Anti-Link Protection */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-6 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-900">
              Group Anti-Link Delete Rules
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Groups enabled via <span className="font-mono text-slate-800">.antilink delete on</span> automatically remove messages containing links when the bot is group admin.
            </p>

            <form onSubmit={handleAddGroup} className="mt-4 flex gap-3">
              <input
                type="text"
                value={newGroupJid}
                onChange={(e) => setNewGroupJid(e.target.value)}
                placeholder="Add Group JID (e.g. 120363041928374655@g.us)"
                className="flex-1 px-3.5 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add Group
              </button>
            </form>
          </div>

          {groupEntries.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              No groups configured. Run <span className="font-mono text-slate-800">.antilink delete on</span> inside any WhatsApp group or add a Group JID above.
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-6">Group JID</th>
                  <th className="py-2.5 px-4">Protection Mode</th>
                  <th className="py-2.5 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {groupEntries.map(([jid, enabled]) => (
                  <tr key={jid} className="hover:bg-slate-50/70">
                    <td className="py-3 px-6 font-mono text-xs text-slate-800">{jid}</td>
                    <td className="py-3 px-4 text-xs font-medium">
                      <span className={enabled ? 'text-emerald-700' : 'text-slate-500'}>
                        {enabled ? 'Delete ON' : 'Delete OFF'}
                      </span>
                    </td>
                    <td className="py-3 px-6 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleGroup(jid, !enabled)}
                          className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded-md hover:bg-slate-100 text-slate-700 cursor-pointer"
                        >
                          {enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveGroup(jid)}
                          className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                          title="Remove group"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Link Pattern Tester */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-slate-700" />
            <h3 className="text-base font-semibold text-slate-900">Link Detector Inspector</h3>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Test any sample message against the regex engine used in <span className="font-mono text-slate-800">index.js</span> (<span className="font-mono">http://</span>, <span className="font-mono">https://</span>, <span className="font-mono">www.</span>, <span className="font-mono">t.me</span>, <span className="font-mono">youtube.com</span>, <span className="font-mono">facebook.com</span>).
          </p>

          <form onSubmit={handleTestLink} className="mt-4 space-y-3">
            <textarea
              rows={3}
              value={linkProbeText}
              onChange={(e) => setLinkProbeText(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
            <button
              type="submit"
              disabled={isTesting}
              className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              {isTesting ? 'Scanning...' : 'Scan Message for Links'}
            </button>
          </form>

          {probeResult && (
            <div className="mt-4 p-4 rounded-lg border border-slate-200 bg-slate-50 text-xs space-y-2">
              <div className="font-medium text-slate-900">
                Result:{' '}
                <span className={probeResult.hasLink ? 'text-red-700' : 'text-emerald-700'}>
                  {probeResult.hasLink ? 'Link Detected — Would Be Deleted' : 'Clean Message — Allowed'}
                </span>
              </div>
              {probeResult.matches.length > 0 && (
                <div className="font-mono text-slate-700 break-all">
                  Matched: {probeResult.matches.join(', ')}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
