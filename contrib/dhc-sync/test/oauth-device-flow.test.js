import { describe, it, expect, vi } from "vitest";
import { DhcOAuthClient, DEVICE_CODE_GRANT } from "../lib/oauth-device-flow.js";

function mockFetch(responses) {
    const impl = vi.fn();
    for (const r of responses) {
        impl.mockResolvedValueOnce({
            status: r.status,
            json: async () => r.body
        });
    }
    return impl;
}

describe("DhcOAuthClient", () => {
    const opts = {
        baseUrl:  "https://api.example.com/edge/v1",
        clientId: "digitalhome-edge",
        scope:    "edge.link edge.telemetry"
    };

    it("requestDeviceAuthorization returns ok on 200", async () => {
        const fetchImpl = mockFetch([{
            status: 200,
            body: {
                device_code: "dc_v1_x",
                user_code:   "ABCD-1234",
                verification_uri: "https://portal.example/link",
                verification_uri_complete: "https://portal.example/link?user_code=ABCD-1234",
                expires_in: 600,
                interval:   5
            }
        }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.requestDeviceAuthorization({ machine_id: "abc" });
        expect(r.kind).toBe("ok");
        expect(r.data.user_code).toBe("ABCD-1234");
        expect(fetchImpl).toHaveBeenCalledOnce();

        const call = fetchImpl.mock.calls[0];
        expect(call[0]).toBe("https://api.example.com/edge/v1/device_authorization");
        expect(call[1].method).toBe("POST");
        const body = JSON.parse(call[1].body);
        expect(body.client_id).toBe("digitalhome-edge");
        expect(body.device_info.machine_id).toBe("abc");
    });

    it("requestDeviceAuthorization returns error on 429", async () => {
        const fetchImpl = mockFetch([{ status: 429, body: { error: "rate_limited" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.requestDeviceAuthorization({});
        expect(r.kind).toBe("error");
        expect(r.status).toBe(429);
    });

    it("pollToken -> pending", async () => {
        const fetchImpl = mockFetch([{ status: 400, body: { error: "authorization_pending" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.pollToken("dc_v1_x");
        expect(r.kind).toBe("pending");
    });

    it("pollToken -> slow_down", async () => {
        const fetchImpl = mockFetch([{ status: 400, body: { error: "slow_down" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.pollToken("dc_v1_x");
        expect(r.kind).toBe("slow_down");
    });

    it("pollToken -> denied", async () => {
        const fetchImpl = mockFetch([{ status: 400, body: { error: "access_denied" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.pollToken("dc_v1_x");
        expect(r.kind).toBe("denied");
    });

    it("pollToken -> expired", async () => {
        const fetchImpl = mockFetch([{ status: 400, body: { error: "expired_token" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.pollToken("dc_v1_x");
        expect(r.kind).toBe("expired");
    });

    it("pollToken -> ok with grant type in request", async () => {
        const fetchImpl = mockFetch([{
            status: 200,
            body: {
                access_token: "dt_v1_x",
                token_type:   "Bearer",
                expires_in:   31536000,
                edge_id:      "e-1",
                home_id:      "DE-DEMO"
            }
        }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.pollToken("dc_v1_x");
        expect(r.kind).toBe("ok");
        expect(r.data.access_token).toBe("dt_v1_x");
        expect(r.data.edge_id).toBe("e-1");
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.grant_type).toBe(DEVICE_CODE_GRANT);
        expect(body.device_code).toBe("dc_v1_x");
    });

    it("postTelemetry sets Authorization header and returns cbox_updated", async () => {
        const fetchImpl = mockFetch([{
            status: 200,
            body: { poll_after_s: 60, cbox_version: "v1", cbox_updated: false }
        }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.postTelemetry("dt_v1_x", { kind: "full" });
        expect(r.kind).toBe("ok");
        expect(r.data.poll_after_s).toBe(60);
        const headers = fetchImpl.mock.calls[0][1].headers;
        expect(headers.Authorization).toBe("Bearer dt_v1_x");
    });

    it("postTelemetry -> unauthorized on 401", async () => {
        const fetchImpl = mockFetch([{ status: 401, body: { error: "invalid_token" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.postTelemetry("dt_v1_x", {});
        expect(r.kind).toBe("unauthorized");
    });

    it("postTelemetry -> gone on 410", async () => {
        const fetchImpl = mockFetch([{ status: 410, body: { error: "revoked" } }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.postTelemetry("dt_v1_x", {});
        expect(r.kind).toBe("gone");
    });

    it("rotateToken -> ok returns new token", async () => {
        const fetchImpl = mockFetch([{
            status: 200,
            body: { access_token: "dt_v1_new", expires_in: 31536000 }
        }]);
        const c = new DhcOAuthClient({ ...opts, fetchImpl });
        const r = await c.rotateToken("dt_v1_old");
        expect(r.kind).toBe("ok");
        expect(r.data.access_token).toBe("dt_v1_new");
    });
});
