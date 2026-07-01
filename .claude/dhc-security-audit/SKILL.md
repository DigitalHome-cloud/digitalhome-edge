---
name: dhc-security-audit
description: Use when the user asks for a security or quality audit of the DigitalHome.Cloud platform — phrases like "audit", "security review", "check our security", "vulnerability scan", "regular health check", "security by design check", "quality check across the apps", "/audit". Runs a structured pass over all three Gatsby apps (Portal, Designer, Modeler), the umbrella, the shared Amplify Gen1 backend, and the GitHub posture, producing a timestamped report at `docs/audits/YYYY-MM-DD-audit.md` with findings ranked by severity (Critical / High / Medium / Low / Info) plus concrete remediation steps. Also use during planning to pressure-test a design's security implications before it ships ("security by design").
---

# DHC platform — security and quality audit

## Why this exists

DigitalHome.Cloud spans three frontend apps + a shared Amplify backend + GitHub repos. The platform handles tenant data (SmartHome IDs are the partition key), authentication via a single Cognito User Pool, and ontology/instance files in S3. Without a recurring audit, drift accumulates: dependency CVEs pile up, IAM/S3 permissions broaden, secrets leak into commits, GraphQL `@auth` rules become inconsistent.

Run this skill quarterly at minimum, and ad-hoc whenever:
- A new dependency is added that touches auth, network, or storage
- Cognito groups, IAM roles, or AppSync schema change
- Before pushing major releases to `main` (production)
- After a security advisory lands on a known dependency

You can also invoke this skill mid-design ("would this introduce …?") to pressure-test a planned change before code is written.

## How to run

1. **Confirm scope with the user.** Ask whether they want a full audit (all eight domains below) or a targeted one ("just dependencies", "just GraphQL `@auth`"). Default to full unless they say otherwise.
2. **Snapshot the working tree.** Run `git status` and `git log --oneline -5` in the umbrella + each submodule so the report can pin exactly which commit was audited.
3. **Walk the eight domains** in order, executing the checks listed under each. Record findings as you go — don't try to remember at the end.
4. **Rank each finding** using the severity rubric below.
5. **Write the report** to `docs/audits/YYYY-MM-DD-audit.md`. Use the template at the bottom of this file. Include findings, evidence (file paths + line numbers, command output snippets), severity, and concrete remediation.
6. **Summarize the top items** to the user in chat — don't repeat the whole report; surface the Critical/High findings and the count at each severity level.
7. **Don't fix things during the audit.** Audit and report only. Remediation is a separate task the user authorizes per finding.

## Severity rubric

| Severity | Meaning | Examples |
|----------|---------|----------|
| **Critical** | Active exposure or imminent compromise. Action within 24h. | Hardcoded AWS key in committed code; public S3 bucket holding tenant data; unauthenticated GraphQL mutation; cleartext password in logs. |
| **High** | Real risk that hasn't been exploited. Action within ~1 week. | Cognito User Pool with no MFA, `@auth { allow: public }` on a tenant-scoped type, npm CVE rated 9+, missing CSP, broad IAM `*` resource. |
| **Medium** | Defensible but worth fixing in the next planning cycle. | Older dependency with known low-severity CVE, missing security headers, weak password policy minimum, no rate limit on a Lambda. |
| **Low** | Hygiene / defense-in-depth. | Unused IAM permissions, outdated docs, missing CONTRIBUTING.md, commit messages inconsistent. |
| **Info** | Observation, not a defect. | Build size growth, dependency count, lint warnings. |

When in doubt, pick the higher severity and let the user de-rank during review.

## The eight domains

### 1. Secrets and credentials

**What you're looking for**: any secret, key, or credential that ended up where it shouldn't be.

