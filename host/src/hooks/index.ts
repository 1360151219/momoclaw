/**
 * Context Compression Module
 *
 * Provides utilities for non-destructive context compression:
 * - compressContext: Incremental summarization with lastConsolidatedIndex tracking
 * - getContextWindow: Sliding window for unconsolidated messages
 */
export {
    compressContext,
    getContextWindow,
    type CompressorDependencies,
} from './contextCompression.js';
