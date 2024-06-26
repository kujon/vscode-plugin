import * as vscode from 'vscode';
import { DiagnosticProvider } from './DiagnosticsProvider';
import { spawn } from 'child_process';

export class VelaVetDiagnosticsProvider implements DiagnosticProvider {
    private collection: vscode.DiagnosticCollection

    constructor(collection: vscode.DiagnosticCollection) {
        this.collection = collection;
    }

    activate(): void {

    }

    deactivate(): void {

    }

    getName(): string {
        return 'vela';
    }

    isApplicable(document: vscode.TextDocument): boolean {
        return document.languageId === 'cue' && document.getText().includes('template:');
    }

    getCollection(): vscode.DiagnosticCollection {
        return this.collection;
    }

    runCommand(document: vscode.TextDocument): Promise<string> {
        const command = `vela def vet ${document.fileName}`;

        const process = spawn(command, { shell: true });

        return new Promise((resolve, reject) => {
            process.stdout.on('data', (data) => {
                resolve(data.toString());
            });

            process.stderr.on('data', (data) => {
                reject(data.toString());
            });
        });
    }

    findRange(document: vscode.TextDocument, problem: string): vscode.Range {
        const regexes = [
            // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid type trit
            /invalid type (.+)/,
            // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: cannot unmarshal number into Go struct field TraitDefinitionSpec.podDisruptive of type bool
            // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: cannot unmarshal number into Go struct field WorkloadTypeDescriptor.workload.type of type string
            /field [\w\.]+\.+(\w+) of type/,
            // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: test2.attributes.podDisruptive: reference "tru" not found
            /reference \"(.+)\" not found/,
            // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: unknown field "podDisruptive"
            /unknown field "(.+)"/
        ];

        let keyword: string | undefined;
        for (const regex of regexes) {
            const match = problem.match(regex);

            if (match && match.length > 0) {
                keyword = match.slice(-1)[0];
                break;
            }
        }

        if (!keyword) {
            return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0));
        }

        const startOffset = document.getText().indexOf(keyword);
        const endOffset = startOffset + keyword.length;
        return new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );
    }

    findCoreProblem(problem: string): string {
        // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: unknown field "podDisruptive"
        // into
        // invalid definition spec: json: unknown field "podDisruptive"
        return problem.replace(/Error\: failed to parse CUE\:\s.+\.\w+\:\s/, '');
    }
}