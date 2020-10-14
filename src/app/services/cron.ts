// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable, NgZone } from '@angular/core';

import { CoreApp, CoreAppProvider, CoreAppSchema } from '@services/app';
import { CoreConfig } from '@services/config';
import { CoreUtils } from '@services/utils/utils';
import { CoreConstants } from '@core/constants';
import { SQLiteDB } from '@classes/sqlitedb';
import { CoreError } from '@classes/errors/error';

import { makeSingleton, Network } from '@singletons/core.singletons';
import { CoreLogger } from '@singletons/logger';

const CRON_TABLE = 'cron';

/*
 * Service to handle cron processes. The registered processes will be executed every certain time.
*/
@Injectable()
export class CoreCronDelegate {

    // Constants.
    static readonly DEFAULT_INTERVAL = 3600000; // Default interval is 1 hour.
    static readonly MIN_INTERVAL = 300000; // Minimum interval is 5 minutes.
    static readonly DESKTOP_MIN_INTERVAL = 60000; // Minimum interval in desktop is 1 minute.
    static readonly MAX_TIME_PROCESS = 120000; // Max time a process can block the queue. Defaults to 2 minutes.

    // Variables for database.
    protected tableSchema: CoreAppSchema = {
        name: 'CoreCronDelegate',
        version: 1,
        tables: [
            {
                name: CRON_TABLE,
                columns: [
                    {
                        name: 'id',
                        type: 'TEXT',
                        primaryKey: true,
                    },
                    {
                        name: 'value',
                        type: 'INTEGER',
                    },
                ],
            },
        ],
    };

    protected logger: CoreLogger;
    protected appDB: SQLiteDB;
    protected dbReady: Promise<void>; // Promise resolved when the app DB is initialized.
    protected handlers: { [s: string]: CoreCronHandler } = {};
    protected queuePromise = Promise.resolve();

    constructor(zone: NgZone) {
        this.logger = CoreLogger.getInstance('CoreCronDelegate');

        this.appDB = CoreApp.instance.getDB();
        this.dbReady = CoreApp.instance.createTablesFromSchema(this.tableSchema).catch(() => {
            // Ignore errors.
        });

        // When the app is re-connected, start network handlers that were stopped.
        Network.instance.onConnect().subscribe(() => {
            // Execute the callback in the Angular zone, so change detection doesn't stop working.
            zone.run(() => {
                this.startNetworkHandlers();
            });
        });

        // Export the sync provider so Behat tests can trigger cron tasks without waiting.
        if (CoreAppProvider.isAutomated()) {
            (<WindowForAutomatedTests> window).cronProvider = this;
        }
    }

    /**
     * Try to execute a handler. It will schedule the next execution once done.
     * If the handler cannot be executed or it fails, it will be re-executed after mmCoreCronMinInterval.
     *
     * @param name Name of the handler.
     * @param force Wether the execution is forced (manual sync).
     * @param siteId Site ID. If not defined, all sites.
     * @return Promise resolved if handler is executed successfully, rejected otherwise.
     */
    protected checkAndExecuteHandler(name: string, force?: boolean, siteId?: string): Promise<void> {
        if (!this.handlers[name] || !this.handlers[name].execute) {
            // Invalid handler.
            const message = `Cannot execute handler because is invalid: ${name}`;
            this.logger.debug(message);

            return Promise.reject(new CoreError(message));
        }

        const usesNetwork = this.handlerUsesNetwork(name);
        const isSync = !force && this.isHandlerSync(name);
        let promise;

        if (usesNetwork && !CoreApp.instance.isOnline()) {
            // Offline, stop executing.
            const message = `Cannot execute handler because device is offline: ${name}`;
            this.logger.debug(message);
            this.stopHandler(name);

            return Promise.reject(new CoreError(message));
        }

        if (isSync) {
            // Check network connection.
            promise = CoreConfig.instance.get(CoreConstants.SETTINGS_SYNC_ONLY_ON_WIFI, false)
                .then((syncOnlyOnWifi) => !syncOnlyOnWifi || CoreApp.instance.isWifi());
        } else {
            promise = Promise.resolve(true);
        }

        return promise.then((execute: boolean) => {
            if (!execute) {
                // Cannot execute in this network connection, retry soon.
                const message = `Cannot execute handler because device is using limited connection: ${name}`;
                this.logger.debug(message);
                this.scheduleNextExecution(name, CoreCronDelegate.MIN_INTERVAL);

                return Promise.reject(new CoreError(message));
            }

            // Add the execution to the queue.
            this.queuePromise = this.queuePromise.catch(() => {
                // Ignore errors in previous handlers.
            }).then(() => this.executeHandler(name, force, siteId).then(() => {
                this.logger.debug(`Execution of handler '${name}' was a success.`);

                return this.setHandlerLastExecutionTime(name, Date.now()).then(() => {
                    this.scheduleNextExecution(name);
                });
            }, (error) => {
                // Handler call failed. Retry soon.
                const message = `Execution of handler '${name}' failed.`;
                this.logger.error(message, error);
                this.scheduleNextExecution(name, CoreCronDelegate.MIN_INTERVAL);

                return Promise.reject(new CoreError(message));
            }));

            return this.queuePromise;
        });
    }

