import * as cheerio from 'cheerio';

/**
 * 移除无用的 HTML 元素，提取纯文本
 */
export function cleanHtmlToText(html: string | null | undefined): string {
  if (!html) return '';

  const $ = cheerio.load(html);

  // 移除无用标签
  $('script, style, noscript, iframe, svg, nav, footer, header, aside, .ad, .advertisement').remove();

  // 替换换行标签
  $('br, hr').replaceWith('\n');
  $('p, div, section, article, h1, h2, h3, h4, h5, h6, li').each((_, el) => {
    $(el).append('\n');
  });

  return $.text()
    .replace(/[ \t]+/g, ' ') // 将多个空格/制表符替换为单个空格
    .replace(/\n\s*\n/g, '\n\n') // 将连续多行空行替换为两行
    .trim();
}
