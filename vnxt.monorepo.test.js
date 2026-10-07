// vnxt.monorepo.test.js
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

// Repo-local git config, so the machine's own settings cannot affect tests
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

// Runs vnxt without a shell, so quoting is identical on Windows and Linux
function vx(args, cwd, input = '\n\n\n\n\n') {
    const result = spawnSync(process.execPath, [vnxtPath, ...args], {
        cwd,
        encoding: 'utf8',
        input
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

// git status --porcelain without trimming the leading space
function statusOf(repoDir) {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' })
        .replace(/\r?\n$/, '');
}

// Everything a refused or preview-only run must leave untouched
function snapshot(repoDir) {
    return {
        head: git(['rev-parse', 'HEAD'], repoDir),
        status: git(['status', '--porcelain'], repoDir),
        tags: git(['tag'], repoDir)
    };
}

// Points the repo at a hooks folder holding one hook
function installHook(repoDir, name, body) {
    const dir = path.join(tmpRoot, `hooks-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
    git(['config', 'core.hooksPath', dir.replace(/\\/g, '/')], repoDir);
}

// Gives a fixture repo a local bare remote, and returns the remote's path
function addRemote(repoDir) {
    const remote = path.join(tmpRoot, `remote-${++counter}.git`);
    fs.mkdirSync(remote);
    git(['init', '-q', '--bare', '-b', 'main'], remote);
    git(['remote', 'add', 'origin', remote], repoDir);
    git(['push', '-q', '-u', 'origin', 'main'], repoDir);
    return remote;
}

// Files touched by the most recent commit, with forward slashes
function committedFiles(cwd) {
    return lines(git(['show', '--name-only', '--format=', 'HEAD'], cwd));
}

// Stand-in monorepo: two apps and three shared packages
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

    execSync('npm install --offline --no-audit --no-fund --ignore-scripts', {
        cwd: templateDir,
        stdio: 'pipe'
    });

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

// A plain single-package repo with a local bare remote, for the tag tests
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
});

describe('workspace tags and pushing', () => {
    const remoteHas = (repoDir, tag) => git(['ls-remote', '--tags', 'origin', tag], repoDir) !== '';
    const remoteMain = remote => git(['rev-parse', 'refs/heads/main'], remote);

    test('tags the commit <name>@<version>, annotated, on the final commit', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: tagged', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Tag: app-one@0.1.2');
        expect(git(['tag'], ws)).toBe('app-one@0.1.2');
        expect(git(['cat-file', '-t', 'refs/tags/app-one@0.1.2'], ws)).toBe('tag');
        expect(git(['rev-parse', 'app-one@0.1.2^{commit}'], ws)).toBe(git(['rev-parse', 'HEAD'], ws));
        const annotation = git(['tag', '-l', '--format=%(contents)', 'app-one@0.1.2'], ws);
        expect(annotation).toContain('Version 0.1.2');
        expect(annotation).toContain('fix: tagged');
    });

    test('drops the leading @ of a scoped name in the tag', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: scoped', '-w', '@fixture/shared-theme', '-dnp'], ws);

        expect(res.status).toBe(0);
        expect(git(['tag'], ws)).toBe('fixture/shared-theme@0.0.1');
        expect(git(['rev-parse', 'fixture/shared-theme@0.0.1^{commit}'], ws)).toBe(git(['rev-parse', 'HEAD'], ws));
    });

    test('two workspaces at the same version no longer collide', () => {
        const ws = freshWorkspace();
        const manifestPath = path.join(ws, 'apps', 'app-two', 'package.json');
        writeJson(manifestPath, { ...readJson(manifestPath), version: '0.1.1' });
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'line the versions up'], ws);

        expect(vx(['-m', 'fix: one', '-w', 'app-one', '-dnp'], ws).status).toBe(0);
        expect(vx(['-m', 'fix: two', '-w', 'app-two', '-dnp'], ws).status).toBe(0);

        expect(lines(git(['tag'], ws)).sort()).toEqual(['app-one@0.1.2', 'app-two@0.1.2']);
    });

    test('tagPrefix is ignored in workspace mode', () => {
        const ws = freshWorkspace();
        writeFile(path.join(ws, '.vnxtrc.json'), JSON.stringify({ tagPrefix: 'rel-' }, null, 2));
        git(['add', '.vnxtrc.json'], ws);
        git(['commit', '-q', '-m', 'add config'], ws);

        vx(['-m', 'fix: prefix', '-w', 'app-one', '-dnp'], ws);

        expect(git(['tag'], ws)).toBe('app-one@0.1.2');
    });

    test('a tag that already exists is caught before committing, and everything is rolled back', () => {
        const ws = freshWorkspace();
        git(['tag', '-a', 'app-one@0.1.2', '-m', 'an old tag'], ws);
        fs.appendFileSync(path.join(ws, 'apps', 'app-one', 'src', 'main.js'), '// a change since the old tag\n');
        git(['add', 'apps/app-one/src/main.js'], ws);
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: clash', '-w', 'app-one', '-dnp'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('app-one@0.1.2 already exists');
        expect(res.stderr).toContain('rolled back');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
        expect(fs.existsSync(path.join(ws, 'apps', 'app-one', 'CHANGELOG.md'))).toBe(false);
    });

    test('-p pushes the commit and the tag', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);

        const res = vx(['-m', 'fix: pushed', '-w', 'app-one', '-p'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Pushed with tags');
        expect(remoteMain(remote)).toBe(git(['rev-parse', 'HEAD'], ws));
        expect(remoteHas(ws, 'app-one@0.1.2')).toBe(true);
    });

    test('autoPush in the config does not push in workspace mode, and the run says so', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);
        const remoteBefore = remoteMain(remote);

        const res = vx(['-m', 'fix: held', '-w', 'app-one'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('autoPush is ignored in workspace mode');
        expect(remoteMain(remote)).toBe(remoteBefore);
        expect(remoteHas(ws, 'app-one@0.1.2')).toBe(false);
        expect(git(['tag'], ws)).toBe('app-one@0.1.2');
        expect(res.stdout).not.toContain('Pushed with tags');
    });

    test('-p still pushes when the config has autoPush on, and the note is not shown', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);

        const res = vx(['-m', 'fix: sent', '-w', 'app-one', '-p'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).not.toContain('autoPush is ignored');
        expect(remoteMain(remote)).toBe(git(['rev-parse', 'HEAD'], ws));
        expect(remoteHas(ws, 'app-one@0.1.2')).toBe(true);
    });

    test('-dnp and autoPush: false both stay quiet about autoPush', () => {
        const flagged = freshWorkspace();
        expect(vx(['-m', 'fix: a', '-w', 'app-one', '-dnp'], flagged).stdout).not.toContain('autoPush is ignored');

        const off = freshWorkspace();
        writeJson(path.join(off, '.vnxtrc.json'), {autoPush: false});
        git(['add', '.vnxtrc.json'], off);
        git(['commit', '-q', '-m', 'config'], off);
        expect(vx(['-m', 'fix: b', '-w', 'app-one'], off).stdout).not.toContain('autoPush is ignored');
    });

    test('several workspaces with autoPush on make their commits and tags but push nothing', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);
        const remoteBefore = remoteMain(remote);

        const res = vx(['-m', 'fix: both', '-w', 'app-one', '-w', 'app-two'], ws);

        expect(res.status).toBe(0);
        expect(lines(git(['tag'], ws))).toEqual(['app-one@0.1.2', 'app-two@0.2.7']);
        expect(remoteMain(remote)).toBe(remoteBefore);
        expect(remoteHas(ws, 'app-one@0.1.2')).toBe(false);
        expect(remoteHas(ws, 'app-two@0.2.7')).toBe(false);
    });

    describe('workspaceAutoPush', () => {
        const withConfig = (config) => {
            const ws = freshWorkspace();
            writeJson(path.join(ws, '.vnxtrc.json'), config);
            git(['add', '.vnxtrc.json'], ws);
            git(['commit', '-q', '-m', 'config'], ws);
            const remote = addRemote(ws);
            return { ws, remote, before: remoteMain(remote) };
        };

        test('true pushes the commit and the tag with no -p, and the note is not shown', () => {
            const { ws, remote } = withConfig({ workspaceAutoPush: true });

            const res = vx(['-m', 'fix: sent', '-w', 'app-one'], ws);

            expect(res.status).toBe(0);
            expect(res.stdout).not.toContain('autoPush is ignored');
            expect(remoteMain(remote)).toBe(git(['rev-parse', 'HEAD'], ws));
            expect(remoteHas(ws, 'app-one@0.1.2')).toBe(true);
        });

        test('true pushes once for several workspaces', () => {
            const { ws, remote } = withConfig({ autoPush: false, workspaceAutoPush: true });

            const res = vx(['-m', 'fix: both', '-w', 'app-one', '-w', 'app-two'], ws);

            expect(res.status).toBe(0);
            expect(remoteMain(remote)).toBe(git(['rev-parse', 'HEAD'], ws));
            expect(remoteHas(ws, 'app-one@0.1.2')).toBe(true);
            expect(remoteHas(ws, 'app-two@0.2.7')).toBe(true);
        });

        test('-dnp overrides true', () => {
            const { ws, remote, before } = withConfig({ workspaceAutoPush: true });

            const res = vx(['-m', 'fix: held', '-w', 'app-one', '-dnp'], ws);

            expect(res.status).toBe(0);
            expect(remoteMain(remote)).toBe(before);
            expect(remoteHas(ws, 'app-one@0.1.2')).toBe(false);
        });

        test('-dnp wins over -p', () => {
            const { ws, remote, before } = withConfig({ workspaceAutoPush: true });

            const res = vx(['-m', 'fix: held', '-w', 'app-one', '-p', '-dnp'], ws);

            expect(res.status).toBe(0);
            expect(remoteMain(remote)).toBe(before);
        });

        test.each([
            ['false', false],
            ['the string "true"', 'true'],
            ['1', 1],
            ['null', null]
        ])('%s does not push', (label, value) => {
            const { ws, remote, before } = withConfig({ workspaceAutoPush: value });

            const res = vx(['-m', 'fix: held', '-w', 'app-one'], ws);

            expect(res.status).toBe(0);
            expect(remoteMain(remote)).toBe(before);
            expect(remoteHas(ws, 'app-one@0.1.2')).toBe(false);
        });

        test('the setting does not affect a single-package repo, which still follows autoPush', () => {
            const run = (config) => {
                const { work, remote } = freshSingleWithRemote();
                writeJson(path.join(work, '.vnxtrc.json'), config);
                git(['add', '.vnxtrc.json'], work);
                git(['commit', '-q', '-m', 'config'], work);
                const before = remoteMain(remote);
                const res = vx(['-m', 'fix: single'], work);
                expect(res.status).toBe(0);
                return remoteMain(remote) !== before;
            };

            expect(run({ autoPush: true, workspaceAutoPush: false })).toBe(true);
            expect(run({ autoPush: false, workspaceAutoPush: true })).toBe(false);
        });

        test('the dry run says it would push, once', () => {
            const { ws } = withConfig({ workspaceAutoPush: true });

            const res = vx(['-m', 'fix: look', '-w', 'app-one,app-two', '-d'], ws, '');

            expect(res.status).toBe(0);
            expect(res.stdout.match(/Push: yes/g)).toHaveLength(1);
        });
    });

    test('the dry run says it will not push when only autoPush is set', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: look', '-w', 'app-one', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Push: no (use -p to push)');
        expect(res.stdout).not.toContain('Push: yes');
    });

    test('an earlier unpushed annotated tag goes up with the push, and the preview says so', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);
        git(['tag', '-a', 'earlier@9.9.9', '-m', 'made earlier, never pushed'], ws);
        const before = snapshot(ws);
        const remoteBefore = remoteMain(remote);

        const preview = vx(['-m', 'fix: look', '-w', 'app-one', '-p', '-d'], ws);

        expect(preview.status).toBe(0);
        expect(preview.stdout).toContain('Tag:       app-one@0.1.2');
        expect(preview.stdout).toContain('git push --follow-tags');
        expect(preview.stdout).toContain('Tags already made locally that this push would also send:\n  earlier@9.9.9');
        expect(snapshot(ws)).toEqual(before);
        expect(remoteMain(remote)).toBe(remoteBefore);
        expect(remoteHas(ws, 'earlier@9.9.9')).toBe(false);

        vx(['-m', 'fix: for real', '-w', 'app-one', '-p'], ws);

        expect(remoteHas(ws, 'earlier@9.9.9')).toBe(true);
        expect(remoteHas(ws, 'app-one@0.1.2')).toBe(true);
    });

    test('pushing with no remote is refused before anything changes', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: nowhere', '-w', 'app-one', '-p'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('No remote repository');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('pushing from a branch with no upstream is refused before anything changes', () => {
        const ws = freshWorkspace();
        const remote = path.join(tmpRoot, `remote-${++counter}.git`);
        fs.mkdirSync(remote);
        git(['init', '-q', '--bare', '-b', 'main'], remote);
        git(['remote', 'add', 'origin', remote], ws);
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: no upstream', '-w', 'app-one', '-p'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('no upstream');
        expect(snapshot(ws)).toEqual(before);
    });

    test('pushing from a detached HEAD is refused before anything changes', () => {
        const ws = freshWorkspace();
        addRemote(ws);
        git(['checkout', '-q', '--detach'], ws);
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: detached', '-w', 'app-one', '-p'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('detached');
        expect(snapshot(ws)).toEqual(before);
    });

    test('a push the remote rejects is reported, and the commit and tag stay local', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);
        const hook = path.join(remote, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, '#!/bin/sh\necho "rejected on purpose" >&2\nexit 1\n');
        fs.chmodSync(hook, 0o755);
        const remoteBefore = remoteMain(remote);

        const res = vx(['-m', 'fix: refused push', '-w', 'app-one', '-p'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('made locally, but the push failed');
        expect(res.stderr).toContain('git push --follow-tags');
        expect(git(['tag'], ws)).toBe('app-one@0.1.2');
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
        expect(git(['log', '-1', '--format=%s'], ws)).toBe('fix: refused push');
        expect(remoteMain(remote)).toBe(remoteBefore);
    });

    test('the preview warns when the tag already exists', () => {
        const ws = freshWorkspace();
        git(['tag', '-a', 'app-one@0.1.2', '-m', 'an old tag'], ws);

        const res = vx(['-m', 'fix: look', '-w', 'app-one', '-dnp', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: the tag app-one@0.1.2 already exists');
    });

    test('the preview warns when pushing is not possible', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: look', '-w', 'app-one', '-p', '-d'], ws);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: No remote repository');
    });
});

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
        lock.packages['apps/app-two'].version = '9.9.9';
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
        fs.writeFileSync(lockFile, JSON.stringify(JSON.parse(fs.readFileSync(lockFile, 'utf8'))) + '\n');
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

describe('workspace staging: -a patch and -a interactive', () => {
    const NOTES = 'apps/app-one/src/notes.js';

    // A committed 30 line file with two edits far enough apart to be two hunks
    function twoHunkWorkspace() {
        const ws = freshWorkspace();
        const original = Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`);
        writeFile(path.join(ws, NOTES), original.join('\n') + '\n');
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'add notes'], ws);

        const edited = [...original];
        edited[1] = 'line 2 EDITED';
        edited[28] = 'line 29 EDITED';
        writeFile(path.join(ws, NOTES), edited.join('\n') + '\n');
        return ws;
    }

    const committedNotes = ws => git(['show', 'HEAD', '--', NOTES], ws);
    const tempIndexes = ws => fs.readdirSync(path.join(ws, '.git')).filter(name => name.includes('.vnxt-'));
    const run = (ws, mode, answers, extra = []) => vx(['-m', 'fix: picked', '-w', 'app-one', '-dnp', '-a', mode, ...extra], ws, answers);

    test('-a p commits only the hunks chosen, and leaves the rest in the working tree', () => {
        const ws = twoHunkWorkspace();

        const res = run(ws, 'p', 'y\nn\n');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('y  stage this hunk');
        expect(res.stdout).toContain('q  quit, staging nothing more');
        expect(res.stdout).toContain('Choosing nothing stops the run and changes nothing.');
        expect(committedNotes(ws)).toContain('+line 2 EDITED');
        expect(committedNotes(ws)).not.toContain('line 29 EDITED');
        expect([...committedFiles(ws)].sort()).toEqual([NOTES, 'apps/app-one/CHANGELOG.md', 'apps/app-one/package.json', 'package-lock.json'].sort());
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
        expect(git(['tag', '--list', 'app-one@0.1.2'], ws)).toBe('app-one@0.1.2');
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('');
        expect(statusOf(ws)).toBe(` M ${NOTES}`);
        expect(fs.readFileSync(path.join(ws, NOTES), 'utf8')).toContain('line 29 EDITED');
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a p can take the second hunk and leave the first', () => {
        const ws = twoHunkWorkspace();

        const res = run(ws, 'p', 'n\ny\n');

        expect(res.status).toBe(0);
        expect(committedNotes(ws)).toContain('+line 29 EDITED');
        expect(committedNotes(ws)).not.toContain('line 2 EDITED');
    });

    test('-a p with nothing selected aborts with an error, and nothing changes', () => {
        const ws = twoHunkWorkspace();
        const before = snapshot(ws);

        const res = run(ws, 'p', 'n\nn\n');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('You have not selected any changes in apps/app-one');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
        expect(fs.existsSync(path.join(ws, 'apps/app-one/CHANGELOG.md'))).toBe(false);
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a p quitting straight away aborts the same way', () => {
        const ws = twoHunkWorkspace();
        const before = snapshot(ws);

        const res = run(ws, 'p', 'q\n');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('You have not selected any changes');
        expect(snapshot(ws)).toEqual(before);
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a p keeps another workspace\'s staged change out of the commit and still staged', () => {
        const ws = twoHunkWorkspace();
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// pre-staged edit\n');
        git(['add', 'apps/app-two/src/main.js'], ws);

        const res = run(ws, 'p', 'y\nn\n');

        expect(res.status).toBe(0);
        expect(committedFiles(ws)).not.toContain('apps/app-two/src/main.js');
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('apps/app-two/src/main.js');
    });

    test('-a p offers only this workspace\'s changes', () => {
        const ws = twoHunkWorkspace();
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// unstaged edit elsewhere\n');

        const res = run(ws, 'p', 'y\nn\n');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('line 2 EDITED');
        expect(res.stdout).not.toContain('unstaged edit elsewhere');
        expect(statusOf(ws)).toContain(' M apps/app-two/src/main.js');
    });

    test('-a p counts a change already staged in the workspace as selected', () => {
        const ws = twoHunkWorkspace();
        git(['add', NOTES], ws);
        writeFile(path.join(ws, 'apps/app-one/src/other.js'), 'x\n');
        git(['add', 'apps/app-one/src/other.js'], ws);

        const res = run(ws, 'p', '\n');

        expect(res.status).toBe(0);
        expect(committedFiles(ws)).toEqual(expect.arrayContaining([NOTES, 'apps/app-one/src/other.js']));
    });

    test('-a p refuses when the manifest has edits of its own, and nothing changes', () => {
        const ws = twoHunkWorkspace();
        const manifest = path.join(ws, 'apps/app-one/package.json');
        const data = readJson(manifest);
        data.description = 'an unrelated edit';
        writeJson(manifest, data);
        const before = snapshot(ws);

        const res = run(ws, 'p', 'y\ny\n');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('apps/app-one/package.json has uncommitted changes');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('-a p stops before asking anything when the tag already exists', () => {
        const ws = twoHunkWorkspace();
        git(['tag', '-a', 'app-one@0.1.2', '-m', 'old'], ws);
        const before = snapshot(ws);

        const res = run(ws, 'p', 'y\ny\n');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('app-one@0.1.2 already exists');
        expect(res.stdout).not.toContain('Choose the changes');
        expect(snapshot(ws)).toEqual(before);
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a p cleans up and rolls back when the version bump itself fails after the choice', () => {
        const ws = twoHunkWorkspace();
        const before = snapshot(ws);

        const res = run(ws, 'p', 'y\nn\n', ['-sv', 'not-a-version']);

        expect(res.status).not.toBe(0);
        expect(snapshot(ws)).toEqual(before);
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('');
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a p rolls back completely when a pre-commit hook rejects the commit', () => {
        const ws = twoHunkWorkspace();
        installHook(ws, 'pre-commit', 'echo "no" >&2\nexit 1');
        const before = snapshot(ws);

        const res = run(ws, 'p', 'y\nn\n');

        expect(res.status).not.toBe(0);
        expect(snapshot(ws)).toEqual(before);
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('');
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('a dry run with -a p asks nothing, says so, and changes nothing', () => {
        const ws = twoHunkWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: picked', '-w', 'app-one', '-dnp', '-d', '-a', 'p'], ws, '');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('You will choose the changes to commit inside apps/app-one');
        expect(res.stdout).toContain('git add -p -- apps/app-one');
        expect(res.stdout.indexOf('git add -p -- apps/app-one')).toBeLessThan(res.stdout.indexOf('npm version patch'));
        expect(snapshot(ws)).toEqual(before);
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a i commits only what was chosen through the menu', () => {
        const ws = twoHunkWorkspace();

        const res = run(ws, 'i', '5\n1\n\ny\nn\n7\n');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain("'patch' picks hunks, 'quit' finishes");
        expect(committedNotes(ws)).toContain('+line 2 EDITED');
        expect(committedNotes(ws)).not.toContain('line 29 EDITED');
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('');
        expect(tempIndexes(ws)).toEqual([]);
    });

    test('-a i with nothing selected aborts with an error, and nothing changes', () => {
        const ws = twoHunkWorkspace();
        const before = snapshot(ws);

        const res = run(ws, 'i', '7\n');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('You have not selected any changes');
        expect(snapshot(ws)).toEqual(before);
        expect(tempIndexes(ws)).toEqual([]);
    });
});

describe('workspace release notes and first versions', () => {
    const sorted = list => [...list].sort();

    function makePublic(ws, dir) {
        const file = path.join(ws, dir, 'package.json');
        const data = readJson(file);
        data.private = false;
        writeJson(file, data);
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'make public'], ws);
    }

    function removeVersion(ws, dir) {
        const file = path.join(ws, dir, 'package.json');
        const data = readJson(file);
        delete data.version;
        writeJson(file, data);
        const lockFile = path.join(ws, 'package-lock.json');
        const lock = readJson(lockFile);
        delete lock.packages[dir].version;
        writeJson(lockFile, lock);
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'drop version'], ws);
    }

    test('-r writes release notes inside the workspace and commits them', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: with notes', '-w', 'app-one', '-dnp', '-r'], ws, '');

        expect(res.status).toBe(0);
        const file = 'apps/app-one/release-notes/app-one@0.1.2.md';
        expect(sorted(committedFiles(ws))).toEqual(sorted([
            'apps/app-one/CHANGELOG.md',
            'apps/app-one/package.json',
            file,
            'package-lock.json'
        ]));
        const notes = fs.readFileSync(path.join(ws, file), 'utf8');
        expect(notes).toContain('# Release app-one@0.1.2');
        expect(notes).toMatch(/Released: \d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2} UTC/);
        expect(notes).toContain('## Changes\n- fix: with notes');
        expect(notes).toContain('See [CHANGELOG.md](../CHANGELOG.md)');
        expect(notes).not.toContain('npm install');
        expect(res.stdout).toContain('Release notes: Generated');
        expect(git(['status', '--porcelain'], ws)).toBe('');
        expect(fs.existsSync(path.join(ws, 'release-notes'))).toBe(false);
    });

    test('-r asks nothing, so it works with no input at all', () => {
        const ws = freshWorkspace();

        const res = vx(['-m', 'fix: no prompt', '-w', 'app-one', '-dnp', '-r'], ws, '');

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
    });

    test('a public workspace gets an install line, and a scoped name is filed without its slash', () => {
        const ws = freshWorkspace();
        makePublic(ws, 'packages/shared-theme');

        const res = vx(['-m', 'fix: theme', '-w', '@fixture/shared-theme', '-dnp', '-r'], ws, '');

        expect(res.status).toBe(0);
        const file = 'packages/shared-theme/release-notes/fixture-shared-theme@0.0.1.md';
        const notes = fs.readFileSync(path.join(ws, file), 'utf8');
        expect(notes).toContain('# Release fixture/shared-theme@0.0.1');
        expect(notes).toContain('npm install @fixture/shared-theme@0.0.1');
        expect(committedFiles(ws)).toContain(file);
    });

    test('-r without a changelog leaves out the changelog link', () => {
        const ws = freshWorkspace();
        writeJson(path.join(ws, '.vnxtrc.json'), { autoChangelog: false });
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'config'], ws);

        const res = vx(['-m', 'fix: no log', '-w', 'app-one', '-dnp', '-r'], ws, '');

        expect(res.status).toBe(0);
        const notes = fs.readFileSync(path.join(ws, 'apps/app-one/release-notes/app-one@0.1.2.md'), 'utf8');
        expect(notes).not.toContain('Full Changelog');
        expect(fs.existsSync(path.join(ws, 'apps/app-one/CHANGELOG.md'))).toBe(false);
    });

    test('-r is rolled back completely when a hook rejects the commit', () => {
        const ws = freshWorkspace();
        installHook(ws, 'pre-commit', 'echo "no" >&2\nexit 1');
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: rejected', '-w', 'app-one', '-dnp', '-r'], ws, '');

        expect(res.status).not.toBe(0);
        expect(snapshot(ws)).toEqual(before);
        expect(fs.existsSync(path.join(ws, 'apps/app-one/release-notes'))).toBe(false);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('-r refuses when that release notes file already exists, and changes nothing', () => {
        const ws = freshWorkspace();
        writeFile(path.join(ws, 'apps/app-one/release-notes/app-one@0.1.2.md'), 'old\n');
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'old notes'], ws);
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: again', '-w', 'app-one', '-dnp', '-r'], ws, '');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('app-one@0.1.2.md already exists');
        expect(snapshot(ws)).toEqual(before);
        expect(fs.readFileSync(path.join(ws, 'apps/app-one/release-notes/app-one@0.1.2.md'), 'utf8')).toBe('old\n');
    });

    test('-r works together with -a p', () => {
        const ws = freshWorkspace();
        const lines = Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`);
        writeFile(path.join(ws, 'apps/app-one/src/notes.js'), lines.join('\n') + '\n');
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'add notes'], ws);
        lines[1] = 'line 2 EDITED';
        writeFile(path.join(ws, 'apps/app-one/src/notes.js'), lines.join('\n') + '\n');

        const res = vx(['-m', 'fix: picked notes', '-w', 'app-one', '-dnp', '-a', 'p', '-r'], ws, 'y\n');

        expect(res.status).toBe(0);
        expect(committedFiles(ws)).toContain('apps/app-one/release-notes/app-one@0.1.2.md');
        expect(git(['status', '--porcelain'], ws)).toBe('');
    });

    test('a dry run with -r lists the file as new and writes nothing', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['-m', 'fix: preview', '-w', 'app-one', '-dnp', '-d', '-r'], ws, '');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('apps/app-one/release-notes/app-one@0.1.2.md (new)');
        expect(res.stdout).toContain('git add -- apps/app-one/release-notes/app-one@0.1.2.md');
        expect(snapshot(ws)).toEqual(before);
        expect(fs.existsSync(path.join(ws, 'apps/app-one/release-notes'))).toBe(false);
    });

    test('a workspace with no version refuses a bump type and says to use -sv', () => {
        const ws = freshWorkspace();
        removeVersion(ws, 'apps/app-one');
        const before = snapshot(ws);

        for (const extra of [[], ['-t', 'minor'], ['-d']]) {
            const res = vx(['-m', 'fix: nothing to bump', '-w', 'app-one', '-dnp', ...extra], ws, '');

            expect(res.status).not.toBe(0);
            expect(res.stderr).toContain('app-one has no version yet');
            expect(res.stderr).toContain('-sv 1.0.0');
            expect(snapshot(ws)).toEqual(before);
        }
        expect(readJson(path.join(ws, 'package-lock.json')).packages['apps/app-one'].version).toBeUndefined();
    });

    test('-sv sets the first version of a workspace with none, in the manifest and the lockfile', () => {
        const ws = freshWorkspace();
        removeVersion(ws, 'apps/app-one');

        const res = vx(['-m', 'chore: baseline', '-w', 'app-one', '-sv', '1.0.0', '-dnp'], ws, '');

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('1.0.0');
        expect(readJson(path.join(ws, 'package-lock.json')).packages['apps/app-one'].version).toBe('1.0.0');
        expect(git(['tag', '--list', 'app-one@1.0.0'], ws)).toBe('app-one@1.0.0');
        expect(res.stdout).toContain('Version: (none) → 1.0.0');
        expect(res.stdout).not.toContain('undefined');
        expect(git(['status', '--porcelain'], ws)).toBe('');
    });

    test('a dry run with -sv on a workspace with no version shows (none) as the starting point', () => {
        const ws = freshWorkspace();
        removeVersion(ws, 'apps/app-one');

        const res = vx(['-m', 'chore: baseline', '-w', 'app-one', '-sv', '1.0.0', '-dnp', '-d'], ws, '');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Version:   (none) → 1.0.0');
    });
});

describe('workspace guards', () => {
    const release = (ws, extra = []) => vx(['-m', 'fix: release', '-w', 'app-one', '-dnp', ...extra], ws, '');
    const touch = (ws, dir = 'apps/app-one') => fs.appendFileSync(path.join(ws, dir, 'src', 'main.js'), `// change ${++counter}\n`);

    test('--publish is refused with a reason, and nothing changes', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = release(ws, ['--publish']);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('--publish is not supported in workspace mode');
        expect(res.stderr).toContain('Use -p to push the commit and tag');
        expect(snapshot(ws)).toEqual(before);
    });

    test('a detached HEAD is refused even without -p, and nothing changes', () => {
        const ws = freshWorkspace();
        git(['checkout', '-q', '--detach'], ws);
        const before = snapshot(ws);

        const res = release(ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('HEAD is detached, so a release commit now would not be on any branch');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('a dry run reports the detached HEAD as a reason a real run would stop', () => {
        const ws = freshWorkspace();
        git(['checkout', '-q', '--detach'], ws);

        const res = release(ws, ['-d']);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: HEAD is detached');
    });

    test.each([
        ['a merge', 'MERGE_HEAD', 'file', 'A merge is in progress'],
        ['a rebase', 'rebase-merge', 'dir', 'A rebase is in progress'],
        ['a cherry-pick', 'CHERRY_PICK_HEAD', 'file', 'A cherry-pick is in progress'],
        ['a revert', 'REVERT_HEAD', 'file', 'A revert is in progress']
    ])('%s in progress is refused, and nothing changes', (_label, marker, kind, expected) => {
        const ws = freshWorkspace();
        const target = path.join(ws, '.git', marker);
        if (kind === 'dir') fs.mkdirSync(target);
        else fs.writeFileSync(target, git(['rev-parse', 'HEAD'], ws) + '\n');
        const before = snapshot(ws);

        const res = release(ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(expected);
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('releasing again with no changes since the last tag is refused', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        const before = snapshot(ws);

        const res = release(ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('No changes in apps/app-one since app-one@0.1.2, so there is nothing to release');
        expect(res.stderr).toContain('-sv');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
    });

    test('a dry run reports "no changes" as a reason a real run would stop', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);

        const res = release(ws, ['-d']);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: No changes in apps/app-one since app-one@0.1.2');
    });

    test('a staged change in the workspace since the tag lifts the refusal', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        touch(ws);
        git(['add', 'apps/app-one/src/main.js'], ws);

        expect(release(ws).status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.3');
        expect(committedFiles(ws)).toContain('apps/app-one/src/main.js');
    });

    test('an unstaged change does not lift it without -a, because it would not be committed', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        touch(ws);
        const before = snapshot(ws);

        const res = release(ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('No changes in apps/app-one since app-one@0.1.2');
        expect(res.stderr).toContain('not staged');
        expect(res.stderr).toContain('-a tracked or -a all');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
    });

    test.each([
        ['tracked'],
        ['all'],
        ['patch']
    ])('an unstaged change does lift it with -a %s, and the change is committed', mode => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        touch(ws);

        const res = vx(['-m', 'fix: release', '-w', 'app-one', '-dnp', '-a', mode], ws, mode === 'patch' ? 'y\n' : '');

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.3');
        expect(committedFiles(ws)).toContain('apps/app-one/src/main.js');
    });

    test('-a tracked does not count an untracked file', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        writeFile(path.join(ws, 'apps/app-one/src/new.js'), 'x\n');

        const res = release(ws, ['-a', 'tracked']);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('No changes in apps/app-one');
    });

    test('-a i counts an untracked file, so it gets as far as the menu', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        writeFile(path.join(ws, 'apps/app-one/src/new.js'), 'x\n');

        const res = vx(['-m', 'fix: release', '-w', 'app-one', '-dnp', '-a', 'i'], ws, '7\n');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('You have not selected any changes');
        expect(res.stderr).not.toContain('No changes in apps/app-one');
    });

    test('a dry run explains the same refusal for an unstaged change', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        touch(ws);

        const res = release(ws, ['-d']);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('A real run would stop here: No changes in apps/app-one');
        expect(res.stdout).toContain('not staged');
    });

    test('a change committed since the tag counts too', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        touch(ws);
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'a committed change'], ws);

        expect(release(ws).status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.3');
    });

    test('a change in another workspace does not count', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        touch(ws, 'apps/app-two');
        const before = snapshot(ws);

        const res = release(ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('No changes in apps/app-one');
        expect(snapshot(ws)).toEqual(before);
    });

    test('-sv is the deliberate way past the "no changes" refusal', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);

        const res = release(ws, ['-sv', '0.5.0']);

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.5.0');
    });

    test('an untracked file counts only with -a all', () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);
        writeFile(path.join(ws, 'apps/app-one/src/new.js'), 'x\n');

        const refused = release(ws);
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('No changes in apps/app-one');

        const allowed = release(ws, ['-a', 'all']);
        expect(allowed.status).toBe(0);
        expect(committedFiles(ws)).toContain('apps/app-one/src/new.js');
    });

    test("another workspace's tags are not mistaken for this one's", () => {
        const ws = freshWorkspace();
        expect(release(ws).status).toBe(0);

        const res = vx(['-m', 'fix: first app-two', '-w', 'app-two', '-dnp'], ws, '');

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-two')).toBe('0.2.7');
    });

    test('a workspace that has never been released is not held back', () => {
        const ws = freshWorkspace();

        const res = release(ws);

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
    });
});

