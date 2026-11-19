import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';

export type MobileOffloadJobType = 'scrape_url' | 'analyze_media_dataurl' | 'extract_dom_links';

export interface MobileOffloadWorkerInfo {
  workerId: string;
  deviceLabel: string;
  deviceMemoryGb: number | null;
  networkType: string;
  userAgent: string;
  lastHeartbeatAt: number;
  jobsCompleted: number;
}

export interface MobileOffloadJob {
  id: string;
  type: MobileOffloadJobType;
  status: 'queued' | 'claimed' | 'completed' | 'failed';
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  workerId?: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
}

const OFFLOAD_FILE = path.resolve('./bot-offload-queue.json');
const MAX_STORED_JOBS = 30;
const WORKER_ACTIVE_TTL_MS = 45_000;

export class MobileOffloadQueueManager {
  private readonly workers = new Map<string, MobileOffloadWorkerInfo>();
  private jobs: MobileOffloadJob[] = [];
  private readonly waiters = new Map<string, Array<(job: MobileOffloadJob) => void>>();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(OFFLOAD_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(OFFLOAD_FILE, 'utf8'));
        if (Array.isArray(parsed?.jobs)) {
          this.jobs = parsed.jobs.slice(0, MAX_STORED_JOBS);
        }
      }
    } catch {
      this.jobs = [];
    }
  }

  private saveToDisk() {
    try {
      this.jobs = this.jobs.slice(0, MAX_STORED_JOBS);
      fs.writeFileSync(
        OFFLOAD_FILE,
        JSON.stringify({ jobs: this.jobs, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore non-fatal disk write error
    }
  }

  public recordHeartbeat(input: {
    workerId: string;
    deviceLabel?: string;
    deviceMemoryGb?: number | null;
    networkType?: string;
    userAgent?: string;
  }): MobileOffloadWorkerInfo {
    const id = String(input.workerId || '').trim().slice(0, 80) || 'mobile-pwa';
    const prev = this.workers.get(id);
    const worker: MobileOffloadWorkerInfo = {
      workerId: id,
      deviceLabel: String(input.deviceLabel || prev?.deviceLabel || 'Mobile Browser Worker').slice(0, 80),
      deviceMemoryGb: typeof input.deviceMemoryGb === 'number' ? input.deviceMemoryGb : (prev?.deviceMemoryGb ?? null),
      networkType: String(input.networkType || prev?.networkType || 'unknown').slice(0, 32),
      userAgent: String(input.userAgent || prev?.userAgent || '').slice(0, 120),
      lastHeartbeatAt: Date.now(),
      jobsCompleted: prev?.jobsCompleted || 0,
    };
    this.workers.set(id, worker);
    return worker;
  }

  public getActiveWorkers(): MobileOffloadWorkerInfo[] {
    const now = Date.now();
    const active: MobileOffloadWorkerInfo[] = [];
    for (const [id, worker] of this.workers.entries()) {
      if (now - worker.lastHeartbeatAt <= WORKER_ACTIVE_TTL_MS) {
        active.push(worker);
      } else {
        this.workers.delete(id);
      }
    }
    return active;
  }

  public hasActiveWorker(): boolean {
    return this.getActiveWorkers().length > 0;
  }

  public enqueueJob(type: MobileOffloadJobType, payload: Record<string, unknown>): MobileOffloadJob {
    const job: MobileOffloadJob = {
      id: `off_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      status: 'queued',
      payload,
      createdAt: new Date().toISOString(),
    };
    this.jobs.unshift(job);
    this.saveToDisk();
    return job;
  }

  public claimNextJob(workerId: string): MobileOffloadJob | null {
    const now = Date.now();
    // Recover stalled claimed jobs (> 60s old)
    for (const j of this.jobs) {
      if (j.status === 'claimed' && j.claimedAt && now - Date.parse(j.claimedAt) > 60_000) {
        j.status = 'queued';
        j.workerId = undefined;
      }
    }
    const next = this.jobs.find((j) => j.status === 'queued');
    if (!next) return null;
    next.status = 'claimed';
    next.workerId = workerId;
    next.claimedAt = new Date().toISOString();
    this.saveToDisk();
    return next;
  }

  public completeJob(params: {
    jobId: string;
    workerId: string;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }): MobileOffloadJob | null {
    const job = this.jobs.find((j) => j.id === params.jobId);
    if (!job) return null;
    job.status = params.ok ? 'completed' : 'failed';
    job.result = params.result;
    job.error = params.error?.slice(0, 300);
    job.workerId = params.workerId;
    job.completedAt = new Date().toISOString();

    const worker = this.workers.get(params.workerId);
    if (worker && params.ok) {
      worker.jobsCompleted += 1;
      worker.lastHeartbeatAt = Date.now();
    }

    this.saveToDisk();
    const list = this.waiters.get(job.id);
    if (list) {
      this.waiters.delete(job.id);
      for (const resolve of list) {
        resolve(job);
      }
    }
    return job;
  }

  public waitForJob(jobId: string, timeoutMs = 15_000): Promise<MobileOffloadJob | null> {
    const existing = this.jobs.find((j) => j.id === jobId);
    if (existing && (existing.status === 'completed' || existing.status === 'failed')) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.waiters.get(jobId) || [];
        this.waiters.set(
          jobId,
          arr.filter((fn) => fn !== onDone)
        );
        resolve(this.jobs.find((j) => j.id === jobId) || null);
      }, timeoutMs);

      const onDone = (finished: MobileOffloadJob) => {
        clearTimeout(timer);
        resolve(finished);
      };

      const arr = this.waiters.get(jobId) || [];
      arr.push(onDone);
      this.waiters.set(jobId, arr);
    });
  }

  public pruneStuckJobs(): number {
    const now = Date.now();
    let healed = 0;
    for (const j of this.jobs) {
      if ((j.status === 'queued' || j.status === 'claimed') && now - Date.parse(j.createdAt) > 5 * 60_000) {
        j.status = 'failed';
        j.error = 'Auto-cleaned by 5-minute watchdog (expired pending job).';
        j.completedAt = new Date().toISOString();
        healed += 1;
      }
    }
    if (this.jobs.length > MAX_STORED_JOBS) {
      this.jobs = this.jobs.slice(0, MAX_STORED_JOBS);
    }
    if (healed > 0) this.saveToDisk();
    return healed;
  }

  public getStatusSnapshot() {
    return {
      activeWorkers: this.getActiveWorkers(),
      queuedCount: this.jobs.filter((j) => j.status === 'queued').length,
      claimedCount: this.jobs.filter((j) => j.status === 'claimed').length,
      completedCount: this.jobs.filter((j) => j.status === 'completed').length,
      recentJobs: this.jobs.slice(0, 12),
    };
  }
}

export function registerMobileOffloadRoutes(
  app: Express,
  manager: MobileOffloadQueueManager,
  onLeadExtracted?: (payload: { url: string; emails: string[]; phones: string[]; title?: string; snippet?: string }) => void
) {
  app.get('/api/offload/status', (_req: Request, res: Response) => {
    res.json(manager.getStatusSnapshot());
  });

  app.post('/api/offload/heartbeat', (req: Request, res: Response) => {
    const worker = manager.recordHeartbeat({
      workerId: req.body?.workerId || 'mobile-pwa',
      deviceLabel: req.body?.deviceLabel,
      deviceMemoryGb: typeof req.body?.deviceMemoryGb === 'number' ? req.body.deviceMemoryGb : null,
      networkType: req.body?.networkType,
      userAgent: req.headers['user-agent'] || '',
    });
    res.json({ ok: true, worker, status: manager.getStatusSnapshot() });
  });

  app.get('/api/offload/next', (req: Request, res: Response) => {
    const workerId = String(req.query.workerId || 'mobile-pwa');
    manager.recordHeartbeat({
      workerId,
      userAgent: req.headers['user-agent'] || '',
    });
    const job = manager.claimNextJob(workerId);
    res.json({ job });
  });

  app.post('/api/offload/enqueue', (req: Request, res: Response) => {
    const type = (req.body?.type || 'scrape_url') as MobileOffloadJobType;
    const payload = (req.body?.payload || {}) as Record<string, unknown>;
    const job = manager.enqueueJob(type, payload);
    res.json({ ok: true, job });
  });

  app.post('/api/offload/:jobId/complete', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const workerId = String(req.body?.workerId || 'mobile-pwa');
    const ok = req.body?.ok !== false;
    const result = (req.body?.result || {}) as Record<string, unknown>;
    const error = typeof req.body?.error === 'string' ? req.body.error : undefined;

    const job = manager.completeJob({ jobId, workerId, ok, result, error });
    if (!job) {
      res.status(404).json({ error: 'Offload job not found.' });
      return;
    }

    if (ok && job.type === 'scrape_url' && onLeadExtracted) {
      const url = String(result.url || job.payload.url || '').trim();
      const emails = Array.isArray(result.emails) ? result.emails.map(String) : [];
      const phones = Array.isArray(result.phones) ? result.phones.map(String) : [];
      if (url && (emails.length > 0 || phones.length > 0 || result.title)) {
        onLeadExtracted({
          url,
          emails,
          phones,
          title: typeof result.title === 'string' ? result.title : undefined,
          snippet: typeof result.snippet === 'string' ? result.snippet : undefined,
        });
      }
    }

    res.json({ ok: true, job });
  });
}
