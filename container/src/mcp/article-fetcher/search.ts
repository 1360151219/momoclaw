import { addExtra, type VanillaPuppeteer } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerCore, { type Browser, type Page } from 'puppeteer';
// src/errors.ts
export enum ErrorType {
  NETWORK = 'NETWORK_ERROR',
  PARSING = 'PARSING_ERROR',
  VALIDATION = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMIT = 'RATE_LIMIT',
  UNKNOWN = 'UNKNOWN_ERROR',
}
export const ErrorCodes: Record<ErrorType, number> = {
  [ErrorType.NETWORK]: 500,
  [ErrorType.PARSING]: 501,
  [ErrorType.VALIDATION]: 400,
  [ErrorType.NOT_FOUND]: 404,
  [ErrorType.RATE_LIMIT]: 429,
  [ErrorType.UNKNOWN]: 500,
};

export class DuckDuckGoError extends Error {
  public readonly code: number;
  public readonly details?: unknown;
  public readonly type: ErrorType;
  public readonly timestamp: number;

  constructor(
    code: number,
    message: string,
    details?: unknown,
    type?: ErrorType,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'DuckDuckGoError';
    this.type = type ?? ErrorType.UNKNOWN;
    this.timestamp = Date.now();
    Object.setPrototypeOf(this, DuckDuckGoError.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      type: this.type,
      timestamp: this.timestamp,
    };
  }
}
// src/selectors.ts

export const selectors = {
  search: {
    resultItem: [
      'article[id^="r1-"]',
      'article.yQDlj3B5DI5YO8c8Ulio.CpkrTDP54mqzpuCSn1Fa.SKlplDuh9FjtDprgoMxk',
    ],
    title: ['h2 a', 'h2.LnpumSThxEWMIsDdAT17.CXMyPcQ6nDv47DKFeywM a'],
    snippet: [
      'div.E2eLOJr8HctVnDOTM8fs div span.kY2IgmnCmOGjharHErah',
      'div.OgdwYG6KE2qthn9XQWFC span.kY2IgmnCmOGjharHErah',
    ],
    url: ['h2 a', 'div.pAgARfGNTRe_uaK72TAD a.Rn_JXVtoPVAFyGkcaXyK'],
    domain: [
      'div.OHr0VX9IuNcv6iakvT6A',
      'div.mwuQiMOjmFJ5vmN6Vcqw.SgSTKoqQXa0tEszD2zWF span',
    ],
  },
  images: {
    resultItem: ['div.tile.tile--img.has-detail', 'div.tile--img'],
    title: ['a.tile--img__sub', 'span.tile--img__title'],
    imageUrl: ['img.tile--img__img', 'img.tile__media__img', 'img.js-lazyload'],
    pageUrl: ['a.tile--img__sub', 'a.tile__link'],
    dimensions: ['div.tile--img__dimensions', 'span.tile--img__dimensions'],
  },
  videos: {
    resultItem: [
      'div.tile.tile--c--w.tile--vid.has-detail.opt--t-xxs',
      'div.tile--vid',
    ],
    title: ['h6.tile__title.tile__title--2 a', 'h6.tile__title a'],
    body: ['div.tile__body', 'div.tile__count'],
    duration: [
      'div.image-labels span.image-labels__label',
      'span.image-labels__label',
    ],
    thumbnail: ['img.tile__media__img', 'img.js-lazyload'],
  },
  news: {
    resultItem: [
      'div.result.result--news',
      'div.result.result--news.result--img.result--url-above-snippet',
    ],
    title: ['h2.result__title a.result__a', 'h2.result__title a'],
    source: ['a.result__url', 'span.result__extras__url a.result__url'],
    snippet: ['div.result__snippet', 'div.result__body div.result__snippet'],
    time: ['span.result__timestamp', 'time.result__timestamp'],
  },
};

// src/services/base.ts

/* --------------------------------------------------------------------------
 * 指纹三位一体:UA / Client Hints / Accept-Language / Timezone / Locale
 * 改动时必须同步修改,避免任何一处不一致(不一致本身就是检测信号)
 * ------------------------------------------------------------------------ */
export const FINGERPRINT = {
  chromeMajor: '131',
  chromeFull: '131.0.6778.86',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  language: 'zh-CN',
  languages: ['zh-CN', 'zh', 'en-US', 'en'],
  platform: 'Win32',
  platformLabel: 'Windows',
  platformVersion: '15.0.0',
  architecture: 'x86',
  timezone: 'Asia/Shanghai',
  viewport: { width: 1920, height: 1080 },
};