    /**
     * Run a handler, cancelling the execution if it takes more than MAX_TIME_PROCESS.
     *
     * @param name Name of the handler.
     * @param force Wether the execution is forced (manual sync).
     * @param siteId Site ID. If not defined, all sites.
     * @return Promise resolved when the handler finishes or reaches max time, rejected if it fails.
     */
    protected executeHandler(name: string, force?: boolean, siteId?: string): Promise<void> {
        return new Promise((resolve, reject): void => {
            this.logger.debug('Executing handler: ' + name);

            // Wrap the call in Promise.resolve to make sure it's a promise.
            Promise.resolve(this.handlers[name].execute(siteId, force)).then(resolve).catch(reject).finally(() => {
                clearTimeout(cancelTimeout);
            });

            const cancelTimeout = setTimeout(() => {
                // The handler took too long. Resolve because we don't want to retry soon.
                this.logger.debug(`Resolving execution of handler '${name}' because it took too long.`);
                resolve();
            }, CoreCronDelegate.MAX_TIME_PROCESS);
        });
    }

    /**
     * Force execution of synchronization cron tasks without waiting for the scheduled time.
     * Please notice that some tasks may not be executed depending on the network connection and sync settings.
     *
     * @param siteId Site ID. If not defined, all sites.
     * @return Promise resolved if all handlers are executed successfully, rejected otherwise.
     */
    async forceSyncExecution(siteId?: string): Promise<void> {
        const promises = [];

        for (const name in this.handlers) {
            if (this.isHandlerManualSync(name)) {
                // Now force the execution of the handler.
                promises.push(this.forceCronHandlerExecution(name, siteId));
            }
        }

        await CoreUtils.instance.allPromises(promises);
    }

    /**
     * Force execution of a cron tasks without waiting for the scheduled time.
     * Please notice that some tasks may not be executed depending on the network connection and sync settings.
     *
     * @param name If provided, the name of the handler.
     * @param siteId Site ID. If not defined, all sites.
     * @return Promise resolved if handler has been executed successfully, rejected otherwise.
     */
    forceCronHandlerExecution(name?: string, siteId?: string): Promise<void> {
        const handler = this.handlers[name];

        // Mark the handler as running (it might be running already).
        handler.running = true;

        // Cancel pending timeout.
        clearTimeout(handler.timeout);
        delete handler.timeout;

        // Now force the execution of the handler.
        return this.checkAndExecuteHandler(name, true, siteId);
    }

    /**
     * Get a handler's interval.
     *
     * @param name Handler's name.
     * @return Handler's interval.
     */
    protected getHandlerInterval(name: string): number {
        if (!this.handlers[name] || !this.handlers[name].getInterval) {
            // Invalid, return default.
            return CoreCronDelegate.DEFAULT_INTERVAL;
        }

        // Don't allow intervals lower than the minimum.
        const minInterval = CoreApp.instance.isDesktop() ? CoreCronDelegate.DESKTOP_MIN_INTERVAL : CoreCronDelegate.MIN_INTERVAL;
        const handlerInterval = this.handlers[name].getInterval();

        if (!handlerInterval) {
            return CoreCronDelegate.DEFAULT_INTERVAL;
        } else {
            return Math.max(minInterval, handlerInterval);
        }
    }

