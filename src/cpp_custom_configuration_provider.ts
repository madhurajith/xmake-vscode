import * as path from 'path';
import * as vscode from 'vscode';
import { Uri, CancellationToken } from "vscode";
import { CustomConfigurationProvider, SourceFileConfigurationItem, WorkspaceBrowseConfiguration } from "vscode-cpptools";

function isMSVC(args: string[]) : boolean {
    return path.basename(args[1]).toLowerCase() == "cl";
}

function findIncludePaths(dir: string, args: string[]) : string[] {
    const includeOptionPrefix = isMSVC(args) ? "/I" : "-I";
    return args.filter(arg => arg.startsWith(includeOptionPrefix)).map(inc => {
        let includePath = inc.substring(2);
        return path.isAbsolute(includePath) ? includePath : path.join(dir, includePath);
    });
}

function findDefines(args: string[]) : string[] {
    const defineOptionPrefix = isMSVC(args) ? "/D" : "-D";
    return args.filter(arg => arg.startsWith(defineOptionPrefix)).map(def => def.substring(2));
}

function findCompilerPath(args: string[]) : string {
    return args[1];
}

function findCompiler(args: string[]) : string {
    return path.basename(args[1]).toLowerCase();
}

function findCompilerArgs(args: string[]) : string[] {
    const optionPrefix = isMSVC(args) ? "/" : "-";
    return args.filter(arg => arg.startsWith(optionPrefix) && 
                                !arg.startsWith(optionPrefix + "I") && 
                                !arg.startsWith(optionPrefix + "D") && 
                                !arg.startsWith(optionPrefix + "o") &&
                                !arg.startsWith(optionPrefix + "std"));
}


function findStandard(args: string[]) : SourceFileConfigurationItem["configuration"]["standard"] {
    const standardPrefix = isMSVC(args) ? "/std:" : "-std=";
    const stdArg = args.find(arg => arg.startsWith(standardPrefix));
    if(stdArg != undefined) {
        const std = stdArg.substring(5);
        switch(std){
            case "c89": return "c89"; 
            case "c99": return "c99";
            case "c11": return "c11";
            case "c17": return "c17";
            case "c++98": return "c++98";
            case "c++03": return "c++03";
            case "c++11": return "c++11";
            case "c++14": return "c++14";
            case "c++17": return "c++17";
            case "c++20": return "c++20";
            case "gnu89": return "gnu89";
            case "gnu99": return "gnu99";
            case "gnu11": return "gnu11";
            case "gnu17": return "gnu17";
            case "gnu++98": return "gnu++98";
            case "gnu++03": return "gnu++03";
            case "gnu++11": return "gnu++11";
            case "gnu++14": return "gnu++14";
            case "gnu++17": return "gnu++17";
            case "gnu++20": return "gnu++20";
            default: return "c++20";
        }
    } else {
        return "c++20";
    }
}

function findIntelliSenseMode(args: string[], platform: string, architecture: string) : SourceFileConfigurationItem["configuration"]["intelliSenseMode"] {

    const intelliArch = architecture == "x86" ? "x86" : "x64";
    const comp_arch = findCompiler(args) + "-" + intelliArch;
    switch(comp_arch) {
        case "msvc-x86": return "msvc-x86";
        case "msvc-x64": return "msvc-x64";
        case "msvc-arm": return "msvc-arm";
        case "msvc-arm64": return "msvc-arm64";
        case "gcc-x86": return "gcc-x86";
        case "gcc-x64": return "gcc-x64";
        case "gcc-arm": return "gcc-arm";
        case "gcc-arm64": return "gcc-arm64";
        case "clang-x86": return "clang-x86";
        case "clang-x64": return "clang-x64";
        case "clang-arm": return "clang-arm";
        case "clang-arm64": return "clang-arm64";
        default: return "msvc-x86";
    }
}

function pushIfNotExist(to: string[], from: string[]): void {
    from.forEach(incoming => {
        if(to.indexOf(incoming) === -1)
            to.push(incoming); 
    });
}

export class XMakeCppCustomConfigurationProvider implements CustomConfigurationProvider {

