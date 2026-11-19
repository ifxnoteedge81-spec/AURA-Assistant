import { authFetch } from './api';

export interface LocalDeviceStats {
  workerId: string;
  deviceLabel: string;
  deviceMemoryGb: number | null;
  networkType: string;
}

function getOrCreateWorkerId(): string {
  try {
    const existing = localStorage.getItem('wanexus_mobile_worker_id');
    if (existing) return existing;
    const created = `pwa_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('wanexus_mobile_worker_id', created);
    return created;
  } catch {
    return 'pwa_browser_worker';
  }
}

export function getLocalDeviceInfo(): LocalDeviceStats {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string } }) : undefined;
  const mem = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
  const net = String(nav?.connection?.effectiveType || (typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline'));
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const deviceLabel = isAndroid ? 'Android Mobile PWA' : isIOS ? 'iPhone/iPad PWA' : 'Browser Offload Worker';

  return {
    workerId: getOrCreateWorkerId(),
    deviceLabel,
    deviceMemoryGb: mem,
    networkType: net,
  };
}

function extractContactsFromText(rawText: string) {
  const emails = Array.from(
    new Set(
      (rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,12}/g) || [])
        .map((e) => e.toLowerCase())
        .filter((e) => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.includes('example.com'))
    )
  ).slice(0, 15);

  const phones = Array.from(
    new Set(
      (rawText.match(/(?:\+?88)?01[3-9]\d{8}|\+\d{1,3}[\s-]?\d{6,12}/g) || []).map((p) =>
        p.replace(/[^\d+]/g, '')
      )
    )
  ).slice(0, 15);

  return { emails, phones };
}

async function runBrowserScrapeJob(url: string): Promise<Record<string, unknown>> {
  let text = '';
  let title = url;
  // Use mobile browser network first; fallback to Jina Reader if target blocks cross-origin browser fetch
  try {
    const directResp = await fetch(url, { mode: 'cors' });
    if (directResp.ok) {
      const html = await directResp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      title = doc.title?.trim() || url;
      text = doc.body?.innerText || html;
    }
  } catch {
    // CORS fallback via Jina Reader using mobile data
  }

  if (!text || text.trim().length < 60) {
    const jinaResp = await fetch(`https://r.jina.ai/${url}`);
    if (!jinaResp.ok) {
      throw new Error(`Mobile browser fetch HTTP ${jinaResp.status}`);
    }
    text = (await jinaResp.text()).slice(0, 120_000);
    const titleLine = text.split('\n').find((l) => l.toLowerCase().startsWith('title:'));
    if (titleLine) title = titleLine.replace(/^title:\s*/i, '').trim() || title;
  }

  const { emails, phones } = extractContactsFromText(text);
  return {
    url,
    title: title.slice(0, 140),
    emails,
    phones,
    snippet: text.replace(/\s+/g, ' ').trim().slice(0, 220),
    processedOn: 'mobile_browser_ram',
  };
}

export async function analyzeMediaInBrowserCanvas(dataUrl: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = 160;
      const h = Math.max(90, Math.round((img.height / Math.max(1, img.width)) * 160));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      let totalLum = 0;
      const count = pixels.length / 4;
      for (let i = 0; i < pixels.length; i += 4) {
        totalLum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      }
      const avgBrightness = Math.round(totalLum / Math.max(1, count));
      const compactThumbDataUrl = canvas.toDataURL('image/jpeg', 0.55);
      resolve({
        width: img.width,
        height: img.height,
        aspect: img.width >= img.height ? 'landscape' : 'portrait',
        avgBrightness,
        compactThumbDataUrl,
        processedOn: 'mobile_browser_canvas',
      });
    };
    img.onerror = () => reject(new Error('Failed to decode media in browser canvas'));
    img.src = dataUrl;
  });
}

export async function sendMobileOffloadHeartbeat() {
  const info = getLocalDeviceInfo();
  const resp = await authFetch('/api/offload/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(info),
  });
  return resp.ok ? resp.json() : null;
}

export async function pollAndRunNextOffloadJob(): Promise<boolean> {
  const info = getLocalDeviceInfo();
  const resp = await authFetch(`/api/offload/next?workerId=${encodeURIComponent(info.workerId)}`);
  if (!resp.ok) return false;
  const data = (await resp.json()) as {
    job?: { id: string; type: string; payload: Record<string, unknown> } | null;
  };
  const job = data?.job;
  if (!job) return false;

  try {
    let result: Record<string, unknown> = {};
    if (job.type === 'scrape_url' || job.type === 'extract_dom_links') {
      const url = String(job.payload?.url || '').trim();
      if (!url) throw new Error('Missing URL in offload job');
      result = await runBrowserScrapeJob(url);
    } else if (job.type === 'analyze_media_dataurl') {
      const dataUrl = String(job.payload?.dataUrl || '').trim();
      if (!dataUrl) throw new Error('Missing dataUrl');
      result = await analyzeMediaInBrowserCanvas(dataUrl);
    } else {
      throw new Error(`Unsupported offload type: ${job.type}`);
    }

    await authFetch(`/api/offload/${encodeURIComponent(job.id)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: info.workerId,
        ok: true,
        result,
      }),
    });
    return true;
  } catch (err) {
    await authFetch(`/api/offload/${encodeURIComponent(job.id)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: info.workerId,
        ok: false,
        error: (err as Error).message,
      }),
    });
    return false;
  }
}
