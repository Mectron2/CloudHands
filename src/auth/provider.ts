import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ClientStore } from './clients.js';
import { hashSecret, matchesSecret, secret } from './secrets.js';
import { SCOPES } from './scopes.js';
import { OAuthStore, type Grant } from './store.js';

const ACCESS_SECONDS = 15 * 60;
const GRANT_SECONDS = 30 * 24 * 60 * 60;
const APPROVAL_SECONDS = 5 * 60;

interface Pending {
  id: string;
  clientId: string;
  clientName: string;
  params: AuthorizationParams;
  scopes: string[];
  browserHash: string;
  expiresAt: number;
  decision: 'pending' | 'approved' | 'denied';
  grantId?: string;
}

interface Code {
  clientId: string;
  grantId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

export interface PendingApproval {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

export class LocalOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: ClientStore;
  readonly resource: URL;
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  private readonly pendingListeners = new Set<(request: PendingApproval) => void>();
  private readonly revocationListeners = new Set<(grantId: string) => void>();

  constructor(readonly issuer: URL, private readonly store: OAuthStore) {
    this.resource = new URL('/mcp', issuer);
    this.clientsStore = new ClientStore(store);
  }

  onPending(listener: (request: PendingApproval) => void): () => void {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  }

  onRevoked(listener: (grantId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  private prune(): void {
    const now = Date.now() / 1000;
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) {
        this.pending.delete(id);
      }
    }
    for (const [id, code] of this.codes) {
      if (code.expiresAt <= now) {
        this.codes.delete(id);
      }
    }
  }

  listPending(): PendingApproval[] {
    this.prune();
    return [...this.pending.values()].filter((request) => request.decision === 'pending').map((request) => ({
      id: request.id,
      clientId: request.clientId,
      clientName: request.clientName,
      redirectUri: request.params.redirectUri,
      scopes: [...request.scopes],
      expiresAt: request.expiresAt,
    }));
  }

  listConnections() {
    const state = this.store.read();
    return state.grants.map((grant) => ({
      ...grant,
      clientName: state.clients.find((client) => client.info.client_id === grant.clientId)?.info.client_name ?? grant.clientId,
    }));
  }

  private validateResource(resource: URL | undefined): void {
    if (resource?.href !== this.resource.href) {
      throw new InvalidTargetError(`Resource must be ${this.resource.href}`);
    }
  }

  private validateScopes(scopes: string[]): void {
    if (!scopes.length || scopes.some((scope) => !SCOPES.some((supported) => supported === scope))) {
      throw new InvalidScopeError('Unsupported or empty scope');
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    this.validateResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
      throw new InvalidGrantError('Invalid S256 code challenge');
    }
    const scopes = [...new Set(params.scopes?.length ? params.scopes : ['files:read'])];
    this.validateScopes(scopes);
    this.prune();
    if (this.pending.size >= 50) {
      throw new TooManyRequestsError('Too many pending approvals');
    }
    const id = randomBytes(6).toString('hex');
    const browserSecret = secret();
    const pending: Pending = {
      id, clientId: client.client_id, clientName: client.client_name ?? client.client_id,
      params, scopes, browserHash: hashSecret(browserSecret), expiresAt: Date.now() / 1000 + APPROVAL_SECONDS,
      decision: 'pending',
    };
    this.pending.set(id, pending);
    response.cookie(`cloudhands_${id}`, browserSecret, {
      httpOnly: true, secure: this.issuer.protocol === 'https:', sameSite: 'lax',
      path: `/oauth/pending/${id}`, maxAge: APPROVAL_SECONDS * 1000,
    });
    response.redirect(303, new URL(`/oauth/pending/${id}`, this.issuer).href);
    const view = this.listPending().find((request) => request.id === id);
    if (view) {
      for (const listener of this.pendingListeners) {
        listener(view);
      }
    }
  }

  approve(id: string, scopes?: string[]): string {
    this.prune();
    const request = this.pending.get(id);
    if (!request || request.decision !== 'pending') {
      throw new Error('Pending request not found or expired');
    }
    const approved = [...new Set(scopes ?? request.scopes)];
    this.validateScopes(approved);
    if (approved.some((scope) => !request.scopes.includes(scope))) {
      throw new Error('Approval cannot add scopes that were not requested');
    }
    const grant: Grant = {
      id: randomUUID(), clientId: request.clientId, scopes: approved,
      createdAt: Date.now() / 1000, expiresAt: Date.now() / 1000 + GRANT_SECONDS, revoked: false,
    };
    this.store.update((state) => { state.grants.push(grant); });
    request.scopes = approved;
    request.grantId = grant.id;
    request.decision = 'approved';
    return grant.id;
  }

  deny(id: string): void {
    this.prune();
    const request = this.pending.get(id);
    if (!request || request.decision !== 'pending') {
      throw new Error('Pending request not found or expired');
    }
    request.decision = 'denied';
  }

  revokeConnection(id: string): void {
    if (!this.store.read().grants.some((grant) => grant.id === id)) {
      throw new Error('Connection not found');
    }
    this.store.update((state) => {
      const grant = state.grants.find((entry) => entry.id === id);
      if (grant) {
        grant.revoked = true;
      }
    });
    for (const listener of this.revocationListeners) {
      listener(id);
    }
  }

