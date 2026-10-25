import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHttpServer } from '../../dist/http/server.js';
import { authorize } from '../helpers/oauth.js';

let directory;
let application;
let baseUrl;
let client;
let transport;
let stateDirectory;
let accessToken;

const text = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
const shell = process.platform === 'win32' ? 'powershell' : 'bash';
const excludedShell = process.platform === 'win32' ? 'bash' : 'powershell';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'llm-gate-test-'));
  stateDirectory = await mkdtemp(join(tmpdir(), 'llm-gate-state-test-'));
  application = createHttpServer({ host: '127.0.0.1', port: 0, cwd: directory, stateDirectory, allowedOrigins: ['https://client.example.com'] });
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  accessToken = (await authorize(application, baseUrl)).tokens.access_token;
  client = new Client({ name: 'jest', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  await client.connect(transport);
});

afterAll(async () => {
  await transport?.terminateSession();
  await client?.close();
  await application?.close();
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
  if (stateDirectory) {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('serves health over HTTP', async () => {
  const response = await fetch(`${baseUrl}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('initializes an MCP session and lists the platform tools with Pi schemas', async () => {
  expect(transport.sessionId).toBeTruthy();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(['read', 'write', 'edit', 'ls', 'grep', 'find', shell].sort());
  expect(tools.find((tool) => tool.name === 'write').inputSchema.required).toEqual(['path', 'content']);
});

test('writes, reads and edits a real file through MCP over HTTP', async () => {
  const written = await client.callTool({ name: 'write', arguments: { path: 'notes.txt', content: 'Hello Pi\n' } });
  expect(written.isError).not.toBe(true);
  expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('Hello Pi\n');

  const edited = await client.callTool({ name: 'edit', arguments: {
    path: 'notes.txt', edits: [{ oldText: 'Hello Pi', newText: 'Hello MCP' }],
  } });
  expect(edited.isError).not.toBe(true);
  expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('Hello MCP\n');

  const read = await client.callTool({ name: 'read', arguments: { path: 'notes.txt' } });
  expect(read.isError).not.toBe(true);
  expect(text(read)).toContain('Hello MCP');
});

test('lists actual directory entries', async () => {
  await writeFile(join(directory, 'listing.txt'), 'listing');
  const result = await client.callTool({ name: 'ls', arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toContain('listing.txt');
});

test('executes the native shell and uses the configured working directory', async () => {
  const command = process.platform === 'win32'
    ? "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'shell.txt'), 'shell works'); Write-Output 'shell works'"
    : "printf 'shell works' > shell.txt; cat shell.txt";
  const result = await client.callTool({ name: shell, arguments: { command, timeout: 10 } });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toContain('shell works');
  expect(await readFile(join(directory, 'shell.txt'), 'utf8')).toBe('shell works');
  expect(result.structuredContent).toMatchObject({ output: expect.stringContaining('shell works'), exit_code: 0 });
});

test('preserves non-zero shell exit status as an MCP tool error', async () => {
  const result = await client.callTool({ name: shell, arguments: { command: 'exit 7', timeout: 10 } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent.exit_code).toBe(7);
});

test('returns tool execution errors and keeps the session usable', async () => {
  const result = await client.callTool({ name: 'read', arguments: { path: 'missing-file.txt' } });
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/ENOENT|not found/i);
  await expect(client.listTools()).resolves.toHaveProperty('tools');
});

test.each([
  ['write', { path: 'invalid.txt', content: 42 }],
  ['read', {}],
  ['edit', { path: 'invalid.txt', edits: [{ oldText: 'x' }] }],
])('validates %s arguments against the original Pi schema', async (name, args) => {
  await expect(client.callTool({ name, arguments: args })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
});

test.each([excludedShell, 'unknown'])('rejects unavailable tool %s', async (name) => {
  await expect(client.callTool({ name, arguments: { command: 'echo unexpected' } })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
});

test('isolates independent MCP sessions and removes a terminated session', async () => {
  const secondClient = new Client({ name: 'second-jest', version: '1.0.0' });
  const secondTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  await secondClient.connect(secondTransport);
  const sessionId = secondTransport.sessionId;

  try {
    expect(sessionId).not.toBe(transport.sessionId);
    await secondTransport.terminateSession();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
    await expect(client.listTools()).resolves.toHaveProperty('tools');
  } finally {
    await secondClient.close();
  }
});

test('rejects requests without an initialized session', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(response.status).toBe(400);
});

test('rejects malformed JSON', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  expect(response.status).toBe(400);
});

test('rejects unsupported methods and foreign origins', async () => {
  const methodResponse = await fetch(`${baseUrl}/mcp`, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } });
  expect(methodResponse.status).toBe(405);
  const originResponse = await fetch(`${baseUrl}/mcp`, { headers: { Origin: 'https://untrusted.example' } });
  expect(originResponse.status).toBe(403);
});

test('supports browser CORS preflight for explicitly allowed origins', async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://client.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example.com');
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('MCP-Session-Id');
});

test.each(['2025-03-26', '2025-06-18', LATEST_PROTOCOL_VERSION])('negotiates MCP %s with a raw HTTP client', async (protocolVersion) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${accessToken}` };
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion, capabilities: {}, clientInfo: { name: 'compatibility-test', version: '1.0.0' },
    } }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect((await response.json()).result.protocolVersion).toBe(protocolVersion);
  const sessionHeaders = {
    ...headers,
    'MCP-Session-Id': response.headers.get('MCP-Session-Id'),
    'MCP-Protocol-Version': protocolVersion,
  };

  try {
    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(initialized.status).toBe(202);
    const listed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect((await listed.json()).result.tools).toHaveLength(7);
  } finally {
    await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: sessionHeaders });
  }
});

test('publishes OAuth discovery without authentication', async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  expect(response.status).toBe(200);
  expect((await response.json()).code_challenge_methods_supported).toEqual(['S256']);
});