    /**
     * The friendly name of the Custom Configuration Provider extension.
     */
    readonly name: string = "XMake";

    /**
     * The id of the extension providing custom configurations. (e.g. `ms-vscode.cpptools`)
     */
    readonly extensionId: string = "xmake-vscode";

    /**
     * In memory compile_commands.json
     */
    private _sourceFileConfigurations: Map<string, SourceFileConfigurationItem>;
    private _workspaceBrowsePaths: Map<string, string[]>;
    private _workspaceCompilerArgs: Map<string, string[]>;
    private _workspaceCompiler: Map<string, string>;
    private _workspaceStandard: Map<string, SourceFileConfigurationItem["configuration"]["standard"]>;

    constructor(){
        this._sourceFileConfigurations = new Map<string, SourceFileConfigurationItem>();
        this._workspaceBrowsePaths = new Map<string, string[]>();
        this._workspaceCompilerArgs = new Map<string, string[]>();
        this._workspaceCompiler = new Map<string, string>();
        this._workspaceStandard = new Map<string, SourceFileConfigurationItem["configuration"]["standard"]>();

        vscode.workspace.workspaceFolders.forEach(folder => {
            this._workspaceBrowsePaths.set(folder.uri.fsPath, []);
            this._workspaceCompilerArgs.set(folder.uri.fsPath, []);
        });
    }

