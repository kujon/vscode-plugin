import * as vscode from 'vscode';
import { CueVetDiagnosticsProvider } from './CueVetDiagnosticsProvider';
import { getCueFileType } from './utils/cue';

export class CueVetCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor(private diagnosticsProvider: CueVetDiagnosticsProvider) { }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        if (!this.diagnosticsProvider.isApplicable(document)) {
            return [];
        }

        const tempFilePath = this.diagnosticsProvider.getTempFilePath(document);
        if (!tempFilePath) {
            return [];
        }

        const topOfDocument = new vscode.Range(0, 0, 0, 0);
        const codeLens = new vscode.CodeLens(topOfDocument, {
            title: `$(file-code) Vela ${getCueFileType(document)}`,
            command: 'vscode.open',
            arguments: [vscode.Uri.file(tempFilePath)]
        });

        return [codeLens];
    }
}
