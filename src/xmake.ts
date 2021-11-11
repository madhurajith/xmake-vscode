'use strict';

// imports
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {log} from './log';
import {config} from './config';
import {Terminal} from './terminal';
import {Status} from './status';
import {Option} from './option';
import {ProblemList} from './problem';
import {Debugger} from './debugger';
import {Completion} from './completion';
import {XmakeTaskProvider} from './task';
import {XMakeExplorer} from './explorer';
import * as process from './process';
import * as utils from './utils';
import {XMakeCppCustomConfigurationProvider} from './cpp_custom_configuration_provider';
import { CppToolsApi, getCppToolsApi,Version } from 'vscode-cpptools';

// the option arguments
export interface OptionArguments extends vscode.QuickPickItem {
    args: Map<string, string>;
}

// the xmake plugin
export class XMake implements vscode.Disposable {

    // the extension context
    private _context: vscode.ExtensionContext;

    // enable plugin?
    private _enabled: boolean = false;

    // option changed?
    private _optionChanged: boolean = true;

    // the problems
    private _problems: ProblemList;

    // the debugger
    private _debugger: Debugger;

    // the terminal
    private _terminal: Terminal;

    // the option
    private _option: Option;

    // the status
    private _status: Status;

    // the log file watcher
    private _logFileSystemWatcher: vscode.FileSystemWatcher;

    // the config file watcher
    private _configFileSystemWatcher: vscode.FileSystemWatcher;

    // the project file watcher
    private _projectFileSystemWatcher: vscode.FileSystemWatcher;

    // the xmake task provider
    private _xmakeTaskProvider: vscode.Disposable | undefined;

    // cpptools custom configuration provider
    private _xmakeCppCustomConfigurationProvider: XMakeCppCustomConfigurationProvider;

    // XMake explorer
    private _xmakeExplorer: XMakeExplorer;

    // the constructor
    constructor(context: vscode.ExtensionContext) {

        // save context
        this._context = context;

        // init log
        log.initialize(context);
    }

    // dispose all objects
    public async dispose() {
        await this.stop();
        if (this._terminal) {
            this._terminal.dispose();
        }
        if (this._status) {
            this._status.dispose();
        }
        if (this._option) {
            this._option.dispose();
        }
        if (this._problems) {
            this._problems.dispose();
        }
        if (this._debugger) {
            this._debugger.dispose();
        }
        if (this._logFileSystemWatcher) {
            this._logFileSystemWatcher.dispose();
        }
        if (this._configFileSystemWatcher) {
            this._configFileSystemWatcher.dispose();
        }
        if (this._projectFileSystemWatcher) {
            this._projectFileSystemWatcher.dispose();
        }
        if (this._xmakeTaskProvider) {
            this._xmakeTaskProvider.dispose();
        }
        if(this._xmakeCppCustomConfigurationProvider) {
            this.deregisterCppCustomConfigurationProvider();
            this._xmakeCppCustomConfigurationProvider.dispose();
        }
        
        if (this._xmakeExplorer) {
            this._xmakeExplorer.dispose();
        }
    }

