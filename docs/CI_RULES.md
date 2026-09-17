# CI Enforcement and Branch Protection Configuration

This document specifies the exact GitHub ruleset / branch-protection configuration required to protect `main` and ensure that all PR validation must pass before code can be merged into `main`.

---

## 1. Branch Ruleset Specification (Recommended)

GitHub Rulesets provide modern, tamper-resistant enforcement for branches.

### Target Ruleset
- **Ruleset Name**: `Protect main branch`
- **Enforcement Status**: `Active`
- **Target Branches**:
  - Target: `Include default branch` (or include pattern `refs/heads/main`)

### Rules
1. **Restrict deletions**: Enabled (prevents deleting `main`).
2. **Block force pushes**: Enabled (prevents rewriting history on `main`).
3. **Require a pull request before merging**:
   - Required approvals: `1`
   - Dismiss stale pull request approvals when new commits are pushed: `Enabled`
   - Require review from Code Owners: Optional / as team requires
   - Require conversation resolution before merging: `Enabled`
4. **Require status checks to pass before merging**:
   - **Require branches to be up to date before merging**: `Enabled` (prevents merging against stale base)
   - **Required Status Checks**:
     - `Plan (changed files, Node versions)`
     - `Typecheck, lint and test (Node 22)`
     - `Postgres (hosted multi-user mode)`
     - `Unit tests (Windows)`

> [!NOTE]
> For paths that don't touch code (e.g. docs-only PRs), the `plan` job sets `code=false`, which marks the dependent jobs (`Typecheck...`, `Postgres...`, `Unit tests...`) as skipped. GitHub treats skipped jobs as passing when evaluated as required status checks, maintaining cost efficiency while preventing bypasses.

---

## 2. Classic Branch Protection Configuration (Alternative)

If using Classic Branch Protection rules:
- **Branch name pattern**: `main`
- [x] **Require a pull request before merging**
  - [x] Require approvals: `1`
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [x] Require conversation resolution before merging
- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - Required checks to select:
    - `Plan (changed files, Node versions)`
    - `Typecheck, lint and test (Node 22)`
    - `Postgres (hosted multi-user mode)`
    - `Unit tests (Windows)`
- [x] **Do not allow bypassing the above settings** (Enforce for administrators)
- [x] **Block force pushes**
- [x] **Do not allow deletions**

---

## 3. Step-by-Step GitHub Web UI Setup

1. Open the repository on GitHub: `https://github.com/rickydeleon49-ui/Ai-Dashboard`.
2. Navigate to **Settings** > **Rules** > **Rulesets** (or **Settings** > **Branches**).
3. Click **New ruleset** > **New branch ruleset**.
4. Set **Ruleset Name** to `Protect main branch` and **Enforcement status** to `Active`.
5. Under **Target branches**, click **Add target** > **Include default branch**.
6. Under **Branch rules**:
   - Check **Restrict deletions**.
   - Check **Block force pushes**.
   - Check **Require a pull request before merging**, set **Required approvals** to `1`, check **Dismiss stale approvals when new commits are pushed**, and check **Require conversation resolution before merging**.
   - Check **Require status checks to pass**:
     - Check **Require branches to be up to date before merging**.
     - In the search bar under "Status checks that are required", search and add:
       1. `Plan (changed files, Node versions)`
       2. `Typecheck, lint and test (Node 22)`
       3. `Postgres (hosted multi-user mode)`
       4. `Unit tests (Windows)`
7. Click **Create** (or **Save changes**).
