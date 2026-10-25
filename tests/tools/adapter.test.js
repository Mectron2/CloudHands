import { jest } from '@jest/globals';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { adaptPiTool } from '../../dist/tools/adapter.js';

function createTool(execute) {
  return adaptPiTool({
    name: 'example',
    description: 'Example tool',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    execute,
  });
}

test('preserves text, images and details and passes a unique call ID and cancellation signal', async () => {
  const content = [
    { type: 'text', text: 'result' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ];
  const execute = jest.fn().mockResolvedValue({ content, details: { truncated: false } });
  const tool = createTool(execute);
  const controller = new AbortController();

  const result = await tool.call({ value: 'hello' }, controller.signal);
  await tool.call({ value: 'again' }, controller.signal);

  expect(result).toEqual({ content, structuredContent: { details: { truncated: false } } });
  expect(execute.mock.calls[0][0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(execute.mock.calls[0][0]).not.toBe(execute.mock.calls[1][0]);
  expect(execute.mock.calls[0].slice(1)).toEqual([{ value: 'hello' }, controller.signal]);
});

test.each([{}, { value: 42 }])('rejects invalid arguments before execution: %j', async (args) => {
  const execute = jest.fn();
  const tool = createTool(execute);

  await expect(tool.call(args, new AbortController().signal)).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  expect(execute).not.toHaveBeenCalled();
});

test('reports execution failures as MCP tool errors', async () => {
  const tool = createTool(async () => { throw new Error('Operation failed'); });
  await expect(tool.call({ value: 'hello' }, new AbortController().signal)).resolves.toEqual({
    isError: true,
    content: [{ type: 'text', text: 'Operation failed' }],
  });
});

test('preserves Pi error flags and structured shell output', async () => {
  const tool = createTool(async () => ({
    content: [{ type: 'text', text: 'Command exited with code 7' }],
    isError: true,
    structuredContent: { output: 'failed', exit_code: 7, truncated: false },
    details: { fullOutputPath: '/tmp/output.txt' },
  }));

  await expect(tool.call({ value: 'hello' }, new AbortController().signal)).resolves.toEqual({
    content: [{ type: 'text', text: 'Command exited with code 7' }],
    isError: true,
    structuredContent: { output: 'failed', exit_code: 7, truncated: false, details: { fullOutputPath: '/tmp/output.txt' } },
  });
});

test.each([null, 42, 'result', ['result']])('wraps non-object Pi structured content: %j', async (value) => {
  const tool = createTool(async () => ({ content: [], structuredContent: value }));
  await expect(tool.call({ value: 'hello' }, new AbortController().signal)).resolves.toEqual({
    content: [], structuredContent: { result: value },
  });
});

test('does not start an already cancelled operation', async () => {
  const execute = jest.fn();
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));

  await expect(createTool(execute).call({ value: 'hello' }, controller.signal)).resolves.toMatchObject({ isError: true });
  expect(execute).not.toHaveBeenCalled();
});

test('propagates cancellation to an executing Pi tool', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const tool = createTool(async (_id, _args, signal) => {
    started();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    });
  });
  const pending = tool.call({ value: 'hello' }, controller.signal);
  await ready;
  controller.abort();

  await expect(pending).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: 'Cancelled' }] });
});
