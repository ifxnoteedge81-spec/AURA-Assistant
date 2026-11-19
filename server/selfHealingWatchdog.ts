import fs from 'node:fs';
import path from 'node:path';

export interface WatchdogHealEvent {
  timestamp: string;
  trigger: 'interval_5m' | 'manual' | 'uncaught_error' | 'memory_pressure';
  actionsTaken: string[];
  rssBeforeMb: number;
  rssAfterMb: number;
  botStatus: string;
  ok: boolean;
}

export interface WatchdogHooks {
  getMemoryRssMb: () => number;
  pruneRuntimeCaches: () => void;
  getBotStatus: () => string;
  isManualDisconnect: () => boolean;
  hasRegisteredCreds: () => boolean;
  hasPendingReconnectTimer: () => boolean;
  triggerWhatsAppReconnect: () => Promise<void>;
  healStuckQueuesAndAgents: () => string[];
  verifyAndRepairJsonFiles: (filePaths: string[]) => string[];
  pushLog: (
    category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud',
    actor: string,
    summary: string,
    outcome?: 'success' | 'blocked' | 'info' | 'error'
  ) => void;
}

export const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // Strictly every 5 minutes

export class SelfHealingWatchdog {
  private readonly hooks: WatchdogHooks;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isHealing = false;
  private cycleCount = 0;
  private totalHealsApplied = 0;
  private processErrorsIntercepted = 0;
  private lastErrorIntercepted: string | null = null;
  private readonly recentEvents: WatchdogHealEvent[] = [];
  private processHooksInstalled = false;

  constructor(hooks: WatchdogHooks) {
    this.hooks = hooks;
  }

