#!/usr/bin/env node

import { config } from './config.js';
import { initDatabase } from './db/index.js';
import { checkDockerAvailable, buildContainerImage } from './container.js';
import { CronService } from './cron/index.js';
import kleur from 'kleur';
import { startInteractiveChat } from './cli/index.js';
import { startFeishuBot } from './feishu/bot.js';
import { startWeixinBot } from './weixin/bot.js';
import { channelRegistry } from './cron/sender.js';
import { FeishuCronHandler } from './feishu/cronHandler.js';
import { WeixinCronHandler } from './weixin/cronHandler.js';
import { startHostMcpServer } from './mcp/server.js';

// Global instances
let cronService: CronService;

/**
 * Initialize core services
 */
async function initialize(): Promise<void> {
  if (!checkDockerAvailable()) {
    console.error(
      kleur.red(
        'Error: Docker is not available. Please install and start Docker first.',
      ),
    );
    process.exit(1);
  }

  initDatabase(config.dbPath);
  cronService = new CronService();
  cronService.start();

  // 启动宿主机 MCP Server
  await startHostMcpServer(config.hostMcpPort);
}

/**
 * Build container image
 */
async function buildImage(): Promise<void> {
  console.log(kleur.gray('Building container image...'));
  const success = await buildContainerImage();
  if (success) {
    console.log(kleur.green('Container image built successfully!'));
  } else {
    console.error(kleur.red('Failed to build container image'));
    process.exit(1);
  }
}

/**
 * Start Feishu bot
 * 启动飞书机器人
 * @returns boolean 表示是否启动成功
 */
async function startFeishu(): Promise<boolean> {
  if (!config.feishu?.appId || !config.feishu?.appSecret) {
    console.error(
      kleur.yellow(
        '⚠️ 飞书配置缺失 (未设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET)，已跳过启动飞书机器人。',
      ),
    );
    return false; // 启动失败/跳过
  }

  // Register Feishu channel handler for task result push
  // 注册飞书的任务结果回传通道（告诉系统任务完成了往哪发消息）
  channelRegistry.register(new FeishuCronHandler(config.feishu));

  console.log(kleur.cyan('✅ 检测到飞书配置，正在启动飞书机器人...'));
  await startFeishuBot({ feishuConfig: config.feishu });
  return true; // 启动成功
}

/**
 * Start Weixin bot
 * 启动微信机器人
 * @returns boolean 表示是否启动成功
 */
async function startWeixin(): Promise<boolean> {
  if (!config.weixin) {
    console.error(kleur.yellow('⚠️ 微信配置缺失，已跳过启动微信机器人。'));
    return false; // 启动失败/跳过
  }

  // Register Weixin channel handler for task result push
  // 注册微信的任务结果回传通道
  channelRegistry.register(new WeixinCronHandler(config.weixin));

  console.log(kleur.cyan('✅ 检测到微信配置，正在启动微信机器人...'));
  // 启动微信机器人监听（长轮询拉取微信消息）
  await startWeixinBot({ weixinConfig: config.weixin });
  return true; // 启动成功
}

/**
 * 启动所有配置的渠道机器人 (飞书、微信等)
 * 这个函数的作用是在同一个程序里，依次把飞书和微信都运行起来。
 * 这样它们就可以共享同一个 51506 端口和同一个定时任务管理器，不会产生冲突。
 */
async function startAllChannels(): Promise<void> {
  let startedCount = 0;

  // 1. 尝试启动飞书渠道
  const feishuStarted = await startFeishu();
  if (feishuStarted) startedCount++;

  // 2. 尝试启动微信渠道
  const weixinStarted = await startWeixin();
  if (weixinStarted) startedCount++;

  // 3. 检查是否有任何渠道成功启动
  if (startedCount === 0) {
    console.error(
      kleur.red(
        '❌ 错误：没有找到任何渠道的有效配置（飞书或微信）。请检查环境变量设置。',
      ),
    );
    process.exit(1);
  }

  console.log(kleur.green('🚀 所有已配置的渠道已成功启动并开始监听！'));
}

// Main entry
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Command routing
  if (args[0] === 'build') {
    await buildImage();
    return;
  }

  // 对于所有的业务启动，先初始化基础服务 (MCP Server, 定时任务, 数据库等)
  await initialize();

  if (args[0] === 'feishu') {
    const started = await startFeishu();
    if (!started) process.exit(1); // 如果单独启动飞书失败，则退出程序
    return;
  }
  if (args[0] === 'weixin') {
    const started = await startWeixin();
    if (!started) process.exit(1); // 如果单独启动微信失败，则退出程序
    return;
  }
  if (args[0] === 'all') {
    // 同时启动所有渠道机器人
    await startAllChannels();
    return;
  }

  // Default: start interactive chat
  const sessionId = args[0] || undefined;
  await startInteractiveChat({ sessionId });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(kleur.gray('\nShutting down...'));
  if (cronService) {
    cronService.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (cronService) {
    cronService.stop();
  }
  process.exit(0);
});

// Run
main().catch((err) => {
  console.error(kleur.red(`Error: ${err}`));
  process.exit(1);
});
