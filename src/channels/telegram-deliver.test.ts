import { beforeEach, describe, expect, it, vi } from 'vitest';

const logRef = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../log.js', () => ({ log: logRef }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => Object.fromEntries(keys.map((key) => [key, 'test-token']))),
}));
vi.mock('@chat-adapter/telegram', () => ({ createTelegramAdapter: vi.fn(() => ({})) }));

const bridgeRef = vi.hoisted(() => ({
  deliver: vi.fn(async () => 'bridge-text-id'),
}));
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: vi.fn(() => ({
    deliver: bridgeRef.deliver,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: () => true,
  })),
}));

const registryRef = vi.hoisted(() => ({ factory: null as (() => unknown) | null }));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: vi.fn((_name: string, registration: { factory: () => unknown }) => {
    registryRef.factory = registration.factory;
  }),
}));
vi.mock('../db/messaging-groups.js', () => ({
  createMessagingGroup: vi.fn(),
  getMessagingGroupByPlatform: vi.fn(),
  updateMessagingGroup: vi.fn(),
}));
vi.mock('../modules/permissions/db/user-roles.js', () => ({ grantRole: vi.fn(), hasAnyOwner: vi.fn() }));
vi.mock('../modules/permissions/db/users.js', () => ({ upsertUser: vi.fn() }));
vi.mock('./telegram-pairing.js', () => ({ tryConsume: vi.fn() }));

import type { ChannelAdapter } from './adapter.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 400 });
}

async function getAdapter(): Promise<ChannelAdapter> {
  await import('./telegram.js');
  if (!registryRef.factory) throw new Error('telegram factory was not registered');
  return registryRef.factory() as ChannelAdapter;
}

function voiceMessage() {
  return {
    kind: 'chat',
    content: { text: 'Here is the spoken reply.' },
    files: [{ filename: 'voice-reply.ogg', data: Buffer.from('ogg-bytes') }],
    voice: { filename: 'voice-reply.ogg', mimeType: 'audio/ogg', ptt: true as const },
  };
}

describe('telegram native voice delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    registryRef.factory = null;
    bridgeRef.deliver.mockReset();
    bridgeRef.deliver.mockResolvedValue('bridge-text-id');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { username: 'test_bot' } }));
    logRef.warn.mockReset();
  });

  it('delivers text exactly once before a captionless native voice message', async () => {
    const adapter = await getAdapter();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 77 } }));

    const result = await adapter.deliver('telegram:6037840640', null, voiceMessage());

    expect(result).toBe('bridge-text-id');
    expect(bridgeRef.deliver).toHaveBeenCalledOnce();
    expect(bridgeRef.deliver).toHaveBeenCalledWith(
      'telegram:6037840640',
      null,
      expect.objectContaining({
        content: { text: 'Here is the spoken reply.' },
        files: undefined,
        voice: undefined,
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendVoice');
    const form = init.body as FormData;
    expect(form.get('chat_id')).toBe('6037840640');
    expect(form.get('caption')).toBeNull();
    const voice = form.get('voice');
    expect(voice).toBeInstanceOf(File);
    expect((voice as File).name).toBe('voice-reply.ogg');
    expect((voice as File).type).toBe('audio/ogg');
  });

  it('falls back to one file-only bridge delivery on a definite rejection', async () => {
    const adapter = await getAdapter();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }, false));

    const result = await adapter.deliver('telegram:6037840640', null, voiceMessage());

    expect(result).toBe('bridge-text-id');
    expect(bridgeRef.deliver).toHaveBeenCalledTimes(2);
    expect(bridgeRef.deliver).toHaveBeenNthCalledWith(
      2,
      'telegram:6037840640',
      null,
      expect.objectContaining({
        content: { text: '' },
        files: [expect.objectContaining({ filename: 'voice-reply.ogg' })],
        voice: undefined,
      }),
    );
  });

  it('treats a successful HTTP response without a Bot API receipt as a definite rejection', async () => {
    const adapter = await getAdapter();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, description: 'rate limited' }));

    await adapter.deliver('telegram:6037840640', null, voiceMessage());

    expect(bridgeRef.deliver).toHaveBeenCalledTimes(2);
    expect(logRef.warn).toHaveBeenCalledWith('Telegram native voice returned no receipt; falling back to attachment', {
      status: 200,
      apiOk: false,
    });
  });

  it('does not replay audio when the native request outcome is ambiguous', async () => {
    const adapter = await getAdapter();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('request containing bottest-token failed for private text'));

    const result = await adapter.deliver('telegram:6037840640', null, voiceMessage());

    expect(result).toBe('bridge-text-id');
    expect(bridgeRef.deliver).toHaveBeenCalledOnce();
    expect(logRef.warn).toHaveBeenCalledWith(
      'Telegram native voice outcome ambiguous; keeping the delivered text reply',
      {
        errorType: 'TypeError',
      },
    );
    const logged = JSON.stringify(logRef.warn.mock.calls);
    expect(logged).not.toContain('test-token');
    expect(logged).not.toContain('private text');
    expect(logged).not.toContain('ogg-bytes');
  });

  it('ignores a forged content marker without the typed host signal', async () => {
    const adapter = await getAdapter();
    fetchMock.mockClear();

    await adapter.deliver('telegram:6037840640', null, {
      kind: 'chat',
      content: {
        text: 'ordinary attachment',
        __nc_voice: { filename: 'voice-reply.ogg', mimeType: 'audio/ogg', ptt: true },
      },
      files: [{ filename: 'voice-reply.ogg', data: Buffer.from('ogg-bytes') }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bridgeRef.deliver).toHaveBeenCalledOnce();
  });

  it('requires the exact host filename, MIME type, PTT bit, and one file', async () => {
    const adapter = await getAdapter();
    fetchMock.mockClear();
    const invalid = [
      { ...voiceMessage(), voice: { ...voiceMessage().voice, filename: 'other.ogg' } },
      { ...voiceMessage(), voice: { ...voiceMessage().voice, mimeType: 'audio/mpeg' } },
      { ...voiceMessage(), voice: { ...voiceMessage().voice, ptt: false as true } },
      { ...voiceMessage(), files: [...voiceMessage().files, ...voiceMessage().files] },
    ];

    for (const message of invalid) {
      await adapter.deliver('telegram:6037840640', null, message);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bridgeRef.deliver).toHaveBeenCalledTimes(invalid.length);
  });
});
