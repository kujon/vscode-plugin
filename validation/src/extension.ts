import { ExtensionContext, languages, Disposable, workspace, window } from 'vscode';
import * as vscode from 'vscode';

import { DiagnosticProvider } from './DiagnosticsProvider';
import { CueVetDiagnosticsProvider } from './CueVetDiagnosticsProvider';
import { VelaVetDiagnosticsProvider } from './VelaVetDiagnosticsProvider';
import { VelaYamlSchemaProvider } from './VelaYamlSchemaProvider';
import { checkTools } from './ToolManager';

let disposables: Disposable[] = [];


async function updateDiagnostics(document: vscode.TextDocument, diagnosticProvider: DiagnosticProvider): Promise<void> {
  if (diagnosticProvider.isApplicable(document)) {
    try {
      await diagnosticProvider.runCommand(document);
      diagnosticProvider.getCollection().clear();
    } catch (problem) {
      console.debug(problem);

      const problems = diagnosticProvider.findCoreProblems(document, problem as string);

      diagnosticProvider.getCollection().set(
        document.uri,
        problems.map(problem => ({
          message: problem.message,
          range: problem.range,
          severity: problem.severity,
          source: diagnosticProvider.getName(),
          relatedInformation: [
            new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, problem.range), problem.message)
          ]
        }))
      );
    }
  } else {
    diagnosticProvider.getCollection().clear();
  }
}

const diagnosticProviders: DiagnosticProvider[] = [
  new VelaVetDiagnosticsProvider(languages.createDiagnosticCollection('vela vet')),
  new CueVetDiagnosticsProvider(languages.createDiagnosticCollection('cue vet'))
];

export async function activate(context: ExtensionContext) {
  checkTools();

  const yamlSchemaProvider = new VelaYamlSchemaProvider(context.globalStorageUri.fsPath);
  await yamlSchemaProvider.register();

  for (const provider of diagnosticProviders) {
    provider.activate();
  }

  if (window.activeTextEditor) {
    for (const provider of diagnosticProviders) {
      updateDiagnostics(window.activeTextEditor.document, provider);
    }
  }

  context.subscriptions.push(workspace.onDidChangeTextDocument(documentEvent => {
    if (documentEvent) {
      for (const provider of diagnosticProviders) {
        updateDiagnostics(documentEvent.document, provider);
      }
    }
  }));

  context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      for (const provider of diagnosticProviders) {
        updateDiagnostics(editor.document, provider);
      }
    }
  }));
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (disposables) {
    disposables.forEach(item => item.dispose());
  }
  disposables = [];

  for (const provider of diagnosticProviders) {
    provider.deactivate();
  }
}