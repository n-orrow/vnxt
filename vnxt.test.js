const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// =============================================================================
// Test Helpers
// =============================================================================

const vnxtPath = path.join(__dirname, 'vnxt.js');

function createTestRepo(testDir) {
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }
    execSync('git init -b main', { cwd: testDir });
    execSync('git config user.email "test@test.com"', { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });
    fs.writeFileSync(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test-package', version: '1.0.0' }, null, 2)
    );
    execSync('git add .', { cwd: testDir });
    execSync('git commit -m "initial commit"', { cwd: testDir });
}

function cleanupTestRepo(testDir) {
    if (!fs.existsSync(testDir)) return;
    const delay = ms => { const s = Date.now(); while (Date.now() - s < ms) {} };
    delay(100);
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
        delay(500);
        try { fs.rmSync(testDir, { recursive: true, force: true }); }
        catch { console.warn(`Warning: Could not cleanup ${testDir}`); }
    }
}

function vx(args, testDir) {
    return execSync(`node ${vnxtPath} ${args}`, {
        cwd: testDir,
        encoding: 'utf8',
        stdio: 'pipe',
        input: '\n\n\n\n\n' // satisfy any interactive prompts (e.g. release notes context)
    });
}

function vxExpectFail(args, testDir) {
    return () => execSync(`node ${vnxtPath} ${args}`, {
        cwd: testDir,
        encoding: 'utf8',
        stdio: 'pipe'
    });
}

