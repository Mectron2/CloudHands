import { createHash, randomBytes } from 'node:crypto';

export const allScopes = ['files:read', 'files:write', 'commands:execute'];

export async function registerClient(baseUrl, overrides = {}) {
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Jest MCP client', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], ...overrides,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Registration failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function beginAuthorization(application, baseUrl, client, overrides = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const params = {
    client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: randomBytes(16).toString('hex'), resource: application.auth.resource.href,
    scope: allScopes.join(' '), ...overrides,
  };
  const response = await fetch(`${baseUrl}/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
  const location = response.headers.get('location');
  return {
    response, verifier, params, client,
    id: location?.includes('/oauth/pending/') ? new URL(location).pathname.split('/').at(-1) : undefined,
    cookie: response.headers.getSetCookie()[0]?.split(';')[0],
    page: location ? new URL(location).pathname : undefined,
  };
}

export async function completeAuthorization(application, baseUrl, flow, scopes) {
  const grantId = application.auth.approve(flow.id, scopes);
  const response = await fetch(`${baseUrl}${flow.page}`, { redirect: 'manual', headers: { Cookie: flow.cookie } });
  return { response, grantId, code: new URL(response.headers.get('location')).searchParams.get('code') };
}

export async function exchangeCode(application, baseUrl, flow, code, overrides = {}) {
  return fetch(`${baseUrl}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: flow.client.client_id, code,
      code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri,
      resource: application.auth.resource.href,
      ...(flow.client.client_secret ? { client_secret: flow.client.client_secret } : {}), ...overrides,
    }),
  });
}

export async function authorize(application, baseUrl, scopes = allScopes, clientOverrides = {}) {
  const client = await registerClient(baseUrl, clientOverrides);
  const flow = await beginAuthorization(application, baseUrl, client, { scope: scopes.join(' ') });
  if (flow.response.status !== 303) {
    throw new Error(`Authorization failed: ${flow.response.status} ${await flow.response.text()}`);
  }
  const completed = await completeAuthorization(application, baseUrl, flow);
  const response = await exchangeCode(application, baseUrl, flow, completed.code);
  if (response.status !== 200) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  return { client, flow, grantId: completed.grantId, tokens: await response.json() };
}
