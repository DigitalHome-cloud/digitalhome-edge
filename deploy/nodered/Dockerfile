# Custom Node-RED image — the whole digitalhome.edge in one container.
#
# The base image plus:
# - device palettes (CCU, Hue, Dashboard v2)
# - node-red-contrib-dhc-mcp     (MCP server surface for Claude)
# - node-red-contrib-dhc-sync    (OAuth device flow + telemetry to cloud)
#
# Both dhc-* palettes are copied from the repo checkout at build time and
# installed as local packages — no npm publish, no external registry.

FROM nodered/node-red:4.0.9

USER root
WORKDIR /usr/src/node-red

# Third-party palettes — pinned versions (audit M-3, no ^ drift).
RUN npm install --no-audit --no-fund --save --unsafe-perm \
      node-red-contrib-ccu@3.4.2 \
      node-red-contrib-huemagic@4.2.2 \
      @flowfuse/node-red-dashboard@1.30.2 \
    && npm cache clean --force

# In-tree palettes — build context is the repo root; contrib/ lives beside deploy/.
# The two .dockerignore files inside each contrib skip node_modules on copy.
COPY --chown=node-red:node-red contrib/dhc-mcp  /opt/dhe-src/dhc-mcp
COPY --chown=node-red:node-red contrib/dhc-sync /opt/dhe-src/dhc-sync

RUN npm install --no-audit --no-fund --save --unsafe-perm \
      /opt/dhe-src/dhc-mcp \
      /opt/dhe-src/dhc-sync \
    && npm cache clean --force

# Entrypoint bcrypts secrets into settings.js and seeds the starter flow
# on first boot. Build context is the repo root, so paths carry the
# deploy/nodered/ prefix.
COPY deploy/nodered/entrypoint.sh   /usr/local/bin/dhe-entrypoint.sh
COPY deploy/nodered/starter-flow.json /usr/local/share/dhe/starter-flow.json
RUN chmod +x /usr/local/bin/dhe-entrypoint.sh

USER node-red

ENTRYPOINT ["/usr/local/bin/dhe-entrypoint.sh"]
CMD ["npm", "start", "--cache", "/data/.npm", "--", "--userDir", "/data"]
