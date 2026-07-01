# Custom Node-RED image with the digitalhome.edge palette set baked in.
# Base image: node-red 4.x (Node 20). We stay on a specific minor tag to avoid
# silent drift; bump intentionally when Node-RED itself is upgraded.
FROM nodered/node-red:4.0.9

# Palette install runs in /usr/src/node-red where the base image keeps its
# own package.json. Any package installed here is available at runtime
# without a first-boot npm install step.
USER root
WORKDIR /usr/src/node-red

# Pin to the same versions the existing stack uses (audit M-3 — no ^ drift).
RUN npm install --no-audit --no-fund --save --unsafe-perm \
      node-red-contrib-ccu@3.4.2 \
      node-red-contrib-huemagic@4.2.2 \
      @flowfuse/node-red-dashboard@1.30.2 \
    && npm cache clean --force

# Bcryptjs ships with Node-RED — the entrypoint uses it to hash passwords
# from the /secrets mount into settings.js on first boot.
COPY entrypoint.sh /usr/local/bin/dhe-entrypoint.sh
RUN chmod +x /usr/local/bin/dhe-entrypoint.sh

USER node-red
# WORKDIR stays at the base image default (/usr/src/node-red) — that's
# where the node-red package.json lives so `npm start` resolves.

ENTRYPOINT ["/usr/local/bin/dhe-entrypoint.sh"]
CMD ["npm", "start", "--cache", "/data/.npm", "--", "--userDir", "/data"]
