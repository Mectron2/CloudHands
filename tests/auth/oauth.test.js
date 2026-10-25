import { jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHttpServer } from '../../dist/http/server.js';
import { allScopes, authorize, beginAuthorization, completeAuthorization, exchangeCode, registerClient } from '../helpers/oauth.js';

let root;
let workspace;
let stateDirectory;
let application;
let baseUrl;

async function start(overrides = {}) {
  application = createHttpServer({ host: '127.0.0.1', port: 0, cwd: workspace, stateDirectory, ...overrides });
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${application.server.address().port}`;
}

function form(path, params, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
}

function refresh(connection, overrides = {}) {
  return form('/token', {
    grant_type: 'refresh_token', client_id: connection.client.client_id,
    refresh_token: connection.tokens.refresh_token, resource: application.auth.resource.href, ...overrides,
  });
}

async function mcp(token, method = 'tools/list', params = {}, sessionId) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { 'MCP-Session-Id': sessionId, 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cloudhands-oauth-'));
  workspace = join(root, 'workspace');
  stateDirectory = join(root, 'state');
  await mkdir(workspace);
  await start();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await application?.close();
  await rm(root, { recursive: true, force: true });
});

test('challenges unauthenticated and invalid tokens with discoverable OAuth metadata', async () => {
  for (const token of [undefined, 'invalid']) {
    const response = await mcp(token);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${application.auth.issuer.origin}/.well-known/oauth-protected-resource/mcp"`);
  }
  const metadata = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
  expect(metadata.resource).toBe(application.auth.resource.href);
  expect(metadata.authorization_servers).toEqual([application.auth.issuer.href]);
  const discovery = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
  expect(discovery.code_challenge_methods_supported).toEqual(['S256']);
  expect(discovery.registration_endpoint).toBe(`${baseUrl}/register`);
});

test('requires local approval and binds the browser continuation to an HttpOnly cookie', async () => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client);
  expect(flow.response.status).toBe(303);
  expect(flow.response.headers.get('Set-Cookie')).toContain('HttpOnly');
  expect(flow.response.headers.get('Set-Cookie')).toContain('SameSite=Lax');
  const waiting = await fetch(`${baseUrl}${flow.page}`, { headers: { Cookie: flow.cookie } });
  expect(waiting.status).toBe(200);
  expect(await waiting.text()).toContain(`approve ${flow.id}`);
  const missingCookie = await fetch(`${baseUrl}${flow.page}`, { redirect: 'manual' });
  expect(missingCookie.status).toBe(404);
  const forgedCookie = await fetch(`${baseUrl}${flow.page}`, { headers: { Cookie: `cloudhands_${flow.id}=forged` }, redirect: 'manual' });
  expect(forgedCookie.status).toBe(404);
  expect((await form('/oauth/approve', { id: flow.id, approve: 'true' })).status).toBe(404);
  expect(application.auth.listConnections()).toEqual([]);
  expect((await exchangeCode(application, baseUrl, flow, flow.id)).status).toBe(400);

  const completed = await completeAuthorization(application, baseUrl, flow);
  const redirect = new URL(completed.response.headers.get('Location'));
  expect(redirect.origin).toBe('https://client.example');
  expect(redirect.searchParams.get('state')).toBe(flow.params.state);
  expect(redirect.searchParams.get('iss')).toBe(application.auth.issuer.href);
  const tokens = await (await exchangeCode(application, baseUrl, flow, completed.code)).json();
  expect(tokens.token_type).toBe('Bearer');
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  expect(tokens.scope.split(' ')).toEqual(allScopes);
  expect((await fetch(`${baseUrl}${flow.page}`, { headers: { Cookie: flow.cookie }, redirect: 'manual' })).status).toBe(404);
});

test('denial returns access_denied without issuing tokens', async () => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client);
  application.auth.deny(flow.id);
  const response = await fetch(`${baseUrl}${flow.page}`, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  const redirect = new URL(response.headers.get('Location'));
  expect(redirect.searchParams.get('error')).toBe('access_denied');
  expect(redirect.searchParams.get('state')).toBe(flow.params.state);
  expect(redirect.searchParams.has('code')).toBe(false);
  expect(application.auth.listConnections()).toEqual([]);
});

test('expires pending approvals and short-lived authorization codes', async () => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client);
  const current = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(current + 301000);
  expect(() => application.auth.approve(flow.id)).toThrow('expired');
  jest.restoreAllMocks();
  const second = await beginAuthorization(application, baseUrl, client);
  const completed = await completeAuthorization(application, baseUrl, second);
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  expect((await exchangeCode(application, baseUrl, second, completed.code)).status).toBe(400);
});