export const BASE_URL = 'https://duckduckgo.com';

/* --------------------------------------------------------------------------
 * Stealth 插件:关闭自带 UA 清洗(我们用 CDP 全量接管)
 * ------------------------------------------------------------------------ */
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('user-agent-override');
const compatiblePuppeteer: VanillaPuppeteer = {
  connect: puppeteerCore.connect.bind(puppeteerCore),
  defaultArgs: puppeteerCore.defaultArgs.bind(puppeteerCore),
  executablePath: puppeteerCore.executablePath.bind(puppeteerCore),
  launch: puppeteerCore.launch.bind(puppeteerCore),
  createBrowserFetcher: (() => {
    throw new Error(
      'createBrowserFetcher is not supported by this Puppeteer version.',
    );
  }) as VanillaPuppeteer['createBrowserFetcher'],
};
const puppeteer = addExtra(compatiblePuppeteer);
puppeteer.use(stealth);

export interface SearchConfig {
  cacheTTL?: number;
  timeout?: number;
  maxRetries?: number;
  language?: string;
  region?: string;
  safeSearch?: boolean;
}

export class BaseService {
  protected browser: Browser | null = null;
  protected config: Required<SearchConfig>;

  constructor(config: SearchConfig = {}) {
    this.config = {
      cacheTTL: config.cacheTTL ?? 300,
      timeout: config.timeout ?? 20_000,
      maxRetries: config.maxRetries ?? 3,
      language: config.language ?? 'zh-CN',
      region: config.region ?? 'cn-zh',
      safeSearch: config.safeSearch ?? true,
    };
  }

  protected log(message: string): void {
    if (process.env.NODE_ENV !== 'production' && process.env.VERBOSE === '1') {
      console.log(`[DDG] ${message}`);
    }
  }

  protected logError(error: unknown): void {
    if (process.env.NODE_ENV !== 'production' && process.env.VERBOSE === '1') {
      console.error('[DDG] Full error:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }

  /**
   * 初始化并复用浏览器实例。
   * 如果当前已经有可用连接，就直接返回，避免重复拉起浏览器进程。
   */
  protected async initBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    const { width, height } = FINGERPRINT.viewport;

    const browser = await puppeteer.launch({
      // 推荐 xvfb + headless:false;次选 'shell';避免使用 'new'(HeadlessChrome 特征明显)
      headless: process.env.HEADFUL === '1' ? false : 'shell',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // 关键:消除自动化标志
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-notifications',
        '--disable-popup-blocking',
        // 语言与窗口
        `--lang=${FINGERPRINT.language}`,
        `--window-size=${width},${height}`,
        '--window-position=0,0',
        // 注意:以下参数已移除,因为它们本身就是检测信号
        //   --disable-web-security
        //   --disable-features=IsolateOrigins,site-per-process
        //   --disable-gpu
        //   --ignore-certificate-errors(系列)
        //   --disable-blink-features(空参数会覆盖 AutomationControlled)
      ],
      // 移除 Puppeteer 默认注入的自动化标志位(navigator.webdriver 根因)
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null, // 让 --window-size 生效,更真实
      executablePath: process.env.CHROME_PATH, // 建议指向系统 Chrome
    });

    this.browser = browser;
    return browser;
  }

  /* ------------------------------------------------------------------------
   * Page 级别:CDP 注入指纹、请求拦截、反检测兜底脚本
   * ---------------------------------------------------------------------- */
  protected async setupPage(page: Page): Promise<void> {
    page.setDefaultNavigationTimeout(this.config.timeout);
    page.setDefaultTimeout(this.config.timeout);

    const client = await page.target().createCDPSession();

    // 1) UA + Client Hints(必须与 UA 中 Chrome 版本严格一致)
    await client.send('Network.setUserAgentOverride', {
      userAgent: FINGERPRINT.userAgent,
      acceptLanguage: FINGERPRINT.acceptLanguage,
      platform: FINGERPRINT.platform,
      userAgentMetadata: {
        brands: [
          { brand: 'Google Chrome', version: FINGERPRINT.chromeMajor },
          { brand: 'Chromium', version: FINGERPRINT.chromeMajor },
          { brand: 'Not_A Brand', version: '24' },
        ],
        fullVersion: FINGERPRINT.chromeFull,
        platform: FINGERPRINT.platformLabel,
        platformVersion: FINGERPRINT.platformVersion,
        architecture: FINGERPRINT.architecture,
        model: '',
        mobile: false,
      },
    });

    // 2) 时区 + Locale(修正 Intl.DateTimeFormat 暴露的服务器时区)
    await client.send('Emulation.setTimezoneOverride', {
      timezoneId: FINGERPRINT.timezone,
    });
    try {
      await client.send('Emulation.setLocaleOverride', {
        locale: FINGERPRINT.language,
      });
    } catch {
      /* 某些 Chrome 版本不支持,忽略即可 */
    }

    // 3) 只设置必要的请求头;Sec-Fetch-* 交给浏览器按导航上下文自动生成,更真实
    await page.setExtraHTTPHeaders({
      'Accept-Language': FINGERPRINT.acceptLanguage,
    });

    // 4) 兜底反指纹脚本(Stealth 处理大部分,这里补漏)
    await page.evaluateOnNewDocument(() => {
      // navigator.languages 与 Accept-Language 对齐
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      });

      // permissions.query 经典检测点:notifications 应返回 Notification.permission
      const originalQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions,
      );
      // @ts-ignore
      window.navigator.permissions.query = (parameters: any) =>
        parameters?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as any)
          : originalQuery(parameters);

