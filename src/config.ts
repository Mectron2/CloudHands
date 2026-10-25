import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  cwd: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  publicUrl?: string;
  stateDirectory?: string;
}

export function defaultStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === 'win32'
    ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'cloudhands')
    : join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'cloudhands');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? '127.0.0.1';
  const portValue = env.PORT ?? '3000';
  const port = Number(portValue);
  const cwd = resolve(env.MCP_CWD ?? process.cwd());

  if (!host.trim()) {
    throw new Error('HOST must not be empty');
  }

  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }

  if (!statSync(cwd).isDirectory()) {
    throw new Error(`MCP_CWD must be a directory: ${cwd}`);
  }

  const allowedHosts = env.MCP_ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);
  const allowedOrigins = env.MCP_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean);
  const stateDirectory = resolve(env.MCP_STATE_DIR ?? defaultStateDirectory(env));
  const publicUrl = env.MCP_PUBLIC_URL ? URL.parse(env.MCP_PUBLIC_URL) : undefined;

  if (env.MCP_PUBLIC_URL !== undefined && (!publicUrl || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash
    || !['/', '/mcp'].includes(publicUrl.pathname)
    || !(publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname))))) {
    throw new Error('MCP_PUBLIC_URL must be an HTTPS origin or HTTP loopback URL, optionally ending in /mcp');
  }

  for (const origin of allowedOrigins ?? []) {
    const url = URL.parse(origin);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error(`Invalid origin in MCP_ALLOWED_ORIGINS: ${origin}`);
    }
  }

  return {
    host, port, cwd, stateDirectory,
    ...(publicUrl ? { publicUrl: publicUrl.origin } : {}),
    ...(allowedHosts?.length ? { allowedHosts } : {}),
    ...(allowedOrigins?.length ? { allowedOrigins } : {}),
  };
}
