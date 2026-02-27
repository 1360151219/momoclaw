import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve, normalize, isAbsolute } from 'path';
import { execSync } from 'child_process';
import { Tool } from './types.js';

const WORKSPACE_BASE = '/workspace/files';
const TMP_DIR = process.env.TMP_DIR || '/workspace/tmp';

// 确保路径在workspace范围内
function sanitizePath(inputPath: string): string {
  // 如果是绝对路径，检查是否在workspace内
  if (isAbsolute(inputPath)) {
    const resolved = normalize(inputPath);
    const workspaceResolved = normalize(WORKSPACE_BASE);
    if (!resolved.startsWith(workspaceResolved)) {
      throw new Error(`Path ${inputPath} is outside workspace`);
    }
    return resolved;
  }

  // 相对路径，拼接到workspace
  return resolve(WORKSPACE_BASE, inputPath);
}

export const tools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as a string.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to read (relative to workspace or absolute)',
        },
        offset: {
          type: 'number',
          description: 'The line number to start reading from (1-indexed)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read',
        },
      },
      required: ['path'],
    },
    execute: async ({ path, offset, limit }) => {
      const filePath = sanitizePath(String(path));

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${path}`);
      }

      const stats = statSync(filePath);
      if (!stats.isFile()) {
        throw new Error(`${path} is not a file`);
      }

      let content = readFileSync(filePath, 'utf-8');

      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (offset as number || 1) - 1);
        const end = limit !== undefined ? start + (limit as number) : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      return content;
    },
  },

  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const filePath = sanitizePath(String(path));
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));

      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, String(content), 'utf-8');
      return `File written successfully: ${path}`;
    },
  },

  {
    name: 'edit_file',
    description: 'Edit a file by replacing a specific string with another. The oldString must match exactly.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to edit',
        },
        oldString: {
          type: 'string',
          description: 'The exact string to replace',
        },
        newString: {
          type: 'string',
          description: 'The replacement string',
        },
      },
      required: ['path', 'oldString', 'newString'],
    },
    execute: async ({ path, oldString, newString }) => {
      const filePath = sanitizePath(String(path));

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${path}`);
      }

      const content = readFileSync(filePath, 'utf-8');
      const old = String(oldString);
      const replacement = String(newString);

      if (!content.includes(old)) {
        throw new Error(`oldString not found in file: ${old.substring(0, 50)}...`);
      }

      const newContent = content.replace(old, replacement);
      writeFileSync(filePath, newContent, 'utf-8');

      return `File edited successfully: ${path}`;
    },
  },

  {
    name: 'list_directory',
    description: 'List files and directories in the specified path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to list (default: workspace root)',
        },
      },
    },
    execute: async ({ path }) => {
      const dirPath = path ? sanitizePath(String(path)) : WORKSPACE_BASE;

      if (!existsSync(dirPath)) {
        throw new Error(`Directory not found: ${path || 'workspace'}`);
      }

      const stats = statSync(dirPath);
      if (!stats.isDirectory()) {
        throw new Error(`${path} is not a directory`);
      }

      const entries = readdirSync(dirPath, { withFileTypes: true });
      const formatted = entries.map(entry => {
        const prefix = entry.isDirectory() ? '[DIR] ' : '[FILE] ';
        return `${prefix}${entry.name}`;
      });

      return formatted.join('\n') || '(empty directory)';
    },
  },

  {
    name: 'execute_command',
    description: 'Execute a shell command in the workspace. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (relative to workspace, default: workspace root)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000)',
        },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd, timeout }) => {
      const workingDir = cwd ? sanitizePath(String(cwd)) : WORKSPACE_BASE;

      if (!existsSync(workingDir)) {
        throw new Error(`Working directory not found: ${cwd}`);
      }

      const cmd = String(command);
      const cmdTimeout = (timeout as number) || 60000;

      // 危险命令检查
      const dangerousPatterns = [
        /rm\s+-rf\s+\/\s*/,
        />\s*\/dev\/null/,
        /mkfs\./,
        /dd\s+if=.*of=\/dev/,
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(cmd)) {
          throw new Error(`Potentially dangerous command detected: ${cmd}`);
        }
      }

      try {
        const result = execSync(cmd, {
          cwd: workingDir,
          timeout: cmdTimeout,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result || '(command executed successfully, no output)';
      } catch (err: any) {
        throw new Error(`Command failed: ${err.message}\nStderr: ${err.stderr}`);
      }
    },
  },
];

export function getToolDefinitions() {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(args);
}
