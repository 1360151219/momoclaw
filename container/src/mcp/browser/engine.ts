import path from 'path';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Step } from './types.js';
import { WORKSPACE_DIR } from './constants.js';
import { assertUrlNotBlocked } from './security.js';
import { ensureDir } from './processManager.js';

/**
 * Connect to a remote Chrome/Chromium via CDP.
 */
export async function connectBrowser(cdpEndpoint: string): Promise<Browser> {
  return chromium.connectOverCDP(cdpEndpoint);
}

/**
 * 低内存模式路由拦截。
 * 默认会拦截图片/字体/媒体资源以节省内存；
 * 当 blockImages 为 false 时，只拦截字体和媒体，保留图片（二维码等场景需要图片）。
 *
 * @param page - Playwright 页面实例
 * @param options - 配置选项
 * @param options.blockImages - 是否拦截图片资源，默认 true
 */
export async function applyLowMemoryRouting(
  page: Page,
  options?: { blockImages?: boolean },
): Promise<void> {
  const shouldBlockImages = options?.blockImages ?? true;
  await page.route('**/*', async (route: any) => {
    const type = route.request().resourceType();
    // 字体和媒体资源始终拦截（占内存大，且登录等场景不需要）
    if (type === 'font' || type === 'media') {
      await route.abort();
      return;
    }
    // 图片资源根据参数决定是否拦截
    if (type === 'image' && shouldBlockImages) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}

/**
 * After each navigation-like step, re-check the current page URL against blocklist.
 */
async function assertCurrentPageNotBlocked(
  page: Page,
  blockDomains: string[],
): Promise<void> {
  const currentUrl = page.url();
  assertUrlNotBlocked(currentUrl, blockDomains);
}

/**
 * Execute a small, restricted step DSL on a single page.
 */
export async function runSteps(params: {
  page: Page;
  steps: Step[];
  blockDomains: string[];
  artifactDirRel: string;
}): Promise<{
  screenshots: string[];
  extracted: Array<{ kind: string; data: unknown }>;
}> {
  const { page, steps, blockDomains, artifactDirRel } = params;
  const screenshots: string[] = [];
  const extracted: Array<{ kind: string; data: unknown }> = [];

  for (const step of steps) {
    switch (step.type) {
      case 'goto': {
        assertUrlNotBlocked(step.url, blockDomains);
        await page.goto(step.url, {
          waitUntil: step.waitUntil ?? 'domcontentloaded',
          timeout: step.timeoutMs ?? 60_000,
        });
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'click': {
        const timeout = step.timeoutMs ?? 30_000;
        if (step.selector) {
          await page.locator(step.selector).first().click({ timeout });
        } else if (step.text) {
          await page.getByText(step.text, { exact: false }).first().click({
            timeout,
          });
        } else {
          throw new Error('click step requires selector or text');
        }
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'fill': {
        const timeout = step.timeoutMs ?? 30_000;
        await page.locator(step.selector).first().fill(step.value, { timeout });
        break;
      }
      case 'press': {
        await page.keyboard.press(step.key);
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'waitForSelector': {
        const timeout = step.timeoutMs ?? 30_000;
        await page.waitForSelector(step.selector, { timeout });
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'sleep': {
        await page.waitForTimeout(step.ms);
        break;
      }
      case 'scroll': {
        await page.mouse.wheel(0, step.deltaY);
        break;
      }
      case 'extract': {
        if (step.kind === 'text') {
          const locator = step.selector
            ? page.locator(step.selector).first()
            : page.locator('body');
          const text = await locator.innerText({ timeout: 30_000 });
          extracted.push({ kind: 'text', data: text });
        } else if (step.kind === 'links') {
          const scope = step.selector ? `${step.selector} a` : 'a';
          const links = await page.$$eval(scope, (as: any[]) =>
            as
              .map((a: any) => ({
                text: (a.textContent || '').trim(),
                href: (a.href as string) || '',
              }))
              .filter((x: any) => x.href),
          );
          extracted.push({ kind: 'links', data: links });
        } else if (step.kind === 'table') {
          const tableSel = step.selector ?? 'table';
          const rows = await page.$$eval(`${tableSel} tr`, (trs: any[]) =>
            trs.map((tr: any) =>
              Array.from(tr.querySelectorAll('th,td')).map((td: any) =>
                (td.textContent || '').trim(),
              ),
            ),
          );
          extracted.push({ kind: 'table', data: rows });
        }
        break;
      }
      case 'screenshot': {
        const rel =
          step.path?.replace(/^\//, '') ??
          path.join(artifactDirRel, `${Date.now()}.png`);
        const abs = path.join(WORKSPACE_DIR, rel);
        ensureDir(path.dirname(abs));
        await page.screenshot({ path: abs, fullPage: step.fullPage ?? true });
        screenshots.push(rel);
        break;
      }
      default: {
        throw new Error(`Unsupported step: ${(step as any).type}`);
      }
    }
  }

  return { screenshots, extracted };
}