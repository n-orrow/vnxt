// vnxt.monorepo.test.js
//
// Integration tests for vnxt's repo root and workspace handling: a fixture
// builder for a stand-in monorepo, and tests that run the real command line tool
// against copies of it.
//
// Fixtures live under the OS temp folder, not next to this file, so they cannot
// collide with the test-* folders that vnxt.test.js creates. Nothing here
// pushes anywhere except to a bare repository inside the same temp folder.

const { spawnSync, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.setTimeout(120000);

const vnxtPath = path.join(__dirname, 'vnxt.js');

let tmpRoot;
let hooksDir;
let templateDir;
let counter = 0;

// =============================================================================
// Helpers
// =============================================================================

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function lines(text) {
    return text.split(/\r?\n/).filter(Boolean);
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

// Repo-local config beats the user's global config, so signing, hooks and
// line-ending settings on the machine running the tests cannot change results.
function isolateGit(repoDir) {
    const settings = [
        ['user.name', 'Fixture User'],
        ['user.email', 'fixture@example.com'],
        ['core.autocrlf', 'false'],
        ['core.safecrlf', 'false'],
        ['commit.gpgsign', 'false'],
        ['tag.gpgsign', 'false'],
        ['tag.forceSignAnnotated', 'false'],
        ['core.hooksPath', hooksDir]
    ];
    for (const [key, value] of settings) {
        git(['config', key, value], repoDir);
    }
}

// Runs vnxt without a shell, so quoting is identical on Windows and Linux.
// Never throws on a non-zero exit: the tests want to look at the exit code.
function vx(args, cwd) {
    const result = spawnSync(process.execPath, [vnxtPath, ...args], {
        cwd,
        encoding: 'utf8',
        input: '\n\n\n\n\n' // answers any prompt with Enter
    });
    const plain = text => (text || '').replace(/\x1b\[[0-9;]*m/g, '');
    return {
        status: result.status,
        stdout: plain(result.stdout),
        stderr: plain(result.stderr),
        error: result.error
    };
}

function versionOf(repoDir, dir) {
    return readJson(path.join(repoDir, dir, 'package.json')).version;
}

// git status --porcelain without the trim that git() applies, which would eat the
// leading space of ' M path'.
function statusOf(repoDir) {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' })
        .replace(/\r?\n$/, '');
}

// Everything a refused or preview-only run must leave exactly as it found it.
function snapshot(repoDir) {
    return {
        head: git(['rev-parse', 'HEAD'], repoDir),
        status: git(['status', '--porcelain'], repoDir),
        tags: git(['tag'], repoDir)
    };
}

// Points the repo at a hooks folder holding one hook. Hooks run through Git's own sh.
function installHook(repoDir, name, body) {
    const dir = path.join(tmpRoot, `hooks-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    git(['config', 'core.hooksPath', dir.replace(/\\/g, '/')], repoDir);
}

// Gives a fixture repo a local bare remote, and returns the remote's path.
function addRemote(repoDir) {
    const remote = path.join(tmpRoot, `remote-${++counter}.git`);
    fs.mkdirSync(remote);
    git(['init', '-q', '--bare', '-b', 'main'], remote);
    git(['remote', 'add', 'origin', remote], repoDir);
    git(['push', '-q', '-u', 'origin', 'main'], repoDir);
    return remote;
}

// Files touched by the most recent commit, with forward slashes.
function committedFiles(cwd) {
    return lines(git(['show', '--name-only', '--format=', 'HEAD'], cwd));
}

// =============================================================================
// Fixtures
// =============================================================================

// Stand-in monorepo: two apps, three source-only shared packages, one root
// lockfile, no version on the root. Built once, then copied for every test.
function buildTemplate() {
    templateDir = path.join(tmpRoot, 'template');
    fs.mkdirSync(templateDir, { recursive: true });

    writeJson(path.join(templateDir, 'package.json'), {
        name: 'fixture-root',
        private: true,
        workspaces: ['apps/*', 'packages/*']
    });

    const manifests = {
        'apps/app-one': {
            name: 'app-one', version: '0.1.1', private: true,
            dependencies: { '@fixture/shared-form': '*', '@fixture/shared-theme': '*' }
        },
        'apps/app-two': {
            name: 'app-two', version: '0.2.6', private: true,
            dependencies: { '@fixture/shared-theme': '*' }
        },
        'packages/shared-api': {
            name: '@fixture/shared-api', version: '0.0.0', private: true
        },
        'packages/shared-theme': {
            name: '@fixture/shared-theme', version: '0.0.0', private: true
        },
        'packages/shared-form': {
            name: '@fixture/shared-form', version: '0.0.0', private: true,
            dependencies: { '@fixture/shared-api': '*' }
        }
    };

    for (const [dir, manifest] of Object.entries(manifests)) {
        writeJson(path.join(templateDir, dir, 'package.json'), manifest);
        const entry = dir.startsWith('apps/') ? 'main.js' : 'index.js';
        writeFile(path.join(templateDir, dir, 'src', entry), `// ${manifest.name}\n`);
    }

    writeFile(path.join(templateDir, '.gitignore'), 'node_modules\n');

    // Workspace links only, so no registry access is needed.
    execSync('npm install --offline --no-audit --no-fund --ignore-scripts', {
        cwd: templateDir,
        stdio: 'pipe'
    });

    // Drop the symlinked node_modules so the per-test copies stay plain files.
    fs.rmSync(path.join(templateDir, 'node_modules'), { recursive: true, force: true });

    git(['init', '-q', '-b', 'main'], templateDir);
    isolateGit(templateDir);
    git(['add', '-A'], templateDir);
    git(['commit', '-q', '-m', 'initial fixture'], templateDir);
}

function freshWorkspace() {
    const dir = path.join(tmpRoot, `ws-${++counter}`);
    fs.cpSync(templateDir, dir, { recursive: true });
    return dir;
}

// A plain single-package repo with a local bare remote, for the tag tests.
function freshSingleWithRemote() {
    const id = ++counter;
    const remote = path.join(tmpRoot, `remote-${id}.git`);
    const work = path.join(tmpRoot, `single-${id}`);

    fs.mkdirSync(remote);
    git(['init', '-q', '--bare', '-b', 'main'], remote);

    fs.mkdirSync(work);
    git(['init', '-q', '-b', 'main'], work);
    isolateGit(work);
    writeJson(path.join(work, 'package.json'), { name: 'fixture-single', version: '1.0.0' });
    git(['add', '-A'], work);
    git(['commit', '-q', '-m', 'initial'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', '-u', 'origin', 'main'], work);

    return { work, remote };
}

beforeAll(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vnxt-mono-')));
    hooksDir = path.join(tmpRoot, 'no-hooks').replace(/\\/g, '/');
    fs.mkdirSync(hooksDir);
    buildTemplate();
});

afterAll(() => {
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.warn(`Warning: Could not clean up ${tmpRoot}`);
    }
});

// =============================================================================
// Fixture sanity (normal tests: these must always pass)
// =============================================================================

describe('fixture sanity', () => {
    test('vnxt runs and reports its own version', () => {
        const res = vx(['-vv'], tmpRoot);
        expect(res.error).toBeUndefined();
        expect(res.stdout).toMatch(/^vnxt v\d+\.\d+\.\d+/);
    });

    test('workspace fixture starts clean with the expected layout', () => {
        const ws = freshWorkspace();

        expect(git(['status', '--porcelain'], ws)).toBe('');
        expect(git(['tag'], ws)).toBe('');

        const tracked = lines(git(['ls-files'], ws));
        expect(tracked).toEqual(expect.arrayContaining([
            'package.json',
            'package-lock.json',
            'apps/app-one/package.json',
            'apps/app-two/package.json',
            'packages/shared-api/package.json',
            'packages/shared-theme/package.json',
            'packages/shared-form/package.json'
        ]));

        expect(readJson(path.join(ws, 'package.json')).version).toBeUndefined();
        expect(readJson(path.join(ws, 'apps', 'app-one', 'package.json')).version).toBe('0.1.1');
        expect(readJson(path.join(ws, 'apps', 'app-two', 'package.json')).version).toBe('0.2.6');
    });
});

// =============================================================================
// Repo root discovery
// =============================================================================

describe('repo root discovery', () => {
    test('works from a subfolder of a single-package repo, using the root files and config', () => {
        const { work } = freshSingleWithRemote();
        writeFile(
            path.join(work, '.vnxtrc.json'),
            JSON.stringify({ tagPrefix: 'rel-', autoChangelog: false }, null, 2)
        );
        git(['add', '.vnxtrc.json'], work);
        git(['commit', '-q', '-m', 'add config'], work);
        const sub = path.join(work, 'docs', 'guide');
        fs.mkdirSync(sub, { recursive: true });

        const res = vx(['-m', 'fix: from a subfolder', '-dnp'], sub);

        expect(res.status).toBe(0);
        expect(readJson(path.join(work, 'package.json')).version).toBe('1.0.1');
        expect(git(['tag'], work)).toBe('rel-1.0.1');
        expect(fs.existsSync(path.join(work, 'CHANGELOG.md'))).toBe(false);
        expect(fs.existsSync(path.join(sub, 'package.json'))).toBe(false);
    });

    test('refuses from a subfolder that has its own package.json, and changes nothing', () => {
        const { work } = freshSingleWithRemote();
        const sub = path.join(work, 'tools', 'helper');
        writeJson(path.join(sub, 'package.json'), { name: 'helper', version: '3.0.0' });
        git(['add', '-A'], work);
        git(['commit', '-q', '-m', 'add helper'], work);
        const before = git(['rev-parse', 'HEAD'], work);

        const res = vx(['-m', 'fix: nested', '-dnp'], sub);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('package.json');
        expect(git(['rev-parse', 'HEAD'], work)).toBe(before);
        expect(git(['tag'], work)).toBe('');
        expect(git(['status', '--porcelain'], work)).toBe('');
        expect(readJson(path.join(work, 'package.json')).version).toBe('1.0.0');
    });

    test("-gv in a subfolder still reports that folder's own package", () => {
        const ws = freshWorkspace();
        const res = vx(['-gv'], path.join(ws, 'apps', 'app-one'));

        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('app-one v0.1.1');
    });

    test('outside any git repo still says so', () => {
        const dir = path.join(tmpRoot, 'not-a-repo');
        writeJson(path.join(dir, 'package.json'), { name: 'loose', version: '1.0.0' });

        const res = vx(['-m', 'fix: nowhere', '-dnp'], dir);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('Not a git repository');
    });
});

// =============================================================================
// Workspace selection (-w)
// =============================================================================

describe('workspace selection (-w)', () => {
    test('refuses from the repo root without a selector, and lists the workspaces', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: from the root', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('inside a workspace folder');
        expect(res.stderr).toContain('app-one (apps/app-one)');
        expect(readJson(path.join(ws, 'package.json')).version).toBeUndefined();
        expect(snapshot(ws)).toEqual(before);
    });

    test('refuses an unknown workspace and lists what exists', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: nope', '-w', 'app-three', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("'app-three'");
        expect(res.stderr).toContain('app-two (apps/app-two)');
        expect(snapshot(ws)).toEqual(before);
    });

    test('refuses the repo root given as -w .', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: root', '-w', '.', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('repo root');
        expect(snapshot(ws)).toEqual(before);
    });

    test('refuses -w with no value', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: nothing', '-w', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('needs a workspace name or folder');
    });

    test('refuses -w in a single-package repo', () => {
        const { work } = freshSingleWithRemote();
        const before = snapshot(work);

        const res = vx(['-m', 'fix: plain', '-w', 'anything', '-dnp'], work);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('declares workspaces');
        expect(snapshot(work)).toEqual(before);
    });

    test('-d previews the resolved workspace and changes nothing', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: preview', '-w', 'apps/app-one', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('DRY RUN');
        expect(res.stdout).toContain('Workspace: app-one');
        expect(res.stdout).toContain('Directory: apps/app-one');
        expect(res.stdout).toContain('Version:   0.1.1 → 0.1.2');
        expect(res.stdout).not.toContain('app-two');
        expect(snapshot(ws)).toEqual(before);
        expect(readJson(path.join(ws, 'apps', 'app-one', 'package.json')).version).toBe('0.1.1');
    });

    test('-d works out the workspace from the current folder', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: preview', '-d'], path.join(ws, 'apps', 'app-two', 'src'));

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Workspace: app-two');
        expect(snapshot(ws)).toEqual(before);
    });

    test.each([
        ['a comma list', ['-w', 'app-one,app-two']],
        ['a repeated flag', ['-w', 'app-one', '-w', 'app-two']],
        ['space separated values', ['-w', 'app-one', 'app-two']],
        ['the --workspace= form', ['--workspace=app-one,app-two']]
    ])('-d previews two workspaces given as %s', (_label, selectorArgs) => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: preview', ...selectorArgs, '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Target 1 of 2');
        expect(res.stdout).toContain('Workspace: app-one');
        expect(res.stdout).toContain('Workspace: app-two');
        expect(snapshot(ws)).toEqual(before);
    });

    test('a single-package repo still gets the original dry run', () => {
        const { work } = freshSingleWithRemote();

        const res = vx(['-m', 'fix: plain preview', '-d', '-dnp'], work);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Would perform the following actions');
        expect(res.stdout).not.toContain('Target 1 of');
    });
});

