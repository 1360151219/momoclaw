/**
 * Enhanced UI Components for MiniClaw
 * Provides loading animations, thinking timers, and tool call visualization
 */

import kleur from 'kleur';
import { ToolCall, ToolEvent } from './types.js';

// Spinner animation frames
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

/**
 * Loading spinner with thinking timer
 */
export class LoadingSpinner {
  private interval: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private startTime: number = 0;
  private currentText = '';
  private isActive = false;

  constructor(private prefix: string = 'Thinking') {}

  /**
   * Start the loading spinner
   */
  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.startTime = Date.now();
    this.frameIndex = 0;
    this.render();
    this.interval = setInterval(() => this.tick(), SPINNER_INTERVAL);
  }

  /**
   * Update the spinner text
   */
  setText(text: string): void {
    this.currentText = text;
    if (this.isActive) {
      this.render();
    }
  }

  /**
   * Stop the spinner and clear the line
   */
  stop(): void {
    if (!this.isActive) return;
    this.isActive = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.clearLine();
  }

  /**
   * Stop the spinner and keep the final message
   */
  finish(message?: string): void {
    if (!this.isActive) return;
    this.stop();
    if (message) {
      console.log(message);
    }
  }

  private tick(): void {
    this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
    this.render();
  }

  private getElapsedTime(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    if (elapsed < 60) {
      return `${elapsed}s`;
    }
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  }

  private render(): void {
    const spinner = SPINNER_FRAMES[this.frameIndex];
    const time = this.getElapsedTime();
    const textPart = this.currentText ? ` ${this.currentText}` : '';
    const line = `${kleur.cyan(spinner)} ${kleur.gray(this.prefix)}${textPart} ${kleur.gray(`(${time})`)}`;
    this.clearLine();
    process.stdout.write(line);
  }

  private clearLine(): void {
    process.stdout.write('\r');
    process.stdout.clearLine(0);
  }
}

/**
 * Tool call visualization
 */
