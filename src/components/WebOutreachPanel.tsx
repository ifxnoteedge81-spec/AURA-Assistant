import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Globe,
  Link2,
  Mail,
  MessageCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Square,
  StopCircle,
  Trash2,
} from 'lucide-react';
import { authFetch } from '../lib/api';
import {
  clearCachedGmailSession,
  connectGmailWithGoogle,
  getCachedGmailSession,
} from '../lib/firebase';
import type {
  OutreachEmailProvider,
  OutreachLeadItem,
  OutreachSafetyPolicy,
  OutreachStateResponse,
} from '../types';

interface PendingConfirmState {
  channel: 'email' | 'whatsapp';
  provider: OutreachEmailProvider | 'whatsapp_baileys';
  recipientCount: number;
  recipientsPreview: string[];
  subject: string;
  body: string;
  leadIds: string[];
  directTarget?: string;
}

export function WebOutreachPanel() {
  const [state, setState] = useState<OutreachStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);

  // Gmail OAuth in-memory session (never stored in localStorage/sessionStorage)
  const [gmailEmail, setGmailEmail] = useState<string | null>(
    () => getCachedGmailSession().email
  );
  const [gmailToken, setGmailToken] = useState<string | null>(
    () => getCachedGmailSession().accessToken
  );
  const [connectingGmail, setConnectingGmail] = useState(false);

  // Web Research & Direct URL Scrape inputs
  const [searchQuery, setSearchQuery] = useState('');
  const [useAiSummary, setUseAiSummary] = useState(false);
  const [searching, setSearching] = useState(false);

  const [directUrls, setDirectUrls] = useState('');
  const [scrapingUrls, setScrapingUrls] = useState(false);

  // Manual Lead Add
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualPhone, setManualPhone] = useState('');

  // Lead selection & filtering
  const [leadFilter, setLeadFilter] = useState<'all' | 'has_email' | 'has_phone' | 'wa_verified'>('all');
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [verifyingWa, setVerifyingWa] = useState(false);

  // Composer state
  const [composeChannel, setComposeChannel] = useState<'email' | 'whatsapp'>('email');
  const [emailProvider, setEmailProvider] = useState<OutreachEmailProvider>('gmail_oauth');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [directEmailInput, setDirectEmailInput] = useState('');
  const [directPhoneInput, setDirectPhoneInput] = useState('');
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [sendingOutreach, setSendingOutreach] = useState(false);

  // Safety policy & Render env guide state
  const [policyDraft, setPolicyDraft] = useState<OutreachSafetyPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [showRenderGuide, setShowRenderGuide] = useState(false);

  // Mandatory explicit confirmation modal before mutating/sending emails or WhatsApp messages
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmState | null>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await authFetch('/api/outreach/state');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as OutreachStateResponse;
      setState(data);
      setPolicyDraft((prev) => prev || data.policy);
      setEmailProvider((prev) => prev || data.policy.preferredEmailProvider);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!state?.whatsappQueue.active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadState();
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [state?.whatsappQueue.active, loadState]);

  async function handleConnectGmail() {
    setConnectingGmail(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await connectGmailWithGoogle();
      setGmailToken(res.accessToken);
      setGmailEmail(res.email || 'Authorized Google Account');
      setEmailProvider('gmail_oauth');
      setNoticeMsg(`Gmail অনুমোদিত হয়েছে (${res.email || 'Connected'}) — এখন সরাসরি মেইল পাঠাতে পারবেন।`);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setConnectingGmail(false);
    }
  }

  function handleDisconnectGmail() {
    clearCachedGmailSession();
    setGmailToken(null);
    setGmailEmail(null);
    setNoticeMsg('Gmail OAuth সেশন ডিসকানেক্ট করা হয়েছে।');
  }

  async function handleActivateSender(id: string) {
    setErrorMsg(null);
    try {
      const res = await authFetch('/api/outreach/senders/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not switch email sender.');
      setState(data.state);
      setEmailProvider('smtp_profile');
      setNoticeMsg('অ্যাক্টিভ SMTP/Gmail App Password সেন্ডার পরিবর্তন করা হয়েছে।');
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }

  async function handleDeleteSender(id: string) {
    setErrorMsg(null);
    try {
      const res = await authFetch(`/api/outreach/senders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not remove email sender.');
      setState(data.state);
      setNoticeMsg('সংরক্ষিত ইমেইল সেন্ডার প্রোফাইল ডিলিট করা হয়েছে।');
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }

  async function handleRunWebResearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await authFetch('/api/outreach/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchQuery.trim(),
          useAiSummary,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Web research failed.');
      setState(data.state);
      const r = data.research;
      setNoticeMsg(
        `রিসার্চ সম্পন্ন (${r.providerUsed}, ${r.tokensSpent} টোকেন): ${r.emailsFound}টি ইমেইল ও ${r.phonesFound}টি নম্বর পাওয়া গেছে।`
      );
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function handleScrapeDirectUrls(e: React.FormEvent) {
    e.preventDefault();
    if (!directUrls.trim()) return;
    setScrapingUrls(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await authFetch('/api/outreach/scrape-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: directUrls.trim(),
          topic: searchQuery.trim() || 'Direct Website Scan',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'URL scrape failed.');
      setState(data.state);
      setDirectUrls('');
      setNoticeMsg(data.research?.summary || 'URL স্ক্যান সম্পন্ন (০ টোকেন)।');
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setScrapingUrls(false);
    }
  }

  async function handleAddManualLead(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const res = await authFetch('/api/outreach/leads/add-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: manualName.trim() || 'Manual Contact',
          emails: manualEmail.trim(),
          phones: manualPhone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add contact.');
      setState(data.state);
      setManualName('');
      setManualEmail('');
      setManualPhone('');
      setShowManualAdd(false);
      setNoticeMsg('ম্যানুয়াল কন্টাক্ট Lead Vault-এ যুক্ত হয়েছে।');
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }

  async function handleDeleteLead(id: string) {
    const res = await authFetch(`/api/outreach/leads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = await res.json();
      setState(data.state);
      setSelectedLeadIds((prev) => prev.filter((x) => x !== id));
    }
  }

  async function handleVerifyWhatsApp() {
    setVerifyingWa(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await authFetch('/api/outreach/leads/verify-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: selectedLeadIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'WhatsApp verification failed.');
      setState(data.state);
      setNoticeMsg(
        `০ টোকেনে যাচাই সম্পন্ন: ${data.checkedCount}টি নম্বরের মধ্যে ${data.activeFound}টি WhatsApp সক্রিয় পাওয়া গেছে।`
      );
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setVerifyingWa(false);
    }
  }

  async function handleGenerateDraft(useAi: boolean) {
    setGeneratingDraft(true);
    setErrorMsg(null);
    try {
      const primaryLead = state?.leads.find((l) => selectedLeadIds.includes(l.id)) || state?.leads[0];
      const res = await authFetch('/api/outreach/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: composeChannel,
          useAi,
          leadId: primaryLead?.id,
          leadName: primaryLead?.name || '{{name}}',
          domain: primaryLead?.domain || '{{domain}}',
          topic: primaryLead?.topic || searchQuery.trim(),
          offerPitch: policyDraft?.defaultOfferPitch,
          language: policyDraft?.defaultLanguage || 'bn',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Draft generation failed.');
      if (data.subject !== undefined) setDraftSubject(data.subject);
      setDraftBody(data.body || '');
      setNoticeMsg(
        useAi
          ? `AI ড্রাফট তৈরি হয়েছে (${data.tokensSpent} টোকেন · ${data.providerUsed})।`
          : '০ টোকেনে স্মার্ট টেমপ্লেট ড্রাফট তৈরি হয়েছে (পার্সোনালাইজেশনের জন্য {{name}} / {{domain}} রাখা যাবে)।'
      );
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setGeneratingDraft(false);
    }
  }

  function handleRequestSendConfirmation() {
    setErrorMsg(null);
    if (!draftBody.trim()) {
      setErrorMsg('মেসেজ বা ইমেইল বডি খালি রাখা যাবে না। আগে একটি ড্রাফট তৈরি বা টাইপ করুন।');
      return;
    }

    const selectedLeads = (state?.leads || []).filter((l) => selectedLeadIds.includes(l.id));

    if (composeChannel === 'email') {
      if (!draftSubject.trim()) {
        setErrorMsg('ইমেইলের জন্য Subject লিখুন।');
        return;
      }
      if (emailProvider === 'gmail_oauth' && !gmailToken) {
        setErrorMsg('Gmail Authorization এখনও কানেক্ট করা হয়নি। উপরে "Sign in with Google (Gmail)" বাটনে ক্লিক করুন।');
        return;
      }

      const recipientList: string[] = [];
      if (directEmailInput.trim()) recipientList.push(directEmailInput.trim());
      for (const l of selectedLeads) {
        for (const e of l.emails) {
          if (!recipientList.includes(e)) recipientList.push(e);
        }
      }

      if (recipientList.length === 0) {
        setErrorMsg('তালিকা থেকে অন্তত একটি ইমেইল-যুক্ত Lead সিলেক্ট করুন অথবা সরাসরি একটি ইমেইল দিন।');
        return;
      }

      setPendingConfirm({
        channel: 'email',
        provider: emailProvider,
        recipientCount: recipientList.length,
        recipientsPreview: recipientList.slice(0, 5),
        subject: draftSubject.trim(),
        body: draftBody.trim(),
        leadIds: selectedLeads.map((l) => l.id),
        directTarget: directEmailInput.trim() || undefined,
      });
      return;
    }

    // WhatsApp channel
    const waRecipients: string[] = [];
    if (directPhoneInput.trim()) waRecipients.push(directPhoneInput.trim());
    for (const l of selectedLeads) {
      const phone = l.whatsappVerifiedPhones[0] || l.phones[0];
      if (phone && !waRecipients.includes(phone)) waRecipients.push(phone);
    }

    if (waRecipients.length === 0) {
      setErrorMsg('তালিকা থেকে অন্তত একটি নম্বর-যুক্ত Lead সিলেক্ট করুন অথবা সরাসরি একটি নম্বর দিন।');
      return;
    }

    setPendingConfirm({
      channel: 'whatsapp',
      provider: 'whatsapp_baileys',
      recipientCount: waRecipients.length,
      recipientsPreview: waRecipients.slice(0, 5),
      subject: '',
      body: draftBody.trim(),
      leadIds: selectedLeads.map((l) => l.id),
      directTarget: directPhoneInput.trim() || undefined,
    });
  }

  async function handleExecuteConfirmedOutreach() {
    if (!pendingConfirm) return;
    const action = pendingConfirm;
    setPendingConfirm(null);
    setSendingOutreach(true);
    setErrorMsg(null);
    setNoticeMsg(null);

    try {
      if (action.channel === 'email') {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (action.provider === 'gmail_oauth' && gmailToken) {
          headers['X-Gmail-Access-Token'] = gmailToken;
        }
        const res = await authFetch('/api/outreach/send-email', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            confirmedByUser: true,
            provider: action.provider,
            subject: action.subject,
            body: action.body,
            leadIds: action.leadIds,
            directEmail: action.directTarget,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Email dispatch failed.');
        setState(data.state);
        setNoticeMsg(
          `ইমেইল ডিসপ্যাচ সম্পন্ন: ${data.sentCount}টি পাঠানো হয়েছে${
            data.failedCount > 0 ? `, ${data.failedCount}টি ব্যর্থ` : ''
          } (০ AI টোকেন)।`
        );
      } else {
        const res = await authFetch('/api/outreach/send-whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirmedByUser: true,
            body: action.body,
            leadIds: action.leadIds,
            directPhone: action.directTarget,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'WhatsApp dispatch failed.');
        setState(data.state);
        setNoticeMsg(
          data.queued
            ? `অ্যান্টি-ব্যান কিউ চালু হয়েছে: ${data.totalQueued} জনকে ৪৫–৯০ সেকেন্ড বিরতিতে পাঠানো হচ্ছে।`
            : 'হোয়াটসঅ্যাপ মেসেজ সফলভাবে পাঠানো হয়েছে (০ AI টোকেন)।'
        );
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSendingOutreach(false);
    }
  }

  async function handleStopWhatsappQueue() {
    const res = await authFetch('/api/outreach/whatsapp-queue/stop', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      setState(data.state);
      setNoticeMsg('WhatsApp আউটরিচ কিউ থামানোর নির্দেশ দেওয়া হয়েছে।');
    }
  }

  async function handleSavePolicy(e: React.FormEvent) {
    e.preventDefault();
    if (!policyDraft) return;
    setSavingPolicy(true);
    setErrorMsg(null);
    try {
      const res = await authFetch('/api/outreach/policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...policyDraft,
          preferredEmailProvider: emailProvider,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed saving policy.');
      setState(data.state);
      setPolicyDraft(data.policy);
      setNoticeMsg('আউটরিচ সেফটি নীতি ও দৈনিক লিমিট সেভ হয়েছে।');
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSavingPolicy(false);
    }
  }

  const filteredLeads = useMemo(() => {
    const list = state?.leads || [];
    if (leadFilter === 'has_email') return list.filter((l) => l.emails.length > 0);
    if (leadFilter === 'has_phone') return list.filter((l) => l.phones.length > 0);
    if (leadFilter === 'wa_verified') return list.filter((l) => l.whatsappVerifiedPhones.length > 0);
    return list;
  }, [state?.leads, leadFilter]);

  function toggleSelectLead(id: string) {
    setSelectedLeadIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleSelectAllFiltered() {
    const ids = filteredLeads.map((l) => l.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedLeadIds.includes(id));
    setSelectedLeadIds(allSelected ? [] : ids);
  }

  if (loading && !state) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-sm text-slate-500">
        Loading Web Research &amp; Outreach console...
      </div>
    );
  }

  const caps = state?.capabilities;
  const stats = state?.stats;
  const policy = state?.policy;

  return (
    <div className="space-y-6">
      {/* Header Summary Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Web Research, Lead Collector &amp; Outreach Console
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>Zero-Token HTML Lead Extractor</span>
              <span aria-hidden="true">·</span>
              <span>Gmail OAuth &amp; HTTP Email APIs</span>
              <span aria-hidden="true">·</span>
              <span>Anti-Ban WhatsApp Queue</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-slate-700">
                RAM {state?.memoryRssMb || 0} MB
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void loadState()}
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>

        {/* 4-column flat tabular metrics */}
        <div className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-slate-500">Emails Sent Today</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
              {stats?.emailsSentToday ?? 0} / {policy?.dailyEmailLimit ?? 30}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">WhatsApp Leads Today</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
              {stats?.whatsappSentToday ?? 0} / {policy?.dailyWhatsappLimit ?? 20}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Collected Leads</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
              {stats?.totalLeads ?? 0}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">WA Verified Leads</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-emerald-700">
              {stats?.whatsappVerifiedCount ?? 0}
            </div>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex items-start justify-between gap-3">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-700 font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {noticeMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl px-4 py-3 text-xs flex items-start justify-between gap-3">
          <span>{noticeMsg}</span>
          <button
            type="button"
            onClick={() => setNoticeMsg(null)}
            className="text-emerald-700 font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            OK
          </button>
        </div>
      )}

      {/* Email & Search Engine Connectivity + Render Env Setup Guide */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Gmail Authorization &amp; Free Search / HTTP Email Status
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Gmail দিয়ে সরাসরি পাঠাতে Google অনুমতি নিন; Resend / Brevo / Tavily / Serper কীগুলো Render Environment Variables থেকে স্বয়ংক্রিয়ভাবে যুক্ত হয়।
            </p>
          </div>

          {/* Official Google Sign-in button for Gmail scope */}
          <div className="flex items-center gap-2.5 shrink-0">
            {gmailToken ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-emerald-700 font-medium">
                  Gmail Connected: {gmailEmail}
                </span>
                <button
                  type="button"
                  onClick={handleDisconnectGmail}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Disconnect Gmail
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleConnectGmail()}
                disabled={connectingGmail}
                className="inline-flex items-center gap-2.5 px-4 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                </svg>
                {connectingGmail ? 'Connecting Gmail...' : 'Sign in with Google (Gmail)'}
              </button>
            )}
          </div>
        </div>

        {/* Clean Unboxed Provider Readiness Table */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-slate-100 text-xs">
          <div>
            <div className="text-slate-500">Gmail Authorization</div>
            <div className={`mt-0.5 font-medium ${gmailToken ? 'text-emerald-700' : 'text-amber-700'}`}>
              {gmailToken ? 'Ready (Session Active)' : 'Click Sign in above'}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Resend / Brevo / Custom HTTP</div>
            <div className="mt-0.5 font-medium text-slate-800">
              {caps?.resendConfigured ? 'Resend Active' : 'Resend Off'}
              {' · '}
              {caps?.brevoConfigured ? 'Brevo Active' : 'Brevo Off'}
              {caps?.customEmailWebhookConfigured ? ' · HTTP Relay Active' : ''}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Free Search (0 AI Tokens)</div>
            <div className="mt-0.5 font-medium text-slate-800">
              {caps?.tavilyConfigured ? 'Tavily Active' : 'Tavily Env Not Set'}
              {' · '}
              {caps?.serperConfigured ? 'Serper Active' : 'Serper Env Not Set'}
              {' · '}
              DDG Lite Ready
            </div>
          </div>
          <div>
            <div className="text-slate-500">AI Search &amp; Draft Brain</div>
            <div className="mt-0.5 font-medium text-slate-800">
              {caps?.geminiSearchConfigured ? 'Gemini Pool Ready' : 'Gemini Off'}
              {' · '}
              {caps?.whatsappConnected ? 'WA Connected' : 'WA Offline'}
            </div>
          </div>
        </div>

        {/* Saved Multi-Account Sender Profiles (Configured via WhatsApp Self-Chat App Password) */}
        <div className="pt-3 border-t border-slate-100 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-800">
              Active Self-Chat Email Senders (Any Gmail via 16-digit App Password):
            </span>
            <span className="text-slate-500">
              যেকোনো জিমেইল যুক্ত/বদল করতে আপনার WhatsApp Self-Chat-এ ইমেইল ও ১৬ সংখ্যার Google App Password লিখে পাঠান
            </span>
          </div>
          {state?.emailSenders && state.emailSenders.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {state.emailSenders.map((snd) => (
                <div
                  key={snd.id}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs ${
                    snd.active
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  <span className="font-medium">{snd.email}</span>
                  <span className="text-[11px] font-mono text-slate-500">{snd.maskedSecret}</span>
                  {!snd.active && (
                    <button
                      type="button"
                      onClick={() => void handleActivateSender(snd.id)}
                      className="text-[11px] font-medium text-emerald-700 hover:underline cursor-pointer"
                    >
                      Use
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDeleteSender(snd.id)}
                    className="text-slate-400 hover:text-red-600 cursor-pointer"
                    title="Delete sender"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              এখনো কোনো App Password সেন্ডার সেভ নেই (OAuth ছাড়া অন্য যেকোনো জিমেইল ব্যবহারের জন্য সেলফ-চ্যাটে ১৬ সংখ্যার App Password দিন)।
            </div>
          )}
        </div>

        {/* Render Environment Variable Guide Toggle */}
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setShowRenderGuide((v) => !v)}
            className="text-xs font-medium text-slate-700 hover:text-slate-900 flex items-center gap-1.5 cursor-pointer"
          >
            {showRenderGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Render Environment Variables যুক্ত করার নিয়ম (Tavily, Serper, Resend, Brevo)
          </button>

          {showRenderGuide && (
            <div className="mt-3 p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 space-y-2 leading-relaxed">
              <div className="font-semibold text-slate-900">
                Render Dashboard → আপনার সার্ভিস → Environment → Add Environment Variable:
              </div>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <code className="font-mono text-slate-900">TAVILY_API_KEY</code> — Tavily (মাসে ১,০০০ ফ্রি ওয়েব সার্চ, ০ AI টোকেন)। একাধিক কী দিলে <code className="font-mono">TAVILY_API_KEY_1</code>, <code className="font-mono">TAVILY_API_KEY_2</code> ব্যবহার করা যাবে।
                </li>
                <li>
                  <code className="font-mono text-slate-900">SERPER_API_KEY</code> — Serper.dev (২,৫০০ ফ্রি Google সার্চ, ০ AI টোকেন)।
                </li>
                <li>
                  <code className="font-mono text-slate-900">RESEND_API_KEY</code> ও <code className="font-mono text-slate-900">RESEND_FROM_EMAIL</code> — Resend HTTP Email API (দিনে ১০০ ফ্রি মেইল, HTTPS পোর্ট ৪৪৩)।
                </li>
                <li>
                  <code className="font-mono text-slate-900">BREVO_API_KEY</code> ও <code className="font-mono text-slate-900">BREVO_FROM_EMAIL</code> — Brevo HTTP Email API (দিনে ৩০০ ফ্রি মেইল)।
                </li>
                <li>
                  <code className="font-mono text-slate-900">CUSTOM_EMAIL_WEBHOOK_URL</code> ও <code className="font-mono text-slate-900">CUSTOM_EMAIL_WEBHOOK_TOKEN</code> — নিজস্ব কোনো HTTP Email রিলে থাকলে।
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Section 1: Web Research + Direct URL Scraper */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <form
          onSubmit={handleRunWebResearch}
          className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Search className="w-4 h-4 text-emerald-700" />
              <span>Web Research &amp; Lead Discovery</span>
            </div>
            <p className="text-xs text-slate-500">
              যেকোনো টপিক বা ইন্ডাস্ট্রি লিখে সার্চ করুন। সিস্টেম ফ্রি সার্চ (Tavily / Serper / DuckDuckGo) দিয়ে ওয়েবসাইট খুঁজে ০ টোকেনে ইমেইল ও ফোন নম্বর সংগ্রহ করবে।
            </p>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="উদাহরণ: Dhaka software company contact email phone"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
            />
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={useAiSummary}
                onChange={(e) => setUseAiSummary(e.target.checked)}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
              />
              <span>ফ্রি সার্চ না পেলে বা রিপোর্ট চাইলে AI Search Summary ব্যবহার করো (অন্যথায় ০ টোকেন)</span>
            </label>
          </div>
          <button
            type="submit"
            disabled={searching}
            className="w-full px-4 py-2 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-60"
          >
            <Globe className="w-3.5 h-3.5" />
            {searching ? 'Researching & Extracting...' : 'Search Web & Collect Leads'}
          </button>
        </form>

        <form
          onSubmit={handleScrapeDirectUrls}
          className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Link2 className="w-4 h-4 text-slate-700" />
              <span>Direct Website Contact Extractor (0 Tokens)</span>
            </div>
            <p className="text-xs text-slate-500">
              এক বা একাধিক ওয়েবসাইটের URL দিন (প্রতি লাইনে বা কমা দিয়ে)। কন্টাক্ট পেজ সহ স্ক্যান করে ০ টোকেনে ইমেইল ও নম্বর বের করবে।
            </p>
            <textarea
              rows={2}
              value={directUrls}
              onChange={(e) => setDirectUrls(e.target.value)}
              placeholder="https://example-company.com"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
            />
          </div>
          <button
            type="submit"
            disabled={scrapingUrls}
            className="w-full px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-60"
          >
            <Play className="w-3.5 h-3.5" />
            {scrapingUrls ? 'Extracting...' : 'Scan URL(s) with 0 AI Tokens'}
          </button>
        </form>
      </div>

      {/* Latest Research Summary Output */}
      {state && state.researchHistory.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              সর্বশেষ রিসার্চ রিপোর্ট: {state.researchHistory[0].query}
            </h3>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {state.researchHistory[0].providerUsed} · {state.researchHistory[0].tokensSpent} tokens
            </span>
          </div>
          <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
            {state.researchHistory[0].summary}
          </p>
          {state.researchHistory[0].urls.length > 0 && (
            <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              {state.researchHistory[0].urls.slice(0, 6).map((u, idx) => (
                <a
                  key={`${u.url}_${idx}`}
                  href={u.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-emerald-700 truncate max-w-[260px]"
                >
                  {u.title || u.url}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Section 2: Lead Vault Table */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Lead Vault ({filteredLeads.length})
            </h2>
            <p className="text-xs text-slate-500">
              মেইল বা হোয়াটসঅ্যাপ পাঠাতে তালিকা থেকে কন্টাক্ট সিলেক্ট করুন।
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Segmented Filter */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'has_email', label: 'Emails' },
                  { id: 'has_phone', label: 'Phones' },
                  { id: 'wa_verified', label: 'WA Active' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setLeadFilter(tab.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    leadFilter === tab.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void handleVerifyWhatsApp()}
              disabled={verifyingWa}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
            >
              {verifyingWa ? 'Checking WA...' : 'Verify WhatsApp (0 Tokens)'}
            </button>

            <button
              type="button"
              onClick={() => setShowManualAdd((v) => !v)}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Contact
            </button>
          </div>
        </div>

        {showManualAdd && (
          <form
            onSubmit={handleAddManualLead}
            className="p-4 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 md:grid-cols-4 gap-3"
          >
            <input
              type="text"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="Name / Business"
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            />
            <input
              type="text"
              value={manualEmail}
              onChange={(e) => setManualEmail(e.target.value)}
              placeholder="Email(s)"
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            />
            <input
              type="text"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              placeholder="Phone(s) e.g. 017..."
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap cursor-pointer"
            >
              Save Lead
            </button>
          </form>
        )}

        {filteredLeads.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg">
            এখনো কোনো Lead সংরক্ষিত নেই। উপরে Web Research বা Direct Website URL স্ক্যান করে সংগ্রহ করুন।
          </div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="py-2.5 px-3 w-8">
                    <button
                      type="button"
                      onClick={toggleSelectAllFiltered}
                      className="text-slate-600 hover:text-slate-900 cursor-pointer"
                      title="Select All"
                    >
                      {filteredLeads.length > 0 &&
                      filteredLeads.every((l) => selectedLeadIds.includes(l.id)) ? (
                        <CheckSquare className="w-4 h-4 text-emerald-700" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>
                  </th>
                  <th className="py-2.5 px-3 font-medium">Business / Source</th>
                  <th className="py-2.5 px-3 font-medium">Emails</th>
                  <th className="py-2.5 px-3 font-medium">Phones &amp; WA Status</th>
                  <th className="py-2.5 px-3 font-medium text-right">Sent</th>
                  <th className="py-2.5 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLeads.slice(0, 60).map((lead: OutreachLeadItem) => {
                  const checked = selectedLeadIds.includes(lead.id);
                  return (
                    <tr key={lead.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 align-top">
                        <button
                          type="button"
                          onClick={() => toggleSelectLead(lead.id)}
                          className="text-slate-600 hover:text-slate-900 cursor-pointer"
                        >
                          {checked ? (
                            <CheckSquare className="w-4 h-4 text-emerald-700" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 align-top max-w-[230px]">
                        <div className="font-medium text-slate-900 truncate" title={lead.name}>
                          {lead.name}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">{lead.domain}</div>
                      </td>
                      <td className="py-2.5 px-3 align-top font-mono text-slate-700">
                        {lead.emails.length > 0 ? lead.emails.join(', ') : '—'}
                      </td>
                      <td className="py-2.5 px-3 align-top font-mono text-slate-700">
                        <div>{lead.phones.length > 0 ? lead.phones.join(', ') : '—'}</div>
                        {lead.whatsappCheckedAt && (
                          <div
                            className={`text-[11px] font-sans ${
                              lead.whatsappVerifiedPhones.length > 0
                                ? 'text-emerald-700'
                                : 'text-slate-400'
                            }`}
                          >
                            {lead.whatsappVerifiedPhones.length > 0
                              ? `WA Active: ${lead.whatsappVerifiedPhones.join(', ')}`
                              : 'No WhatsApp'}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 align-top text-right font-mono tabular-nums text-slate-600">
                        E:{lead.emailSentCount} · W:{lead.whatsappSentCount}
                      </td>
                      <td className="py-2.5 px-3 align-top text-right">
                        <button
                          type="button"
                          onClick={() => void handleDeleteLead(lead.id)}
                          className="text-slate-400 hover:text-red-600 cursor-pointer"
                          title="Delete lead"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 3: Dual-Channel Outreach Composer + Safety Policy */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Composer (7 cols) */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Outreach Message &amp; Email Composer
            </h2>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setComposeChannel('email')}
                className={`px-3 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  composeChannel === 'email'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                Email Outreach
              </button>
              <button
                type="button"
                onClick={() => setComposeChannel('whatsapp')}
                className={`px-3 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  composeChannel === 'whatsapp'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <MessageCircle className="w-3.5 h-3.5" />
                WhatsApp Outreach
              </button>
            </div>
          </div>

          {composeChannel === 'email' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Email Delivery Method
                </label>
                <select
                  value={emailProvider}
                  onChange={(e) => setEmailProvider(e.target.value as OutreachEmailProvider)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="gmail_oauth">Gmail Authorization (Primary · 30/day safe)</option>
                  <option value="smtp_profile">Saved Gmail App Password / SMTP Sender Profile</option>
                  <option value="resend_http">Resend HTTP API (100/day free)</option>
                  <option value="brevo_http">Brevo HTTP API (300/day free)</option>
                  <option value="custom_http">Custom HTTP Email Webhook</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Direct Email (Optional if selected above)
                </label>
                <input
                  type="email"
                  value={directEmailInput}
                  onChange={(e) => setDirectEmailInput(e.target.value)}
                  placeholder="client@company.com"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Direct Phone (Optional if selected from Lead Vault)
              </label>
              <input
                type="text"
                value={directPhoneInput}
                onChange={(e) => setDirectPhoneInput(e.target.value)}
                placeholder="017XXXXXXXX or +88017..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
          )}

          {composeChannel === 'email' && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Email Subject
              </label>
              <input
                type="text"
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
                placeholder="{{name}}-এর জন্য সহযোগিতা ও অটোমেশন প্রস্তাব"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-700">
                Message Body (Supports {'{{name}}'} &amp; {'{{domain}}'})
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleGenerateDraft(false)}
                  disabled={generatingDraft}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                >
                  0-Token Draft
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerateDraft(true)}
                  disabled={generatingDraft}
                  className="px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 whitespace-nowrap cursor-pointer"
                >
                  AI Brain Draft
                </button>
              </div>
            </div>
            <textarea
              rows={6}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="কাস্টমারকে পাঠানোর মেসেজ লিখুন বা উপরের '0-Token Draft' বাটনে ক্লিক করুন..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              Selected Leads: {selectedLeadIds.length}
            </div>
            <button
              type="button"
              onClick={handleRequestSendConfirmation}
              disabled={sendingOutreach}
              className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-60"
            >
              <Send className="w-3.5 h-3.5" />
              {composeChannel === 'email' ? 'Review & Send Email' : 'Review & Send WhatsApp'}
            </button>
          </div>

          {/* Active WhatsApp Queue Status */}
          {state?.whatsappQueue.active && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-3 text-xs">
              <div className="text-slate-700">
                <span className="font-medium">WhatsApp Queue Running:</span>{' '}
                <span className="font-mono tabular-nums">
                  {state.whatsappQueue.processed}/{state.whatsappQueue.total}
                </span>{' '}
                · Current: {state.whatsappQueue.currentRecipient || 'Waiting human delay...'}
              </div>
              <button
                type="button"
                onClick={() => void handleStopWhatsappQueue()}
                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 bg-white rounded-md hover:bg-red-50 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <StopCircle className="w-3.5 h-3.5" />
                Stop Queue
              </button>
            </div>
          )}
        </div>

        {/* Safety Policy & Daily Guardrails (5 cols) */}
        <form
          onSubmit={handleSavePolicy}
          className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <ShieldAlert className="w-4 h-4 text-amber-600" />
            <span>Safety Limits &amp; Usage Policy</span>
          </div>
          <p className="text-xs text-slate-500">
            আপনার Gmail এবং WhatsApp অ্যাকাউন্ট ব্যান/স্প্যাম থেকে বাঁচাতে দৈনিক কোটা ও হিউম্যান বিরতি নির্ধারণ করুন।
          </p>

          {policyDraft && (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Daily Email Limit
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={policyDraft.dailyEmailLimit}
                    onChange={(e) =>
                      setPolicyDraft({ ...policyDraft, dailyEmailLimit: Number(e.target.value) })
                    }
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Daily WA New-Lead Limit
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={40}
                    value={policyDraft.dailyWhatsappLimit}
                    onChange={(e) =>
                      setPolicyDraft({
                        ...policyDraft,
                        dailyWhatsappLimit: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono tabular-nums"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    WA Min Delay (sec)
                  </label>
                  <input
                    type="number"
                    min={15}
                    max={300}
                    value={Math.round(policyDraft.whatsappMinDelayMs / 1000)}
                    onChange={(e) =>
                      setPolicyDraft({
                        ...policyDraft,
                        whatsappMinDelayMs: Number(e.target.value) * 1000,
                      })
                    }
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Draft Language
                  </label>
                  <select
                    value={policyDraft.defaultLanguage}
                    onChange={(e) =>
                      setPolicyDraft({
                        ...policyDraft,
                        defaultLanguage: e.target.value === 'en' ? 'en' : 'bn',
                      })
                    }
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="bn">Bengali (বাংলা)</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Your Offer / Service Pitch (Used in 0-Token Drafts)
                </label>
                <textarea
                  rows={3}
                  value={policyDraft.defaultOfferPitch}
                  onChange={(e) =>
                    setPolicyDraft({ ...policyDraft, defaultOfferPitch: e.target.value })
                  }
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg"
                />
              </div>

              <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={policyDraft.crawlContactSubpages}
                  onChange={(e) =>
                    setPolicyDraft({ ...policyDraft, crawlContactSubpages: e.target.checked })
                  }
                  className="rounded border-slate-300 text-emerald-600"
                />
                <span>স্বয়ংক্রিয়ভাবে /contact এবং /about সাব-পেজ স্ক্যান করো (০ টোকেন)</span>
              </label>

              <button
                type="submit"
                disabled={savingPolicy}
                className="w-full px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap cursor-pointer disabled:opacity-60"
              >
                {savingPolicy ? 'Saving Policy...' : 'Save Safety Policy'}
              </button>
            </div>
          )}
        </form>
      </div>

      {/* Dispatch Audit Logs */}
      {state && state.dispatchLogs.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Recent Outreach Dispatch Log</h3>
          <div className="divide-y divide-slate-100 text-xs">
            {state.dispatchLogs.slice(0, 10).map((log) => (
              <div key={log.id} className="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <div className="text-slate-800">
                  <span className="font-medium uppercase">{log.channel}</span> ·{' '}
                  <span className="font-mono">{log.recipient}</span> ({log.provider})
                </div>
                <div className="flex items-center gap-3 text-slate-500">
                  <span
                    className={
                      log.status === 'sent'
                        ? 'text-emerald-700 font-medium'
                        : 'text-red-600 font-medium'
                    }
                  >
                    {log.status === 'sent' ? 'Sent' : `Failed: ${log.error || 'Error'}`}
                  </span>
                  <span className="font-mono tabular-nums">
                    {log.timestamp.slice(11, 19)} UTC
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mandatory Explicit User Confirmation Modal before Sending Emails / WhatsApp Outreach */}
      {pendingConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 space-y-4 shadow-lg">
            <h3 className="text-base font-semibold text-slate-900">
              {pendingConfirm.channel === 'email'
                ? `Send Email to ${pendingConfirm.recipientCount} recipient(s)?`
                : `Send WhatsApp Message to ${pendingConfirm.recipientCount} recipient(s)?`}
            </h3>
            <div className="text-xs text-slate-600 space-y-2">
              <div>
                <span className="font-medium text-slate-800">Provider:</span>{' '}
                {pendingConfirm.provider}
              </div>
              <div>
                <span className="font-medium text-slate-800">Recipients Preview:</span>{' '}
                <span className="font-mono">{pendingConfirm.recipientsPreview.join(', ')}</span>
                {pendingConfirm.recipientCount > 5 && ` (+${pendingConfirm.recipientCount - 5} more)`}
              </div>
              {pendingConfirm.subject && (
                <div>
                  <span className="font-medium text-slate-800">Subject:</span>{' '}
                  {pendingConfirm.subject}
                </div>
              )}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-700">
                {pendingConfirm.body}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setPendingConfirm(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleExecuteConfirmedOutreach()}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 whitespace-nowrap cursor-pointer"
              >
                Confirm &amp; Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
