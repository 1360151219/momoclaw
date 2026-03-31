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
import { startHostMcpServer } from './mcp/server.js';

// Global instances
let cronService: CronService;
export const hostMcpPort: number = 51506;

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
  await startHostMcpServer(hostMcpPort);
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
 */
async function startFeishu(): Promise<void> {
  if (!config.feishu?.appId || !config.feishu?.appSecret) {
    console.error(
      kleur.red(
        'Error: Feishu not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars.',
      ),
    );
    process.exit(1);
  }

  // Register Feishu channel handler for task result push
  channelRegistry.register(new FeishuCronHandler(config.feishu));

  console.log(kleur.cyan('Starting Feishu bot...'));
  await startFeishuBot({ feishuConfig: config.feishu });
}

async function startWeixin(): Promise<void> {
  if (!config.weixin) {
    console.error(kleur.red('Error: Weixin config is missing in .env'));
    process.exit(1);
  }

  console.log(kleur.cyan('Starting Weixin bot...'));
  await startWeixinBot({ weixinConfig: config.weixin });
}

// Main entry
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Command routing
  if (args[0] === 'build') {
    await buildImage();
    return;
  }
  await initialize();
  if (args[0] === 'feishu') {
    await startFeishu();
    return;
  }
  if (args[0] === 'weixin') {
    await startWeixin();
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
