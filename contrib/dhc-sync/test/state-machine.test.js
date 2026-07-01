import { describe, it, expect } from "vitest";
import { DhcSyncStateMachine, STATES } from "../lib/state-machine.js";

describe("DhcSyncStateMachine", () => {
    it("starts in BOOT by default", () => {
        const fsm = new DhcSyncStateMachine();
        expect(fsm.state).toBe(STATES.BOOT);
    });

    it("allows BOOT -> UNLINKED and emits transition", () => {
        const fsm = new DhcSyncStateMachine();
        const events = [];
        fsm.on("transition", (e) => events.push(e));

        fsm.to(STATES.UNLINKED);

        expect(fsm.state).toBe(STATES.UNLINKED);
        expect(events).toHaveLength(1);
        expect(events[0].from).toBe(STATES.BOOT);
        expect(events[0].to).toBe(STATES.UNLINKED);
    });

    it("rejects illegal transitions", () => {
        const fsm = new DhcSyncStateMachine();
        // BOOT -> AWAITING_APPROVAL is not in the table
        expect(() => fsm.to(STATES.AWAITING_APPROVAL)).toThrow(/illegal transition/);
        expect(fsm.state).toBe(STATES.BOOT);
    });

    it("supports the happy path BOOT -> UNLINKED -> AWAITING_APPROVAL -> LINKED", () => {
        const fsm = new DhcSyncStateMachine();
        fsm.to(STATES.UNLINKED);
        fsm.to(STATES.AWAITING_APPROVAL, {
            user_code: "ABCD-1234",
            device_code: "dc_v1_x",
            verification_uri: "https://portal.example/link"
        });
        expect(fsm.context.user_code).toBe("ABCD-1234");
        fsm.to(STATES.LINKED, { edge_id: "e-1", home_id: "DE-DEMO" });
        expect(fsm.state).toBe(STATES.LINKED);
        expect(fsm.context.edge_id).toBe("e-1");
        // Earlier ctx isn't wiped
        expect(fsm.context.user_code).toBe("ABCD-1234");
    });

    it("patchContext emits without a state change", () => {
        const fsm = new DhcSyncStateMachine();
        fsm.to(STATES.UNLINKED);
        const events = [];
        fsm.on("contextPatch", (e) => events.push(e));
        fsm.patchContext({ error: "network timeout" });
        expect(events).toHaveLength(1);
        expect(events[0].context.error).toBe("network timeout");
        expect(fsm.state).toBe(STATES.UNLINKED);
    });

    it("recovers via ERROR -> UNLINKED", () => {
        const fsm = new DhcSyncStateMachine();
        fsm.to(STATES.UNLINKED);
        fsm.to(STATES.ERROR, { error: "cloud unreachable" });
        expect(fsm.state).toBe(STATES.ERROR);
        fsm.to(STATES.UNLINKED);
        expect(fsm.state).toBe(STATES.UNLINKED);
    });
});
