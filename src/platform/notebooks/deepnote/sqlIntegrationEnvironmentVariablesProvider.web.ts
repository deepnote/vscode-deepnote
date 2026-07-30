import { injectable } from 'inversify';
import { EventEmitter } from 'vscode';

import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

import { Resource } from '../../common/types';
import { DisposableBase } from '../../common/utils/lifecycle';
import { EnvironmentVariables } from '../../common/variables/types';
import { ISqlIntegrationEnvVarsProvider } from './types';

/**
 * Web stub for `ISqlIntegrationEnvVarsProvider`. Integration credentials are only resolved for locally
 * launched kernels, which web does not have, so this yields no env vars and no configs. Binding it keeps
 * the dependency non-optional for every consumer instead of making them branch on a missing provider.
 */
@injectable()
export class SqlIntegrationEnvironmentVariablesProviderWeb
    extends DisposableBase
    implements ISqlIntegrationEnvVarsProvider
{
    private readonly _onDidChangeEnvironmentVariables = this._register(new EventEmitter<Resource>());

    public readonly onDidChangeEnvironmentVariables = this._onDidChangeEnvironmentVariables.event;

    public async getEnvironmentVariables(): Promise<EnvironmentVariables> {
        return {};
    }

    /** Federated auth is node-only (no codegen is bound on web), so nothing is ever a candidate here. */
    public async getFederatedAuthCandidates(): Promise<ReadonlySet<string>> {
        return new Set();
    }

    public async getMergedIntegrationConfigs(): Promise<DatabaseIntegrationConfig[]> {
        return [];
    }
}
