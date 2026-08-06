/**
 * Utility functions for Deepnote block ID and sorting key generation
 */

import { NotebookCell, NotebookCellData } from 'vscode';

import type { Pocket } from '../../platform/deepnote/pocket';

export function parseJsonWithFallback(value: string, fallback?: unknown): unknown | null {
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback ?? null;
    }
}

/**
 * Generate a random hex ID for blocks (32 character hex string)
 */
export function generateBlockId(): string {
    const chars = '0123456789abcdef';
    let id = '';
    for (let i = 0; i < 32; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

/** Agent block cell. Lives here so importers avoid `@deepnote/runtime-core`. */
export function isAgentCell(cell: NotebookCell): boolean {
    const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;

    return pocket?.type === 'agent';
}

/** Agent-generated scratch cell (`metadata.is_ephemeral`). */
export function isEphemeralCell(cell: NotebookCell | NotebookCellData): boolean {
    return cell.metadata?.is_ephemeral === true;
}

/**
 * Serialized block id, or undefined. Prefer `__deepnoteBlockId` — VS Code may rewrite `id`.
 * Missing id makes callers mint a new one and reassign the block on save.
 */
export function getBlockId(cell: NotebookCell | NotebookCellData): string | undefined {
    return (
        (cell.metadata?.__deepnoteBlockId as string | undefined) ||
        (cell.metadata?.id as string | undefined) ||
        (cell.metadata?.deepnoteBlockId as string | undefined)
    );
}

/** Owning agent block id when `isEphemeralCell`; otherwise undefined. */
export function getEphemeralCellAgentSourceBlockId(cell: NotebookCell): string | undefined {
    return isEphemeralCell(cell) ? (cell.metadata?.agent_source_block_id as string | undefined) : undefined;
}

/**
 * Generate sorting key based on index (format: a0, a1, ..., a99, b0, b1, ...)
 */
export function generateSortingKey(index: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const letterIndex = Math.floor(index / 100);
    const letter = letterIndex < alphabet.length ? alphabet[letterIndex] : 'z';
    const number = index % 100;
    return `${letter}${number}`;
}
