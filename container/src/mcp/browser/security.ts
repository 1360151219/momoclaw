import fs from 'fs';
import path from 'path';
import { ensureDir } from './processManager.js';
import {
  GLOBAL_BLOCKLIST_PATH,
  DEFAULT_BLOCKED_HOST_PATTERNS,
} from './constants.js';

/**
 * Read global blocklist from workspace (if present).
 */
export function readGlobalBlocklist(): string[] {
  try {
    if (!fs.existsSync(GLOBAL_BLOCKLIST_PATH)) return [];
    const raw = fs.readFileSync(GLOBAL_BLOCKLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { domains?: unknown };
    if (!Array.isArray(parsed.domains)) return [];
    return parsed.domains.filter((d): d is string => typeof d === 'string');
  } catch {
    return [];
  }
}

/**
 * Persist global blocklist to workspace.
 */
export function writeGlobalBlocklist(domains: string[]): void {
  const dir = path.dirname(GLOBAL_BLOCKLIST_PATH);
  ensureDir(dir);
  fs.writeFileSync(
    GLOBAL_BLOCKLIST_PATH,
    JSON.stringify({ domains }, null, 2),
    'utf-8',
  );
}

/**
 * Check if hostname is an IPv4 literal.
 */
function isIpv4Literal(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

/**
 * Check if an IPv4 literal is private / local / link-local / reserved.
 */
function isBlockedIpv4(ipv4: string): boolean {
  const parts = ipv4.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true; // treat invalid as blocked
  }
  // 127.0.0.0/8 loopback
  if (parts[0] === 127) return true;
  // 10.0.0.0/8 private
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 private
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 private
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 link-local
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8 reserved
  if (parts[0] === 0) return true;
  return false;
}

/**
 * Match a hostname against blocklist patterns.
 */
function isHostBlockedByPatterns(
  hostname: string,
  blockDomains: string[],
): boolean {
  const host = hostname.toLowerCase();
  for (const ruleRaw of blockDomains) {
    const rule = ruleRaw.toLowerCase().trim();
    if (!rule) continue;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (host === suffix) return true;
      if (host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (host === rule) return true;
    if (host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

/**
 * Validate a URL is http(s) and NOT blocked by the effective blocklist.
 * Throws a friendly error message on violation.
 */
export function assertUrlNotBlocked(urlStr: string, blockDomains: string[]): void {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed. Got: ${u.protocol}`);
  }

  const host = u.hostname.toLowerCase();
  if (isIpv4Literal(host) && isBlockedIpv4(host)) {
    throw new Error(`Navigation blocked. IPv4 host "${host}" is not allowed.`);
  }

  const effective = [...DEFAULT_BLOCKED_HOST_PATTERNS, ...blockDomains];
  if (isHostBlockedByPatterns(host, effective)) {
    throw new Error(
      `Navigation blocked by blocklist. Host "${host}" is blocked.`,
    );
  }
}
