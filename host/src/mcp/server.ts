import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import {
  createScheduledTask,
  listScheduledTasks,
  listTasksByChannel,
  updateTaskStatus,
  deleteScheduledTask,
  getTaskRunLogs,
  getScheduledTask,
  updateTaskNextRun,
} from '../db/index.js';
import { CronService } from '../cron/scheduler.js';

function createSessionMcpServer(channelContext: any): McpServer {
  const server = new McpServer({
    name: `momoclaw-host-mcp`,
    version: '1.0.0',
  });

  // --- 注册工具 ---

  // 1. schedule_task
  server.tool(
    'schedule_task',
    `【创建定时任务】当用户要求在未来的某个时间、或者每隔一段时间重复执行某项操作时，必须使用此工具。
请根据 scheduleType 严格遵守以下 scheduleValue 格式要求：
1. type="cron": 表示每隔一段时间需要重复执行的表达式，使用标准 Cron 表达式 (分 时 日 月 周)。
   - 示例: "0 9 * * *" (每天09:00), "*/5 * * * *" (每5分钟)
2. type="once": 表示一次性执行（例如"明天早上8点提醒我"），必须使用 13 位毫秒级时间戳 (Unix Timestamp)。
   - 示例: "1709542800000"
   - ⚠️ 严禁使用 "2024-03-04" 或 "tomorrow" 等自然语言或相对时间。如果是自然语言，请先将其转换为对应的时间戳再调用本工具。`,
    {
      sessionId: z.string().optional().describe('关联的会话ID（可以不传）'),
      prompt: z
        .string()
        .describe(
          '定时执行的提示词，即任务触发时你想让 AI 执行的指令，例如："给用户发送早安问候"',
        ),
      scheduleType: z
        .enum(['cron', 'once'])
        .describe('调度类型：重复执行请选 cron，单次执行请选 once'),
      scheduleValue: z.string().describe(
        `调度参数值。必须严格符合 scheduleType 对应的格式：
- cron: "0 9 * * *"
- once: "1709542800000" (13位时间戳，必须是数字字符串，禁止使用自然语言或日期字符串)`,
      ),
    },
    async ({ sessionId, prompt, scheduleType, scheduleValue }) => {
      try {
        const taskId = CronService.generateTaskId();
        const nextRun = CronService.calculateInitialNextRun(
          scheduleType as any,
          scheduleValue,
        );

        const actualSessionId = sessionId || channelContext.sessionId || '';

        const task = createScheduledTask(
          taskId,
          actualSessionId,
          prompt,
          scheduleType as any,
          scheduleValue,
          nextRun,
          channelContext.channelType, // channelType
          channelContext.channelId, // channelId
        );

        return {
          content: [
            {
              type: 'text',
              text: `任务创建成功！任务ID: \`${taskId}\` \n下次执行时间: ${new Date(nextRun).toLocaleString()}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `创建任务失败: ${err.message}` }],
        };
      }
    },
  );

  // 2. list_scheduled_tasks
  server.tool(
    'list_scheduled_tasks',
    `【查询定时任务列表】当用户询问"我有几个定时任务"、"帮我看看我有哪些定时任务"时，必须使用此工具获取已创建的任务列表。`,
    {},
    async () => {
      try {
        // 优先按渠道查询：同一渠道（如同一个飞书群、同一个终端）下的所有任务
        // 这样无论用户 /new 切换了多少次会话，都能看到自己的任务
        let tasks;
        if (channelContext.channelType && channelContext.channelId) {
          tasks = listTasksByChannel(channelContext.channelType, channelContext.channelId);
        } else {
          // 兜底：如果没有渠道信息，按 sessionId 查询
          tasks = listScheduledTasks(channelContext.sessionId);
        }
        return {
          content: [
            {
              type: 'text',
              text: `查询到定时任务列表如下，其中 \`id\` 为任务 ID，可用于删除任务：\n${JSON.stringify(tasks, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `查询失败: ${err.message}` }],
        };
      }
    },
  );

  // 3. delete_task
  server.tool(
    'delete_task',
    '【删除定时任务】当用户要求取消、删除或停止某个定时提醒、定时计划时使用。可以先调用 list_scheduled_tasks 获取所有任务，找到对应的 taskId 后再调用此工具。',
    {
      taskId: z
        .string()
        .describe(
          '需要删除的定时任务的 ID，通常是一串包含数字和字母的字符串，可以从 list_scheduled_tasks 结果中获取。',
        ),
    },
    async ({ taskId }) => {
      try {
        const success = deleteScheduledTask(taskId);
        if (success) {
          return {
            content: [{ type: 'text', text: `任务 ${taskId} 已成功删除。` }],
          };
        } else {
          return {
            content: [
              { type: 'text', text: `删除失败：未找到任务 ${taskId}。` },
            ],
          };
        }
      } catch (err: any) {
        return {
          content: [
            { type: 'text', text: `删除任务时发生错误: ${err.message}` },
          ],
        };
      }
    },
  );

  return server;
}

export async function startHostMcpServer(port: number = 0): Promise<number> {
  const app = express();
  app.use(cors());

  // 保存每个 sessionId 对应的 transport
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    const server = createSessionMcpServer(req.query);

    // SSEServerTransport will automatically append its own ?sessionId=uuid to this endpoint
    const transport = new SSEServerTransport('/messages', res);

    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const mcpSessionId = req.query.sessionId as string;
    const transport = transports.get(mcpSessionId);
    if (!transport) {
      res.status(400).send('SSE not initialized for this session');
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  // 启动服务
  return new Promise((resolve) => {
    // 显式绑定到 0.0.0.0，允许局域网/Docker 容器访问
    const srv = app.listen(port, '0.0.0.0', () => {
      const addr = srv.address() as any;
      console.log(
        `[Host MCP Server] Listening on ${addr.address}:${addr.port}`,
      );
      resolve(addr.port);
    });
  });
}