describe('several workspaces in one run', () => {
    const sorted = list => [...list].sort();
    const many = (ws, selectors, extra = [], input = '') =>
        vx(['-m', 'fix: several', '-dnp', ...selectors, ...extra], ws, input);
    const filesOf = (ws, rev) => sorted(lines(git(['show', '--name-only', '--format=', rev], ws)));

    test('makes one commit and one tag per workspace, in the order given', () => {
        const ws = freshWorkspace();

        const res = many(ws, ['-w', 'app-two,app-one']);

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
        expect(versionOf(ws, 'apps/app-two')).toBe('0.2.7');
        expect(git(['rev-list', '--count', 'HEAD~2..HEAD'], ws)).toBe('2');
        expect(filesOf(ws, 'HEAD~1')).toEqual(['apps/app-two/CHANGELOG.md', 'apps/app-two/package.json', 'package-lock.json']);
        expect(filesOf(ws, 'HEAD')).toEqual(['apps/app-one/CHANGELOG.md', 'apps/app-one/package.json', 'package-lock.json']);
        expect(git(['tag', '--points-at', 'HEAD~1'], ws)).toBe('app-two@0.2.7');
        expect(git(['tag', '--points-at', 'HEAD'], ws)).toBe('app-one@0.1.2');
        expect(git(['cat-file', '-t', 'app-one@0.1.2'], ws)).toBe('tag');
        expect(git(['status', '--porcelain'], ws)).toBe('');
        expect(res.stdout).toContain('2 workspaces released');
    });

    test('the lockfile ends up with both versions', () => {
        const ws = freshWorkspace();

        many(ws, ['-w', 'app-one,app-two']);

        const lock = readJson(path.join(ws, 'package-lock.json')).packages;
        expect(lock['apps/app-one'].version).toBe('0.1.2');
        expect(lock['apps/app-two'].version).toBe('0.2.7');
    });

    test('each commit and changelog carries the shared message', () => {
        const ws = freshWorkspace();

        many(ws, ['-w', 'app-one,app-two']);

        expect(git(['log', '-2', '--format=%s'], ws)).toBe('fix: several\nfix: several');
        expect(fs.readFileSync(path.join(ws, 'apps/app-one/CHANGELOG.md'), 'utf8')).toContain('- fix: several');
        expect(fs.readFileSync(path.join(ws, 'apps/app-two/CHANGELOG.md'), 'utf8')).toContain('- fix: several');
    });

    test('three workspaces, one of them scoped, each get their own tag', () => {
        const ws = freshWorkspace();

        const res = many(ws, ['-w', 'app-one,app-two,@fixture/shared-theme']);

        expect(res.status).toBe(0);
        expect(git(['rev-list', '--count', 'HEAD~3..HEAD'], ws)).toBe('3');
        expect(sorted(lines(git(['tag', '--list', '*@*'], ws)))).toEqual(['app-one@0.1.2', 'app-two@0.2.7', 'fixture/shared-theme@0.0.1']);
    });

    test('a repeated workspace is made once', () => {
        const ws = freshWorkspace();

        const res = many(ws, ['-w', 'app-one,app-one,app-two']);

        expect(res.status).toBe(0);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
        expect(git(['rev-list', '--count', 'HEAD~2..HEAD'], ws)).toBe('2');
    });

    test('-r writes release notes for each workspace', () => {
        const ws = freshWorkspace();

        const res = many(ws, ['-w', 'app-one,app-two'], ['-r']);

        expect(res.status).toBe(0);
        expect(filesOf(ws, 'HEAD~1')).toContain('apps/app-one/release-notes/app-one@0.1.2.md');
        expect(filesOf(ws, 'HEAD')).toContain('apps/app-two/release-notes/app-two@0.2.7.md');
    });

    test('-p pushes once, after every commit, and sends every tag', () => {
        const ws = freshWorkspace();
        const remote = addRemote(ws);

        const res = vx(['-m', 'fix: pushed', '-w', 'app-one,app-two', '-p'], ws, '');

        expect(res.status).toBe(0);
        expect(res.stdout.match(/Pushing to remote/g)).toHaveLength(1);
        expect(res.stdout).toContain('Pushed with tags');
        expect(git(['rev-parse', 'main'], remote)).toBe(git(['rev-parse', 'HEAD'], ws));
        expect(sorted(lines(git(['tag', '--list'], remote)))).toEqual(['app-one@0.1.2', 'app-two@0.2.7']);
    });

    test('a staged change in a workspace that was not chosen stays staged and uncommitted', () => {
        const ws = freshWorkspace();
        fs.appendFileSync(path.join(ws, 'packages', 'shared-api', 'src', 'index.js'), '// staged, not chosen\n');
        git(['add', 'packages/shared-api/src/index.js'], ws);

        const res = many(ws, ['-w', 'app-one,app-two']);

        expect(res.status).toBe(0);
        expect(git(['diff', '--cached', '--name-only'], ws)).toBe('packages/shared-api/src/index.js');
        expect(filesOf(ws, 'HEAD')).not.toContain('packages/shared-api/src/index.js');
        expect(filesOf(ws, 'HEAD~1')).not.toContain('packages/shared-api/src/index.js');
    });

    test('a problem with one target stops the whole run before anything changes', () => {
        const ws = freshWorkspace();
        git(['tag', '-a', 'app-two@0.2.7', '-m', 'old'], ws);
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// change\n');
        const before = snapshot(ws);

        const res = many(ws, ['-w', 'app-one,app-two']);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('Nothing was changed');
        expect(res.stderr).toContain('[app-two] The tag app-two@0.2.7 already exists');
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
        expect(fs.existsSync(path.join(ws, 'apps/app-one/CHANGELOG.md'))).toBe(false);
    });

    test('every problem is listed, not only the first', () => {
        const ws = freshWorkspace();
        expect(vx(['-m', 'fix: first', '-w', 'app-one', '-dnp'], ws, '').status).toBe(0);
        expect(vx(['-m', 'fix: first', '-w', 'app-two', '-dnp'], ws, '').status).toBe(0);

        const res = many(ws, ['-w', 'app-one,app-two']);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('[app-one] No changes in apps/app-one');
        expect(res.stderr).toContain('[app-two] No changes in apps/app-two');
    });

    test('a problem every target shares is said once', () => {
        const ws = freshWorkspace();
        git(['checkout', '-q', '--detach'], ws);

        const res = many(ws, ['-w', 'app-one,app-two']);

        expect(res.status).not.toBe(0);
        expect(res.stderr.match(/HEAD is detached/g)).toHaveLength(1);
        expect(res.stderr).not.toContain('[app-one, app-two]');
    });

    test('a failure part way stops there and says what landed, what did not, and how to carry on', () => {
        const ws = freshWorkspace();
        installHook(ws, 'pre-commit', 'f="$(git rev-parse --git-dir)/hookcount"\nn=$(cat "$f" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "$f"\n[ "$n" -ge 2 ] && { echo "second commit refused" >&2; exit 1; }\nexit 0');
        const remote = addRemote(ws);

        const res = vx(['-m', 'fix: partial', '-w', 'app-one,app-two,@fixture/shared-theme', '-p'], ws, '');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('Stopped at app-two');
        expect(res.stderr).toContain('Landed before this: app-one@0.1.2');
        expect(res.stderr).toContain('Not started: @fixture/shared-theme');
        expect(res.stderr).toContain('Nothing was pushed');
        expect(res.stderr).toContain('vx -w @fixture/shared-theme -m');
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.2');
        expect(git(['tag', '--list', 'app-one@0.1.2'], ws)).toBe('app-one@0.1.2');
        expect(versionOf(ws, 'apps/app-two')).toBe('0.2.6');
        expect(git(['tag', '--list', 'app-two@*'], ws)).toBe('');
        expect(git(['tag', '--list'], remote)).toBe('');
        expect(git(['status', '--porcelain'], ws)).toBe('');
    });

    test('a workspace with no version stops the run, in a dry run too', () => {
        const ws = freshWorkspace();
        const file = path.join(ws, 'apps/app-two/package.json');
        const data = readJson(file);
        delete data.version;
        writeJson(file, data);
        git(['add', '-A'], ws);
        git(['commit', '-q', '-m', 'drop version'], ws);
        const before = snapshot(ws);

        for (const extra of [[], ['-d']]) {
            const res = many(ws, ['-w', 'app-one,app-two'], extra);

            expect(res.status).not.toBe(0);
            expect(res.stderr).toContain('app-two has no version yet');
            expect(snapshot(ws)).toEqual(before);
        }
    });

    test('a dry run shows every target, once each, and writes nothing', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = many(ws, ['-w', 'app-one,app-two'], ['-d']);

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Target 1 of 2');
        expect(res.stdout).toContain('Target 2 of 2');
        expect(res.stdout).toContain('Tag:       app-one@0.1.2');
        expect(res.stdout).toContain('Tag:       app-two@0.2.7');
        expect(res.stdout.match(/Dry run complete/g)).toHaveLength(1);
        expect(res.stdout.match(/Repo root:/g)).toHaveLength(1);
        expect(snapshot(ws)).toEqual(before);
        expect(versionOf(ws, 'apps/app-one')).toBe('0.1.1');
    });

    test('a dry run with a push says it pushes once, and lists tags that would go with it', () => {
        const ws = freshWorkspace();
        addRemote(ws);

        const res = vx(['-m', 'fix: preview', '-w', 'app-one,app-two', '-p', '-d'], ws, '');

        expect(res.status).toBe(0);
        expect(res.stdout.match(/Push: yes/g)).toHaveLength(1);
        expect(res.stdout).toContain('once, after every commit');
    });
});

