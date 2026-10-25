import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHttpServer } from '../../dist/http/server.js';
import { authorize } from '../helpers/oauth.js';

const tunnelHost = 'example.ngrok-free.app';
const applications = [];
const stateDirectories = [];

async function start(allowedHosts) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cloudhands-host-state-'));
  stateDirectories.push(stateDirectory);
  const application = createHttpServer({ host: '127.0.0.1', port: 0, cwd: process.cwd(), stateDirectory, allowedHosts });
  applications.push(application);
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', resolve);
  });
  return application.server.address().port;
}

function initialize(port, host, extraHeaders = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'tunnel-test', version: '1.0.0' },
  } });

  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { text += part; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(stateDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('rejects an unconfigured tunnel host before MCP initialization', async () => {
  const port = await start();
  const response = await initialize(port, tunnelHost);
  expect(response.status).toBe(403);
  expect(response.body.error.message).toBe(`Invalid Host: ${tunnelHost}`);
});

test('initializes through an explicitly allowed tunnel with OAuth', async () => {
  const port = await start(['localhost', '127.0.0.1', '[::1]', tunnelHost]);
  const { tokens } = await authorize(applications[0], `http://127.0.0.1:${port}`);
  const authorization = { Authorization: `Bearer ${tokens.access_token}` };
  const response = await initialize(port, tunnelHost, { 'X-Forwarded-Proto': 'https', ...authorization });
  expect(response.status).toBe(200);
  expect(response.body.result.serverInfo.name).toBe('CloudHands');
  expect(response.headers['mcp-session-id']).toBeTruthy();
  expect(response.headers['www-authenticate']).toBeUndefined();
  expect((await initialize(port, `localhost:${port}`, authorization)).status).toBe(200);
});

test('keeps rejecting unconfigured hosts even if they spoof forwarded headers', async () => {
  const port = await start(['localhost', tunnelHost]);
  const response = await initialize(port, 'untrusted.example', {
    'X-Forwarded-Host': tunnelHost,
    'X-Forwarded-Proto': 'https',
  });
  expect(response.status).toBe(403);
});
