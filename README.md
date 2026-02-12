# vnxt

A lightweight CLI tool for automated version bumping with changelog generation and git integration.

## Features

- 🚀 Automatic semantic version detection from commit messages
- 📝 Automatic CHANGELOG.md generation
- 🏷️ Git tag annotation
- 🔍 Pre-flight checks for clean working directory
- 🔬 Dry-run mode to preview changes
- 📋 Release notes generation
- ⚙️ Project-level configuration support
- 💬 Interactive mode when no arguments provided

## Installation

### Global Installation

**Bash/PowerShell:**
```bash
npm install -g vnxt
```

After installation, you can use either `vnxt` or the shorter alias `vx`:
```bash
vnxt --help
vx --help  # Same thing, shorter!
```

### Local Installation (from source)

**Bash/macOS/Linux:**
```bash
# Clone the repository
git clone https://github.com/n-orrow/vnxt.git
cd vnxt

# Install globally via npm link
chmod +x vnxt.js
npm link
```

**PowerShell/Windows:**
```powershell
# Clone the repository
git clone https://github.com/n-orrow/vnxt.git
cd vnxt

# Install globally via npm link
npm link
```

## Usage

### Basic Examples

**Bash/PowerShell:**
```bash
# Simple version bump (auto-detects patch from "fix:")
vnxt -m "fix: resolve RFID reader bug"
# or use the shorter alias:
vx -m "fix: resolve RFID reader bug"

# Feature addition (auto-detects minor from "feat:")
vx -m "feat: add heatmap visualization"

# Breaking change (auto-detects major from "BREAKING")
vx -m "BREAKING: redesign API structure"

# With changelog and push to remote
vx -m "feat: add new dashboard" -c -p

# Interactive mode (prompts for input)
vx
```

### Command Line Options

All options work with both `vnxt` and `vx`:

```
-m, --message <msg>      Commit message (required unless using interactive mode)
-t, --type <type>        Version type: patch, minor, major (auto-detected from message)
-v, --version <ver>      Set specific version (e.g., 2.0.0-beta.1)
-p, --push              Push to remote with tags
-c, --changelog         Update CHANGELOG.md
-d, --dry-run           Show what would happen without making changes
-a, --all [mode]        Stage files before versioning (prompts if no mode)
                        Modes: tracked, all, interactive (i), patch (p)
-r, --release           Generate release notes file
-h, --help              Show help message
```

### Automatic Version Detection

vnxt automatically detects the version bump type from your commit message:

- `major:` → **major** version bump
- `minor:` → **minor** version bump
- `patch:` → **patch** version bump
- `feat:` or `feature:` → **minor** version bump
- `fix:` → **patch** version bump
- `BREAKING:` or contains `BREAKING` → **major** version bump

You can override this with the `-t` flag.

### Dry Run

Preview what will happen without making changes:

**Bash/PowerShell:**
```bash
vx -m "feat: new feature" -d
```

Output:
```
🔬 DRY RUN MODE - No changes will be made

Would perform the following actions:
  1. Bump minor version
  2. Commit with message: "feat: new feature"
  3. Create git tag with annotation
  4. (Skipping push - use --push to enable)

✓ Dry run complete. Use without -d to apply changes.
```

### Custom Versions

Set a specific version number (useful for pre-releases):

**Bash/PowerShell:**
```bash
vx -v 2.0.0-beta.1 -m "beta: initial release candidate"
vx -v 1.5.0-rc.2 -m "release candidate 2"
```

### Changelog Generation

Automatically update CHANGELOG.md with version history:

**Bash/PowerShell:**
```bash
vx -m "feat: add user authentication" -c
```

Creates/updates CHANGELOG.md:
```markdown
# Changelog

## [1.2.0] - 2024-02-10
- feat: add user authentication

## [1.1.0] - 2024-02-09
- feat: add dashboard
```

### Release Notes

Generate a formatted release notes file:

**Bash/PowerShell:**
```bash
vx -m "feat: major feature release" -r
```

Creates `release-notes-v1.2.0.md`:
```markdown
# Release v1.2.0

Released: 2024-02-10

## Changes
feat: major feature release

## Installation
npm install your-package@1.2.0
```