describe('--list-workspaces', () => {
    test('lists every workspace from the repo root, and changes nothing', () => {
        const ws = freshWorkspace();
        const before = snapshot(ws);

        const res = vx(['--list-workspaces'], ws, '');

        expect(res.status).toBe(0);
        for (const name of ['app-one', 'app-two', '@fixture/shared-api', '@fixture/shared-theme', '@fixture/shared-form']) {
            expect(res.stdout).toContain(name);
        }
        expect(res.stdout).toMatch(/app-one\s+apps\/app-one\s+0\.1\.1\s+yes\s+-\s+never released/);
        expect(res.stdout).toMatch(/app-two\s+apps\/app-two\s+0\.2\.6\s+yes\s+-\s+never released/);
        expect(snapshot(ws)).toEqual(before);
    });

    test('-lw is the short form, and it works from inside a workspace folder', () => {
        const ws = freshWorkspace();

        const res = vx(['-lw'], path.join(ws, 'apps', 'app-one', 'src'), '');

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('app-two');
    });

    test('shows the latest tag and whether the workspace has changed since', () => {
        const ws = freshWorkspace();
        expect(vx(['-m', 'fix: one', '-w', 'app-one', '-dnp'], ws, '').status).toBe(0);
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// change\n');
        git(['add', 'apps/app-two/src/main.js'], ws);
        expect(vx(['-m', 'fix: two', '-w', 'app-two', '-dnp'], ws, '').status).toBe(0);
        fs.appendFileSync(path.join(ws, 'apps', 'app-two', 'src', 'main.js'), '// another change\n');
        fs.appendFileSync(path.join(ws, 'packages', 'shared-api', 'src', 'index.js'), '// never released, so not compared\n');

        const res = vx(['--list-workspaces'], ws, '');

        expect(res.stdout).toMatch(/app-one\s+apps\/app-one\s+0\.1\.2\s+yes\s+app-one@0\.1\.2\s+none since tag/);
        expect(res.stdout).toMatch(/app-two\s+apps\/app-two\s+0\.2\.7\s+yes\s+app-two@0\.2\.7\s+unstaged changes only/);
        expect(res.stdout).toMatch(/shared-api\s+packages\/shared-api\s+0\.0\.0\s+yes\s+-\s+never released/);

        git(['add', 'apps/app-two/src/main.js'], ws);
        expect(vx(['--list-workspaces'], ws, '').stdout).toMatch(/app-two\s+apps\/app-two\s+0\.2\.7\s+yes\s+app-two@0\.2\.7\s+changed since tag/);
    });

    test('shows a workspace with no version', () => {
        const ws = freshWorkspace();
        const file = path.join(ws, 'apps/app-one/package.json');
        const data = readJson(file);
        delete data.version;
        writeJson(file, data);

        const res = vx(['-lw'], ws, '');

        expect(res.stdout).toMatch(/app-one\s+apps\/app-one\s+\(none\)/);
    });

    test('needs no message, and is refused with a reason in a repo without workspaces', () => {
        const { work } = freshSingleWithRemote();

        const res = vx(['-lw'], work, '');

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('does not declare workspaces');
    });

    test('is in the help text, and the help no longer says one at a time', () => {
        const ws = freshWorkspace();

        const res = vx(['--help'], ws, '');

        expect(res.stdout).toContain('--list-workspaces');
        expect(res.stdout).not.toContain('One at a time for now');
    });
});

