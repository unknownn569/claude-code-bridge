import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { ANTHROPIC_API_KEY: 'k', BRIDGE_TOKEN: 't' };

describe('loadConfig', () => {
  it('throws a clear error listing every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/BRIDGE_TOKEN/);
  });

  it('starts without ANTHROPIC_API_KEY and uses the Claude Code login', () => {
    const config = loadConfig({ BRIDGE_TOKEN: 't' });
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it('throws when only one variable is missing', () => {
    expect(() => loadConfig({ ...base, BRIDGE_TOKEN: '' })).toThrow(/BRIDGE_TOKEN/);
  });

  it('applies defaults and reads overrides', () => {
    const config = loadConfig(base);
    expect(config.maxTurns).toBe(40);
    expect(config.maxBudgetUsd).toBe(2);
    expect(config.port).toBe(8080);

    const custom = loadConfig({
      ...base,
      BRIDGE_MODEL: 'claude-sonnet-4-5',
      BRIDGE_MAX_TURNS: '10',
      BRIDGE_MAX_BUDGET_USD: '0.5',
      PORT: '9000',
      BRIDGE_WORKDIR: '/tmp',
    });
    expect(custom.model).toBe('claude-sonnet-4-5');
    expect(custom.maxTurns).toBe(10);
    expect(custom.maxBudgetUsd).toBe(0.5);
    expect(custom.port).toBe(9000);
    expect(custom.workdir).toBe('/tmp');
  });

  it('rejects non-numeric or non-positive numbers', () => {
    expect(() => loadConfig({ ...base, BRIDGE_MAX_TURNS: 'abc' })).toThrow(/BRIDGE_MAX_TURNS/);
    expect(() => loadConfig({ ...base, BRIDGE_MAX_BUDGET_USD: '0' })).toThrow(/BRIDGE_MAX_BUDGET_USD/);
  });
});
