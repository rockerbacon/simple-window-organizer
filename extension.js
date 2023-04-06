// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-
// Start apps on custom workspaces
/* exported init enable disable */

const {Shell} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

const WORKSPACE_ACTIVATION_SUSPENSION_TRIGGER = 1000;
const WORKSPACE_ACTIVATION_SUSPENSION_TIMEOUT = 2000;

class WindowMover {
    constructor() {
        this._settings = ExtensionUtils.getSettings();
        this._appSystem = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._appSettings = {};
        this._appState = {};

        this._readAppSettings();

        this._lastStartedApp = null;
        this._lastAppStart = 0;
        this._suspendWorkspaceActivationUntil = 0;

        this._saveAppSettingsTimeout = null;

        this._appsStateChangedId =
            this._appSystem.connect('app-state-changed',
                this._appStateChanged.bind(this));

        this._workspaceTrackers = {};

        this._workspaceAddedId =
            global.workspace_manager.connect(
                'workspace-added',
                this._trackWorkspaceWindows.bind(this)
            );

        this._workspaceRemovedId =
            global.workspace_manager.connect(
                'workspace-removed',
                this._untrackWorkspaceWindows.bind(this)
            );

        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            this._trackWorkspaceWindows(global.workspace_manager, i);
        }
    }

    _trackWorkspaceWindows(workspaceManager, workspaceIndex) {
        if (this._workspaceTrackers[workspaceIndex]) {
            return;
        }

        const workspace = workspaceManager.get_workspace_by_index(workspaceIndex);
        this._workspaceTrackers[workspaceIndex] =
            workspace.connect(
                'window-added',
                this._registerWindowAddedToWorkspace.bind(this)
            );
    }

    _untrackWorkspaceWindows(workspaceManager, workspaceIndex) {
        const tracker = this._workspaceTrackers[workspaceIndex];
        if (!tracker) {
            return;
        }

        const workspace = workspaceManager.get_workspace_by_index(workspaceIndex);
        if (workspace) {
            workspace.disconnect(tracker);
        }

        delete this._workspaceTrackers[workspaceIndex];
    }

    _readAppSettings() {
        const settingsValue = this._settings.get_string('application-settings');

        this._appSettings = JSON.parse(settingsValue);
    }

    _getPreviousAppState(app) {
        let state = this._appState[app.id];

        if (!state) {
            state = {
                app,
                state: Shell.AppState.STOPPED,
                windowsChangedId: app.connect('windows-changed',
                    this._appWindowsChanged.bind(this)),
            }
            this._appState[app.id] = state;
        }

        return state;
    }

    _disconnectAppEvents() {
        for (const [id, state] of Object.entries(this._appState)) {
            if (state.windowsChangedId) {
                state.app.disconnect(state.windowsChangedId);
            }
        }
    }

    destroy() {
        if (this._appsChangedId) {
            this._appSystem.disconnect(this._appsChangedId);
            this._appsChangedId = 0;
        }

        if (this._appsStateChangedId) {
            this._appSystem.disconnect(this._appsStateChangedId);
            this._appsStateChangedId = 0;
        }

        if (this._saveAppSettingsTimeout) {
            this._saveAppSettingsTimeout.destroy();
            this._saveAppSettings();
        }

        if (this._settings) {
            this._settings.run_dispose();
            this._settings = null;
        }

        for (const workspaceIndex of Object.keys(this._workspaceTrackers)) {
            this._untrackWorkspaceWindows(global.workspace_manager, workspaceIndex);
        }
        this._workspaceTrackers = {};

        this._disconnectAppEvents();
        this._appSettings = {};
        this._appState = {};
    }

    _appStateChanged(appSystem, app) {
        let previousState = this._getPreviousAppState(app);

        if (
            previousState.state === Shell.AppState.STOPPED &&
            app.state !== Shell.AppState.STOPPED &&
            this._lastStartedApp !== app
        ) {
            this._lastStartedApp = app;

            let appStartInterval = Date.now() - this._lastAppStart;
            this._lastAppStart = Date.now();

            if (appStartInterval < WORKSPACE_ACTIVATION_SUSPENSION_TRIGGER) {
                    this._suspendWorkspaceActivationUntil =
                        Date.now() + WORKSPACE_ACTIVATION_SUSPENSION_TIMEOUT;
            }
        }

        previousState.state = app.state;
    }

    _activateWorkspace(workspaceNum) {
        let workspaceManager = global.workspace_manager;
        let metaWorkspace = workspaceManager.get_workspace_by_index(workspaceNum);
        metaWorkspace.activate(global.get_current_time());
    }

    _ensureWorkspaceExists(window, workspaceNum) {
        const lastWorkspace = global.workspace_manager.get_n_workspaces();

        for (let i = lastWorkspace; i <= workspaceNum; i++) {
            window.change_workspace_by_index(i - 1, false);
            global.workspaceManager.append_new_workspace(false, 0);
        }
    }

    _moveWindow(window, workspaceNum, app) {
        log(JSON.stringify({
            action: 'SWO - MOVE WINDOW',
            app: app.id,
            workspace: workspaceNum,
        }));

        this._ensureWorkspaceExists(window, workspaceNum);
        window.change_workspace_by_index(workspaceNum, false);
    }

    _getAppSettings(app) {
        let settings = this._appSettings[app.id];

        if (!settings) {
            settings = {
                workspaceNum: global.workspace_manager.get_active_workspace_index(),
            }

            this._appSettings[app.id] = settings;
        }

        return settings;
    }

    _saveAppSettings() {
        this._settings.set_string(
            'application-settings',
            JSON.stringify(this._appSettings)
        );

        if (this._saveAppSettingsTimeout) {
            this._saveAppSettingsTimeout = null;
        }
    }

    _scheduleSaveAppSettings() {
        if (this._saveAppSettingsTimeout) {
            return;
        }

        this._saveAppSettingsTimeout = setTimeout(
            this._saveAppSettings.bind(this),
            60000
        );
    }

    _modifyAppWorkspaceNum(app, workspaceNum) {
        log(JSON.stringify({
            action: 'SWO -  SET APP WORKSPACE',
            app: app.id,
            workspace: workspaceNum,
        }));
        const settings = this._getAppSettings(app);
        settings.workspaceNum = workspaceNum;

        this._scheduleSaveAppSettings();
    }

    _registerWindowAddedToWorkspace(workspace, window) {
        const app = this._windowTracker.get_window_app(window);
        if (!app) {
            return;
        }

        this._modifyAppWorkspaceNum(app, workspace.index());
    }

    _checkRequiresOrganization(windows, settings) {
        return (
            windows.some(w => w.get_workspace().index() !== settings.workspaceNum) &&
            windows.every(w => !w.skip_taskbar) &&
            windows.every(w => !w.is_on_all_workspaces())
        );
    }

    _appWindowsChanged(app) {
        const windows = app.get_windows();
        const settings = this._getAppSettings(app);

        if (
            !this._checkRequiresOrganization(windows, settings)
        ) {
            return;
        }

        for (const window of windows) {
            this._moveWindow(window, settings.workspaceNum, app);
        }

        if (
            Date.now() > this._suspendWorkspaceActivationUntil
        ) {
            this._activateWorkspace(settings.workspaceNum);
        }
    }
}

let winMover;

/** */
function init() {
}

/** */
function enable() {
    winMover = new WindowMover();
}

/** */
function disable() {
    winMover.destroy();
}
