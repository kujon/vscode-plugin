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
        case dir.endsWith('resources'):
            return 'resource';
        case dir.endsWith('definitions') || document.getText().includes('template:'):
            return 'definition';
        default:
            return 'unknown';
    }
}