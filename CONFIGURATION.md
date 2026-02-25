# vnxt Configuration

vnxt can be configured using a `.vnxtrc.json` file in your project root.

## Configuration Options

### `autoChangelog` (boolean)
- **Default:** `true`
- **Description:** Automatically update CHANGELOG.md with each version bump
- **Example:**
  ```json
  "autoChangelog": true
  ```

### `defaultType` (string)
- **Default:** `"patch"`
- **Options:** `"patch"`, `"minor"`, `"major"`
- **Description:** Default version bump type when not auto-detected or specified
- **Example:**
  ```json
  "defaultType": "patch"
  ```

### `requireCleanWorkingDir` (boolean)
- **Default:** `false`
- **Description:** Require a clean git working directory before bumping
- **Note:** Set to `false` to use the `-a` staging feature
- **Example:**
  ```json
  "requireCleanWorkingDir": false
  ```

### `autoPush` (boolean)
- **Default:** `true`
- **Description:** Automatically push to remote after successful version bump
- **Note:** Can be overridden with `--no-push` / `-dnp` flag
- **Example:**
  ```json
  "autoPush": true
  ```

### `defaultStageMode` (string)
- **Default:** `"tracked"`
- **Options:** `"tracked"`, `"all"`, `"interactive"`, `"patch"`
- **Description:** Default staging mode when using `-a` flag without argument
- **Example:**
  ```json
  "defaultStageMode": "tracked"
  ```

### `tagPrefix` (string)
- **Default:** `"v"`
- **Description:** Prefix applied consistently across all git tags, release note filenames, and npm publish tags
- **Affects:**
    - Git version tags (e.g., `v1.2.3`)
    - npm publish trigger tags (e.g., `publish/v1.2.3`)
    - Release note filenames (e.g., `release-notes/v1.2.3.md`)
- **Example:**
  ```json
  "tagPrefix": "v"
  ```

### `colors` (boolean)
- **Default:** `true`
- **Description:** Enable or disable colored terminal output
- **Example:**
  ```json
  "colors": true
  ```
  Note: Disabling colors is useful for:
- Logging systems that don't support ANSI colors
- CI/CD environments with color issues
- Personal preference

## CLI-Only Flags (Not in .vnxtrc.json)

Some flags are not configurable via `.vnxtrc.json` and are always passed on the command line.

### `--publish`
Bumps the version, pushes to remote, and creates a `publish/vX.Y.Z` git tag to trigger an npm publish workflow via GitHub Actions. This flag implies `--push` — you don't need to pass both.

It also automatically generates release notes (stored in `release-notes/`) and prompts you for optional context to include.

```bash
vx -m "feat: new feature" --publish
```

### `-r` / `--release`
Generates a release notes file in `release-notes/` without triggering an npm publish. The filename uses your `tagPrefix` setting (e.g., `release-notes/v1.2.3.md`). You'll be prompted for optional context to include in the notes.

```bash
vx -m "fix: bug" -r
```

### Version Inspection Flags
These flags exit immediately after printing and don't perform any versioning:

- `-vv` / `--vnxt-version` — Show the installed vnxt version
- `-gv` / `--get-version` — Show the current project's name and version
- `-sv` / `--set-version <ver>` — Set a specific version (e.g., `2.0.0-beta.1`)

## Example Configuration Files

### Minimal (Auto-push enabled)
```json
{
  "autoPush": true
}
```

### Conservative (Manual everything)
```json
{
  "autoChangelog": false,
  "autoPush": false,
  "requireCleanWorkingDir": true
}
```

### Recommended (Default)
```json
{
  "autoChangelog": true,
  "defaultType": "patch",
  "requireCleanWorkingDir": false,
  "autoPush": true,
  "defaultStageMode": "tracked",
  "tagPrefix": "v",
  "colors": true
}
```

### Custom Tag Prefix
```json
{
  "tagPrefix": "release-"
}
```
This would create tags like `release-1.2.3` instead of `v1.2.3`

## Flag Overrides

Command-line flags always override configuration:

- `--push` / `-p`: Force push (overrides `autoPush: false`)
- `--no-push` / `-dnp`: Prevent push (overrides `autoPush: true`)
- `--changelog` / `-c`: Force changelog update (overrides `autoChangelog: false`)
- `--type` / `-t`: Override `defaultType`
- `--publish`: Force push + trigger npm publish (implies `--push`)
- `-sv` / `--set-version <ver>`: Set an exact version instead of bumping

## Usage Examples

### With autoPush enabled in config:
```bash
# This will auto-push
vx -m "fix: bug"

# This will NOT push (override)
vx -m "fix: bug" -dnp
```

### With autoPush disabled in config:
```bash
# This will NOT push
vx -m "fix: bug"

# This WILL push (override)
vx -m "fix: bug" -p
```

## Creating Your Configuration

1. Create `.vnxtrc.json` in your project root:
   ```bash
   touch .vnxtrc.json
   ```

2. Add your configuration:
   ```json
   {
     "autoPush": true,
     "autoChangelog": true
   }
   ```

3. Commit the configuration:
   ```bash
   git add .vnxtrc.json
   git commit -m "chore: add vnxt configuration"
   ```

## Best Practices

1. **Commit your `.vnxtrc.json`** - Share configuration with your team
2. **Start with defaults** - Only override what you need
3. **Use `autoPush: true`** - Reduces manual steps in workflow
4. **Keep `requireCleanWorkingDir: false`** - Allows using the `-a` staging feature
5. **Document custom settings** - Add comments in your README if using non-standard config