export function displayToolCall(toolCall: ToolCall, index: number = 0): void {
  const icon = '⚙️';
  const toolName = kleur.magenta(toolCall.name);
  const args = JSON.stringify(toolCall.arguments, null, 2);

  console.log();
  console.log(`${kleur.gray('─'.repeat(50))}`);
  console.log(`${icon} ${kleur.bold('Tool Call')} ${kleur.gray(`#${index + 1}`)}: ${toolName}`);
  console.log();

  // Display arguments in a readable format
  const argsLines = args.split('\n');
  for (const line of argsLines) {
    console.log(`  ${kleur.gray(line)}`);
  }
  console.log(`${kleur.gray('─'.repeat(50))}`);
  console.log();
}

/**
 * Display a section header
 */
export function displaySectionHeader(title: string, icon?: string): void {
  const iconStr = icon ? `${icon} ` : '';
  console.log();
  console.log(kleur.bold().cyan(`${iconStr}${title}`));
  console.log(kleur.gray('─'.repeat(Math.min(title.length + 4, 50))));
}

/**
 * Display assistant response with proper formatting
 */
export function displayAssistantResponse(content: string): void {
  // Ensure content starts on a new line
  if (!content.startsWith('\n')) {
    console.log();
  }
  // Content is streamed directly, but we can add post-processing here if needed
}

/**
 * Display welcome banner
 */
export function displayWelcomeBanner(sessionId: string, model: string): void {
  const shortModel = model.split('/').pop() || model;

  console.log();
  console.log(kleur.bold().cyan('╭─────────────────────────────────────────────╮'));
  console.log(kleur.bold().cyan('│') + '           ' + kleur.bold().white('MiniClaw AI Assistant') + '           ' + kleur.bold().cyan('│'));
  console.log(kleur.bold().cyan('╰─────────────────────────────────────────────╯'));
  console.log();
  console.log(`${kleur.gray('Session:')} ${kleur.cyan(sessionId)}  ${kleur.gray('Model:')} ${kleur.cyan(shortModel)}`);
  console.log();
  console.log(kleur.gray('Commands:'));
  console.log(`  ${kleur.cyan('/model <name>')}    - Switch model`);
  console.log(`  ${kleur.cyan('/system <prompt>')}  - Update system prompt`);
  console.log(`  ${kleur.cyan('/memory')}          - View memory and history`);
  console.log(`  ${kleur.cyan('/clear')}           - Clear session history`);
  console.log(`  ${kleur.cyan('/exit')}            - Quit`);
  console.log();
}

/**
 * Format the prompt prefix
 */
export function formatPromptPrefix(sessionId: string, model: string): string {
  const shortModel = model.split('/').pop() || model;
  return kleur.gray(`[${sessionId}:${shortModel}]`) + ' ' + kleur.cyan('>');
}

/**
 * Display error message with proper formatting
 */
export function displayError(message: string): void {
  console.log();
  console.log(kleur.red('❌ Error:'));
  console.log(`  ${kleur.red(message)}`);
  console.log();
}

/**
 * Display success message
 */
export function displaySuccess(message: string): void {
  console.log();
  console.log(kleur.green(`✓ ${message}`));
  console.log();
}

/**
 * Display a real-time tool use event (as it happens)
 */
export function displayToolUseEvent(toolCall: ToolCall, hasStartedOutput: boolean): void {
  const icon = '🔧';
  const toolName = kleur.magenta(toolCall.name);
  const args = JSON.stringify(toolCall.arguments, null, 2);

  if (!hasStartedOutput) {
    console.log();
  }
  console.log(`${kleur.gray('─'.repeat(50))}`);
  console.log(`${icon} ${kleur.bold('Using Tool')}: ${toolName}`);
  console.log();

  // Display arguments in a readable format
  const argsLines = args.split('\n');
  for (const line of argsLines) {
    console.log(`  ${kleur.gray(line)}`);
  }
  console.log(`${kleur.gray('─'.repeat(50))}`);
}

/**
 * Display a real-time tool result event (as it happens)
 */
export function displayToolResultEvent(toolCallId: string, result: string, subtype?: string): void {
  const icon = '✅';
  const status = subtype ? kleur.cyan(subtype) : kleur.cyan('complete');

  console.log(`${kleur.gray('─'.repeat(50))}`);
  console.log(`${icon} ${kleur.bold('Tool Result')}: ${status}`);
  console.log();

  // Display a preview of the result (truncated if too long)
  let resultPreview = result.trim();
  if (resultPreview.length > 500) {
    resultPreview = resultPreview.slice(0, 500) + '... (truncated)';
  }

  if (resultPreview) {
    const resultLines = resultPreview.split('\n');
    for (const line of resultLines.slice(0, 10)) { // Show max 10 lines
      console.log(`  ${kleur.gray(line)}`);
    }
    if (resultLines.length > 10) {
      console.log(`  ${kleur.gray('... (more lines)')}`);
    }
  }
  console.log(`${kleur.gray('─'.repeat(50))}`);
}

/**
 * Display a thinking event (AI's internal thinking)
 */
export function displayThinkingEvent(thinking: string, hasStartedOutput: boolean): void {
  const icon = '💭';

  if (!hasStartedOutput) {
    console.log();
  }
  console.log(`${kleur.gray('─'.repeat(50))}`);
  console.log(`${icon} ${kleur.bold('Thinking')}`);
  console.log();

  // Display thinking content (truncated if too long)
  let thinkingContent = thinking.trim();
  if (thinkingContent.length > 1000) {
    thinkingContent = thinkingContent.slice(0, 1000) + '... (truncated)';
  }

  if (thinkingContent) {
    const thinkingLines = thinkingContent.split('\n');
    for (const line of thinkingLines.slice(0, 20)) { // Show max 20 lines
      console.log(`  ${kleur.gray(line)}`);
    }
    if (thinkingLines.length > 20) {
      console.log(`  ${kleur.gray('... (more lines)')}`);
    }
  }
  console.log(`${kleur.gray('─'.repeat(50))}`);
}
