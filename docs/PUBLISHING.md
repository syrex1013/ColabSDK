# Publishing Guide

This document describes how releases are built, tested, and published to npm for [**@syrex1013/colab-sdk**](https://www.npmjs.com/package/@syrex1013/colab-sdk).

---

## Table of contents

- [Overview](#overview)
- [One-time setup](#one-time-setup)
- [CI workflows](#ci-workflows)
- [Release process](#release-process)
- [Dry-run publishing](#dry-run-publishing)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Documentation map](#documentation-map)

---

## Overview

| Channel | URL |
|---------|-----|
| npm | https://www.npmjs.com/package/@syrex1013/colab-sdk |
| GitHub | https://github.com/syrex1013/ColabSDK |
| Releases | https://github.com/syrex1013/ColabSDK/releases |

Every npm publish is gated by automated checks. Manual publishes are possible but not recommended — prefer the GitHub Release workflow.

---

## One-time setup

### 1. Create an npm access token

1. Sign in at [npmjs.com](https://www.npmjs.com/).
2. Navigate to **Access Tokens** → **Generate New Token**.
3. Select **Granular Access Token** (recommended).
4. Grant **Read and Write** permission for packages under your scope.
5. Copy the token immediately — it will not be shown again.

### 2. Add the token to GitHub Secrets

> **Never commit tokens to the repository.**

1. Open the repository on GitHub.
2. Go to **Settings** → **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. Name: `NPM_TOKEN`
5. Value: paste your npm token.
6. Save.

The publish workflow reads `secrets.NPM_TOKEN` at runtime only.

If a token is ever exposed, **revoke it on npm** and generate a replacement.

### 3. Resolve GitHub Actions billing

Workflows require an active GitHub account. If jobs fail with *"account is locked due to a billing issue"*, resolve it at [GitHub Billing settings](https://github.com/settings/billing).

### 4. Package scope

The published package name is **`@syrex1013/colab-sdk`**, scoped to the npm user that owns the token.

---

## CI workflows

| Workflow | File | Trigger | Actions |
|----------|------|---------|---------|
| **CI** | [ci.yml](../.github/workflows/ci.yml) | Push or PR to `main` | `typecheck` → `test:coverage` → `build` |
| **Publish** | [publish.yml](../.github/workflows/publish.yml) | GitHub Release published | Full test pipeline → `npm publish` |
| **Publish** | [publish.yml](../.github/workflows/publish.yml) | Manual `workflow_dispatch` | Dry-run or real publish |

### Pre-publish checklist (automated)

The following steps run before every npm upload:

1. `bun run typecheck`
2. `bun run test:coverage` — fails if line coverage drops below 90%
3. `bun run build`
4. `npm pack --dry-run` — verify tarball contents
5. `npm publish --access public --provenance`

Additionally, `prepublishOnly` in `package.json` runs build and coverage when `npm publish` executes locally.

---

## Release process

### Step 1 — Update the changelog

Edit [CHANGELOG.md](../CHANGELOG.md):

1. Move entries from `[Unreleased]` into a new version section.
2. Add the release date: `## [x.y.z] - YYYY-MM-DD`.
3. Update comparison links at the bottom of the file.

### Step 2 — Bump the version

```bash
npm version patch   # 0.1.0 → 0.1.1
npm version minor   # 0.1.0 → 0.2.0
npm version major   # 0.1.0 → 1.0.0
```

This updates `package.json` and creates a version commit and git tag.

### Step 3 — Push to GitHub

```bash
git push origin main --follow-tags
```

### Step 4 — Create a GitHub Release

**Option A — GitHub UI**

1. Go to **Releases** → **Draft a new release**.
2. Select the version tag (e.g. `v0.1.1`).
3. Set the title to the version number.
4. Paste the corresponding changelog section as release notes.
5. Click **Publish release**.

**Option B — GitHub CLI**

```bash
gh release create v0.1.1 \
  --title "v0.1.1" \
  --notes-file CHANGELOG.md
```

Publishing the release triggers the **Publish to npm** workflow automatically.

---

## Dry-run publishing

### Local

```bash
bun run build
bun run test:coverage
npm pack --dry-run
npm publish --access public --dry-run
```

### CI (recommended)

1. Go to **Actions** → **Publish to npm**.
2. Click **Run workflow**.
3. Select branch `main`.
4. Set `dry_run` to **true** (default).

This executes the full pipeline and runs `npm publish --dry-run` without uploading.

To publish manually from CI, set `dry_run` to **false**. For normal releases, prefer creating a GitHub Release instead.

---

## Verification

After a successful publish:

```bash
npm view @syrex1013/colab-sdk version
npm view @syrex1013/colab-sdk
```

Install in a clean project:

```bash
mkdir /tmp/colab-test && cd /tmp/colab-test
bun init -y
bun add @syrex1013/colab-sdk
```

> **Note:** New packages may take 5–15 minutes to appear in the npm search index. The tarball is usually available immediately.

---

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| Workflow never starts — billing lock | Fix billing at [github.com/settings/billing](https://github.com/settings/billing) |
| `403 Forbidden` on publish | Token lacks write access or wrong scope |
| `403` version already exists | Bump version with `npm version patch` |
| `404` on `@colab/*` scope | Use `@syrex1013/colab-sdk` or create the `@colab` npm org |
| `402 Payment Required` | Scoped packages require `--access public` (configured in workflow) |
| Coverage gate fails | Run `bun run test:coverage` locally and add tests |
| `NPM_TOKEN` not set | Add the secret under repo Settings → Secrets |
| `npm install` returns 404 shortly after first publish | Wait for registry propagation, or install via tarball URL |

---

## Documentation map

| Audience | Resource |
|----------|----------|
| End users | [README](../README.md) |
| API consumers | [API.md](./API.md) |
| Example scripts | [examples/README.md](../examples/README.md) |
| Changelog | [CHANGELOG.md](../CHANGELOG.md) |
| Maintainers | This document |

---

<p align="center">
  <a href="./README.md">← Documentation index</a> ·
  <a href="../README.md">Project README</a>
</p>
