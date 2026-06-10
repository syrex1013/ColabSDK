# Publishing & auto-release

This project uses GitHub Actions to run tests before every publish to npm.

## One-time setup

### 1. Create an npm access token

1. Log in at [npmjs.com](https://www.npmjs.com/)
2. Go to **Access Tokens** → **Generate New Token**
3. Choose **Granular Access Token** (recommended) or **Classic**
4. Permissions: **Read and Write** for packages (limit to `@colab` scope if possible)
5. Copy the token — you will not see it again

### 2. Add the token to GitHub Secrets

**Never commit tokens to the repository.**

1. Open your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `NPM_TOKEN`
4. Value: paste your npm token
5. Save

The publish workflow reads `secrets.NPM_TOKEN` only at runtime in GitHub Actions.

> If a token was ever shared in chat, email, or committed by mistake, **revoke it on npm** and create a new one.

### 3. npm organization (scoped package)

Package name is `@syrex1013/colab-sdk` (scoped to the npm user/org that owns the token).

## Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| [CI](../.github/workflows/ci.yml) | Push / PR to `main` | `typecheck` → `test:coverage` → `build` |
| [Publish](../.github/workflows/publish.yml) | GitHub **Release published** | Same checks, then `npm publish` |
| [Publish](../.github/workflows/publish.yml) | Manual **workflow_dispatch** | Dry-run or real publish |

### What runs before npm publish

1. `bun run typecheck`
2. `bun run test:coverage` (fails if line coverage &lt; 90%)
3. `bun run build`
4. `npm pack --dry-run` (verify tarball contents)
5. `npm publish --access public --provenance`

`prepublishOnly` in `package.json` also runs build + coverage when `npm publish` executes.

## Release a new version

### 1. Update the changelog

Edit [CHANGELOG.md](../CHANGELOG.md):

- Move items from `[Unreleased]` into a new `## [x.y.z] - YYYY-MM-DD` section
- Update comparison links at the bottom

### 2. Bump version and tag

```bash
# patch: 0.1.0 → 0.1.1
npm version patch

# minor: 0.1.0 → 0.2.0
npm version minor

# major: 0.1.0 → 1.0.0
npm version major
```

This updates `package.json` and creates a git commit + tag `v*`.

### 3. Push to GitHub

```bash
git push origin main --follow-tags
```

### 4. Create a GitHub Release

**Option A — GitHub UI**

1. Repo → **Releases** → **Draft a new release**
2. Choose the tag (e.g. `v0.1.1`)
3. Title: `v0.1.1`
4. Paste the changelog section for that version
5. Click **Publish release**

Publishing the release triggers **Publish to npm** automatically.

**Option B — GitHub CLI**

```bash
gh release create v0.1.1 --title "v0.1.1" --notes-file RELEASE_NOTES.md
```

## Test publish without uploading

### Local dry run

```bash
bun run build
bun run test:coverage
npm pack --dry-run
npm publish --access public --dry-run
```

### CI dry run

1. GitHub → **Actions** → **Publish to npm**
2. **Run workflow** → branch `main`
3. `dry_run`: **true** (default)

This runs the full test pipeline and `npm publish --dry-run` using `NPM_TOKEN`.

### CI real publish (manual)

Same as above but set `dry_run` to **false**. Prefer using **GitHub Releases** for normal releases.

## Verify after publish

```bash
npm view @syrex1013/colab-sdk version
npm view @syrex1013/colab-sdk
```

Install in a clean project:

```bash
bun init -y
bun add @syrex1013/colab-sdk
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Actions job never starts — *billing issue* | [GitHub Billing settings](https://github.com/settings/billing) → resolve payment/budget. Public repos normally get free minutes; account lock blocks all workflows. |
| `403 Forbidden` on publish | Token lacks write access or wrong npm scope |
| `404` on `@colab/*` scope | Use `@syrex1013/colab-sdk` or create the `@colab` npm organization |
| `402 Payment Required` | Scoped package needs `--access public` (already in workflow) |
| Coverage gate fails | Run `bun run test:coverage` locally and add tests |
| Version already exists | Bump version with `npm version patch` |
| `NPM_TOKEN` not set | Add secret under repo Settings → Secrets |
| `npm install` 404 right after first publish | Wait 5–15 minutes for registry index propagation, or install tarball URL from `npm view @syrex1013/colab-sdk@0.1.0 dist.tarball` |

## Where docs live after release

| Location | URL |
|----------|-----|
| npm package | `https://www.npmjs.com/package/@syrex1013/colab-sdk` |
| README (install + quick start) | GitHub repo homepage |
| API reference | [docs/API.md](./API.md) (in repo + npm tarball) |
| Examples | [examples/README.md](../examples/README.md) (repo only) |
| Changelog | [CHANGELOG.md](../CHANGELOG.md) |
| Releases | `https://github.com/syrex1013/ColabSDK/releases` |