describe('workspace commit: not supported yet', () => {
    test.each([
        ['--publish', ['--publish'], 'nothing is published from here'],
        ['-sv with several workspaces', ['-w', 'app-two', '-sv', '2.0.0'], 'cannot be used with several workspaces'],
        ['-a p with several workspaces', ['-w', 'app-two', '-a', 'p'], 'works with one workspace at a time'],
        ['-a i with several workspaces', ['-w', 'app-two', '-a', 'i'], 'works with one workspace at a time']
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

        const res = vx(['-m', 'fix: nope', '-w', 'app-one', '--publish', '-d'], ws);

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('nothing is published from here');
    });
});

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

    // A preversion script that leaves a marker at a path the test knows, wherever npm runs it
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
        fs.writeFileSync(lockFile, JSON.stringify(JSON.parse(fs.readFileSync(lockFile, 'utf8'))) + '\n');
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
        expect(git(['rev-list', '--count', 'HEAD'], work)).toBe('2');
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

describe('manifest layout after a bump', () => {
    const { matchLayout } = require('./vnxt.js');
    const manifestPath = ws => path.join(ws, 'apps', 'app-one', 'package.json');
    const committedManifest = (ws, rev = 'HEAD') =>
        execFileSync('git', ['show', `${rev}:apps/app-one/package.json`], { cwd: ws }).toString();

    const withLayout = (eol, finalNewline) => {
        const ws = freshWorkspace();
        const original = fs.readFileSync(manifestPath(ws), 'utf8').replace(/\r?\n/g, '\n').replace(/\n+$/, '');
        const text = original.replace(/\n/g, eol) + (finalNewline ? eol : '');
        fs.writeFileSync(manifestPath(ws), text);
        git(['add', 'apps/app-one/package.json'], ws);
        git(['commit', '-q', '--allow-empty', '-m', 'set layout'], ws);
        return { ws, text };
    };
    const bump = ws => vx(['-m', 'fix: layout', '-w', 'app-one', '-dnp'], ws, '');
    const expectOnlyVersionChanged = (ws, before) => {
        expect(committedManifest(ws)).toBe(before.replace('"version": "0.1.1"', '"version": "0.1.2"'));
        expect(fs.readFileSync(manifestPath(ws), 'utf8')).toBe(committedManifest(ws));
    };

    test.each([
        ['LF, with a final newline', '\n', true],
        ['LF, without a final newline', '\n', false],
        ['CRLF, with a final newline', '\r\n', true],
        ['CRLF, without a final newline', '\r\n', false]
    ])('%s: the bump changes the version and nothing else', (label, eol, finalNewline) => {
        const { ws, text } = withLayout(eol, finalNewline);

        const res = bump(ws);

        expect(res.status).toBe(0);
        expectOnlyVersionChanged(ws, text);
        expect(git(['diff', '--numstat', 'HEAD~1', 'HEAD', '--', 'apps/app-one/package.json'], ws)).toMatch(/^1\t1\t/);
    });

    test('a rolled-back bump leaves the manifest in its original layout', () => {
        const { ws, text } = withLayout('\r\n', false);
        git(['tag', '-a', 'app-one@0.1.2', '-m', 'old'], ws);
        fs.appendFileSync(path.join(ws, 'apps', 'app-one', 'src', 'main.js'), '// change\n');
        git(['add', 'apps/app-one/src/main.js'], ws);

        const res = bump(ws);

        expect(res.status).not.toBe(0);
        expect(fs.readFileSync(manifestPath(ws), 'utf8')).toBe(text);
    });

    test('several workspaces each keep their own layout', () => {
        const { ws, text } = withLayout('\r\n', false);
        const two = path.join(ws, 'apps', 'app-two', 'package.json');
        const twoText = fs.readFileSync(two, 'utf8').replace(/\n+$/, '');
        fs.writeFileSync(two, twoText);
        git(['add', 'apps/app-two/package.json'], ws);
        git(['commit', '-q', '-m', 'set layout two'], ws);

        const res = vx(['-m', 'fix: both', '-w', 'app-one', '-w', 'app-two', '-dnp'], ws, '');

        expect(res.status).toBe(0);
        expect(committedManifest(ws, 'HEAD~1')).toBe(text.replace('"version": "0.1.1"', '"version": "0.1.2"'));
        expect(execFileSync('git', ['show', 'HEAD:apps/app-two/package.json'], { cwd: ws }).toString())
            .toBe(twoText.replace('"version": "0.2.6"', '"version": "0.2.7"'));
    });

    describe('matchLayout', () => {
        test('puts back a missing final newline', () => {
            expect(matchLayout('{\n  "a": 1\n}', '{\n  "a": 2\n}\n')).toBe('{\n  "a": 2\n}');
        });
        test('adds a final newline that npm dropped', () => {
            expect(matchLayout('{\n  "a": 1\n}\n', '{\n  "a": 2\n}')).toBe('{\n  "a": 2\n}\n');
        });
        test('converts to CRLF, and does not double an existing CR', () => {
            expect(matchLayout('{\r\n  "a": 1\r\n}\r\n', '{\n  "a": 2\n}\n')).toBe('{\r\n  "a": 2\r\n}\r\n');
            expect(matchLayout('{\r\n  "a": 1\r\n}\r\n', '{\r\n  "a": 2\r\n}\r\n')).toBe('{\r\n  "a": 2\r\n}\r\n');
        });
        test('converts to LF when the original was LF', () => {
            expect(matchLayout('{\n  "a": 1\n}\n', '{\r\n  "a": 2\r\n}\r\n')).toBe('{\n  "a": 2\n}\n');
        });
        test('leaves the text alone when there was no original', () => {
            expect(matchLayout(null, '{"a":2}\n')).toBe('{"a":2}\n');
        });
    });
});