```bash
# Files that must never be tracked — confirm they aren't
git -C . ls-files | grep -E "(aws-exports\.js$|\.env\.development$|\.graphqlconfig\.yml$)"
for app in portal designer modeler; do
  git -C "repos/$app" ls-files | grep -E "(aws-exports\.js$|\.env\.development$|\.graphqlconfig\.yml$)"
done
# (any output here = critical — those files must be in .gitignore and never committed)

# Scan history for leaked AWS keys
git -C . log --all -p | grep -E "AKIA[0-9A-Z]{16}|aws_secret_access_key" | head
for app in portal designer modeler; do
  git -C "repos/$app" log --all -p | grep -E "AKIA[0-9A-Z]{16}|aws_secret_access_key" | head
done

# Scan history for committed passwords / tokens / private keys
git -C . log --all -p -S "BEGIN PRIVATE KEY" --pickaxe-regex | head
git -C . log --all -p -G "(password|secret|token|api[_-]key)\\s*[:=]\\s*['\"]" --pickaxe-regex | head -50

# Inspect what GATSBY_* env vars are baked into the bundle (these are PUBLIC)
for app in portal designer modeler; do
  echo "[$app]"
  grep -hoE "GATSBY_[A-Z_]+" "repos/$app/src/aws-exports.deployment.js" 2>/dev/null | sort -u
done
```

Cross-check `.gitignore` in each repo covers: `aws-exports.js`, `.env*`, `.graphqlconfig.yml`, `amplify` (modeler/designer/portal). Cross-check umbrella `.gitignore` covers `todo/`, `.graphqlconfig.yml`, `src/aws-exports.js`.

A `GATSBY_*` env var is **shipped to the browser** in the JS bundle. Anything secret (private API keys, server-side credentials) must not start with `GATSBY_`. Cognito Pool IDs and Identity Pool IDs are public-by-design and OK to ship.

### 2. Authentication and authorization (Cognito + AppSync)

**What you're looking for**: weak auth posture, missing MFA, over-broad permissions, missing `@auth` on tenant data.

```bash
# AppSync schema authz check — every type that holds tenant data must have @auth
grep -E "type\s+\w+\s*@(model|auth)" repos/portal/amplify/backend/api/*/schema.graphql 2>/dev/null
# Look for @auth { allow: public } on tenant-scoped types — that's a bug
grep -B 2 -A 4 "allow: public" repos/portal/amplify/backend/api/*/schema.graphql 2>/dev/null

# Cognito group references — confirm the apps gate on the right groups
for app in portal designer modeler; do
  echo "=== $app: hasGroup() and dhc-* group references ==="
  grep -rn 'hasGroup\|"dhc-users"\|"dhc-operators"\|"dhc-admins"\|"dhc-modelers"' "repos/$app/src/" 2>/dev/null | head -20
done

# Authenticator / signIn flows — make sure every entry calls reloadSession()
grep -rn "signIn\|confirmSignIn\|Authenticator" repos/*/src/pages/signin.js 2>/dev/null
```

