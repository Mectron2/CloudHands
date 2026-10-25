import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import { adaptPiTool, type McpTool } from './adapter.js';

export function createToolCatalog(cwd: string, platform: NodeJS.Platform = process.platform): McpTool[] {
  const tools = [
    adaptPiTool(createReadTool(cwd)),
    adaptPiTool(createWriteTool(cwd)),
    adaptPiTool(createEditTool(cwd)),
    adaptPiTool(createLsTool(cwd)),
    adaptPiTool(createFindTool(cwd)),
    adaptPiTool(createGrepTool(cwd)),
    platform === 'win32'
      ? adaptPiTool(createPowerShellTool(cwd))
      : adaptPiTool(createBashTool(cwd)),
  ];

  return tools.map((tool) => ({
    ...tool,
    definition: {
      ...tool.definition,
      annotations: {
        readOnlyHint: ['read', 'ls', 'find', 'grep'].includes(tool.definition.name),
        destructiveHint: !['read', 'ls', 'find', 'grep'].includes(tool.definition.name),
        openWorldHint: ['bash', 'powershell'].includes(tool.definition.name),
      },
    },
  }));
}
