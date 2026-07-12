// digitalhome.edge httpNodeMiddleware
//
// Applies HTTP Basic auth to httpNode routes (/api/*, custom http-in
// endpoints, etc.) but explicitly exempts /dashboard/* so the local
// homeowner can scan the pairing QR without credentials on the LAN.
//
// The factory takes the bcrypt hash the entrypoint generated from
// /secrets/nodered-http-password and returns an Express middleware.
// It is wired into settings.js as:
//
//   httpNodeMiddleware: require('/usr/local/share/dhe/http-auth-middleware.js')({
//       user: "dhcedge",
//       hash: "$2a$08$..."
//   }),
//
// Because httpNodeMiddleware runs BEFORE httpNodeAuth in Node-RED's
// request pipeline, and httpNodeAuth is no longer set, this middleware
// is the only gate on /api/*.

const bcrypt = require("bcryptjs");

module.exports = function ({ user, hash }) {
    // Fail-open only in the "misconfigured, nothing to check against"
    // shape — logged so the operator notices.
    if (!user || !hash) {
        console.warn("[dhe-http-auth] user/hash missing — httpNode routes are UNAUTHENTICATED");
        return function passthrough(req, res, next) {
            next();
        };
    }

    const denyBasic = (res) => {
        res.set("WWW-Authenticate", 'Basic realm="digitalhome.edge"');
        return res.status(401).send();
    };

    return function dheHttpAuth(req, res, next) {
        // LAN-open surfaces (no credentials): the Dashboard v2 (/ui, and its
        // legacy /dashboard alias) + socket.io, the static edge web app (/app),
        // and its headless onboarding API (/app-api). These are intentionally
        // open on the local network so a homeowner can pair/onboard without
        // credentials — the same posture as the pairing QR. Exact-or-prefix
        // match so we don't whitelist e.g. /dashboard-admin or /appx.
        const open = ["/dashboard", "/ui", "/app", "/app-api"];
        if (open.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
            return next();
        }

        const hdr = req.headers.authorization || "";
        if (!hdr.startsWith("Basic ")) return denyBasic(res);

        const decoded = Buffer.from(hdr.slice(6), "base64").toString();
        const idx = decoded.indexOf(":");
        if (idx < 0) return denyBasic(res);
        const u = decoded.slice(0, idx);
        const p = decoded.slice(idx + 1);

        if (u !== user || !bcrypt.compareSync(p, hash)) return denyBasic(res);
        return next();
    };
};
