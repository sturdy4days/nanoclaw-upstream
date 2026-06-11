/**
 * Guard for the wirings-create side effect: `ncl wirings create` must route
 * through createMessagingGroupAgent so the companion agent_destinations row
 * exists. With the generic INSERT alone, a CLI-created wiring receives
 * messages but delivery's ACL silently drops every send the agent addresses
 * to the chat (found live 2026-06-11 — the agent looked mute, no error
 * anywhere).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the wirings commands.
import './wirings.js';

function now(): string {
  return new Date().toISOString();
}

describe('wirings create → destination side effect', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:-100',
      name: 'Group',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('creates the wiring AND the companion agent_destinations row', async () => {
    const res = await dispatch(
      {
        id: 'req-wire-1',
        command: 'wirings-create',
        args: { messaging_group_id: 'mg-1', agent_group_id: 'ag-1', engage_mode: 'mention' },
      },
      { caller: 'host' },
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const wiring = getDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
      .get('mg-1', 'ag-1');
    expect(wiring).toBeTruthy();

    const dest = getDb()
      .prepare("SELECT * FROM agent_destinations WHERE agent_group_id = 'ag-1' AND target_id = 'mg-1'")
      .get();
    expect(dest).toBeTruthy();
  });
});
