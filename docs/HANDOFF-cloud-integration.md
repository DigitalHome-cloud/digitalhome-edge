# Handoff → digitalhome.edge — Cloud edge-integration is LIVE (stage)

**From:** dark factory / cloud team
**Date:** 2026-07-04
**Status:** Cloud side **deployed + verified on stage**. Edge side needs the small
changes in [`docs/specs/dhc-sync-pairing-client.md`](specs/dhc-sync-pairing-client.md)
to pair end-to-end.

---

## 1. TL;DR

The RFC 8628 edge registration API and the **two-step pairing** model are live on
stage, behind a real hostname:

- **Edge API (stage):** `https://stage-api.digitalhome.cloud/edge/v1`
- **Portal (stage):** `https://stage-portal.digitalhome.cloud` (`/link`, `/edges`)

To connect a box **to stage**, its Node-RED flow must point the `dhc-sync-config`
node at the **stage** edge API (see §3 — this is the one thing you need to change
now). The box's own dashboard QR already sends the user to the correct
(stage) Portal — the cloud fills that in per environment.

---

## 2. Environment endpoints

The cloud API is **branch-aware**; the hostname tells you the environment:

| Environment | Edge API base URL (`cloudApiUrl`) | Portal | Status |
|---|---|---|---|
| **stage** | `https://stage-api.digitalhome.cloud/edge/v1` | `stage-portal.digitalhome.cloud` | ✅ live |
| **prod** | `https://api.digitalhome.cloud/edge/v1` | `portal.digitalhome.cloud` | ⏳ created on the next cloud `main` deploy |
| **dev** | a developer's sandbox `execute-api` URL + `/edge/v1` | (their sandbox) | per-developer |

The edge appends the fixed paths itself (`/device_authorization`, `/token`,
`/telemetry`, `/token/rotate`) — set only the **base** URL.

---

## 3. Coding the target into the flow  ← ACTION REQUIRED

The environment is defined by the **flow's origin** (the `flows/digitalhome-flows`
submodule → `digitalhome-edge-nodered-flows`, stage vs prod). The target URL lives
in the `dhc-sync-config` node's **`cloudApiUrl`** property, which is stored in the
flow JSON. **The code default is prod**
(`dhc-sync-config.js:32`, `.html:6`), so a stage flow **must override it**.

### Do now (stage)
In the **stage** flow, set the `dhc-sync-config` node:
```
cloudApiUrl = https://stage-api.digitalhome.cloud/edge/v1
```
Everything else on that node stays as-is (`clientId=digitalhome-edge`,
`scope=edge.link edge.telemetry edge.cbox edge.lake`, `secretsDir=/secrets`,
`configDir=/config`).

Commit that in the **stage branch of `digitalhome-edge-nodered-flows`**, so the
"origin of the flow" carries the environment: the stage flow → stage-api, the
prod flow → the default `api.digitalhome.cloud`, a dev flow → the dev sandbox URL.

### Recommended (optional) — make the environment first-class
Two clean ways so nobody forgets to override the prod default:

1. **Env-var indirection.** Put `cloudApiUrl = ${DHC_CLOUD_API_URL}` in the node
   and define `DHC_CLOUD_API_URL` per box (docker-compose `environment:` /
   `/opt/dhe/.env`). Node-RED substitutes `${ENV}` in node string properties at
   deploy. The value still comes from the environment, not the flow — use this
   only if you'd rather key off the box than the flow.
2. **Env dropdown on the node** (small `dhc-sync` change): add an `env`
   selector (`dev|stage|prod`) to `dhc-sync-config` that maps to the three base
   URLs, so a flow just picks `stage`. Cleanest long-term; needs a code change in
   `contrib/dhc-sync`.

For now, option in §3 "Do now" (explicit `cloudApiUrl` in the stage flow) is
enough and matches "the origin of the flow defines the environment".

---

## 4. What's live on the cloud (so you know what to expect)

**Two-step pairing** (the model you described — register the box to the user,
then link it to a home later):

