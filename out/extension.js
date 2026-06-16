"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
// --- FIX 1: Removed unused `import * as fs from "fs"` ---
const FALKON_EXTENSIONS = new Set([".flk"]);
let hasShownInSession = false;
// --- FIX 5: statusBarItem is initialised at declaration to avoid null-safety risk ---
// It is properly assigned inside activate() before any usage.
let statusBarItem;
function isFalkonFile(fsPath) {
    return FALKON_EXTENSIONS.has(path.extname(fsPath).toLowerCase());
}
async function buildAndRun(document) {
    const filePath = document.uri.fsPath;
    if (!isFalkonFile(filePath)) {
        return;
    }
    // Save the document first to ensure the latest changes are built
    if (document.isDirty) {
        await document.save();
    }
    const folder = path.dirname(filePath);
    const fileName = path.parse(filePath).name;
    const isWindows = process.platform === "win32";
    const exeName = isWindows ? `${fileName}.exe` : fileName;
    // --- FIX 2: Always recreate the terminal with the correct cwd instead of
    //            reusing a stale one whose working directory may be wrong.
    //            This ensures `falkon build <basename>` resolves against the right folder. ---
    const existingTerminal = vscode.window.terminals.find((t) => t.name === "Falkon Run");
    if (existingTerminal) {
        existingTerminal.dispose(); // kill stale terminal with wrong cwd
    }
    const terminal = vscode.window.createTerminal({
        name: "Falkon Run",
        cwd: folder,
        shellPath: isWindows ? "powershell.exe" : undefined,
    });
    terminal.show(true); // show terminal but preserve focus in editor
    // --- FIX 3: Correct PowerShell invocation.
    //   - buildCmd uses basename since terminal cwd = folder (safe now that we fixed cwd).
    //   - runCmd uses `& ".\\exe"` syntax which is correct in PowerShell for all name patterns.
    //   - On Unix we quote the run path properly. ---
    const buildCmd = `falkon build "${path.basename(filePath)}"`;
    const runCmd = isWindows
        ? `& ".\\${exeName}"`
        : `./"${exeName}"`;
    // PowerShell: use `;` so the run step always executes (shows build errors even on fail).
    // Unix: use `&&` so the run step only executes on successful build.
    const fullCmd = isWindows
        ? `${buildCmd} ; if ($LASTEXITCODE -eq 0) { ${runCmd} }`
        : `${buildCmd} && ${runCmd}`;
    terminal.sendText(fullCmd);
}
class FalkonDebugConfigurationProvider {
    /**
     * Provide initial debug configurations.
     */
    provideDebugConfigurations(folder, token) {
        return [
            {
                type: "falkon",
                name: "Launch",
                request: "launch",
            },
        ];
    }
    /**
     * Intercept debug launch — redirect to buildAndRun via terminal instead of
     * launching a real debug session (Falkon has no DAP adapter).
     */
    async resolveDebugConfiguration(folder, config, token) {
        console.log("Falkon Debug: resolveDebugConfiguration called", config);
        const falkonConfig = vscode.workspace.getConfiguration("falkon");
        const enableDebugIntercept = falkonConfig.get("enableDebugIntercept", true);
        if (!enableDebugIntercept) {
            console.log("Falkon Debug: Intercept disabled in settings.");
            return undefined;
        }
        // If no config is provided (e.g. F5 without launch.json), provide defaults
        if (!config.type && !config.request && !config.name) {
            console.log("Falkon Debug: Config is empty, providing defaults");
            config.type = "falkon";
            config.name = "Launch";
            config.request = "launch";
        }
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            console.log("Falkon Debug: Active editor path:", editor.document.uri.fsPath);
            if (isFalkonFile(editor.document.uri.fsPath)) {
                console.log("Falkon Debug: Is a Falkon file, calling buildAndRun");
                await buildAndRun(editor.document);
            }
            else {
                console.log("Falkon Debug: NOT a Falkon file");
                vscode.window.showErrorMessage("Active file is not a .flk file.");
            }
        }
        else {
            console.log("Falkon Debug: No active editor");
            vscode.window.showErrorMessage("No active Falkon file to run.");
        }
        return undefined; // Abort actual debug session — handled via terminal
    }
}
// --- FIX 5: Accept statusBarItem as a parameter so checkFalkonInstallation
//            cannot crash if called before activate() initialises the item. ---
function checkFalkonInstallation(bar, showNotification) {
    return new Promise((resolve) => {
        cp.exec("falkon -v", (error, stdout, stderr) => {
            if (error) {
                bar.text = `$(alert) Falkon: CLI Missing`;
                bar.tooltip = `Falkon compiler not found in PATH. Click to verify.`;
                bar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
                if (showNotification) {
                    vscode.window.showErrorMessage("Falkon compiler CLI ('falkon') could not be found in your system's PATH. Please ensure it is installed and added to PATH.");
                }
                resolve(false);
            }
            else {
                const version = stdout.trim() || stderr.trim() || "unknown version";
                bar.text = `$(check) Falkon: Ready`;
                bar.tooltip = `Falkon compiler is ready.\nVersion info: ${version}`;
                bar.backgroundColor = undefined;
                if (showNotification) {
                    vscode.window.showInformationMessage(`Falkon compiler CLI is ready! (${version})`);
                }
                resolve(true);
            }
        });
    });
}
function activate(context) {
    console.log("Falkon extension is now active!");
    // Resolve extension ID and version safely
    const myExtension = vscode.extensions.all.find((ext) => ext.extensionPath === context.extensionPath);
    const extensionId = myExtension
        ? myExtension.id.toLowerCase()
        : "falkon-industries.falkon-language";
    const currentVersion = myExtension
        ? myExtension.packageJSON.version
        : "0.1.0";
    // Create and configure the status bar item
    // --- FIX 5: Assign to the module-level variable AND pass it explicitly ---
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "falkon.checkCli";
    context.subscriptions.push(statusBarItem);
    // Register debug configuration provider
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("falkon", new FalkonDebugConfigurationProvider()));
    // --- Register: falkon.buildAndRun ---
    context.subscriptions.push(vscode.commands.registerCommand("falkon.buildAndRun", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("No active editor found.");
            return;
        }
        if (!isFalkonFile(editor.document.uri.fsPath)) {
            vscode.window.showWarningMessage("Active file is not a Falkon source file.");
            return;
        }
        await buildAndRun(editor.document);
    }));
    // --- Register: falkon.checkCli ---
    context.subscriptions.push(vscode.commands.registerCommand("falkon.checkCli", async () => {
        // Dispose any existing Falkon Check terminal to get a fresh one
        const existing = vscode.window.terminals.find((t) => t.name === "Falkon Check");
        if (existing) {
            existing.dispose();
        }
        const isWindows = process.platform === "win32";
        const checkTerminal = vscode.window.createTerminal({
            name: "Falkon Check",
            shellPath: isWindows ? "powershell.exe" : undefined,
        });
        checkTerminal.show(false);
        checkTerminal.sendText("falkon -v");
        // Also update status bar via exec (independent of the terminal output)
        if (statusBarItem) {
            await checkFalkonInstallation(statusBarItem, true);
        }
    }));
    // --- Register: falkon.openSettings ---
    context.subscriptions.push(vscode.commands.registerCommand("falkon.openSettings", () => {
        vscode.commands.executeCommand("workbench.action.openSettings", "falkon");
    }));
    // --- Register: falkon.showWalkthrough ---
    context.subscriptions.push(vscode.commands.registerCommand("falkon.showWalkthrough", () => {
        vscode.commands.executeCommand("workbench.action.openWalkthrough", `${extensionId}#falkonWalkthrough`, false);
    }));
    // Show / hide status bar item based on whether a .flk file is active
    const updateStatusBarVisibility = (editor) => {
        if (!statusBarItem) {
            return;
        }
        if (editor && isFalkonFile(editor.document.uri.fsPath)) {
            statusBarItem.show();
        }
        else {
            statusBarItem.hide();
        }
    };
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarVisibility));
    updateStatusBarVisibility(vscode.window.activeTextEditor);
    // Run initial silent CLI check to set status bar state
    checkFalkonInstallation(statusBarItem, false);
    // --- Walkthrough auto-open ---
    // We use "onStartupFinished" so VS Code guarantees ALL contribution points
    // (including walkthroughs from package.json) are registered before activate()
    // runs. This means openWalkthrough will always find our walkthrough by ID.
    //
    // "onStartupFinished" also fires when VS Code restarts the extension host
    // after a mid-session VSIX install, so both first-install and reinstall are
    // covered without needing "* " activation.
    //
    // A 500ms delay is kept as a safety margin for the Welcome panel's own
    // rendering cycle. This is small enough not to feel slow.
    //
    // Condition: show on every fresh extension host load (!hasShownInSession)
    // OR when the version changes (update scenario).
    const lastVersion = context.globalState.get("lastVersion");
    if (!hasShownInSession || lastVersion !== currentVersion) {
        hasShownInSession = true;
        context.globalState.update("lastVersion", currentVersion);
        setTimeout(() => {
            vscode.commands.executeCommand("workbench.action.openWalkthrough", `${extensionId}#falkonWalkthrough`, false);
        }, 500);
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map