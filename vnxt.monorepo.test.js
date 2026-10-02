// vnxt.monorepo.test.js
//
// Monorepo work, step 1: a fixture builder, plus tests that pin the problems
// in vnxt 1.15.3 that the monorepo work has to fix.
//
// The four test.failing cases describe the behaviour we WANT. Each one passes
// while vnxt is wrong and starts failing once vnxt is fixed. That failure is
// the cue to turn the case into a normal test in the step that fixes it.
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
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error
    };
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
// Workspace behaviour we want (currently failing)
// =============================================================================

describe('monorepo: behaviour we want, not yet built', () => {
    test.failing('runs from inside a workspace folder and bumps only that workspace', () => {
        const ws = freshWorkspace();
        const res = vx(['-m', 'fix: from inside app-one', '-dnp'], path.join(ws, 'apps', 'app-one'));

        expect(res.status).toBe(0);
        expect(readJson(path.join(ws, 'apps', 'app-one', 'package.json')).version).toBe('0.1.2');
        expect(readJson(path.join(ws, 'apps', 'app-two', 'package.json')).version).toBe('0.2.6');
    });

    test.failing('refuses to run from the repo root without a workspace selector', () => {
        const ws = freshWorkspace();
        const res = vx(['-m', 'fix: from the root', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(readJson(path.join(ws, 'package.json')).version).toBeUndefined();
        expect(git(['tag'], ws)).toBe('');
    });

    test.failing("keeps another workspace's staged change out of the commit and still staged", () => {
        const ws = freshWorkspace();
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// pre-staged edit\n');
        git(['add', 'apps/app-two/src/main.js'], ws);

        vx(['-m', 'fix: app-one only', '-w', 'apps/app-one', '-dnp'], ws);

        const files = committedFiles(ws);
        expect(files.some(f => f.startsWith('apps/app-two/'))).toBe(false);
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('apps/app-two/src/main.js');
    });

    test.failing('with -a all, stages untracked files in the target and nowhere else', () => {
        const ws = freshWorkspace();
        writeFile(path.join(ws, 'apps', 'app-one', 'src', 'new-in-target.js'), '// new\n');
        writeFile(path.join(ws, 'apps', 'app-two', 'src', 'new-elsewhere.js'), '// new\n');

        vx(['-m', 'fix: app-one only', '-w', 'apps/app-one', '-a', 'all', '-dnp'], ws);

        const files = committedFiles(ws);
        expect(files).toContain('apps/app-one/src/new-in-target.js');
        expect(files).not.toContain('apps/app-two/src/new-elsewhere.js');
        expect(git(['status', '--porcelain'], ws)).toBe('?? apps/app-two/src/new-elsewhere.js');
    });
});

// =============================================================================
// Tag handling in a plain single-package repo (currently failing)
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
