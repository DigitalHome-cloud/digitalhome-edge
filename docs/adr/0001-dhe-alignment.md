# ADR-0001: Align `digitalhome-edge` with the SLAB5 target architecture

**Status:** Accepted
**Date:** 2026-07-01
**Deciders:** Frank-Uwe
**Related:** [`../architecture.md`](../architecture.md) (target spec), [`../../SPEC.md`](../../SPEC.md) (current-state snapshot)

## Context

The `digitalhome-edge` repo currently runs a working Homematic + Hue bridge
built around a Python FastMCP server, a hand-authored Node-RED flow set, and a
local SQLite knowledge/device store. The SLAB5 architecture programme
(see `docs/architecture.md`) defines a target end-state that differs
substantially: an ontology-driven twin (REC/Brick JSON-LD C-BOX), a
catalog-generated MCP surface with Resources as well as Tools, a Docker
Compose runtime under `/opt/dhe/`, a dedicated sync-agent, and a cloud deploy
pipeline that pushes twin + flow bundles from the Blockly designer to the edge.

A full gap analysis and phased migration plan was produced separately
(the plan file `~/.claude/plans/tingly-swimming-sphinx.md`). This ADR captures
the load-bearing decisions from that plan so they survive independent of the
plan file, and states clearly which parts of the SLAB5 spec we accept, adapt,
or defer.

## Decision

### Accepted as-is from the SLAB5 spec