    /**
     * A request to determine whether this provider can provide IntelliSense configurations for the given document.
     * @param uri The URI of the document.
     * @param token (optional) The cancellation token.
     * @returns 'true' if this provider can provide IntelliSense configurations for the given document.
     */
    canProvideConfiguration(uri: Uri, token?: CancellationToken): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            resolve(this._sourceFileConfigurations.has(uri.fsPath));
        });
    }

    /**
     * A request to get Intellisense configurations for the given files.
     * @param uris A list of one of more URIs for the files to provide configurations for.
     * @param token (optional) The cancellation token.
     * @returns A list of [SourceFileConfigurationItem](#SourceFileConfigurationItem) for the documents that this provider
     * is able to provide IntelliSense configurations for.
     * Note: If this provider cannot provide configurations for any of the files in `uris`, the provider may omit the
     * configuration for that file in the return value. An empty array may be returned if the provider cannot provide
     * configurations for any of the files requested.
     */
    provideConfigurations(uris: Uri[], token?: CancellationToken): Thenable<SourceFileConfigurationItem[]> {
        let items : SourceFileConfigurationItem[];
        uris.forEach(uri => {
            if(this._sourceFileConfigurations.has(uri.fsPath))
                items.push(this._sourceFileConfigurations.get(uri.fsPath));
        }); 

        return new Promise((resolve, reject) => { resolve(items); });
    }

    /**
     * A request to determine whether this provider can provide a code browsing configuration for the workspace folder.
     * @param token (optional) The cancellation token.
     * @returns 'true' if this provider can provide a code browsing configuration for the workspace folder.
     */
    canProvideBrowseConfiguration(token?: CancellationToken): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            resolve(this._workspaceBrowsePaths.size > 0);
        });
    }

    /**
     * A request to get the code browsing configuration for the workspace folder.
     * @param token (optional) The cancellation token.
     * @returns A [WorkspaceBrowseConfiguration](#WorkspaceBrowseConfiguration) with the information required to
     * construct the equivalent of `browse.path` from `c_cpp_properties.json`. If there is no configuration to report, or
     * the provider indicated that it cannot provide a [WorkspaceBrowseConfiguration](#WorkspaceBrowseConfiguration)
     * then `null` should be returned.
     */
    provideBrowseConfiguration(token?: CancellationToken): Thenable<WorkspaceBrowseConfiguration> {
        const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
        return new Promise((resolve, reject) => {
            resolve({ browsePath : this._workspaceBrowsePaths.get(workspaceFolder),
                    compilerArgs : this._workspaceCompilerArgs.get(workspaceFolder),
                    compilerPath : this._workspaceCompiler.get(workspaceFolder),
                    standard : this._workspaceStandard.get(workspaceFolder)
                });
        });
    }

    /**
     * A request to determine whether this provider can provide a code browsing configuration for each folder in a multi-root workspace.
     * @param token (optional) The cancellation token.
     * @returns 'true' if this provider can provide a code browsing configuration for each folder in a multi-root workspace.
     */
    canProvideBrowseConfigurationsPerFolder(token?: CancellationToken): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            resolve(this._workspaceBrowsePaths.size > 0);
        });
    }

    /**
     * A request to get the code browsing configuration for the workspace folder.
     * @param uri The URI of the folder to provide a browse configuration for.
     * @param token (optional) The cancellation token.
     * @returns A [WorkspaceBrowseConfiguration](#WorkspaceBrowseConfiguration) with the information required to
     * construct the equivalent of `browse.path` from `c_cpp_properties.json`. If there is no configuration for this folder, or
     * the provider indicated that it cannot provide a [WorkspaceBrowseConfiguration](#WorkspaceBrowseConfiguration) per folder
     * then `null` should be returned.
     */
    provideFolderBrowseConfiguration(uri: Uri, token?: CancellationToken): Thenable<WorkspaceBrowseConfiguration> {
        if(this._workspaceBrowsePaths.has(uri.fsPath)){
            return new Promise((resolve, reject) => {
                resolve({ browsePath : this._workspaceBrowsePaths.get(uri.fsPath),
                    compilerArgs : this._workspaceCompilerArgs.get(uri.fsPath),
                    compilerPath : this._workspaceCompiler.get(uri.fsPath),
                    standard : this._workspaceStandard.get(uri.fsPath)
                });
            });
        } else {
            return new Promise((resolve, reject) => {
                resolve(null);
            })
        }
    }

    dispose() {
    }

    updateCompileCommands(compileCommands: any, platform: string, architecture: string) {

        this._sourceFileConfigurations.clear();
        this._workspaceBrowsePaths.forEach((paths) => { paths = [] });
        this._workspaceCompilerArgs.forEach((args) => { args = [] });
        this._workspaceCompiler.forEach(compiler => { compiler = undefined; })
        this._workspaceStandard.forEach(standard => { standard = undefined; });

        compileCommands.forEach(cmd => {
            // Validate the incoming command
            if(typeof(cmd.directory) == 'string' && typeof(cmd.file) == 'string' && typeof(cmd.arguments) == 'object') {
            
                const uri = path.isAbsolute(cmd.file) ? Uri.file(cmd.file) : Uri.file(path.join(cmd.directory, cmd.file));
                const includePaths = findIncludePaths(cmd.directory, cmd.arguments);
                const compilerPath = findCompilerPath(cmd.arguments);
                const compilerArgs = findCompilerArgs(cmd.arguments);
                const standard = findStandard(cmd.arguments);

                // Populate the source file configuration item

                const srcConfig : SourceFileConfigurationItem = {
                    uri: uri,
                    configuration: {
                        includePath: includePaths,
                        defines: findDefines(cmd.arguments),
                        compilerPath: compilerPath,
                        compilerArgs: compilerArgs,
                        standard: standard,
                        intelliSenseMode: findIntelliSenseMode(cmd.arguments, platform, architecture)
                    }
                };

                this._sourceFileConfigurations.set(uri.fsPath, srcConfig);

                // Populate the workspace browse configuration
                
                vscode.workspace.workspaceFolders.forEach(folder => {
                    const relativePath = path.relative(uri.fsPath, folder.uri.fsPath);
                    if(relativePath.startsWith("..") || relativePath.startsWith("."))
                    {
                        pushIfNotExist(this._workspaceBrowsePaths.get(folder.uri.fsPath), includePaths);
                        pushIfNotExist(this._workspaceCompilerArgs.get(folder.uri.fsPath), compilerArgs);
                        this._workspaceCompiler.set(folder.uri.fsPath, compilerPath);
                        this._workspaceStandard.set(folder.uri.fsPath, standard);
                    }
                });
             }
            else{
                console.error("Failed to process compile command '" + JSON.stringify(cmd) + "'");
            }
        });
    }
}