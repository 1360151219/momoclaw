#!/usr/bin/env node

import { config } from './config.js';
import { initDatabase } from './db/index.js';
import { checkDockerAvailable, buildContainerImage } from './container.js';
import { CronService, cronService as defaultCronService } from './cron.js';
import kleur from 'kleur';
import { startInteractiveChat } from './chat/index.js';
import { startFeishuBot } from './chat/feishu.js';

// Global instances
let cronService: CronService;

/**
 * Initialize core services
 */
async function initialize(): Promise<void> {
    if (!checkDockerAvailable()) {
        console.error(
            kleur.red('Error: Docker is not available. Please install and start Docker first.'),
        );
        process.exit(1);
    }

    initDatabase(config.dbPath);
    cronService = defaultCronService;
    cronService.start();
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
        console.error(kleur.red('Error: Feishu not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars.'));
        process.exit(1);
    }

    console.log(kleur.cyan('Starting Feishu bot...'));
    await startFeishuBot({ feishuConfig: config.feishu });
}

// Main entry
async function main(): Promise<void> {
    await initialize();

    const args = process.argv.slice(2);

    // Command routing
    if (args[0] === 'build') {
        await buildImage();
        return;
    }

    if (args[0] === 'feishu') {
        await startFeishu();
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