test('validates PKCE and consumes an authorization code exactly once', async () => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client);
  const completed = await completeAuthorization(application, baseUrl, flow);
  const wrong = await exchangeCode(application, baseUrl, flow, completed.code, { code_verifier: 'incorrect-verifier' });
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).error).toBe('invalid_grant');
  expect((await exchangeCode(application, baseUrl, flow, completed.code)).status).toBe(200);
  expect((await exchangeCode(application, baseUrl, flow, completed.code)).status).toBe(400);
});

test('binds authorization codes to the client, redirect URI and target resource', async () => {
  const client = await registerClient(baseUrl);
  const other = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client);
  const { code } = await completeAuthorization(application, baseUrl, flow);
  for (const override of [
    { client_id: other.client_id },
    { redirect_uri: 'https://attacker.example/callback' },
    { resource: 'https://other.example/mcp' },
    { resource: '' },
  ]) {
    expect((await exchangeCode(application, baseUrl, flow, code, override)).status).toBe(400);
  }
  expect((await exchangeCode(application, baseUrl, flow, code)).status).toBe(200);
});

test.each([
  { redirect_uri: 'https://attacker.example/callback' },
  { code_challenge_method: 'plain' },
  { code_challenge: 'short' },
  { resource: 'https://other.example/mcp' },
  { scope: 'administrator' },
])('rejects invalid authorization parameters: %j', async (overrides) => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client, overrides);
  expect(flow.id).toBeUndefined();
  expect(application.auth.listPending()).toEqual([]);
});

test.each(['https://client.example/callback#fragment', 'http://public.example/callback', 'file:///tmp/callback', 'https://user:secret@client.example/callback'])('rejects unsafe registered callback %s', async (redirect) => {
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
  });
  expect(response.status).toBe(400);
});

test('enforces read-only scopes and filters tool discovery', async () => {
  const connection = await authorize(application, baseUrl, ['files:read']);
  const client = new Client({ name: 'scope-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${connection.tokens.access_token}` } },
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['find', 'grep', 'ls', 'read']);
    const listed = await client.callTool({ name: 'ls', arguments: {} });
    expect(listed.isError).not.toBe(true);
    for (const name of ['write', 'edit', process.platform === 'win32' ? 'powershell' : 'bash']) {
      const response = await mcp(connection.tokens.access_token, 'tools/call', { name, arguments: {} }, transport.sessionId);
      expect(response.status).toBe(403);
      expect(response.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
    }
  } finally {
    await transport.terminateSession();
    await client.close();
  }
});

test('allows the local owner to narrow approval but never expand requested scopes', async () => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client, { scope: 'files:read files:write' });
  expect(() => application.auth.approve(flow.id, ['commands:execute'])).toThrow('not requested');
  const { code } = await completeAuthorization(application, baseUrl, flow, ['files:read']);
  const response = await exchangeCode(application, baseUrl, flow, code);
  expect((await response.json()).scope).toBe('files:read');
});

test('rotates refresh tokens and revokes the connection if an old token is reused', async () => {
  const connection = await authorize(application, baseUrl);
  const response = await refresh(connection);
  expect(response.status).toBe(200);
  const rotated = await response.json();
  expect(rotated.refresh_token).not.toBe(connection.tokens.refresh_token);
  expect((await application.auth.verifyAccessToken(rotated.access_token)).clientId).toBe(connection.client.client_id);
  const reused = await refresh(connection);
  expect(reused.status).toBe(400);
  expect((await reused.json()).error).toBe('invalid_grant');
  expect((await mcp(rotated.access_token)).status).toBe(401);
  expect((await refresh({ ...connection, tokens: rotated })).status).toBe(400);
});

test('refresh cannot expand permissions or change the resource or client', async () => {
  const connection = await authorize(application, baseUrl, ['files:read']);
  const other = await registerClient(baseUrl);
  for (const overrides of [{ scope: 'files:write' }, { resource: 'https://other.example/mcp' }, { client_id: other.client_id }]) {
    expect((await refresh(connection, overrides)).status).toBe(400);
  }
  expect((await refresh(connection)).status).toBe(200);
});

test('expires access tokens while allowing refresh within the connection lifetime', async () => {
  const connection = await authorize(application, baseUrl);
  const current = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(current + 16 * 60 * 1000);
  expect((await mcp(connection.tokens.access_token)).status).toBe(401);
  expect((await refresh(connection)).status).toBe(200);
  jest.spyOn(Date, 'now').mockReturnValue(current + 31 * 24 * 60 * 60 * 1000);
  expect((await refresh(connection)).status).toBe(400);
});

test('supports confidential clients and stores only hashes of secrets', async () => {
  const connection = await authorize(application, baseUrl, allScopes, { token_endpoint_auth_method: 'client_secret_post' });
  expect(connection.client.client_secret).toBeTruthy();
  expect((await refresh(connection)).status).toBe(401);
  expect((await refresh(connection, { client_secret: 'wrong-secret' })).status).toBe(401);
  expect((await refresh(connection, { client_secret: connection.client.client_secret })).status).toBe(200);
  const stored = await readFile(join(stateDirectory, 'oauth.json'), 'utf8');
  for (const value of [connection.client.client_secret, connection.tokens.access_token, connection.tokens.refresh_token]) {
    expect(stored).not.toContain(value);
  }
});