// =============================================================================
// Workspace commit (-w)
// =============================================================================

describe('workspace commit (-w)', () => {
    const sorted = list => [...list].sort();

    test('runs from inside a workspace folder and bumps only that workspace', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: from inside app-one', '-dnp'], path.join(ws, 'apps', 'app-one'));

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
        expect(versionOf(ws, 'apps/app-two')).toBe('0.2.6');
        expect(readJson(path.join(ws, 'package.json')).version).toBeUndefined();
        expect(git(['log', '-1', '--format=%s'], ws)).toBe('fix: from inside app-one');
        expect(sorted(committedFiles(ws))).toEqual([
            'apps/app-one/CHANGELOG.md',
            'apps/app-one/package.json',
            'package-lock.json'
        ]);
        expect(git(['status', '--porcelain'], ws)).toBe('');
    });

    test("keeps another workspace's staged change out of the commit and still staged", () => {
        const ws = freshWorkspace();
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// pre-staged edit\n');
        git(['add', 'apps/app-two/src/main.js'], ws);

        const res = vx(['-m', 'fix: app-one only', '-w', 'apps/app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(committedFiles(ws).some(f => f.startsWith('apps/app-two/'))).toBe(false);
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('apps/app-two/src/main.js');
        expect(git(['status', '--porcelain'], ws)).toBe('M  apps/app-two/src/main.js');
    });

    test('with -a all, stages untracked files in the target and nowhere else', () => {
        const ws = freshWorkspace();
        writeFile(path.join(ws, 'apps', 'app-one', 'src', 'new-in-target.js'), '// new\n');
        writeFile(path.join(ws, 'apps', 'app-two', 'src', 'new-elsewhere.js'), '// new\n');

        const res = vx(['-m', 'fix: app-one only', '-w', 'apps/app-one', '-a', 'all', '-dnp'], ws);

        expect(res.status).toBe(0);
        const files = committedFiles(ws);
        expect(files).toContain('apps/app-one/src/new-in-target.js');
        expect(files).not.toContain('apps/app-two/src/new-elsewhere.js');
        expect(git(['status', '--porcelain'], ws)).toBe('?? apps/app-two/src/new-elsewhere.js');
    });

    test('with -a tracked, commits tracked changes in the target and leaves untracked files alone', () => {
        const ws = freshWorkspace();
        fs.appendFileSync(path.join(ws, 'apps', 'app-one', 'src', 'main.js'), '// tracked edit\n');
        writeFile(path.join(ws, 'apps', 'app-one', 'src', 'untracked.js'), '// new\n');
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// edit elsewhere\n');

        const res = vx(['-m', 'fix: tracked only', '-w', 'app-one', '-a', 'tracked', '-dnp'], ws);

        expect(res.status).toBe(0);
        const files = committedFiles(ws);
        expect(files).toContain('apps/app-one/src/main.js');
        expect(files).not.toContain('apps/app-one/src/untracked.js');
        expect(files.some(f => f.startsWith('apps/app-two/'))).toBe(false);
        expect(lines(statusOf(ws)).sort()).toEqual([
            ' M apps/app-two/src/main.js',
            '?? apps/app-one/src/untracked.js'
        ]);
    });

    test('without -a, commits only what is staged in the target, not a half-staged file in full', () => {
        const ws = freshWorkspace();
        const file = path.join(ws, 'apps', 'app-one', 'src', 'main.js');
        fs.appendFileSync(file, '// staged edit\n');
        git(['add', 'apps/app-one/src/main.js'], ws);
        fs.appendFileSync(file, '// unstaged edit\n');

        const res = vx(['-m', 'fix: staged part only', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        const committed = git(['show', 'HEAD:apps/app-one/src/main.js'], ws);
        expect(committed).toContain('// staged edit');
        expect(committed).not.toContain('// unstaged edit');
        expect(fs.readFileSync(file, 'utf8')).toContain('// unstaged edit');
        expect(statusOf(ws)).toBe(' M apps/app-one/src/main.js');
    });

    test('leaves no temporary index behind', () => {
        const ws = freshWorkspace();

        vx(['-m', 'fix: tidy', '-w', 'app-one', '-dnp'], ws);

        const leftovers = fs.readdirSync(path.join(ws, '.git')).filter(name => name.includes('vnxt'));
        expect(leftovers).toEqual([]);
    });

    test('puts the changelog inside the workspace folder, and not at the root', () => {
        const ws = freshWorkspace();

        vx(['-m', 'fix: changelog', '-w', 'app-one', '-dnp'], ws);

        const changelog = fs.readFileSync(path.join(ws, 'apps', 'app-one', 'CHANGELOG.md'), 'utf8');
        expect(changelog).toContain('[0.1.2]');
        expect(changelog).toContain('fix: changelog');
        expect(fs.existsSync(path.join(ws, 'CHANGELOG.md'))).toBe(false);
    });

    test('autoChangelog: false in the root config is respected', () => {
        const ws = freshWorkspace();
        writeFile(path.join(ws, '.vnxtrc.json'), JSON.stringify({ autoChangelog: false }, null, 2));
        git(['add', '.vnxtrc.json'], ws);
        git(['commit', '-q', '-m', 'add config'], ws);

        vx(['-m', 'fix: no changelog', '-w', 'app-one', '-dnp'], ws);

        expect(sorted(committedFiles(ws))).toEqual(['apps/app-one/package.json', 'package-lock.json']);
    });

    test.each([
        ['feat: adds a thing', [], '0.2.0'],
        ['fix: mends a thing', [], '0.1.2'],
        ['chore: whatever', ['-t', 'major'], '1.0.0'],
        ['chore: set exactly', ['-sv', '0.5.0'], '0.5.0']
    ])('"%s" with %j gives app-one %s', (message, extra, expected) => {
        const ws = freshWorkspace();

        const res = vx(['-m', message, '-w', 'app-one', ...extra, '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe(expected);
    });

    test('-q is quiet', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: quiet', '-w', 'app-one', '-q', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('');
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
    });

    test('with the default autoPush on, a real run commits but never pushes', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);
        const remoteHead = git(['rev-parse', 'refs/heads/main'], remote);

        const res = vx(['-m', 'fix: stays local', '-w', 'app-one'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Not pushed');
        expect(git(['rev-parse', 'refs/heads/main'], remote)).toBe(remoteHead);
        expect(git(['log', '-1', '--format=%s'], ws)).toBe('fix: stays local');
    });
});

// =============================================================================
// Workspace commit: hooks
// =============================================================================

describe('workspace commit: git hooks', () => {
    test('a pre-commit hook runs, and what it adds ends up in the commit with no phantom changes', () => {
        const ws = freshWorkspace();
        installHook(ws, 'pre-commit', 'echo "// formatted" >> apps/app-one/src/main.js\ngit add apps/app-one/src/main.js');

        const res = vx(['-m', 'fix: hooked', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(git(['show', 'HEAD:apps/app-one/src/main.js'], ws)).toContain('// formatted');
        expect(git(['status', '--porcelain'], ws)).toBe('');
    });

    test('a hook that rejects the commit rolls the version bump back', () => {
        const ws = freshWorkspace();
        installHook(ws, 'pre-commit', 'echo "rejected on purpose" >&2\nexit 1');
        const manifestBefore = fs.readFileSync(path.join(ws, 'apps', 'app-one', 'package.json'), 'utf8');
        const lockBefore = fs.readFileSync(path.join(ws, 'package-lock.json'), 'utf8');
        const headBefore = git(['rev-parse', 'HEAD'], ws);
        writeFile(path.join(ws, 'apps', 'app-one', 'src', 'extra.js'), '// extra\n');

        const res = vx(['-m', 'fix: refused', '-w', 'app-one', '-a', 'all', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('rolled back');
        expect(git(['rev-parse', 'HEAD'], ws)).toBe(headBefore);
        expect(fs.readFileSync(path.join(ws, 'apps', 'app-one', 'package.json'), 'utf8')).toBe(manifestBefore);
        expect(fs.readFileSync(path.join(ws, 'package-lock.json'), 'utf8')).toBe(lockBefore);
        expect(fs.existsSync(path.join(ws, 'apps', 'app-one', 'CHANGELOG.md'))).toBe(false);

        const staged = lines(git(['diff', '--cached', '--name-only'], ws));
        expect(staged).not.toContain('apps/app-one/package.json');
        expect(staged).not.toContain('package-lock.json');
        expect(staged).not.toContain('apps/app-one/CHANGELOG.md');
        expect(fs.readdirSync(path.join(ws, '.git')).filter(name => name.includes('vnxt'))).toEqual([]);
    });
});

// =============================================================================
// Workspace commit: the lockfile
// =============================================================================

describe('workspace commit: the lockfile', () => {
    test('only the workspace\'s own entry changes in the committed lockfile', () => {
        const ws = freshWorkspace();
        const before = JSON.parse(git(['show', 'HEAD:package-lock.json'], ws));

        vx(['-m', 'fix: lock check', '-w', 'app-one', '-dnp'], ws);

        const after = JSON.parse(git(['show', 'HEAD:package-lock.json'], ws));
        const changed = Object.keys(after.packages).filter(
            key => JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key])
        );
        expect(changed).toEqual(['apps/app-one']);
    });

    test('refuses when the lockfile already has uncommitted changes, and changes nothing', () => {
        const ws = freshWorkspace();
        const lockFile = path.join(ws, 'package-lock.json');
        fs.appendFileSync(lockFile, '\n');
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: dirty lock', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('package-lock.json has uncommitted changes');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('leaves a stale entry for another workspace alone, and still bumps', () => {
        const ws = freshWorkspace();
        const lockFile = path.join(ws, 'package-lock.json');
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        lock.packages['apps/app-two'].version = '9.9.9'; // a stale entry for the other app
        fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'stale lockfile entry'], ws);

        const res = vx(['-m', 'fix: despite stale lock', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        const before = JSON.parse(git(['show', 'HEAD~1:package-lock.json'], ws));
        const after = JSON.parse(git(['show', 'HEAD:package-lock.json'], ws));
        const changed = Object.keys(after.packages).filter(
            key => JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key])
        );
        expect(changed).toEqual(['apps/app-one']);
        expect(after.packages['apps/app-two'].version).toBe('9.9.9');
        expect(git(['status', '--porcelain'], ws)).toBe('');
    });

    test('installs nothing: no node_modules appears, and the lockfile entry still matches the manifest', () => {
        const ws = freshWorkspace();
        expect(fs.existsSync(path.join(ws, 'node_modules'))).toBe(false);

        const res = vx(['-m', 'fix: no install', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(fs.existsSync(path.join(ws, 'node_modules'))).toBe(false);
        const lock = JSON.parse(fs.readFileSync(path.join(ws, 'package-lock.json'), 'utf8'));
        expect(lock.packages['apps/app-one'].version).toBe('0.1.2');
    });

    test('keeps a CRLF lockfile as CRLF, changing exactly one line', () => {
        const ws = freshWorkspace();
        const lockFile = path.join(ws, 'package-lock.json');
        fs.writeFileSync(lockFile, fs.readFileSync(lockFile, 'utf8').replace(/\r?\n/g, '\r\n'));
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'lockfile with CRLF line endings'], ws);

        const res = vx(['-m', 'fix: crlf lock', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        const committed = git(['show', 'HEAD:package-lock.json'], ws);
        expect((committed.match(/\r\n/g) || []).length).toBe((committed.match(/\n/g) || []).length);
        expect(git(['diff', '--numstat', 'HEAD~1', 'HEAD', '--', 'package-lock.json'], ws)).toBe('1\t1\tpackage-lock.json');
    });

    test('refuses a lockfile it cannot edit safely, and changes nothing', () => {
        const ws = freshWorkspace();
        const lockFile = path.join(ws, 'package-lock.json');
        fs.writeFileSync(lockFile, JSON.stringify(JSON.parse(fs.readFileSync(lockFile, 'utf8'))) + '\n'); // minified
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'minified lockfile'], ws);
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: odd lock', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('cannot edit safely');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('a repo with no lockfile still works, and does not gain one', () => {
        const ws = freshWorkspace();
        git(['rm', '-q', 'package-lock.json'], ws);
        git(['commit', '-q', '-m', 'drop lockfile'], ws);

        const res = vx(['-m', 'fix: no lockfile', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(fs.existsSync(path.join(ws, 'package-lock.json'))).toBe(false);
        expect(committedFiles(ws)).not.toContain('package-lock.json');
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
    });
});

// =============================================================================
// Workspace commit: what is refused for now
// =============================================================================

describe('workspace commit: not supported yet', () => {
    test.each([
        ['-r', ['-r'], 'not supported in workspace mode yet'],
        ['--publish', ['--publish'], 'not supported in workspace mode yet'],
        ['-p', ['-p'], 'not supported in workspace mode yet'],
        ['-a p', ['-a', 'p'], 'not supported in workspace mode yet'],
        ['-a i', ['-a', 'i'], 'not supported in workspace mode yet'],
        ['several workspaces', ['-w', 'app-two'], 'One workspace at a time']
    ])('%s is refused, and nothing changes', (_label, extra, expected) => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: nope', '-w', 'app-one', ...extra], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(expected);
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('a bare -a (which would prompt) is refused, and nothing changes', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: nope', '-w', 'app-one', '-dnp', '-a'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('needs a staging mode');
        expect(snapshot(ws)).toEqual(before);
    });

    test('a real run without -m is refused, and nothing changes', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-w', 'app-one', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('-m is required');
        expect(snapshot(ws)).toEqual(before);
    });

    test('a refused flag is refused in a dry run as well', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: nope', '-w', 'app-one', '-r', '-d'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('not supported in workspace mode yet');
    });
});

// =============================================================================
// Workspace preview (-d)
// =============================================================================

describe('workspace preview (-d) for one workspace', () => {
    test('shows the new version, what changes, what is staged elsewhere and the exact commands', () => {
        const ws = freshWorkspace();
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// staged elsewhere\n');
        git(['add', 'apps/app-two/src/main.js'], ws);
        writeFile(path.join(ws, 'apps', 'app-one', 'src', 'fresh.js'), '// fresh\n');
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: look first', '-w', 'app-one', '-a', 'all', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Version:   0.1.1 → 0.1.2');
        expect(res.stdout).toContain('apps/app-one/src/fresh.js');
        expect(res.stdout).toContain('apps/app-one/CHANGELOG.md (new)');
        expect(res.stdout).toContain("package-lock.json (this workspace's entry only)");
        expect(res.stdout).toContain('Staged elsewhere, left staged and out of this commit:\n  apps/app-two/src/main.js');
        expect(res.stdout).toContain('npm version patch --git-tag-version=false --workspaces-update=false');
        expect(res.stdout).toContain("so npm installs nothing");
        expect(res.stdout).toContain('git add -A -- apps/app-one');
        expect(res.stdout).toContain('git commit -m "fix: look first"');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('shows the version -sv would set', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'chore: baseline', '-w', 'app-one', '-sv', '2.0.0', '-d'], ws);

        expect(res.stdout).toContain('Version:   0.1.1 → 2.0.0');
    });

    test('says when a real run would stop', () => {
        const ws = freshWorkspace();
        fs.appendFileSync(path.join(ws, 'package-lock.json'), '\n');

        const res = vx(['-m', 'fix: look first', '-w', 'app-one', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: package-lock.json has uncommitted changes');
    });

    // A preversion script that leaves a marker at a path the test knows, wherever npm runs it.
    function addPreversionMarker(ws) {
        const marker = path.join(tmpRoot, `ran-preversion-${++counter}.txt`).replace(/\\/g, '/');
        const manifestPath = path.join(ws, 'apps', 'app-one', 'package.json');
        const manifest = readJson(manifestPath);
        manifest.scripts = { preversion: `node -e "require('fs').writeFileSync('${marker}', 'x')"` };
        writeJson(manifestPath, manifest);
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'add a preversion script'], ws);
        return marker;
    }

    test('says when the lockfile is formatted in a way a real run could not edit', () => {
        const ws = freshWorkspace();
        const lockFile = path.join(ws, 'package-lock.json');
        fs.writeFileSync(lockFile, JSON.stringify(JSON.parse(fs.readFileSync(lockFile, 'utf8'))) + '\n'); // minified
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'minified lockfile'], ws);

        const res = vx(['-m', 'fix: look first', '-w', 'app-one', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: package-lock.json is formatted in a way vnxt cannot edit safely');
    });

    test('never runs scripts from the workspace', () => {
        const ws = freshWorkspace();
        const marker = addPreversionMarker(ws);

        const res = vx(['-m', 'fix: look first', '-w', 'app-one', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Version:   0.1.1 → 0.1.2');
        expect(fs.existsSync(marker)).toBe(false);
    });

    test('a real run still lets npm run the workspace\'s own version scripts, as before', () => {
        const ws = freshWorkspace();
        const marker = addPreversionMarker(ws);

        const res = vx(['-m', 'fix: for real', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(fs.existsSync(marker)).toBe(true);
    });
});

// =============================================================================
// Tag handling in a plain single-package repo
// =============================================================================

describe('single-package repo: tag handling', () => {
    test('puts the version tag on the final commit and pushes it', () => {
        const { work } = freshSingleWithRemote();
        const res = vx(['-m', 'fix: tag check', '-c', '-p'], work);

        expect(res.status).toBe(0);
        expect(git(['rev-parse', 'v1.0.1^{commit}'], work)).toBe(git(['rev-parse', 'HEAD'], work));
        expect(git(['ls-remote', '--tags', 'origin', 'v1.0.1'], work)).not.toBe('');
    });

    test('keeps the tag on the final commit when changelog and release notes are generated', () => {
        const { work } = freshSingleWithRemote();
        const res = vx(['-m', 'fix: notes and changelog', '-c', '-r', '-dnp'], work);

        expect(res.status).toBe(0);
        expect(committedFiles(work)).toEqual(
            expect.arrayContaining(['CHANGELOG.md', 'release-notes/v1.0.1.md'])
        );
        expect(git(['rev-parse', 'v1.0.1^{commit}'], work)).toBe(git(['rev-parse', 'HEAD'], work));
        expect(git(['rev-list', '--count', 'HEAD'], work)).toBe('2'); // initial commit plus one release commit
    });

    test('--publish pushes the version tag and the publish tag, both on the final commit', () => {
        const { work } = freshSingleWithRemote();
        const res = vx(['-m', 'fix: publish check', '--publish'], work);

        expect(res.status).toBe(0);
        const head = git(['rev-parse', 'HEAD'], work);
        expect(git(['rev-parse', 'v1.0.1^{commit}'], work)).toBe(head);
        expect(git(['rev-parse', 'publish/v1.0.1^{commit}'], work)).toBe(head);
        expect(git(['ls-remote', '--tags', 'origin', 'v1.0.1'], work)).not.toBe('');
        expect(git(['ls-remote', '--tags', 'origin', 'publish/v1.0.1'], work)).not.toBe('');
    });

    test('--publish release notes list this release first, then everything since the last publish tag', () => {
        const { work } = freshSingleWithRemote();
        git(['tag', 'publish/v1.0.0'], work);
        for (const subject of ['chore: first since publish', 'chore: second since publish']) {
            fs.appendFileSync(path.join(work, 'notes.txt'), `${subject}\n`);
            git(['add', 'notes.txt'], work);
            git(['commit', '-q', '-m', subject], work);
        }

        vx(['-m', 'fix: the release itself', '--publish'], work);

        const notes = fs.readFileSync(path.join(work, 'release-notes', 'v1.0.1.md'), 'utf8');
        const changes = lines(notes.split('## Changes')[1].split('## Installation')[0]);
        expect(changes).toEqual([
            '- fix: the release itself',
            '- chore: second since publish',
            '- chore: first since publish'
        ]);
    });
});
