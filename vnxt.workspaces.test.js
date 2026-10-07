// vnxt.workspaces.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    UserError,
    readWorkspaces,
    parseSelectors,
    collectWorkspaceSelectors,
    setLockfileVersion,
    workspaceTagName,
    resolveTargets,
    inferTarget
} = require('./vnxt.js');

let tmpRoot;
let counter = 0;

beforeAll(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vnxt-ws-')));
});

afterAll(() => {
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.warn(`Warning: Could not clean up ${tmpRoot}`);
    }
});

// Builds a repo from { 'relative/path': contents }
function buildRepo(files) {
    const root = path.join(tmpRoot, `repo-${++counter}`);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, contents] of Object.entries(files)) {
        const target = path.join(root, rel);
        if (contents === null) {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
    }
    return root;
}

// Two apps and three source-only packages, plus folders that must be ignored
function standardRepo(rootExtras = {}) {
    return buildRepo({
        'package.json': {
            name: 'fixture-root',
            private: true,
            workspaces: ['apps/*', 'packages/*'],
            ...rootExtras
        },
        'apps/app-one/package.json': { name: 'app-one', version: '0.1.1', private: true },
        'apps/app-two/package.json': { name: 'app-two', version: '0.2.6', private: true },
        'packages/shared-api/package.json': { name: '@fixture/shared-api', version: '0.0.0', private: true },
        'packages/shared-theme/package.json': { name: '@fixture/shared-theme', version: '0.0.0', private: true },
        'packages/shared-form/package.json': { name: '@fixture/shared-form', version: '0.0.0', private: true },
        'packages/shared-theme/src/components/button.js': '// deep file\n',
        'apps/not-a-package': null,
        'apps/.hidden/package.json': { name: 'hidden', version: '9.9.9' },
        'packages/node_modules/leftpad/package.json': { name: 'leftpad', version: '1.0.0' }
    });
}

function names(workspaces) {
    return workspaces.map(ws => ws.name);
}

function messageOf(fn) {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(UserError);
        return err.message;
    }
    throw new Error('Expected a UserError, but nothing was thrown');
}

describe('importing vnxt.js', () => {
    test('does not run the command line tool', () => {
        expect(typeof resolveTargets).toBe('function');
    });
});

describe('readWorkspaces', () => {
    test('finds folders matched by a trailing *, skipping hidden, node_modules and non-packages', () => {
        const root = standardRepo();
        const found = readWorkspaces(root);

        expect(found.map(ws => ws.dir)).toEqual([
            'apps/app-one',
            'apps/app-two',
            'packages/shared-api',
            'packages/shared-form',
            'packages/shared-theme'
        ]);
    });

    test('reports name, folder, version and privacy for each workspace', () => {
        const root = standardRepo();
        const appOne = readWorkspaces(root).find(ws => ws.name === 'app-one');

        expect(appOne).toEqual({
            name: 'app-one',
            dir: 'apps/app-one',
            abs: path.join(root, 'apps', 'app-one'),
            version: '0.1.1',
            private: true
        });
    });

    test('reads scoped package names', () => {
        const root = standardRepo();
        expect(names(readWorkspaces(root))).toEqual(
            expect.arrayContaining(['@fixture/shared-api', '@fixture/shared-form', '@fixture/shared-theme'])
        );
    });

    test('supports the object form, plain folders, a ./ prefix and a trailing slash', () => {
        const root = buildRepo({
            'package.json': { name: 'r', workspaces: { packages: ['./apps/app-one/', 'tools/cli'] } },
            'apps/app-one/package.json': { name: 'app-one', version: '1.0.0' },
            'apps/app-two/package.json': { name: 'app-two', version: '1.0.0' },
            'tools/cli/package.json': { name: 'cli', version: '1.0.0' }
        });

        expect(names(readWorkspaces(root))).toEqual(['app-one', 'cli']);
    });

    test('supports a * inside the last segment', () => {
        const root = buildRepo({
            'package.json': { name: 'r', workspaces: ['packages/shared-*'] },
            'packages/shared-a/package.json': { name: 'a', version: '1.0.0' },
            'packages/shared-b/package.json': { name: 'b', version: '1.0.0' },
            'packages/other/package.json': { name: 'other', version: '1.0.0' }
        });

        expect(names(readWorkspaces(root))).toEqual(['a', 'b']);
    });

    test('a workspace with no name falls back to its folder name', () => {
        const root = buildRepo({
            'package.json': { name: 'r', workspaces: ['apps/*'] },
            'apps/nameless/package.json': { version: '1.0.0' }
        });

        expect(names(readWorkspaces(root))).toEqual(['nameless']);
    });

    test('does not list a folder twice when two patterns match it', () => {
        const root = buildRepo({
            'package.json': { name: 'r', workspaces: ['apps/*', 'apps/app-one'] },
            'apps/app-one/package.json': { name: 'app-one', version: '1.0.0' }
        });

        expect(readWorkspaces(root)).toHaveLength(1);
    });

    test.each([
        ['**', 'apps/**'],
        ['negation', '!apps/skip'],
        ['a * in a middle segment', 'apps/*/inner'],
        ['brace expansion', 'apps/{a,b}']
    ])('refuses a pattern with %s, naming the pattern', (_label, pattern) => {
        const root = buildRepo({ 'package.json': { name: 'r', workspaces: [pattern] } });

        expect(messageOf(() => readWorkspaces(root))).toContain(pattern);
    });

    test('refuses two workspaces with the same name', () => {
        const root = buildRepo({
            'package.json': { name: 'r', workspaces: ['apps/*'] },
            'apps/a/package.json': { name: 'same', version: '1.0.0' },
            'apps/b/package.json': { name: 'same', version: '1.0.0' }
        });

        const message = messageOf(() => readWorkspaces(root));
        expect(message).toContain("'same'");
        expect(message).toContain('apps/a');
        expect(message).toContain('apps/b');
    });

    test('names the file when a workspace package.json is not valid JSON', () => {
        const root = buildRepo({
            'package.json': { name: 'r', workspaces: ['apps/*'] },
            'apps/broken/package.json': '{ "name": '
        });

        expect(messageOf(() => readWorkspaces(root))).toContain('apps/broken/package.json');
    });

    test('reads a package.json that starts with a byte order mark', () => {
        const root = buildRepo({
            'package.json': '\uFEFF' + JSON.stringify({ name: 'r', workspaces: ['apps/*'] }),
            'apps/a/package.json': '\uFEFF' + JSON.stringify({ name: 'a', version: '1.0.0' })
        });

        expect(names(readWorkspaces(root))).toEqual(['a']);
    });

    test('returns an empty list when the root declares no workspaces', () => {
        const root = buildRepo({ 'package.json': { name: 'plain', version: '1.0.0' } });

        expect(readWorkspaces(root)).toEqual([]);
    });
});

