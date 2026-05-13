import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { WeixinGateway } from './gateway.js';
import { WeixinBot } from './bot.js';
import { WeixinCronHandler } from './cronHandler.js';
import type { WeixinConfig } from './types.js';
import { channelRegistry } from '../cron/sender.js';
import {
  registerWeixinUser,
  getWeixinUser,
  listWeixinUsers,
  updateWeixinUserStatus,
  updateWeixinUserToken,
  deleteWeixinUser,
  type WeixinUserRow,
} from '../db/index.js';

export interface WeixinUserInstance {
  user: WeixinUserRow;
  gateway: WeixinGateway;
  bot: WeixinBot;
}

export class WeixinUserManager {
  private config: WeixinConfig;
  private instances = new Map<string, WeixinUserInstance>();

  constructor(config: WeixinConfig) {
    this.config = config;
  }

  // ---- public API ----

  /** Start all active users. If none exist, show QR code for a new one. */
  async startAllActive(): Promise<number> {
    const users = this.listUsers();

    if (users.length === 0) {
      try {
        await this.startNewUser();
        return 1;
      } catch (e) {
        console.error('[WeixinUserManager] Failed to start new user:', e);
        return 0;
      }
    }

    let startedCount = 0;
    for (const u of users) {
      if (u.status === 'active' || u.status === 'pending') {
        try {
          await this.startExistingUser(u.id);
          startedCount++;
        } catch (e) {
          console.error(`[WeixinUserManager] Failed to start user ${u.id}:`, e);
          updateWeixinUserStatus(u.id, 'error', String(e));
        }
      }
    }
    return startedCount;
  }

  stopUser(userId: string): void {
    const instance = this.instances.get(userId);
    if (!instance) {
      console.log(`[WeixinUserManager] User ${userId} is not running`);
      return;
    }
    instance.gateway.stop();
    channelRegistry.unregister('weixin', userId);
    this.instances.delete(userId);
    updateWeixinUserStatus(userId, 'stopped');
    console.log(`[WeixinUserManager] User ${userId} stopped`);
  }

  deleteUser(userId: string): void {
    if (this.instances.has(userId)) {
      this.stopUser(userId);
    }
    deleteWeixinUser(userId);
    console.log(`[WeixinUserManager] User ${userId} deleted`);
  }

  listUsers(): WeixinUserRow[] {
    return listWeixinUsers();
  }

  getInstance(userId: string): WeixinUserInstance | undefined {
    return this.instances.get(userId);
  }

  isRunning(userId: string): boolean {
    return this.instances.has(userId);
  }

  // ---- internal ----

  private async startNewUser(): Promise<void> {
    console.log('[WeixinUserManager] No users found — starting QR login flow...');

    const gateway = new WeixinGateway(this.config);
    await gateway.start();

    const tokenInfo = gateway.getClient().getTokenInfo();
    const userId = tokenInfo.ilink_user_id;
    if (!userId) {
      gateway.stop();
      throw new Error('QR login completed but no ilink_user_id returned');
    }

    gateway.setWxUserId(userId);
    this.seedWorkspace(userId);

    const name = `Weixin ${userId.slice(0, 8)}`;
    registerWeixinUser(userId, name, tokenInfo);
    updateWeixinUserToken(userId, tokenInfo);

    channelRegistry.register(new WeixinCronHandler(gateway), userId);

    const bot = new WeixinBot(gateway, userId);
    await bot.start();

    const userRow = getWeixinUser(userId)!;
    this.instances.set(userId, { user: userRow, gateway, bot });

    console.log(`[WeixinUserManager] New user registered: ${name} (${userId})`);
  }

  private async startExistingUser(userId: string): Promise<void> {
    if (this.instances.has(userId)) {
      console.log(`[WeixinUserManager] User ${userId} is already running`);
      return;
    }

    const userRow = getWeixinUser(userId);
    if (!userRow) {
      throw new Error(`WeixinUser not found: ${userId}`);
    }

    const gateway = new WeixinGateway(this.config);
    gateway.setWxUserId(userId);

    if (userRow.bot_token) {
      gateway.getClient().setToken({
        bot_token: userRow.bot_token,
        ilink_bot_id: userRow.ilink_bot_id ?? undefined,
        ilink_user_id: userRow.ilink_user_id ?? undefined,
        baseurl: userRow.baseurl ?? undefined,
      });
    }

    channelRegistry.register(new WeixinCronHandler(gateway), userId);

    const bot = new WeixinBot(gateway, userId);
    await bot.start();

    const tokenInfo = gateway.getClient().getTokenInfo();
    updateWeixinUserToken(userId, tokenInfo);

    this.instances.set(userId, { user: userRow, gateway, bot });

    console.log(`[WeixinUserManager] User ${userId} (${userRow.name}) started`);
  }

  /** Copy seed files (CLAUDE.md, etc.) from root workspace into a new user's workspace. */
  private seedWorkspace(userId: string): void {
    const workspaceRoot = resolve(process.env.WORKSPACE_DIR || './workspace');
    const userDir = join(workspaceRoot, userId);

    const seedFile = join(workspaceRoot, 'CLAUDE.md');
    if (existsSync(seedFile)) {
      if (!existsSync(userDir)) {
        mkdirSync(userDir, { recursive: true });
      }
      copyFileSync(seedFile, join(userDir, 'CLAUDE.md'));
    }
  }
}
