import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { createOAuthMetadata, mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { LocalOAuthProvider } from './provider.js';
import { SCOPES } from './scopes.js';

export function createOAuthRouter(provider: LocalOAuthProvider) {
  const router = express.Router();
  const validation = { validate: { xForwardedForHeader: false } };
  const tokenLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false,
    skip: (request) => request.method !== 'POST',
    message: { error: 'temporarily_unavailable', error_description: 'Too many token requests' },
    ...validation,
  });
  const metadata = {
    ...createOAuthMetadata({ provider, issuerUrl: provider.issuer, scopesSupported: [...SCOPES] }),
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  };

  router.use('/authorize', authorizationHandler({ provider, rateLimit: validation }));
  router.use('/register', clientRegistrationHandler({ clientsStore: provider.clientsStore, rateLimit: validation }));
  router.use(['/token', '/revoke'], tokenLimit, express.urlencoded({ extended: false, limit: '16kb' }), provider.clientsStore.authenticate());
  router.use('/token', tokenHandler({ provider, rateLimit: false }));
  router.use('/revoke', revocationHandler({ provider, rateLimit: false }));
  router.use(mcpAuthMetadataRouter({ oauthMetadata: metadata, resourceServerUrl: provider.resource, scopesSupported: [...SCOPES], resourceName: 'CloudHands' }));
  router.use('/.well-known/oauth-protected-resource', metadataHandler({
    resource: provider.resource.href,
    authorization_servers: [provider.issuer.href],
    scopes_supported: [...SCOPES],
    resource_name: 'CloudHands',
  }));
  router.get('/oauth/pending/:id', (request, response) => provider.pendingPage(request, response));

  return router;
}
