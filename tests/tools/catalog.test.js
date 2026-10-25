import { createToolCatalog } from '../../dist/tools/catalog.js';

describe('platform tool catalog', () => {
  test.each([
    ['win32', 'powershell', 'bash'],
    ['linux', 'bash', 'powershell'],
    ['darwin', 'bash', 'powershell'],
  ])('%s exposes %s and excludes %s', (platform, included, excluded) => {
    const tools = createToolCatalog(process.cwd(), platform);
    const names = tools.map((tool) => tool.definition.name);

    expect(names).toHaveLength(7);
    expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'ls', 'find', 'grep', included]));
    expect(names).not.toContain(excluded);
    for (const tool of tools) {
      expect(tool.definition.inputSchema.type).toBe('object');
      expect(tool.definition.description).toBeTruthy();
    }
  });

  test('detects the current machine by default', () => {
    const names = createToolCatalog(process.cwd()).map((tool) => tool.definition.name);
    expect(names).toContain(process.platform === 'win32' ? 'powershell' : 'bash');
    expect(names).not.toContain(process.platform === 'win32' ? 'bash' : 'powershell');
  });
});
