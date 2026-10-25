import { randomUUID } from 'node:crypto';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

interface PiToolResult {
  content: CallToolResult['content'];
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

interface PiTool<TArgs> {
  name: string;
  description: string;
  parameters: { type: 'object' };
  execute: (id: string, args: TArgs, signal?: AbortSignal) => Promise<PiToolResult>;
}

export interface McpTool {
  definition: Tool;
  call: (args: unknown, signal: AbortSignal) => Promise<CallToolResult>;
}

const validator = new AjvJsonSchemaValidator();

export function adaptPiTool<TArgs>(tool: PiTool<TArgs>): McpTool {
  const inputSchema: Tool['inputSchema'] = { ...tool.parameters };
  const validate = validator.getValidator<TArgs>(inputSchema);

  return {
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema,
    },
    async call(args, signal) {
      const validation = validate(args);

      if (!validation.valid) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${tool.name}: ${validation.errorMessage}`);
      }

      try {
        signal.throwIfAborted();
        const result = await tool.execute(randomUUID(), validation.data, signal);
        const structuredContent = result.structuredContent === undefined
          ? {}
          : result.structuredContent !== null && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
            ? result.structuredContent
            : { result: result.structuredContent };
        const details = result.details === undefined ? {} : { details: result.details };

        return {
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result.structuredContent === undefined && result.details === undefined
            ? {}
            : { structuredContent: { ...structuredContent, ...details } }),
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  };
}