describe('parseSelectors', () => {
    test('splits comma lists and flattens repeated flags', () => {
        expect(parseSelectors(['app-one,app-two', 'packages/shared-api'])).toEqual([
            'app-one', 'app-two', 'packages/shared-api'
        ]);
    });

    test('trims spaces, drops empty items and removes duplicates', () => {
        expect(parseSelectors([' a , ,b', 'a', ''])).toEqual(['a', 'b']);
    });

    test('accepts a single string, nothing, or undefined', () => {
        expect(parseSelectors('a,b')).toEqual(['a', 'b']);
        expect(parseSelectors([])).toEqual([]);
        expect(parseSelectors(undefined)).toEqual([]);
    });
});

describe('setLockfileVersion', () => {
    const packages = () => ({
        '': { name: 'r', workspaces: ['apps/*'] },
        'apps/a': { version: '1.0.0', private: true },
        'apps/b': { version: '2.0.0' }
    });

    // Lockfile text in a given style, so every style can be checked byte for byte
    function lockText(pkgs, { indent = 2, newline = '\n', final = true } = {}) {
        const json = JSON.stringify({ name: 'r', lockfileVersion: 3, packages: pkgs }, null, indent);
        return json.replace(/\n/g, newline) + (final ? newline : '');
    }

    test('changes only the named entry\'s version', () => {
        const result = JSON.parse(setLockfileVersion(lockText(packages()), 'apps/a', '1.0.1'));

        expect(result.packages['apps/a']).toEqual({ version: '1.0.1', private: true });
        expect(result.packages['apps/b']).toEqual({ version: '2.0.0' });
        expect(result.packages['']).toEqual(packages()['']);
        expect(result.lockfileVersion).toBe(3);
    });

    test.each([
        ['2 spaces, LF, final newline', { indent: 2, newline: '\n', final: true }],
        ['4 spaces', { indent: 4 }],
        ['tabs', { indent: '\t' }],
        ['CRLF', { newline: '\r\n' }],
        ['no final newline', { final: false }],
        ['CRLF with no final newline', { newline: '\r\n', final: false }]
    ])('keeps the file byte for byte apart from the version (%s)', (_label, style) => {
        const expected = lockText({ ...packages(), 'apps/a': { version: '1.0.1', private: true } }, style);

        expect(setLockfileVersion(lockText(packages(), style), 'apps/a', '1.0.1')).toBe(expected);
    });

    test('leaves the text alone when the workspace has no entry', () => {
        const text = lockText(packages());

        expect(setLockfileVersion(text, 'apps/missing', '3.0.0')).toBe(text);
    });

    test('puts a version first when the entry has none', () => {
        const pkgs = { ...packages(), 'apps/c': { private: true } };
        const entry = JSON.parse(setLockfileVersion(lockText(pkgs), 'apps/c', '0.0.1')).packages['apps/c'];

        expect(Object.keys(entry)).toEqual(['version', 'private']);
    });

    test('keeps a name that comes before the version where it is', () => {
        const pkgs = { ...packages(), 'apps/c': { name: 'c', version: '0.0.0' } };
        const entry = JSON.parse(setLockfileVersion(lockText(pkgs), 'apps/c', '0.0.1')).packages['apps/c'];

        expect(Object.keys(entry)).toEqual(['name', 'version']);
        expect(entry.version).toBe('0.0.1');
    });

    test('refuses a lockfile that would be reformatted, such as a minified one', () => {
        const minified = JSON.stringify({ name: 'r', lockfileVersion: 3, packages: packages() }) + '\n';

        expect(messageOf(() => setLockfileVersion(minified, 'apps/a', '1.0.1'))).toContain('cannot edit safely');
    });

    test('refuses a lockfile that is not valid JSON', () => {
        expect(messageOf(() => setLockfileVersion('{ "name": ', 'apps/a', '1.0.1'))).toContain('not valid JSON');
    });
});