      // 清除 ChromeDriver / CDP 常见变量痕迹
      const w = window as any;
      for (const key of Object.keys(w)) {
        if (/^cdc_[\w]+_(Array|Promise|Symbol|JSON|Object)$/.test(key)) {
          try {
            delete w[key];
          } catch {
            /* ignore */
          }
        }
      }

      // WebGL vendor / renderer 兜底(Stealth 已处理,双重保险)
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      // @ts-ignore
      WebGLRenderingContext.prototype.getParameter = function (param: number) {
        if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return getParameter.call(this, param);
      };

      // 修复 window.chrome 结构
      if (!(window as any).chrome) {
        (window as any).chrome = {
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
        };
      }
    });

    // 5) 资源拦截:屏蔽图片/字体/媒体,降低被动指纹采集并提速
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        return req.abort().catch(() => {});
      }
      return req.continue().catch(() => {});
    });
  }

  /* ------------------------------------------------------------------------
   * 真人行为模拟
   * ---------------------------------------------------------------------- */
  protected async humanize(page: Page): Promise<void> {
    const { width, height } = FINGERPRINT.viewport;

    // 鼠标随机移动几次
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(
        Math.floor(Math.random() * width),
        Math.floor(Math.random() * height),
        { steps: 10 + Math.floor(Math.random() * 20) },
      );
      await this.sleep(120, 380);
    }

    // 分段滚动 + 回滚(模拟阅读)
    await page.evaluate(async () => {
      const total = document.body.scrollHeight;
      let cur = 0;
      while (cur < Math.min(total, 2400)) {
        const step = 200 + Math.random() * 300;
        cur += step;
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
      }
      window.scrollBy(0, -300);
    });

    await this.sleep(600, 1500);
  }

  /** 仿真键盘输入节奏 */
  protected async typeHumanLike(
    page: Page,
    selector: string,
    text: string,
  ): Promise<void> {
    for (const ch of text) {
      await page.type(selector, ch, { delay: 60 + Math.random() * 120 });
      if (Math.random() < 0.08) await this.sleep(200, 500);
    }
  }

  protected sleep(min: number, max?: number): Promise<void> {
    const ms = max ? min + Math.random() * (max - min) : min;
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ------------------------------------------------------------------------
   * 资源释放
   * ---------------------------------------------------------------------- */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /**
   * 校验搜索词是否为空。
   * 这里直接使用当前文件内已定义的错误类型，避免再去 `require` 一个并不存在的模块。
   */
  protected validateQuery(query: string): void {
    if (!query?.trim()) {
      throw new DuckDuckGoError(
        ErrorCodes[ErrorType.VALIDATION],
        'Search query cannot be empty',
        undefined,
        ErrorType.VALIDATION,
      );
    }
  }
}

// src/services/search.ts
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  position: number;
  domain: string;
}

export interface SearchResponse {
  results: SearchResultItem[];
}

