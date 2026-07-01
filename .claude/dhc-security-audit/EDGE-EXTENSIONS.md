# Edge-context extensions for `dhc-security-audit`

`SKILL.md` and `CHECKLIST.md` are written for the cloud platform (Portal, Designer,
Modeler + Amplify Gen1/Gen2). When the skill is run against a `digitalhome-edge`
checkout (this repo, or a future dhe box), the eight cloud domains still apply where
they translate — but three edge-only domains are added, and a couple of cloud domains
map differently. This file records those additions so the next audit doesn't
re-derive them.

## When to load this file

Load `EDGE-EXTENSIONS.md` when any of these are true:

- The current working directory is `digitalhome-edge/` (this repo).
- The audit target is a live edge box (`/home/dhc-svc/…` or `/opt/dhe/…` layout).
- The `git remote -v` origin URL contains `digitalhome-edge`.

Run cloud domains 1, 3, 5, 6, 7, 8 unchanged where they apply. Domains 2 and 4 are
partially replaced (see mapping below). Then run the three new edge-only domains
below (9, 10, 11).

## Domain mapping: cloud → edge

| Cloud domain | Edge equivalent | Notes |
|---|---|---|
| 1. Secrets & credentials | 1. Secrets & credentials (unchanged) | Add checks for `digitalhome.edge.config.cache` file mode, `flows_cred.json` protection. |
| 2. Auth & authorization (Cognito + AppSync) | **9. MCP surface** (new) + **10. Node-RED posture** (new) | The edge does not run Cognito/AppSync. Auth on the local Python MCP server and on Node-RED replaces those checks. |
| 3. Data layer (DynamoDB + S3) | Adapt: SQLite instead | Check DB file mode, gitignore coverage, WAL journal disposal. No S3 on the edge itself (that's cloud-side). |
| 4. Frontend security | Mostly N/A | Node-RED Dashboard v2 replaces the Gatsby apps; a few checks (see §10.4). |
| 5. Dependency hygiene | Adapt: `pip` + `npm` global for Node-RED | `yarn audit` becomes `pip-audit` + `npm audit` in the userDir. |
| 6. Build, deploy, CI/CD | Adapt: `install.sh` + systemd + `git pull` | No Amplify Hosting; the checks become "installer safety" + "update mechanism safety". |
| 7. Code quality | Unchanged | Python + bash + JavaScript-in-flows. |
| 8. Documentation | Unchanged | `CLAUDE.md`, `SPEC.md`, `docs/architecture.md`, `docs/adr/`. |

## 9. MCP surface (new)

**What you're looking for**: any unauthenticated / over-permissioned tool exposure on
the Model Context Protocol endpoint.

```bash
# Bind address — is the MCP server LAN-open?
grep -n -E "uvicorn.run|host\s*=|bind" mcp-server/*.py

# Authentication middleware — is there any?
grep -n -E "@app.middleware|Depends\(|verify_token|Bearer|api_key|Authorization" mcp-server/*.py

# Tool signatures that accept arbitrary URL fragments (SSRF-adjacent)
grep -n -B 1 -A 6 "@mcp.tool()" mcp-server/*.py | grep -E "endpoint:|path:|node_id:|url:" | head

# ufw exposure of the MCP port
grep -n "ufw allow.*8000\|ufw allow.*8443" install.sh
```

**Manual checks**:
- Does the MCP endpoint use TLS? (Target per SLAB5 spec: `:8443` streamable HTTP.)
- Are there any MCP tools whose docstring says "pass any …" — those are SSRF/RCE
  surface for authenticated but low-privilege callers.
- Does the MCP catalog auto-generate from the C-BOX yet (SLAB5 target), or are
  tools hand-coded (current)? Hand-coded → each tool is its own review target.

**Severity guidance**:
- Unauthenticated MCP endpoint on a LAN-open port = **Critical**.
- Auth present but tool signatures allow arbitrary paths = **High** (SSRF surface).
- No TLS = **High** if any device-control tool exists; **Medium** for read-only KB tools.

## 10. Node-RED posture (new)

**What you're looking for**: unlocked admin API, unauthenticated HTTP-in flows,
credential-secret mishandling, palette CVEs.

```bash
# Is adminAuth configured?
find / -path "*/.node-red/settings.js" 2>/dev/null | while read f; do
  echo "[$f]"
  grep -nE "adminAuth|httpNodeAuth|httpAdminAuth|credentialSecret|editorTheme" "$f"
done

# Is the credential secret set (must not be the shipped default)?
grep -n "credentialSecret" install.sh docs/install.md

# HTTP-in endpoints — any auth wrappers?
python3 -c "
import json, glob
for f in glob.glob('flows/*/flows.json'):
    with open(f) as fh: flows = json.load(fh)
    ins = [n for n in flows if n.get('type') == 'http in']
    print(f'{f}: {len(ins)} HTTP-in endpoints')
    for n in ins[:10]:
        print(f\"  {n.get('method','?').upper():5s} {n.get('url','?')}\")
"

# flows_cred.json presence + perms (on a live box)
stat -c '%a %n' /home/dhc-svc/.node-red/projects/*/flows_cred.json 2>/dev/null

# Node-RED version + palette versions
grep -E '"node-red-contrib|"node-red"|"@flowfuse' /home/dhc-svc/.node-red/package.json 2>/dev/null
```

**Manual checks**:
- Node-RED editor: does it prompt for a password, or does it load straight to flows?
  (Straight-to-flows on a LAN-open port = C-1 in the 2026-07-01 audit.)
- Dashboard v2: is it exposed publicly (`:1880/ui`) or gated behind `httpNodeAuth`?
- Flow contents (`function` nodes): scan for `require("fs")`, `require("child_process")`,
  `eval(`, `Function(` — these are legitimate in some flows but each usage is a
  review target.

**Severity guidance**:
- No `adminAuth` on a LAN-open `:1880` = **Critical**.
- No `credentialSecret` (or default secret) = **High** (encrypted-at-rest credentials
  are trivially decryptable with the default).
- HTTP-in endpoints without `httpNodeAuth` and reachable from LAN = **High**.
- Palette major-version behind + known CVE = **Medium/High** depending on severity.

## 11. Systemd / runtime hardening (new)

**What you're looking for**: services running with more privilege / more filesystem
access than they need; installer scripts doing sudo-heavy things without user
confirmation; update mechanisms that trust remote content.

```bash
# Systemd unit hardening
for u in /etc/systemd/system/{nodered,mcp-server,dhe}.service; do
  [ -f "$u" ] || continue
  echo "=== $u ==="
  grep -E "NoNewPrivileges|ProtectSystem|ProtectHome|PrivateTmp|PrivateDevices|RestrictAddressFamilies|CapabilityBoundingSet|SystemCallFilter|ReadWritePaths|ReadOnlyPaths|User=|Group=" "$u" || echo "  (no hardening flags)"
done

# Service user posture
getent passwd dhc-svc 2>/dev/null
ls -la /home/dhc-svc 2>/dev/null | head

# Config cache file mode (must be 0600, not 0644)
stat -c '%a %n' /home/dhc-svc/digitalhome.edge.config.cache 2>/dev/null
stat -c '%a %n' /opt/dhe/secrets/* 2>/dev/null

# ufw / firewall state
ufw status verbose 2>/dev/null | head -20
ss -ltn 2>/dev/null | head

# install.sh review: run-as-root, network fetches, sudo escalation
grep -n -E "curl\s+.*\|\s*(bash|sh)|wget\s+.*\|\s*(bash|sh)|sudo\s|EUID|require_root" install.sh

# Update mechanism — how does the box pull updates?
grep -n -E "git pull|systemctl restart|apt(-get)?\s+(upgrade|dist-upgrade)|unattended" bin/dhcedge install.sh docs/install.md

# dhcedge update-hosts hostname/ip validation
grep -n -B 2 -A 12 "update_hosts\|cmd_update_hosts" bin/dhcedge
```

**Manual checks**:
- Is the `dhc-svc` shell nologin?
- Does `install.sh` prompt before making destructive changes (writing systemd units,
  opening firewall ports)? Or is it "run as root, no prompt, no dry-run"?
- What runs at deploy time? `git pull` on the repo → does anything auto-execute
  (a hook, a pre-commit that runs on the server)?
- Are there any `sudo` NOPASSWD rules for `dhc-svc`? Check `/etc/sudoers.d/`.

**Severity guidance**:
- Missing `NoNewPrivileges` on a network-exposed service = **Medium**.
- Config cache mode 0644 (readable by other local users) = **High**.
- `sudo dhc-svc ALL=(ALL) NOPASSWD: ALL` = **Critical**.
- ufw disabled entirely on prod = **Critical**.
- Unattended-upgrades disabled on prod = **Medium**.
- Installer that pipes remote content to `sh`/`bash` = **High**.

## Report additions

When writing the audit report, add the three new domains to the "What was checked but
found clean" list even if empty findings — future readers should see they were run.

The report title becomes `<repo> Security & Quality Audit — YYYY-MM-DD` (drop the
"DHC" prefix — it's not always the DigitalHome.cloud platform being audited).

## Reference audits

- `docs/audits/2026-07-01-audit.md` — first edge-context audit. **2 critical / 4 high / 5 medium / 4 low / 3 info.** Both critical findings (C-1 Node-RED admin API open, C-2 MCP endpoint open) are blocking; the SLAB5 migration plan addresses several but does not implement auth on day one — must be added regardless of migration timeline.
