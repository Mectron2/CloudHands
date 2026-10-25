import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface StoredClient {
  info: OAuthClientInformationFull;
  secretHash?: string;
}

export interface Grant {
  id: string;
  clientId: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface StoredToken {
  hash: string;
  kind: 'access' | 'refresh';
  grantId: string;
  scopes: string[];
  expiresAt: number;
  used: boolean;
}

interface State {
  version: 1;
  binding: string;
  clients: StoredClient[];
  grants: Grant[];
  tokens: StoredToken[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validState(value: unknown): value is State {
  return record(value) && value.version === 1 && typeof value.binding === 'string'
    && Array.isArray(value.clients) && value.clients.every((client) => record(client)
      && OAuthClientInformationFullSchema.safeParse(client.info).success
      && (client.secretHash === undefined || (typeof client.secretHash === 'string' && /^[a-f0-9]{64}$/.test(client.secretHash))))
    && Array.isArray(value.grants) && value.grants.every((grant) => record(grant)
      && typeof grant.id === 'string' && typeof grant.clientId === 'string' && strings(grant.scopes)
      && typeof grant.createdAt === 'number' && Number.isFinite(grant.createdAt)
      && typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt) && typeof grant.revoked === 'boolean')
    && Array.isArray(value.tokens) && value.tokens.every((token) => record(token)
      && typeof token.hash === 'string' && /^[a-f0-9]{64}$/.test(token.hash)
      && ['access', 'refresh'].includes(String(token.kind)) && typeof token.grantId === 'string'
      && strings(token.scopes) && typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt)
      && typeof token.used === 'boolean');
}

function canonicalPath(path: string): string {
  if (existsSync(path)) {
    return realpathSync(path);
  }
  const parent = dirname(path);
  if (parent === path) {
    throw new Error(`Filesystem root does not exist: ${path}`);
  }
  return resolve(canonicalPath(parent), relative(parent, path));
}

export function isWithin(root: string, path: string): boolean {
  const difference = relative(canonicalPath(root), canonicalPath(path));
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..\\`) && !difference.startsWith('../'));
}

export class OAuthStore {
  private state: State;
  private closed = false;
  private readonly file: string;
  private readonly lock: string;
  private readonly lockId = randomUUID();

  constructor(directory: string, binding: string, workspace: string) {
    if (isWithin(workspace, directory)) {
      throw new Error('MCP_STATE_DIR must be outside MCP_CWD');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = resolve(directory, 'oauth.json');
    this.lock = resolve(directory, 'server.lock');

    try {
      writeFileSync(this.lock, JSON.stringify({ pid: process.pid, id: this.lockId }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!record(error) || error.code !== 'EEXIST') {
        throw error;
      }
      const previous: unknown = JSON.parse(readFileSync(this.lock, 'utf8'));
      if (!record(previous) || typeof previous.pid !== 'number') {
        throw new Error('Invalid OAuth lock file');
      }
      try {
        process.kill(previous.pid, 0);
        throw new Error('Another llm-gate process is using MCP_STATE_DIR');
      } catch (probeError) {
        if (!record(probeError) || probeError.code !== 'ESRCH') {
          throw probeError;
        }
      }
      unlinkSync(this.lock);
      writeFileSync(this.lock, JSON.stringify({ pid: process.pid, id: this.lockId }), { flag: 'wx', mode: 0o600 });
    }

    try {
      const initial: State = { version: 1, binding, clients: [], grants: [], tokens: [] };
      if (existsSync(this.file)) {
        if (lstatSync(this.file).isSymbolicLink()) {
          throw new Error('OAuth state must not be a symbolic link');
        }
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!validState(parsed)) {
          throw new Error('Invalid OAuth state file');
        }
        this.state = parsed.binding === binding ? parsed : initial;
      } else {
        this.state = initial;
      }
      this.update(() => {});
    } catch (error) {
      this.close();
      throw error;
    }
  }

  read(): State {
    if (this.closed) {
      throw new Error('OAuth state store is closed');
    }
    return structuredClone(this.state);
  }

  update(change: (state: State) => void): void {
    if (this.closed) {
      throw new Error('OAuth state store is closed');
    }
    const next = structuredClone(this.state);
    change(next);
    const now = Date.now() / 1000;
    next.tokens = next.tokens.filter((token) => token.expiresAt > now);
    next.grants = next.grants.filter((grant) => grant.expiresAt > now);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
      this.state = next;
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    if (existsSync(this.lock)) {
      const lock: unknown = JSON.parse(readFileSync(this.lock, 'utf8'));
      if (record(lock) && lock.id === this.lockId) {
        unlinkSync(this.lock);
      }
    }
    this.closed = true;
  }
}
