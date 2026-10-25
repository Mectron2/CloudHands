import { resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';

test('uses local defaults', () => {
  expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 3000, cwd: process.cwd(), stateDirectory: expect.any(String) });
});

test('loads explicit configuration and resolves the working directory', () => {
  expect(loadConfig({ HOST: 'localhost', PORT: '4567', MCP_CWD: 'src' })).toMatchObject({
    host: 'localhost', port: 4567, cwd: resolve('src'),
  });
});

test('normalizes the public MCP URL for reverse-proxy OAuth discovery', () => {
  expect(loadConfig({ MCP_PUBLIC_URL: 'https://example.ngrok-free.app/mcp' }).publicUrl).toBe('https://example.ngrok-free.app');
});

test.each(['', 'http://public.example', 'https://example.com/path', 'https://user:password@example.com', 'https://example.com/?query=1', 'https://example.com/#fragment'])('rejects invalid public URL %j', (url) => {
  expect(() => loadConfig({ MCP_PUBLIC_URL: url })).toThrow('MCP_PUBLIC_URL');
});

test.each(['', '-1', '65536', '1.5', 'text', '1e3'])('rejects invalid port %j', (port) => {
  expect(() => loadConfig({ PORT: port })).toThrow('PORT');
});

test('rejects an empty host', () => {
  expect(() => loadConfig({ HOST: ' ' })).toThrow('HOST');
});

test('rejects a file as working directory', () => {
  expect(() => loadConfig({ MCP_CWD: 'package.json' })).toThrow('MCP_CWD');
});

test('loads host and browser origin allowlists', () => {
  expect(loadConfig({ MCP_ALLOWED_HOSTS: ' localhost, mcp.example.com ', MCP_ALLOWED_ORIGINS: 'https://client.example.com' })).toMatchObject({
    allowedHosts: ['localhost', 'mcp.example.com'], allowedOrigins: ['https://client.example.com'],
  });
});

test.each(['*', 'not-a-url', 'https://client.example.com/path', 'file:///tmp'])('rejects invalid allowed origin %j', (origin) => {
  expect(() => loadConfig({ MCP_ALLOWED_ORIGINS: origin })).toThrow('MCP_ALLOWED_ORIGINS');
});