1. **Ontology-driven twin.** A-BOX = REC + Brick vocabulary; C-BOX = per-home
   JSON-LD instance with `slab:liveRef` + `slab:lakeRef` on every Point.
   The `slab:` namespace remains SLAB5-owned (it is the spec's own vocabulary).
2. **MCP catalog is generated from the C-BOX at deploy time**, not authored by
   hand. One MCP Resource per readable Point, one Tool per Command Point, one
   Tool per historical query. Catalog is a versioned snapshot; `listChanged`
   notifications fire on redeploy.
3. **Runtime is a Docker Compose stack under `/opt/dhe/`** with three
   services (`node-red`, `mcp-server`, `sync-agent`), all `network_mode: host`.
   Bind-mounts only, no named volumes. A single `dhe.service` (systemd
   oneshot) manages the stack.
4. **Cloud is the single source of truth for the twin.** The local
   `/opt/dhe/cbox/cbox.jsonld` cache is refreshed only on (a) edge startup and
   (b) new cloud deployment of the C-BOX — no scheduled refresh, no
   operator-triggered local edits.
5. **Provisioning via a Claude Code Skill** that generates declarative
   artifacts (`docker-compose.yml`, `dhe.service`, `.env`, secrets files) —
   the artifacts are the deliverable, the Skill is disposable.
6. **Per-tenant isolation via STS AssumeRole** scoped to
   `s3://digitalhome-cloud/{homeId}/*`. Application code cannot cross tenants.
7. **Node-RED Projects for git-backed flow versioning.** Already enabled;
   matches spec §6 exactly.

### Adapted

1. **Product naming.** SLAB5 is the company; the product is
   **digitalhome.edge** (short forms: `dhe`, `dh.edge`). All identifiers
   (systemd unit, directory paths, container names, image names) use `dhe`.
   `SLAB5` appears only when attributing the spec document or referring to
   the company. The `slab:` JSON-LD namespace stays SLAB5-owned by design.
2. **Homematic + Hue are first-class dhe protocols.** The spec names
   Matter/MQTT/SmartThings; we extend `liveRef.protocol` to also accept
   `homematic` and `hue`. All 57 devices currently inventoried lift into the
   first C-BOX without protocol migration. Rationale: the deployed base runs
   on these protocols and re-doing it via MQTT bridges adds risk without
   value.
3. **Ontology lives in `modeler/semantic-core`, not vendored into the edge repo.**
   The `~/digitalhomeCloud/digitalhome-cloud-darkfactory/repos/modeler/semantic-core/`
   folder is the single source of truth for REC + Brick vocabulary across the
   platform. The edge Dockerfile clones the modeler repo at a pinned SHA and
   copies `semantic-core/` into the image at build time. This keeps the edge
   self-contained at runtime while the modeler remains the authoring surface.
4. **Cutover via fresh Ubuntu VM first.** Build the entire dhe stack on a
   scratch VM, verify end-to-end, then reprovision stage (DLAB5-W541-01),
   then prod (DLAB5-M92P-01). Neither existing box is disturbed until the VM
   run passes verification.

### Deferred (not part of the initial cutover)

1. **Cloud-executed mode** (Lambda MCP server for cloud-only homes) —
   tracked as a follow-up after the hybrid path is stable.
2. **Zigbee / Matter native controllers on the edge** — the Docker Compose
   contract already leaves room for a Zigbee dongle (`/dev/ttyUSB0`) and
   Matter mDNS (`network_mode: host`), but no devices of those protocols
   exist in the current inventory. Wire them in when the first Matter/Zigbee
   device arrives.
3. **Criticality routing** (`slab:criticality: "high" | "normal"` enforcement
   at deploy and runtime) — the C-BOX will carry the tag but runtime routing
   decisions are not enforced in the first cutover. Track as a follow-up.

### Resolved since the plan was written

- **Amplify Gen1 → Gen2 migration** for the shared backend is **complete**.
  The Phase 7 precondition no longer blocks the cloud deploy pipeline work.
  The Blockly designer can be extended against the Gen2 backend directly.

## Consequences

**Positive.**
- One coherent target architecture — no half-migrated intermediate state.
- Clean separation between what's running today (`SPEC.md`) and what we're
  building (`docs/architecture.md`), with this ADR bridging the two.
- Homematic + Hue survive the migration as first-class protocols, so the
  57-device deployed base is not thrown away.
- Ontology lives once (in the modeler), not twice.

**Negative / accepted tradeoffs.**
- Full rewrite is multi-week; existing stage box will be replaced, not
  incrementally upgraded.
- Extending `liveRef.protocol` beyond the spec's Matter/MQTT/SmartThings list
  is a small local extension to SLAB5 — coordinate with the spec authors if
  this affects broader tooling.
- The `slab:` namespace remains in JSON-LD payloads despite the product-name
  rename; readers unfamiliar with the company/product distinction may find
  this confusing (documented in this ADR and in the naming note at the top
  of the plan file).

## Migration plan (summary)

Full phased plan lives in `~/.claude/plans/tingly-swimming-sphinx.md`.
Phase headers only:

- **Phase 0** — Alignment docs (this ADR + doc restructure).
- **Phase 1** — Directory layout & runtime shape on fresh Ubuntu VM.
- **Phase 2** — Config & secrets model split.
- **Phase 3** — Ontology + C-BOX + catalog generation, MCP server rewrite.
- **Phase 4** — Node-RED contrib package (`node-red-contrib-dhc-edge-mcp`).
- **Phase 5** — Sync-agent (startup pull, deploy-triggered pull, timeseries).
- **Phase 6** — Provisioning Skill.
- **Phase 7** — Cloud deploy pipeline (unblocked now that Gen2 is done).
- **Phase 8** — Cutover: VM → stage → prod.

## Still-open decisions

1. **Device inventory lift.** How much of the current 57-device inventory is
   auto-lifted into the first C-BOX by `cbox_gen.py` vs. redone through
   Blockly brownfield autodiscovery once the designer supports it.
2. **Container image registry.** Docker Hub? Private ECR under the same AWS
   account as the (now Gen2) Amplify backend?
3. **Deploy-notification channel** (Phase 5): cloud → edge "new C-BOX deployed"
   signal — MQTT, WebSocket over HTTPS, or AWS IoT Core?
4. **VM specs and host** for the Phase 1 build (workstation KVM vs. separate
   host vs. cloud instance) and whether to snapshot as a golden image.
