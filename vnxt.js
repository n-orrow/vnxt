#!/usr/bin/env node

const {execSync, execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

const args = process.argv.slice(2);
let quietMode = false;

function log(message, color = '') {
    if (quietMode) return;
    if (color && colors[color] && config.colors) {
        console.log(`${colors[color]}${message}${colors.reset}`);
    } else {
        console.log(message);
    }
}

function logError(message) {
    if (config.colors) {
        console.error(`${colors.red}${message}${colors.reset}`);
    } else {
        console.error(message);
    }
}

function getFlag(flag, short) {
    const index = args.indexOf(flag) !== -1 ? args.indexOf(flag) : args.indexOf(short);
    if (index === -1) return null;
    return args[index + 1] || true;
}

function hasFlag(flag, short) {
    return args.includes(flag) || (short ? args.includes(short) : false);
}

function loadConfig() {
    const defaults = {
        autoChangelog: true,
        defaultType: 'patch',
        requireCleanWorkingDir: false,
        autoPush: true,
        workspaceAutoPush: false,
        defaultStageMode: 'tracked',
        tagPrefix: 'v',
        colors: true
    };

    if (fs.existsSync('.vnxtrc.json')) {
        const userConfig = JSON.parse(fs.readFileSync('.vnxtrc.json', 'utf8'));
        return {...defaults, ...userConfig};
    }

    return defaults;
}

let config = { colors: true };

// Moves into the repo root so relative paths resolve from there
function enterRepoRoot() {
    const startDir = process.cwd();

    let cdup;
    try {
        cdup = execFileSync('git', ['rev-parse', '--show-cdup'], {stdio: 'pipe'}).toString().trim();
    } catch {
        return { moved: false, startDir, depth: 0 };
    }
    if (!cdup) return { moved: false, startDir, depth: 0 };

    process.chdir(path.resolve(cdup));
    return { moved: true, startDir, depth: cdup.split('/').filter(Boolean).length };
}

function readJsonIfExists(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

function declaresWorkspaces(pkg) {
    return Array.isArray(pkg.workspaces) || (!!pkg.workspaces && Array.isArray(pkg.workspaces.packages));
}

// In a plain repo, started below the root, vnxt can only act on the root package
function refuseAmbiguousSubfolder(location) {
    if (!location.moved) return;

    let dir = location.startDir;
    for (let i = 0; i < location.depth; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            logError(`❌ Found a package.json in ${dir}, below the repo root.`);
            logError('   vnxt cannot yet version nested packages, and will not bump the root by mistake.');
            logError('   Run it from the repo root if the root package is the one you mean.');
            process.exit(1);
        }
        dir = path.dirname(dir);
    }
}

class UserError extends Error {}

function toPosix(p) {
    return p.replace(/\\/g, '/');
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turns one entry of the workspaces field into folder names relative to the root
function expandWorkspacePattern(root, pattern) {
    const clean = toPosix(pattern).replace(/^\.\//, '').replace(/\/+$/, '');
    const segments = clean.split('/');
    const last = segments[segments.length - 1];
    const parents = segments.slice(0, -1);

    const unsupported = clean.startsWith('!')
        || /[?[\]{}()]/.test(clean)
        || clean.includes('**')
        || parents.some(segment => segment.includes('*'));
    if (unsupported) {
        throw new UserError(`Workspace pattern '${pattern}' is not supported yet. Use plain folders or a * in the last part (apps/*).`);
    }

    if (!last.includes('*')) return [clean];

    const matcher = new RegExp('^' + last.split('*').map(escapeRegExp).join('[^/]*') + '$');
    const parent = parents.join('/');

    let entries;
    try {
        entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.') && matcher.test(e.name))
        .map(e => (parent ? `${parent}/${e.name}` : e.name));
}

// Lists the workspaces the root package.json declares, as they exist on disk
function readWorkspaces(root, rootPackage) {
    const pkg = rootPackage || readJsonIfExists(path.join(root, 'package.json'));
    if (!pkg || !declaresWorkspaces(pkg)) return [];

    const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages;
    const dirs = [];
    for (const pattern of patterns) {
        for (const dir of expandWorkspacePattern(root, pattern)) {
            if (!dirs.includes(dir)) dirs.push(dir);
        }
    }

    const found = [];
    for (const dir of dirs.sort()) {
        const manifestPath = path.join(root, dir, 'package.json');
        if (!fs.existsSync(manifestPath)) continue;

        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
        } catch (err) {
            throw new UserError(`Could not read ${dir}/package.json: ${err.message}`);
        }

        found.push({
            name: manifest.name || path.basename(dir),
            dir,
            abs: path.join(root, dir),
            version: manifest.version,
            private: manifest.private === true
        });
    }

    const seen = {};
    for (const ws of found) {
        if (seen[ws.name]) {
            throw new UserError(`Two workspaces are called '${ws.name}': ${seen[ws.name]} and ${ws.dir}.`);
        }
        seen[ws.name] = ws.dir;
    }

    return found;
}

// Accepts values from repeated flags and comma lists: ['a,b', 'c'] gives ['a', 'b', 'c']
function parseSelectors(values) {
    const list = [];
    for (const value of [].concat(values || [])) {
        for (const part of String(value).split(',')) {
            const item = part.trim();
            if (item && !list.includes(item)) list.push(item);
        }
    }
    return list;
}

// Collects every -w / --workspace value from argv
function collectWorkspaceSelectors(argv) {
    const values = [];

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (token.startsWith('--workspace=')) {
            const value = token.slice('--workspace='.length);
            if (!value) throw new UserError('--workspace= needs a workspace name or folder.');
            values.push(value);
            continue;
        }

        if (token !== '-w' && token !== '--workspace') continue;

        const before = values.length;
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
            values.push(argv[++i]);
        }
        if (values.length === before) {
            throw new UserError(`${token} needs a workspace name or folder, for example: ${token} apps/app-one`);
        }
    }

    return parseSelectors(values);
}

function describeWorkspaces(workspaces) {
    return workspaces.map(ws => `${ws.name} (${ws.dir})`).join(', ');
}

// A selector is a package name or a folder
function resolveSelector(selector, { root, startDir, workspaces, rootName }) {
    const rootError = () => new UserError(
        `'${selector}' is the repo root, which vnxt does not version. Choose a workspace: ${describeWorkspaces(workspaces)}.`
    );

    const cleaned = toPosix(selector).replace(/\/+$/, '') || '/';
    if (cleaned === '.' || (rootName && selector === rootName)) throw rootError();

    const byName = workspaces.find(ws => ws.name === selector);
    if (byName) return byName;

    for (const base of [startDir, root]) {
        const rel = toPosix(path.relative(root, path.resolve(base, cleaned)));
        if (rel === '') throw rootError();

        const hit = workspaces.find(ws => ws.dir === rel);
        if (hit) return hit;

        const inside = workspaces.filter(ws => ws.dir.startsWith(`${rel}/`));
        if (inside.length) {
            throw new UserError(`'${selector}' holds several workspaces (${inside.map(ws => ws.name).join(', ')}). Name the one you want.`);
        }
    }

    throw new UserError(`No workspace matches '${selector}'. Available: ${describeWorkspaces(workspaces)}.`);
}

// The workspace whose folder contains startDir, or null
function inferTarget(startDir, root, workspaces) {
    let rel = toPosix(path.relative(root, startDir));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;

    for (;;) {
        const hit = workspaces.find(ws => ws.dir === rel);
        if (hit) return hit;

        const cut = rel.lastIndexOf('/');
        if (cut === -1) return null;
        rel = rel.slice(0, cut);
    }
}

// Decides which workspaces a command means
function resolveTargets({ root, startDir, selectors }) {
    const rootPackage = readJsonIfExists(path.join(root, 'package.json'));
    const wanted = parseSelectors(selectors);

    if (!rootPackage || !declaresWorkspaces(rootPackage)) {
        if (wanted.length) throw new UserError('-w needs a repo whose root package.json declares workspaces.');
        return null;
    }

    const workspaces = readWorkspaces(root, rootPackage);
    if (!workspaces.length) {
        throw new UserError('The root package.json declares workspaces, but none of them were found on disk.');
    }

    if (wanted.length) {
        const context = { root, startDir, workspaces, rootName: rootPackage.name };
        const targets = [];
        for (const selector of wanted) {
            const ws = resolveSelector(selector, context);
            if (!targets.includes(ws)) targets.push(ws);
        }
        return targets;
    }

    const inferred = inferTarget(startDir, root, workspaces);
    if (inferred) return [inferred];

    throw new UserError(`Run vnxt from inside a workspace folder, or choose one with -w. Workspaces: ${describeWorkspaces(workspaces)}.`);
}

const LOCKFILE = 'package-lock.json';

function gitOut(args) {
    return execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}

function gitList(args) {
    return gitOut(args).split('\0').filter(Boolean);
}

function uniqueSorted(list) {
    return [...new Set(list)].sort();
}

// Sets the version in a workspace's own lockfile entry and touches nothing else
function setLockfileVersion(text, dir, version) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = (text.match(/^([ \t]+)"/m) || [])[1] || 2;
    const write = lock => JSON.stringify(lock, null, indent).replace(/\n/g, newline) + (text.endsWith(newline) ? newline : '');

    let lock;
    try {
        lock = JSON.parse(text);
    } catch (err) {
        throw new UserError(`${LOCKFILE} is not valid JSON: ${err.message}`);
    }
    if (write(lock) !== text) {
        throw new UserError(`${LOCKFILE} is formatted in a way vnxt cannot edit safely. Run npm install, commit it, then run vnxt again.`);
    }

    const entry = lock.packages && lock.packages[dir];
    if (!entry) return text;

    if ('version' in entry) entry.version = version;
    else lock.packages[dir] = { version, ...entry };

    return write(lock);
}

// npm rewrites a manifest in its own layout (LF, final newline)
function matchLayout(original, updated) {
    if (original === null || original === undefined) return updated;
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const body = updated.replace(/(\r?\n)+$/, '').replace(/\r\n/g, '\n').replace(/\n/g, eol);
    return /(\r?\n)$/.test(original) ? body + eol : body;
}

function snapshotFiles(files) {
    const snapshot = {};
    for (const file of files) {
        snapshot[file] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    }
    return snapshot;
}

// Puts files back as they were, and takes them out of the index again
function restoreFiles(snapshot) {
    for (const [file, content] of Object.entries(snapshot)) {
        if (content === null) fs.rmSync(file, {force: true});
        else fs.writeFileSync(file, content);

        try {
            execFileSync('git', ['reset', '-q', '--', file], {stdio: 'pipe'});
        } catch {
        }
    }
}

function quoteForDisplay(arg) {
    return /^[\w./@:=+,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

// The git steps of a real run, as data, so the dry run can print them
function buildCommitPlan(ws, opts, hasLockfile) {
    const lock = hasLockfile ? [LOCKFILE] : [];
    const keep = [ws.dir, ...lock];
    const versionFiles = [`${ws.dir}/package.json`, ...(opts.generateChangelog ? [`${ws.dir}/CHANGELOG.md`] : []), ...lock];

    const picking = opts.addMode === 'patch' || opts.addMode === 'interactive';
    const pick = picking ? ['add', opts.addMode === 'patch' ? '-p' : '-i', '--', ws.dir] : null;

    const stage = [];
    if (opts.addMode === 'all') stage.push(['add', '-A', '--', ws.dir]);
    if (opts.addMode === 'tracked') stage.push(['add', '-u', '--', ws.dir]);
    stage.push(['add', '--', ...versionFiles]);

    return {
        pick,
        stage,
        resetOthers: ['reset', '-q', '--', '.', ...keep.map(p => `:(exclude,literal)${p}`)],
        commit: ['commit', '-m', opts.message],
        resetKept: ['reset', '-q', '--', ...keep]
    };
}

function makeTemporaryIndex() {
    const realIndex = path.resolve(gitOut(['rev-parse', '--git-path', 'index']).trim());
    const tempIndex = `${realIndex}.vnxt-${process.pid}`;
    fs.copyFileSync(realIndex, tempIndex);
    return tempIndex;
}

function removeTemporaryIndex(tempIndex) {
    if (!tempIndex) return;
    fs.rmSync(tempIndex, {force: true});
    fs.rmSync(`${tempIndex}.lock`, {force: true});
}

// Lets the person choose what goes into the commit, using a copy of the index
function pickChanges(ws, plan) {
    const tempIndex = makeTemporaryIndex();
    const env = {...process.env, GIT_INDEX_FILE: tempIndex};
    try {
        log(`\n🧩 Choose the changes to commit in ${ws.dir} (git ${plan.pick.slice(0, 2).join(' ')})...`, 'cyan');
        if (plan.pick[1] === '-p') {
            log('   y  stage this hunk        n  skip this hunk        q  quit, staging nothing more', 'gray');
            log('   s  split into smaller hunks        ?  git\'s full help', 'gray');
        } else {
            log('   Choose a command by number or name: \'patch\' picks hunks, \'quit\' finishes.', 'gray');
            log('   A blank line ends a file selection.        ?  git\'s full help', 'gray');
        }
        log('   Choosing nothing stops the run and changes nothing.', 'gray');
        try {
            execFileSync('git', plan.pick, {env, stdio: 'inherit'});
        } catch (err) {
            throw new UserError(`Git could not run the change selection (${err.message}). Nothing was changed.`);
        }

        const chosen = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--', ws.dir], {env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
            .split('\0').filter(Boolean);
        if (!chosen.length) {
            throw new UserError(`You have not selected any changes in ${ws.dir}, so nothing was committed and nothing was changed. Select at least one change, or use -a tracked to commit everything tracked.`);
        }
        return tempIndex;
    } catch (err) {
        removeTemporaryIndex(tempIndex);
        throw err;
    }
}

// Commits from a temporary copy of the index
function commitWithTemporaryIndex(plan, quiet, preparedIndex = null) {
    const tempIndex = preparedIndex || makeTemporaryIndex();
    const env = {...process.env, GIT_INDEX_FILE: tempIndex};

    try {
        execFileSync('git', plan.resetOthers, {env, stdio: 'pipe'});
        execFileSync('git', plan.commit, {env, stdio: quiet ? 'pipe' : 'inherit'});
    } finally {
        removeTemporaryIndex(tempIndex);
    }
}

// Tag name <name>@<version>, with the leading @ of a scope dropped
function workspaceTagName(ws, version) {
    return `${ws.name.replace(/^@/, '')}@${version}`;
}

function isValidTagName(tag) {
    try {
        gitOut(['check-ref-format', `refs/tags/${tag}`]);
        return true;
    } catch {
        return false;
    }
}

function tagExists(tag) {
    try {
        gitOut(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
        return true;
    } catch {
        return false;
    }
}

function hasOrigin() {
    try {
        gitOut(['remote', 'get-url', 'origin']);
        return true;
    } catch {
        return false;
    }
}

function hasUpstream() {
    try {
        gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        return true;
    } catch {
        return false;
    }
}

// A merge, rebase, cherry-pick or revert that is part way through
function operationInProgress() {
    const markers = [
        ['MERGE_HEAD', 'merge'],
        ['rebase-merge', 'rebase'],
        ['rebase-apply', 'rebase'],
        ['CHERRY_PICK_HEAD', 'cherry-pick'],
        ['REVERT_HEAD', 'revert']
    ];
    for (const [name, label] of markers) {
        try {
            if (fs.existsSync(gitOut(['rev-parse', '--git-path', name]).trim())) return label;
        } catch {
        }
    }
    return null;
}

// The most recent tag made for this workspace, or null when it has never been released
function lastWorkspaceTag(ws) {
    const prefix = ws.name.replace(/^@/, '');
    try {
        return gitOut(['tag', '--list', `${prefix}@*`, '--sort=-version:refname']).split('\n').map(t => t.trim()).filter(Boolean)[0] || null;
    } catch {
        return null;
    }
}

// True when nothing the next commit would contain differs from the workspace's last tag
function unchangedSince(ws, tag, opts) {
    const differs = args => {
        try {
            execFileSync('git', ['diff', '--quiet', ...args, tag, '--', ws.dir], {stdio: 'pipe'});
            return false;
        } catch {
            return true;
        }
    };
    const mode = opts.addMode || null;

    if (!mode) return !differs(['--cached']);
    if (differs([])) return false;
    if ((mode === 'all' || mode === 'interactive') && gitList(['ls-files', '-o', '--exclude-standard', '-z', '--', ws.dir]).length) return false;
    return true;
}

// Summarises changes since the last tag, for the listing
function changesSince(ws, tag) {
    if (!unchangedSince(ws, tag, {addMode: null})) return 'changed since tag';
    if (!unchangedSince(ws, tag, {addMode: 'all'})) return 'unstaged changes only';
    return 'none since tag';
}

// Reasons a real run would stop before changing anything
function workspaceProblems(ws, opts = {}) {
    const problems = [];
    let detachedReported = false;

    try {
        gitOut(['rev-parse', '--verify', '-q', 'HEAD']);
    } catch {
        problems.push('This repo has no commits yet. Make a first commit before using workspace mode.');
    }

    if (opts.push) {
        if (!hasOrigin()) {
            problems.push('No remote repository (origin) is configured, so vnxt cannot push. Add one, or use -dnp to commit without pushing.');
        } else if (!gitOut(['branch', '--show-current']).trim()) {
            detachedReported = true;
            problems.push('HEAD is detached, so there is no branch to push. Switch to a branch, or use -dnp to commit without pushing.');
        } else if (!hasUpstream()) {
            problems.push('This branch has no upstream yet. Run git push -u origin <branch> once, or use -dnp to commit without pushing.');
        }
    }

    if (!detachedReported && !gitOut(['branch', '--show-current']).trim()) {
        problems.push('HEAD is detached, so a release commit now would not be on any branch and is easy to lose. Switch to a branch first.');
    }

    const busy = operationInProgress();
    if (busy) {
        problems.push(`A ${busy} is in progress. Finish or abort it before making a release commit.`);
    }

    if (!opts.customVersion) {
        const last = lastWorkspaceTag(ws);
        if (last && unchangedSince(ws, last, opts)) {
            const unstaged = !opts.addMode && !unchangedSince(ws, last, {addMode: 'all'});
            problems.push(`No changes in ${ws.dir} since ${last}, so there is nothing to release.${unstaged
                ? ' You have changes there that are not staged, and without -a they would not be committed. Stage them, or use -a tracked or -a all.'
                : ' Make a change first, or use -sv to set a version anyway.'}`);
        }
    }

    if (opts.addMode === 'patch' || opts.addMode === 'interactive') {
        const versionFiles = [`${ws.dir}/package.json`, `${ws.dir}/CHANGELOG.md`];
        const dirty = versionFiles.filter(file => gitOut(['status', '--porcelain', '--', file]).trim());
        if (dirty.length) {
            problems.push(`${dirty.join(' and ')} ${dirty.length > 1 ? 'have' : 'has'} uncommitted changes. vnxt stages the version files whole, so they cannot be part of a hand-picked commit. Commit or stash them first, or use -a tracked.`);
        }
    }

    if (fs.existsSync(LOCKFILE)) {
        if (gitOut(['status', '--porcelain', '--', LOCKFILE]).trim()) {
            problems.push(`${LOCKFILE} has uncommitted changes. Commit or stash them first, so they cannot ride along in a version commit.`);
        } else {
            try {
                setLockfileVersion(fs.readFileSync(LOCKFILE, 'utf8'), ws.dir, ws.version || '0.0.0');
            } catch (err) {
                if (!(err instanceof UserError)) throw err;
                problems.push(err.message);
            }
        }
    }

    return problems;
}

// Refuses flags and combinations that workspace mode does not support
function assertWorkspaceFlagsSupported(opts, targets) {
    const refuse = flag => {
        throw new UserError(`${flag} is not supported in workspace mode yet.`);
    };

    if (opts.publishToNpm) {
        throw new UserError('--publish is not supported in workspace mode, and is not meant to be: apps are deployed as builds and shared packages are used through the workspace links, so nothing is published from here. Use -p to push the commit and tag.');
    }
    if (opts.promptForStaging) throw new UserError('Workspace mode needs a staging mode: -a all, -a tracked, -a patch or -a interactive.');

    if (targets.length > 1) {
        if (opts.customVersion) {
            throw new UserError('-sv sets one exact version, so it cannot be used with several workspaces. Run them one at a time, or leave -sv out.');
        }
        if (opts.addMode === 'patch' || opts.addMode === 'interactive') {
            throw new UserError(`-a ${opts.addMode} chooses changes by hand, so it works with one workspace at a time.`);
        }
    }

    if (!opts.dryRun && !opts.message) throw new UserError('-m is required in workspace mode for now.');
}

// Release notes live inside the workspace: <dir>/release-notes/<name>@<version>.md
function workspaceReleaseNotesPath(ws, version) {
    const safe = ws.name.replace(/^@/, '').replace(/\//g, '-');
    return `${ws.dir}/release-notes/${safe}@${version}.md`;
}

// Same layout as the single-package release notes, so anything that reads them still can
function generateWorkspaceReleaseNotes(ws, file, tag, newVersion, message, withChangelog) {
    log('📋 Generating release notes...', 'cyan');

    const now = new Date();
    const time = now.toISOString().replace('T', ' ').split('.')[0].split(' ')[1];
    const date = now.toISOString().split('T')[0];

    let author = '';
    try { author = gitOut(['config', 'user.name']).trim(); } catch {}

    const notes = `# Release ${tag}

Released: ${date} at ${time} UTC${author ? `\nAuthor: ${author}` : ''}

## Changes
- ${commitSubject(message)}
${ws.private ? '' : `
## Installation
\`\`\`bash
npm install ${ws.name}@${newVersion}
\`\`\`
`}${withChangelog ? `
## Full Changelog
See [CHANGELOG.md](../CHANGELOG.md) for complete version history.
` : ''}`;

    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, notes);
    log(`   Created: ${file}`);
}

function bumpAndCommitWorkspace(ws, opts, versionArg) {
    const problems = workspaceProblems(ws, opts);
    if (problems.length) throw new UserError(problems[0]);

    const branch = gitOut(['branch', '--show-current']).trim();
    if (!branch) {
        log('⚠️  Warning: HEAD is detached, so this commit will not be on any branch', 'yellow');
    } else if (branch !== 'main' && branch !== 'master') {
        log(`⚠️  Warning: You're on branch '${branch}', not main/master`, 'yellow');
    }

    const manifest = `${ws.dir}/package.json`;
    const hadLockfile = fs.existsSync(LOCKFILE);
    const snapshot = snapshotFiles([manifest, LOCKFILE, `${ws.dir}/CHANGELOG.md`]);
    const plan = buildCommitPlan(ws, opts, hadLockfile);

    let pickedIndex = null;
    if (plan.pick) {
        const expected = previewVersion(ws, versionArg);
        const expectedTag = expected && workspaceTagName(ws, expected);
        if (expectedTag && tagExists(expectedTag)) {
            throw new UserError(`The tag ${expectedTag} already exists. Use -sv to choose another version, or delete the old tag if it is stale.`);
        }
        pickedIndex = pickChanges(ws, plan);
    }

    let step = 'bump the version';
    let newVersion;
    let tag;
    let notesFile = null;
    const notesDir = `${ws.dir}/release-notes`;
    const notesDirExisted = fs.existsSync(notesDir);
    try {
        log(`\n🔼 Bumping ${ws.name}...`, 'cyan');
        execSync(`npm version ${versionArg} --git-tag-version=false --workspaces-update=false`, {cwd: ws.abs, stdio: quietMode ? 'pipe' : 'inherit'});
        newVersion = readJsonIfExists(path.join(ws.abs, 'package.json')).version;
        if (snapshot[manifest] !== null) {
            const written = fs.readFileSync(manifest, 'utf8');
            const restored = matchLayout(snapshot[manifest], written);
            if (restored !== written) fs.writeFileSync(manifest, restored);
        }

        if (hadLockfile) fs.writeFileSync(LOCKFILE, setLockfileVersion(snapshot[LOCKFILE], ws.dir, newVersion));

        tag = workspaceTagName(ws, newVersion);
        if (!isValidTagName(tag)) throw new UserError(`'${tag}' is not a tag name git accepts.`);
        if (tagExists(tag)) {
            throw new UserError(`The tag ${tag} already exists, so the version bump was rolled back. Use -sv to choose another version, or delete the old tag if it is stale.`);
        }

        if (opts.generateChangelog) generateChangelog(newVersion, opts.message, ws.dir);

        if (opts.generateReleaseNotes) {
            const candidate = workspaceReleaseNotesPath(ws, newVersion);
            if (fs.existsSync(candidate)) throw new UserError(`${candidate} already exists, so the version bump was rolled back. Delete it or use -sv to choose another version.`);
            notesFile = candidate;
            generateWorkspaceReleaseNotes(ws, notesFile, tag, newVersion, opts.message, opts.generateChangelog);
            plan.stage.push(['add', '--', notesFile]);
        }

        step = 'stage the files';
        log('📦 Staging files...', 'cyan');
        const stageEnv = pickedIndex ? {...process.env, GIT_INDEX_FILE: pickedIndex} : process.env;
        for (const args of plan.stage) execFileSync('git', args, {env: stageEnv, stdio: 'pipe'});

        step = 'commit';
        log('📝 Committing...', 'cyan');
        commitWithTemporaryIndex(plan, quietMode, pickedIndex);
    } catch (err) {
        removeTemporaryIndex(pickedIndex);
        if (notesFile) {
            fs.rmSync(notesFile, {force: true});
            try { execFileSync('git', ['reset', '-q', '--', notesFile], {stdio: 'pipe'}); } catch {}
            if (!notesDirExisted) { try { fs.rmdirSync(notesDir); } catch {} }
        }
        restoreFiles(snapshot);
        if (err instanceof UserError) throw err;
        throw new UserError(`Could not ${step}, so the version bump was rolled back. ${err.message}`);
    }

    execFileSync('git', plan.resetKept, {stdio: 'pipe'});

    log('🏷️  Adding tag annotation...', 'cyan');
    try {
        execFileSync('git', ['tag', '-a', tag, '-m', `Version ${newVersion}\n\n${opts.message}`], {stdio: 'pipe'});
    } catch (err) {
        throw new UserError(`The commit was made, but the tag ${tag} could not be created: ${err.message}\n   Nothing was pushed. Create the tag by hand with: git tag -a ${tag} -m "Version ${newVersion}"`);
    }

    let pushed = false;
    if (opts.push) {
        log('🚀 Pushing to remote...', 'cyan');
        try {
            execFileSync('git', ['push', '--follow-tags'], {stdio: quietMode ? 'pipe' : 'inherit'});
            pushed = true;
        } catch (err) {
            throw new UserError(`The commit and the tag ${tag} were made locally, but the push failed: ${err.message}\n   Fix the cause, then run: git push --follow-tags`);
        }
    }

    return { newVersion, tag, pushed };
}

// The version npm would produce, worked out on a throwaway copy of the manifest
function previewVersion(ws, versionArg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnxt-preview-'));
    try {
        fs.copyFileSync(path.join(ws.abs, 'package.json'), path.join(dir, 'package.json'));
        execSync(`npm version ${versionArg} --git-tag-version=false --ignore-scripts`, {cwd: dir, stdio: 'pipe'});
        return readJsonIfExists(path.join(dir, 'package.json')).version;
    } catch {
        return null;
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

function filesToStage(ws, addMode) {
    const tracked = gitList(['ls-files', '-m', '-d', '-z', '--', ws.dir]);
    if (addMode === 'tracked') return uniqueSorted(tracked);
    if (addMode === 'all') return uniqueSorted([...tracked, ...gitList(['ls-files', '-o', '--exclude-standard', '-z', '--', ws.dir])]);
    return uniqueSorted(gitList(['diff', '--cached', '--name-only', '-z', '--', ws.dir]));
}

function printList(items, empty = '(none)') {
    if (!items.length) log(`  ${empty}`, 'gray');
    for (const item of items) log(`  ${item}`);
}

// Local annotated tags that a push would also send
function unpushedTags() {
    try {
        const out = gitOut(['push', '--follow-tags', '--dry-run', '--porcelain']);
        return out.split(/\r?\n/)
            .filter(line => line.startsWith('*\trefs/tags/'))
            .map(line => line.slice(1).trim().split(':')[0].replace(/^refs\/tags\//, ''))
            .sort();
    } catch {
        return null;
    }
}

function previewWorkspace(ws, opts, versionArg, part = null) {
    const hadLockfile = fs.existsSync(LOCKFILE);
    const plan = buildCommitPlan(ws, opts, hadLockfile);
    const newVersion = previewVersion(ws, versionArg);

    if (part) {
        log(`\n━━ Target ${part.index} of ${part.total} ━━\n`, 'cyan');
    } else {
        log('🔬 DRY RUN MODE - No changes will be made\n', 'yellow');
        log(`Repo root: ${process.cwd()}\n`);
    }
    log(`Workspace: ${ws.name}`);
    log(`Directory: ${ws.dir}`);
    log(`Version:   ${ws.version || '(none)'} → ${newVersion || '(could not be calculated)'}`);
    log(`Private:   ${ws.private ? 'yes' : 'no'}`);
    log(`Message:   ${opts.message || '(none yet)'}`);
    const tag = newVersion ? workspaceTagName(ws, newVersion) : null;
    log(`Tag:       ${tag || '(unknown)'}`);

    for (const problem of workspaceProblems(ws, opts)) {
        log(`\n⚠️  A real run would stop here: ${problem}`, 'yellow');
    }

    if (tag && tagExists(tag)) {
        log(`\n⚠️  A real run would stop here: the tag ${tag} already exists.`, 'yellow');
    }

    log('\nWill change:', 'cyan');
    printList([
        `${ws.dir}/package.json`,
        ...(hadLockfile ? [`${LOCKFILE} (this workspace's entry only)`] : []),
        ...(opts.generateChangelog ? [`${ws.dir}/CHANGELOG.md${fs.existsSync(`${ws.dir}/CHANGELOG.md`) ? '' : ' (new)'}`] : []),
        ...(opts.generateReleaseNotes && newVersion ? [`${workspaceReleaseNotesPath(ws, newVersion)} (new)`] : [])
    ]);
    if (opts.generateReleaseNotes && newVersion && fs.existsSync(workspaceReleaseNotesPath(ws, newVersion))) {
        log(`\n⚠️  A real run would stop here: ${workspaceReleaseNotesPath(ws, newVersion)} already exists.`, 'yellow');
    }

    if (plan.pick) {
        log(`\nYou will choose the changes to commit inside ${ws.dir} (-a ${opts.addMode}) when this is run for real.`, 'cyan');
        log('Already staged there, and so part of the commit:', 'cyan');
        printList(filesToStage(ws, opts.addMode));
    } else {
        const staging = opts.addMode ? `-a ${opts.addMode}` : 'already staged';
        log(`\nWill commit from inside ${ws.dir} as well (${staging}):`, 'cyan');
        printList(filesToStage(ws, opts.addMode));
    }

    const outside = gitList(['diff', '--cached', '--name-only', '-z'])
        .filter(file => file !== LOCKFILE && file !== ws.dir && !file.startsWith(`${ws.dir}/`));
    log('\nStaged elsewhere, left staged and out of this commit:', 'cyan');
    printList(outside);

    const show = args => `git ${args.map(quoteForDisplay).join(' ')}`;
    log('\nCommands, in order:', 'cyan');
    if (plan.pick) log(`  ${show(plan.pick)}   (first, on a temporary copy of the index; you choose, and choosing nothing stops the run)`);
    log(`  npm version ${versionArg} --git-tag-version=false --workspaces-update=false   (run in ${ws.dir})`);
    if (hadLockfile) log(`  (vnxt sets the version in ${LOCKFILE}'s ${ws.dir} entry itself, so npm installs nothing)`);
    for (const args of plan.stage) log(`  ${show(args)}${plan.pick ? '   (on that copy)' : ''}`);
    if (opts.generateReleaseNotes && newVersion) log(`  ${show(['add', '--', workspaceReleaseNotesPath(ws, newVersion)])}${plan.pick ? '   (on that copy)' : ''}`);
    log(`  ${show(plan.resetOthers)}   (on a temporary copy of the index)`);
    log(`  ${show(plan.commit)}   (on that copy; hooks run as usual)`);
    log(`  ${show(plan.resetKept)}`);
    if (tag) log(`  git tag -a ${quoteForDisplay(tag)} -m "Version ${newVersion}..."`);
    if (opts.push && !part) log('  git push --follow-tags');

    if (part) return;
    previewPushSummary(opts);
    log('\n✓ Dry run complete. Nothing was changed.', 'green');
}

function previewPushSummary(opts) {
    log(`\nPush: ${opts.push ? 'yes (-p or workspaceAutoPush), once, after every commit' : 'no (use -p to push)'}`, 'cyan');
    if (opts.push) {
        const unpushed = unpushedTags();
        if (unpushed === null) {
            log('  (could not ask the remote which tags are not pushed yet)', 'gray');
        } else {
            log('  Tags already made locally that this push would also send:');
            printList(unpushed, '(none)');
        }
    }
}

function printWorkspaceSummary(ws, result, opts) {
    const { newVersion, tag, pushed } = result;
    log('\n📊 Summary:', 'cyan');
    log('━'.repeat(50), 'gray');
    log(`\n📦 Workspace: ${ws.name} (${ws.dir})`, 'green');
    log(`📦 Version: ${ws.version || '(none)'} → ${newVersion}`, 'green');
    log(`💬 Message: ${opts.message}`);
    if (opts.generateChangelog) log(`📄 Changelog: Updated (${ws.dir}/CHANGELOG.md)`);
    if (opts.generateReleaseNotes) log(`📋 Release notes: Generated (${workspaceReleaseNotesPath(ws, newVersion)})`);
    log(`🏷️  Tag: ${tag}`);
    log(pushed ? '📍 Remote: Pushed with tags' : '📍 Remote: Not pushed (use --push to enable)', pushed ? 'green' : 'gray');
    log('━'.repeat(50), 'gray');
    log('\n✅ Version bump complete!\n', 'green');
}

// Everything that would stop any of the targets, found before the first one is touched
function preflightMany(targets, opts, versionArg) {
    const found = new Map();
    const add = (message, ws) => {
        if (!found.has(message)) found.set(message, []);
        found.get(message).push(ws.name);
    };

    for (const ws of targets) {
        for (const problem of workspaceProblems(ws, opts)) add(problem, ws);

        const newVersion = previewVersion(ws, versionArg);
        if (!newVersion) {
            add('The new version could not be worked out.', ws);
            continue;
        }
        const tag = workspaceTagName(ws, newVersion);
        if (!isValidTagName(tag)) add(`'${tag}' is not a tag name git accepts.`, ws);
        else if (tagExists(tag)) add(`The tag ${tag} already exists. Use -sv on its own to choose another version, or delete the old tag if it is stale.`, ws);
        if (opts.generateReleaseNotes && fs.existsSync(workspaceReleaseNotesPath(ws, newVersion))) {
            add(`${workspaceReleaseNotesPath(ws, newVersion)} already exists.`, ws);
        }
    }

    return [...found].map(([message, names]) => (names.length === targets.length ? message : `[${names.join(', ')}] ${message}`));
}

function printManySummary(landed, opts, pushed) {
    log('\n📊 Summary:', 'cyan');
    log('━'.repeat(50), 'gray');
    log(`\n💬 Message: ${opts.message}`);
    for (const { ws, result } of landed) {
        log(`\n📦 ${ws.name} (${ws.dir}): ${ws.version || '(none)'} → ${result.newVersion}`, 'green');
        log(`   🏷️  Tag: ${result.tag}`);
    }
    log(pushed ? '\n📍 Remote: Pushed with tags' : '\n📍 Remote: Not pushed (use --push to enable)', pushed ? 'green' : 'gray');
    log('━'.repeat(50), 'gray');
    log(`\n✅ ${landed.length} workspaces released, one commit and one tag each.\n`, 'green');
}

// Releases several workspaces: one commit and tag each, then one push
function runManyWorkspaces(opts, targets, versionArg) {
    const noVersion = targets.filter(ws => !ws.version);
    if (noVersion.length) {
        throw new UserError(`${noVersion.map(ws => ws.name).join(', ')} ${noVersion.length > 1 ? 'have' : 'has'} no version yet, so there is nothing to bump. Set a first version with -sv, one workspace at a time.`);
    }

    if (opts.dryRun) {
        log('🔬 DRY RUN MODE - No changes will be made\n', 'yellow');
        log(`Repo root: ${process.cwd()}\n`);
        log(`${targets.length} workspaces, one commit and one tag each, in this order:`, 'cyan');
        printList(targets.map(ws => ws.name));
        targets.forEach((ws, index) => previewWorkspace(ws, opts, versionArg, { index: index + 1, total: targets.length }));
        previewPushSummary(opts);
        log('\n✓ Dry run complete. Nothing was changed.', 'green');
        return;
    }

    const problems = preflightMany(targets, opts, versionArg);
    if (problems.length) {
        throw new UserError(`Nothing was changed. Fix ${problems.length > 1 ? 'these' : 'this'} first:\n${problems.map(p => `   - ${p}`).join('\n')}`);
    }

    const landed = [];
    for (const ws of targets) {
        try {
            landed.push({ ws, result: bumpAndCommitWorkspace(ws, { ...opts, push: false }, versionArg) });
        } catch (err) {
            const notStarted = targets.slice(landed.length + 1).map(t => t.name);
            const lines = [
                `Stopped at ${ws.name}: ${err.message}`,
                `   Landed before this: ${landed.length ? landed.map(l => l.result.tag).join(', ') : 'nothing'}.`,
                `   Not started: ${notStarted.length ? notStarted.join(', ') : 'nothing'}.`,
                '   Nothing was pushed.'
            ];
            if (notStarted.length) {
                lines.push(`   After dealing with ${ws.name} as described above, run the rest with: vx -w ${notStarted.join(',')} -m "<the same message>"  (and the same flags)`);
            }
            throw new UserError(lines.join('\n'));
        }
    }

    let pushed = false;
    if (opts.push) {
        log('\n🚀 Pushing to remote...', 'cyan');
        try {
            execFileSync('git', ['push', '--follow-tags'], {stdio: quietMode ? 'pipe' : 'inherit'});
            pushed = true;
        } catch (err) {
            throw new UserError(`All ${landed.length} commits and tags were made locally (${landed.map(l => l.result.tag).join(', ')}), but the push failed: ${err.message}\n   Fix the cause, then run: git push --follow-tags`);
        }
    }

    printManySummary(landed, opts, pushed);
}

// Prints the workspaces and their state, changing nothing
function listWorkspaces() {
    const root = process.cwd();
    const rootPackage = readJsonIfExists(path.join(root, 'package.json'));
    if (!rootPackage || !declaresWorkspaces(rootPackage)) {
        throw new UserError("This repo's root package.json does not declare workspaces, so there is nothing to list.");
    }
    const workspaces = readWorkspaces(root, rootPackage);
    if (!workspaces.length) throw new UserError('The root package.json declares workspaces, but none of them were found on disk.');

    const rows = workspaces.map(ws => {
        const tag = lastWorkspaceTag(ws);
        let changes = 'never released';
        if (tag) changes = changesSince(ws, tag);
        return [ws.name, ws.dir, ws.version || '(none)', ws.private ? 'yes' : 'no', tag || '-', changes];
    });
    const head = ['NAME', 'FOLDER', 'VERSION', 'PRIVATE', 'LATEST TAG', 'CHANGES'];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    const line = cells => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();

    log(`Workspaces in ${root}:\n`, 'cyan');
    log(line(head), 'gray');
    for (const row of rows) log(line(row));
    log('\nChoose one or more with -w, for example: vx -w ' + workspaces[0].name + ' -m "fix: ..."', 'gray');
}

// What vnxt does in a workspaces repo once it knows which workspaces are meant
function runWorkspaceMode(opts, targets) {
    assertWorkspaceFlagsSupported(opts, targets);

    const pushByConfig = config.workspaceAutoPush === true;
    opts = {...opts, push: !opts.noPush && (opts.explicitPush || pushByConfig)};
    if (config.autoPush && !opts.push && !opts.noPush) {
        log('ℹ️  autoPush is ignored in workspace mode. Add -p to push, or set workspaceAutoPush to true in .vnxtrc.json.', 'cyan');
    }

    const ws = targets[0];

    if (opts.customVersion === true) throw new UserError('-sv needs a version, for example: -sv 2.0.0-beta.1');

    let type = opts.type;
    if (!opts.customVersion && !getFlag('--type', '-t') && opts.message) {
        type = detectVersionType(opts.message, opts.type);
    }
    if (!opts.customVersion && !['patch', 'minor', 'major'].includes(type)) {
        throw new UserError('Version type must be patch, minor, or major');
    }

    const versionArg = opts.customVersion || type;
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(versionArg)) {
        throw new UserError(`'${versionArg}' is not a version npm can use.`);
    }

    if (targets.length > 1) {
        runManyWorkspaces(opts, targets, versionArg);
        return;
    }

    if (!ws.version && !opts.customVersion) {
        throw new UserError(`${ws.name} has no version yet, so there is nothing to bump. Set its first version with -sv, for example: -sv 1.0.0`);
    }

    if (opts.dryRun) {
        previewWorkspace(ws, opts, versionArg);
        return;
    }

    const result = bumpAndCommitWorkspace(ws, opts, versionArg);
    printWorkspaceSummary(ws, result, opts);
}

function handleQuickFlags() {
    if (args.includes('--vnxt-version') || args.includes('-vv')) {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        console.log(`vnxt v${pkg.version}`);
        process.exit(0);
    }

    if (args.includes('--get-version') || args.includes('-gv')) {
        if (!fs.existsSync('./package.json')) {
            console.error('❌ No package.json found in current directory.');
            process.exit(1);
        }
        const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        console.log(`${pkg.name} v${pkg.version}`);
        process.exit(0);
    }

    if (hasFlag('--help', '-h')) {
        printHelp();
        process.exit(0);
    }
}

function parseArgs() {
    if (args.includes('--quiet') || args.includes('-q')) {
        quietMode = true;
    }

    const addAllFlag = getFlag('--all', '-a');
    let addMode = null;
    let promptForStaging = false;

    if (addAllFlag) {
        if (typeof addAllFlag === 'string') {
            const mode = addAllFlag.toLowerCase();
            const modeMap = { a: 'all', i: 'interactive', p: 'patch' };
            const valid = ['tracked', 'all', 'interactive', 'patch', ...Object.keys(modeMap)];
            if (!valid.includes(mode)) {
                logError(`Error: Invalid add mode '${addAllFlag}'. Use: tracked, all, interactive (i), or patch (p)`);
                process.exit(1);
            }
            addMode = modeMap[mode] || mode;
        } else {
            promptForStaging = true;
        }
    }

    const noPush = hasFlag('--no-push', '-dnp');
    const publishToNpm = hasFlag('--publish');

    return {
        message:              getFlag('--message', '-m'),
        type:                 getFlag('--type', '-t') || config.defaultType,
        customVersion:        getFlag('--set-version', '-sv'),
        dryRun:               hasFlag('--dry-run', '-d'),
        noPush,
        publishToNpm,
        explicitPush:         hasFlag('--push', '-p'),
        push:                 noPush ? false : (hasFlag('--push', '-p') || publishToNpm || config.autoPush),
        generateChangelog:    hasFlag('--changelog', '-c') || config.autoChangelog,
        generateReleaseNotes: hasFlag('--release', '-r'),
        addMode,
        promptForStaging
    };
}

async function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => { rl.close(); resolve(answer); });
    });
}

async function runInteractiveMode(opts) {
    log('🤔 Interactive mode\n', 'cyan');

    opts.message = await prompt('Commit message: ');
    if (!opts.message) {
        logError('Error: Commit message is required');
        process.exit(1);
    }

    const typeInput = await prompt('Version type (patch/minor/major) [auto-detect]: ');
    if (typeInput && ['patch', 'minor', 'major'].includes(typeInput)) {
        opts.type = typeInput;
    }

    const changelogInput = await prompt('Update CHANGELOG.md? (y/n) [n]: ');
    opts.generateChangelog = changelogInput.toLowerCase() === 'y' || changelogInput.toLowerCase() === 'yes' || opts.generateChangelog;

    const publishInput = await prompt('Publish to npm? (y/n) [n]: ');
    if (publishInput.toLowerCase() === 'y' || publishInput.toLowerCase() === 'yes') {
        opts.publishToNpm = true;
        opts.generateReleaseNotes = true;
    }

    const pushInput = await prompt('Push to remote? (y/n) [n]: ');
    opts.push = pushInput.toLowerCase() === 'y' || pushInput.toLowerCase() === 'yes' || opts.push;

    const dryRunInput = await prompt('Dry run (preview only)? (y/n) [n]: ');
    opts.dryRun = dryRunInput.toLowerCase() === 'y' || dryRunInput.toLowerCase() === 'yes';

    log('');
}

function detectVersionType(message, currentType) {
    const rules = [
        { prefixes: ['major:', 'MAJOR:'],  type: 'major', label: 'major version bump' },
        { prefixes: ['minor:', 'MINOR:'],  type: 'minor', label: 'minor version bump' },
        { prefixes: ['patch:', 'PATCH:'],  type: 'patch', label: 'patch version bump' },
        { prefixes: ['feat:', 'feature:'], type: 'minor', label: 'minor version bump (feature)' },
        { prefixes: ['fix:'],              type: 'patch', label: 'patch version bump (fix)' },
        { prefixes: ['breaking:'],         type: 'major', label: 'major version bump (breaking change)' },
    ];

    for (const rule of rules) {
        if (rule.prefixes.some(p => message.startsWith(p))) {
            log(`📝 Auto-detected: ${rule.label}`, 'cyan');
            return rule.type;
        }
    }

    if (message.includes('BREAKING')) {
        log('📝 Auto-detected: major version bump (breaking change)', 'cyan');
        return 'major';
    }

    return currentType;
}

async function runPreflightChecks(opts) {
    log('\n🔍 Running pre-flight checks...\n', 'cyan');

    if ((config.requireCleanWorkingDir && !opts.addMode) || opts.promptForStaging) {
        const status = execSync('git status --porcelain --untracked-files=no').toString().trim();
        if (status || opts.promptForStaging) {
            if (status) log('⚠️  You have uncommitted changes.\n', 'yellow');

            log('📁 How would you like to stage files?\n');
            log('  1. Tracked files only (git add -u)');
            log('  2. All changes (git add -A)');
            log('  3. Interactive selection (git add -i)');
            log('  4. Patch mode (git add -p)');
            log('  5. Skip staging (continue without staging)\n');

            const choice = await prompt('Select [1-5]: ');
            const choiceMap = { '1': 'tracked', '2': 'all', '3': 'interactive', '4': 'patch' };

            if (choiceMap[choice]) {
                opts.addMode = choiceMap[choice];
            } else if (choice === '5') {
                log('⚠️  Skipping file staging. Ensure files are staged manually.', 'yellow');
            } else {
                logError('Invalid choice. Exiting.');
                process.exit(1);
            }
            log('');
        }
    }

    const branch = execSync('git branch --show-current').toString().trim();
    if (branch !== 'main' && branch !== 'master') {
        log(`⚠️  Warning: You're on branch '${branch}', not main/master`, 'yellow');
    }

    try {
        execSync('git remote get-url origin', {stdio: 'pipe'});
    } catch {
        if (opts.push) {
            logError('❌ Error: No remote repository configured, cannot push');
            process.exit(1);
        }
        log('⚠️  Warning: No remote repository configured', 'yellow');
    }

    log('✅ Pre-flight checks passed\n', 'green');
    return branch;
}

function runDryRun(opts) {
    log('🔬 DRY RUN MODE - No changes will be made\n', 'yellow');
    log('Would perform the following actions:');

    if (opts.addMode) {
        const modeDescriptions = {
            tracked:     'Stage tracked files only (git add -u)',
            all:         'Stage all changes (git add -A)',
            interactive: 'Interactive selection (git add -i)',
            patch:       'Patch mode (git add -p)'
        };
        log(`  1. ${modeDescriptions[opts.addMode]}`);
    }

    log(`  2. Bump ${opts.type} version`);
    log(`  3. Commit with message: "${opts.message}"`);
    log('  4. Create git tag with annotation');
    log(opts.generateChangelog    ? '  5. Update CHANGELOG.md'                          : '  5. (Skipping changelog - use --changelog to enable)');
    log(opts.generateReleaseNotes ? '  6. Generate release notes file'                  : '  6. (Skipping release notes - use --release to enable)');
    log(opts.push                 ? '  7. Push to remote with tags'                     : '  7. (Skipping push - use --push to enable)');

    log('\n✓ Dry run complete. Use without -d to apply changes.', 'green');
    process.exit(0);
}

function stageFiles(addMode) {
    log('📦 Staging files...', 'cyan');
    const modeCommands = {
        tracked:     'git add -u',
        all:         'git add -A',
        interactive: 'git add -i',
        patch:       'git add -p'
    };
    execSync(modeCommands[addMode], {stdio: 'inherit'});
}

function bumpVersion(opts) {
    log('\n🔼 Bumping version...', 'cyan');

    const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    const oldVersion = packageJson.version;

    const versionArg = opts.customVersion || opts.type;
    execSync(`npm version ${versionArg} --git-tag-version=false`, {stdio: quietMode ? 'pipe' : 'inherit'});

    const newVersion = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;

    return { oldVersion, newVersion, packageJson };
}

// Commits and tags once every file has been written
function commitAndTag(opts, newVersion) {
    execSync('git add package.json', {stdio: 'pipe'});
    if (fs.existsSync('package-lock.json')) {
        execSync('git add package-lock.json', {stdio: 'pipe'});
    }
    execFileSync('git', ['commit', '-m', opts.message], {stdio: quietMode ? 'pipe' : 'inherit'});

    log('🏷️  Adding tag annotation...', 'cyan');
    const tagMessage = `Version ${newVersion}\n\n${opts.message}`;
    execFileSync('git', ['tag', '-a', `${config.tagPrefix}${newVersion}`, '-m', tagMessage], {stdio: 'pipe'});
}

function generateChangelog(newVersion, message, dir = '') {
    log('📄 Updating CHANGELOG.md...', 'cyan');

    const file = dir ? `${dir}/CHANGELOG.md` : 'CHANGELOG.md';

    const date = new Date().toISOString().split('T')[0];
    const entry = `\n## [${newVersion}] - ${date}\n- ${message}\n`;

    let changelog = '# Changelog\n';
    if (fs.existsSync(file)) {
        changelog = fs.readFileSync(file, 'utf8');
    }

    const lines = changelog.split('\n');
    const titleIndex = lines.findIndex(line => line.startsWith('# Changelog'));
    lines.splice(titleIndex + 1, 0, entry);
    fs.writeFileSync(file, lines.join('\n'));

    execFileSync('git', ['add', '--', file], {stdio: 'pipe'});
}

// Mirrors git's own idea of a subject: the first paragraph, joined onto one line
function commitSubject(message) {
    return message.split(/\r?\n\r?\n/)[0].replace(/\s*\r?\n\s*/g, ' ').trim();
}

function generateReleaseNotes(newVersion, message, context, packageJson, isPublish = false) {
    log('📋 Generating release notes...', 'cyan');

    const date = new Date();
    const timestamp = date.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    const dateShort = date.toISOString().split('T')[0];

    let author = '';
    try { author = execSync('git config user.name', {stdio: 'pipe'}).toString().trim(); } catch {}

    let changes = message;
    if (isPublish) {
        try {
            const lastPublishTag = execSync(
                'git tag --list "publish/v*" --sort=-version:refname',
                {stdio: 'pipe'}
            ).toString().trim().split('\n').filter(Boolean)[0];

            if (lastPublishTag) {
                const earlier = execSync(
                    `git log ${lastPublishTag}..HEAD --pretty=format:"- %s"`,
                    {stdio: 'pipe'}
                ).toString().trim();
                changes = [`- ${commitSubject(message)}`, earlier].filter(Boolean).join('\n');
            }
        } catch {
        }
    }

    const notes = `# Release ${config.tagPrefix}${newVersion}

Released: ${dateShort} at ${timestamp.split(' ')[1]}${author ? `\nAuthor: ${author}` : ''}

## Changes
${changes}${context ? `\n\n## Release Notes\n${context}` : ''}

## Installation
\`\`\`bash
npm install ${packageJson.name}@${newVersion}
\`\`\`

## Full Changelog
See [CHANGELOG.md](../CHANGELOG.md) for complete version history.
`;

    const dir = 'release-notes';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const filename = `${dir}/${config.tagPrefix}${newVersion}.md`;
    fs.writeFileSync(filename, notes);
    log(`   Created: ${filename}`);

    execSync(`git add ${filename}`, {stdio: 'pipe'});
}


function pushToRemote(opts, newVersion) {
    log('🚀 Pushing to remote...', 'cyan');
    execSync('git push --follow-tags', {stdio: quietMode ? 'pipe' : 'inherit'});

    if (opts.publishToNpm) {
        log('📦 Pushing publish tag to trigger npm release...', 'cyan');
        const publishTag = `publish/${config.tagPrefix}${newVersion}`;
        execSync(`git tag ${publishTag}`, {stdio: 'pipe'});
        execSync(`git push origin ${publishTag}`, {stdio: quietMode ? 'pipe' : 'inherit'});
    }
}

function printSummary(opts, oldVersion, newVersion, branch) {
    log('\n📊 Summary:', 'cyan');
    log('━'.repeat(50), 'gray');
    log(`\n📦 Version: ${oldVersion} → ${newVersion}`, 'green');
    log(`💬 Message: ${opts.message}`);
    log(`🏷️  Tag: ${config.tagPrefix}${newVersion}`);
    log(`🌿 Branch: ${branch}`);

    if (opts.generateChangelog)    log('📄 Changelog: Updated');
    if (opts.generateReleaseNotes) log('📋 Release notes: Generated');

    if (opts.push) {
        log('🚀 Remote: Pushed with tags', 'green');
        if (opts.publishToNpm) {
            log(`📦 npm: Publishing triggered (publish/${config.tagPrefix}${newVersion})`, 'green');
        }
    } else {
        log('📍 Remote: Not pushed (use --push to enable)', 'gray');
    }

    if (!quietMode) {
        try {
            log('\n📝 Files changed:');
            const diff = execSync('git diff HEAD~1 --stat').toString();
            console.log(diff);
        } catch {
        }
    }

    log('━'.repeat(50), 'gray');
    log('\n✅ Version bump complete!\n', 'green');
}

function printHelp() {
    console.log(`
vnxt (vx) - Version Bump CLI Tool

Usage:
  vnxt [options]
  vx -m "commit message" [options]

Options:
  -m, --message <msg>      Commit message (required, or use interactive mode)
  -t, --type <type>        Version type: patch, minor, major (auto-detected from message)
  -sv, --set-version <v>   Set a specific version (e.g., 2.0.0-beta.1)
  -gv, --get-version       Show the current project's version
  -vv, --vnxt-version      Show the installed vnxt version
  -p, --push               Push to remote with tags
  -dnp, --no-push          Prevent auto-push (overrides config)
  --publish                Push and trigger npm publish via GitHub Actions (implies --push)
  -c, --changelog          Update CHANGELOG.md
  -d, --dry-run            Show what would happen without making changes
  -a, --all [mode]         Stage files before versioning
                           Modes: tracked (default), all, interactive (i), patch (p)
                           If no mode specified, prompts interactively
  -w, --workspace <w>      Workspace(s) to version in an npm workspaces repo (name or folder).
                           Several: -w a,b or -w a -w b. One commit and one tag each,
                           tags are <name>@<version>. -sv, -a patch and -a interactive
                           need a single workspace.
  -lw, --list-workspaces   List the workspaces, their versions, latest tags and whether
                           they have changed since. Changes nothing.
  -r, --release            Generate release notes file (saved to release-notes/)
  -q, --quiet              Minimal output (errors only)
  -h, --help               Show this help message

Auto-detection:
  - "major:" → major version
  - "minor:" → minor version
  - "patch:" → patch version
  - "feat:" or "feature:" → minor version
  - "fix:" → patch version
  - "BREAKING" or "breaking:" → major version

Configuration:
  Create .vnxtrc.json in your project:
  {
    "autoChangelog": true,
    "defaultType": "patch",
    "requireCleanWorkingDir": false,
    "autoPush": true,
    "defaultStageMode": "tracked",
    "tagPrefix": "v",
    "colors": true
  }

Examples:
  vx -vv                                  # Show vnxt version
  vx -gv                                  # Show current project version
  vx -m "fix: resolve bug"                # Auto-pushes with autoPush: true
  vx -m "feat: add new feature"           # Auto-pushes with autoPush: true
  vx -m "fix: bug" -dnp                   # Don't push (override)
  vx -sv 2.0.0-beta.1 -m "beta release"
  vx -m "test" -d
  vx -m "fix: bug" -a                     # Interactive prompt for staging
  vx -m "fix: bug" -a tracked             # Stage tracked files only
  vx -m "fix: bug" -a all                 # Stage all changes
  vx -m "fix: bug" -a i                   # Interactive git add
  vx -m "fix: bug" -a p                   # Patch mode
  vx -m "fix: bug" -q                     # Quiet mode (minimal output)
  vx -m "feat: new feature" --publish     # Bump, push and trigger npm publish
  vx -m "fix: bug" -r                     # Generate release notes in release-notes/
  vx                                      # Interactive mode
`);
}

async function main() {
    try {
        handleQuickFlags();

        const location = enterRepoRoot();
        config = loadConfig();

        if (!fs.existsSync('.git')) {
            logError('❌ Not a git repository. Run `git init` first.');
            process.exit(1);
        }

        if (hasFlag('--list-workspaces', '-lw')) {
            listWorkspaces();
            return;
        }

        const targets = resolveTargets({
            root: process.cwd(),
            startDir: location.startDir,
            selectors: collectWorkspaceSelectors(args)
        });
        if (!targets) refuseAmbiguousSubfolder(location);

        const opts = parseArgs();

        if (targets) {
            runWorkspaceMode(opts, targets);
            return;
        }

        if (!opts.message) {
            await runInteractiveMode(opts);
        }

        if (!opts.customVersion && !getFlag('--type', '-t')) {
            opts.type = detectVersionType(opts.message, opts.type);
        }

        if (!opts.customVersion && !['patch', 'minor', 'major'].includes(opts.type)) {
            logError('Error: Version type must be patch, minor, or major');
            process.exit(1);
        }

        let releaseNotesContext = '';
        if (!opts.generateReleaseNotes && opts.publishToNpm) {
            opts.generateReleaseNotes = true;
            if (!quietMode) {
                log('\n📋 Release notes required for --publish.', 'yellow');
                releaseNotesContext = await prompt('   Add context (press Enter to skip): ');
                if (releaseNotesContext) log('');
            }
        } else if (opts.generateReleaseNotes && !quietMode) {
            releaseNotesContext = await prompt('\n📋 Add context to release notes (press Enter to skip): ');
            if (releaseNotesContext) log('');
        }

        const branch = await runPreflightChecks(opts);

        if (opts.dryRun) runDryRun(opts);

        if (opts.addMode) stageFiles(opts.addMode);

        const { oldVersion, newVersion, packageJson } = bumpVersion(opts);

        if (opts.generateChangelog)    generateChangelog(newVersion, opts.message);
        if (opts.generateReleaseNotes) generateReleaseNotes(newVersion, opts.message, releaseNotesContext, packageJson, opts.publishToNpm);

        commitAndTag(opts, newVersion);

        if (opts.push)                 pushToRemote(opts, newVersion);

        printSummary(opts, oldVersion, newVersion, branch);
    } catch (error) {
        logError('\n❌ Error: ' + error.message);
        process.exit(1);
    }
}

module.exports = {
    UserError,
    readWorkspaces,
    parseSelectors,
    collectWorkspaceSelectors,
    setLockfileVersion,
    workspaceTagName,
    resolveTargets,
    inferTarget,
    matchLayout
};

if (require.main === module) {
    main();
}