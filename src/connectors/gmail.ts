import { google, gmail_v1 } from 'googleapis';
import { env, getDb, intEnv, maxValue, requireEnv, writeRaw } from '../lake.js';

const HINT =
  'Create OAuth "Desktop app" credentials at https://console.cloud.google.com/apis/credentials, enable the Gmail API, set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in .env, then run `npm run auth:gmail`.';

function getClient(): gmail_v1.Gmail {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = requireEnv(
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    HINT,
  );
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

function header(msg: gmail_v1.Schema$Message, name: string): string | null {
  const h = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function extractText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  return (part.parts ?? []).map(extractText).join('');
}

export async function syncGmail(): Promise<void> {
  const gmail = getClient();
  const db = await getDb();

  // Incremental: search after the newest message we already have.
  const newest = await maxValue<Date>('emails', 'date');
  const backfillDays = intEnv('GMAIL_BACKFILL_DAYS', 30);
  const afterEpoch = newest
    ? Math.floor(new Date(newest).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - backfillDays * 24 * 3600;

  const extra = env('GMAIL_QUERY');
  const q = `after:${afterEpoch}${extra ? ` ${extra}` : ''}`;

  let pageToken: string | undefined;
  let total = 0;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    const ids = list.data.messages ?? [];
    if (ids.length === 0) break;

    const messages: gmail_v1.Schema$Message[] = [];
    for (const { id } of ids) {
      const res = await gmail.users.messages.get({ userId: 'me', id: id!, format: 'full' });
      messages.push(res.data);
    }
    await writeRaw('gmail', `messages-${total}`, messages);

    for (const m of messages) {
      const dateMs = m.internalDate ? Number(m.internalDate) : null;
      await db.run(
        `INSERT OR REPLACE INTO emails VALUES (?, ?, CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?)`,
        [
          m.id!,
          m.threadId ?? null,
          dateMs ? new Date(dateMs).toISOString().replace('Z', '') : null,
          header(m, 'From'),
          header(m, 'To'),
          header(m, 'Subject'),
          m.snippet ?? null,
          (m.labelIds ?? []).join(','),
          extractText(m.payload).slice(0, 100_000),
        ],
      );
    }
    total += messages.length;
    console.log(`gmail: fetched ${total} messages so far…`);
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(`gmail: synced ${total} new messages`);
}