  public start() {
    this.installProcessSafetyNets();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.runHealCycle('interval_5m');
    }, WATCHDOG_INTERVAL_MS);
    this.hooks.pushLog(
      'system',
      '5m Self-Healing Watchdog',
      '24/7 Watchdog armed (5-minute cycle + crash guard + 512MB RAM protection).',
      'success'
    );
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private installProcessSafetyNets() {
    if (this.processHooksInstalled) return;
    this.processHooksInstalled = true;

    process.on('unhandledRejection', (reason) => {
      this.processErrorsIntercepted += 1;
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.lastErrorIntercepted = `${new Date().toISOString()}: ${msg.slice(0, 180)}`;
      console.error('[Watchdog] Intercepted unhandledRejection (process kept alive):', msg);
      this.hooks.pushLog('system', 'Self-Healing Guard', `Prevented crash (unhandledRejection): ${msg.slice(0, 120)}`, 'error');
      void this.runHealCycle('uncaught_error');
    });

    process.on('uncaughtException', (err) => {
      this.processErrorsIntercepted += 1;
      const msg = err?.message || String(err);
      this.lastErrorIntercepted = `${new Date().toISOString()}: ${msg.slice(0, 180)}`;
      console.error('[Watchdog] Intercepted uncaughtException (auto-healing):', msg);
      this.hooks.pushLog('system', 'Self-Healing Guard', `Recovered from exception: ${msg.slice(0, 120)}`, 'error');
      void this.runHealCycle('uncaught_error');
    });
  }

  public async runHealCycle(
    trigger: WatchdogHealEvent['trigger'] = 'manual'
  ): Promise<WatchdogHealEvent> {
    if (this.isHealing) {
      return (
        this.recentEvents[0] || {
          timestamp: new Date().toISOString(),
          trigger,
          actionsTaken: ['Heal cycle already in progress.'],
          rssBeforeMb: this.hooks.getMemoryRssMb(),
          rssAfterMb: this.hooks.getMemoryRssMb(),
          botStatus: this.hooks.getBotStatus(),
          ok: true,
        }
      );
    }

    this.isHealing = true;
    this.cycleCount += 1;
    const actionsTaken: string[] = [];
    const rssBeforeMb = this.hooks.getMemoryRssMb();

    try {
      // 1. Prune runtime caches & enforce 512MB Render memory safety threshold
      this.hooks.pruneRuntimeCaches();
      if (rssBeforeMb >= 340) {
        try {
          const maybeGc = (globalThis as unknown as { gc?: () => void }).gc;
          if (typeof maybeGc === 'function') maybeGc();
        } catch {
          // ignore
        }
        actionsTaken.push(`Pruned caches under elevated RAM (${rssBeforeMb} MB)`);
      } else {
        actionsTaken.push('Pruned runtime caches cleanly');
      }

      // 2. Verify & auto-heal corrupt local JSON stores if any got truncated
      const jsonFixes = this.hooks.verifyAndRepairJsonFiles([
        './bot-config.json',
        './bot-outreach.json',
        './bot-agent-runs.json',
        './bot-agent-schedules.json',
        './bot-offload-queue.json',
      ]);
      for (const fix of jsonFixes) {
        actionsTaken.push(fix);
      }

      // 3. Release any stalled agent / outreach / offload locks
      const queueHeals = this.hooks.healStuckQueuesAndAgents();
      for (const qh of queueHeals) {
        actionsTaken.push(qh);
      }

      // 4. WhatsApp socket self-heal if registered session went idle disconnected
      const currentStatus = this.hooks.getBotStatus();
      if (
        !this.hooks.isManualDisconnect() &&
        this.hooks.hasRegisteredCreds() &&
        currentStatus === 'disconnected' &&
        !this.hooks.hasPendingReconnectTimer()
      ) {
        try {
          await this.hooks.triggerWhatsAppReconnect();
          actionsTaken.push('Revived idle disconnected WhatsApp socket automatically');
        } catch (err) {
          actionsTaken.push(`WhatsApp reconnect attempt deferred: ${(err as Error).message.slice(0, 80)}`);
        }
      }

      if (actionsTaken.length > 1) {
        this.totalHealsApplied += 1;
      }

      const rssAfterMb = this.hooks.getMemoryRssMb();
      const ev: WatchdogHealEvent = {
        timestamp: new Date().toISOString(),
        trigger,
        actionsTaken,
        rssBeforeMb,
        rssAfterMb,
        botStatus: this.hooks.getBotStatus(),
        ok: true,
      };
      this.recentEvents.unshift(ev);
      if (this.recentEvents.length > 20) {
        this.recentEvents.length = 20;
      }

      if (trigger !== 'interval_5m' || actionsTaken.length > 1) {
        this.hooks.pushLog(
          'system',
          '5m Self-Healing Watchdog',
          `[${trigger}] RSS ${rssBeforeMb}->${rssAfterMb}MB · ${actionsTaken.join(' | ').slice(0, 140)}`,
          'success'
        );
      }
      return ev;
    } finally {
      this.isHealing = false;
    }
  }

  public getStatus() {
    return {
      enabled: Boolean(this.timer),
      intervalMs: WATCHDOG_INTERVAL_MS,
      cycleCount: this.cycleCount,
      totalHealsApplied: this.totalHealsApplied,
      processErrorsIntercepted: this.processErrorsIntercepted,
      lastErrorIntercepted: this.lastErrorIntercepted,
      recentEvents: this.recentEvents.slice(0, 10),
    };
  }
}

export function repairCorruptJsonFiles(filePaths: string[]): string[] {
  const repaired: string[] = [];
  for (const rel of filePaths) {
    const abs = path.resolve(rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const raw = fs.readFileSync(abs, 'utf8').trim();
      if (!raw) {
        fs.unlinkSync(abs);
        repaired.push(`Removed empty corrupt file ${rel}`);
        continue;
      }
      JSON.parse(raw);
    } catch {
      try {
        fs.copyFileSync(abs, `${abs}.corrupt.${Date.now()}.bak`);
      } catch {
        // ignore backup failure
      }
      try {
        fs.unlinkSync(abs);
        repaired.push(`Isolated corrupt JSON store ${rel} so fresh clean state initializes`);
      } catch {
        // ignore
      }
    }
  }
  return repaired;
}
