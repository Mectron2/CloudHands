import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpTool } from '../tools/adapter.js';
import { toolScope } from '../auth/scopes.js';

export function createMcpServer(tools: readonly McpTool[]): Server {
  const registry = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const server = new Server(
    { name: 'llm-gate', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, { authInfo }) => ({
    tools: tools.filter((tool) => authInfo?.scopes.includes(toolScope(tool.definition.name))).map((tool) => ({
      ...tool.definition,
      securitySchemes: [{ type: 'oauth2', scopes: [toolScope(tool.definition.name)] }],
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [toolScope(tool.definition.name)] }] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, { signal, authInfo }) => {
    const tool = registry.get(request.params.name);

    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }

    if (!authInfo?.scopes.includes(toolScope(tool.definition.name))) {
      throw new McpError(ErrorCode.InvalidRequest, 'Insufficient scope');
    }

    return tool.call(request.params.arguments ?? {}, signal);
  });

  return server;
}