Manual checks (browser / AWS console — ask the user to verify if you can't):
- **Cognito User Pool**: MFA optional or required? Password policy ≥ 12 chars + complexity? Account recovery method? Token expiry (access ≤ 1h, refresh ≤ 30d)?
- **Identity Pool**: authenticated role scope, unauthenticated role disabled if not used.
- **AppSync**: default authentication mode is `AMAZON_COGNITO_USER_POOLS`. API key fallback should be disabled or scoped to a specific operation.
- **Federation / Hosted UI**: not configured today (per `dhc-design-implement` skill notes). If enabled, audit OIDC client secrets and redirect URIs.

Also check that the Modeler's custom signin (replaced the Authenticator) handles all `nextStep.signInStep` cases — `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`, MFA TOTP/SMS, `CONFIRM_SIGN_UP`, `RESET_PASSWORD`. Missing branches mean some users (admins with temporary passwords, MFA users) can't sign in.

### 3. Data layer (DynamoDB + S3)

**What you're looking for**: cross-tenant leakage, public buckets, missing encryption.

```bash
# Schema review — every tenant-scoped @model should partition on smartHomeId
grep -E "@key|@auth|smartHome" repos/portal/amplify/backend/api/*/schema.graphql 2>/dev/null | head -30

# S3 access patterns from the frontend — look for unsigned reads / writes
grep -rn "uploadData\|downloadData\|getProperties\|list\b" repos/*/src/utils/s3.js 2>/dev/null | head
```

Manual checks (AWS console / `amplify status`):
- **DynamoDB**: server-side encryption enabled? Point-in-time recovery? `@auth { allow: owner }` translates to `owner` field == `cognito:username`?
- **S3**: public access **blocked** at account + bucket level? Bucket policy denies `s3:PutObject` from non-Amplify principals? Signed URL TTL ≤ 1h?
- **Bucket structure** per ADR-0010: confirm tenant-scoped paths (`public/smarthomes/{smartHomeId}/...`) actually enforce per-tenant Cognito identity claims, not just key naming.

### 4. Frontend security (Gatsby apps)

```bash
# Insecure DOM operations
grep -rn "dangerouslySetInnerHTML\|innerHTML\s*=\|eval(\|new Function(" repos/*/src/ 2>/dev/null | head

# Unrestricted target=_blank without rel="noopener noreferrer".
# Grep is line-based but JSX often spans `target` and `rel` across lines, so
# look at a 2-line window after each match and exclude any window that has
# `rel=...noreferrer` or `rel=...noopener`.
grep -rn -A 1 'target="_blank"' repos/*/src/ 2>/dev/null | \
  grep --no-group-separator -B 1 -E 'rel=' | \
  grep -v 'rel=' | grep 'target="_blank"' | \
  awk -F: '{print $1":"$2}' | sort -u || echo "  (no naked target=_blank — clean)"

# document.write, window.open patterns
grep -rn "document.write\|window.open(" repos/*/src/ 2>/dev/null | head

# Hardcoded URLs that should use getAppUrl
grep -rn "https://portal\.digitalhome\.cloud\|https://designer\.digitalhome\.cloud\|https://modeler\.digitalhome\.cloud" repos/*/src/ 2>/dev/null | grep -v "getAppUrl\|aws-exports.deployment.js\|tagline\|comment" | head

# CSP / security headers — Amplify Hosting doesn't add these by default
for app in portal designer modeler; do
  echo "[$app]"
  cat "repos/$app/customHttp.yml" 2>/dev/null || echo "(no customHttp.yml — no custom security headers)"
done
```

If `customHttp.yml` is missing, recommend adding one with `Strict-Transport-Security`, `Content-Security-Policy` (start with `default-src 'self'` + the Cognito + AppSync + S3 origins), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.

Confirm cross-app navigation only uses `getAppUrl(appName)` (env-aware). Hardcoded `https://*.digitalhome.cloud` URLs break stage/dev environments and may bypass intended routing.

### 5. Dependency hygiene

```bash
# Vulnerability counts per app
for app in portal designer modeler; do
  echo "=== $app ==="
  (cd "repos/$app" && yarn audit --level=high --json 2>/dev/null | tail -1)
  # OR: npm audit --json | jq '.metadata.vulnerabilities'
done

# Lockfile drift
for app in portal designer modeler; do
  test -f "repos/$app/yarn.lock" && echo "[$app] uses yarn.lock"
  test -f "repos/$app/package-lock.json" && echo "[$app] uses package-lock.json"
  test -f "repos/$app/yarn.lock" && test -f "repos/$app/package-lock.json" && echo "[$app] WARNING: both lockfiles present"
done

# Outdated packages
for app in portal designer modeler; do
  echo "=== $app ==="
  (cd "repos/$app" && yarn outdated 2>&1 | head -30 || true)
done

# License audit — confirm no GPL/AGPL/LGPL surprises
for app in portal designer modeler; do
  echo "=== $app ==="
  (cd "repos/$app" && npx --yes license-checker --summary 2>/dev/null | head -20 || echo "(license-checker not available — skip or install)")
done
```

Severity guide: 1 critical CVE = High in audit. 5+ high CVEs = High overall. Patch-version updates with no breaking changes = Low (worth doing, low risk). Major bumps that touch React, Gatsby, Amplify = Medium (needs testing).

The 75–78 vulnerabilities seen in recent Amplify deploy logs are likely transitive and many are in dev-only packages — focus on `--production` paths if possible.

### 6. Build, deploy, CI/CD

```bash
# Confirm each app builds clean from a fresh state
for app in portal designer modeler; do
  echo "=== $app build ==="
  (cd "repos/$app" && yarn clean && yarn build 2>&1 | tail -5)
done

# Confirm GATSBY_* env vars in Amplify console match aws-exports.deployment.js
for app in portal designer modeler; do
  echo "[$app] expected GATSBY_* vars:"
  grep -hoE "GATSBY_[A-Z_]+" "repos/$app/src/aws-exports.deployment.js" 2>/dev/null | sort -u
done
# Then ask the user to compare against the Amplify Hosting console for each app.

# amplify.yml present and sane (no rm -rf, no curl | bash)
for app in portal designer modeler; do
  echo "[$app] amplify.yml:"
  cat "repos/$app/amplify.yml" 2>&1 | head -30
done

# Branch protection — manual check on GitHub:
# - main: require PR review, status checks (build), no force-push
# - stage: same as main but optionally allow lighter review
gh api "repos/DigitalHome-cloud/digitalhome-cloud-portal/branches/main/protection" 2>/dev/null | jq '{required_status_checks, required_pull_request_reviews, allow_force_pushes}'
gh api "repos/DigitalHome-cloud/digitalhome-cloud-designer/branches/main/protection" 2>/dev/null | jq '{required_status_checks, required_pull_request_reviews, allow_force_pushes}'
gh api "repos/DigitalHome-cloud/digitalhome-cloud-modeler/branches/main/protection" 2>/dev/null | jq '{required_status_checks, required_pull_request_reviews, allow_force_pushes}'

# Dependabot status
for repo in digitalhome-cloud-portal digitalhome-cloud-designer digitalhome-cloud-modeler digitalhome-cloud-darkfactory; do
  echo "[$repo] dependabot alerts (need admin):"
  gh api "repos/DigitalHome-cloud/$repo/dependabot/alerts?state=open" 2>/dev/null | jq 'length' || echo "(no access)"
done

# Secret scanning enabled?
for repo in digitalhome-cloud-portal digitalhome-cloud-designer digitalhome-cloud-modeler digitalhome-cloud-darkfactory; do
  echo "[$repo] secret scanning:"
  gh api "repos/DigitalHome-cloud/$repo" 2>/dev/null | jq '.security_and_analysis'
done
```

Manual checks:
- **Amplify Hosting**: each app's branch (`main` → prod, `stage` → staging) has a separate environment with separate env vars. Confirm prod doesn't accidentally get dev/stage backend IDs.
- **IAM build role**: scoped to the minimum (S3 publish, CloudFront invalidate). Not a wildcard `*`.
- **Build caching**: Amplify caches `node_modules`. Confirm cache invalidates on `package.json`/`yarn.lock` change (it does by default; flag if disabled).

### 7. Code quality

```bash
# Lint + format runs clean
for app in portal designer modeler; do
  echo "=== $app format ==="
  (cd "repos/$app" && yarn format --check 2>&1 | tail -10 || true)
done

# i18n key parity — every key in en/common.json should also be in de/ and fr/
for app in portal designer modeler; do
  echo "=== $app i18n parity ==="
  if [ -f "repos/$app/src/locales/en/common.json" ]; then
    en=$(node -e "console.log(Object.keys(require('./repos/$app/src/locales/en/common.json')).length)")
    de=$(node -e "console.log(Object.keys(require('./repos/$app/src/locales/de/common.json')).length)" 2>/dev/null || echo "missing")
    fr=$(node -e "console.log(Object.keys(require('./repos/$app/src/locales/fr/common.json')).length)" 2>/dev/null || echo "missing")
    echo "  en: $en keys, de: $de keys, fr: $fr keys"
  fi
done

# Test coverage — none of the apps have tests today (per CLAUDE.md). Flag that.
for app in portal designer modeler; do
  test -d "repos/$app/__tests__" || test -d "repos/$app/src/__tests__" || \
    grep -q '"test"' "repos/$app/package.json" 2>/dev/null && echo "[$app] has tests" || echo "[$app] no tests"
done

# Submodule SHAs match each app's HEAD on stage
git -C . status --short | grep "^M\|^m " | head
```

Note any test coverage gaps as **High** if they cover auth/authorization paths, **Medium** otherwise. The platform's "no test suite is configured yet" status (per each CLAUDE.md) is itself a Medium finding worth tracking.

### 8. Documentation and ADR posture

```bash
# CLAUDE.md files exist and aren't stale
for f in CLAUDE.md repos/portal/CLAUDE.md repos/designer/CLAUDE.md repos/modeler/CLAUDE.md; do
  if [ -f "$f" ]; then
    echo "[$f] last modified:"
    git log -1 --format="%cs %s" -- "$f"
  fi
done

# ADRs cover the major architectural decisions
ls docs/adr/ 2>/dev/null | head

# Specs index
ls docs/specs/ 2>/dev/null | head
```

Look for:
- CLAUDE.md last modified > 6 months ago = Low.
- A new dependency or pattern shipped with no ADR = Low/Medium.
- A spec that's empty (e.g. `DH-SPEC-202-Modeller.md` was 0 bytes at last audit) = Low.

## Output: the audit report

Write to `docs/audits/YYYY-MM-DD-audit.md`. If a folder doesn't exist, create it.

Use this template (lift verbatim, fill in):

```markdown
# DHC Security & Quality Audit — YYYY-MM-DD

**Auditor**: Claude Code (claude-opus-4-7) via the `dhc-security-audit` skill
**Branch audited**: <umbrella-branch>
**Commits audited**:
- umbrella: `<sha>` (<one-line subject>)
- portal:   `<sha>`
- designer: `<sha>`
- modeler:  `<sha>`
**Scope**: Full / Targeted (<list domains>)

## Summary

| Severity | Count |
|----------|-------|
| Critical |   N   |
| High     |   N   |
| Medium   |   N   |
| Low      |   N   |
| Info     |   N   |

**Top items requiring attention this cycle**:
1. <one-line of the most pressing finding>
2. ...

## Findings

### CRITICAL

#### C-1. <Title>
**Domain**: <Secrets / Auth / Data / Frontend / Deps / CI / Quality / Docs>
**Evidence**: `<file:line>` or command output
```
<snippet>
```
**Impact**: <one paragraph>
**Remediation**: <concrete steps>

### HIGH
...

### MEDIUM
...

### LOW
...

### INFO
...

## What was checked but found clean

A short bulleted list, so future audits can see what's been validated:
- [x] No AWS keys in git history (umbrella + 3 submodules)
- [x] AppSync schema has `@auth` on every `@model`
- [x] Cognito User Pool has MFA enabled
- ...

## Carry-overs from previous audits

| Item | First flagged | Status |
|------|---------------|--------|
| ...  | YYYY-MM-DD    | open / fixed / accepted |

## Recommended next audit

YYYY-MM-DD (quarterly cadence, or sooner if any High items open).
```

## Recommended cadence

- **Quarterly**: full audit (all eight domains).
- **Per-release**: targeted audit on whichever domains the release touches (e.g. dependency bumps trigger Domain 5; backend schema change triggers Domains 2 and 3).
- **Ad-hoc**: when a security advisory lands on React, Gatsby, Amplify, AWS SDK, or any direct dependency.
- **Pre-commit advisory mode**: if invoked during planning ("would this design …?"), run only the relevant checklist items and respond inline rather than writing a full report file.

## Boundaries

- **Don't auto-fix findings**, even small ones. The audit is read-only by design — remediation is a separate task with its own approval.
- **Don't bypass `.gitignore` rules** to inspect secret files. If `.env.development` would be useful evidence, ask the user to summarize what's in it; don't read it.
- **Don't run `amplify push` / `amplify update` / any backend mutation** during the audit.
- **Don't make AWS API calls that mutate state.** Read-only IAM ops only (`describe`, `list`, `get`).
- **If the user is on `main`** (production), be extra cautious — flag findings for review, don't even propose changes against `main` directly. Stage them on a dedicated `audit/YYYY-MM-DD` branch.

## Prior audits

- 2026-05-08 — **0 critical** / 6 high / 7 medium / 2 low / 6 info — [docs/audits/2026-05-08-audit.md](../../../docs/audits/2026-05-08-audit.md). First audit on the Gen 2 backend. **All 5 prior-audit Criticals (C-1 to C-5) confirmed closed in Gen 2.** Remaining work is carry-over Highs (H-1 customHttp.yml, H-3 blog HTML XSS, H-4 SVG XSS, H-5 npm CVEs, H-6 Portal i18n, H-7 .graphqlconfig.yml) and 2 new Mediums (M-6 DDB PITR not enabled, M-7 stale Gen 1 refs in CLAUDE.md files).
- 2026-05-07 — 5 critical / 8 high / 9 medium / 4 low / 5 info — [docs/audits/2026-05-07-audit.md](../../../docs/audits/2026-05-07-audit.md). Top items: SmartHomeDesign / SmartHome cross-tenant exposure (C-1), tenant data in publicly-accessible S3 paths (C-2), `globalAuthRule = public` footgun (C-3), no branch protection on `main` in any repo (C-4), UserProfile cross-user PII access (C-5).

When a new audit completes, prepend a one-liner to this list with the date, severity counts, and a link:

```
- 2026-MM-DD — N critical / N high / N medium / N low / N info — docs/audits/2026-MM-DD-audit.md
```
