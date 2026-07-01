// oauth-device-flow.js
//
// RFC 8628 client for docs/specs/edge-cloud-api.md §3.1 – §3.4.
//
// Uses Node 20's global fetch — no HTTP dependency. Every call returns a
// discriminated result object so the caller can pattern-match without
// try/catch for expected outcomes ("authorization_pending" isn't an error).

"use strict";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

class DhcOAuthClient {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl   e.g. https://api.digitalhome.cloud/edge/v1
     * @param {string} opts.clientId  e.g. digitalhome-edge
     * @param {string} opts.scope     space-separated
     * @param {function} [opts.fetchImpl]  swap for tests
     */
    constructor(opts) {
        if (!opts.baseUrl)  throw new Error("DhcOAuthClient: baseUrl required");
        if (!opts.clientId) throw new Error("DhcOAuthClient: clientId required");
        this.baseUrl  = opts.baseUrl.replace(/\/+$/, "");
        this.clientId = opts.clientId;
        this.scope    = opts.scope || "";
        this.fetch    = opts.fetchImpl || global.fetch;
    }

    async _post(path, body, { bearer } = {}) {
        const headers = { "Content-Type": "application/json", "Accept": "application/json" };
        if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
        const res = await this.fetch(`${this.baseUrl}${path}`, {
            method:  "POST",
            headers,
            body:    JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch (_) { /* non-JSON body */ }
        return { status: res.status, body: json };
    }

    /**
     * POST /device_authorization
     * @returns {Promise<{kind:"ok", data:{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}} | {kind:"error", status:number, body:any}>}
     */
    async requestDeviceAuthorization(deviceInfo) {
        const { status, body } = await this._post("/device_authorization", {
            client_id:   this.clientId,
            scope:       this.scope,
            device_info: deviceInfo || {},
        });
        if (status === 200 && body?.device_code) {
            return { kind: "ok", data: body };
        }
        return { kind: "error", status, body };
    }

    /**
     * POST /token — one poll iteration. Callers loop with `interval` seconds.
     * @returns discriminated object with kind = "ok" | "pending" | "slow_down" | "denied" | "expired" | "error"
     */
    async pollToken(deviceCode) {
        const { status, body } = await this._post("/token", {
            grant_type:  DEVICE_CODE_GRANT,
            device_code: deviceCode,
            client_id:   this.clientId,
        });
        if (status === 200 && body?.access_token) {
            return { kind: "ok", data: body };
        }
        if (status === 400 && body?.error) {
            switch (body.error) {
                case "authorization_pending": return { kind: "pending" };
                case "slow_down":             return { kind: "slow_down" };
                case "access_denied":         return { kind: "denied", body };
                case "expired_token":         return { kind: "expired", body };
                default:                      return { kind: "error", status, body };
            }
        }
        return { kind: "error", status, body };
    }

    /**
     * POST /telemetry with bearer auth. Payload as spec §4.
     * @returns {Promise<{kind:"ok"|"unauthorized"|"gone"|"error", status?, data?, body?}>}
     */
    async postTelemetry(bearer, payload) {
        const { status, body } = await this._post("/telemetry", payload, { bearer });
        if (status === 200) return { kind: "ok", data: body };
        if (status === 401) return { kind: "unauthorized", status, body };
        if (status === 410) return { kind: "gone", status, body };
        return { kind: "error", status, body };
    }

    /**
     * POST /token/rotate with bearer auth.
     */
    async rotateToken(bearer) {
        const { status, body } = await this._post("/token/rotate", {}, { bearer });
        if (status === 200 && body?.access_token) return { kind: "ok", data: body };
        if (status === 401) return { kind: "unauthorized", status, body };
        return { kind: "error", status, body };
    }
}

module.exports = { DhcOAuthClient, DEVICE_CODE_GRANT };
