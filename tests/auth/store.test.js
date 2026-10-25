import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OAuthStore } from '../../dist/auth/store.js';

let root;
let workspace;
let directory;
const stores = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cloudhands-store-'));
  workspace = join(root, 'workspace');
  directory = join(root, 'state');
  await mkdir(workspace);
});

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await rm(root, { recursive: true, force: true });
});

function open(binding = 'server-and-workspace') {
  const store = new OAuthStore(directory, binding, workspace);
  stores.push(store);
  return store;
}

test('refuses to put OAuth state inside the shared workspace', () => {
  expect(() => new OAuthStore(join(workspace, 'state'), 'test', workspace)).toThrow('outside MCP_CWD');
});

test('resolves directory junctions before checking state isolation', async () => {
  await symlink(workspace, directory, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => open()).toThrow('outside MCP_CWD');
});

test('prevents concurrent processes from using the same state directory', () => {
  const first = open();
  expect(() => open()).toThrow('Another CloudHands process');
  first.close();
  expect(() => open()).not.toThrow();
});

test('persists atomic updates and returns isolated snapshots', async () => {
  const first = open();
  const snapshot = first.read();
  snapshot.binding = 'modified externally';
  expect(first.read().binding).toBe('server-and-workspace');
  first.close();
  expect(open().read().binding).toBe('server-and-workspace');
  expect(JSON.parse(await readFile(join(directory, 'oauth.json'), 'utf8')).version).toBe(1);
});

test('fails closed on corrupt persisted data and releases its lock', async () => {
  open().close();
  await writeFile(join(directory, 'oauth.json'), '{');
  expect(() => open()).toThrow();
  await writeFile(join(directory, 'oauth.json'), JSON.stringify({ version: 1 }));
  expect(() => open()).toThrow('Invalid OAuth state');
});

test('does not commit partial state when an update fails', () => {
  const store = open();
  expect(() => store.update((state) => { state.binding = 'changed'; throw new Error('Failure'); })).toThrow('Failure');
  expect(store.read().binding).toBe('server-and-workspace');
});
