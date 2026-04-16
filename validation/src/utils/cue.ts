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
    return getCueFileTypeFromPath(document.fileName, document.getText());
}

export function getCueFileTypeFromPath(filePath: string, content?: string): CueFileType {
    const dir = dirname(filePath);
    const baseName = basename(filePath);

    switch (true) {
        case !filePath.endsWith('.cue'):
            return 'unknown';
        case isTempFile(filePath):
            return 'generated';
        case baseName === 'parameter.cue':
            return 'parameter';
        case baseName === 'template.cue':
            return 'template';
        case dir.includes('/resources') || dir.endsWith('resources'):
            return 'resource';
        case dir.endsWith('definitions') || (content && content.includes('template:')):
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