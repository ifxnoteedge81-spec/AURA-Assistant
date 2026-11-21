import { autonomousAgentEngine, telegramBotController } from '../../api/index.ts';
import { verifyInternalBgSignature, type TelegramUpdate } from '../../server/telegramBot.ts';

interface NetlifyBgEvent {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
}

interface BackgroundWorkerPayload {
  kind?: 'telegram_update' | 'agent_run';
  update?: TelegramUpdate;
  origin?: string;
  goal?: string;
  preassignedRunId?: string;
}

export async function handler(event: NetlifyBgEvent) {
  if (event.httpMethod && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  const rawBody = String(event.body || '');
  const sig = String(
    event.headers?.['x-wanexus-bg-sig'] || event.headers?.['X-Wanexus-Bg-Sig'] || ''
  ).trim();

  if (!verifyInternalBgSignature(rawBody, sig)) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Invalid worker signature' }) };
  }

  let payload: BackgroundWorkerPayload;
  try {
    payload = JSON.parse(rawBody) as BackgroundWorkerPayload;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON payload' }) };
  }

  try {
    if (payload.kind === 'telegram_update' && payload.update) {
      const outcome = await telegramBotController.handleWebhookUpdate(payload.update, payload.origin, {
        backgroundMode: true,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, mode: 'netlify_background_15m', ...outcome }),
      };
    }

    if (payload.kind === 'agent_run' && payload.goal) {
      const run = await autonomousAgentEngine.executeMission({
        goal: payload.goal,
        source: 'dashboard',
        maxWallClockMs: 240_000,
        preassignedRunId: payload.preassignedRunId,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: run.status === 'completed', runId: run.id }),
      };
    }

    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Unknown worker payload kind' }) };
  } catch (err) {
    console.error('[Netlify Background Worker] Error:', (err as Error).message);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: (err as Error).message.slice(0, 200) }),
    };
  }
}
