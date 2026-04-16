import * as vscode from 'vscode';
import { basename, dirname } from "node:path";
import { isTempFile } from './files';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type CueFileType =
    'component-definition' |
    'trait-definition' |
    'policy-definition' |
    'workflow-step-definition' |
    'parameter' |
    'template' |
    'resource' |
    'generated' |
    'unknown' |
    null;

export async function getCueFileType(document: vscode.TextDocument): Promise<CueFileType> {
    return getCueFileTypeFromPath(document.fileName, document.getText());
}

export async function getCueFileTypeFromPath(filePath: string, content?: string): Promise<CueFileType> {
    const dir = dirname(filePath);
    const baseName = basename(filePath);

    if (!filePath.endsWith('.cue')) {
        return null;
    }

    if (isTempFile(filePath)) {
        return 'generated';
    }

    const isDefinition = dir.endsWith('definitions') || (content && content.includes('template:'));

    // Extract definition type from CUE file if it's a definition
    let definitionType: string | null = null;
    if (isDefinition) {
        // TODO: Improve detecting definition type.
        const { stdout } = await execAsync(`sed -e '1,/^)$/d' -e '/^template:/,$d' ${filePath} | cue eval - --out json | awk -F'"' '/"type":/ {print $4}'`);
        definitionType = stdout.trim();
    }

    switch (true) {
        case baseName === 'parameter.cue':
            return 'parameter';
        case baseName === 'template.cue':
            return 'template';
        case dir.includes('/resources') || dir.endsWith('resources'):
            return 'resource';
        case definitionType === 'component':
            return 'component-definition';
        case definitionType === 'trait':
            return 'trait-definition';
        case definitionType === 'policy':
            return 'policy-definition';
        case definitionType === 'workflow-step':
            return 'workflow-step-definition';
        case isDefinition:
            return 'component-definition'; // fallback if type extraction fails
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