1. Box shows QR + `user_code` on its dashboard (Setup tab).
2. User opens `verification_uri_complete` (→ **stage**-portal `/link`), signs in
   with Cognito, sees the box's `device_info`, and **Approves**.
   - They may **pick a home now** *or* **"register only, link later"** — home is
     optional.
3. Box's next `/token` poll returns a `device_token` (+ `edge_id`). If no home was
   chosen, `home_id` is `null` and `cloud_endpoints` is `null`.
4. Later, the user assigns the box to a Digital Home from Portal **My Edges**
   (`/edges`). The box learns its `home_id` from the **`/telemetry` response**
   (now echoes the current `home_id`) — no re-pairing.

Verified end-to-end on stage (register-without-home → token → listMyEdges →
linkEdgeToHome → telemetry shows the home → unassign).

**Wire contract (unchanged, must be honored):** JSON bodies; success is HTTP
**200 exactly**; `/token` pending/errors are HTTP **400** with
`{"error": authorization_pending|slow_down|access_denied|expired_token}`;
`/telemetry` uses **401** / **410**; `interval ≥ 5`. Full spec:
[`docs/specs/edge-cloud-api.md`](specs/edge-cloud-api.md).

---

## 5. Edge-side changes required — see the spec

Details + line refs in **[`docs/specs/dhc-sync-pairing-client.md`](specs/dhc-sync-pairing-client.md)**. Summary:

1. **CRITICAL — writable secrets mount.** `deploy/docker-compose.yml:27` mounts
   `/opt/dhe/secrets:/secrets:ro`. The box can't persist its `device-token`
   (`EROFS`) and drops to `ERROR` on link. Change to `:rw`. **Nothing pairs until
   this is fixed** — independent of everything else.
2. **Tolerate a null home** at registration (`onLinked`, `dhc-sync-config.js:150`)
   — don't write the literal `"null"` to `home-id`; still enter `LINKED`.
3. **Learn the home from telemetry** (`dhc-sync-config.js:207`) — read `home_id`
   from the 200 response and update `home-id` when it changes.
4. **Dashboard** — add a "registered, awaiting home" state.

---

## 6. Acceptance test (stage)

Cloud side (already passing — sanity curl):
```bash
curl -s -X POST https://stage-api.digitalhome.cloud/edge/v1/device_authorization \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"digitalhome-edge","scope":"edge.link edge.telemetry edge.cbox edge.lake","device_info":{"machine_id":"t","hostname":"t","lan_ip":"1.2.3.4","dhe_version":"0.3.0"}}'
# → 200, verification_uri = https://stage-portal.digitalhome.cloud/link?user_code=...
```
End-to-end (after §5.1 + §3):
- [ ] Boot a box on the **stage** flow → dashboard shows QR/`user_code`.
- [ ] Open the QR → stage Portal `/link` → sign in → **Approve (register only)**.
- [ ] Box persists `device-token`/`edge-id`, flips to `LINKED`, dashboard shows
      "registered, awaiting home".
- [ ] In Portal **My Edges**, assign the box to a Digital Home → next telemetry
      carries `home_id`; dashboard flips to "Linked to {home}".

---

## 7. Prod cutover

`https://api.digitalhome.cloud/edge/v1` is created automatically when the cloud
`core` repo is deployed to `main` (not done yet — everything is on stage). The
edge default already points at prod, so the **prod** flow needs no `cloudApiUrl`
override — only the stage/dev flows do. Coordinate the `main` cutover with the
cloud team.

---

## 8. References

- Wire spec (authoritative): `docs/specs/edge-cloud-api.md`
- Edge client changes: `docs/specs/dhc-sync-pairing-client.md`
- Cloud tracking spec: `digitalhome-cloud-darkfactory/docs/specs/DH-SPEC-100-edge-cloud-registration.md`
- Flows repo (stage/prod origin): `digitalhome-edge-nodered-flows` (submodule `flows/digitalhome-flows`)
