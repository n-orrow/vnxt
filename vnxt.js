#!/usr/bin/env node

const {execSync} = require('child_process');
const fs = require('fs');
const readline = require('readline');

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
    tagPrefix: 'v'
};

if (fs.existsSync('.vnxtrc.json')) {
    const userConfig = JSON.parse(fs.readFileSync('.vnxtrc.json', 'utf8'));
    config = {...config, ...userConfig};
}

// Parse arguments
let message = getFlag('--message', '-m');
let type = getFlag('--type', '-t') || config.defaultType;
let customVersion = getFlag('--version', '-v');
let dryRun = hasFlag('--dry-run', '-d');
let noPush = hasFlag('--no-push', '-dnp');
let push = noPush ? false : (hasFlag('--push', '-p') || config.autoPush);
let generateChangelog = hasFlag('--changelog', '-c') || config.autoChangelog;
const addAllFlag = getFlag('--all', '-a');
let addMode = null; // Will be set to: 'tracked', 'all', 'interactive', 'patch', or null
let promptForStaging = false; // If true, prompt user for staging mode
if (addAllFlag) {
    // If -a has a value, use it as the mode
    if (typeof addAllFlag === 'string') {
        const mode = addAllFlag.toLowerCase();
        if (['tracked', 'all', 'a', 'interactive', 'i', 'patch', 'p'].includes(mode)) {
            if (mode === 'a') addMode = 'all';
            else if (mode === 'i') addMode = 'interactive';
            else if (mode === 'p') addMode = 'patch';
            else addMode = mode;
        } else {
            console.error(`Error: Invalid add mode '${addAllFlag}'. Use: tracked, all, interactive (i), or patch (p)`);
            process.exit(1);
        }
    } else {
        // If -a has no value, we'll prompt the user later
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
            console.log('🤔 Interactive mode\n');

            message = await prompt('Commit message: ');
            if (!message) {
                console.error('Error: Commit message is required');
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

            console.log(''); // Blank line before proceeding
        }

        // Auto-detect version type from conventional commit format
        if (!customVersion && !getFlag('--type', '-t')) {
            if (message.startsWith('major:') || message.startsWith('MAJOR:')) {
                type = 'major';
                console.log('📝 Auto-detected: major version bump');
            } else if (message.startsWith('minor:') || message.startsWith('MINOR:')) {
                type = 'minor';
                console.log('📝 Auto-detected: minor version bump');
            } else if (message.startsWith('patch:') || message.startsWith('PATCH:')) {
                type = 'patch';
                console.log('📝 Auto-detected: patch version bump');
            } else if (message.startsWith('feat:') || message.startsWith('feature:')) {
                type = 'minor';
                console.log('📝 Auto-detected: minor version bump (feature)');
            } else if (message.startsWith('fix:')) {
                type = 'patch';
                console.log('📝 Auto-detected: patch version bump (fix)');
            } else if (message.includes('BREAKING') || message.startsWith('breaking:')) {
                type = 'major';
                console.log('📝 Auto-detected: major version bump (breaking change)');
            }
        }

        // Validate version type
        if (!customVersion && !['patch', 'minor', 'major'].includes(type)) {
            console.error('Error: Version type must be patch, minor, or major');
            process.exit(1);
        }

        // PRE-FLIGHT CHECKS
        console.log('\n🔍 Running pre-flight checks...\n');

        // Check for uncommitted changes OR if user requested staging prompt
        if ((config.requireCleanWorkingDir && !addMode) || promptForStaging) {
            const status = execSync('git status --porcelain --untracked-files=no').toString().trim();
            if (status || promptForStaging) {
                // No files staged and changes exist - offer interactive selection
                if (status) {
                    console.log('⚠️  You have uncommitted changes.\n');
                }
                console.log('📁 How would you like to stage files?\n');
                console.log('  1. Tracked files only (git add -u)');
                console.log('  2. All changes (git add -A)');
                console.log('  3. Interactive selection (git add -i)');
                console.log('  4. Patch mode (git add -p)');
                console.log('  5. Skip staging (continue without staging)\n');

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
                    console.log('⚠️  Skipping file staging. Ensure files are staged manually.');
                } else {
                    console.error('Invalid choice. Exiting.');
                    process.exit(1);
                }
                console.log('');
            }
        }

        // Check current branch
        const branch = execSync('git branch --show-current').toString().trim();
        if (branch !== 'main' && branch !== 'master') {
            console.log(`⚠️  Warning: You're on branch '${branch}', not main/master`);
        }

        // Check if remote exists
        try {
            execSync('git remote get-url origin', {stdio: 'pipe'});
        } catch {
            if (push) {
                console.error('❌ Error: No remote repository configured, cannot push');
                process.exit(1);
            }
            console.log('⚠️  Warning: No remote repository configured');
        }

        console.log('✅ Pre-flight checks passed\n');

        // DRY RUN MODE
        if (dryRun) {
            console.log('🔬 DRY RUN MODE - No changes will be made\n');
            console.log('Would perform the following actions:');

            if (addMode) {
                const modeDescriptions = {
                    'tracked': 'Stage tracked files only (git add -u)',
                    'all': 'Stage all changes (git add -A)',
                    'interactive': 'Interactive selection (git add -i)',
                    'patch': 'Patch mode (git add -p)'
                };
                console.log(`  1. ${modeDescriptions[addMode]}`);
            }

            if (customVersion) {
                console.log(`  2. Set version to: ${customVersion}`);
            } else {
                console.log(`  2. Bump ${type} version`);
            }

            console.log(`  3. Commit with message: "${message}"`);
            console.log(`  4. Create git tag with annotation`);

            if (generateChangelog) {
                console.log('  5. Update CHANGELOG.md');
            }

            if (generateReleaseNotes) {
                console.log('  6. Generate release notes file');
            }

            if (push) {
                console.log('  7. Push to remote with tags');
            } else {
                console.log('  7. (Skipping push - use --push to enable)');
            }

            console.log('\n✓ Dry run complete. Use without -d to apply changes.');
            process.exit(0);
        }

        // STAGE FILES if requested
        if (addMode) {
            console.log('📦 Staging files...');

            if (addMode === 'tracked') {
                // Only stage tracked files that have been modified/deleted
                execSync('git add -u', {stdio: 'inherit'});
            } else if (addMode === 'all') {
                // Stage all changes (respects .gitignore for new files)
                execSync('git add -A', {stdio: 'inherit'});
            } else if (addMode === 'interactive') {
                // Interactive staging
                execSync('git add -i', {stdio: 'inherit'});
            } else if (addMode === 'patch') {
                // Patch mode staging
                execSync('git add -p', {stdio: 'inherit'});
            }
        }
        // BUMP VERSION
        console.log(`\n🔼 Bumping version...`);

        // Get current version before bump
        const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
        const oldVersion = packageJson.version;

        // Always disable npm's git integration and handle it ourselves
        if (customVersion) {
            execSync(`npm version ${customVersion} --git-tag-version=false`, {stdio: 'inherit'});
        } else {
            execSync(`npm version ${type} --git-tag-version=false`, {stdio: 'inherit'});
        }

        // Get new version
        const newVersion = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;

        // Stage package files
        execSync('git add package.json', {stdio: 'pipe'});
        if (fs.existsSync('package-lock.json')) {
            execSync('git add package-lock.json', {stdio: 'pipe'});
        }

        // Commit with user's message
        execSync(`git commit -m "${message}"`, {stdio: 'inherit'});

        // Create annotated tag
        execSync(`git tag -a v${newVersion} -m "Version ${newVersion}\n\n${message}"`, {stdio: 'pipe'});

        // ADD GIT TAG ANNOTATION (keeping console.log for UX)
        console.log('🏷️  Adding tag annotation...');
        const tagMessage = `Version ${newVersion}\n\n${message}`;
        execSync(`git tag -a v${newVersion} -f -m "${tagMessage}"`, {stdio: 'pipe'});

        // GENERATE CHANGELOG
        if (generateChangelog) {
            console.log('📄 Updating CHANGELOG.md...');
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
            console.log('📋 Generating release notes...');
            const releaseNotes = `# Release v${newVersion}

Released: ${new Date().toISOString().split('T')[0]}

## Changes
${message}

## Installation
\`\`\`bash
npm install ${packageJson.name}@${newVersion}
\`\`\`

## Full Changelog
See [CHANGELOG.md](./CHANGELOG.md) for complete version history.
`;

            const filename = `release-notes-v${newVersion}.md`;
            fs.writeFileSync(filename, releaseNotes);
            console.log(`   Created: ${filename}`);
        }

        // PUSH TO REMOTE
        if (push) {
            console.log('🚀 Pushing to remote...');
            execSync('git push --follow-tags', {stdio: 'inherit'});
        }

        // STATS/SUMMARY
        console.log('\n📊 Summary:');
        console.log('━'.repeat(50));

        console.log(`\n📦 Version: ${oldVersion} → ${newVersion}`);
        console.log(`💬 Message: ${message}`);
        console.log(`🏷️  Tag: v${newVersion}`);
        console.log(`🌿 Branch: ${branch}`);

        if (generateChangelog) {
            console.log(`📄 Changelog: Updated`);
        }

        if (generateReleaseNotes) {
            console.log(`📋 Release notes: Generated`);
        }

        if (push) {
            console.log(`🚀 Remote: Pushed with tags`);
        } else {
            console.log(`📍 Remote: Not pushed (use --push to enable)`);
        }

        // Show files changed
        console.log('\n📝 Files changed:');
        const diff = execSync('git diff HEAD~1 --stat').toString();
        console.log(diff);

        console.log('━'.repeat(50));
        console.log('\n✅ Version bump complete!\n');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
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
  -p, --push               Push to remote with tags
  -dnp, --no-push          Prevent auto-push (overrides config)
  -c, --changelog          Update CHANGELOG.md
  -d, --dry-run            Show what would happen without making changes
  -a, --all [mode]         Stage files before versioning
                           Modes: tracked (default), all, interactive (i), patch (p)
                           If no mode specified, prompts interactively
  -r, --release            Generate release notes file
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
    "tagPrefix": "v"
  }

Examples:
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
  vx                                      # Interactive mode
`);
    process.exit(0);
}

// Run main function
main();
