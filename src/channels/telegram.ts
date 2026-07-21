/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

const TELEGRAM_VOICE_FILENAME = 'voice-reply.ogg';
const TELEGRAM_VOICE_MIME = 'audio/ogg';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface TelegramVoiceCandidate {
  file: NonNullable<OutboundMessage['files']>[number];
}

type TelegramVoiceResult = { state: 'sent'; messageId: string } | { state: 'rejected' } | { state: 'ambiguous' };

/** Accept only the host synthesizer's typed and pinned voice signal. */
function getTelegramVoiceCandidate(message: OutboundMessage): TelegramVoiceCandidate | null {
  const content = message.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  const voice = message.voice;
  if (
    !voice ||
    voice.filename !== TELEGRAM_VOICE_FILENAME ||
    voice.mimeType !== TELEGRAM_VOICE_MIME ||
    voice.ptt !== true ||
    typeof record.text !== 'string' ||
    !record.text.trim() ||
    !message.files ||
    message.files.length !== 1
  ) {
    return null;
  }
  const [file] = message.files;
  if (!file || file.filename !== TELEGRAM_VOICE_FILENAME) return null;
  return { file };
}

async function sendTelegramVoice(
  token: string,
  platformId: string,
  threadId: string | null,
  candidate: TelegramVoiceCandidate,
): Promise<TelegramVoiceResult> {
  const destination = threadId ?? platformId;
  const chatId = destination.split(':').slice(1).join(':');
  if (!chatId) return { state: 'rejected' };

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(
    'voice',
    new Blob([new Uint8Array(candidate.file.data)], { type: TELEGRAM_VOICE_MIME }),
    candidate.file.filename,
  );

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn('Telegram native voice rejected; falling back to attachment', { status: response.status });
      return { state: 'rejected' };
    }
    const data = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
    if (!data.ok || data.result?.message_id === undefined) {
      log.warn('Telegram native voice returned no receipt; falling back to attachment', {
        status: response.status,
        apiOk: data.ok === true,
      });
      return { state: 'rejected' };
    }
    return { state: 'sent', messageId: `${chatId}:${data.result.message_id}` };
  } catch (err) {
    // The request might have reached Telegram before the response was lost.
    // Replaying the audio here could create a duplicate voice message.
    log.warn('Telegram native voice outcome ambiguous; keeping the delivered text reply', {
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return { state: 'ambiguous' };
  }
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      deliver: async (platformId, threadId, message: OutboundMessage) => {
        const voiceCandidate = getTelegramVoiceCandidate(message);
        if (!voiceCandidate) return bridge.deliver(platformId, threadId, message);

        // Text is delivered once before the additive, captionless voice bubble.
        const textReceipt = await bridge.deliver(platformId, threadId, {
          ...message,
          files: undefined,
          voice: undefined,
        });
        const nativeVoice = await sendTelegramVoice(token, platformId, threadId, voiceCandidate);
        if (nativeVoice.state === 'rejected') {
          try {
            await bridge.deliver(platformId, threadId, {
              ...message,
              content: { ...(message.content as Record<string, unknown>), text: '' },
              voice: undefined,
            });
          } catch (err) {
            log.warn('Telegram voice attachment fallback failed after text delivery', {
              errorType: err instanceof Error ? err.name : typeof err,
            });
          }
        }
        return textReceipt ?? (nativeVoice.state === 'sent' ? nativeVoice.messageId : undefined);
      },
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
