import { z } from 'zod/v4';

export const StepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goto'),
    url: z.string().describe('Destination URL (http/https).'),
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle'])
      .optional()
      .describe('Navigation wait condition.'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('click'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector. Prefer stable selectors when possible.'),
    text: z
      .string()
      .optional()
      .describe('Click element by text content (fallback).'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('fill'),
    selector: z.string().describe('CSS selector of input/textarea.'),
    value: z.string().describe('Text to fill.'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('press'),
    key: z.string().describe('Keyboard key, e.g. Enter, Escape, Tab.'),
  }),
  z.object({
    type: z.literal('waitForSelector'),
    selector: z.string().describe('CSS selector to wait for.'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('sleep'),
    ms: z
      .number()
      .int()
      .positive()
      .describe('Fixed delay in milliseconds.'),
  }),
  z.object({
    type: z.literal('scroll'),
    deltaY: z.number().int().describe('Vertical scroll delta.'),
  }),
  z.object({
    type: z.literal('extract'),
    kind: z.enum(['text', 'links', 'table']),
    selector: z
      .string()
      .optional()
      .describe('Optional scope selector. Defaults to whole page.'),
  }),
  z.object({
    type: z.literal('screenshot'),
    fullPage: z.boolean().optional(),
    path: z
      .string()
      .optional()
      .describe(
        'Relative path under /workspace/files. If omitted, auto-generated.',
      ),
  }),
]);

export type Step = z.infer<typeof StepSchema>;
