// Fails when an E2E suite would not be run by any shard.
//
// The E2E job is a matrix over the directories in test/e2e/suite/, each shard running one directory's
// glob. A suite added to the wrong place — or a new group directory without a matching script and
// matrix entry — does not fail anything: it just silently never runs, which looks like a faster green
// build. This turns that into a build error.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const suiteDir = path.join(repoRoot, 'test', 'e2e', 'suite');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'e2e.yml');

const problems = [];

const entries = fs.readdirSync(suiteDir, { withFileTypes: true });

const stray = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.e2e.test.ts'));
for (const file of stray) {
    problems.push(`${file.name} sits directly in test/e2e/suite/ — move it into a group directory.`);
}

const groups = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (groups.length === 0) {
    problems.push('test/e2e/suite/ has no group directories.');
}

const scripts = require(path.join(repoRoot, 'package.json')).scripts;
const workflow = fs.readFileSync(workflowPath, 'utf8');

for (const group of groups) {
    const files = fs.readdirSync(path.join(suiteDir, group)).filter((name) => name.endsWith('.e2e.test.ts'));
    if (files.length === 0) {
        problems.push(`Group "${group}" contains no suites.`);
    }
    if (!scripts[`test:e2e:${group}`]) {
        problems.push(`Group "${group}" has no "test:e2e:${group}" script in package.json.`);
    }
    if (!workflow.includes(group)) {
        problems.push(`Group "${group}" is not named in .github/workflows/e2e.yml — no shard runs it.`);
    }
    console.log(`  ${group.padEnd(12)} ${files.length} suites`);
}

// A script without a directory would fail the shard rather than skip it, but it is still a mistake.
for (const name of Object.keys(scripts)) {
    const match = name.match(/^test:e2e:(.+)$/);
    if (match && !['prebuilt'].includes(match[1]) && !groups.includes(match[1])) {
        problems.push(`Script "${name}" has no matching directory under test/e2e/suite/.`);
    }
}

if (problems.length > 0) {
    console.error('\nE2E suite grouping is inconsistent:');
    for (const problem of problems) {
        console.error(`  - ${problem}`);
    }
    process.exit(1);
}

console.log('\nEvery E2E suite belongs to exactly one shard.');
