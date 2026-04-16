import path from 'path';
import fs from 'fs';

export interface ClientConfig {
  serverUrl: string;         // Mac Mini LifeOS server, e.g. http://192.168.1.10:3000
  jpegQuality: number;       // 1-100, default 60
  heartbeatIntervalMs: number;
  sessionPollIntervalMs: number;
  sensitiveApps: string[];   // additional apps to skip beyond defaults
}

const CONFIG_PATH = path.join(process.env.HOME ?? '~', '.lifeos-client', 'config.json');

const DEFAULTS: ClientConfig = {
  serverUrl: process.env.LIFEOS_SERVER_URL ?? 'http://localhost:3000',
  jpegQuality: 60,
  heartbeatIntervalMs: 10_000,
  sessionPollIntervalMs: 5_000,
  sensitiveApps: [],
};

export function loadConfig(): ClientConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<ClientConfig>;
      return { ...DEFAULTS, ...raw };
    }
  } catch {
    console.warn('[config] Failed to read config, using defaults');
  }
  return { ...DEFAULTS };
}
