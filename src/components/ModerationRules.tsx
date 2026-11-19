import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Eye,
  Film,
  Heart,
  Image,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Target,
  Terminal,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  VolumeX,
  X,
} from 'lucide-react';
import { authFetch } from '../lib/api';
import {
  BENGALI_AUTOREPLY_EXACT,
  type BotConfig,
  type BotStatusResponse,
  type ContactPolicyEntry,
  type ContactPolicyMode,
  type DirectCommandLogItem,
  type GroupAiMode,
  type GroupDirectiveConfig,
  type GroupMemberTargetDirective,
  type KnownContactItem,
  type KnownGroupItem,
  type KnownGroupMemberItem,
  type MediaStoryFeedItem,
  type SelfChatTurnItem,
  type StoryWhitelistContact,
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
  const [mediaStories, setMediaStories] = useState<MediaStoryFeedItem[]>([]);
  const [isLoadingStories, setIsLoadingStories] = useState(false);

  // Known WhatsApp Contacts & Story Custom Whitelist State
  const [knownContacts, setKnownContacts] = useState<KnownContactItem[]>([]);
  const [storySelectedPicker, setStorySelectedPicker] = useState<string>('manual');
  const [storyManualName, setStoryManualName] = useState('');
  const [storyManualPhone, setStoryManualPhone] = useState('');
  const [storyCustomPrompt, setStoryCustomPrompt] = useState('');

  // Direct Action Command Box (Inbox Knock + Group @Mention)
  const [directActionType, setDirectActionType] = useState<'auto' | 'dm_knock' | 'group_mention'>('auto');
  const [directContactPicker, setDirectContactPicker] = useState<string>('manual');
  const [directTargetPhoneOrName, setDirectTargetPhoneOrName] = useState('');
  const [directGroupJid, setDirectGroupJid] = useState('');
  const [directMentionMemberJids, setDirectMentionMemberJids] = useState<string[]>([]);
  const [directInstruction, setDirectInstruction] = useState('');
  const [directUseAiCraft, setDirectUseAiCraft] = useState(true);
  const [isExecutingDirectCmd, setIsExecutingDirectCmd] = useState(false);
  const [directCmdResult, setDirectCmdResult] = useState<{
    messageText: string;
    note: string;
    targetLabel: string;
    deliveredLive: boolean;
    dryRun: boolean;
    mentionedJids: string[];
    providerUsed: string;
  } | null>(null);
  const [directCommandHistory, setDirectCommandHistory] = useState<DirectCommandLogItem[]>([]);

  // Owner Self-Chat Copilot & Contact Engagement/Hold Policies State
  const [selfChatHistory, setSelfChatHistory] = useState<SelfChatTurnItem[]>([]);
  const [selfChatInput, setSelfChatInput] = useState('');
  const [isSendingSelfChat, setIsSendingSelfChat] = useState(false);
  const [serverRssMb, setServerRssMb] = useState<number | null>(null);
  const [selfConnectedPhone, setSelfConnectedPhone] = useState('');
  const [policyPicker, setPolicyPicker] = useState<string>('manual');
  const [policyName, setPolicyName] = useState('');
  const [policyPhone, setPolicyPhone] = useState('');
  const [policyMode, setPolicyMode] = useState<ContactPolicyMode>('long_engage');
  const [policyNote, setPolicyNote] = useState('');

  // Keep fresh refs so rapid clicks merge cleanly without stale closure rollbacks
  const groupAiMapRef = useRef<Record<string, boolean>>(config.groupAiGroups || {});
  const antilinkMapRef = useRef<Record<string, boolean>>(config.antilinkGroups || {});
  const directivesMapRef = useRef<Record<string, GroupDirectiveConfig>>(config.groupDirectives || {});
  const storyAllowedRef = useRef<StoryWhitelistContact[]>(config.storyAllowedContacts || []);
  const contactPoliciesRef = useRef<ContactPolicyEntry[]>(config.contactPolicies || []);

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
    storyAllowedRef.current = config.storyAllowedContacts || [];
  }, [config.storyAllowedContacts]);

  useEffect(() => {
    contactPoliciesRef.current = config.contactPolicies || [];
  }, [config.contactPolicies]);

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

  async function loadMediaStories() {
    setIsLoadingStories(true);
    try {
      const res = await authFetch('/api/media/stories');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.stories)) {
          setMediaStories(data.stories);
        }
      }
    } catch {
      // ignore transient story fetch errors
    } finally {
      setIsLoadingStories(false);
    }
  }

  async function loadContacts() {
    try {
      const res = await authFetch('/api/contacts');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.contacts)) {
          setKnownContacts(data.contacts);
        }
      }
    } catch {
      // ignore transient contact fetch errors
    }
  }

  async function loadDirectCommands() {
    try {
      const res = await authFetch('/api/assistant/direct-commands');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.commands)) {
          setDirectCommandHistory(data.commands);
        }
      }
    } catch {
      // ignore
    }
  }

  async function loadSelfChatState() {
    try {
      const res = await authFetch('/api/assistant/self-chat');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.history)) {
          setSelfChatHistory(data.history);
        }
        if (typeof data.memoryRssMb === 'number') {
          setServerRssMb(data.memoryRssMb);
        }
        if (typeof data.connectedPhone === 'string') {
          setSelfConnectedPhone(data.connectedPhone);
        }
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void loadGroups();
    void loadMediaStories();
    void loadContacts();
    void loadDirectCommands();
    void loadSelfChatState();
  }, [botStatus]);

  useEffect(() => {
    if (!directGroupJid && knownGroups.length > 0) {
      setDirectGroupJid(knownGroups[0].jid);
    }
  }, [knownGroups, directGroupJid]);

  const groupEntries = Object.entries(config.antilinkGroups || {});
  const groupAiMap = config.groupAiGroups || {};
  const directivesMap = config.groupDirectives || {};
  const storyAllowedList = config.storyAllowedContacts || [];

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

  async function handleAddStoryWhitelistContact(e: React.FormEvent) {
    e.preventDefault();
    let name = '';
    let phone = '';
    let jid = '';

    if (storySelectedPicker !== 'manual') {
      const picked = knownContacts.find((c) => c.jid === storySelectedPicker);
      if (picked) {
        name = picked.name;
        phone = picked.phone;
        jid = picked.jid;
      }
    } else {
      name = storyManualName.trim();
      phone = storyManualPhone.replace(/\D/g, '');
      if (/^01[3-9]\d{8}$/.test(phone)) phone = `88${phone}`;
      jid = phone ? `${phone}@s.whatsapp.net` : '';
      if (!name && phone) name = `+${phone}`;
    }

    if (!name && !phone && !jid) {
      setRuleError('স্টোরি লিস্টে যোগ করার জন্য একটি কন্টাক্ট সিলেক্ট করুন বা নাম/নম্বর লিখুন।');
      return;
    }

    const nextEntry: StoryWhitelistContact = {
      id: `story_wl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      phone,
      jid: jid || undefined,
      customPrompt: storyCustomPrompt.trim() || undefined,
      enabled: true,
    };

    const currentList = storyAllowedRef.current;
    const deduped = currentList.filter(
      (x) =>
        !(phone && x.phone === phone) &&
        !(jid && x.jid === jid) &&
        !(name && x.name.toLowerCase() === name.toLowerCase())
    );
    const nextList = [nextEntry, ...deduped];
    storyAllowedRef.current = nextList;

    const ok = await safeUpdate(
      {
        storyWhitelistMode: 'selected_only',
        storyAllowedContacts: nextList,
      },
      'add_story_wl',
      `"${name}"-কে কাস্টম স্টোরি লিস্টে যোগ করা হয়েছে।`
    );

    if (ok) {
      setStoryManualName('');
      setStoryManualPhone('');
      setStoryCustomPrompt('');
    }
  }

  async function handleToggleStoryWhitelistContact(id: string) {
    const nextList = storyAllowedRef.current.map((item) =>
      item.id === id ? { ...item, enabled: !item.enabled } : item
    );
    storyAllowedRef.current = nextList;
    await safeUpdate({ storyAllowedContacts: nextList }, `toggle_story_wl_${id}`, 'Updated story contact status.');
  }

  async function handleRemoveStoryWhitelistContact(id: string) {
    const nextList = storyAllowedRef.current.filter((item) => item.id !== id);
    storyAllowedRef.current = nextList;
    await safeUpdate({ storyAllowedContacts: nextList }, `del_story_wl_${id}`, 'Removed contact from story whitelist.');
  }

  function handleToggleDirectMentionMember(memberJid: string) {
    setDirectMentionMemberJids((prev) =>
      prev.includes(memberJid) ? prev.filter((id) => id !== memberJid) : [...prev, memberJid]
    );
  }

  async function handleExecuteDirectCommand(dryRun: boolean) {
    const instruction = directInstruction.trim();
    if (!instruction) {
      setRuleError('কমান্ড বক্সে কী মেসেজ পাঠাতে চান বা কী বলতে চান তা লিখুন।');
      return;
    }

    setRuleError(null);
    setIsExecutingDirectCmd(true);
    try {
      const selectedContact =
        directContactPicker !== 'manual'
          ? knownContacts.find((c) => c.jid === directContactPicker)
          : undefined;

      const selectedGroup = knownGroups.find((g) => g.jid === directGroupJid);
      const selectedMembersPayload =
        selectedGroup && directMentionMemberJids.length > 0
          ? (selectedGroup.members || [])
              .filter((m) => directMentionMemberJids.includes(m.jid))
              .map((m) => ({ jid: m.jid, lid: m.lid, phone: m.phone, name: m.name }))
          : undefined;

      const res = await authFetch('/api/assistant/direct-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: directActionType,
          targetPhoneOrJid: selectedContact ? selectedContact.jid : directTargetPhoneOrName.trim(),
          targetContactName: selectedContact ? selectedContact.name : undefined,
          groupJid: directActionType === 'group_mention' ? directGroupJid : directActionType === 'auto' ? directGroupJid || undefined : undefined,
          mentionMembers: selectedMembersPayload,
          instruction,
          useAiCraft: directUseAiCraft,
          dryRun,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRuleError(data.error || 'Could not execute direct command.');
        return;
      }

      setDirectCmdResult({
        messageText: data.messageText,
        note: data.note,
        targetLabel: data.targetLabel,
        deliveredLive: Boolean(data.deliveredLive),
        dryRun: Boolean(data.dryRun),
        mentionedJids: Array.isArray(data.mentionedJids) ? data.mentionedJids : [],
        providerUsed: String(data.providerUsed || 'offline_emotion'),
      });
      if (!dryRun && data.commandRecord) {
        setDirectCommandHistory((prev) => [data.commandRecord, ...prev].slice(0, 30));
        flashSaved(data.deliveredLive ? 'WhatsApp-এ মেসেজ পাঠানো হয়েছে!' : 'ড্রাফট সেভ হয়েছে।');
      }
    } catch (err) {
      setRuleError((err as Error).message || 'Direct command network error.');
    } finally {
      setIsExecutingDirectCmd(false);
    }
  }

  async function handleSendSelfChatMessage(
    customText?: string,
    simMedia?: { kind: 'video' | 'photo'; caption: string; visualPreset?: 'dark_bad' | 'portrait_stunning'; durationSec?: number }
  ) {
    const textToSend = (customText !== undefined ? customText : selfChatInput).trim();
    if (!textToSend && !simMedia) return;
    setRuleError(null);
    setIsSendingSelfChat(true);
    try {
      const res = await authFetch('/api/assistant/self-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: textToSend,
          ...(simMedia ? { media: simMedia } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRuleError(data.error || 'Self-Chat copilot failed.');
        return;
      }
      if (Array.isArray(data.history)) setSelfChatHistory(data.history);
      if (typeof data.memoryRssMb === 'number') setServerRssMb(data.memoryRssMb);
      if (customText === undefined) setSelfChatInput('');
      if (data.config) {
        await onUpdateConfig({
          autoreply: data.config.autoreply,
          aiAssistantEnabled: data.config.aiAssistantEnabled,
          assistantTone: data.config.assistantTone,
          dailyReplyLimit: data.config.dailyReplyLimit,
          groupAiEnabled: data.config.groupAiEnabled,
          groupAiGroups: data.config.groupAiGroups,
          antilinkGroups: data.config.antilinkGroups,
          storyWhitelistMode: data.config.storyWhitelistMode,
          contactPolicies: data.config.contactPolicies,
        });
      }
    } catch (err) {
      setRuleError((err as Error).message || 'Self-Chat error.');
    } finally {
      setIsSendingSelfChat(false);
    }
  }

  async function handleClearSelfChat() {
    setRuleError(null);
    try {
      const res = await authFetch('/api/assistant/self-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      if (res.ok) {
        setSelfChatHistory([]);
        flashSaved('Self-Chat হিস্ট্রি ক্লিয়ার করা হয়েছে।');
      }
    } catch {
      // ignore
    }
  }

  async function handleAddContactPolicy(e: React.FormEvent) {
    e.preventDefault();
    setRuleError(null);
    let name = '';
    let phone = '';
    let jid = '';

    if (policyPicker !== 'manual') {
      const picked = knownContacts.find((c) => c.jid === policyPicker);
      if (picked) {
        name = picked.name;
        phone = picked.phone;
        jid = picked.jid;
      }
    } else {
      name = policyName.trim();
      const rawDigits = policyPhone.replace(/\D/g, '');
      phone =
        rawDigits.startsWith('01') && rawDigits.length === 11
          ? `88${rawDigits}`
          : rawDigits.startsWith('1') && rawDigits.length === 10
            ? `880${rawDigits}`
            : rawDigits;
      jid = phone ? `${phone}@s.whatsapp.net` : '';
      if (!name && phone) name = `+${phone}`;
    }

    if (!name && !phone && !jid) {
      setRuleError('একটি কন্টাক্ট সিলেক্ট করুন বা নাম ও নাম্বার লিখুন।');
      return;
    }

    const nextEntry: ContactPolicyEntry = {
      id: `cpol_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      phone,
      jid: jid || undefined,
      mode: policyMode,
      note: policyNote.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };

    const current = contactPoliciesRef.current.filter(
      (c) =>
        !(phone && c.phone === phone) &&
        !(jid && c.jid === jid) &&
        !(name && c.name.toLowerCase() === name.toLowerCase())
    );
    const nextList = [nextEntry, ...current];
    contactPoliciesRef.current = nextList;

    const ok = await safeUpdate(
      { contactPolicies: nextList },
      'add_contact_policy',
      `"${name}"-এর জন্য কন্টাক্ট রুল সেভ হয়েছে।`
    );
    if (ok) {
      setPolicyName('');
      setPolicyPhone('');
      setPolicyNote('');
    }
  }

  async function handleRemoveContactPolicy(id: string) {
    const nextList = contactPoliciesRef.current.filter((p) => p.id !== id);
    contactPoliciesRef.current = nextList;
    await safeUpdate({ contactPolicies: nextList }, `del_pol_${id}`, 'কন্টাক্ট রুল মুছে ফেলা হয়েছে।');
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
                <span>Own Number Self-Chat</span>
                <span className="font-medium text-emerald-700">Owner Copilot (0 Tokens)</span>
              </li>
              <li className="px-4 py-2.5 flex justify-between">
                <span>Prefix Commands (.)</span>
                <span className="font-medium text-slate-500">Excluded</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Owner Self-Chat Direct Copilot & Contact Long-Engage / Hold Manager */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-emerald-600" />
              Owner Self-Chat Copilot (নিজের নাম্বারে সরাসরি চ্যাট ও কমান্ড)
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              কানেক্টেড WhatsApp অ্যাকাউন্ট থেকে নিজের নাম্বারে (<span className="font-medium text-slate-900">Message Yourself</span>) মেসেজ বা ভিডিও পাঠালেই AI সরাসরি আপনার সাথে চ্যাট করবে—পরামর্শ, একাধিক নাম্বারে পাঠানো, ভিডিওর ভুল ধরা, এবং কাকে <span className="font-medium text-slate-900">দীর্ঘক্ষণ কথা</span> বা <span className="font-medium text-slate-900">আটকে রাখবে</span> তা এখান থেকেই সেট হবে।
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-medium text-emerald-800">
              <Sparkles className="w-3.5 h-3.5" />
              0 Tokens Strictly
            </span>
            {serverRssMb !== null && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700">
                <Cpu className="w-3.5 h-3.5 text-slate-500" />
                RAM: {serverRssMb} MB
              </span>
            )}
            <button
              type="button"
              disabled={busyKey === 'self_chat_toggle'}
              onClick={() =>
                void safeUpdate(
                  { selfChatCopilotEnabled: !(config.selfChatCopilotEnabled !== false) },
                  'self_chat_toggle',
                  config.selfChatCopilotEnabled !== false ? 'Self-Chat Copilot বন্ধ হয়েছে।' : 'Self-Chat Copilot চালু হয়েছে!'
                )
              }
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-60 ${
                config.selfChatCopilotEnabled !== false
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.selfChatCopilotEnabled !== false ? 'Self-Chat: ON' : 'Self-Chat: OFF'}
            </button>
          </div>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Direct Self-Chat Console */}
          <div className="lg:col-span-7 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-slate-600">
                Direct Owner Chat Console {selfConnectedPhone ? `(+${selfConnectedPhone})` : '(Message Yourself Sync)'}
              </div>
              {selfChatHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleClearSelfChat()}
                  className="text-xs text-slate-500 hover:text-rose-600 transition-colors cursor-pointer"
                >
                  Clear History
                </button>
              )}
            </div>

            <div className="border border-slate-200 rounded-xl bg-slate-50 p-3.5 h-64 overflow-y-auto space-y-2.5">
              {selfChatHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-4 text-xs text-slate-500 space-y-1.5">
                  <p className="font-medium text-slate-700">আপনার নিজের নাম্বারে সরাসরি চ্যাট করতে নিচে লিখুন অথবা WhatsApp-এ "Message Yourself"-এ মেসেজ/ভিডিও দিন।</p>
                  <p>সম্পূর্ণ ০ টোকেন ও লো-র‍্যাম (সর্বোচ্চ ২৫ টার্ন বাফার) মোডে চলবে।</p>
                </div>
              ) : (
                selfChatHistory.slice(-10).map((turn) => (
                  <div
                    key={turn.id}
                    className={`flex ${turn.role === 'owner' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                        turn.role === 'owner'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-white border border-slate-200 text-slate-800'
                      }`}
                    >
                      {turn.mediaKind && (
                        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80 mb-1">
                          Media: {turn.mediaKind}
                        </div>
                      )}
                      <div>{turn.text}</div>
                      {turn.actionSummary && (
                        <div className="mt-1.5 pt-1 border-t border-slate-100 text-[10px] text-emerald-700 font-medium">
                          {turn.actionSummary}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={isSendingSelfChat}
                onClick={() => void handleSendSelfChatMessage('স্ট্যাটাস ও র‍্যাম দেখাও')}
                className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors cursor-pointer"
              >
                স্ট্যাটাস ও র‍্যাম
              </button>
              <button
                type="button"
                disabled={isSendingSelfChat}
                onClick={() =>
                  void handleSendSelfChatMessage('এই ভিডিওটা দেখো, আমার বটের কোথায় মিসটেক হইছে?', {
                    kind: 'video',
                    caption: 'এই ভিডিওটা দেখো, আমার বটের কোথায় মিসটেক হইছে?',
                    durationSec: 12,
                    visualPreset: 'portrait_stunning',
                  })
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-md transition-colors cursor-pointer"
              >
                <Film className="w-3 h-3" />
                ভিডিও মিসটেক অ্যানালাইসিস টেস্ট
              </button>
              <button
                type="button"
                disabled={isSendingSelfChat}
                onClick={() => void handleSendSelfChatMessage('কার কার ওপর রুল চালু আছে দেখাও')}
                className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors cursor-pointer"
              >
                কন্টাক্ট রুলস দেখো
              </button>
              <button
                type="button"
                disabled={isSendingSelfChat}
                onClick={() => void handleSendSelfChatMessage('কমান্ড লিস্ট')}
                className="px-2.5 py-1 text-[11px] font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded-md transition-colors cursor-pointer"
              >
                সব কমান্ড (A-Z Help)
              </button>
              <button
                type="button"
                disabled={isSendingSelfChat}
                onClick={() => void handleSendSelfChatMessage('আমার জন্য একটা ক্লায়েন্ট অফার ইমেইল ড্রাফট করো')}
                className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors cursor-pointer"
              >
                ইমেইল ড্রাফট টেস্ট
              </button>
              <button
                type="button"
                disabled={isSendingSelfChat}
                onClick={() => void handleSendSelfChatMessage('ক্লায়েন্ট দাম কমাতে চাচ্ছে কী বলবো পরামর্শ দাও')}
                className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors cursor-pointer"
              >
                পরামর্শ টেস্ট
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendSelfChatMessage();
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={selfChatInput}
                onChange={(e) => setSelfChatInput(e.target.value)}
                placeholder="যেকোনো কথা, পরামর্শ, কমান্ড (যেমন: 01711..., 01811... এদেরকে পাঠাও...)"
                className="flex-1 px-3.5 py-2.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
              <button
                type="submit"
                disabled={isSendingSelfChat || !selfChatInput.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors cursor-pointer disabled:opacity-60"
              >
                <Send className="w-3.5 h-3.5" />
                {isSendingSelfChat ? 'পাঠাচ্ছে...' : 'Send'}
              </button>
            </form>
          </div>

          {/* Right: Contact Engagement & Hold Manager */}
          <div className="lg:col-span-5 space-y-3 border-t lg:border-t-0 lg:border-l border-slate-200 pt-4 lg:pt-0 lg:pl-6">
            <div>
              <h3 className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
                Contact Long-Engage &amp; Hold Rules
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                নির্দিষ্ট নাম্বারের জন্য রুল দিন: কার সাথে দীর্ঘক্ষণ কথা বলবে, কাকে আটকে রাখবে (হোল্ড), অথবা কাকে মিউট রাখবে।
              </p>
            </div>

            <form onSubmit={(e) => void handleAddContactPolicy(e)} className="space-y-2.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
              <select
                value={policyPicker}
                onChange={(e) => setPolicyPicker(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              >
                <option value="manual">নতুন নাম / নাম্বার লিখুন</option>
                {knownContacts.map((c) => (
                  <option key={c.jid} value={c.jid}>
                    {c.name} {c.phone ? `(+${c.phone})` : ''}
                  </option>
                ))}
              </select>

              {policyPicker === 'manual' && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={policyName}
                    onChange={(e) => setPolicyName(e.target.value)}
                    placeholder="নাম (যেমন: রাহুল)"
                    className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800"
                  />
                  <input
                    type="text"
                    value={policyPhone}
                    onChange={(e) => setPolicyPhone(e.target.value)}
                    placeholder="01712345678"
                    className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 font-mono"
                  />
                </div>
              )}

              <select
                value={policyMode}
                onChange={(e) => setPolicyMode(e.target.value as ContactPolicyMode)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 font-medium"
              >
                <option value="long_engage">💬 দীর্ঘক্ষণ কথা বলো (Long Engage)</option>
                <option value="hold_wait">⏳ আটকে রাখো / অপেক্ষায় রাখো (0-Token Hold)</option>
                <option value="mute_ai">🔇 রিপ্লাই বন্ধ রাখো (Mute AI)</option>
              </select>

              <input
                type="text"
                value={policyNote}
                onChange={(e) => setPolicyNote(e.target.value)}
                placeholder="ঐচ্ছিক কারণ/নোট (যেমন: পেমেন্টের বিষয়ে ব্যস্ত দেখাও)"
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800"
              />

              <button
                type="submit"
                disabled={busyKey === 'add_contact_policy'}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-60"
              >
                <Plus className="w-3.5 h-3.5" />
                Save Contact Rule
              </button>
            </form>

            <div className="space-y-2 max-h-52 overflow-y-auto">
              {(config.contactPolicies || []).filter((p) => p.mode !== 'normal').length === 0 ? (
                <div className="text-xs text-slate-400 text-center py-4 border border-dashed border-slate-200 rounded-lg">
                  কোনো কন্টাক্ট রুল এখনো সেট করা নেই।
                </div>
              ) : (
                (config.contactPolicies || [])
                  .filter((p) => p.mode !== 'normal')
                  .map((p) => (
                    <div
                      key={p.id}
                      className="flex items-start justify-between gap-2 p-2.5 rounded-lg border border-slate-200 bg-white text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 truncate">
                          {p.name} {p.phone ? <span className="font-mono text-slate-500">(+{p.phone})</span> : ''}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              p.mode === 'long_engage'
                                ? 'bg-emerald-50 text-emerald-700'
                                : p.mode === 'hold_wait'
                                  ? 'bg-amber-50 text-amber-700'
                                  : 'bg-rose-50 text-rose-700'
                            }`}
                          >
                            {p.mode === 'long_engage' ? (
                              <>
                                <MessageCircle className="w-2.5 h-2.5" /> দীর্ঘক্ষণ কথা
                              </>
                            ) : p.mode === 'hold_wait' ? (
                              <>
                                <Clock className="w-2.5 h-2.5" /> আটকে রাখো (Hold)
                              </>
                            ) : (
                              <>
                                <VolumeX className="w-2.5 h-2.5" /> রিপ্লাই বন্ধ
                              </>
                            )}
                          </span>
                        </div>
                        {p.note && <div className="mt-1 text-[11px] text-slate-500">{p.note}</div>}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRemoveContactPolicy(p.id)}
                        className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer shrink-0"
                        title="Remove Rule"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Direct Action Command Box (Inbox Knock & Group @Mention Dispatcher) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-600" />
              Direct AI Action Command Box (সরাসরি ইনবক্স নক ও গ্রুপ @মেনশন)
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              এখান থেকে সরাসরি কমান্ড দিন—কোনো নির্দিষ্ট নাম্বার/কন্টাক্টের <span className="font-medium text-slate-900">ইনবক্সে গিয়ে নক করতে</span> অথবা কোনো{' '}
              <span className="font-medium text-slate-900">গ্রুপে @মেনশন দিয়ে কথা বলতে</span> বা কাজটি করে দিতে। মেমোরি সেভ থাকায় রিপ্লাই দিলে AI ধারাবাহিকভাবে কথা চালিয়ে যাবে।
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {(
              [
                { id: 'auto', label: 'ফ্রি-হ্যান্ড / অটো' },
                { id: 'dm_knock', label: 'ইনবক্স নক (DM)' },
                { id: 'group_mention', label: 'গ্রুপে @মেনশন' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setDirectActionType(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  directActionType === tab.id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-5 bg-slate-50/50">
          {(directActionType === 'dm_knock' || directActionType === 'auto') && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
              <div className="md:col-span-5">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  কন্টাক্ট সিলেক্ট করুন (অথবা নিচে নাম/নাম্বার লিখুন)
                </label>
                <select
                  value={directContactPicker}
                  onChange={(e) => setDirectContactPicker(e.target.value)}
                  className="w-full px-3.5 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-emerald-600"
                >
                  <option value="manual">+ কাস্টম নাম্বার বা নাম লিখবো (অথবা কমান্ড থেকে নেবে)</option>
                  {knownContacts.map((c) => (
                    <option key={c.jid} value={c.jid}>
                      {c.name} {c.phone ? `(+${c.phone})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {directContactPicker === 'manual' && (
                <div className="md:col-span-7">
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    টার্গেট নাম্বার বা কন্টাক্ট নাম (ইনবক্সের জন্য)
                  </label>
                  <input
                    type="text"
                    value={directTargetPhoneOrName}
                    onChange={(e) => setDirectTargetPhoneOrName(e.target.value)}
                    placeholder="যেমন: 01712345678 বা Rafiq (অথবা শুধু কমান্ড বক্সে লিখুন)"
                    className="w-full px-3.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-emerald-600"
                  />
                </div>
              )}
            </div>
          )}

          {(directActionType === 'group_mention' || directActionType === 'auto') && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
                <div className="md:col-span-6">
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    হোয়াটসঅ্যাপ গ্রুপ (গ্রুপে মেনশন দেওয়ার জন্য)
                  </label>
                  <select
                    value={directGroupJid}
                    onChange={(e) => {
                      setDirectGroupJid(e.target.value);
                      setDirectMentionMemberJids([]);
                    }}
                    className="w-full px-3.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-emerald-600"
                  >
                    <option value="">-- গ্রুপ বাছাই করুন --</option>
                    {knownGroups.map((g) => (
                      <option key={g.jid} value={g.jid}>
                        {g.name} ({g.members?.length || g.participantCount || 0} members)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-6 text-[11px] text-slate-500">
                  নিচে ক্লিক করে যাদেরকে গ্রুপে <span className="font-mono text-slate-800">@mention</span> করতে চান সিলেক্ট করুন (একাধিক মেম্বার সিলেক্ট করা যাবে):
                </div>
              </div>

              {directGroupJid && (
                <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pt-1">
                  {(knownGroups.find((g) => g.jid === directGroupJid)?.members || []).length === 0 ? (
                    <span className="text-xs text-slate-500">
                      এই গ্রুপের মেম্বার এখনো লোড হয়নি—WhatsApp কানেক্ট থাকলে "Refresh Groups" চাপুন অথবা কমান্ডে @নাম/নাম্বার লিখুন।
                    </span>
                  ) : (
                    (knownGroups.find((g) => g.jid === directGroupJid)?.members || []).slice(0, 60).map((m) => {
                      const picked = directMentionMemberJids.includes(m.jid);
                      return (
                        <button
                          key={m.jid}
                          type="button"
                          onClick={() => handleToggleDirectMentionMember(m.jid)}
                          className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors cursor-pointer ${
                            picked
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          @{m.name} {m.phone ? `(${m.phone.slice(-4)})` : ''}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-semibold text-slate-800">
                কমান্ড / ইনস্ট্রাকশন বক্স (কী বলবে বা কী কাজ করবে লিখুন)
              </label>
              <button
                type="button"
                onClick={() => setDirectUseAiCraft((v) => !v)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md border cursor-pointer ${
                  directUseAiCraft
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : 'bg-white text-slate-700 border-slate-200'
                }`}
              >
                {directUseAiCraft ? 'AI স্মার্টলি লিখে দেবে' : 'হুবহু মেসেজ পাঠাবে (0 Token)'}
              </button>
            </div>

            <textarea
              rows={3}
              value={directInstruction}
              onChange={(e) => setDirectInstruction(e.target.value)}
              placeholder="উদাহরণ ১: 01712345678 এই নাম্বারে ইনবক্সে নক করে বলো আজকে সন্ধ্যা ৭টায় মিটিং আছে, ফ্রি থাকলে জানাতে।&#10;উদাহরণ ২: গ্রুপে তানভীরকে মেনশন দিয়ে বলো কালকের ট্যুরের হিসাবটা আজকে দিয়ে দিতে।"
              className="w-full px-3.5 py-2.5 text-xs leading-relaxed bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
            />

            <div className="flex flex-wrap gap-1.5">
              {[
                'ইনবক্সে নক দিয়ে বলো কেমন আছেন, আজকে একটু সময় থাকলে কথা বলি।',
                'গ্রুপে @মেনশন দিয়ে বলো আজকের মিটিংয়ের আপডেটটা জানাতে।',
                'ওকে নক দিয়ে বলো কালকে প্রজেক্টের ফাইলটা পাঠিয়ে দিতে।',
              ].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setDirectInstruction(preset)}
                  className="px-2.5 py-1 text-[11px] bg-white border border-slate-200 rounded-md text-slate-600 hover:bg-slate-100 cursor-pointer"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={isExecutingDirectCmd}
              onClick={() => void handleExecuteDirectCommand(true)}
              className="px-4 py-2 text-xs font-medium bg-white text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-100 flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
            >
              <Eye className="w-3.5 h-3.5" />
              {isExecutingDirectCmd ? 'Processing...' : 'Preview Draft (না পাঠিয়ে দেখুন)'}
            </button>
            <button
              type="button"
              disabled={isExecutingDirectCmd}
              onClick={() => void handleExecuteDirectCommand(false)}
              className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
            >
              <Send className="w-3.5 h-3.5" />
              {isExecutingDirectCmd ? 'Sending...' : 'Execute & Send on WhatsApp'}
            </button>
          </div>

          {directCmdResult && (
            <div className="p-4 rounded-xl border border-slate-200 bg-white space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">
                  Target: {directCmdResult.targetLabel}
                </span>
                <span
                  className={`font-mono text-[11px] font-semibold ${
                    directCmdResult.deliveredLive ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {directCmdResult.deliveredLive
                    ? 'LIVE SENT'
                    : directCmdResult.dryRun
                      ? 'PREVIEW'
                      : 'DRAFT (OFFLINE)'}{' '}
                  · {directCmdResult.providerUsed}
                </span>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 whitespace-pre-wrap">
                {directCmdResult.messageText}
              </div>
              <div className="text-[11px] text-slate-600">{directCmdResult.note}</div>
            </div>
          )}

          {directCommandHistory.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-700">
                Recent Executed Commands ({directCommandHistory.length})
              </div>
              <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                {directCommandHistory.slice(0, 8).map((cmd) => (
                  <div key={cmd.id} className="px-4 py-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-medium text-slate-900">
                        [{cmd.actionType === 'group_mention' ? 'GROUP @MENTION' : 'DM KNOCK'}] {cmd.targetLabel}
                      </div>
                      <div className="text-slate-600 truncate">{cmd.messageSent}</div>
                    </div>
                    <span className="font-mono text-[11px] text-slate-400 shrink-0 tabular-nums">
                      {cmd.deliveredLive ? 'Sent' : 'Draft'} · {new Date(cmd.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
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

      {/* Zero-Token Story, Sticker, Photo & Video Intelligence */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Image className="w-4 h-4 text-emerald-600" />
              Zero-Token Story, Sticker, Photo &amp; Video Intelligence
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              AI <span className="font-medium text-slate-900">০ টোকেন খরচে</span> লোকাল পিক্সেল ও মেটাডাটা বিশ্লেষণের মাধ্যমে স্টোরি, ছবি, ভিডিও, স্টিকার ও রিয়্যাকশন পড়ে এবং{' '}
              <span className="font-medium text-slate-900">শুধুমাত্র টেক্সট SMS</span> (ভালো/খারাপ/হাসি/যুক্তি/সুন্দর ছবির প্রশংসা) ও লাইক-রিয়্যাক্টে রিপ্লাই দেয়।
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={busyKey === 'media_zero_mode'}
              onClick={() =>
                void safeUpdate(
                  { mediaZeroTokenReplyMode: !(config.mediaZeroTokenReplyMode !== false) },
                  'media_zero_mode',
                  !(config.mediaZeroTokenReplyMode !== false)
                    ? '100% Zero-Token Media Reply Mode enabled.'
                    : 'Hybrid Mode (0-Token Read + Text AI for Captioned Media) enabled.'
                )
              }
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60 ${
                config.mediaZeroTokenReplyMode !== false
                  ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.mediaZeroTokenReplyMode !== false
                ? 'Reply Mode: 100% Zero-Token'
                : 'Reply Mode: Hybrid (0-Tok Read + Text AI)'}
            </button>

            <button
              type="button"
              disabled={busyKey === 'media_intel_master'}
              onClick={() =>
                void safeUpdate(
                  { mediaIntelligenceEnabled: !(config.mediaIntelligenceEnabled !== false) },
                  'media_intel_master',
                  !(config.mediaIntelligenceEnabled !== false)
                    ? 'Zero-Token Media Intelligence turned ON.'
                    : 'Zero-Token Media Intelligence turned OFF.'
                )
              }
              className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60 ${
                config.mediaIntelligenceEnabled !== false
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {config.mediaIntelligenceEnabled !== false ? 'Media Reader: ON' : 'Media Reader: OFF'}
            </button>
          </div>
        </div>

        <div className="p-6 border-b border-slate-200 bg-slate-50/70 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <button
            type="button"
            disabled={busyKey === 'story_read'}
            onClick={() =>
              void safeUpdate(
                { storyAutoReadEnabled: !(config.storyAutoReadEnabled !== false) },
                'story_read',
                'Story Auto-Read setting saved.'
              )
            }
            className={`px-3.5 py-2.5 text-xs font-medium rounded-lg border flex items-center justify-between gap-2 cursor-pointer ${
              config.storyAutoReadEnabled !== false
                ? 'bg-white border-emerald-200 text-emerald-800'
                : 'bg-white border-slate-200 text-slate-500'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              Story Auto-Read
            </span>
            <span className="font-mono font-semibold">
              {config.storyAutoReadEnabled !== false ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            disabled={busyKey === 'story_react'}
            onClick={() =>
              void safeUpdate(
                { storyAutoReactEnabled: !(config.storyAutoReactEnabled !== false) },
                'story_react',
                'Story Auto-Like setting saved.'
              )
            }
            className={`px-3.5 py-2.5 text-xs font-medium rounded-lg border flex items-center justify-between gap-2 cursor-pointer ${
              config.storyAutoReactEnabled !== false
                ? 'bg-white border-emerald-200 text-emerald-800'
                : 'bg-white border-slate-200 text-slate-500'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Heart className="w-3.5 h-3.5" />
              Story Like Reaction
            </span>
            <span className="font-mono font-semibold">
              {config.storyAutoReactEnabled !== false ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            disabled={busyKey === 'story_reply'}
            onClick={() =>
              void safeUpdate(
                { storyAutoReplyEnabled: !(config.storyAutoReplyEnabled !== false) },
                'story_reply',
                'Story SMS Comment setting saved.'
              )
            }
            className={`px-3.5 py-2.5 text-xs font-medium rounded-lg border flex items-center justify-between gap-2 cursor-pointer ${
              config.storyAutoReplyEnabled !== false
                ? 'bg-white border-emerald-200 text-emerald-800'
                : 'bg-white border-slate-200 text-slate-500'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Story SMS Comment
            </span>
            <span className="font-mono font-semibold">
              {config.storyAutoReplyEnabled !== false ? 'ON' : 'OFF'}
            </span>
          </button>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Story Comment Cooldown
            </label>
            <select
              value={config.storyCooldownMs ?? 900000}
              onChange={(e) =>
                void safeUpdate(
                  { storyCooldownMs: Number(e.target.value) },
                  'story_cooldown',
                  'Story cooldown saved.'
                )
              }
              className="w-full px-3 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            >
              <option value={60000}>1m Cooldown (Test)</option>
              <option value={300000}>5m Cooldown</option>
              <option value={900000}>15m Cooldown (Balanced)</option>
              <option value={3600000}>1h Cooldown</option>
              <option value={21600000}>6h Cooldown</option>
            </select>
          </div>
        </div>

        {/* Custom Story Audience Selector (Whitelist: ONLY Selected Contacts' Stories) */}
        <div className="p-6 border-b border-slate-200 bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-emerald-600" />
                Story Custom Contact Whitelist (শুধু সিলেক্টেড কন্টাক্টের স্টোরি দেখবে ও ইনবক্সে রিপ্লাই দেবে)
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                শুধু স্টোরির ক্ষেত্রে: যাদের নাম/নম্বর এখানে এড করবেন, "Selected Contacts Only" চালু থাকলে একমাত্র তাদের স্টোরিগুলো AI পড়বে, লাইক দেবে এবং সরাসরি ইনবক্স করবে।
              </p>
            </div>

            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 shrink-0">
              <button
                type="button"
                disabled={busyKey === 'story_wl_mode'}
                onClick={() =>
                  void safeUpdate(
                    { storyWhitelistMode: 'all' },
                    'story_wl_mode',
                    'Story mode set to: All Contacts.'
                  )
                }
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  config.storyWhitelistMode !== 'selected_only'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Contacts
              </button>
              <button
                type="button"
                disabled={busyKey === 'story_wl_mode'}
                onClick={() =>
                  void safeUpdate(
                    { storyWhitelistMode: 'selected_only' },
                    'story_wl_mode',
                    'Story mode set to: Selected Contacts Only.'
                  )
                }
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  config.storyWhitelistMode === 'selected_only'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Selected Only ({storyAllowedList.filter((x) => x.enabled !== false).length})
              </button>
            </div>
          </div>

          <form onSubmit={handleAddStoryWhitelistContact} className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-end">
            <div className="lg:col-span-4">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                কন্টাক্ট বাছাই করুন ({knownContacts.length} cached)
              </label>
              <select
                value={storySelectedPicker}
                onChange={(e) => setStorySelectedPicker(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-emerald-600"
              >
                <option value="manual">+ নাম ও নাম্বার ম্যানুয়ালি এড করুন</option>
                {knownContacts.map((c) => (
                  <option key={c.jid} value={c.jid}>
                    {c.name} {c.phone ? `(+${c.phone})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {storySelectedPicker === 'manual' && (
              <>
                <div className="lg:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">নাম (Name)</label>
                  <input
                    type="text"
                    value={storyManualName}
                    onChange={(e) => setStoryManualName(e.target.value)}
                    placeholder="যেমন: Ayesha"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div className="lg:col-span-3">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">নাম্বার (Optional)</label>
                  <input
                    type="text"
                    value={storyManualPhone}
                    onChange={(e) => setStoryManualPhone(e.target.value)}
                    placeholder="017XXXXXXXX"
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </>
            )}

            <div className={storySelectedPicker === 'manual' ? 'lg:col-span-3' : 'lg:col-span-5'}>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                কাস্টম স্টোরি নোট (Optional: প্রশংসা / ফানি / ভদ্র)
              </label>
              <input
                type="text"
                value={storyCustomPrompt}
                onChange={(e) => setStoryCustomPrompt(e.target.value)}
                placeholder="যেমন: সুন্দর ছবি হলে ভীষণ প্রশংসা করবে"
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
              />
            </div>

            <div className={storySelectedPicker === 'manual' ? 'lg:col-span-12 flex justify-end' : 'lg:col-span-3'}>
              <button
                type="submit"
                disabled={busyKey === 'add_story_wl'}
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-60"
              >
                <Plus className="w-3.5 h-3.5" />
                Add to Story Whitelist
              </button>
            </div>
          </form>

          {storyAllowedList.length === 0 ? (
            <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              এখনো কোনো কন্টাক্ট স্টোরি হোয়াইটলিস্টে যোগ করা হয়নি।
              {config.storyWhitelistMode === 'selected_only'
                ? ' সতর্কতা: "Selected Only" চালু আছে কিন্তু লিস্ট খালি থাকায় আপাতত কোনো স্টোরিতে রিপ্লাই যাবে না।'
                : ' চাইলে ওপর থেকে নাম/নাম্বার এড করলে শুধু তাদের স্টোরি দেখা ও ইনবক্স চালু হয়ে যাবে।'}
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
              {storyAllowedList.map((item) => (
                <div key={item.id} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{item.name}</span>
                      {item.phone && (
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums">+{item.phone}</span>
                      )}
                      <span
                        className={`text-[11px] font-medium ${
                          item.enabled !== false ? 'text-emerald-700' : 'text-slate-400'
                        }`}
                      >
                        • {item.enabled !== false ? 'Story Watch ON' : 'Paused'}
                      </span>
                    </div>
                    {item.customPrompt && <div className="text-slate-600">{item.customPrompt}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busyKey === `toggle_story_wl_${item.id}`}
                      onClick={() => void handleToggleStoryWhitelistContact(item.id)}
                      className={`px-2.5 py-1 text-[11px] font-medium border rounded-md cursor-pointer ${
                        item.enabled !== false
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {item.enabled !== false ? 'Pause' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={busyKey === `del_story_wl_${item.id}`}
                      onClick={() => void handleRemoveStoryWhitelistContact(item.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                      title="Remove from story whitelist"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            Recent Zero-Token Media &amp; Story Activity ({mediaStories.length}) — strictly SMS text replies only
          </div>
          <button
            type="button"
            onClick={() => void loadMediaStories()}
            disabled={isLoadingStories}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 flex items-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingStories ? 'animate-spin' : ''}`} />
            Refresh Feed
          </button>
        </div>

        {mediaStories.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            No stories, photos, stickers, or videos analyzed yet today. Test a Story or Photo inside the Command Simulator!
          </div>
        ) : (
          <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
            {mediaStories.slice(0, 15).map((item) => (
              <div key={item.id} className="px-6 py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-3 text-xs">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{item.senderName}</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      [{item.source.toUpperCase()} · {item.banglaSceneLabel}]
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-emerald-700">
                      0 Read Tokens
                    </span>
                  </div>
                  <div className="text-slate-600 break-words">{item.compactContextLine}</div>
                  {item.replySent && (
                    <div className="text-slate-900 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5">
                      {item.reactionSent ? `${item.reactionSent} ` : ''}
                      {item.replySent}
                    </div>
                  )}
                </div>
                <div className="text-[11px] font-mono text-slate-400 whitespace-nowrap shrink-0 tabular-nums">
                  {new Date(item.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
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