    // load cache
    async loadCache() {

        // load config cache
        let cacheJson = {}
        let getConfigPathScript = path.join(__dirname, `../../assets/config.lua`);
        if (fs.existsSync(getConfigPathScript)) {
            let configs = (await process.iorunv("xmake", ["l", getConfigPathScript], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (configs) {
                configs = configs.split('__end__')[0].trim();
                cacheJson = JSON.parse(configs);
            }
        }

        // init platform
        const plat = ("plat" in cacheJson && cacheJson["plat"] != "")? cacheJson["plat"] : {win32: 'windows', darwin: 'macosx', linux: 'linux'}[os.platform()];
        if (plat) {
            this._option.set("plat", plat);
            this._status.plat = plat;
        }

        // init architecture
        const arch = ("arch" in cacheJson && cacheJson["arch"] != "")? cacheJson["arch"] : (plat == "windows"? "x86" : {x64: 'x86_64', x86: 'i386'}[os.arch()]);
        if (arch) {
            this._option.set("arch", arch);
            this._status.arch = arch;
        }

        // init build mode
        const mode = ("mode" in cacheJson && cacheJson["mode"] != "")? cacheJson["mode"] : "debug";
        this._option.set("mode", mode);
        this._status.mode = mode;
    }

    // update Intellisense
    async updateIntellisense() {
        log.verbose("updating Intellisense ..");

        if(fs.existsSync(path.join(config.workingDirectory, ".vscode"))) {
             fs.mkdir(path.join(config.workingDirectory, ".vscode"));
        }

        let updateIntellisenseScript = path.join(__dirname, `../../assets/update_intellisense.lua`);
        if (fs.existsSync(updateIntellisenseScript)) {
            await process.runv("xmake", ["l", updateIntellisenseScript], {"COLORTERM": "nocolor"}, config.workingDirectory);
            await this.updateCompileCommands();
        }
    }

    // init watcher
    async initWatcher() {

        // init log file system watcher
        this._logFileSystemWatcher = vscode.workspace.createFileSystemWatcher(".xmake/**/vscode-build.log");
        this._logFileSystemWatcher.onDidCreate(this.onLogFileUpdated.bind(this));
        this._logFileSystemWatcher.onDidChange(this.onLogFileUpdated.bind(this));
        this._logFileSystemWatcher.onDidDelete(this.onLogFileDeleted.bind(this));

        // init config file system watcher
        this._configFileSystemWatcher = vscode.workspace.createFileSystemWatcher(".xmake/xmake.conf");
        this._configFileSystemWatcher.onDidCreate(this.onConfigFileUpdated.bind(this));
        this._configFileSystemWatcher.onDidChange(this.onConfigFileUpdated.bind(this));

        // init project file system watcher
        this._projectFileSystemWatcher = vscode.workspace.createFileSystemWatcher("**/xmake.lua");
        this._projectFileSystemWatcher.onDidCreate(this.onProjectFileUpdated.bind(this));
        this._projectFileSystemWatcher.onDidChange(this.onProjectFileUpdated.bind(this));
    }

    // refresh folder
    async refreshFolder() {

        // wait some times
        await utils.sleep(2000);

        // refresh it
        vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    }

    // on Config File Updated
    async onConfigFileUpdated(affectedPath: vscode.Uri) {

        // trace
        log.verbose("onConfigFileUpdated: " + affectedPath.fsPath);

        // update configure cache
        let filePath = affectedPath.fsPath;
        if (filePath.includes("xmake.conf")) {
            this.loadCache();
        }
    }

    // on Project File Updated
    async onProjectFileUpdated(affectedPath: vscode.Uri) {

        // trace
        log.verbose("onProjectFileUpdated: " + affectedPath.fsPath);

        // wait some times
        await utils.sleep(2000);

        // update project cache
        let filePath = affectedPath.fsPath;
        if (filePath.includes("xmake.lua")) {
            this.loadCache();
            this.updateIntellisense();
            this._xmakeExplorer.refresh();
        }
    }

    // on Log File Updated
    async onLogFileUpdated(affectedPath: vscode.Uri) {

        // trace
        log.verbose("onLogFileUpdated: " + affectedPath.fsPath);

        // wait some times
        await utils.sleep(2000);

        // update problems
        let filePath = affectedPath.fsPath;
        if (filePath.includes("vscode-build.log")) {
            this._problems.diagnose(filePath);
        }
    }

    // on Log File Delete
    async onLogFileDeleted(affectedPath: vscode.Uri) {

        // trace
        log.verbose("onLogFileDeleted: " + affectedPath.fsPath);

        // wait some times
        await utils.sleep(2000);

        // clear problems
        let filePath = affectedPath.fsPath;
        if (filePath.includes("vscode-build.log")) {
            this._problems.clear();
        }
    }

    // start plugin
    async startPlugin() {

        // has been enabled?
        if (this._enabled) {
            return ;
        }

        // init languages
        vscode.languages.registerCompletionItemProvider("xmake", new Completion());

        // register xmake task provider
        this._xmakeTaskProvider = vscode.tasks.registerTaskProvider(XmakeTaskProvider.XmakeType, new XmakeTaskProvider(utils.getProjectRoot()));

        // explorer
        this._xmakeExplorer = new XMakeExplorer();
        await this._xmakeExplorer.init(this._context);

        // init terminal
        if (!this._terminal) {
            this._terminal = new Terminal();
        }

        // init problems
        this._problems = new ProblemList();

        // init debugger
        this._debugger = new Debugger();

        // init status
        this._status = new Status();

        // init option
        this._option = new Option();

        // load cached configure
        this.loadCache();

        // init watcher
        this.initWatcher();

        this._xmakeCppCustomConfigurationProvider = new XMakeCppCustomConfigurationProvider();
        this.updateIntellisense();
        
        // init project name
        let projectName = path.basename(utils.getProjectRoot());
        this._option.set("project", projectName);
        this._status.project = projectName;

        // enable this plugin
        this._enabled = true;
    }

    // create project
    async createProject() {

        // select language
        let getLanguagesScript = path.join(__dirname, `../../assets/languages.lua`);
        let gettemplatesScript = path.join(__dirname, `../../assets/templates.lua`);
        if (fs.existsSync(getLanguagesScript) && fs.existsSync(gettemplatesScript)) {
            let result = (await process.iorunv("xmake", ["l", getLanguagesScript], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (result) {
                let items: vscode.QuickPickItem[] = [];
                result.split("\n").forEach(element => {
                    items.push({label: element.trim(), description: ""});
                });
                const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
                if (chosen) {

                    // select template
                    let result2 = (await process.iorunv("xmake", ["l", gettemplatesScript, chosen.label], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
                    if (result2) {
                        let items2: vscode.QuickPickItem[] = [];
                        result2.split("\n").forEach(element => {
                            items2.push({label: element.trim(), description: ""});
                        });
                        const chosen2: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items2);
                        if (chosen2) {

                            // create project
                            if (!this._terminal) {
                                this._terminal = new Terminal();
                            }
                            await this._terminal.execute("create", `xmake create -t ${chosen2.label} -l ${chosen.label} -P ${config.workingDirectory}`);

                            // start plugin
                            this.startPlugin();

                            // refresh folder
                            await this.refreshFolder();
                        }
                    }
                }
            }
        }
    }

    // start xmake plugin
    async start(): Promise<void> {

        // open project directory first!
        if (!utils.getProjectRoot()) {
            if (!!(await vscode.window.showErrorMessage('no opened folder!',
                'Open a xmake project directory first!'))) {
                vscode.commands.executeCommand('vscode.openFolder');
            }
            return;
        }

        // trace
        log.verbose(`start in ${config.workingDirectory}`);

        // check xmake
        if (0 != (await process.runv("xmake", ["--version"], {"COLORTERM": "nocolor"}, config.workingDirectory)).retval) {
            if (!!(await vscode.window.showErrorMessage('xmake not found!',
                'Access https://xmake.io to download and install xmake first!'))) {
            }
            return;
        }

        // valid xmake project?
        if (!fs.existsSync(path.join(config.workingDirectory, "xmake.lua"))) {
            if (!!(await vscode.window.showErrorMessage('xmake.lua not found!',
                'Create a new xmake project'))) {
                await this.createProject();
            }
            return;
        }

        // start plugin
        this.startPlugin();
    }

    // shutdown xmake plugin
    async stop(): Promise<void> {

        // trace
        log.verbose('stop!');

        // disable this plugin
        this._enabled = false;
    }

    // on create project
    async onCreateProject(target?: string) {
        if (this._enabled) {
            this.createProject();
        }
    }

    // on new files
    async onNewFiles(target?: string) {
 
        if (!this._enabled) {
            return ;
        }

        // select files
        let getFilesListScript = path.join(__dirname, `../../assets/newfiles.lua`);
        if (fs.existsSync(getFilesListScript) && fs.existsSync(getFilesListScript)) {
            let result = (await process.iorunv("xmake", ["l", getFilesListScript], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (result) {
                let items: vscode.QuickPickItem[] = [];
                result.split("\n").forEach(element => {
                    items.push({label: element.trim(), description: ""});
                });
                const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
                if (chosen) {
                    let filesdir = path.join(__dirname, "..", "..", "assets", "newfiles", chosen.label);
                    if (fs.existsSync(filesdir)) {

                        // copy files
                        await process.runv("xmake", ["l", "os.cp", path.join(filesdir, "*"), config.workingDirectory], {"COLORTERM": "nocolor"}, config.workingDirectory);

                        // refresh folder
                        await this.refreshFolder();
                    }
                }
            }
        }
    }

    // on configure project
    async onConfigure(target?: string): Promise<boolean> {

        // this plugin enabled?
        if (!this._enabled) {
            return false;
        }

        // option changed?
        if (this._optionChanged || this._xmakeExplorer.getOptionsChanged()) {

            // get the target platform
            let plat = this._option.get<string>("plat");

            // get the target architecture
            let arch = this._option.get<string>("arch");

            // get the build mode
            let mode = this._option.get<string>("mode");

            // make command
            let command = `xmake f -p ${plat} -a ${arch} -m ${mode}`;
            if (this._option.get<string>("plat") == "android" && config.androidNDKDirectory != "") {
                command += ` --ndk=\"${config.androidNDKDirectory}\"`;
            }
            if (config.QtDirectory != "") {
                command += ` --qt=\"${config.QtDirectory}\"`;
            }
            if (config.WDKDirectory != "") {
                command += ` --wdk=\"${config.WDKDirectory}\"`;
            }
            if (config.buildDirectory != "" && config.buildDirectory != path.join(utils.getProjectRoot(), "build")) {
                command += ` -o \"${config.buildDirectory}\"`
            }
            if (config.additionalConfigArguments) {
                command += ` ${config.additionalConfigArguments}`
            }

            command += ` ${this._xmakeExplorer.getCommandOptions()}`

            // configure it
            await this._terminal.execute("config", command);

            // mark as not changed
            this._optionChanged = false;
            this._xmakeExplorer.setOptionsChanged(false);
            return true;
        }
        return false;
    }

    // on clean configure project
    async onCleanConfigure(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // make command
        let command = `xmake f -c`;
        if (config.buildDirectory != "" && config.buildDirectory != path.join(utils.getProjectRoot(), "build")) {
            command += ` -o \"${config.buildDirectory}\"`
        }
        if (config.additionalConfigArguments) {
            command += ` ${config.additionalConfigArguments}`
        }

        // configure it
        await this._terminal.execute("clean config", command);

        // mark as not changed
        this._optionChanged = false;
    }

    // on build project
    async onBuild(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // add build level to command
        const targetName = this._option.get<string>("target");
        const buildLevel = config.get<string>("buildLevel");
        let command = "xmake"
        if (targetName && targetName != "default")
            command += " build";
        if (buildLevel == "verbose")
            command += " -v";
        else if (buildLevel == "warning")
            command += " -w";
        else if (buildLevel == "debug")
            command += " -v --backtrace";

        // add build target to command
        if (targetName && targetName != "default")
            command += ` ${targetName}`;
        else if (targetName == "all")
            command += " -a";

        // configure and build it
        await this.onConfigure(target);
        await this._terminal.execute("build", command);
    }

    // on rebuild project
    async onRebuild(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // add build level to command
        const buildLevel = config.get<string>("buildLevel");
        let command = "xmake -r"
        if (buildLevel == "verbose")
            command += " -v";
        else if (buildLevel == "warning")
            command += " -w";
        else if (buildLevel == "debug")
            command += " -v --backtrace";

        // add build target to command
        const targetName = this._option.get<string>("target");
        if (targetName && targetName != "default")
            command += ` ${targetName}`;
        else if (targetName == "all")
            command += " -a";

        // configure and rebuild it
        await this.onConfigure(target);
        await this._terminal.execute("rebuild", command);
    }

    // on clean target files
    async onClean(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // get target name
        const targetName = this._option.get<string>("target");

        // make command
        let command = "xmake c";
        if (targetName && targetName != "default")
            command += ` ${targetName}`;

        // configure and clean it
        await this.onConfigure(target);
        await this._terminal.execute("clean", command);
    }

    // on clean all target files
    async onCleanAll(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // get target name
        const targetName = this._option.get<string>("target");

        // make command
        let command = "xmake c -a";
        if (targetName && targetName != "default")
            command += ` ${targetName}`;

        // configure and clean all
        await this.onConfigure(target);
        await this._terminal.execute("clean all", command);
    }

    // on run target
    async onRun(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // get target name
        let targetName = this._option.get<string>("target");
        if (!targetName) {
            let getDefaultTargetPathScript = path.join(__dirname, `../../assets/default_target.lua`);
            if (fs.existsSync(getDefaultTargetPathScript)) {
                let result = (await process.iorunv("xmake", ["l", getDefaultTargetPathScript], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
                if (result) {
                    targetName = result.split('__end__')[0].trim();
                }
            }
        }

        // get target arguments
        let args = [];
        if (targetName && targetName in config.debuggingTargetsArguments)
            args = config.debuggingTargetsArguments[targetName];
        else if ("default" in config.debuggingTargetsArguments)
            args = config.debuggingTargetsArguments["default"];

        // make command line arguments string
        let argstr = "";
        if (args.length > 0) {
            argstr = '"' + args.join('" "') + '"';
        }

        // make command
        let command = "xmake r"
        if (targetName && targetName != "default")
            command += ` ${targetName} ${argstr}`;
        else if (targetName == "all")
            command += " -a";
        else command += ` ${argstr}`;

        // configure and run it
        await this.onConfigure(target);
        await this._terminal.execute("run", command);
    }

    // on package target
    async onPackage(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // get target name
        const targetName = this._option.get<string>("target");

        // make command
        let command = "xmake p"
        if (targetName && targetName != "default")
            command += ` ${targetName}`;
        else if (targetName == "all")
            command += " -a";

        // configure and package it
        await this.onConfigure(target);
        await this._terminal.execute("package", command);
    }

    // on install target
    async onInstall(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // get target name
        const targetName = this._option.get<string>("target");

        // make command
        let command = "xmake install"
        if (targetName && targetName != "default")
            command += ` ${targetName}`;
        else if (targetName == "all")
            command += " -a";
        if (config.installDirectory != "")
            command += ` -o \"${config.installDirectory}\"`;

        // configure and install it
        await this.onConfigure(target);
        await this._terminal.execute("install", command);
    }

    // on uninstall target
    async onUninstall(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // get target name
        const targetName = this._option.get<string>("target");

        // make command
        let command = "xmake uninstall"
        if (targetName && targetName != "default")
            command += ` ${targetName}`;
        if (config.installDirectory != "")
            command += ` --installdir=\"${config.installDirectory}\"`;

        // configure and uninstall it
        await this.onConfigure(target);
        await this._terminal.execute("uninstall", command);
    }

    // on debug target
    async onDebug(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return ;
        }

        /* cpptools or codelldb externsions not found?
         *
         * @see
         * https://github.com/Microsoft/vscode-cpptools
         * https://github.com/vadimcn/vscode-lldb
         */
        var extension = null;
        if (os.platform() == "darwin" || config.debugConfigType == "codelldb") {
            extension = vscode.extensions.getExtension("vadimcn.vscode-lldb");
        }
        if (!extension) {
            extension = vscode.extensions.getExtension("ms-vscode.cpptools");
        }
        if (!extension) {

            // get target name
            const targetName = this._option.get<string>("target");

            // make command
            let command = "xmake r -d";
            if (targetName && targetName != "default")
                command += ` ${targetName}`;

            // configure and debug it
            await this.onConfigure(target);
            await this._terminal.execute("debug", command);
            return ;
        }

        // active cpptools/codelldb externsions
        if (!extension.isActive) {
            extension.activate();
        }

        // option changed?
        if (this._optionChanged) {
            await vscode.window.showErrorMessage('Configuration have been changed, please rebuild program first!');
            return ;
        }

        // get target name
        var targetName = this._option.get<string>("target");
        if (!targetName) targetName = "default";

        // get target program
        var targetProgram = null;
        let getTargetPathScript = path.join(__dirname, `../../assets/targetpath.lua`);
        if (fs.existsSync(getTargetPathScript)) {
            targetProgram = (await process.iorunv("xmake", ["l", getTargetPathScript, targetName], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (targetProgram) {
                targetProgram = targetProgram.split("__end__")[0].trim();
                targetProgram = targetProgram.split('\n')[0].trim();
            }
        }

        // get target run directory
        var targetRunDir = null;
        let getTargetRunDirScript = path.join(__dirname, `../../assets/target_rundir.lua`);
        if (fs.existsSync(getTargetRunDirScript)) {
            targetRunDir = (await process.iorunv("xmake", ["l", getTargetRunDirScript, targetName], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (targetRunDir) {
                targetRunDir = targetRunDir.split("__end__")[0].trim();
                targetRunDir = targetRunDir.split('\n')[0].trim();
            }
        }

        // get platform
        var plat = this._option.get<string>("plat");
        if (!plat) plat = "default";

        // start debugging
        if (targetProgram && fs.existsSync(targetProgram)) {
            this._debugger.startDebugging(targetName, targetProgram, targetRunDir, plat);
        } else {
            await vscode.window.showErrorMessage('The target program not found!');
        }
    }

    // on macro begin
    async onMacroBegin(target?: string) {
        if (this._enabled) {
            await this._terminal.execute("macro begin", "xmake m -b");
            this._status.startRecord();
        }
    }

    // on macro end
    async onMacroEnd(target?: string) {
        if (this._enabled) {
            await this._terminal.execute("macro end", "xmake m -e");
            this._status.stopRecord();
        }
    }

    // on macro run
    async onMacroRun(target?: string) {
        if (this._enabled) {
            await this._terminal.execute("macro run", "xmake m .");
        }
    }

    // on run last command
    async onRunLastCommand(target?: string) {
        if (this._enabled) {
            await this._terminal.execute("macro run last", "xmake m ..");
        }
    }

    // on update intellisense
    async onUpdateIntellisense(target?: string) {
        if (this._enabled) {
            await this.updateIntellisense();
        }
    }

    // set project root directory
    async setProjectRoot(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // no projects?
        if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
            return;
        }

        // select projects
        let items: vscode.QuickPickItem[] = [];
        vscode.workspace.workspaceFolders.forEach(workspaceFolder => {
            items.push({label: workspaceFolder.name, description: workspaceFolder.uri.fsPath});
        });
        const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
        if (chosen && chosen.label !== this._option.get<string>("project")) {

            // update project
            this._option.set("project", chosen.label);
            utils.setProjectRoot(chosen.description);
            this._status.project = chosen.label;
            this._optionChanged = true;

            // reload cache in new project root
            this.loadCache();
        }
    }

    // set target platform
    async setTargetPlat(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // select platform
        let items: vscode.QuickPickItem[] = [];
        items.push({label: "linux", description: "The Linux Platform"});
        items.push({label: "macosx", description: "The MacOS Platform"});
        items.push({label: "windows", description: "The Windows Platform"});
        items.push({label: "android", description: "The Android Platform"});
        items.push({label: "iphoneos", description: "The iPhoneOS Platform"});
        items.push({label: "watchos", description: "The WatchOS Platform"});
        items.push({label: "mingw", description: "The MingW Platform"});
        items.push({label: "cross", description: "The Cross Platform"});
        const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
        if (chosen && chosen.label !== this._option.get<string>("plat")) {

            // update platform
            this._option.set("plat", chosen.label);
            this._status.plat = chosen.label;
            this._optionChanged = true;

            // update architecture
            let plat = chosen.label;
            let arch = "";
            const host = {win32: 'windows', darwin: 'macosx', linux: 'linux'}[os.platform()];
            if (plat == host) {
                arch = (plat == "windows"? "x86" : {x64: 'x86_64', x86: 'i386'}[os.arch()]);
            }
            else {
                arch = {windows: "x86", macosx: "x86_64", linux: "x86_64", mingw: "x86_64", iphoneos: "arm64", watchos: "armv7k", android: "arm64-v8a"}[plat];
            }
            if (arch && arch != "") {
                this._option.set("arch", arch);
                this._status.arch = arch;
            }
        }
    }

   // set target architecture
   async setTargetArch(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // select architecture
        let items: vscode.QuickPickItem[] = [];
        let plat = this._option.get<string>("plat");

        // select files
        let getArchListScript = path.join(__dirname, `../../assets/archs.lua`);
        if (fs.existsSync(getArchListScript) && fs.existsSync(getArchListScript)) {
            let result = (await process.iorunv("xmake", ["l", getArchListScript, plat], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (result) {
                let items: vscode.QuickPickItem[] = [];
                result = result.split("__end__")[0].trim();
                result.split("\n").forEach(element => {
                    items.push({label: element.trim(), description: "The " + element.trim() + " Architecture"});
                });
                const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
                if (chosen && chosen.label !== this._option.get<string>("arch")) {
                    this._option.set("arch", chosen.label);
                    this._status.arch = chosen.label;
                    this._optionChanged = true;
                }
            }
        }
    }

    // set build mode
    async setBuildMode(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }

        // select mode
        let items: vscode.QuickPickItem[] = [];
        items.push({label: "debug", description: "The Debug Mode"});
        items.push({label: "release", description: "The Release Mode"});
        const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
        if (chosen && chosen.label !== this._option.get<string>("mode")) {
            this._option.set("mode", chosen.label);
            this._status.mode = chosen.label;
            this._optionChanged = true;
        }
    }

    // set default target
    async setDefaultTarget(target?: string) {

        // this plugin enabled?
        if (!this._enabled) {
            return
        }
    
        // get target names
        let targets = "";
        let getTargetsPathScript = path.join(__dirname, `../../assets/targets.lua`);
        if (fs.existsSync(getTargetsPathScript)) {
            targets = (await process.iorunv("xmake", ["l", getTargetsPathScript], {"COLORTERM": "nocolor"}, config.workingDirectory)).stdout.trim();
            if (targets) {
                targets = targets.split("__end__")[0].trim();
            }
        }
    
        // select target
        let items: vscode.QuickPickItem[] = [];
        items.push({label: "default", description: "All Default Targets"});
        items.push({label: "all", description: "All Targets"});
        if (targets) {
            targets.split('\n').forEach(element => {
                element = element.trim();
                if (element.length > 0)
                    items.push({label: element, description: "The Project Target: " + element});
            });
        }
        const chosen: vscode.QuickPickItem|undefined = await vscode.window.showQuickPick(items);
        if (chosen && chosen.label !== this._option.get<string>("target")) {
            this._option.set("target", chosen.label);
            this._status.target = chosen.label;
        }
    }


    async registerCppCustomConfigurationProvider() {
        let api: CppToolsApi|undefined = await getCppToolsApi(Version.v2);
        if (api) {
            if (api.notifyReady) {
                // Inform cpptools that a custom config provider will be able to service the current workspace.
                api.registerCustomConfigurationProvider(this._xmakeCppCustomConfigurationProvider);

                // Do any required setup that the provider needs.

                // Notify cpptools that the provider is ready to provide IntelliSense configurations.
                api.notifyReady(this._xmakeCppCustomConfigurationProvider);
            } else {
                // Running on a version of cpptools that doesn't support v2 yet.
                
                // Do any required setup that the provider needs.

                // Inform cpptools that a custom config provider will be able to service the current workspace.
                api.registerCustomConfigurationProvider(this._xmakeCppCustomConfigurationProvider);
                api.didChangeCustomConfiguration(this._xmakeCppCustomConfigurationProvider);
            }
        }
    }

    async deregisterCppCustomConfigurationProvider() {
        let api: CppToolsApi|undefined = await getCppToolsApi(Version.v2);
        if (api) {
            api.dispose();
        }
    }

    async updateCompileCommands() {
        // Ideally we should be able to read compile commands directly using iorunv.
        // At this point i'm not sure whether the compile commands can be written to the console without
        // changing xmake code itself.
        // For now reading compile commands from the default compile commands file inside .vscode.

        if(fs.existsSync(path.join(config.workingDirectory, ".vscode/compile_commands.json"))) {
            await fs.readFile(path.join(config.workingDirectory, ".vscode/compile_commands.json"), (err, data) => {
                this._xmakeCppCustomConfigurationProvider.updateCompileCommands(JSON.parse(data.toString()),this._status.plat, this._status.arch);
                this.deregisterCppCustomConfigurationProvider();
                this.registerCppCustomConfigurationProvider();
            });
        } 
    }
};