describe('workspaceTagName', () => {
    test.each([
        ['app-one', '0.1.2', 'app-one@0.1.2'],
        ['@acme/ui', '1.0.0', 'acme/ui@1.0.0'],
        ['@acme/errors', '2.0.0-beta.1', 'acme/errors@2.0.0-beta.1'],
        ['plain', '1.0.0+build.5', 'plain@1.0.0+build.5']
    ])('%s at %s is tagged %s', (name, version, expected) => {
        expect(workspaceTagName({ name }, version)).toBe(expected);
    });

    test('two workspaces at the same version get different tags', () => {
        expect(workspaceTagName({ name: 'app-a' }, '0.1.2')).not.toBe(workspaceTagName({ name: 'app-b' }, '0.1.2'));
    });

    test('a scoped and an unscoped name cannot produce the same tag', () => {
        expect(workspaceTagName({ name: '@a/b' }, '1.0.0')).toBe('a/b@1.0.0');
        expect(workspaceTagName({ name: 'a' }, '1.0.0')).toBe('a@1.0.0');
    });
});

describe('collectWorkspaceSelectors', () => {
    test.each([
        [['-w', 'a'], ['a']],
        [['--workspace', 'a'], ['a']],
        [['--workspace=a,b'], ['a', 'b']],
        [['-w', 'a,b'], ['a', 'b']],
        [['-w', 'a', 'b', '-d'], ['a', 'b']],
        [['-w', 'a', '-m', 'fix: x', '-w', 'b'], ['a', 'b']],
        [['-w', 'a', '--workspace=b', '-w', 'a'], ['a', 'b']],
        [['-m', 'fix: x', '-d'], []],
        [[], []]
    ])('%j gives %j', (argv, expected) => {
        expect(collectWorkspaceSelectors(argv)).toEqual(expected);
    });

    test.each([
        ['-w with nothing after it', ['-w']],
        ['-w followed by another flag', ['-w', '-d']],
        ['-w followed by -m', ['-w', '-m', 'fix: x']],
        ['--workspace with nothing after it', ['--workspace']],
        ['an empty --workspace=', ['--workspace=']]
    ])('refuses %s', (_label, argv) => {
        expect(() => collectWorkspaceSelectors(argv)).toThrow(UserError);
    });

    test('does not take a commit message for a workspace', () => {
        expect(collectWorkspaceSelectors(['-m', 'fix: app-one', '-w', 'app-two'])).toEqual(['app-two']);
    });
});

