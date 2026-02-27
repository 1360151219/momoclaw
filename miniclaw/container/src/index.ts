#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { PromptPayload, ContainerResult } from './types.js';
import { runAgent } from './agent.js';

const INPUT_FILE = process.env.INPUT_FILE || '/workspace/input/payload.json';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/workspace/output/result.json';

async function main(): Promise<void> {
  // 确保输出目录存在
  const outputDir = dirname(OUTPUT_FILE);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 读取输入
  if (!existsSync(INPUT_FILE)) {
    const result: ContainerResult = {
      success: false,
      content: '',
      error: `Input file not found: ${INPUT_FILE}`,
    };
    writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const payload: PromptPayload = JSON.parse(readFileSync(INPUT_FILE, 'utf-8'));

  try {
    // 流式输出到stdout
    const result = await runAgent(payload, (chunk) => {
      process.stdout.write(chunk);
    });

    const output: ContainerResult = {
      success: true,
      content: result.content,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    };

    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  } catch (err: any) {
    const result: ContainerResult = {
      success: false,
      content: '',
      error: err.message || String(err),
    };
    writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
