const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Test helper to create a temporary git repo
function createTestRepo(testDir) {
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    // Initialize git repo
    execSync('git init', { cwd: testDir });
    execSync('git config user.email "test@test.com"', { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });

    // Create package.json
    const packageJson = {
        name: 'test-package',
        version: '1.0.0'
    };
    fs.writeFileSync(
        path.join(testDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
    );

    // Initial commit
    execSync('git add .', { cwd: testDir });
    execSync('git commit -m "initial commit"', { cwd: testDir });
}

// Clean up test directory with retry logic for Windows
function cleanupTestRepo(testDir) {
    if (fs.existsSync(testDir)) {
        try {
            // Small delay to let Windows release file handles
            const delay = ms => {
                const start = Date.now();
                while (Date.now() - start < ms) {}
            };
            delay(100);

            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (error) {
            // Retry once after a longer delay
            const delay = ms => {
                const start = Date.now();
                while (Date.now() - start < ms) {}
            };
            delay(500);

            try {
                fs.rmSync(testDir, { recursive: true, force: true });
            } catch (retryError) {
                console.warn(`Warning: Could not cleanup ${testDir}`);
            }
        }
    }
}

describe('vbump CLI', () => {
    const testDir = path.join(__dirname, 'test-repo');
    const vbumpPath = path.join(__dirname, 'vbump.js');

    beforeEach(() => {
        createTestRepo(testDir);
    });

    afterEach(() => {
        cleanupTestRepo(testDir);
    });

    describe('Version Bumping', () => {
        test('should bump patch version', () => {
            const result = execSync(
                `node ${vbumpPath} -m "fix: test patch"`,
                { cwd: testDir, encoding: 'utf8' }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('1.0.1');
            expect(result).toContain('1.0.0 → 1.0.1');
        });

        test('should bump minor version', () => {
            execSync(
                `node ${vbumpPath} -m "feat: test feature" -t minor`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('1.1.0');
        });

        test('should bump major version', () => {
            execSync(
                `node ${vbumpPath} -m "BREAKING: major change" -t major`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('2.0.0');
        });

        test('should set custom version', () => {
            execSync(
                `node ${vbumpPath} -v 2.5.0-beta.1 -m "beta release"`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('2.5.0-beta.1');
        });
    });

    describe('Auto-detection', () => {
        test('should auto-detect patch from "fix:" prefix', () => {
            execSync(
                `node ${vbumpPath} -m "fix: bug fix"`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('1.0.1');
        });

        test('should auto-detect minor from "feat:" prefix', () => {
            execSync(
                `node ${vbumpPath} -m "feat: new feature"`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('1.1.0');
        });

        test('should auto-detect major from "BREAKING" keyword', () => {
            execSync(
                `node ${vbumpPath} -m "BREAKING: api change"`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('2.0.0');
        });
    });

    describe('Git Integration', () => {
        test('should create git commit', () => {
            execSync(
                `node ${vbumpPath} -m "fix: test commit" -a`,  // Add -a flag
                { cwd: testDir }
            );

            const log = execSync('git log --oneline', {
                cwd: testDir,
                encoding: 'utf8'
            });

            expect(log).toContain('fix: test commit');
        });

        test('should create git tag', () => {
            execSync(
                `node ${vbumpPath} -m "feat: test tag"`,
                { cwd: testDir }
            );

            const tags = execSync('git tag', {
                cwd: testDir,
                encoding: 'utf8'
            });

            expect(tags).toContain('v1.1.0');
        });

        test('should annotate git tag with message', () => {
            execSync(
                `node ${vbumpPath} -m "fix: annotated tag" -a`,  // Add -a flag
                { cwd: testDir }
            );

            const tagMessage = execSync('git tag -l v1.0.1 -n99', {
                cwd: testDir,
                encoding: 'utf8'
            });

            expect(tagMessage).toContain('Version 1.0.1');

            // Check the actual tag annotation body with git show
            const fullAnnotation = execSync('git show v1.0.1 --no-patch', {
                cwd: testDir,
                encoding: 'utf8'
            });

            expect(fullAnnotation).toContain('fix: annotated tag');
        });
    });

    describe('Changelog Generation', () => {
        test('should create CHANGELOG.md', () => {
            execSync(
                `node ${vbumpPath} -m "feat: first feature" -c`,
                { cwd: testDir }
            );

            const changelogPath = path.join(testDir, 'CHANGELOG.md');
            expect(fs.existsSync(changelogPath)).toBe(true);
        });

        test('should add entry to CHANGELOG.md', () => {
            execSync(
                `node ${vbumpPath} -m "feat: test changelog" -c`,
                { cwd: testDir }
            );

            const changelog = fs.readFileSync(
                path.join(testDir, 'CHANGELOG.md'),
                'utf8'
            );

            expect(changelog).toContain('# Changelog');
            expect(changelog).toContain('[1.1.0]');
            expect(changelog).toContain('feat: test changelog');
        });

        test('should append to existing CHANGELOG.md', () => {
            // First bump
            execSync(
                `node ${vbumpPath} -m "feat: first" -c`,
                { cwd: testDir }
            );

            // Second bump
            execSync(
                `node ${vbumpPath} -m "fix: second" -c`,
                { cwd: testDir }
            );

            const changelog = fs.readFileSync(
                path.join(testDir, 'CHANGELOG.md'),
                'utf8'
            );

            expect(changelog).toContain('[1.1.0]');
            expect(changelog).toContain('feat: first');
            expect(changelog).toContain('[1.1.1]');
            expect(changelog).toContain('fix: second');
        });
    });

    describe('Release Notes', () => {
        test('should generate release notes file', () => {
            execSync(
                `node ${vbumpPath} -m "feat: release" -r`,
                { cwd: testDir }
            );

            const releaseNotesPath = path.join(testDir, 'release-notes-v1.1.0.md');
            expect(fs.existsSync(releaseNotesPath)).toBe(true);
        });

        test('release notes should contain version and message', () => {
            execSync(
                `node ${vbumpPath} -m "feat: new release" -r`,
                { cwd: testDir }
            );

            const releaseNotes = fs.readFileSync(
                path.join(testDir, 'release-notes-v1.1.0.md'),
                'utf8'
            );

            expect(releaseNotes).toContain('Release v1.1.0');
            expect(releaseNotes).toContain('feat: new release');
        });
    });

    describe('Dry Run Mode', () => {
        test('should not modify version in dry run', () => {
            execSync(
                `node ${vbumpPath} -m "fix: dry run test" -d`,
                { cwd: testDir }
            );

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('1.0.0'); // Unchanged
        });

        test('should not create commits in dry run', () => {
            execSync(
                `node ${vbumpPath} -m "fix: dry run commit" -d`,
                { cwd: testDir }
            );

            const log = execSync('git log --oneline', {
                cwd: testDir,
                encoding: 'utf8'
            });

            expect(log).not.toContain('dry run commit');
        });
    });

    describe('Pre-flight Checks', () => {
        test('should fail with uncommitted changes (without --all)', () => {
            // Create uncommitted file
            fs.writeFileSync(path.join(testDir, 'test.txt'), 'uncommitted');

            expect(() => {
                execSync(
                    `node ${vbumpPath} -m "fix: should fail"`,
                    { cwd: testDir, stdio: 'pipe' }
                );
            }).toThrow();
        });

        test('should succeed with --all flag despite uncommitted changes', () => {
            // Create uncommitted file
            fs.writeFileSync(path.join(testDir, 'test.txt'), 'uncommitted');

            expect(() => {
                execSync(
                    `node ${vbumpPath} -m "fix: with all flag" -a`,
                    { cwd: testDir }
                );
            }).not.toThrow();

            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );

            expect(packageJson.version).toBe('1.0.1');
        });
    });

    describe('Configuration File', () => {
        test('should read .vbumprc.json config', () => {
            const config = {
                autoChangelog: true,
                defaultType: 'minor'
            };

            fs.writeFileSync(
                path.join(testDir, '.vbumprc.json'),
                JSON.stringify(config)
            );

            execSync('git add .vbumprc.json', { cwd: testDir });
            execSync('git commit -m "add config"', { cwd: testDir });

            execSync(
                `node ${vbumpPath} -m "test: config test"`,
                { cwd: testDir }
            );

            // Should use minor as default
            const packageJson = JSON.parse(
                fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
            );
            expect(packageJson.version).toBe('1.1.0');

            // Should auto-create changelog
            expect(fs.existsSync(path.join(testDir, 'CHANGELOG.md'))).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('should require commit message', () => {
            expect(() => {
                execSync(
                    `node ${vbumpPath}`,
                    { cwd: testDir, stdio: 'pipe', input: '\n\n' }
                );
            }).toThrow();
        });

        test('should reject invalid version type', () => {
            expect(() => {
                execSync(
                    `node ${vbumpPath} -m "test" -t invalid`,
                    { cwd: testDir, stdio: 'pipe' }
                );
            }).toThrow();
        });
    });

    describe('Stage All Changes', () => {
        test('should stage all files with --all flag', () => {
            // Create multiple uncommitted files
            fs.writeFileSync(path.join(testDir, 'file1.txt'), 'content1');
            fs.writeFileSync(path.join(testDir, 'file2.txt'), 'content2');

            execSync(
                `node ${vbumpPath} -m "chore: stage all" -a`,
                { cwd: testDir }
            );

            const status = execSync('git status --porcelain', {
                cwd: testDir,
                encoding: 'utf8'
            });

            // Should be no uncommitted files
            expect(status.trim()).toBe('');
        });
    });
});

// Integration test
describe('Full Workflow Integration', () => {
    const testDir = path.join(__dirname, 'integration-test');
    const vbumpPath = path.join(__dirname, 'vbump.js');

    beforeAll(() => {
        createTestRepo(testDir);
    });

    afterAll(() => {
        cleanupTestRepo(testDir);
    });

    test('complete workflow: bump, changelog, release notes', () => {
        // First feature
        execSync(
            `node ${vbumpPath} -m "feat: first feature" -c -r -a`,
            { cwd: testDir }
        );

        let packageJson = JSON.parse(
            fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
        );
        expect(packageJson.version).toBe('1.1.0');

        // Bug fix
        execSync(
            `node ${vbumpPath} -m "fix: bug fix" -c -r -a`,
            { cwd: testDir }
        );

        packageJson = JSON.parse(
            fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
        );
        expect(packageJson.version).toBe('1.1.1');

        // Breaking change
        execSync(
            `node ${vbumpPath} -m "BREAKING: major change" -c -r -a`,
            { cwd: testDir }
        );

        packageJson = JSON.parse(
            fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
        );
        expect(packageJson.version).toBe('2.0.0');

        // Verify changelog has all entries
        const changelog = fs.readFileSync(
            path.join(testDir, 'CHANGELOG.md'),
            'utf8'
        );

        expect(changelog).toContain('[1.1.0]');
        expect(changelog).toContain('feat: first feature');
        expect(changelog).toContain('[1.1.1]');
        expect(changelog).toContain('fix: bug fix');
        expect(changelog).toContain('[2.0.0]');
        expect(changelog).toContain('BREAKING: major change');

        // Verify all release notes exist
        expect(fs.existsSync(path.join(testDir, 'release-notes-v1.1.0.md'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'release-notes-v1.1.1.md'))).toBe(true);
        expect(fs.existsSync(path.join(testDir, 'release-notes-v2.0.0.md'))).toBe(true);

        // Verify git tags
        const tags = execSync('git tag', {
            cwd: testDir,
            encoding: 'utf8'
        }).split('\n').filter(Boolean);

        expect(tags).toContain('v1.1.0');
        expect(tags).toContain('v1.1.1');
        expect(tags).toContain('v2.0.0');
    });
});