    /**
     * Get a handler's last execution ID.
     *
     * @param name Handler's name.
     * @return Handler's last execution ID.
     */
    protected getHandlerLastExecutionId(name: string): string {
        return 'last_execution_' + name;
    }

    /**
     * Get a handler's last execution time. If not defined, return 0.
     *
     * @param name Handler's name.
     * @return Promise resolved with the handler's last execution time.
     */
    protected async getHandlerLastExecutionTime(name: string): Promise<number> {
        await this.dbReady;

        const id = this.getHandlerLastExecutionId(name);

        try {
            const entry = await this.appDB.getRecord(CRON_TABLE, { id });
            const time = parseInt(entry.value, 10);

            return isNaN(time) ? 0 : time;
        } catch (err) {
            return 0; // Not set, return 0.
        }
    }

    /**
     * Check if a handler uses network. Defaults to true.
     *
     * @param name Handler's name.
     * @return True if handler uses network or not defined, false otherwise.
     */
    protected handlerUsesNetwork(name: string): boolean {
        if (!this.handlers[name] || !this.handlers[name].usesNetwork) {
            // Invalid, return default.
            return true;
        }

        return this.handlers[name].usesNetwork();
    }

    /**
     * Check if there is any manual sync handler registered.
     *
     * @return Whether it has at least 1 manual sync handler.
     */
    hasManualSyncHandlers(): boolean {
        for (const name in this.handlers) {
            if (this.isHandlerManualSync(name)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if there is any sync handler registered.
     *
     * @return Whether it has at least 1 sync handler.
     */
    hasSyncHandlers(): boolean {
        for (const name in this.handlers) {
            if (this.isHandlerSync(name)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if a handler can be manually synced. Defaults will use isSync instead.
     *
     * @param name Handler's name.
     * @return True if handler is a sync process and can be manually executed or not defined, false otherwise.
     */
    protected isHandlerManualSync(name: string): boolean {
        if (!this.handlers[name] || !this.handlers[name].canManualSync) {
            // Invalid, return default.
            return this.isHandlerSync(name);
        }

        return this.handlers[name].canManualSync();
    }

    /**
     * Check if a handler is a sync process. Defaults to true.
     *
     * @param name Handler's name.
     * @return True if handler is a sync process or not defined, false otherwise.
     */
    protected isHandlerSync(name: string): boolean {
        if (!this.handlers[name] || !this.handlers[name].isSync) {
            // Invalid, return default.
            return true;
        }

        return this.handlers[name].isSync();
    }

    /**
     * Register a handler to be executed every certain time.
     *
     * @param handler The handler to register.
     */
    register(handler: CoreCronHandler): void {
        if (!handler || !handler.name) {
            // Invalid handler.
            return;
        }
        if (typeof this.handlers[handler.name] != 'undefined') {
            this.logger.debug(`The cron handler '${handler.name}' is already registered.`);

            return;
        }

        this.logger.debug(`Register handler '${handler.name}' in cron.`);

        handler.running = false;
        this.handlers[handler.name] = handler;

        // Start the handler.
        this.startHandler(handler.name);
    }

    /**
     * Schedule a next execution for a handler.
     *
     * @param name Name of the handler.
     * @param time Time to the next execution. If not supplied it will be calculated using the last execution and
     *             the handler's interval. This param should be used only if it's really necessary.
     */
    protected scheduleNextExecution(name: string, time?: number): void {
        if (!this.handlers[name]) {
            // Invalid handler.
            return;
        }
        if (this.handlers[name].timeout) {
            // There's already a pending timeout.
            return;
        }

        let promise;

        if (time) {
            promise = Promise.resolve(time);
        } else {
            // Get last execution time to check when do we need to execute it.
            promise = this.getHandlerLastExecutionTime(name).then((lastExecution) => {
                const interval = this.getHandlerInterval(name);
                const nextExecution = lastExecution + interval;

                return nextExecution - Date.now();
            });
        }

        promise.then((nextExecution) => {
            this.logger.debug(`Scheduling next execution of handler '${name}' in '${nextExecution}' ms`);
            if (nextExecution < 0) {
                nextExecution = 0; // Big negative numbers aren't executed immediately.
            }

            this.handlers[name].timeout = window.setTimeout(() => {
                delete this.handlers[name].timeout;
                this.checkAndExecuteHandler(name).catch(() => {
                    // Ignore errors.
                });
            }, nextExecution);
        });
    }

    /**
     * Set a handler's last execution time.
     *
     * @param name Handler's name.
     * @param time Time to set.
     * @return Promise resolved when the execution time is saved.
     */
    protected async setHandlerLastExecutionTime(name: string, time: number): Promise<void> {
        await this.dbReady;

        const id = this.getHandlerLastExecutionId(name);
        const entry = {
            id,
            value: time,
        };

        await this.appDB.insertRecord(CRON_TABLE, entry);
    }

    /**
     * Start running a handler periodically.
     *
     * @param name Name of the handler.
     */
    protected startHandler(name: string): void {
        if (!this.handlers[name]) {
            // Invalid handler.
            this.logger.debug(`Cannot start handler '${name}', is invalid.`);

            return;
        }

        if (this.handlers[name].running) {
            this.logger.debug(`Handler '${name}', is already running.`);

            return;
        }

        this.handlers[name].running = true;

        this.scheduleNextExecution(name);
    }

    /**
     * Start running periodically the handlers that use network.
     */
    startNetworkHandlers(): void {
        for (const name in this.handlers) {
            if (this.handlerUsesNetwork(name)) {
                this.startHandler(name);
            }
        }
    }

    /**
     * Stop running a handler periodically.
     *
     * @param name Name of the handler.
     */
    protected stopHandler(name: string): void {
        if (!this.handlers[name]) {
            // Invalid handler.
            this.logger.debug(`Cannot stop handler '${name}', is invalid.`);

            return;
        }

        if (!this.handlers[name].running) {
            this.logger.debug(`Cannot stop handler '${name}', it's not running.`);

            return;
        }

        this.handlers[name].running = false;
        clearTimeout(this.handlers[name].timeout);
        delete this.handlers[name].timeout;
    }

}

export class CoreCron extends makeSingleton(CoreCronDelegate) {}


/**
 * Interface that all cron handlers must implement.
 */
export interface CoreCronHandler {
    /**
     * A name to identify the handler.
     */
    name: string;

    /**
     * Whether the handler is running. Used internally by the provider, there's no need to set it.
     */
    running?: boolean;

    /**
     * Timeout ID for the handler scheduling. Used internally by the provider, there's no need to set it.
     */
    timeout?: number;

    /**
     * Returns handler's interval in milliseconds. Defaults to CoreCronDelegate.DEFAULT_INTERVAL.
     *
     * @return Interval time (in milliseconds).
     */
    getInterval?(): number;

    /**
     * Check whether the process uses network or not. True if not defined.
     *
     * @return Whether the process uses network or not
     */
    usesNetwork?(): boolean;

    /**
     * Check whether it's a synchronization process or not. True if not defined.
     *
     * @return Whether it's a synchronization process or not.
     */
    isSync?(): boolean;

    /**
     * Check whether the sync can be executed manually. Call isSync if not defined.
     *
     * @return Whether the sync can be executed manually.
     */
    canManualSync?(): boolean;

    /**
     * Execute the process.
     *
     * @param siteId ID of the site affected. If not defined, all sites.
     * @param force Determines if it's a forced execution.
     * @return Promise resolved when done. If the promise is rejected, this function will be called again often,
     *         it shouldn't be abused.
     */
    execute?(siteId?: string, force?: boolean): Promise<void>;
}

/**
 * Extended window type for automated tests.
 */
export type WindowForAutomatedTests = Window & {
    cronProvider?: CoreCronDelegate;
};
