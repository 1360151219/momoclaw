import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const DEFAULT_MEMORY_TEMPLATE = `# Daily Memory

## Important Facts

(Key information learned today)

## Decisions Made

(Important decisions and their rationale)

## Progress

(What was accomplished today)

## Notes for Tomorrow

(Things to remember or follow up on)
`;

/**
 * Get today's date string in YYYY-MM-DD format
 */
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Memory store organized by date: memory/YYYY-MM-DD/MEMORY.md
 */
export class MemoryStore {
  private baseDir: string;

  constructor(workspaceDir: string) {
    this.baseDir = join(workspaceDir, 'memory');
    this.ensureTodayMemory();
  }

  /**
   * Get today's date string
   */
  private getTodayString(): string {
    return getTodayDate();
  }

  /**
   * Get the memory directory for a specific date
   */
  private getDateDir(date: string): string {
    return join(this.baseDir, date);
  }

  /**
   * Get the memory file path for a specific date
   */
  private getMemoryFile(date: string): string {
    return join(this.getDateDir(date), 'MEMORY.md');
  }

  /**
   * Ensure today's memory file exists
   */
  private ensureTodayMemory(): void {
    this.ensureDateMemory(this.getTodayString());
  }

  /**
   * Ensure memory file exists for a specific date
   */
  private ensureDateMemory(date: string): void {
    const dateDir = this.getDateDir(date);
    const memoryFile = this.getMemoryFile(date);

    if (!existsSync(dateDir)) {
      mkdirSync(dateDir, { recursive: true });
    }

    if (!existsSync(memoryFile)) {
      writeFileSync(memoryFile, DEFAULT_MEMORY_TEMPLATE, 'utf-8');
    }
  }

  /**
   * Read memory for a specific date (default: today)
   */
  read(date?: string): string {
    const targetDate = date || this.getTodayString();
    const memoryFile = this.getMemoryFile(targetDate);

    if (existsSync(memoryFile)) {
      return readFileSync(memoryFile, 'utf-8');
    }
    return '';
  }

  /**
   * Write memory for a specific date (default: today)
   */
  write(content: string, date?: string): void {
    const targetDate = date || this.getTodayString();
    this.ensureDateMemory(targetDate);
    const memoryFile = this.getMemoryFile(targetDate);
    writeFileSync(memoryFile, content, 'utf-8');
  }

  /**
   * Append to memory for a specific date (default: today)
   */
  append(content: string, date?: string): void {
    const targetDate = date || this.getTodayString();
    this.ensureDateMemory(targetDate);
    const memoryFile = this.getMemoryFile(targetDate);
    const existing = this.read(targetDate);
    writeFileSync(memoryFile, existing + '\n' + content, 'utf-8');
  }

  /**
   * Get today's memory file path for the container
   */
  getTodayMemoryPath(): string {
    const today = this.getTodayString();
    this.ensureDateMemory(today);
    return this.getMemoryFile(today);
  }

  /**
   * Get memory context for passing to container
   */
  getMemoryContext(): { todayPath: string; recentContent: string } {
    const today = this.getTodayString();
    this.ensureDateMemory(today);

    // Read today's memory
    const todayContent = this.read(today);

    // Also include yesterday's memory if exists
    const yesterday = this.getYesterdayString();
    let recentContent = `## Today (${today})\n\n${todayContent}`;

    if (yesterday) {
      const yesterdayContent = this.read(yesterday);
      if (yesterdayContent && !yesterdayContent.includes('(Key information learned today)')) {
        recentContent = `## Yesterday (${yesterday})\n\n${yesterdayContent}\n\n---\n\n` + recentContent;
      }
    }

    return {
      todayPath: this.getMemoryFile(today),
      recentContent,
    };
  }

  /**
   * Get yesterday's date string
   */
  private getYesterdayString(): string | null {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }

  /**
   * List all dates that have memory files
   */
  listDates(): string[] {
    if (!existsSync(this.baseDir)) {
      return [];
    }

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  }

  /**
   * Get paths for all memory directories
   */
  getAllPaths(): string[] {
    const dates = this.listDates();
    return dates.map((date) => this.getMemoryFile(date));
  }

  /**
   * Get the base memory directory
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
