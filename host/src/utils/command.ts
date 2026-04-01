/**
 * Parse slash command from message content
 * 
 * @param content - The message content to parse
 * @returns Object with command and args, or null if not a command
 */
export function parseCommand(content: string): { command: string; args: string } | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.slice(1).split(/\s+/, 2);
    return {
        command: parts[0] || '',
        args: parts[1] || '',
    };
}