describe('resolveTargets with selectors', () => {
    test('finds a workspace by package name, scoped or not', () => {
        const root = standardRepo();

        expect(names(resolveTargets({ root, startDir: root, selectors: ['app-one'] }))).toEqual(['app-one']);
        expect(names(resolveTargets({ root, startDir: root, selectors: ['@fixture/shared-form'] })))
            .toEqual(['@fixture/shared-form']);
    });

    test.each([
        ['a relative path', 'apps/app-one'],
        ['a path with ./ and a trailing slash', './apps/app-one/'],
        ['a path with Windows separators', 'apps\\app-one']
    ])('finds a workspace by %s', (_label, selector) => {
        const root = standardRepo();

        expect(names(resolveTargets({ root, startDir: root, selectors: [selector] }))).toEqual(['app-one']);
    });

    test('finds a workspace by absolute path', () => {
        const root = standardRepo();
        const selector = path.join(root, 'apps', 'app-two');

        expect(names(resolveTargets({ root, startDir: root, selectors: [selector] }))).toEqual(['app-two']);
    });

    test('resolves a path relative to the folder vnxt was started in', () => {
        const root = standardRepo();
        const startDir = path.join(root, 'apps', 'app-one');

        expect(names(resolveTargets({ root, startDir, selectors: ['../app-two'] }))).toEqual(['app-two']);
    });

    test('takes several selectors, repeated or comma separated, without duplicates', () => {
        const root = standardRepo();
        const targets = resolveTargets({
            root,
            startDir: root,
            selectors: ['app-one,apps/app-two', 'apps/app-one', '@fixture/shared-api']
        });

        expect(names(targets)).toEqual(['app-one', 'app-two', '@fixture/shared-api']);
    });

    test.each([
        ['a dot', '.'],
        ['the root package name', 'fixture-root'],
        ['a path that climbs back to the root', 'apps/..']
    ])('refuses the repo root given as %s', (_label, selector) => {
        const root = standardRepo();
        const message = messageOf(() => resolveTargets({ root, startDir: root, selectors: [selector] }));

        expect(message).toContain('repo root');
        expect(message).toContain('app-one');
    });

    test('refuses a folder that holds several workspaces, and names them', () => {
        const root = standardRepo();
        const message = messageOf(() => resolveTargets({ root, startDir: root, selectors: ['apps'] }));

        expect(message).toContain('app-one');
        expect(message).toContain('app-two');
    });

    test('lists what is available when nothing matches', () => {
        const root = standardRepo();
        const message = messageOf(() => resolveTargets({ root, startDir: root, selectors: ['app-three'] }));

        expect(message).toContain("'app-three'");
        expect(message).toContain('app-one (apps/app-one)');
    });

    test('refuses -w in a repo that declares no workspaces', () => {
        const root = buildRepo({ 'package.json': { name: 'plain', version: '1.0.0' } });
        const message = messageOf(() => resolveTargets({ root, startDir: root, selectors: ['anything'] }));

        expect(message).toContain('workspaces');
    });
});

describe('resolveTargets without selectors', () => {
    test.each([
        ['the workspace folder itself', 'apps/app-one', 'app-one'],
        ['a folder deep inside a workspace', 'packages/shared-theme/src/components', '@fixture/shared-theme']
    ])('picks the workspace from %s', (_label, start, expected) => {
        const root = standardRepo();
        const startDir = path.join(root, ...start.split('/'));

        expect(names(resolveTargets({ root, startDir, selectors: [] }))).toEqual([expected]);
    });

    test.each([
        ['the repo root', ''],
        ['a folder between workspaces', 'apps'],
        ['a folder that is not part of any workspace', 'apps/not-a-package']
    ])('refuses from %s, and lists the workspaces', (_label, start) => {
        const root = standardRepo();
        const startDir = path.join(root, ...start.split('/').filter(Boolean));
        const message = messageOf(() => resolveTargets({ root, startDir, selectors: [] }));

        expect(message).toContain('inside a workspace folder');
        expect(message).toContain('app-one (apps/app-one)');
    });

    test('refuses from a folder outside the repo', () => {
        const root = standardRepo();
        const outside = buildRepo({ 'elsewhere/placeholder.txt': 'x' });

        expect(messageOf(() => resolveTargets({ root, startDir: outside, selectors: [] })))
            .toContain('inside a workspace folder');
    });

    test('returns null for a repo with no workspaces, so single-package behaviour carries on', () => {
        const root = buildRepo({ 'package.json': { name: 'plain', version: '1.0.0' } });

        expect(resolveTargets({ root, startDir: root, selectors: [] })).toBeNull();
    });

    test('refuses a repo that declares workspaces but has none on disk', () => {
        const root = buildRepo({ 'package.json': { name: 'r', workspaces: ['apps/*'] } });

        expect(messageOf(() => resolveTargets({ root, startDir: root, selectors: [] })))
            .toContain('none of them were found');
    });
});

describe('inferTarget', () => {
    test('returns the nearest enclosing workspace, or null', () => {
        const root = standardRepo();
        const workspaces = readWorkspaces(root);

        expect(inferTarget(path.join(root, 'apps', 'app-two', 'src'), root, workspaces).name).toBe('app-two');
        expect(inferTarget(root, root, workspaces)).toBeNull();
        expect(inferTarget(path.join(root, 'apps'), root, workspaces)).toBeNull();
    });
});