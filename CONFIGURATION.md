<!-- CONFIGURATION.md -->
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
- **Note:** Ignored in workspace mode (npm workspaces). Use `workspaceAutoPush` there.
- **Example:**
  ```json
  "autoPush": true
  ```

### `workspaceAutoPush` (boolean)
- **Default:** `false`
- **Description:** Automatically push after a release in workspace mode (a repo whose root `package.json` declares `workspaces`). Without it, workspace mode pushes only when you pass `-p`.
- **Note:** Only a literal `true` turns it on. The string `"true"`, `1` and `null` do not.
- **Note:** `-dnp` always overrides it.
- **Note:** Has no effect in a single-package repo, which follows `autoPush`.
- **Warning:** With several workspaces in one run, this pushes every commit and every new tag in one go, and `--follow-tags` also sends any annotated tags you made earlier and never pushed. Tags on a shared remote are awkward to remove, so check with `-d` first if you are unsure.
- **Example:**
  ```json
  "workspaceAutoPush": true
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
- **Note:** Not used in workspace mode. Workspace tags are always `<name>@<version>` (for example `app-one@1.2.3`, or `acme/ui@1.2.3` for `@acme/ui`).
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

Not available in workspace mode. vnxt refuses it there, because apps are deployed as builds and shared packages are used through the workspace links.

### `-r` / `--release`
Generates a release notes file in `release-notes/` without triggering an npm publish. The filename uses your `tagPrefix` setting (e.g., `release-notes/v1.2.3.md`). You'll be prompted for optional context to include in the notes.

```bash
vx -m "fix: bug" -r
```

In workspace mode the file is written inside the workspace, as `<workspace>/release-notes/<name>@<version>.md`, and there is no context prompt.

### `-w` / `--workspace <name or folder>`
Chooses which npm workspace to release. Repeat it, or separate names with commas, to release several in one run. Each gets its own commit and tag, followed by one push at the end if you are pushing. From inside a workspace folder, that workspace is used without `-w`.

```bash
vx -w app-one -m "fix: bug"
vx -w app-one -w app-two -m "chore: bump deps"
```

`-sv`, `-a patch` and `-a interactive` need exactly one workspace.

### `-lw` / `--list-workspaces`
Lists the workspaces in the repo with their version, folder, whether they are private, the latest tag and what has changed since it. Exits without changing anything.

```bash
vx -lw
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

### Monorepo (npm workspaces)
```json
{
  "autoChangelog": true,
  "autoPush": false,
  "workspaceAutoPush": false
}
```
Workspace mode ignores `autoPush` and `tagPrefix`, so the settings that matter there are `autoChangelog` and `workspaceAutoPush`. Leave `workspaceAutoPush` off and push with `-p` when you have checked what is about to go.

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
- `--no-push` / `-dnp`: Prevent push (overrides `autoPush: true` and `workspaceAutoPush: true`)
- `--changelog` / `-c`: Force changelog update (overrides `autoChangelog: false`)
- `--type` / `-t`: Override `defaultType`
- `--publish`: Force push + trigger npm publish (implies `--push`)
- `-sv` / `--set-version <ver>`: Set an exact version instead of bumping (one workspace at a time in workspace mode)

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

### In workspace mode:
```bash
# Pushes only with -p, whatever autoPush says
vx -w app-one -m "fix: bug"        # commit and tag, no push
vx -w app-one -m "fix: bug" -p     # commit, tag and push

# With "workspaceAutoPush": true
vx -w app-one -m "fix: bug"        # pushes
vx -w app-one -m "fix: bug" -dnp   # does not push
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
3. **Use `autoPush: true`** - Reduces manual steps in workflow (single-package repos; in a monorepo, prefer pushing with `-p`)
4. **Keep `requireCleanWorkingDir: false`** - Allows using the `-a` staging feature
5. **Document custom settings** - Add comments in your README if using non-standard config