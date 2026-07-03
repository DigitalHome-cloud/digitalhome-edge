# dhc-sync — Pairing Client Changes (two-step + writable secrets)

**Status:** Draft v0.1
**Owner:** `digitalhome-edge` team
**Date:** 2026-07-03
**Depends on:** `docs/specs/edge-cloud-api.md` (wire spec) — cloud side is **live on stage**.
**Related (cloud):** `digitalhome-cloud-darkfactory/docs/specs/DH-SPEC-100-edge-cloud-registration.md`

## 1. Why

The cloud registration API (RFC 8628 device flow) is implemented and verified on
stage, including a **two-step pairing model**: a box can register to its owner
**without a home**, and the owner assigns it to a Digital Home later from the
Portal "My Edges" page. Two edge-client changes are needed to use it:

1. **Blocker — the secrets mount is read-only**, so the box cannot persist its
   `device-token` and drops to `ERROR` the moment it links. Nothing pairs
   end-to-end until this is fixed. This is independent of the two-step work.
2. **Two-step support** — tolerate a `null` home at registration and learn the
   home later from the telemetry response.

## 2. Cloud contract changes the edge must accommodate

Already deployed (stage); the edge must not break on them:

| Endpoint | Change |
|---|---|
| `POST /token` (success) | `home_id` may be **`null`** (registered, no home yet). `cloud_endpoints` may be **`null`** when there is no home. |
| `POST /telemetry` (200) | Response now includes **`home_id`** — the box's *current* binding. It can change from `null` → a home after the owner links it in the Portal (or back to `null` on unassign). |

Unchanged: paths, JSON bodies, exact `200 / 400(error) / 401 / 410` semantics,
`interval ≥ 5`.

## 3. Required changes

### 3.1 CRITICAL — make the secrets mount writable
`deploy/docker-compose.yml:27` mounts `/opt/dhe/secrets:/secrets:**ro**`.
`contrib/dhc-sync/lib/secrets.js` `writeSecret()` does `writeFile(tmp)` + `rename()`,
which fails `EROFS` on a read-only mount; `onLinked()`
(`nodes/dhc-sync-config.js:152-154`) throws and the FSM drops to `ERROR`.

**Change:** mount `/opt/dhe/secrets` read-write.
```yaml
# deploy/docker-compose.yml
-      - /opt/dhe/secrets:/secrets:ro
+      - /opt/dhe/secrets:/secrets:rw
```
`/opt/dhe/config:/config:ro` stays read-only (the container never writes config).
Host perms remain `0700` dir / `0600` files (owner uid 1000). This alone unblocks
end-to-end pairing for the existing one-step flow.

### 3.2 Tolerate a null home at registration (`onLinked`)
`nodes/dhc-sync-config.js:150-166`. Today it does
`writeSecret(dir, "home-id", tokenResp.home_id)` unconditionally — with a `null`
home that writes the literal string `"null"` to `/opt/dhe/secrets/home-id`.

**Change:** treat `home_id` as optional.
- If `tokenResp.home_id` is a non-empty string → write `home-id` as today.
- If it is `null`/empty → **do not** write a bogus value: `deleteSecret(dir, "home-id")`
  (or skip the write) so the file is absent, not `"null"`.
- Enter `LINKED` regardless (the box has a valid `device_token` + `edge_id`); the
  *home* is a separate, later concern.
- The status payload / FSM `home_id` should be `null` when unset (not `"null"`).

### 3.3 Learn the home from the telemetry response (heartbeat loop)
`nodes/dhc-sync-config.js:207-211` reads `cbox_updated` / `cbox_version` /
`poll_after_s` from the 200 body but ignores `home_id`.

**Change:** on each telemetry 200, compare `res.data.home_id` to the currently
stored `home-id`:
- changed to a non-empty value → `writeSecret(dir, "home-id", res.data.home_id)`,
  update the FSM/dashboard, `node.log("assigned to <home_id>")`.
- changed to `null`/empty (unassigned) → `deleteSecret(dir, "home-id")` + update
  state.
- unchanged → no-op.

This is how a box registered without a home discovers its assignment after the
owner links it in the Portal, with no re-pairing.

### 3.4 Dashboard — "registered, awaiting home" state
`examples/pairing-flow.json` + the status surface. Today the Setup tab shows the
QR + `user_code` while unlinked and a "linked to {home}" Status tab once linked.

**Change:** when `state == LINKED` **and** `home_id` is empty, show a distinct
line — e.g. *"Registered ✓ — waiting to be linked to a home in the Portal
(My Edges)."* When `home_id` later populates (via §3.3), switch to the normal
*"Linked to {home_id} ✓"*. The existing pairing button (QR + `user_code` +
"Restart pairing") is unchanged and already satisfies the "web interface with a
pairing button" requirement.

## 4. Secondary / backlog (not required for two-step)

- **Token rotation:** `lib/oauth-device-flow.js` has `rotateToken()` but the FSM
  never calls it — a `401` forces a full re-pair (`nodes/dhc-sync-config.js:223`).
  Wire it up per wire-spec §3.4 to avoid re-approval on token expiry.
- **Config source drift:** `README.md` says `cloud.api_url` comes from
  `/config/dhe.config.cache`, but the code only reads the Node-RED node property
  `cloudApiUrl`. Align the docs (or read the cache). Default stays
  `https://api.digitalhome.cloud/edge/v1`; for stage testing set the node's
  `cloudApiUrl` to the stage `execute-api` URL + `/edge/v1`.
- **machine-id:** fallback is random hex (`lib/system-info.js`); wire spec §9.3
  specifies UUIDv7. Cosmetic.

## 5. Acceptance criteria

- [ ] With the writable mount, a box completes pairing: dashboard QR → Portal
      approve → box persists `device-token`/`edge-id`, flips to `LINKED`
      (no `EROFS`, no `ERROR`).
- [ ] Approving on `/link` **without** a home leaves the box `LINKED` with no
      `home-id` file (not `"null"`), dashboard shows "registered, awaiting home".
- [ ] After the owner assigns the box in Portal → My Edges, the next telemetry
      200 carries `home_id`; the box writes `home-id` and the dashboard flips to
      "Linked to {home}".
- [ ] Unassigning in the Portal clears the box's `home-id` on the next heartbeat.
- [ ] The one-step flow (home chosen during approval) still lands `LINKED` with
      the home set immediately.

## 6. Files touched

- `deploy/docker-compose.yml` (§3.1)
- `contrib/dhc-sync/nodes/dhc-sync-config.js` (§3.2, §3.3, §3.4 state)
- `contrib/dhc-sync/examples/pairing-flow.json` (§3.4 dashboard)
- `contrib/dhc-sync/lib/secrets.js` — only if `deleteSecret` needs a guard for a
  missing file (it likely already no-ops).
- Tests: extend `contrib/dhc-sync/test/state-machine.test.js` for the
  registered-without-home and learn-home-from-telemetry transitions.