test('authenticates client_secret_basic without accepting mixed credentials', async () => {
  const client = await registerClient(baseUrl, { token_endpoint_auth_method: 'client_secret_basic' });
  const flow = await beginAuthorization(application, baseUrl, client);
  const { code } = await completeAuthorization(application, baseUrl, flow);
  const params = {
    grant_type: 'authorization_code', code, code_verifier: flow.verifier,
    redirect_uri: flow.params.redirect_uri, resource: application.auth.resource.href,
  };
  const headers = { Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` };
  expect((await form('/token', { ...params, client_id: client.client_id }, headers)).status).toBe(401);
  const response = await form('/token', params, headers);
  expect(response.status).toBe(200);
  expect((await response.json()).access_token).toBeTruthy();
});

test('revocation stops both access and refresh tokens but cannot revoke another client', async () => {
  const connection = await authorize(application, baseUrl);
  const other = await registerClient(baseUrl);
  const params = { client_id: other.client_id, token: connection.tokens.refresh_token };
  expect((await form('/revoke', params)).status).toBe(200);
  await expect(application.auth.verifyAccessToken(connection.tokens.access_token)).resolves.toHaveProperty('clientId');
  expect((await form('/revoke', { ...params, client_id: connection.client.client_id })).status).toBe(200);
  expect((await mcp(connection.tokens.access_token)).status).toBe(401);
  expect((await refresh(connection)).status).toBe(400);
});

test('binds MCP session IDs to the approved connection', async () => {
  const first = await authorize(application, baseUrl);
  const second = await authorize(application, baseUrl);
  const response = await mcp(first.tokens.access_token, 'initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'first', version: '1.0.0' },
  });
  const sessionId = response.headers.get('MCP-Session-Id');
  expect(sessionId).toBeTruthy();
  expect((await mcp(second.tokens.access_token, 'tools/list', {}, sessionId)).status).toBe(404);
  application.auth.revokeConnection(first.grantId);
  expect((await mcp(first.tokens.access_token, 'tools/list', {}, sessionId)).status).toBe(401);
});

test('persists connections across restart and invalidates them when the public URL changes', async () => {
  await application.close();
  await start({ publicUrl: 'https://mcp.example.test' });
  const connection = await authorize(application, baseUrl);
  await application.close();
  await start({ publicUrl: 'https://mcp.example.test' });
  await expect(application.auth.verifyAccessToken(connection.tokens.access_token)).resolves.toHaveProperty('clientId');
  expect((await refresh(connection)).status).toBe(200);
  await application.close();
  await start({ publicUrl: 'https://changed.example.test' });
  await expect(application.auth.verifyAccessToken(connection.tokens.access_token)).rejects.toThrow('Invalid');
  expect(application.auth.listConnections()).toEqual([]);
});

test('MCP SDK completes automatic discovery, dynamic registration and PKCE exchange', async () => {
  let information;
  let tokens;
  let verifier;
  let authorizationUrl;
  const oauthClient = {
    redirectUrl: 'https://client.example/callback',
    clientMetadata: {
      client_name: 'SDK OAuth test', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    },
    clientInformation: () => information,
    saveClientInformation: (value) => { information = value; },
    tokens: () => tokens,
    saveTokens: (value) => { tokens = value; },
    redirectToAuthorization: (url) => { authorizationUrl = url; },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
  };
  const client = new Client({ name: 'oauth-sdk-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: oauthClient });
  await expect(client.connect(transport)).rejects.toThrow();
  expect(authorizationUrl).toBeInstanceOf(URL);
  const pending = await fetch(authorizationUrl, { redirect: 'manual' });
  const path = new URL(pending.headers.get('Location')).pathname;
  const cookie = pending.headers.getSetCookie()[0].split(';')[0];
  application.auth.approve(path.split('/').at(-1));
  const completed = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  const code = new URL(completed.headers.get('Location')).searchParams.get('code');
  await transport.finishAuth(code);
  expect(tokens.access_token).toBeTruthy();
  await client.close();
  const authenticatedClient = new Client({ name: 'oauth-sdk-client', version: '1.0.0' });
  const authenticatedTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: oauthClient });
  try {
    await authenticatedClient.connect(authenticatedTransport);
    expect((await authenticatedClient.listTools()).tools).toHaveLength(7);
  } finally {
    await authenticatedTransport.terminateSession();
    await authenticatedClient.close();
  }
});

test('rate limits invalid client authentication before token processing', async () => {
  let response;
  for (let index = 0; index < 51; index++) {
    response = await form('/token', { grant_type: 'refresh_token', client_id: 'unknown', refresh_token: 'invalid' });
  }
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBeTruthy();
});
