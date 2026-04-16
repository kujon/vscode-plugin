import * as vscode from 'vscode';
import { CoreProblem, DiagnosticProvider } from './DiagnosticsProvider';
import { getToolPath } from './ToolManager';
import { getCueFileType } from './utils/cue';
import { runCommand } from './utils/command';

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
        return 'vela def vet';
    }

    async isApplicable(document: vscode.TextDocument): Promise<boolean> {
        const cueFileType = await getCueFileType(document);
        return cueFileType === 'component-definition' ||
            cueFileType === 'trait-definition' ||
            cueFileType === 'policy-definition' ||
            cueFileType === 'workflow-step-definition';
    }

    getCollection(): vscode.DiagnosticCollection {
        return this.collection;
    }

    async runCommand(document: vscode.TextDocument): Promise<string> {
        const command = `${getToolPath('vela')} def vet ${document.fileName}`;

        const { stdout, stderr } = await runCommand(command);

        if (stderr) {
            throw stderr;
        }

        return stdout;
    }

    private findRange(document: vscode.TextDocument, problem: string): vscode.Range {
        const regexes = [
            // invalid type trit
            /invalid type (.+)/,
            // invalid definition spec: json: cannot unmarshal number into Go struct field TraitDefinitionSpec.podDisruptive of type bool
            // invalid definition spec: json: cannot unmarshal number into Go struct field WorkloadTypeDescriptor.workload.type of type string
            /field [\w\.]+\.+(\w+) of type/,
            // test2.attributes.podDisruptive: reference "tru" not found
            /reference \"(.+)\" not found/,
            // invalid definition spec: json: unknown field "podDisruptive"
            /unknown field "(.+)"/,
            // duplicated definition name found, vtx-static-site and podDisruptive
            /duplicated definition name found, .+ and (.+)/,
            // lol: cannot use value 42 (type int) as struct
            /(.+)\: cannot use value .+ \(type .+\) as .+/
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

    async findCoreProblems(document: vscode.TextDocument, problem: string): Promise<CoreProblem[]> {
        // invalid definition spec: json: unknown field "podDisruptive"
        // into
        // invalid definition spec: json: unknown field "podDisruptive"
        const coreProblem = problem.replace(/Error\: failed to parse CUE\:\s.+\.\w+\:\s/, '');
        return [{
            message: coreProblem,
            range: this.findRange(document, coreProblem),
            severity: vscode.DiagnosticSeverity.Error
        }];
    }
}