### File Staging Options

vnxt offers flexible file staging with the `-a` flag:

**Bash/PowerShell:**
```bash
# Interactive prompt (asks which mode to use)
vx -m "chore: update" -a

# Specific modes
vx -m "fix: bug" -a tracked      # Stage tracked files only (git add -u)
vx -m "feat: new" -a all         # Stage all changes (git add -A)
vx -m "refactor: code" -a i      # Interactive selection (git add -i)
vx -m "fix: typo" -a p           # Patch mode (git add -p)
```

**Staging Modes:**
- `tracked` - Only staged tracked files that have been modified/deleted (default)
- `all` - Stages all changes, respects `.gitignore` for new files
- `interactive` or `i` - Opens git's interactive staging mode
- `patch` or `p` - Opens patch mode for selective staging

**Note:** If you run `vx` without any files staged and without the `-a` flag, vnxt will prompt you interactively to choose a staging mode.

### Complete Workflow Example

**Bash/PowerShell:**
```bash
# Make changes to your code
# ...

# Dry run to preview
vx -m "feat: add new API endpoint" -d

# Execute with changelog, release notes, and push
vx -m "feat: add new API endpoint" -c -r -p
```

## Configuration

Create a `.vnxtrc.json` file in your project root to set defaults:
```json
{
  "autoChangelog": true,
  "defaultType": "patch",
  "requireCleanWorkingDir": true,
  "autoPush": false
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoChangelog` | boolean | `false` | Automatically update CHANGELOG.md on every bump |
| `defaultType` | string | `"patch"` | Default version bump type if not auto-detected |
| `requireCleanWorkingDir` | boolean | `true` | Require clean git working directory before bumping |
| `autoPush` | boolean | `false` | Automatically push to remote after bumping |

## Pre-flight Checks

vnxt performs several checks before making changes:

- ✅ Verifies no uncommitted changes (unless using `-a`)
- ✅ Warns if not on main/master branch
- ✅ Checks for remote repository (if pushing)

Example output:
```
🔍 Running pre-flight checks...

⚠️  Warning: You're on branch 'feature/new-dashboard', not main/master
✅ Pre-flight checks passed
```

## Interactive Mode

Run `vnxt` (or `vx`) without arguments for guided prompts:

**Bash/PowerShell:**
```bash
vx
```

Output:
```
🤔 Interactive mode

Commit message: feat: add new feature
Version type (patch/minor/major) [patch]: minor

📝 Auto-detected: minor version bump (feature)

🔍 Running pre-flight checks...
...
```

## Workflow Examples

### Quick Fix

**Bash/PowerShell:**
```bash
vx -m "fix: resolve login bug"
```

### Feature Release

**Bash/PowerShell:**
```bash
vx -m "feat: add dashboard analytics" -c -p
```

### Major Release with Full Documentation

**Bash/PowerShell:**
```bash
vx -m "BREAKING: new API structure" -c -r -p
```

### Local Development (No Push)

**Bash/PowerShell:**
```bash
vx -m "chore: refactor code" -a
```

## Troubleshooting

### Permission Denied (Windows PowerShell)

If you get execution policy errors:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Uncommitted Changes Error

Either commit your changes first, or use the `-a` flag to stage all changes:

**Bash/PowerShell:**
```bash
vx -m "your message" -a
```

### Command Not Found After Installation

Make sure npm's global bin directory is in your PATH:

**Bash:**
```bash
npm config get prefix
# Add the bin subdirectory to your PATH
```

**PowerShell:**
```powershell
npm config get prefix
# Add the bin subdirectory to your PATH in System Environment Variables
```

## Requirements

- Node.js 12.x or higher
- npm 6.x or higher
- Git installed and configured

## Version Management

This project uses [vnxt](https://vnxt.dev) for version bumping with the following configuration:

- Auto-push enabled (`autoPush: true`)
- Clean working directory not required (`requireCleanWorkingDir: false`)

See `.vnxtrc.json` for full configuration.

## Author

Nate Orrow - Software Developer

## License

MIT License - see [LICENSE](LICENSE) file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request