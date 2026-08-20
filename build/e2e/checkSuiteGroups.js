// Fails when the E2E shard list and the suite directories disagree.
//
// The E2E job is a matrix over a list of group names, each shard running one directory's glob. A
// directory that is missing from that list does not fail anything: nothing runs it, and the build
// goes green sooner. Same for a suite left outside a group directory. This turns both into errors.
//
// The authoritative list comes from E2E_GROUPS (set by the workflow from the same job output the
// matrix reads, so the two cannot drift). Run locally without it and the list is inferred from the
// `test:e2e:<group>` scripts instead.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const suiteDir = path.join(repoRoot, 'test', 'e2e', 'suite');
const scripts = require(path.join(repoRoot, 'package.json')).scripts;

const RESERVED_SCRIPT_SUFFIXES = ['prebuilt'];

function declaredGroups() {
    const fromEnv = process.env.E2E_GROUPS;
    if (!fromEnv) {
        return Object.keys(scripts)
            .map((name) => name.match(/^test:e2e:(.+)$/)?.[1])
            .filter((group) => group && !RESERVED_SCRIPT_SUFFIXES.includes(group));
    }

    const parsed = JSON.parse(fromEnv);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`E2E_GROUPS must be a non-empty JSON array, got: ${fromEnv}`);
    }

    return parsed;
}

const groups = declaredGroups();
const problems = [];
const entries = fs.readdirSync(suiteDir, { withFileTypes: true });

for (const file of entries.filter((entry) => entry.isFile() && entry.name.endsWith('.e2e.test.ts'))) {
    problems.push(`${file.name} sits directly in test/e2e/suite/ — move it into a group directory.`);
}

// The check this job exists for: a directory nobody shards.
for (const dir of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    if (!groups.includes(dir)) {
        problems.push(`test/e2e/suite/${dir}/ is not in the shard list [${groups.join(', ')}] — no job runs it.`);
    }
}

for (const group of groups) {
    const dir = path.join(suiteDir, group);
    if (!fs.existsSync(dir)) {
        problems.push(`Shard "${group}" has no test/e2e/suite/${group}/ directory.`);
        continue;
    }

    const suites = fs.readdirSync(dir).filter((name) => name.endsWith('.e2e.test.ts'));
    if (suites.length === 0) {
        problems.push(`Shard "${group}" contains no suites.`);
    }
    if (!scripts[`test:e2e:${group}`]) {
        problems.push(`Shard "${group}" has no "test:e2e:${group}" script in package.json.`);
    }

    console.log(`  ${group.padEnd(12)} ${suites.length} suites`);
}

if (problems.length > 0) {
    console.error('\nE2E shard list and suite directories disagree:');
    for (const problem of problems) {
        console.error(`  - ${problem}`);
    }
    process.exit(1);
}

console.log(
    `\nEvery suite directory is covered by a shard (${process.env.E2E_GROUPS ? 'E2E_GROUPS' : 'package.json'}).`
);