  pendingPage(request: Request, response: Response): void {
    this.prune();
    const id = request.params.id;
    const pending = typeof id === 'string' ? this.pending.get(id) : undefined;
    const cookie = request.headers.cookie?.split(';').map((value) => value.trim())
      .find((value) => value.startsWith(`cloudhands_${id}=`))?.split('=')[1];
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!pending || !cookie || !matchesSecret(cookie, pending.browserHash)) {
      response.status(404).send('Authorization request not found or expired');
      return;
    }
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined) {
      redirect.searchParams.set('state', pending.params.state);
    }
    redirect.searchParams.set('iss', this.issuer.href);

    if (pending.decision === 'denied') {
      this.pending.delete(pending.id);
      redirect.searchParams.set('error', 'access_denied');
      response.redirect(302, redirect.href);
      return;
    }
    if (pending.decision === 'approved' && pending.grantId) {
      const grant = this.store.read().grants.find((entry) => entry.id === pending.grantId);
      if (!grant || grant.revoked || grant.expiresAt <= Date.now() / 1000) {
        this.pending.delete(pending.id);
        redirect.searchParams.set('error', 'access_denied');
        response.redirect(302, redirect.href);
        return;
      }
      const code = secret();
      this.codes.set(hashSecret(code), {
        clientId: pending.clientId, grantId: pending.grantId, redirectUri: pending.params.redirectUri,
        challenge: pending.params.codeChallenge, expiresAt: Date.now() / 1000 + 60,
      });
      this.pending.delete(pending.id);
      response.clearCookie(`cloudhands_${pending.id}`, { path: `/oauth/pending/${pending.id}` });
      redirect.searchParams.set('code', code);
      response.redirect(302, redirect.href);
      return;
    }
    response.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>CloudHands: connection approval</title><body><h1>Approve the connection in the CloudHands terminal</h1><p>Request: <strong>${pending.id}</strong></p><p>In your local terminal, verify the client, callback URL, and requested permissions, then enter <code>approve ${pending.id}</code> or <code>deny ${pending.id}</code>.</p><p>This page refreshes automatically. The request expires after 5 minutes.</p></body></html>`);
  }

  private findCode(client: OAuthClientInformationFull, code: string): Code {
    this.prune();
    const entry = this.codes.get(hashSecret(code));
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.findCode(client, code).challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.validateResource(resource);
    const entry = this.findCode(client, code);
    if (redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('Redirect URI does not match');
    }
    const grant = this.store.read().grants.find((item) => item.id === entry.grantId);
    if (!grant || grant.revoked || grant.expiresAt <= Date.now() / 1000) {
      throw new InvalidGrantError('Authorization has been revoked or expired');
    }
    this.codes.delete(hashSecret(code));
    return this.issueTokens(grant, grant.scopes);
  }

  private issueTokens(grant: Grant, scopes: string[], previousRefreshHash?: string): OAuthTokens {
    const access = secret();
    const refresh = secret();
    const expiresAt = Math.min(Date.now() / 1000 + ACCESS_SECONDS, grant.expiresAt);
    this.store.update((state) => {
      if (previousRefreshHash) {
        const previous = state.tokens.find((token) => token.hash === previousRefreshHash);
        if (!previous || previous.used) {
          throw new InvalidGrantError('Refresh token is no longer active');
        }
        previous.used = true;
      }
      state.tokens.push(
        { hash: hashSecret(access), kind: 'access', grantId: grant.id, scopes, expiresAt, used: false },
        { hash: hashSecret(refresh), kind: 'refresh', grantId: grant.id, scopes, expiresAt: grant.expiresAt, used: false },
      );
    });
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(expiresAt - Date.now() / 1000), refresh_token: refresh, scope: scopes.join(' ') };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.validateResource(resource);
    const state = this.store.read();
    const token = state.tokens.find((entry) => entry.hash === hashSecret(refresh) && entry.kind === 'refresh');
    const grant = state.grants.find((entry) => entry.id === token?.grantId && entry.clientId === client.client_id);
    if (!token || !grant || grant.revoked || token.expiresAt <= Date.now() / 1000 || grant.expiresAt <= Date.now() / 1000) {
      throw new InvalidGrantError('Invalid, revoked or expired refresh token');
    }
    if (token.used) {
      this.revokeConnection(grant.id);
      throw new InvalidGrantError('Refresh token reuse detected; connection revoked');
    }
    const requested = [...new Set(scopes ?? token.scopes)];
    this.validateScopes(requested);
    if (requested.some((scope) => !token.scopes.includes(scope))) {
      throw new InvalidScopeError('Refresh cannot expand granted scopes');
    }
    return this.issueTokens(grant, requested, token.hash);
  }

  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const state = this.store.read();
    const token = state.tokens.find((entry) => entry.hash === hashSecret(value) && entry.kind === 'access');
    const grant = state.grants.find((entry) => entry.id === token?.grantId);
    if (!token || !grant || grant.revoked || token.expiresAt <= Date.now() / 1000 || grant.expiresAt <= Date.now() / 1000) {
      throw new InvalidTokenError('Invalid, revoked or expired access token');
    }
    return { token: value, clientId: grant.clientId, scopes: token.scopes, expiresAt: token.expiresAt, resource: this.resource, extra: { grantId: grant.id } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const state = this.store.read();
    const token = state.tokens.find((entry) => entry.hash === hashSecret(request.token));
    const grant = state.grants.find((entry) => entry.id === token?.grantId && entry.clientId === client.client_id);
    if (grant && !grant.revoked) {
      this.revokeConnection(grant.id);
    }
  }

  close(): void {
    this.pending.clear();
    this.codes.clear();
    this.pendingListeners.clear();
    this.revocationListeners.clear();
    this.store.close();
  }
}
