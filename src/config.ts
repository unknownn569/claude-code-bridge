export interface BridgeConfig {
  anthropicApiKey?: string;
  token: string;
  workdir: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  port: number;
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: "${value}" is not a positive number`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const missing: string[] = [];
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const token = env.BRIDGE_TOKEN;
  if (!token) missing.push('BRIDGE_TOKEN');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in before starting the bridge.',
    );
  }
  return {
    anthropicApiKey,
    token: token as string,
    workdir: env.BRIDGE_WORKDIR || process.cwd(),
    model: env.BRIDGE_MODEL || undefined,
    maxTurns: num(env.BRIDGE_MAX_TURNS, 40, 'BRIDGE_MAX_TURNS'),
    maxBudgetUsd: num(env.BRIDGE_MAX_BUDGET_USD, 2, 'BRIDGE_MAX_BUDGET_USD'),
    port: num(env.PORT, 8080, 'PORT'),
  };
}
