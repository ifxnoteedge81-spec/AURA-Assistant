import crypto from 'node:crypto';
import pg from 'pg';
import type { Pool as PgPool } from 'pg';
import type {
  ChatMemoryRecord,
  ChatTurn,
  DictionaryEntry,
  InboxNoteRecord,
} from './assistantEngine.ts';

const { Pool } = pg;

export interface PostgresStatus {
  configured: boolean;
  connected: boolean;
  lastError: string | null;
}

let pool: PgPool | null = null;
let schemaReadyPromise: Promise<boolean> | null = null;
let hasConnectedOnce = false;
let lastPgError: string | null = null;

export function isPostgresConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  return Boolean(url && (url.startsWith('postgres://') || url.startsWith('postgresql://')));
}

export function getPostgresStatus(): PostgresStatus {
  return {
    configured: isPostgresConfigured(),
    connected: hasConnectedOnce && lastPgError === null,
    lastError: lastPgError,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function getPool(): PgPool | null {
  if (!isPostgresConfigured()) return null;
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL!.trim();
  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1');

  pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });

  pool.on('error', (err) => {
    lastPgError = (err as Error).message.slice(0, 160);
    console.warn('[Postgres] Idle pool error:', lastPgError);
  });

  return pool;
}

async function ensureSchema(): Promise<boolean> {
  const activePool = getPool();
  if (!activePool) return false;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    try {
      await activePool.query(`
        CREATE TABLE IF NOT EXISTS aura_settings (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          config_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS aura_contacts (
          chat_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          contact_jid TEXT NOT NULL,
          contact_name TEXT NOT NULL DEFAULT '',
          detected_district TEXT NOT NULL DEFAULT 'Standard',
          last_summary TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS aura_messages (
          id BIGSERIAL PRIMARY KEY,
          chat_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          msg_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          provider_used TEXT NOT NULL DEFAULT '',
          latency_ms INTEGER NOT NULL DEFAULT 0,
          UNIQUE (chat_id, role, msg_timestamp, text_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_aura_messages_chat_ts
          ON aura_messages (chat_id, msg_timestamp DESC);

        CREATE TABLE IF NOT EXISTS aura_notes (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          contact_jid TEXT NOT NULL,
          contact_name TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL,
          urgency TEXT NOT NULL DEFAULT 'normal',
          resolved BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS aura_dictionary (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          term TEXT NOT NULL,
          term_lower TEXT NOT NULL DEFAULT '',
          meaning TEXT NOT NULL,
          district TEXT NOT NULL,
          language TEXT NOT NULL,
          reply_style_hint TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE aura_dictionary
          ADD COLUMN IF NOT EXISTS term_lower TEXT NOT NULL DEFAULT '';

        UPDATE aura_dictionary
          SET term_lower = LOWER(term)
          WHERE term_lower = '' AND term <> '';

        CREATE INDEX IF NOT EXISTS idx_aura_dict_term_lower
          ON aura_dictionary (term_lower);

        CREATE INDEX IF NOT EXISTS idx_aura_dict_district
          ON aura_dictionary (district);

        CREATE INDEX IF NOT EXISTS idx_aura_dict_created
          ON aura_dictionary (created_at DESC);

        CREATE TABLE IF NOT EXISTS aura_sessions (
          session_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          phone_number TEXT NOT NULL DEFAULT '',
          payload_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS aura_ai_analytics (
          id BIGSERIAL PRIMARY KEY,
          chat_id TEXT NOT NULL,
          provider_used TEXT NOT NULL,
          key_slot INTEGER,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS aura_client_bots (
          bot_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          config_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      hasConnectedOnce = true;
      lastPgError = null;
      return true;
    } catch (err) {
      lastPgError = (err as Error).message.slice(0, 160);
      schemaReadyPromise = null;
      console.warn('[Postgres] Schema initialization failed:', lastPgError);
      return false;
    }
  })();

  return schemaReadyPromise;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 24);
}

export async function pgSaveSettings(ownerId: string, config: Record<string, unknown>): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(
      `INSERT INTO aura_settings (id, owner_id, config_json, updated_at)
       VALUES ('primary', $1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           config_json = EXCLUDED.config_json,
           updated_at = NOW()`,
      [ownerId, JSON.stringify(config)]
    );
    hasConnectedOnce = true;
    lastPgError = null;
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLoadSettings(): Promise<{ ownerId?: string; config?: Record<string, unknown> } | null> {
  if (!(await ensureSchema()) || !pool) return null;
  try {
    const res = await pool.query<{ owner_id: string; config_json: Record<string, unknown> }>(
      `SELECT owner_id, config_json FROM aura_settings WHERE id = 'primary' LIMIT 1`
    );
    if (res.rows.length === 0) return null;
    return { ownerId: res.rows[0].owner_id, config: res.rows[0].config_json };
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return null;
  }
}

export async function pgSaveChatMemory(
  ownerId: string,
  memory: ChatMemoryRecord,
  turnsToInsert: Array<ChatTurn & { providerUsed?: string; latencyMs?: number }>
): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(
      `INSERT INTO aura_contacts (chat_id, owner_id, contact_jid, contact_name, detected_district, last_summary, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (chat_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           contact_jid = EXCLUDED.contact_jid,
           contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), aura_contacts.contact_name),
           detected_district = COALESCE(NULLIF(EXCLUDED.detected_district, ''), aura_contacts.detected_district),
           last_summary = CASE
             WHEN LENGTH(EXCLUDED.last_summary) > 0 THEN EXCLUDED.last_summary
             ELSE aura_contacts.last_summary
           END,
           updated_at = EXCLUDED.updated_at`,
      [
        memory.chatId,
        ownerId,
        memory.contactJid,
        memory.contactName || '',
        memory.detectedDistrict || 'Standard',
        memory.lastSummary || '',
        memory.updatedAt || new Date().toISOString(),
      ]
    );

    for (const turn of turnsToInsert) {
      if (!turn.text || !turn.text.trim()) continue;
      const trimmed = turn.text.trim().slice(0, 4000);
      await pool.query(
        `INSERT INTO aura_messages (chat_id, owner_id, role, text, text_hash, msg_timestamp, provider_used, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
         ON CONFLICT (chat_id, role, msg_timestamp, text_hash) DO NOTHING`,
        [
          memory.chatId,
          ownerId,
          turn.role === 'assistant' ? 'assistant' : 'user',
          trimmed,
          hashText(trimmed),
          turn.timestamp || new Date().toISOString(),
          turn.providerUsed || '',
          turn.latencyMs || 0,
        ]
      );
    }
    hasConnectedOnce = true;
    lastPgError = null;
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLoadRecentMemories(): Promise<Array<ChatMemoryRecord & { archiveCount: number }>> {
  if (!(await ensureSchema()) || !pool) return [];
  try {
    const contactsRes = await pool.query<{
      chat_id: string;
      contact_jid: string;
      contact_name: string;
      detected_district: string;
      last_summary: string;
      updated_at: Date;
    }>(
      `SELECT chat_id, contact_jid, contact_name, detected_district, last_summary, updated_at
       FROM aura_contacts
       ORDER BY updated_at DESC
       LIMIT 200`
    );

    const chatIds = contactsRes.rows.map((r) => r.chat_id);
    if (chatIds.length === 0) return [];

    const [msgsRes, countsRes] = await Promise.all([
      pool.query<{ chat_id: string; role: string; text: string; msg_timestamp: Date }>(
        `SELECT chat_id, role, text, msg_timestamp
         FROM (
           SELECT chat_id, role, text, msg_timestamp,
                  ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY msg_timestamp DESC) AS rn
           FROM aura_messages
           WHERE chat_id = ANY($1::text[])
         ) ranked
         WHERE rn <= 20
         ORDER BY chat_id, msg_timestamp ASC`,
        [chatIds]
      ),
      pool.query<{ chat_id: string; cnt: string }>(
        `SELECT chat_id, COUNT(*)::text AS cnt
         FROM aura_messages
         WHERE chat_id = ANY($1::text[])
         GROUP BY chat_id`,
        [chatIds]
      ),
    ]);

    const turnsByChat = new Map<string, ChatTurn[]>();
    for (const m of msgsRes.rows) {
      const list = turnsByChat.get(m.chat_id) || [];
      list.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        text: m.text,
        timestamp: m.msg_timestamp.toISOString(),
      });
      turnsByChat.set(m.chat_id, list);
    }

    const countByChat = new Map<string, number>();
    for (const c of countsRes.rows) {
      countByChat.set(c.chat_id, Number(c.cnt || 0));
    }

    return contactsRes.rows.map((row) => {
      const turns = turnsByChat.get(row.chat_id) || [];
      return {
        chatId: row.chat_id,
        contactJid: row.contact_jid,
        contactName: row.contact_name,
        detectedDistrict: row.detected_district || 'Standard',
        lastSummary: row.last_summary || '',
        turns,
        archiveCount: countByChat.get(row.chat_id) ?? turns.length,
        updatedAt: row.updated_at.toISOString(),
      };
    });
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

export async function pgGetChatArchive(chatId: string, limit = 1000): Promise<ChatTurn[]> {
  if (!(await ensureSchema()) || !pool) return [];
  try {
    const res = await pool.query<{ role: string; text: string; msg_timestamp: Date }>(
      `SELECT role, text, msg_timestamp
       FROM (
         SELECT role, text, msg_timestamp
         FROM aura_messages
         WHERE chat_id = $1
         ORDER BY msg_timestamp DESC
         LIMIT $2
       ) sub
       ORDER BY msg_timestamp ASC`,
      [chatId, limit]
    );
    return res.rows.map((r) => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      text: r.text,
      timestamp: r.msg_timestamp.toISOString(),
    }));
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

export async function pgLoadSingleContact(chatId: string): Promise<ChatMemoryRecord | null> {
  if (!(await ensureSchema()) || !pool) return null;
  try {
    const contactRes = await pool.query<{
      chat_id: string;
      contact_jid: string;
      contact_name: string;
      detected_district: string;
      last_summary: string;
      updated_at: Date;
    }>(
      `SELECT chat_id, contact_jid, contact_name, detected_district, last_summary, updated_at
       FROM aura_contacts
       WHERE chat_id = $1
       LIMIT 1`,
      [chatId]
    );
    const turns = await pgGetChatArchive(chatId, 20);
    if (contactRes.rows.length === 0 && turns.length === 0) return null;

    const row = contactRes.rows[0];
    return {
      chatId,
      contactJid: row?.contact_jid || chatId,
      contactName: row?.contact_name || '',
      detectedDistrict: row?.detected_district || 'Standard',
      lastSummary: row?.last_summary || '',
      turns,
      updatedAt: row?.updated_at?.toISOString() || turns[turns.length - 1]?.timestamp || new Date().toISOString(),
    };
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return null;
  }
}

export async function pgRecallOlderMessages(
  chatId: string,
  incomingText: string,
  recentTurns: ChatTurn[],
  maxResults = 5
): Promise<ChatTurn[]> {
  if (!(await ensureSchema()) || !pool) return [];
  const tokens = incomingText
    .toLowerCase()
    .split(/[\s,.!?;:'"()[\]{}<>\/\\|@#$%^&*+=~`-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 5);

  if (tokens.length === 0) return [];

  try {
    const recentHashes = new Set(recentTurns.map((t) => `${t.role}|${hashText(t.text)}`));
    const patterns = tokens.map((t) => `%${escapeLikePattern(t)}%`);
    const res = await pool.query<{ role: string; text: string; text_hash: string; msg_timestamp: Date }>(
      `SELECT role, text, text_hash, msg_timestamp
       FROM aura_messages
       WHERE chat_id = $1
         AND text ILIKE ANY($2::text[])
       ORDER BY msg_timestamp DESC
       LIMIT 25`,
      [chatId, patterns]
    );

    const matched: ChatTurn[] = [];
    for (const row of res.rows) {
      if (recentHashes.has(`${row.role}|${row.text_hash}`)) continue;
      matched.push({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        text: row.text,
        timestamp: row.msg_timestamp.toISOString(),
      });
      if (matched.length >= maxResults) break;
    }
    return matched.reverse();
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

export async function pgDeleteChatMemory(chatId: string): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(`DELETE FROM aura_messages WHERE chat_id = $1`, [chatId]);
    await pool.query(`DELETE FROM aura_contacts WHERE chat_id = $1`, [chatId]);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgSaveNote(ownerId: string, note: InboxNoteRecord): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(
      `INSERT INTO aura_notes (id, owner_id, contact_jid, contact_name, summary, urgency, resolved, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE
       SET resolved = EXCLUDED.resolved,
           summary = EXCLUDED.summary`,
      [
        note.id,
        ownerId,
        note.contactJid,
        note.contactName || '',
        note.summary,
        note.urgency,
        note.resolved,
        note.createdAt || new Date().toISOString(),
      ]
    );
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgDeleteNote(id: string): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(`DELETE FROM aura_notes WHERE id = $1`, [id]);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLoadNotes(): Promise<InboxNoteRecord[]> {
  if (!(await ensureSchema()) || !pool) return [];
  try {
    const res = await pool.query<{
      id: string;
      contact_jid: string;
      contact_name: string;
      summary: string;
      urgency: string;
      resolved: boolean;
      created_at: Date;
    }>(
      `SELECT id, contact_jid, contact_name, summary, urgency, resolved, created_at
       FROM aura_notes
       ORDER BY created_at DESC
       LIMIT 200`
    );
    return res.rows.map((r) => ({
      id: r.id,
      contactJid: r.contact_jid,
      contactName: r.contact_name,
      summary: r.summary,
      urgency: r.urgency === 'important' ? 'important' : 'normal',
      resolved: r.resolved,
      createdAt: r.created_at.toISOString(),
    }));
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

function makeDeterministicDictId(term: string, district: string): string {
  const key = `${term.trim().toLowerCase()}|${district.trim().toLowerCase()}`;
  return `dict_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

export async function pgSaveDictionaryEntries(ownerId: string, entries: DictionaryEntry[]): Promise<void> {
  await pgBulkInsertDictionaryEntries(ownerId, entries);
}

export async function pgBulkInsertDictionaryEntries(
  ownerId: string,
  entries: Array<Omit<DictionaryEntry, 'id'> & { id?: string }>
): Promise<number> {
  if (!(await ensureSchema()) || !pool || entries.length === 0) return 0;
  let insertedTotal = 0;
  const BATCH_SIZE = 500;

  try {
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const slice = entries.slice(i, i + BATCH_SIZE);
      const ids: string[] = [];
      const ownerIds: string[] = [];
      const terms: string[] = [];
      const termsLower: string[] = [];
      const meanings: string[] = [];
      const districts: string[] = [];
      const languages: string[] = [];
      const hints: string[] = [];

      const seenInBatch = new Set<string>();
      for (const entry of slice) {
        const cleanTerm = (entry.term || '').trim().slice(0, 200);
        const cleanMeaning = (entry.meaning || '').trim().slice(0, 500);
        if (!cleanTerm || !cleanMeaning) continue;
        const cleanDistrict = (entry.district || 'General').trim().slice(0, 100);
        const id = entry.id?.trim() || makeDeterministicDictId(cleanTerm, cleanDistrict);
        if (seenInBatch.has(id)) continue;
        seenInBatch.add(id);

        ids.push(id);
        ownerIds.push(ownerId);
        terms.push(cleanTerm);
        termsLower.push(cleanTerm.toLowerCase());
        meanings.push(cleanMeaning);
        districts.push(cleanDistrict);
        languages.push(
          entry.language === 'bn_en' || entry.language === 'en_slang' ? entry.language : 'bn_dialect'
        );
        hints.push((entry.replyStyleHint || '').trim().slice(0, 300));
      }

      if (ids.length === 0) continue;

      const res = await pool.query(
        `INSERT INTO aura_dictionary (id, owner_id, term, term_lower, meaning, district, language, reply_style_hint)
         SELECT * FROM UNNEST(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]
         )
         ON CONFLICT (id) DO UPDATE
         SET meaning = EXCLUDED.meaning,
             term_lower = EXCLUDED.term_lower,
             language = EXCLUDED.language,
             reply_style_hint = CASE
               WHEN LENGTH(EXCLUDED.reply_style_hint) > 0 THEN EXCLUDED.reply_style_hint
               ELSE aura_dictionary.reply_style_hint
             END`,
        [ids, ownerIds, terms, termsLower, meanings, districts, languages, hints]
      );
      insertedTotal += res.rowCount || ids.length;
    }
    hasConnectedOnce = true;
    lastPgError = null;
    return insertedTotal;
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return insertedTotal;
  }
}

export async function pgGetDictionaryCount(): Promise<number> {
  if (!(await ensureSchema()) || !pool) return 0;
  try {
    const res = await pool.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM aura_dictionary`);
    return Number(res.rows[0]?.cnt || 0);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return 0;
  }
}

export async function pgQueryDictionaryPage(params: {
  page?: number;
  limit?: number;
  search?: string;
  district?: string;
}): Promise<{
  entries: DictionaryEntry[];
  totalCount: number;
  page: number;
  totalPages: number;
  districts: string[];
}> {
  const limit = Math.max(10, Math.min(100, Math.round(params.limit || 50)));
  const requestedPage = Math.max(1, Math.round(params.page || 1));
  if (!(await ensureSchema()) || !pool) {
    return { entries: [], totalCount: 0, page: 1, totalPages: 1, districts: [] };
  }

  try {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.district && params.district !== 'ALL') {
      values.push(params.district);
      conditions.push(`district = $${values.length}`);
    }
    if (params.search && params.search.trim()) {
      const q = `%${escapeLikePattern(params.search.trim().toLowerCase())}%`;
      values.push(q);
      conditions.push(`(term_lower LIKE $${values.length} OR LOWER(meaning) LIKE $${values.length} OR LOWER(district) LIKE $${values.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM aura_dictionary ${whereClause}`,
      values
    );
    const totalCount = Number(countRes.rows[0]?.cnt || 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    const rowsRes = await pool.query<{
      id: string;
      term: string;
      meaning: string;
      district: string;
      language: string;
      reply_style_hint: string;
    }>(
      `SELECT id, term, meaning, district, language, reply_style_hint
       FROM aura_dictionary
       ${whereClause}
       ORDER BY created_at DESC, id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const distRes = await pool.query<{ district: string }>(
      `SELECT DISTINCT district FROM aura_dictionary ORDER BY district ASC LIMIT 120`
    );

    return {
      entries: rowsRes.rows.map((r) => ({
        id: r.id,
        term: r.term,
        meaning: r.meaning,
        district: r.district,
        language: r.language === 'bn_en' || r.language === 'en_slang' ? r.language : 'bn_dialect',
        replyStyleHint: r.reply_style_hint || '',
      })),
      totalCount,
      page,
      totalPages,
      districts: distRes.rows.map((r) => r.district).filter(Boolean),
    };
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return { entries: [], totalCount: 0, page: 1, totalPages: 1, districts: [] };
  }
}

export async function pgFindRelevantDictionaryEntries(
  incomingText: string,
  maxResults = 8
): Promise<DictionaryEntry[]> {
  if (!(await ensureSchema()) || !pool || !incomingText || !incomingText.trim()) return [];
  const rawTokens = incomingText
    .toLowerCase()
    .split(/[\s,.!?;:'"()[\]{}<>\/\\|@#$%^&*+=~`।—–-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 60);

  const uniqueTokens = Array.from(new Set(rawTokens)).slice(0, 12);
  // Add 2-word phrases for multi-word idioms
  const bigrams: string[] = [];
  for (let i = 0; i < rawTokens.length - 1 && bigrams.length < 6; i += 1) {
    bigrams.push(`${rawTokens[i]} ${rawTokens[i + 1]}`);
  }
  const exactCandidates = Array.from(new Set([...uniqueTokens, ...bigrams])).slice(0, 18);
  if (exactCandidates.length === 0) return [];

  try {
    // 1. Exact index lookup first (sub-millisecond)
    const exactRes = await pool.query<{
      id: string;
      term: string;
      meaning: string;
      district: string;
      language: string;
      reply_style_hint: string;
    }>(
      `SELECT id, term, meaning, district, language, reply_style_hint
       FROM aura_dictionary
       WHERE term_lower = ANY($1::text[])
       LIMIT $2`,
      [exactCandidates, maxResults]
    );

    const matched: DictionaryEntry[] = exactRes.rows.map((r) => ({
      id: r.id,
      term: r.term,
      meaning: r.meaning,
      district: r.district,
      language: r.language === 'bn_en' || r.language === 'en_slang' ? r.language : 'bn_dialect',
      replyStyleHint: r.reply_style_hint || '',
    }));

    // 2. Prefix fallback if fewer than maxResults matched and tokens exist
    if (matched.length < maxResults) {
      const prefixPatterns = uniqueTokens
        .filter((t) => t.length >= 3)
        .slice(0, 6)
        .map((t) => `${escapeLikePattern(t)}%`);
      if (prefixPatterns.length > 0) {
        const seenIds = new Set(matched.map((m) => m.id));
        const partialRes = await pool.query<{
          id: string;
          term: string;
          meaning: string;
          district: string;
          language: string;
          reply_style_hint: string;
        }>(
          `SELECT id, term, meaning, district, language, reply_style_hint
           FROM aura_dictionary
           WHERE term_lower LIKE ANY($1::text[])
           LIMIT $2`,
          [prefixPatterns, maxResults]
        );
        for (const r of partialRes.rows) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          matched.push({
            id: r.id,
            term: r.term,
            meaning: r.meaning,
            district: r.district,
            language: r.language === 'bn_en' || r.language === 'en_slang' ? r.language : 'bn_dialect',
            replyStyleHint: r.reply_style_hint || '',
          });
          if (matched.length >= maxResults) break;
        }
      }
    }

    return matched;
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

export async function pgDeleteDictionaryEntry(id: string): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(`DELETE FROM aura_dictionary WHERE id = $1`, [id]);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgClearDictionary(): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(`DELETE FROM aura_dictionary`);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLoadDictionary(limit = 300): Promise<DictionaryEntry[]> {
  if (!(await ensureSchema()) || !pool) return [];
  try {
    const res = await pool.query<{
      id: string;
      term: string;
      meaning: string;
      district: string;
      language: string;
      reply_style_hint: string;
    }>(
      `SELECT id, term, meaning, district, language, reply_style_hint
       FROM aura_dictionary
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.max(1, Math.min(500, limit))]
    );
    return res.rows.map((r) => ({
      id: r.id,
      term: r.term,
      meaning: r.meaning,
      district: r.district,
      language: r.language === 'bn_en' || r.language === 'en_slang' ? r.language : 'bn_dialect',
      replyStyleHint: r.reply_style_hint || '',
    }));
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

export async function pgSaveSessionBackup(
  sessionId: string,
  ownerId: string,
  phoneNumber: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(
      `INSERT INTO aura_sessions (session_id, owner_id, phone_number, payload_json, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           phone_number = EXCLUDED.phone_number,
           payload_json = EXCLUDED.payload_json,
           updated_at = NOW()`,
      [sessionId, ownerId, phoneNumber || '', JSON.stringify(payload)]
    );
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLoadSessionBackup(
  sessionId: string
): Promise<Record<string, unknown> | null> {
  if (!(await ensureSchema()) || !pool) return null;
  try {
    const res = await pool.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM aura_sessions WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );
    return res.rows[0]?.payload_json || null;
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return null;
  }
}

export async function pgDeleteSessionBackup(): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(`DELETE FROM aura_sessions WHERE session_id IN ('primary', 'keys_backup')`);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgDeleteSingleSessionBackup(sessionId: string): Promise<void> {
  if (!(await ensureSchema()) || !pool || !sessionId) return;
  try {
    await pool.query(`DELETE FROM aura_sessions WHERE session_id = $1`, [sessionId]);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLogAiUsage(params: {
  chatId: string;
  providerUsed: string;
  keySlot?: number;
  latencyMs: number;
}): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(
      `INSERT INTO aura_ai_analytics (chat_id, provider_used, key_slot, latency_ms)
       VALUES ($1, $2, $3, $4)`,
      [params.chatId, params.providerUsed, params.keySlot ?? null, Math.max(0, Math.round(params.latencyMs))]
    );
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgSaveClientBot(
  botId: string,
  ownerId: string,
  config: Record<string, unknown>
): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(
      `INSERT INTO aura_client_bots (bot_id, owner_id, config_json, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (bot_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           config_json = EXCLUDED.config_json,
           updated_at = NOW()`,
      [botId, ownerId, JSON.stringify(config)]
    );
    hasConnectedOnce = true;
    lastPgError = null;
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgLoadClientBots<T = Record<string, unknown>>(): Promise<T[]> {
  if (!(await ensureSchema()) || !pool) return [];
  try {
    const res = await pool.query<{ config_json: T }>(
      `SELECT config_json FROM aura_client_bots ORDER BY updated_at DESC LIMIT 500`
    );
    return res.rows.map((r) => r.config_json).filter(Boolean);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
    return [];
  }
}

export async function pgDeleteClientBot(botId: string): Promise<void> {
  if (!(await ensureSchema()) || !pool) return;
  try {
    await pool.query(`DELETE FROM aura_client_bots WHERE bot_id = $1`, [botId]);
    await pool.query(`DELETE FROM aura_sessions WHERE session_id = $1`, [`client_sess_${botId}`]);
  } catch (err) {
    lastPgError = (err as Error).message.slice(0, 160);
  }
}

export async function pgClosePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    schemaReadyPromise = null;
    await current.end().catch(() => {});
  }
}
