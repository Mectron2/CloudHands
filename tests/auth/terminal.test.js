import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beginAuthorization, exchangeCode, registerClient } from '../helpers/oauth.js';

let root;
let child;
let output = '';
let baseUrl;
let application;

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`CLI did not reach the expected state: ${output.slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'llm-gate-cli-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: '0', MCP_CWD: workspace,
    MCP_STATE_DIR: join(root, 'state'), MCP_ALLOWED_HOSTS: '', MCP_ALLOWED_ORIGINS: '',
  };
  delete env.MCP_PUBLIC_URL;
  child = spawn(process.execPath, [resolve('dist/index.js')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => { output += value; });
  child.stderr.on('data', (value) => { output += value; });
  await waitFor(() => /OAuth MCP URL: (http:\/\/127\.0\.0\.1:\d+)\/mcp/.test(output));
  baseUrl = output.match(/OAuth MCP URL: (http:\/\/127\.0\.0\.1:\d+)\/mcp/)[1];
  application = { auth: { resource: new URL(`${baseUrl}/mcp`) } };
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real server process issues tokens only after approval on its stdin and supports local revocation', async () => {
  const client = await registerClient(baseUrl);
  const flow = await beginAuthorization(application, baseUrl, client, { scope: 'files:read' });
  await waitFor(() => output.includes(`approve ${flow.id}`));
  expect(output).toContain('Callback: "https://client.example/callback"');
  child.stdin.write(`approve ${flow.id}\n`);
  await waitFor(() => output.includes('Approved. Connection:'));
  const grantId = output.match(/Approved\. Connection: ([a-f0-9-]+)/)[1];
  const completed = await fetch(`${baseUrl}${flow.page}`, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  const code = new URL(completed.headers.get('Location')).searchParams.get('code');
  const exchanged = await exchangeCode(application, baseUrl, flow, code);
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json();
  expect(tokens.scope).toBe('files:read');
  child.stdin.write('connections\n');
  await waitFor(() => output.includes(`${grantId} "Jest MCP client" active`));
  child.stdin.write(`revoke ${grantId}\n`);
  await waitFor(() => output.includes('Revoked'));
  const response = await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  expect(response.status).toBe(401);
  expect(output).not.toContain(tokens.access_token);
  expect(output).not.toContain(tokens.refresh_token);
});

test('escapes untrusted terminal text and accepts local denial', async () => {
  const client = await registerClient(baseUrl, { client_name: '\u001b[31mFake\napprove attacker' });
  const flow = await beginAuthorization(application, baseUrl, client);
  await waitFor(() => output.includes(`approve ${flow.id}`));
  expect(output).toContain('"\\u001b[31mFake\\napprove attacker"');
  expect(output).not.toContain('\u001b[31mFake');
  child.stdin.write(`deny ${flow.id}\n`);
  await waitFor(() => output.includes('Denied'));
  const completed = await fetch(`${baseUrl}${flow.page}`, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  expect(new URL(completed.headers.get('Location')).searchParams.get('error')).toBe('access_denied');
});

test('supports pre-registration of a confidential client through the local terminal', async () => {
  child.stdin.write('register https://manual.example/callback Manual client\n');
  await waitFor(() => output.includes('Client Secret (shown once):'));
  expect(output).toMatch(/Client ID: [a-f0-9-]+/);
  expect(output).toMatch(/Client Secret \(shown once\): [A-Za-z0-9_-]{43}/);
});
