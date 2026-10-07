#!/usr/bin/env node

// =============================================================================
// TODOs
// -----------------------------------------------------------------------------
// 1. Nothing comes to mind right now
// =============================================================================

// =============================================================================
// Imports & Constants
// =============================================================================

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

// =============================================================================
// Logging
// =============================================================================

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

// =============================================================================
// Argument Helpers
// =============================================================================

function getFlag(flag, short) {
    const index = args.indexOf(flag) !== -1 ? args.indexOf(flag) : args.indexOf(short);
    if (index === -1) return null;
    return args[index + 1] || true;
}

function hasFlag(flag, short) {
    return args.includes(flag) || (short ? args.includes(short) : false);
}

// =============================================================================
// Load Config
// =============================================================================

function loadConfig() {
    const defaults = {
        autoChangelog: true,
        defaultType: 'patch',
        requireCleanWorkingDir: false,
        autoPush: true,
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

// The real settings are loaded in main(), once vnxt is standing in the repo root.
let config = { colors: true };

// =============================================================================
// Repo Root
// =============================================================================

// Moves into the top of the git repository, so every relative path used below
// (package.json, .vnxtrc.json, CHANGELOG.md, release-notes/) means the same
// thing wherever vnxt was started. Does nothing outside a git repository.
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

// In a plain repo, started below the root, vnxt can only act on the root package.
// That is safe unless the folder holds its own package.json, because the person
// almost certainly means that package instead.
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

// =============================================================================
// Workspaces
// =============================================================================

// Problems the person can fix (a wrong -w value, the wrong folder) are thrown as
// UserError, so they print as a plain message rather than a stack trace.
class UserError extends Error {}

function toPosix(p) {
    return p.replace(/\\/g, '/');
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turns one entry of the workspaces field into folder names relative to the root.
// Supports plain folders and a * in the last segment (apps/*, packages/ui-*).
// Anything fancier is refused loudly rather than guessed at.
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

// Lists the workspaces the root package.json declares, as they exist on disk.
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

// Accepts values from repeated flags and comma lists: ['a,b', 'c'] gives ['a', 'b', 'c'].
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

// Collects every value given to -w / --workspace from an argv list: repeated flags,
// comma lists, space separated values and --workspace=value all work. A value is any
// token that does not start with '-', so one flag never swallows the next.
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

// A selector is a package name or a folder. Folders are tried relative to where
// vnxt was started first, then relative to the repo root.
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

// The workspace whose folder contains startDir, or null when startDir is the
// root, a folder between workspaces, or outside the repo altogether.
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

// Decides which workspaces a command means. Returns null for a repo without
// workspaces (plain single-package behaviour). Otherwise returns a non-empty list,
// or throws a UserError saying why it cannot tell.
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

// =============================================================================
// Workspace Mode
// =============================================================================

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

// Sets the version in a workspace's own lockfile entry and touches nothing else,
// keeping the file's indentation, line endings and final newline exactly as they
// were. A lockfile that does not survive a parse and rewrite unchanged is refused
// rather than reformatted. A workspace with no entry is left alone.
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

function snapshotFiles(files) {
    const snapshot = {};
    for (const file of files) {
        snapshot[file] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    }
    return snapshot;
}

// Puts files back as they were, and takes them out of the index again.
function restoreFiles(snapshot) {
    for (const [file, content] of Object.entries(snapshot)) {
        if (content === null) fs.rmSync(file, {force: true});
        else fs.writeFileSync(file, content);

        try {
            execFileSync('git', ['reset', '-q', '--', file], {stdio: 'pipe'});
        } catch {
            // Not known to git, so there is nothing to take out of the index
        }
    }
}

function quoteForDisplay(arg) {
    return /^[\w./@:=+,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

// Everything the real run does to git, as data, so the dry run prints exactly
// what the real run executes. The commit is made from a temporary copy of the
// index in which everything outside this workspace (and the lockfile) is put
// back to HEAD, so other staged work is neither committed nor disturbed.
function buildCommitPlan(ws, opts, hasLockfile) {
    const lock = hasLockfile ? [LOCKFILE] : [];
    const keep = [ws.dir, ...lock];
    const versionFiles = [`${ws.dir}/package.json`, ...(opts.generateChangelog ? [`${ws.dir}/CHANGELOG.md`] : []), ...lock];

    const stage = [];
    if (opts.addMode === 'all') stage.push(['add', '-A', '--', ws.dir]);
    if (opts.addMode === 'tracked') stage.push(['add', '-u', '--', ws.dir]);
    stage.push(['add', '--', ...versionFiles]);

    return {
        stage,
        resetOthers: ['reset', '-q', '--', '.', ...keep.map(p => `:(exclude,literal)${p}`)],
        commit: ['commit', '-m', opts.message],
        resetKept: ['reset', '-q', '--', ...keep]
    };
}

function commitWithTemporaryIndex(plan, quiet) {
    const realIndex = path.resolve(gitOut(['rev-parse', '--git-path', 'index']).trim());
    const tempIndex = `${realIndex}.vnxt-${process.pid}`;
    const env = {...process.env, GIT_INDEX_FILE: tempIndex};

    fs.copyFileSync(realIndex, tempIndex);
    try {
        execFileSync('git', plan.resetOthers, {env, stdio: 'pipe'});
        execFileSync('git', plan.commit, {env, stdio: quiet ? 'pipe' : 'inherit'});
    } finally {
        fs.rmSync(tempIndex, {force: true});
        fs.rmSync(`${tempIndex}.lock`, {force: true});
    }
}

// Reasons a real run would stop before changing anything.
function workspaceProblems(ws) {
    const problems = [];

    try {
        gitOut(['rev-parse', '--verify', '-q', 'HEAD']);
    } catch {
        problems.push('This repo has no commits yet. Make a first commit before using workspace mode.');
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

// Flags that have no workspace version yet are refused outright, in a dry run too,
// so a preview never describes something the real run would turn down.
function assertWorkspaceFlagsSupported(opts, targets) {
    const refuse = flag => {
        throw new UserError(`${flag} is not supported in workspace mode yet.`);
    };

    if (opts.generateReleaseNotes) refuse('-r / --release');
    if (opts.publishToNpm) refuse('--publish');
    if (opts.explicitPush) refuse('-p / --push (tags and pushing for workspaces are not built yet)');
    if (opts.promptForStaging) throw new UserError('Workspace mode needs a staging mode: -a all or -a tracked.');
    if (opts.addMode === 'interactive' || opts.addMode === 'patch') refuse(`-a ${opts.addMode}`);

    if (!opts.dryRun) {
        if (targets.length > 1) throw new UserError('One workspace at a time for now. Several workspaces in one run are not built yet.');
        if (!opts.message) throw new UserError('-m is required in workspace mode for now.');
    }
}

function bumpAndCommitWorkspace(ws, opts, versionArg) {
    const problems = workspaceProblems(ws);
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

    let step = 'bump the version';
    let newVersion;
    try {
        log(`\n🔼 Bumping ${ws.name}...`, 'cyan');
        // --workspaces-update=false stops npm reinstalling the whole tree just to change a version
        execSync(`npm version ${versionArg} --git-tag-version=false --workspaces-update=false`, {cwd: ws.abs, stdio: quietMode ? 'pipe' : 'inherit'});
        newVersion = readJsonIfExists(path.join(ws.abs, 'package.json')).version;

        // npm left the lockfile alone, so set this workspace's version in it, and nothing else
        if (hadLockfile) fs.writeFileSync(LOCKFILE, setLockfileVersion(snapshot[LOCKFILE], ws.dir, newVersion));

        if (opts.generateChangelog) generateChangelog(newVersion, opts.message, ws.dir);

        step = 'stage the files';
        log('📦 Staging files...', 'cyan');
        for (const args of plan.stage) execFileSync('git', args, {stdio: 'pipe'});

        step = 'commit';
        log('📝 Committing...', 'cyan');
        commitWithTemporaryIndex(plan, quietMode);
    } catch (err) {
        restoreFiles(snapshot);
        if (err instanceof UserError) throw err;
        throw new UserError(`Could not ${step}, so the version bump was rolled back. ${err.message}`);
    }

    // Make the real index agree with the new commit for the paths it covered
    execFileSync('git', plan.resetKept, {stdio: 'pipe'});
    return newVersion;
}

// The version npm would produce, worked out on a throwaway copy of the manifest.
// Scripts are ignored so a preview can never run anything from the package.
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

function previewResolved(targets) {
    log('🔬 DRY RUN MODE - No changes will be made\n', 'yellow');
    log(`Repo root: ${process.cwd()}`);

    targets.forEach((ws, index) => {
        log(`\nTarget ${index + 1} of ${targets.length}`, 'cyan');
        log(`  Workspace: ${ws.name}`);
        log(`  Directory: ${ws.dir}`);
        log(`  Version:   ${ws.version || '(none)'}`);
        log(`  Private:   ${ws.private ? 'yes' : 'no'}`);
    });

    log('\n✓ Dry run complete. Several workspaces in one run are not built yet, so this only shows which workspaces vnxt resolved.', 'green');
}

function previewWorkspace(ws, opts, versionArg) {
    const hadLockfile = fs.existsSync(LOCKFILE);
    const plan = buildCommitPlan(ws, opts, hadLockfile);
    const newVersion = previewVersion(ws, versionArg);

    log('🔬 DRY RUN MODE - No changes will be made\n', 'yellow');
    log(`Repo root: ${process.cwd()}\n`);
    log(`Workspace: ${ws.name}`);
    log(`Directory: ${ws.dir}`);
    log(`Version:   ${ws.version || '(none)'} → ${newVersion || '(could not be calculated)'}`);
    log(`Private:   ${ws.private ? 'yes' : 'no'}`);
    log(`Message:   ${opts.message || '(none yet)'}`);

    for (const problem of workspaceProblems(ws)) {
        log(`\n⚠️  A real run would stop here: ${problem}`, 'yellow');
    }

    log('\nWill change:', 'cyan');
    printList([
        `${ws.dir}/package.json`,
        ...(hadLockfile ? [`${LOCKFILE} (this workspace's entry only)`] : []),
        ...(opts.generateChangelog ? [`${ws.dir}/CHANGELOG.md${fs.existsSync(`${ws.dir}/CHANGELOG.md`) ? '' : ' (new)'}`] : [])
    ]);

    const staging = opts.addMode ? `-a ${opts.addMode}` : 'already staged';
    log(`\nWill commit from inside ${ws.dir} as well (${staging}):`, 'cyan');
    printList(filesToStage(ws, opts.addMode));

    const outside = gitList(['diff', '--cached', '--name-only', '-z'])
        .filter(file => file !== LOCKFILE && file !== ws.dir && !file.startsWith(`${ws.dir}/`));
    log('\nStaged elsewhere, left staged and out of this commit:', 'cyan');
    printList(outside);

    const show = args => `git ${args.map(quoteForDisplay).join(' ')}`;
    log('\nCommands, in order:', 'cyan');
    log(`  npm version ${versionArg} --git-tag-version=false --workspaces-update=false   (run in ${ws.dir})`);
    if (hadLockfile) log(`  (vnxt sets the version in ${LOCKFILE}'s ${ws.dir} entry itself, so npm installs nothing)`);
    for (const args of plan.stage) log(`  ${show(args)}`);
    log(`  ${show(plan.resetOthers)}   (on a temporary copy of the index)`);
    log(`  ${show(plan.commit)}   (on that copy; hooks run as usual)`);
    log(`  ${show(plan.resetKept)}`);

    log('\n✓ Dry run complete. Tags and pushing are not built for workspaces yet.', 'green');
}

function printWorkspaceSummary(ws, newVersion, opts) {
    log('\n📊 Summary:', 'cyan');
    log('━'.repeat(50), 'gray');
    log(`\n📦 Workspace: ${ws.name} (${ws.dir})`, 'green');
    log(`📦 Version: ${ws.version} → ${newVersion}`, 'green');
    log(`💬 Message: ${opts.message}`);
    if (opts.generateChangelog) log(`📄 Changelog: Updated (${ws.dir}/CHANGELOG.md)`);
    log('🏷️  Tag: Not created yet (per-workspace tags are the next step)', 'gray');
    log('📍 Remote: Not pushed (pushing from workspace mode arrives with the tags)', 'gray');
    log('━'.repeat(50), 'gray');
    log('\n✅ Version bump complete!\n', 'green');
}

// What vnxt does in a workspaces repo once it knows which workspaces are meant.
function runWorkspaceMode(opts, targets) {
    assertWorkspaceFlagsSupported(opts, targets);

    if (targets.length > 1) {
        previewResolved(targets);
        return;
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

    if (opts.dryRun) {
        previewWorkspace(ws, opts, versionArg);
        return;
    }

    const newVersion = bumpAndCommitWorkspace(ws, opts, versionArg);
    printWorkspaceSummary(ws, newVersion, opts);
}

// =============================================================================
// Handle Quick Flags (exit immediately)
// =============================================================================

function handleQuickFlags() {
    // -vv / --vnxt-version: show vnxt's own installed version
    if (args.includes('--vnxt-version') || args.includes('-vv')) {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        console.log(`vnxt v${pkg.version}`);
        process.exit(0);
    }

    // -gv / --get-version: show the current project's version
    if (args.includes('--get-version') || args.includes('-gv')) {
        if (!fs.existsSync('./package.json')) {
            console.error('❌ No package.json found in current directory.');
            process.exit(1);
        }
        const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        console.log(`${pkg.name} v${pkg.version}`);
        process.exit(0);
    }

    // -h / --help
    if (hasFlag('--help', '-h')) {
        printHelp();
        process.exit(0);
    }
}

// =============================================================================
// Parse Args
// =============================================================================

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

// =============================================================================
// Interactive Prompt Helper
// =============================================================================

async function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => { rl.close(); resolve(answer); });
    });
}

// =============================================================================
// Interactive Mode
// =============================================================================

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

// =============================================================================
// Detect Version Type
// =============================================================================

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

    // Special case: BREAKING anywhere in message
    if (message.includes('BREAKING')) {
        log('📝 Auto-detected: major version bump (breaking change)', 'cyan');
        return 'major';
    }

    return currentType;
}

// =============================================================================
// Pre-flight Checks
// =============================================================================

async function runPreflightChecks(opts) {
    log('\n🔍 Running pre-flight checks...\n', 'cyan');

    // Staging prompt if requested
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

    // Branch check
    const branch = execSync('git branch --show-current').toString().trim();
    if (branch !== 'main' && branch !== 'master') {
        log(`⚠️  Warning: You're on branch '${branch}', not main/master`, 'yellow');
    }

    // Remote check
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

// =============================================================================
// Dry Run
// =============================================================================

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

// =============================================================================
// Stage Files
// =============================================================================

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

// =============================================================================
// Bump Version
// =============================================================================

function bumpVersion(opts) {
    log('\n🔼 Bumping version...', 'cyan');

    const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    const oldVersion = packageJson.version;

    const versionArg = opts.customVersion || opts.type;
    execSync(`npm version ${versionArg} --git-tag-version=false`, {stdio: quietMode ? 'pipe' : 'inherit'});

    const newVersion = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;

    return { oldVersion, newVersion, packageJson };
}

// =============================================================================
// Commit and Tag
// =============================================================================

// Runs once every file (version, changelog, release notes) has been written and
// staged, so there is a single commit and the tag lands on that final commit.
function commitAndTag(opts, newVersion) {
    execSync('git add package.json', {stdio: 'pipe'});
    if (fs.existsSync('package-lock.json')) {
        execSync('git add package-lock.json', {stdio: 'pipe'});
    }
    execFileSync('git', ['commit', '-m', opts.message], {stdio: quietMode ? 'pipe' : 'inherit'});

    // Create annotated tag
    log('🏷️  Adding tag annotation...', 'cyan');
    const tagMessage = `Version ${newVersion}\n\n${opts.message}`;
    execFileSync('git', ['tag', '-a', `${config.tagPrefix}${newVersion}`, '-m', tagMessage], {stdio: 'pipe'});
}

// =============================================================================
// Generate Changelog
// =============================================================================

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

// =============================================================================
// Generate Release Notes
// =============================================================================

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

    // If publishing, gather all commits since the last publish/v* tag
    let changes = message;
    if (isPublish) {
        try {
            const lastPublishTag = execSync(
                'git tag --list "publish/v*" --sort=-version:refname',
                {stdio: 'pipe'}
            ).toString().trim().split('\n').filter(Boolean)[0];

            if (lastPublishTag) {
                // The commit for this release does not exist yet, so its subject is added by hand
                const earlier = execSync(
                    `git log ${lastPublishTag}..HEAD --pretty=format:"- %s"`,
                    {stdio: 'pipe'}
                ).toString().trim();
                changes = [`- ${commitSubject(message)}`, earlier].filter(Boolean).join('\n');
            }
        } catch {
            // Fall back to current message if git log fails
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

// =============================================================================
// Push to Remote
// =============================================================================

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

// =============================================================================
// Print Summary
// =============================================================================

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
            // No previous commit to diff against
        }
    }

    log('━'.repeat(50), 'gray');
    log('\n✅ Version bump complete!\n', 'green');
}

// =============================================================================
// Help
// =============================================================================

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
  -w, --workspace <w>      Workspace to version in an npm workspaces repo (name or folder).
                           One at a time for now, and no tags or pushing yet
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

// =============================================================================
// Main
// =============================================================================

async function main() {
    try {
        handleQuickFlags();

        // Work from the repo root, wherever vnxt was started
        const location = enterRepoRoot();
        config = loadConfig();

        // Git repo check
        if (!fs.existsSync('.git')) {
            logError('❌ Not a git repository. Run `git init` first.');
            process.exit(1);
        }

        // Say which workspace is meant, or learn that this is a plain repo
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

        // Interactive mode if no message provided
        if (!opts.message) {
            await runInteractiveMode(opts);
        }

        // Auto-detect version type from commit message
        if (!opts.customVersion && !getFlag('--type', '-t')) {
            opts.type = detectVersionType(opts.message, opts.type);
        }

        // Validate version type
        if (!opts.customVersion && !['patch', 'minor', 'major'].includes(opts.type)) {
            logError('Error: Version type must be patch, minor, or major');
            process.exit(1);
        }

        // Release notes context prompt
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
    resolveTargets,
    inferTarget
};

if (require.main === module) {
    main();
}