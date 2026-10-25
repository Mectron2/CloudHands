import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { RequestHandler } from 'express';
import { hashSecret, matchesSecret } from './secrets.js';
import { OAuthStore } from './store.js';

export class ClientStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: OAuthStore) {}

  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.store.read().clients.find((client) => client.info.client_id === id)?.info;
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const method = client.token_endpoint_auth_method ?? 'client_secret_post';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      throw new InvalidClientMetadataError('Unsupported token endpoint authentication method');
    }
    if (client.grant_types?.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))
      || client.response_types?.some((type) => type !== 'code')) {
      throw new InvalidClientMetadataError('Only authorization_code, refresh_token and code responses are supported');
    }
    if (!client.redirect_uris.length || client.redirect_uris.length > 10 || client.redirect_uris.some((redirect) => {
      const url = URL.parse(redirect);
      return !url || url.hash || url.username || url.password
        || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
    })) {
      throw new InvalidClientMetadataError('Redirect URIs must use HTTPS or HTTP loopback and have no fragment or credentials');
    }
    if (method !== 'none' && !client.client_secret) {
      throw new InvalidClientMetadataError('Confidential clients require a generated client secret');
    }
    const info: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: method,
    };
    const { client_secret: clientSecret, ...publicInfo } = info;
    this.store.update((state) => {
      if (state.clients.length >= 1000) {
        throw new InvalidClientMetadataError('Client registration limit reached');
      }
      state.clients.push({ info: publicInfo, ...(clientSecret ? { secretHash: hashSecret(clientSecret) } : {}) });
    });
    return info;
  }

  authenticate(): RequestHandler {
    return (request, response, next) => {
      if (request.method !== 'POST') {
        next();
        return;
      }
      try {
        let id: unknown = request.body?.client_id;
        let password: unknown = request.body?.client_secret;
        let method = password === undefined ? 'none' : 'client_secret_post';
        const authorization = request.headers.authorization;
        if (authorization !== undefined) {
          if (!/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization) || id !== undefined || password !== undefined) {
            throw new InvalidClientError('Invalid client authentication');
          }
          const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
          const separator = decoded.indexOf(':');
          if (separator < 0) {
            throw new InvalidClientError('Invalid client authentication');
          }
          id = decodeURIComponent(decoded.slice(0, separator));
          password = decodeURIComponent(decoded.slice(separator + 1));
          method = 'client_secret_basic';
        }
        const client = this.store.read().clients.find((entry) => entry.info.client_id === id);
        if (!client || client.info.token_endpoint_auth_method !== method
          || (client.secretHash && (typeof password !== 'string' || !matchesSecret(password, client.secretHash)))
          || (client.info.client_secret_expires_at && client.info.client_secret_expires_at <= Date.now() / 1000)) {
          throw new InvalidClientError('Invalid client credentials');
        }
        request.body.client_id = id;
        next();
      } catch (error) {
        const failure = error instanceof InvalidClientError ? error : new InvalidClientError('Invalid client credentials');
        response.setHeader('Cache-Control', 'no-store');
        response.status(401).json(failure.toResponseObject());
      }
    };
  }
}
