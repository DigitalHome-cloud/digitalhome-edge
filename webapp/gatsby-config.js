/**
 * Gatsby config for the digitalhome.edge web app.
 *
 * Served by Node-RED httpStatic at the /app sub-path, so pathPrefix must match
 * and the build must run with --prefix-paths (see package.json "build").
 * The SPA talks to the edge over same-origin /app-api/* endpoints, so no API
 * base URL / CORS config is needed.
 */
module.exports = {
  pathPrefix: "/app",
  siteMetadata: {
    title: "digitalhome.edge",
    apiBase: "/app-api",
  },
  plugins: [],
};
