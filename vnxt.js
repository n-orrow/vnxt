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

const config = loadConfig();

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

    // Stage package files and commit
    execSync('git add package.json', {stdio: 'pipe'});
    if (fs.existsSync('package-lock.json')) {
        execSync('git add package-lock.json', {stdio: 'pipe'});
    }
    execFileSync('git', ['commit', '-m', opts.message], {stdio: quietMode ? 'pipe' : 'inherit'});

    // Create annotated tag
    log('🏷️  Adding tag annotation...', 'cyan');
    const tagMessage = `Version ${newVersion}\n\n${opts.message}`;
    execFileSync('git', ['tag', '-a', `${config.tagPrefix}${newVersion}`, '-m', tagMessage], {stdio: 'pipe'});

    return { oldVersion, newVersion, packageJson };
}

// =============================================================================
// Generate Changelog
// =============================================================================

function generateChangelog(newVersion, message) {
    log('📄 Updating CHANGELOG.md...', 'cyan');

    const date = new Date().toISOString().split('T')[0];
    const entry = `\n## [${newVersion}] - ${date}\n- ${message}\n`;

    let changelog = '# Changelog\n';
    if (fs.existsSync('CHANGELOG.md')) {
        changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
    }

    const lines = changelog.split('\n');
    const titleIndex = lines.findIndex(line => line.startsWith('# Changelog'));
    lines.splice(titleIndex + 1, 0, entry);
    fs.writeFileSync('CHANGELOG.md', lines.join('\n'));

    execSync('git add CHANGELOG.md', {stdio: 'pipe'});
    execSync('git commit --amend --no-edit', {stdio: 'pipe'});
}

// =============================================================================
// Generate Release Notes
// =============================================================================

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
                const commits = execSync(
                    `git log ${lastPublishTag}..HEAD --pretty=format:"- %s"`,
                    {stdio: 'pipe'}
                ).toString().trim();
                if (commits) changes = commits;
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
    execSync('git commit --amend --no-edit', {stdio: 'pipe'});
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

        // Git repo check
        if (!fs.existsSync('.git')) {
            logError('❌ Not a git repository. Run `git init` first.');
            process.exit(1);
        }

        const opts = parseArgs();

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
        if (opts.push)                 pushToRemote(opts, newVersion);

        printSummary(opts, oldVersion, newVersion, branch);

    } catch (error) {
        logError('\n❌ Error: ' + error.message);
        process.exit(1);
    }
}

main();