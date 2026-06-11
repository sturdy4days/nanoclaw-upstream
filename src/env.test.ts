import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promoteEnvFlags } from './env.js';

describe('promoteEnvFlags', () => {
  let dir: string;
  let originalCwd: string;
  let savedVitest: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    // The function no-ops under vitest so a developer's live .env can't steer
    // test behavior; lift the guard only inside these tests, which use a
    // fixture .env in a temp cwd.
    savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    delete process.env.NANOCLAW_TEST_FLAG;
    delete process.env.NANOCLAW_TEST_PRESET;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    delete process.env.NANOCLAW_TEST_FLAG;
    delete process.env.NANOCLAW_TEST_PRESET;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('promotes prefixed flags from .env into process.env', () => {
    fs.writeFileSync('.env', 'NANOCLAW_TEST_FLAG=true\nOTHER_KEY=secret\n# NANOCLAW_COMMENTED=x\n');
    promoteEnvFlags();
    expect(process.env.NANOCLAW_TEST_FLAG).toBe('true');
    expect(process.env.OTHER_KEY).toBeUndefined();
    expect(process.env.NANOCLAW_COMMENTED).toBeUndefined();
  });

  it('never overrides values already in process.env', () => {
    process.env.NANOCLAW_TEST_PRESET = 'from-service-env';
    fs.writeFileSync('.env', 'NANOCLAW_TEST_PRESET=from-dotenv\n');
    promoteEnvFlags();
    expect(process.env.NANOCLAW_TEST_PRESET).toBe('from-service-env');
  });

  it('strips surrounding quotes', () => {
    fs.writeFileSync('.env', 'NANOCLAW_TEST_FLAG="quoted value"\n');
    promoteEnvFlags();
    expect(process.env.NANOCLAW_TEST_FLAG).toBe('quoted value');
  });

  it('is a no-op without a .env file', () => {
    expect(() => promoteEnvFlags()).not.toThrow();
    expect(process.env.NANOCLAW_TEST_FLAG).toBeUndefined();
  });

  it('is a no-op under vitest (hermetic tests)', () => {
    process.env.VITEST = 'true';
    fs.writeFileSync('.env', 'NANOCLAW_TEST_FLAG=true\n');
    promoteEnvFlags();
    expect(process.env.NANOCLAW_TEST_FLAG).toBeUndefined();
  });
});
