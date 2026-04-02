import * as vscode from 'vscode';
import { basename, dirname } from "node:path";
import { isTempFile } from './files';

export type CueFileType =
    'definition' |
    'parameter' |
    'template' |
    'resource' |
    'generated' |
    'unknown';

export function getCueFileType(document: vscode.TextDocument): CueFileType {
    const dir = dirname(document.fileName);
    const baseName = basename(document.fileName);

    switch (true) {
        case document.languageId !== 'cue':
            return 'unknown';
        case isTempFile(document.fileName):
            return 'generated';
        case baseName === 'parameter.cue':
            return 'parameter';
        case baseName === 'template.cue':
            return 'template';
        case dir.includes('/resources') || dir.endsWith('resources'):
            return 'resource';
        case dir.endsWith('definitions') || document.getText().includes('template:'):
            return 'definition';
        default:
            return 'unknown';
    }
}

/**
 * Finds the root resources directory by walking up the directory tree.
 * @param filePath - Path to a file that may be inside a resources directory
 * @returns The path to the resources directory, or empty string if not found
 */
export function findResourcesDir(filePath: string): string {
    let dir = dirname(filePath);
    while (dir && dir !== '/' && dir !== '.') {
        if (dir.endsWith('/resources') || dir.endsWith('\\resources')) {
            return dir;
        }
        const parentDir = dirname(dir);
        if (parentDir === dir) break; // Reached root
        dir = parentDir;
    }
    return '';
}