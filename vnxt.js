#!/usr/bin/env node

const {execSync} = require('child_process');
const fs = require('fs');
const readline = require('readline');

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

// Quiet mode flag
let quietMode = false;

// Helper to log with colors (respects quiet mode and colors config)
function log(message, color = '') {
    if (quietMode) return;
    if (color && colors[color] && config.colors) {
        console.log(`${colors[color]}${message}${colors.reset}`);
    } else {
        console.log(message);
    }
}

function logError(message) {
    // Errors always show, even in quiet mode
    // Colors can be disabled for errors too
    if (config.colors) {
        console.error(`${colors.red}${message}${colors.reset}`);
    } else {
        console.error(message);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);

// Helper to parse flags
function getFlag(flag, short) {
    const index = args.indexOf(flag) !== -1 ? args.indexOf(flag) : args.indexOf(short);
    if (index === -1) return null;
    return args[index + 1] || true;
}

function hasFlag(flag, short) {
    return args.includes(flag) || args.includes(short);
}

// Load config file if exists
let config = {
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
    config = {...config, ...userConfig};
}

// Check for --version flag
if (args.includes('--version') || args.includes('-V')) {
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    console.log(`vnxt v${pkg.version}`);
    process.exit(0);
}

// Check for --quiet flag
if (args.includes('--quiet') || args.includes('-q')) {
    quietMode = true;
}

// Check if in a git repository
if (!fs.existsSync('.git')) {
    logError('❌ Not a git repository. Run `git init` first.');
    process.exit(1);
}

// Parse arguments
let message = getFlag('--message', '-m');
let type = getFlag('--type', '-t') || config.defaultType;
let customVersion = getFlag('--version', '-v');
let dryRun = hasFlag('--dry-run', '-d');
let noPush = hasFlag('--no-push', '-dnp');
let publishToNpm = hasFlag('--publish');
let push = noPush ? false : (hasFlag('--push', '-p') || publishToNpm || config.autoPush);
let generateChangelog = hasFlag('--changelog', '-c') || config.autoChangelog;
const addAllFlag = getFlag('--all', '-a');
let addMode = null;
let promptForStaging = false;
if (addAllFlag) {
    if (typeof addAllFlag === 'string') {
        const mode = addAllFlag.toLowerCase();
        if (['tracked', 'all', 'a', 'interactive', 'i', 'patch', 'p'].includes(mode)) {
            if (mode === 'a') addMode = 'all';
            else if (mode === 'i') addMode = 'interactive';
            else if (mode === 'p') addMode = 'patch';
            else addMode = mode;
        } else {
            logError(`Error: Invalid add mode '${addAllFlag}'. Use: tracked, all, interactive (i), or patch (p)`);
            process.exit(1);
        }
    } else {
        promptForStaging = true;
    }
}
let generateReleaseNotes = hasFlag('--release', '-r');

// Interactive mode helper
async function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin, output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

// Main function
async function main() {
    try {
        // Interactive mode if no message provided
        if (!message) {
            log('🤔 Interactive mode\n', 'cyan');

            message = await prompt('Commit message: ');
            if (!message) {
                logError('Error: Commit message is required');
                process.exit(1);
            }

            const typeInput = await prompt('Version type (patch/minor/major) [auto-detect]: ');
            if (typeInput && ['patch', 'minor', 'major'].includes(typeInput)) {
                type = typeInput;
            }

            const changelogInput = await prompt('Update CHANGELOG.md? (y/n) [n]: ');
            generateChangelog = changelogInput.toLowerCase() === 'y' || changelogInput.toLowerCase() === 'yes' || generateChangelog;

            const releaseNotesInput = await prompt('Generate release notes? (y/n) [n]: ');
            generateReleaseNotes = releaseNotesInput.toLowerCase() === 'y' || releaseNotesInput.toLowerCase() === 'yes';

            const pushInput = await prompt('Push to remote? (y/n) [n]: ');
            push = pushInput.toLowerCase() === 'y' || pushInput.toLowerCase() === 'yes' || push;

            const dryRunInput = await prompt('Dry run (preview only)? (y/n) [n]: ');
            dryRun = dryRunInput.toLowerCase() === 'y' || dryRunInput.toLowerCase() === 'yes';

            log(''); // Blank line before proceeding
        }

        // Auto-detect version type from conventional commit format
        if (!customVersion && !getFlag('--type', '-t')) {
            if (message.startsWith('major:') || message.startsWith('MAJOR:')) {
                type = 'major';
                log('📝 Auto-detected: major version bump', 'cyan');
            } else if (message.startsWith('minor:') || message.startsWith('MINOR:')) {
                type = 'minor';
                log('📝 Auto-detected: minor version bump', 'cyan');
            } else if (message.startsWith('patch:') || message.startsWith('PATCH:')) {
                type = 'patch';
                log('📝 Auto-detected: patch version bump', 'cyan');
            } else if (message.startsWith('feat:') || message.startsWith('feature:')) {
                type = 'minor';
                log('📝 Auto-detected: minor version bump (feature)', 'cyan');
            } else if (message.startsWith('fix:')) {
                type = 'patch';
                log('📝 Auto-detected: patch version bump (fix)', 'cyan');
            } else if (message.includes('BREAKING') || message.startsWith('breaking:')) {
                type = 'major';
                log('📝 Auto-detected: major version bump (breaking change)', 'cyan');
            }
        }

        // Validate version type
        if (!customVersion && !['patch', 'minor', 'major'].includes(type)) {
            logError('Error: Version type must be patch, minor, or major');
            process.exit(1);
        }

        // AUTO-REQUIRE RELEASE NOTES for --publish
        let releaseNotesContext = '';
        const requireReleaseNotes = !generateReleaseNotes && publishToNpm;
        if (requireReleaseNotes) {
            generateReleaseNotes = true;
            if (!quietMode) {
                log(`\n📋 Release notes required for --publish.`, 'yellow');
                releaseNotesContext = await prompt('   Add context (press Enter to skip): ');
                if (releaseNotesContext) log('');
            }
        } else if (generateReleaseNotes && !quietMode) {
            // -r flag was passed explicitly - still offer context prompt
            releaseNotesContext = await prompt('\n📋 Add context to release notes (press Enter to skip): ');
            if (releaseNotesContext) log('');
        }

        // PRE-FLIGHT CHECKS
        log('\n🔍 Running pre-flight checks...\n', 'cyan');

        // Check for uncommitted changes OR if user requested staging prompt
        if ((config.requireCleanWorkingDir && !addMode) || promptForStaging) {
            const status = execSync('git status --porcelain --untracked-files=no').toString().trim();
            if (status || promptForStaging) {
                if (status) {
                    log('⚠️  You have uncommitted changes.\n', 'yellow');
                }
                log('📁 How would you like to stage files?\n');
                log('  1. Tracked files only (git add -u)');
                log('  2. All changes (git add -A)');
                log('  3. Interactive selection (git add -i)');
                log('  4. Patch mode (git add -p)');
                log('  5. Skip staging (continue without staging)\n');

                const choice = await prompt('Select [1-5]: ');

                if (choice === '1') {
                    addMode = 'tracked';
                } else if (choice === '2') {
                    addMode = 'all';
                } else if (choice === '3') {
                    addMode = 'interactive';
                } else if (choice === '4') {
                    addMode = 'patch';
                } else if (choice === '5') {
                    log('⚠️  Skipping file staging. Ensure files are staged manually.', 'yellow');
                } else {
                    logError('Invalid choice. Exiting.');
                    process.exit(1);
                }
                log('');
            }
        }

        // Check current branch
        const branch = execSync('git branch --show-current').toString().trim();
        if (branch !== 'main' && branch !== 'master') {
            log(`⚠️  Warning: You're on branch '${branch}', not main/master`, 'yellow');
        }

        // Check if remote exists
        try {
            execSync('git remote get-url origin', {stdio: 'pipe'});
        } catch {
            if (push) {
                logError('❌ Error: No remote repository configured, cannot push');
                process.exit(1);
            }
            log('⚠️  Warning: No remote repository configured', 'yellow');
        }

        log('✅ Pre-flight checks passed\n', 'green');

        // DRY RUN MODE
        if (dryRun) {
            log('🔬 DRY RUN MODE - No changes will be made\n', 'yellow');
            log('Would perform the following actions:');

            if (addMode) {
                const modeDescriptions = {
                    'tracked': 'Stage tracked files only (git add -u)',
                    'all': 'Stage all changes (git add -A)',
                    'interactive': 'Interactive selection (git add -i)',
                    'patch': 'Patch mode (git add -p)'
                };
                log(`  1. ${modeDescriptions[addMode]}`);
            }

            log(`  2. Bump ${type} version`);
            log(`  3. Commit with message: "${message}"`);
            log('  4. Create git tag with annotation');

            if (generateChangelog) {
                log('  5. Update CHANGELOG.md');
            } else {
                log('  5. (Skipping changelog - use --changelog to enable)');
            }

            if (generateReleaseNotes) {
                log('  6. Generate release notes file');
            } else {
                log('  6. (Skipping release notes - use --release to enable)');
            }

            if (push) {
                log('  7. Push to remote with tags');
            } else {
                log('  7. (Skipping push - use --push to enable)');
            }

            log('\n✓ Dry run complete. Use without -d to apply changes.', 'green');
            process.exit(0);
        }

        // STAGE FILES if requested
        if (addMode) {
            log('📦 Staging files...', 'cyan');

            if (addMode === 'tracked') {
                execSync('git add -u', {stdio: 'inherit'});
            } else if (addMode === 'all') {
                execSync('git add -A', {stdio: 'inherit'});
            } else if (addMode === 'interactive') {
                execSync('git add -i', {stdio: 'inherit'});
            } else if (addMode === 'patch') {
                execSync('git add -p', {stdio: 'inherit'});
            }
        }
        // BUMP VERSION
        log(`\n🔼 Bumping version...`, 'cyan');

        // Get current version before bump
        const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        const oldVersion = packageJson.version;

        // Always disable npm's git integration and handle it ourselves
        if (customVersion) {
            execSync(`npm version ${customVersion} --git-tag-version=false`, {stdio: quietMode ? 'pipe' : 'inherit'});
        } else {
            execSync(`npm version ${type} --git-tag-version=false`, {stdio: quietMode ? 'pipe' : 'inherit'});
        }

        // Get new version
        const newVersion = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;

        // Stage package files
        execSync('git add package.json', {stdio: 'pipe'});
        if (fs.existsSync('package-lock.json')) {
            execSync('git add package-lock.json', {stdio: 'pipe'});
        }

        // Commit with user's message
        execSync(`git commit -m "${message}"`, {stdio: quietMode ? 'pipe' : 'inherit'});

        // Create annotated tag
        log('🏷️  Adding tag annotation...', 'cyan');
        const tagMessage = `Version ${newVersion}\n\n${message}`;
        execSync(`git tag -a ${config.tagPrefix}${newVersion} -m "${tagMessage}"`, {stdio: 'pipe'});

        // GENERATE CHANGELOG
        if (generateChangelog) {
            log('📄 Updating CHANGELOG.md...', 'cyan');
            const date = new Date().toISOString().split('T')[0];
            const changelogEntry = `\n## [${newVersion}] - ${date}\n- ${message}\n`;

            let changelog = '# Changelog\n';
            if (fs.existsSync('CHANGELOG.md')) {
                changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
            }

            // Insert new entry after the title
            const lines = changelog.split('\n');
            const titleIndex = lines.findIndex(line => line.startsWith('# Changelog'));
            lines.splice(titleIndex + 1, 0, changelogEntry);

            fs.writeFileSync('CHANGELOG.md', lines.join('\n'));

            // Stage the changelog
            execSync('git add CHANGELOG.md', {stdio: 'pipe'});
            execSync(`git commit --amend --no-edit`, {stdio: 'pipe'});
        }

        // GENERATE RELEASE NOTES
        if (generateReleaseNotes) {
            log('📋 Generating release notes...', 'cyan');

            const date = new Date();
            const timestamp = date.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
            const dateShort = date.toISOString().split('T')[0];

            let author = '';
            try {
                author = execSync('git config user.name', {stdio: 'pipe'}).toString().trim();
            } catch {
                author = '';
            }

            const releaseNotes = `# Release ${config.tagPrefix}${newVersion}

Released: ${dateShort} at ${timestamp.split(' ')[1]}${author ? `\nAuthor: ${author}` : ''}

## Changes
${message}${releaseNotesContext ? `\n\n## Release Notes\n${releaseNotesContext}` : ''}

## Installation
\`\`\`bash
npm install ${packageJson.name}@${newVersion}
\`\`\`

## Full Changelog
See [CHANGELOG.md](../CHANGELOG.md) for complete version history.
`;

            const releaseNotesDir = 'release-notes';
            if (!fs.existsSync(releaseNotesDir)) {
                fs.mkdirSync(releaseNotesDir);
            }

            const filename = `${releaseNotesDir}/${config.tagPrefix}${newVersion}.md`;
            fs.writeFileSync(filename, releaseNotes);
            log(`   Created: ${filename}`);

            // Stage and amend commit to include release notes
            execSync(`git add ${filename}`, {stdio: 'pipe'});
            execSync(`git commit --amend --no-edit`, {stdio: 'pipe'});
        }

        // PUSH TO REMOTE
        if (push) {
            log('🚀 Pushing to remote...', 'cyan');
            execSync('git push --follow-tags', {stdio: quietMode ? 'pipe' : 'inherit'});

            // If --publish flag, also push a publish/v* tag to trigger npm workflow
            if (publishToNpm) {
                log('📦 Pushing publish tag to trigger npm release...', 'cyan');
                const publishTag = `publish/${config.tagPrefix}${newVersion}`;
                execSync(`git tag ${publishTag}`, {stdio: 'pipe'});
                execSync(`git push origin ${publishTag}`, {stdio: quietMode ? 'pipe' : 'inherit'});
            }
        }

        // STATS/SUMMARY
        log('\n📊 Summary:', 'cyan');
        log('━'.repeat(50), 'gray');

        log(`\n📦 Version: ${oldVersion} → ${newVersion}`, 'green');
        log(`💬 Message: ${message}`);
        log(`🏷️  Tag: ${config.tagPrefix}${newVersion}`);
        log(`🌿 Branch: ${branch}`);

        if (generateChangelog) {
            log(`📄 Changelog: Updated`);
        }

        if (generateReleaseNotes) {
            log(`📋 Release notes: Generated`);
        }

        if (push) {
            log(`🚀 Remote: Pushed with tags`, 'green');
            if (publishToNpm) {
                log(`📦 npm: Publishing triggered (publish/${config.tagPrefix}${newVersion})`, 'green');
            }
        } else {
            log(`📍 Remote: Not pushed (use --push to enable)`, 'gray');
        }

        // Show files changed
        if (!quietMode) {
            log('\n📝 Files changed:');
            const diff = execSync('git diff HEAD~1 --stat').toString();
            console.log(diff);
        }

        log('━'.repeat(50), 'gray');
        log('\n✅ Version bump complete!\n', 'green');

    } catch (error) {
        logError('\n❌ Error: ' + error.message);
        process.exit(1);
    }
}

// Show help
if (hasFlag('--help', '-h')) {
    console.log(`
vnxt (vx) - Version Bump CLI Tool

Usage:
  vnxt [options]
  vx -m "commit message" [options]

Options:
  -m, --message <msg>      Commit message (required, or use interactive mode)
  -t, --type <type>        Version type: patch, minor, major (auto-detected from message)
  -v, --version <ver>      Set specific version (e.g., 2.0.0-beta.1)
  -V, --version            Show vnxt version
  -p, --push               Push to remote with tags
  -dnp, --no-push          Prevent auto-push (overrides config)
  --publish                Push and trigger npm publish via GitHub Actions
  -c, --changelog          Update CHANGELOG.md
  -d, --dry-run            Show what would happen without making changes
  -a, --all [mode]         Stage files before versioning
                           Modes: tracked (default), all, interactive (i), patch (p)
                           If no mode specified, prompts interactively
  -r, --release            Generate release notes file
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
  vx -V                                   # Show version
  vx -m "fix: resolve bug"                # Auto-pushes with autoPush: true
  vx -m "feat: add new feature"           # Auto-pushes with autoPush: true
  vx -m "fix: bug" -dnp                   # Don't push (override)
  vx -v 2.0.0-beta.1 -m "beta release"
  vx -m "test" -d
  vx -m "fix: bug" -a                     # Interactive prompt for staging
  vx -m "fix: bug" -a tracked             # Stage tracked files only
  vx -m "fix: bug" -a all                 # Stage all changes
  vx -m "fix: bug" -a i                   # Interactive git add
  vx -m "fix: bug" -a p                   # Patch mode
  vx -m "fix: bug" -q                     # Quiet mode (minimal output)
  vx -m "feat: new feature" --publish     # Bump, push and trigger npm publish
  vx                                      # Interactive mode
`);
    process.exit(0);
}

// Run main function
main();