function readPackageVersion(testDir) {
    return JSON.parse(fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')).version;
}

function writeConfig(testDir, config) {
    fs.writeFileSync(path.join(testDir, '.vnxtrc.json'), JSON.stringify(config, null, 2));
    execSync('git add .vnxtrc.json', { cwd: testDir });
    execSync('git commit -m "add config"', { cwd: testDir });
}

// =============================================================================
// Version Bumping
// =============================================================================

describe('Version Bumping', () => {
    const testDir = path.join(__dirname, 'test-bump');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('bumps patch version', () => {
        vx('-m "fix: patch test" -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.0.1');
    });

    test('bumps minor version', () => {
        vx('-m "feat: minor test" -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.1.0');
    });

    test('bumps major version', () => {
        vx('-m "major: breaking" -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('2.0.0');
    });

    test('sets specific version with -sv', () => {
        vx('-sv 2.5.0-beta.1 -m "beta release" -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('2.5.0-beta.1');
    });

    test('summary output shows version transition', () => {
        const result = vx('-m "fix: summary test" -dnp', testDir);
        expect(result).toContain('1.0.0 → 1.0.1');
    });
});

// =============================================================================
// Auto-detection of Commit Prefix
// =============================================================================

describe('Auto-detection', () => {
    const testDir = path.join(__dirname, 'test-autodetect');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    const cases = [
        ['fix: bug',            '1.0.1'],
        ['patch: tweak',        '1.0.1'],
        ['feat: feature',       '1.1.0'],
        ['feature: feature',    '1.1.0'],
        ['minor: improvement',  '1.1.0'],
        ['major: change',       '2.0.0'],
        ['BREAKING: api',       '2.0.0'],
        ['breaking: api',       '2.0.0'],
        ['MAJOR: overhaul',     '2.0.0'],
    ];

    test.each(cases)('"%s" → %s', (message, expected) => {
        vx(`-m "${message}" -dnp`, testDir);
        expect(readPackageVersion(testDir)).toBe(expected);
    });

    test('falls back to defaultType (patch) with no recognised prefix', () => {
        vx('-m "chore: tidy up" -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.0.1');
    });
});

// =============================================================================
// Version Inspection Flags
// =============================================================================

describe('Version Flags', () => {
    const testDir = path.join(__dirname, 'test-versionflags');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('-vv shows vnxt version', () => {
        const result = execSync(`node ${vnxtPath} -vv`, { encoding: 'utf8' });
        expect(result).toMatch(/^vnxt v\d+\.\d+\.\d+/);
    });

    test('--vnxt-version shows vnxt version', () => {
        const result = execSync(`node ${vnxtPath} --vnxt-version`, { encoding: 'utf8' });
        expect(result).toMatch(/^vnxt v\d+\.\d+\.\d+/);
    });

    test('-vv shows vnxt version, not project version', () => {
        const result = execSync(`node ${vnxtPath} -vv`, { cwd: testDir, encoding: 'utf8' });
        const vnxtPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        expect(result.trim()).toBe(`vnxt v${vnxtPkg.version}`);
    });

    test('-gv shows project name and version', () => {
        const result = vx('-gv', testDir);
        expect(result.trim()).toBe('test-package v1.0.0');
    });

    test('--get-version shows project name and version', () => {
        const result = vx('--get-version', testDir);
        expect(result.trim()).toBe('test-package v1.0.0');
    });

    test('-gv fails gracefully with no package.json', () => {
        const emptyDir = path.join(__dirname, 'test-empty-gv');
        fs.mkdirSync(emptyDir, { recursive: true });
        try {
            expect(() => execSync(`node ${vnxtPath} -gv`, { cwd: emptyDir, stdio: 'pipe' })).toThrow();
        } finally {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });
});

// =============================================================================
// Git Integration
// =============================================================================

describe('Git Integration', () => {
    const testDir = path.join(__dirname, 'test-git');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('creates a git commit', () => {
        vx('-m "fix: commit test" -dnp', testDir);
        const log = execSync('git log --oneline', { cwd: testDir, encoding: 'utf8' });
        expect(log).toContain('fix: commit test');
    });

    test('creates an annotated git tag', () => {
        vx('-m "feat: tag test" -dnp', testDir);
        const tags = execSync('git tag', { cwd: testDir, encoding: 'utf8' });
        expect(tags).toContain('v1.1.0');
    });

    test('tag annotation contains version and message', () => {
        vx('-m "fix: annotated" -dnp', testDir);
        const annotation = execSync('git show v1.0.1 --no-patch', { cwd: testDir, encoding: 'utf8' });
        expect(annotation).toContain('Version 1.0.1');
        expect(annotation).toContain('fix: annotated');
    });

    test('does not crash on first commit (no HEAD~1)', () => {
        // The initial commit is commit #1; after bump there is a HEAD~1, so
        // to test the single-commit edge case we need a fresh repo with no prior commits.
        const singleDir = path.join(__dirname, 'test-singlecommit');
        fs.mkdirSync(singleDir, { recursive: true });
        execSync('git init', { cwd: singleDir });
        execSync('git config user.email "test@test.com"', { cwd: singleDir });
        execSync('git config user.name "Test User"', { cwd: singleDir });
        fs.writeFileSync(
            path.join(singleDir, 'package.json'),
            JSON.stringify({ name: 'single', version: '1.0.0' }, null, 2)
        );
        // Stage but don't commit — then bump so the bump IS the first commit
        execSync('git add .', { cwd: singleDir });
        try {
            expect(() => vx('-m "fix: first ever commit" -dnp', singleDir)).not.toThrow();
        } finally {
            cleanupTestRepo(singleDir);
        }
    });
});

// =============================================================================
// tagPrefix Configuration
// =============================================================================

describe('tagPrefix Config', () => {
    const testDir = path.join(__dirname, 'test-tagprefix');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('custom tagPrefix applies to git tag', () => {
        writeConfig(testDir, { tagPrefix: 'release-' });
        vx('-m "fix: prefix test" -dnp', testDir);
        const tags = execSync('git tag', { cwd: testDir, encoding: 'utf8' });
        expect(tags).toContain('release-1.0.1');
        expect(tags).not.toContain('v1.0.1');
    });

    test('custom tagPrefix applies to release notes filename', () => {
        writeConfig(testDir, { tagPrefix: 'release-' });
        vx('-m "fix: prefix notes" -r -dnp', testDir);
        const notesPath = path.join(testDir, 'release-notes', 'release-1.0.1.md');
        expect(fs.existsSync(notesPath)).toBe(true);
    });

    test('empty tagPrefix creates bare version tags', () => {
        writeConfig(testDir, { tagPrefix: '' });
        vx('-m "fix: no prefix" -dnp', testDir);
        const tags = execSync('git tag', { cwd: testDir, encoding: 'utf8' });
        expect(tags).toContain('1.0.1');
    });
});

// =============================================================================
// Changelog Generation
// =============================================================================

describe('Changelog Generation', () => {
    const testDir = path.join(__dirname, 'test-changelog');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('creates CHANGELOG.md with -c flag', () => {
        vx('-m "feat: first feature" -c -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'CHANGELOG.md'))).toBe(true);
    });

    test('changelog contains version header and message', () => {
        vx('-m "feat: changelog test" -c -dnp', testDir);
        const changelog = fs.readFileSync(path.join(testDir, 'CHANGELOG.md'), 'utf8');
        expect(changelog).toContain('# Changelog');
        expect(changelog).toContain('[1.1.0]');
        expect(changelog).toContain('feat: changelog test');
    });

    test('appends new entries to existing changelog', () => {
        vx('-m "feat: first" -c -dnp', testDir);
        vx('-m "fix: second" -c -dnp', testDir);
        const changelog = fs.readFileSync(path.join(testDir, 'CHANGELOG.md'), 'utf8');
        expect(changelog).toContain('[1.1.0]');
        expect(changelog).toContain('feat: first');
        expect(changelog).toContain('[1.1.1]');
        expect(changelog).toContain('fix: second');
    });

    test('autoChangelog config auto-creates changelog', () => {
        writeConfig(testDir, { autoChangelog: true });
        vx('-m "fix: auto changelog" -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'CHANGELOG.md'))).toBe(true);
    });

    test('autoChangelog: false skips changelog without -c', () => {
        writeConfig(testDir, { autoChangelog: false });
        vx('-m "fix: no changelog" -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'CHANGELOG.md'))).toBe(false);
    });
});

// =============================================================================
// Release Notes
// =============================================================================

describe('Release Notes', () => {
    const testDir = path.join(__dirname, 'test-releasenotes');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('creates release notes file in release-notes/ directory', () => {
        vx('-m "feat: release" -r -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'release-notes', 'v1.1.0.md'))).toBe(true);
    });

    test('release notes contain version, message, and install snippet', () => {
        vx('-m "feat: new release" -r -dnp', testDir);
        const notes = fs.readFileSync(path.join(testDir, 'release-notes', 'v1.1.0.md'), 'utf8');
        expect(notes).toContain('Release v1.1.0');
        expect(notes).toContain('feat: new release');
        expect(notes).toContain('npm install');
    });

    test('release notes are committed into git', () => {
        vx('-m "fix: notes commit" -r -dnp', testDir);
        const log = execSync('git show --name-only HEAD', { cwd: testDir, encoding: 'utf8' });
        expect(log).toContain('release-notes/v1.0.1.md'); // git always uses forward slashes
    });

    test('release notes respect tagPrefix in filename', () => {
        writeConfig(testDir, { tagPrefix: 'ver-' });
        vx('-m "fix: prefixed notes" -r -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'release-notes', 'ver-1.0.1.md'))).toBe(true);
    });
});

// =============================================================================
// Dry Run Mode
// =============================================================================

describe('Dry Run Mode', () => {
    const testDir = path.join(__dirname, 'test-dryrun');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('does not modify package.json version', () => {
        vx('-m "fix: dry run test" -d -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.0.0');
    });

    test('does not create a git commit', () => {
        vx('-m "fix: dry run commit" -d -dnp', testDir);
        const log = execSync('git log --oneline', { cwd: testDir, encoding: 'utf8' });
        expect(log).not.toContain('dry run commit');
    });

    test('does not create a git tag', () => {
        vx('-m "fix: dry run tag" -d -dnp', testDir);
        const tags = execSync('git tag', { cwd: testDir, encoding: 'utf8' });
        expect(tags.trim()).toBe('');
    });

    test('does not create CHANGELOG.md', () => {
        vx('-m "fix: dry run log" -d -c -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'CHANGELOG.md'))).toBe(false);
    });

    test('does not create release notes', () => {
        vx('-m "fix: dry run notes" -d -r -dnp', testDir);
        expect(fs.existsSync(path.join(testDir, 'release-notes'))).toBe(false);
    });

    test('outputs a dry run summary', () => {
        const result = vx('-m "fix: dry run summary" -d -dnp', testDir);
        expect(result).toContain('DRY RUN');
    });
});

// =============================================================================
// Push Behaviour
// =============================================================================

describe('Push Behaviour', () => {
    const testDir = path.join(__dirname, 'test-push');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('-dnp prevents push even when autoPush is true', () => {
        writeConfig(testDir, { autoPush: true });
        // No remote configured — if it tries to push it will throw
        // With -dnp it should succeed without pushing
        expect(() => vx('-m "fix: no push" -dnp', testDir)).not.toThrow();
    });

    test('autoPush: false skips push by default', () => {
        writeConfig(testDir, { autoPush: false });
        expect(() => vx('-m "fix: no auto push" -dnp', testDir)).not.toThrow();
    });
});

// =============================================================================
// Quiet Mode
// =============================================================================

describe('Quiet Mode', () => {
    const testDir = path.join(__dirname, 'test-quiet');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('-q produces minimal output', () => {
        const result = vx('-m "fix: quiet test" -q -dnp', testDir);
        expect(result.trim()).toBe('');
    });

    test('-q still bumps version correctly', () => {
        vx('-m "fix: quiet bump" -q -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.0.1');
    });
});

// =============================================================================
// Staging (--all / -a)
// =============================================================================

describe('File Staging', () => {
    const testDir = path.join(__dirname, 'test-staging');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('-a tracked stages tracked files', () => {
        fs.writeFileSync(path.join(testDir, 'tracked.txt'), 'content');
        execSync('git add tracked.txt', { cwd: testDir });
        vx('-m "chore: stage tracked" -a tracked -dnp', testDir);
        const status = execSync('git status --porcelain', { cwd: testDir, encoding: 'utf8' });
        expect(status.trim()).toBe('');
    });

    test('-a all stages untracked files too', () => {
        fs.writeFileSync(path.join(testDir, 'new-file.txt'), 'content');
        vx('-m "chore: stage all" -a all -dnp', testDir);
        const status = execSync('git status --porcelain', { cwd: testDir, encoding: 'utf8' });
        expect(status.trim()).toBe('');
    });
});

// =============================================================================
// Configuration File
// =============================================================================

describe('Configuration File', () => {
    const testDir = path.join(__dirname, 'test-config');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('defaultType config is used when no prefix detected', () => {
        writeConfig(testDir, { defaultType: 'minor' });
        vx('-m "chore: config type test" -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.1.0');
    });

    test('colors: false does not crash', () => {
        writeConfig(testDir, { colors: false });
        expect(() => vx('-m "fix: no colors" -dnp', testDir)).not.toThrow();
    });
});

// =============================================================================
// Error Handling
// =============================================================================

describe('Error Handling', () => {
    const testDir = path.join(__dirname, 'test-errors');
    beforeEach(() => createTestRepo(testDir));
    afterEach(() => cleanupTestRepo(testDir));

    test('rejects invalid version type', () => {
        expect(vxExpectFail('-m "test" -t invalid', testDir)).toThrow();
    });

    test('fails outside a git repo', () => {
        const nonGitDir = path.join(__dirname, 'test-nogit');
        fs.mkdirSync(nonGitDir, { recursive: true });
        fs.writeFileSync(path.join(nonGitDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
        try {
            expect(() => execSync(`node ${vnxtPath} -m "fix: no git"`, { cwd: nonGitDir, stdio: 'pipe' })).toThrow();
        } finally {
            fs.rmSync(nonGitDir, { recursive: true, force: true });
        }
    });
});

// =============================================================================
// Full Workflow Integration
// =============================================================================

describe('Full Workflow Integration', () => {
    const testDir = path.join(__dirname, 'test-integration');
    beforeAll(() => createTestRepo(testDir));
    afterAll(() => cleanupTestRepo(testDir));

    test('patch → minor → major with changelog and release notes', () => {
        vx('-m "fix: bug fix" -c -r -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.0.1');

        vx('-m "feat: new feature" -c -r -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('1.1.0');

        vx('-m "BREAKING: major change" -c -r -dnp', testDir);
        expect(readPackageVersion(testDir)).toBe('2.0.0');

        // Changelog has all three entries
        const changelog = fs.readFileSync(path.join(testDir, 'CHANGELOG.md'), 'utf8');
        expect(changelog).toContain('[1.0.1]');
        expect(changelog).toContain('fix: bug fix');
        expect(changelog).toContain('[1.1.0]');
        expect(changelog).toContain('feat: new feature');
        expect(changelog).toContain('[2.0.0]');
        expect(changelog).toContain('BREAKING: major change');

        // Release notes all exist in the subdirectory
        expect(fs.existsSync(path.join(testDir, 'release-notes', 'v1.0.1.md'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'release-notes', 'v1.1.0.md'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'release-notes', 'v2.0.0.md'))).toBe(true);

        // Git tags all exist
        const tags = execSync('git tag', { cwd: testDir, encoding: 'utf8' }).split('\n').filter(Boolean);
        expect(tags).toContain('v1.0.1');
        expect(tags).toContain('v1.1.0');
        expect(tags).toContain('v2.0.0');
    });
});