export class SearchService extends BaseService {
  /** 对外入口:带指数退避重试 */
  async search(query: string): Promise<SearchResponse> {
    this.validateQuery(query);

    let lastErr: unknown;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        return await this.searchOnce(query);
      } catch (err) {
        lastErr = err;
        // 验证失败、未找到结果等不必重试
        if (
          err instanceof DuckDuckGoError &&
          (err.type === ErrorType.VALIDATION ||
            err.type === ErrorType.NOT_FOUND)
        ) {
          throw err;
        }
        const backoff = 1000 * 2 ** attempt + Math.random() * 1000;
        this.log(
          `Attempt ${attempt + 1} failed, backoff ${backoff.toFixed(0)}ms`,
        );
        await this.sleep(backoff);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new DuckDuckGoError(
          ErrorCodes[ErrorType.UNKNOWN],
          'Search failed after retries',
          lastErr,
          ErrorType.UNKNOWN,
        );
  }

  /** 单次搜索:模拟真人「访问首页 → 键入搜索词 → 回车跳转」 */
  private async searchOnce(query: string): Promise<SearchResponse> {
    const browser = await this.initBrowser();
    let page: Page | null = null;

    try {
      page = await browser.newPage();
      await this.setupPage(page);
      this.log('Page configured');

      // Step 1: 访问首页,建立自然 Referer 链路
      await page.goto(BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.timeout,
      });
      this.log('Homepage loaded');
      await this.humanize(page);

      // Step 2: 输入搜索词(仿真键入)
      const inputSelector = 'input[name="q"]';
      await page.waitForSelector(inputSelector, {
        timeout: this.config.timeout,
      });
      await page.click(inputSelector, { clickCount: 1 });
      await this.sleep(150, 400);
      await this.typeHumanLike(page, inputSelector, query);
      await this.sleep(300, 800);

      // Step 3: 回车触发真实跳转
      await Promise.all([
        page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: this.config.timeout,
        }),
        page.keyboard.press('Enter'),
      ]);
      this.log('Results page navigated');

      // Step 4: 等待结果容器,再做一次人性化交互
      await page.waitForSelector('.react-results--main', {
        timeout: this.config.timeout,
      });
      await this.humanize(page);

      // Step 5: 解析结果
      const results = await page.evaluate((sel: typeof selectors.search) => {
        const out: Array<{
          title: string;
          url: string;
          snippet: string;
          position: number;
          domain: string;
        }> = [];

        const pickOne = (root: Element, list: string[]): Element | null => {
          for (const s of list) {
            const el = root.querySelector(s);
            if (el) return el;
          }
          return null;
        };

        let articles: NodeListOf<Element> | null = null;
        for (const s of sel.resultItem) {
          articles = document.querySelectorAll(s);
          if (articles.length) break;
        }
        if (!articles) return out;

        articles.forEach((article, i) => {
          const titleEl = pickOne(article, sel.title);
          const snippetEl = pickOne(article, sel.snippet);
          const urlEl = pickOne(article, sel.url) ?? titleEl;
          const domainEl = pickOne(article, sel.domain);

          if (!titleEl || !urlEl) return;
          const href = urlEl.getAttribute('href');
          if (!href || href === '#') return;

          const formattedUrl = href.startsWith('http')
            ? href
            : `https://${href}`;

          out.push({
            title:
              titleEl.textContent
                ?.trim()
                ?.replace(
                  "Your browser indicates if you've visited this link",
                  '',
                ) ?? '',
            url: formattedUrl,
            snippet: snippetEl?.textContent?.trim() ?? '',
            position: i + 1,
            domain:
              domainEl?.textContent
                ?.trim()
                ?.replace(
                  /Only include results for this siteHide site from these resultsShare feedback about this site/,
                  '',
                ) ?? '',
          });
        });

        return out;
      }, selectors.search);

      this.log(`Parsed ${results.length} results`);

      if (!results.length) {
        throw new DuckDuckGoError(
          ErrorCodes[ErrorType.NOT_FOUND],
          'No results found',
          undefined,
          ErrorType.NOT_FOUND,
        );
      }

      return { results };
    } catch (error) {
      this.logError(error);

      if (page) {
        try {
          const html = await page.content();
          this.log(`Current HTML (head): ${html.substring(0, 500)}...`);
        } catch {
          /* ignore */
        }
      }

      if (error instanceof DuckDuckGoError) throw error;
      throw new DuckDuckGoError(
        ErrorCodes[ErrorType.PARSING],
        'Failed to parse search results',
        error,
        ErrorType.PARSING,
      );
    } finally {
      if (page) await page.close().catch(() => {});
      // 注意:不在此处关闭 browser,由上层 DuckDuckGoService.close() 统一释放
    }
  }
}
