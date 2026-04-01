import * as vscode from 'vscode';
import { execSync } from 'child_process';

interface ToolDefinition {
    name: string;
    settingKey: string;
    installUrl: string;
}

const TOOLS: ToolDefinition[] = [
    {
        name: 'kubectl',
        settingKey: 'velaValidation.tools.kubectlPath',
        installUrl: 'https://kubernetes.io/docs/tasks/tools/',
    },
    {
        name: 'cue',
        settingKey: 'velaValidation.tools.cuePath',
        installUrl: 'https://cuelang.org/docs/install/',
    },
    {
        name: 'vela',
        settingKey: 'velaValidation.tools.velaPath',
        installUrl: 'https://kubevela.io/docs/installation/kubernetes#install-vela-cli',
    },
];

function whichSync(name: string): string | undefined {
    try {
        return execSync(`which ${name}`, { encoding: 'utf-8', timeout: 5_000 }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function isExecutable(toolPath: string): boolean {
    try {
        execSync(`"${toolPath}" version`, { encoding: 'utf-8', timeout: 5_000, stdio: 'ignore' });
        return true;
    } catch {
        try {
            execSync(`"${toolPath}" --version`, { encoding: 'utf-8', timeout: 5_000, stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }
}

export function getToolPath(name: 'kubectl' | 'cue' | 'vela'): string {
    const tool = TOOLS.find(t => t.name === name)!;
    const configured = vscode.workspace.getConfiguration().get<string>(tool.settingKey);
    if (configured) {
        return configured;
    }
    return name;
}

export async function checkTools(): Promise<void> {
    for (const tool of TOOLS) {
        const configured = vscode.workspace.getConfiguration().get<string>(tool.settingKey);

        if (configured) {
            if (!isExecutable(configured)) {
                const action = await vscode.window.showWarningMessage(
                    `Configured path for "${tool.name}" is not valid: ${configured}`,
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', tool.settingKey);
                }
            }
            continue;
        }

        const found = whichSync(tool.name);
        if (!found) {
            const action = await vscode.window.showWarningMessage(
                `"${tool.name}" was not found on your PATH. Some features will be unavailable.`,
                'Install',
                'Configure Path'
            );
            if (action === 'Install') {
                vscode.env.openExternal(vscode.Uri.parse(tool.installUrl));
            } else if (action === 'Configure Path') {
                vscode.commands.executeCommand('workbench.action.openSettings', tool.settingKey);
            }
        }
    }
}
