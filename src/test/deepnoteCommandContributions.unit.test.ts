import { expect } from 'chai';
import * as fs from 'fs';
import * as path from '../platform/vscode-path/path';
import { EXTENSION_ROOT_DIR_FOR_TESTS } from './constants.node';

interface CommandContribution {
    command: string;
    enablement?: string;
}

interface MenuContribution {
    command: string;
    when?: string;
}

const DEEPNOTE_NOTEBOOK_CLAUSE = "notebookType == 'deepnote'";
const CAN_RESTART_CLAUSE = 'deepnote.notebookeditor.canrestartNotebookkernel';
const RESTART_COMMANDS = [
    'deepnote.restartkernel',
    'deepnote.restartkernelandrunallcells',
    'deepnote.restartkernelandrunuptoselectedcell'
];

/**
 * Guards the contribution points that gate Deepnote notebook commands. These are plain JSON, so nothing
 * else type-checks them: a new add-block command that forgets its `enablement` would silently reappear in
 * the palette for `.ipynb` files (#467), and the restart entries would silently stop reaching Deepnote
 * notebooks again (#471).
 */
suite('Deepnote command contributions (package.json)', () => {
    let commandsById: Map<string, CommandContribution>;
    let menus: Record<string, MenuContribution[]>;

    suiteSetup(() => {
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'package.json')).toString()
        );
        commandsById = new Map(
            (packageJson.contributes.commands as CommandContribution[]).map((command) => [command.command, command])
        );
        menus = packageJson.contributes.menus;
    });

    test('every add-block command is enabled only for Deepnote notebooks', () => {
        const addBlockCommands = [...commandsById.values()].filter((command) =>
            /^deepnote\.add\w*Block\w*$/.test(command.command)
        );
        const ungated = addBlockCommands
            .filter((command) => command.enablement !== DEEPNOTE_NOTEBOOK_CLAUSE)
            .map((command) => command.command);

        expect(addBlockCommands.length).to.be.at.least(19, 'the add-block sweep should still cover every block type');
        expect(ungated).to.deep.equal([], `add-block commands must carry enablement "${DEEPNOTE_NOTEBOOK_CLAUSE}"`);
    });

    test('add-block toolbar entries stay scoped to Deepnote notebooks', () => {
        const entries = menus['notebook/toolbar'].filter((entry) => /^deepnote\.add\w*Block\w*$/.test(entry.command));

        expect(entries.length).to.be.at.least(1);
        for (const entry of entries) {
            expect(entry.when, entry.command).to.equal(DEEPNOTE_NOTEBOOK_CLAUSE);
        }
    });

    for (const commandId of RESTART_COMMANDS) {
        test(`${commandId} can be enabled on a Deepnote notebook with a restartable kernel`, () => {
            const enablement = commandsById.get(commandId)?.enablement ?? '';

            expect(enablement).to.include(`(${DEEPNOTE_NOTEBOOK_CLAUSE} && ${CAN_RESTART_CLAUSE})`);
        });
    }

    test('Restart Kernel is surfaced in the notebook toolbar for Deepnote notebooks', () => {
        const entry = menus['notebook/toolbar'].find(
            (entry) => entry.command === 'deepnote.restartkernel' && entry.when?.includes(DEEPNOTE_NOTEBOOK_CLAUSE)
        );

        expect(entry, 'notebook/toolbar needs a deepnote.restartkernel entry for Deepnote notebooks').to.not.be
            .undefined;
        expect(entry?.when).to.not.include("notebookType == 'jupyter-notebook'");
    });

    test('Restart Kernel is surfaced in the editor title for Deepnote notebooks when the global toolbar is off', () => {
        const entry = menus['editor/title'].find(
            (entry) => entry.command === 'deepnote.restartkernel' && entry.when?.includes(DEEPNOTE_NOTEBOOK_CLAUSE)
        );

        expect(entry?.when).to.include(CAN_RESTART_CLAUSE);
        expect(entry?.when).to.include('config.notebook.globalToolbar != true');
    });
});
