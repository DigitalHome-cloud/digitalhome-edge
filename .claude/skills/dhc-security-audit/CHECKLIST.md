# Quick-reference audit checklist

This is the human-friendly companion to `SKILL.md`. Print it / paste it into a tracking issue when running an audit. Tick each box as you go; flag any "no" with a finding in the report.

## 1. Secrets & credentials

- [ ] No `aws-exports.js`, `.env.development`, or `.graphqlconfig.yml` tracked in any repo
- [ ] No AWS access keys (`AKIA…`) in git history (umbrella + 3 submodules)
- [ ] No private keys (`BEGIN PRIVATE KEY`) in history
- [ ] No hardcoded passwords / tokens in code
- [ ] All `GATSBY_*` env vars are intentionally public (Cognito Pool IDs, API endpoints — yes; secret keys — no)
- [ ] `.gitignore` covers `aws-exports.js`, `.env*`, `.graphqlconfig.yml`, `amplify` in each app
- [ ] Umbrella `.gitignore` covers `todo/`, `.graphqlconfig.yml`

## 2. Auth & authorization

- [ ] AppSync schema: every `@model` has an explicit `@auth` block
- [ ] No `allow: public` on tenant-scoped types
- [ ] Cognito User Pool: MFA enabled (optional or required)
- [ ] Password policy ≥ 12 chars + complexity + breach-list check
- [ ] Account recovery via verified email only
- [ ] Token expiry: access ≤ 1h, refresh ≤ 30d
- [ ] Identity Pool: unauthenticated role disabled (or scoped if used)
- [ ] AppSync default auth = `AMAZON_COGNITO_USER_POOLS`; API key fallback disabled or scoped
- [ ] Federation/Hosted UI: not configured (current state) OR audited (if enabled)
- [ ] Modeler custom signin handles all `nextStep` branches (new-password, MFA TOTP/SMS, confirm-signup, reset-password)

## 3. Data layer (DynamoDB & S3)

- [ ] Every tenant table partitions on `smartHomeId` (or equivalent)
- [ ] DynamoDB encryption at rest enabled
- [ ] DynamoDB point-in-time recovery enabled
- [ ] S3 bucket public access blocked at account + bucket level
- [ ] S3 bucket policy denies non-Amplify principals
- [ ] Signed URL TTL ≤ 1h
- [ ] Tenant paths in S3 enforced by Cognito identity claims, not just key naming

## 4. Frontend security

- [ ] No `dangerouslySetInnerHTML` / `innerHTML =` / `eval(` / `new Function(`
- [ ] All `target="_blank"` links have `rel="noopener noreferrer"`
- [ ] No `document.write` or unrestricted `window.open`
- [ ] Cross-app navigation always uses `getAppUrl()` (no hardcoded production URLs)
- [ ] `customHttp.yml` exists with CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- [ ] Reduced-motion respected on continuous animations (signin canvas, etc.)

## 5. Dependencies

- [ ] `yarn audit --level=high` returns zero High/Critical (or each one is documented + accepted)
- [ ] No GPL/AGPL/LGPL deps (Apache-2.0 + MIT only, per existing CLAUDE.md policy)
- [ ] Single lockfile per app (no mixed `yarn.lock` + `package-lock.json`)
- [ ] No major-version drift (React 18, Gatsby 5, Amplify v6, all aligned across apps)
- [ ] `caniuse-lite` browserslist data ≤ 6 months old

## 6. Build & CI/CD

- [ ] All three apps build clean from `yarn clean && yarn build`
- [ ] Amplify Console env vars match `aws-exports.deployment.js` expectations
- [ ] `amplify.yml` has no destructive shell calls (`rm -rf`, `curl | bash`)
- [ ] Branch protection on `main`: PR review required, build status check required, no force-push
- [ ] Branch protection on `stage`: same or lighter (review optional)
- [ ] Dependabot enabled on all 4 GitHub repos
- [ ] Secret scanning enabled on all 4 GitHub repos
- [ ] Amplify build IAM role scoped (no wildcard `*` resource)

## 7. Code quality

- [ ] `yarn format --check` passes in all 3 apps
- [ ] Locale parity: same key count in `en/`, `de/`, `fr/` per app
- [ ] Submodule SHAs in umbrella match each app's HEAD on `stage`
- [ ] At least one test for the auth flow per app (acknowledged: no tests today; this is a tracked Medium)

## 8. Documentation

- [ ] Each `CLAUDE.md` modified within the last 6 months OR validated as still accurate
- [ ] ADRs cover the major architectural decisions (auth, multi-repo, ontology, S3 layout)
- [ ] No empty spec files in `docs/specs/`
- [ ] Audit log updated in `.claude/skills/dhc-security-audit/SKILL.md` "Prior audits"

## Manual checks summary

These can't be scripted — confirm by hand each cycle:

- AWS Console: Cognito User Pool settings (MFA, password policy, recovery)
- AWS Console: Identity Pool roles (auth + unauth)
- AWS Console: AppSync auth modes
- AWS Console: S3 bucket policies + public access blocks
- AWS Console: DynamoDB encryption + PITR
- AWS Console: IAM build role scope
- GitHub: branch protection, dependabot alerts, secret scanning
- Amplify Hosting: per-app env var config (prod vs stage isolation)
- Browser: each app loads with correct CSP / HSTS headers (use the network tab)
