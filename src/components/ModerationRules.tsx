import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Target,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { authFetch } from '../lib/api';
import {
  BENGALI_AUTOREPLY_EXACT,
  type BotConfig,
  type BotStatusResponse,
  type GroupAiMode,
  type GroupDirectiveConfig,
  type GroupMemberTargetDirective,
  type KnownGroupItem,
  type KnownGroupMemberItem,
  type TokenTelemetrySnapshot,
} from '../types';

interface ModerationRulesProps {
  config: BotConfig;
  botStatus?: BotStatusResponse['status'];
  tokenTelemetry?: TokenTelemetrySnapshot;
  onUpdateConfig: (patch: Partial<BotConfig>) => Promise<void>;
}

const EMPTY_DIRECTIVE: GroupDirectiveConfig = {
  groupPrompt: '',
  targets: [],
};

export function ModerationRules({ config, botStatus, tokenTelemetry, onUpdateConfig }: ModerationRulesProps) {
  const activeReplyText = config.autoreplyMessage || BENGALI_AUTOREPLY_EXACT;
  const [isEditingReply, setIsEditingReply] = useState(false);
  const [replyDraft, setReplyDraft] = useState(activeReplyText);
  const [isSavingReply, setIsSavingReply] = useState(false);

  const [newGroupJid, setNewGroupJid] = useState('');
  const [newAiGroupJid, setNewAiGroupJid] = useState('');
  const [knownGroups, setKnownGroups] = useState<KnownGroupItem[]>([]);
  const [groupsConnected, setGroupsConnected] = useState(false);
  const [groupLoadError, setGroupLoadError] = useState<string | null>(null);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [linkProbeText, setLinkProbeText] = useState(
    'Check this out: https://youtube.com/watch?v=dQw4w9WgXcQ or t.me/mychannel'
  );
  const [probeResult, setProbeResult] = useState<{ hasLink: boolean; matches: string[] } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Per-Group AI Command Box & @Mention Target State
  const [expandedGroupJid, setExpandedGroupJid] = useState<string | null>(null);
  const [commandPromptDraft, setCommandPromptDraft] = useState('');
  const [isCommandDirty, setIsCommandDirty] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [selectedMemberKey, setSelectedMemberKey] = useState<string>('manual');
  const [manualMemberName, setManualMemberName] = useState('');
  const [manualMemberPhone, setManualMemberPhone] = useState('');
  const [targetObjectiveInput, setTargetObjectiveInput] = useState('');

  // Keep fresh refs so rapid clicks merge cleanly without stale closure rollbacks
  const groupAiMapRef = useRef<Record<string, boolean>>(config.groupAiGroups || {});
  const antilinkMapRef = useRef<Record<string, boolean>>(config.antilinkGroups || {});
  const directivesMapRef = useRef<Record<string, GroupDirectiveConfig>>(config.groupDirectives || {});

  useEffect(() => {
    groupAiMapRef.current = config.groupAiGroups || {};
  }, [config.groupAiGroups]);

  useEffect(() => {
    antilinkMapRef.current = config.antilinkGroups || {};
  }, [config.antilinkGroups]);

  useEffect(() => {
    directivesMapRef.current = config.groupDirectives || {};
  }, [config.groupDirectives]);

  useEffect(() => {
    if (!isEditingReply) {
      setReplyDraft(config.autoreplyMessage || BENGALI_AUTOREPLY_EXACT);
    }
  }, [config.autoreplyMessage, isEditingReply]);

  // Keep command box draft synced when switching group or when clean
  useEffect(() => {
    if (!expandedGroupJid) return;
    if (!isCommandDirty) {
      const saved = (config.groupDirectives || {})[expandedGroupJid];
      setCommandPromptDraft(saved?.groupPrompt || '');
    }
  }, [expandedGroupJid, config.groupDirectives, isCommandDirty]);

  function flashSaved(msg: string) {
    setSaveToast(msg);
    setTimeout(() => {
      setSaveToast((curr) => (curr === msg ? null : curr));
    }, 2600);
  }

  async function loadGroups() {
    setIsLoadingGroups(true);
    setGroupLoadError(null);
    try {
      const res = await authFetch('/api/groups');
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setGroupLoadError(errData.error || `Failed to refresh groups (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      setGroupsConnected(Boolean(data.connected));
      setKnownGroups(Array.isArray(data.groups) ? data.groups : []);
      if (data.liveFetchError) {
        setGroupLoadError(`Live WhatsApp sync note: ${data.liveFetchError}`);
      }
    } catch (err) {
      setGroupLoadError((err as Error).message || 'Network error while refreshing groups.');
    } finally {
      setIsLoadingGroups(false);
    }
  }

  useEffect(() => {
    void loadGroups();
  }, [botStatus]);

  const groupEntries = Object.entries(config.antilinkGroups || {});
  const groupAiMap = config.groupAiGroups || {};
  const directivesMap = config.groupDirectives || {};

  async function safeUpdate(
    patch: Partial<BotConfig>,
    key = 'global',
    successMessage?: string
  ): Promise<boolean> {
    setRuleError(null);
    setBusyKey(key);
    try {
      await onUpdateConfig(patch);
      if (successMessage) {
        flashSaved(successMessage);
      }
      return true;
    } catch (err) {
      setRuleError((err as Error).message || 'Could not save rule changes.');
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  function handleOpenCommandEditor(grp: KnownGroupItem) {
    if (expandedGroupJid === grp.jid) {
      setExpandedGroupJid(null);
      setShowMentionDropdown(false);
      return;
    }
    const existing = directivesMap[grp.jid] || EMPTY_DIRECTIVE;
    setExpandedGroupJid(grp.jid);
    setCommandPromptDraft(existing.groupPrompt || '');
    setIsCommandDirty(false);
    setShowMentionDropdown(false);
    setMentionFilter('');
    const firstMember = grp.members?.[0];
    setSelectedMemberKey(firstMember ? firstMember.jid : 'manual');
    setManualMemberName('');
    setManualMemberPhone('');
    setTargetObjectiveInput('');
  }

  function handleSelectMentionForPrompt(member: KnownGroupMemberItem) {
    const tag = `@${member.name}`;
    setCommandPromptDraft((prev) => {
      const trimmed = prev.replace(/@([^\s]*)$/, '');
      const spacer = trimmed && !trimmed.endsWith(' ') && !trimmed.endsWith('\n') ? ' ' : '';
      return `${trimmed}${spacer}${tag} `;
    });
    setIsCommandDirty(true);
    setShowMentionDropdown(false);
    setMentionFilter('');
    setSelectedMemberKey(member.jid);
  }

  function handleCommandPromptChange(val: string) {
    setCommandPromptDraft(val);
    setIsCommandDirty(true);
    const match = val.match(/@([^\s\n@]{0,24})$/);
    if (match) {
      setMentionFilter(match[1].toLowerCase());
      setShowMentionDropdown(true);
    } else {
      setShowMentionDropdown(false);
    }
  }

  async function saveDirectiveForGroup(
    groupJid: string,
    nextDirective: GroupDirectiveConfig,
    busyTag: string,
    toastMsg: string
  ): Promise<boolean> {
    const nextMap = { ...directivesMapRef.current };
    if (nextDirective.groupPrompt.trim() || nextDirective.targets.length > 0) {
      nextMap[groupJid] = nextDirective;
    } else {
      delete nextMap[groupJid];
    }
    directivesMapRef.current = nextMap;
    const ok = await safeUpdate({ groupDirectives: nextMap }, busyTag, toastMsg);
    if (ok) {
      setIsCommandDirty(false);
    }
    return ok;
  }

  async function handleSaveCommandBox(groupJid: string) {
    const current = directivesMapRef.current[groupJid] || EMPTY_DIRECTIVE;
    await saveDirectiveForGroup(
      groupJid,
      {
        groupPrompt: commandPromptDraft.trim(),
        targets: current.targets || [],
      },
      `cmd_${groupJid}`,
      'Group AI command box saved.'
    );
  }

  async function handleAddTargetDirective(grp: KnownGroupItem, e: React.FormEvent) {
    e.preventDefault();
    const objective = targetObjectiveInput.trim();
    if (!objective) {
      setRuleError('Please enter what the AI should convince or how it should handle this member.');
      return;
    }

    let targetJid = '';
    let targetPhone = '';
    let targetName = '';

    if (selectedMemberKey !== 'manual') {
      const picked = (grp.members || []).find((m) => m.jid === selectedMemberKey);
      if (picked) {
        targetJid = picked.jid;
        targetPhone = picked.phone;
        targetName = picked.name;
      }
    } else {
      targetName = manualMemberName.trim();
      targetPhone = manualMemberPhone.replace(/\D/g, '');
      targetJid = targetPhone ? `${targetPhone}@s.whatsapp.net` : '';
      if (!targetName && targetPhone) {
        targetName = `+${targetPhone}`;
      }
    }

    if (!targetName && !targetPhone && !targetJid) {
      setRuleError('Select a group member or enter a member name / WhatsApp number.');
      return;
    }

    const current = directivesMapRef.current[grp.jid] || EMPTY_DIRECTIVE;
    const newTarget: GroupMemberTargetDirective = {
      id: `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      targetJid,
      targetPhone,
      targetName,
      objective,
      enabled: true,
    };

    const ok = await saveDirectiveForGroup(
      grp.jid,
      {
        groupPrompt: isCommandDirty ? commandPromptDraft.trim() : current.groupPrompt,
        targets: [...(current.targets || []), newTarget],
      },
      `add_tgt_${grp.jid}`,
      `Added target mission for @${targetName}.`
    );

    if (ok) {
      setTargetObjectiveInput('');
      setManualMemberName('');
      setManualMemberPhone('');
    }
  }

  async function handleToggleTargetDirective(groupJid: string, targetId: string) {
    const current = directivesMapRef.current[groupJid] || EMPTY_DIRECTIVE;
    const nextTargets = (current.targets || []).map((t) =>
      t.id === targetId ? { ...t, enabled: !t.enabled } : t
    );
    await saveDirectiveForGroup(
      groupJid,
      { ...current, targets: nextTargets },
      `tgt_${targetId}`,
      'Updated member target status.'
    );
  }

  async function handleRemoveTargetDirective(groupJid: string, targetId: string) {
    const current = directivesMapRef.current[groupJid] || EMPTY_DIRECTIVE;
    const nextTargets = (current.targets || []).filter((t) => t.id !== targetId);
    await saveDirectiveForGroup(
      groupJid,
      { ...current, targets: nextTargets },
      `del_tgt_${targetId}`,
      'Removed member target mission.'
    );
  }

  async function handleAddAiGroup(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = newAiGroupJid.trim();
    if (!cleaned) return;
    const formatted = cleaned.endsWith('@g.us') ? cleaned : `${cleaned}@g.us`;
    const nextMap = { ...groupAiMapRef.current, [formatted]: true };
    groupAiMapRef.current = nextMap;
    const ok = await safeUpdate(
      {
        groupAiEnabled: true,
        groupAiGroups: nextMap,
      },
      'add_ai_group',
      'Added & enabled Group AI Clone.'
    );
    if (ok) {
      setNewAiGroupJid('');
      void loadGroups();
    }
  }

  async function handleToggleAiGroup(jid: string, enabled: boolean) {
    const nextMap = { ...groupAiMapRef.current, [jid]: enabled };
    groupAiMapRef.current = nextMap;
    const ok = await safeUpdate(
      {
        ...(enabled ? { groupAiEnabled: true } : {}),
        groupAiGroups: nextMap,
      },
      `toggle_ai_${jid}`,
      enabled ? 'Group AI Clone turned ON and saved.' : 'Group AI Clone turned OFF and saved.'
    );
    if (ok) {
      setKnownGroups((prev) =>
        prev.map((g) => (g.jid === jid ? { ...g, groupAiEnabled: enabled } : g))
      );
    }
  }

  async function handleRemoveAiGroup(jid: string) {
    const nextMap = { ...groupAiMapRef.current };
    delete nextMap[jid];
    groupAiMapRef.current = nextMap;
    await safeUpdate({ groupAiGroups: nextMap }, `rm_ai_${jid}`, 'Removed group override.');
    void loadGroups();
  }

  async function handleSaveReply(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = replyDraft.trim();
    if (!cleaned) return;
    setIsSavingReply(true);
    try {
      const ok = await safeUpdate(
        { autoreplyMessage: cleaned },
        'save_reply',
        'Auto-reply message saved.'
      );
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
      const ok = await safeUpdate(
        { autoreplyMessage: BENGALI_AUTOREPLY_EXACT },
        'reset_reply',
        'Reset auto-reply message to default.'
      );
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
    const nextMap = { ...antilinkMapRef.current, [formatted]: true };
    antilinkMapRef.current = nextMap;
    const ok = await safeUpdate({ antilinkGroups: nextMap }, 'add_antilink', 'Anti-Link group added.');
    if (ok) {
      setNewGroupJid('');
    }
  }

  async function handleToggleGroup(jid: string, enabled: boolean) {
    const nextMap = { ...antilinkMapRef.current, [jid]: enabled };
    antilinkMapRef.current = nextMap;
    await safeUpdate(
      { antilinkGroups: nextMap },
      `antilink_${jid}`,
      enabled ? 'Anti-Link enabled and saved.' : 'Anti-Link disabled and saved.'
    );
  }

  async function handleRemoveGroup(jid: string) {
    const nextMap = { ...antilinkMapRef.current };
    delete nextMap[jid];
    antilinkMapRef.current = nextMap;
    await safeUpdate({ antilinkGroups: nextMap }, `rm_antilink_${jid}`, 'Removed group anti-link rule.');
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
      {(ruleError || saveToast) && (
        <div className="flex flex-col gap-2">
          {ruleError && (
            <div className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 flex items-center justify-between gap-3">
              <span>{ruleError}</span>
              <button
                type="button"
                onClick={() => setRuleError(null)}
                className="text-red-500 hover:text-red-800 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {saveToast && (
            <div className="p-3.5 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-medium text-emerald-800 flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{saveToast}</span>
            </div>
          )}
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
              Controlled via <span className="font-mono text-slate-800">.autoreply on</span> and{' '}
              <span className="font-mono text-slate-800">.autoreply off</span>. Triggers strictly for incoming private DMs.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <select
              value={config.cooldownMs}
              onChange={(e) =>
                void safeUpdate(
                  { cooldownMs: Number(e.target.value) },
                  'cooldown',
                  'Cooldown interval saved.'
                )
              }
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
              disabled={busyKey === 'autoreply_toggle'}
              onClick={() =>
                void safeUpdate(
                  { autoreply: !config.autoreply },
                  'autoreply_toggle',
                  !config.autoreply ? 'Auto-Reply turned ON and saved.' : 'Auto-Reply turned OFF and saved.'
                )
              }
              className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 ${
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

      {/* Smart Group AI Clone ("আমার কপি") + Per-Group Command Box & @Mention Targeting */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-600" />
              Smart Group AI Clone (গ্রুপে আপনার কপি ও মেম্বার কমান্ড বক্স)
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              প্রতিটি গ্রুপের জন্য আলাদা <span className="font-medium text-slate-900">AI Command Box</span> ও মেম্বার{' '}
              <span className="font-mono text-slate-800">@mention</span> টার্গেট সেট করুন—টার্গেট করা মেম্বারকে আপনার ইনস্ট্রাকশন অনুযায়ী কনভিন্স করবে, আর বাকি সবার সাথে নরমাল কথা বলবে।
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={busyKey === 'group_react'}
              onClick={() =>
                void safeUpdate(
                  { groupReactionEnabled: !(config.groupReactionEnabled !== false) },
                  'group_react',
                  'Group emoji reaction setting saved.'
                )
              }
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60 ${
                config.groupReactionEnabled !== false
                  ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Emoji Reactions: {config.groupReactionEnabled !== false ? 'ON' : 'OFF'}
            </button>

            <button
              type="button"
              disabled={busyKey === 'group_ai_master'}
              onClick={() =>
                void safeUpdate(
                  { groupAiEnabled: !config.groupAiEnabled },
                  'group_ai_master',
                  !config.groupAiEnabled
                    ? 'Master Group AI Clone turned ON and saved.'
                    : 'Master Group AI Clone turned OFF and saved.'
                )
              }
              className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60 ${
                config.groupAiEnabled
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.groupAiEnabled ? 'Group AI Clone: ON' : 'Group AI Clone: OFF'}
            </button>
          </div>
        </div>

        {tokenTelemetry && (
          <div className="px-6 py-2.5 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums text-slate-600">
            <span>
              Today Tokens: <strong className="text-slate-900">{tokenTelemetry.todayTotalTokens.toLocaleString()}</strong>{' '}
              ({tokenTelemetry.byCategory.group.calls} group AI calls ·{' '}
              {tokenTelemetry.avgTokensPerGroupMsg !== null
                ? `avg ${tokenTelemetry.avgTokensPerGroupMsg} tok/msg`
                : 'avg pending'}
              )
            </span>
            <span>
              Remaining Capacity:{' '}
              <strong className="text-emerald-700">
                {tokenTelemetry.whatsappSafeCap.remaining} WhatsApp safe replies
              </strong>{' '}
              · ~{tokenTelemetry.geminiPool.estimatedGroupMsgsLeft.toLocaleString()} Gemini est. msgs (
              {tokenTelemetry.geminiPool.readyKeysCount}/{tokenTelemetry.geminiPool.configuredKeysCount} keys ready)
            </span>
          </div>
        )}

        <div className="p-6 border-b border-slate-200 bg-slate-50/70 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-5">
            <label className="block text-xs font-medium text-slate-600">
              Group Clone Behavior Mode
            </label>
            <select
              value={config.groupAiMode || 'smart_blend'}
              onChange={(e) =>
                void safeUpdate(
                  { groupAiMode: e.target.value as GroupAiMode },
                  'group_ai_mode',
                  'Group AI mode saved.'
                )
              }
              className="mt-1.5 w-full px-3.5 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            >
              <option value="smart_blend">Smart Human Blend (Observe + Emoji React + Roast/Flirt/Debate)</option>
              <option value="mention_only">Mention &amp; Reply Only (Observes all, replies when tagged/targeted)</option>
              <option value="active_chat">Active Group Member (Participates in most messages)</option>
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-slate-600">
              Group Text Cooldown
            </label>
            <select
              value={config.groupCooldownMs ?? 6000}
              onChange={(e) =>
                void safeUpdate(
                  { groupCooldownMs: Number(e.target.value) },
                  'group_cooldown',
                  'Group cooldown saved.'
                )
              }
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
              disabled={busyKey === 'add_ai_group'}
              className="px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
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
                : `Configured / cached groups (${knownGroups.length}) — connect WhatsApp to auto-list all your groups & members`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void loadGroups()}
            disabled={isLoadingGroups}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 flex items-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingGroups ? 'animate-spin' : ''}`} />
            {isLoadingGroups ? 'Refreshing...' : 'Refresh Groups'}
          </button>
        </div>

        {groupLoadError && (
          <div className="px-6 py-2.5 border-b border-slate-200 bg-amber-50 text-xs text-amber-800 flex items-center justify-between gap-2">
            <span>{groupLoadError}</span>
            <button
              type="button"
              onClick={() => setGroupLoadError(null)}
              className="text-amber-700 hover:text-amber-900 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {knownGroups.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No groups enabled yet. Send <span className="font-mono text-slate-800">.groupai on</span> inside any WhatsApp group, or add a Group JID above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-6">Group Name</th>
                  <th className="py-2.5 px-4">Group JID</th>
                  <th className="py-2.5 px-4">Clone &amp; Directives</th>
                  <th className="py-2.5 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {knownGroups.map((grp) => {
                  const isActive = groupAiMap[grp.jid] ?? grp.groupAiEnabled;
                  const directive = directivesMap[grp.jid] || EMPTY_DIRECTIVE;
                  const activeTargetsCount = (directive.targets || []).filter((t) => t.enabled !== false).length;
                  const hasPrompt = Boolean(directive.groupPrompt?.trim());
                  const isExpanded = expandedGroupJid === grp.jid;
                  const members = grp.members || [];
                  const filteredMembers = members.filter((m) => {
                    if (!mentionFilter) return true;
                    return (
                      m.name.toLowerCase().includes(mentionFilter) ||
                      m.phone.includes(mentionFilter)
                    );
                  });

                  return (
                    <Fragment key={grp.jid}>
                      <tr className={isExpanded ? 'bg-slate-50/80' : 'hover:bg-slate-50/70'}>
                        <td className="py-3 px-6 font-medium text-slate-900">
                          <div>{grp.name}</div>
                          <div className="text-[11px] font-normal text-slate-500 mt-0.5 tabular-nums">
                            {grp.participantCount > 0
                              ? `${grp.participantCount} participants`
                              : members.length > 0
                                ? `${members.length} cached members`
                                : 'Members sync when connected'}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600">{grp.jid}</td>
                        <td className="py-3 px-4">
                          <div className="font-medium">
                            <span className={isActive ? 'text-emerald-700' : 'text-slate-500'}>
                              {isActive ? 'Clone Active' : 'Paused / Off'}
                            </span>
                          </div>
                          {(hasPrompt || activeTargetsCount > 0) && (
                            <div className="text-[11px] font-mono text-slate-600 mt-0.5 tabular-nums">
                              {hasPrompt ? 'Command ON' : 'No Prompt'} · {activeTargetsCount}{' '}
                              {activeTargetsCount === 1 ? 'Target' : 'Targets'}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-6 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleOpenCommandEditor(grp)}
                              className={`px-2.5 py-1 text-xs font-medium border rounded-md flex items-center gap-1 whitespace-nowrap cursor-pointer ${
                                isExpanded
                                  ? 'border-slate-900 bg-slate-900 text-white'
                                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                              }`}
                            >
                              <Target className="w-3 h-3" />
                              Command Box
                              {isExpanded ? (
                                <ChevronUp className="w-3 h-3" />
                              ) : (
                                <ChevronDown className="w-3 h-3" />
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={busyKey === `toggle_ai_${grp.jid}`}
                              onClick={() => void handleToggleAiGroup(grp.jid, !isActive)}
                              className={`px-2.5 py-1 text-xs font-medium border rounded-md whitespace-nowrap cursor-pointer disabled:opacity-60 ${
                                isActive
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                              }`}
                            >
                              {busyKey === `toggle_ai_${grp.jid}`
                                ? 'Saving...'
                                : isActive
                                  ? 'Turn OFF'
                                  : 'Turn ON'}
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

                      {isExpanded && (
                        <tr>
                          <td colSpan={4} className="p-0 bg-slate-50/90 border-t border-slate-200">
                            <div className="p-6 space-y-6">
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200">
                                <div>
                                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                                    <Target className="w-4 h-4 text-emerald-600" />
                                    {grp.name} — Per-Group AI Command Box &amp; Member Targeting
                                  </h3>
                                  <p className="text-xs text-slate-600 mt-1">
                                    নির্দিষ্ট মেম্বারকে <span className="font-mono text-slate-800">@mention</span> দিয়ে মিশন/কনভিন্স ইনস্ট্রাকশন সেট করলে AI শুধু ওই মেম্বারের সাথে মিশন অনুযায়ী কথা বলবে; গ্রুপের বাকি সব মেম্বারের সাথে সম্পূর্ণ নরমালি কথা বলবে।
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleSaveCommandBox(grp.jid)}
                                  disabled={busyKey === `cmd_${grp.jid}`}
                                  className="px-3.5 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                                >
                                  <Save className="w-3.5 h-3.5" />
                                  {busyKey === `cmd_${grp.jid}`
                                    ? 'Saving...'
                                    : isCommandDirty
                                      ? 'Save Command Box *'
                                      : 'Save Command Box'}
                                </button>
                              </div>

                              {/* Per-Group General Command Box with @Mention Picker */}
                              <div className="space-y-2 relative">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="text-xs font-semibold text-slate-800">
                                    Group AI Command / Custom Behavior Rule (শুধু এই গ্রুপের জন্য)
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMentionFilter('');
                                      setShowMentionDropdown((v) => !v);
                                    }}
                                    className="px-2.5 py-1 text-[11px] font-medium bg-white border border-slate-200 rounded-md text-slate-700 hover:bg-slate-100 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                  >
                                    <AtSign className="w-3 h-3 text-emerald-600" />
                                    Mention Member ({members.length})
                                  </button>
                                </div>

                                <textarea
                                  rows={3}
                                  value={commandPromptDraft}
                                  onChange={(e) => handleCommandPromptChange(e.target.value)}
                                  placeholder="উদাহরণ: এই গ্রুপে টোন একটু বন্ধুত্বপূর্ণ রাখবে, কেউ অফিস প্রজেক্ট নিয়ে কথা বললে পজিটিভলি সাপোর্ট দেবে... (@ লিখলে মেম্বার লিস্ট আসবে)"
                                  className="w-full px-3.5 py-2.5 text-xs leading-relaxed bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                                />

                                {showMentionDropdown && (
                                  <div className="bg-white border border-slate-200 rounded-lg shadow-sm max-h-48 overflow-y-auto divide-y divide-slate-100">
                                    <div className="px-3 py-1.5 bg-slate-50 text-[11px] font-medium text-slate-500 flex items-center justify-between">
                                      <span>Select group member to @mention &amp; target</span>
                                      <button
                                        type="button"
                                        onClick={() => setShowMentionDropdown(false)}
                                        className="text-slate-400 hover:text-slate-700 cursor-pointer"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                    {filteredMembers.length === 0 ? (
                                      <div className="px-3 py-2.5 text-xs text-slate-500">
                                        {members.length === 0
                                          ? 'No members cached yet. Connect WhatsApp & click Refresh Groups, or enter member manually below.'
                                          : 'No member matches filter.'}
                                      </div>
                                    ) : (
                                      filteredMembers.slice(0, 30).map((m) => (
                                        <button
                                          key={m.jid}
                                          type="button"
                                          onClick={() => handleSelectMentionForPrompt(m)}
                                          className="w-full px-3 py-2 text-left text-xs hover:bg-emerald-50/70 flex items-center justify-between gap-3 cursor-pointer"
                                        >
                                          <span className="font-medium text-slate-900">
                                            @{m.name}
                                            {m.isAdmin && (
                                              <span className="ml-2 text-[10px] font-mono text-emerald-700">
                                                [Admin]
                                              </span>
                                            )}
                                          </span>
                                          <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                                            {m.phone ? `+${m.phone}` : 'LID · Hidden Phone'}
                                          </span>
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Targeted Member Mention Objectives Builder */}
                              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                                <div>
                                  <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                                    <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
                                    @Mention Member Specific Objectives (নির্দিষ্ট মেম্বারকে কনভিন্স/হ্যান্ডেল করার কমান্ড)
                                  </h4>
                                  <p className="text-[11px] text-slate-500 mt-0.5">
                                    গ্রুপের কোন মেম্বারকে কী বিষয়ে কনভিন্স করতে হবে বা কীভাবে তার সাথে ডিল করতে হবে তা ঠিক করুন। অন্য সবার সাথে AI সাধারণভাবেই কথা বলবে।
                                  </p>
                                </div>

                                <form
                                  onSubmit={(e) => void handleAddTargetDirective(grp, e)}
                                  className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-end"
                                >
                                  <div className="lg:col-span-4">
                                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                                      Target Group Member (@Mention)
                                    </label>
                                    <select
                                      value={selectedMemberKey}
                                      onChange={(e) => setSelectedMemberKey(e.target.value)}
                                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-emerald-600"
                                    >
                                      {members.map((m) => (
                                        <option key={m.jid} value={m.jid}>
                                          @{m.name} {m.phone ? `(+${m.phone})` : '(LID · Hidden Phone)'}
                                        </option>
                                      ))}
                                      <option value="manual">
                                        + Enter Member Name / Number Manually
                                      </option>
                                    </select>
                                  </div>

                                  {selectedMemberKey === 'manual' && (
                                    <>
                                      <div className="lg:col-span-4">
                                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                                          Member Name
                                        </label>
                                        <input
                                          type="text"
                                          value={manualMemberName}
                                          onChange={(e) => setManualMemberName(e.target.value)}
                                          placeholder="e.g. Rafiq"
                                          className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                                        />
                                      </div>
                                      <div className="lg:col-span-4">
                                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                                          Phone Number (recommended for exact JID match)
                                        </label>
                                        <input
                                          type="text"
                                          value={manualMemberPhone}
                                          onChange={(e) => setManualMemberPhone(e.target.value)}
                                          placeholder="e.g. 88017XXXXXXXX"
                                          className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                                        />
                                      </div>
                                    </>
                                  )}

                                  <div
                                    className={
                                      selectedMemberKey === 'manual' ? 'lg:col-span-9' : 'lg:col-span-5'
                                    }
                                  >
                                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                                      Objective / How AI Should Convince or Handle Them
                                    </label>
                                    <input
                                      type="text"
                                      value={targetObjectiveInput}
                                      onChange={(e) => setTargetObjectiveInput(e.target.value)}
                                      placeholder="উদাহরণ: ওকে বুঝিয়ে বলো ট্যুরে যাওয়ার জন্য, মিষ্টি কথায় ও যুক্তি দিয়ে কনভিন্স করো"
                                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                                    />
                                  </div>

                                  <div className="lg:col-span-3">
                                    <button
                                      type="submit"
                                      disabled={busyKey === `add_tgt_${grp.jid}`}
                                      className="w-full px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-60"
                                    >
                                      <Plus className="w-3.5 h-3.5" />
                                      Add &amp; Save Target
                                    </button>
                                  </div>
                                </form>

                                {(directive.targets || []).length > 0 ? (
                                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                                    {(directive.targets || []).map((t) => (
                                      <div
                                        key={t.id}
                                        className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                                      >
                                        <div className="min-w-0 space-y-0.5">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-semibold text-slate-900">
                                              @{t.targetName}
                                            </span>
                                            {t.targetPhone && (
                                              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                                                +{t.targetPhone}
                                              </span>
                                            )}
                                            <span
                                              className={`text-[11px] font-medium ${
                                                t.enabled !== false ? 'text-emerald-700' : 'text-slate-400'
                                              }`}
                                            >
                                              • {t.enabled !== false ? 'Mission Active' : 'Paused'}
                                            </span>
                                          </div>
                                          <div className="text-slate-700 break-words">
                                            {t.objective}
                                          </div>
                                        </div>

                                        <div className="flex items-center gap-2 shrink-0">
                                          <button
                                            type="button"
                                            disabled={busyKey === `tgt_${t.id}`}
                                            onClick={() => void handleToggleTargetDirective(grp.jid, t.id)}
                                            className={`px-2.5 py-1 text-[11px] font-medium border rounded-md cursor-pointer ${
                                              t.enabled !== false
                                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                                            }`}
                                          >
                                            {t.enabled !== false ? 'Pause' : 'Activate'}
                                          </button>
                                          <button
                                            type="button"
                                            disabled={busyKey === `del_tgt_${t.id}`}
                                            onClick={() => void handleRemoveTargetDirective(grp.jid, t.id)}
                                            className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                                            title="Remove member target"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-xs text-slate-500 py-2">
                                    No specific member targets set yet for this group. Everyone is treated normally based on Group AI behavior.
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
                disabled={busyKey === 'add_antilink'}
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
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
                          disabled={busyKey === `antilink_${jid}`}
                          onClick={() => void handleToggleGroup(jid, !enabled)}
                          className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded-md hover:bg-slate-100 text-slate-700 cursor-pointer disabled:opacity-60"
                        >
                          {enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveGroup(jid)}
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
