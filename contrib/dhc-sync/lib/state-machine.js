// state-machine.js
//
// Small transition-checked FSM for the dhc-sync client. Owned by the
// dhc-sync-config node; subscribed by dhc-sync-status nodes and dashboard
// templates.
//
// Real work (network calls, secret persistence) happens in follow-up modules;
// this file only tracks state + emits transitions.

"use strict";

const { EventEmitter } = require("events");

const STATES = Object.freeze({
    BOOT:               "boot",
    UNLINKED:           "unlinked",
    AWAITING_APPROVAL:  "awaiting_approval",
    LINKED:             "linked",
    DENIED:             "denied",
    ERROR:              "error"
});

// Legal transitions. Reject anything else — silent state corruption is worse
// than a loud throw in dev, and this FSM is small enough that the table
// stays maintainable.
const TRANSITIONS = Object.freeze({
    [STATES.BOOT]:              [STATES.UNLINKED, STATES.LINKED, STATES.ERROR],
    [STATES.UNLINKED]:          [STATES.AWAITING_APPROVAL, STATES.ERROR],
    [STATES.AWAITING_APPROVAL]: [STATES.LINKED, STATES.DENIED, STATES.UNLINKED, STATES.ERROR],
    [STATES.LINKED]:            [STATES.UNLINKED, STATES.ERROR],
    [STATES.DENIED]:            [STATES.UNLINKED, STATES.ERROR],
    [STATES.ERROR]:             [STATES.UNLINKED, STATES.BOOT]
});

class DhcSyncStateMachine extends EventEmitter {
    constructor(initial = STATES.BOOT) {
        super();
        this._state = initial;
        this._context = {
            edge_id:                   null,
            home_id:                   null,
            user_code:                 null,
            device_code:               null,
            verification_uri:          null,
            verification_uri_complete: null,
            expires_at:                null,
            error:                     null,
            token_expires_at:          null,
            last_telemetry_at:         null
        };
    }

    static get STATES() { return STATES; }

    get state()   { return this._state; }
    get context() { return { ...this._context }; }

    /**
     * Transition to a new state with optional context updates.
     * Throws if the transition isn't in the TRANSITIONS table.
     */
    to(newState, ctxPatch = {}) {
        const allowed = TRANSITIONS[this._state] || [];
        if (!allowed.includes(newState)) {
            throw new Error(
                `dhc-sync: illegal transition ${this._state} -> ${newState}`
            );
        }
        const oldState = this._state;
        this._state = newState;
        this._context = { ...this._context, ...ctxPatch };
        this.emit("transition", {
            from: oldState,
            to:   newState,
            context: this.context
        });
    }

    /**
     * Update context without a state change.
     */
    patchContext(ctxPatch) {
        this._context = { ...this._context, ...ctxPatch };
        this.emit("contextPatch", { context: this.context });
    }
}

module.exports = { DhcSyncStateMachine, STATES };
