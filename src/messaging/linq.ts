/**
 * Outbound messaging via Linq (iMessage, with RCS/SMS fallback) — how the
 * lake reaches a human. Deliberately standalone from the storage layer:
 * anything can `import { sendText } from './messaging/linq.js'` without
 * touching DuckDB.
 *
 * Setup is a one-time CLI flow (see README "Texting"): sign up for a Linq
 * account, then put the API key, your Linq Number, and your phone in .env.
 * Free-tier caveat: a recipient must text the Linq Number once before it
 * can text them.
 */
import Linq from '@linqapp/sdk';
import { env, requireEnv } from '../env.js';

const HINT =
  'Run `npx @linqapp/cli signup`, then set LINQ_API_KEY, LINQ_NUMBER (both from `linq whoami`) and LINQ_DEFAULT_TO in .env. See README "Texting".';

const SCREEN_EFFECTS = [
  'confetti',
  'fireworks',
  'lasers',
  'sparkles',
  'celebration',
  'hearts',
  'love',
  'balloons',
  'happy_birthday',
  'echo',
  'spotlight',
] as const;
const BUBBLE_EFFECTS = ['slam', 'loud', 'gentle', 'invisible'] as const;

export type TextEffect = (typeof SCREEN_EFFECTS)[number] | (typeof BUBBLE_EFFECTS)[number];

export interface SentText {
  chatId: string;
  messageId: string;
  /** Status at send time — almost always 'pending'; delivery happens async. */
  status: string;
}

let client: Linq | undefined;

/** The full SDK client, for anything beyond sendText (reactions, attachments,
 * webhooks, group chats — https://apidocs.linqapp.com). */
export function getLinqClient(): Linq {
  if (!client) {
    const { LINQ_API_KEY } = requireEnv(['LINQ_API_KEY'], HINT);
    client = new Linq({ apiKey: LINQ_API_KEY });
  }
  return client;
}

/**
 * Text someone. Recipient defaults to LINQ_DEFAULT_TO (you), so the common
 * call is just `await sendText('run done')`. Linq reuses the existing chat
 * with a recipient, so calling this repeatedly threads one conversation.
 */
export async function sendText(
  body: string,
  opts: { to?: string; effect?: TextEffect } = {},
): Promise<SentText> {
  const { LINQ_NUMBER } = requireEnv(['LINQ_NUMBER'], HINT);
  const to = opts.to ?? env('LINQ_DEFAULT_TO');
  if (!to) throw new Error(`No recipient: pass opts.to or set LINQ_DEFAULT_TO in .env. ${HINT}`);

  const effect = opts.effect
    ? {
        type: (SCREEN_EFFECTS as readonly string[]).includes(opts.effect)
          ? ('screen' as const)
          : ('bubble' as const),
        name: opts.effect,
      }
    : undefined;

  try {
    const { chat } = await getLinqClient().chats.create({
      from: LINQ_NUMBER,
      to: [to],
      message: { parts: [{ type: 'text', value: body }], effect },
    });
    return { chatId: chat.id, messageId: chat.message.id, status: chat.message.delivery_status };
  } catch (err) {
    if (err instanceof Linq.PermissionDeniedError) {
      throw new Error(
        `Linq can't text ${to} yet. On the free tier they must be a contact ` +
          `(\`linq contacts add ${to}\`) AND have texted your Linq Number (${LINQ_NUMBER}) once.`,
      );
    }
    throw err;
  }
}
