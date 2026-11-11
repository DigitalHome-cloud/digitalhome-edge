// dynsec.js — the broker's access rules for a code (Mosquitto Dynamic Security).
//
// One client and one role per code. The role lets the code read its own
// subtree and write only the topics its kind and bell role need. Everything
// else is refused by the broker before it reaches Node-RED.

"use strict";

const CONTROL = "$CONTROL/dynamic-security/v1";
const RESPONSE = CONTROL + "/response";
const BASE = "dhc/panel";

function topicOf(id, leaf) { return BASE + "/" + id + "/" + leaf; }
function roleName(id) { return "panel-" + id; }

/** What a code may publish, by its bell role and kind. */
function writableLeaves(code) {
    const leaves = ["act", "status"];
    if (code.bell === "ring") leaves.push("ring");
    if (code.bell === "listen") leaves.push("answer");
    if (code.kind === "phone") leaves.push("up/#");   // a stationary phone's touches and answers
    return leaves;
}

function aclsFor(code) {
    const acls = [{ acltype: "subscribePattern", topic: topicOf(code.id, "#"), priority: 0, allow: true }];
    for (const leaf of writableLeaves(code)) {
        acls.push({ acltype: "publishClientSend", topic: topicOf(code.id, leaf), priority: 0, allow: true });
    }
    return acls;
}

function createCommands(code, secret) {
    return [
        { command: "createRole", rolename: roleName(code.id), acls: aclsFor(code) },
        { command: "createClient", username: code.id, password: secret, textname: code.name, roles: [{ rolename: roleName(code.id), priority: 0 }] },
    ];
}

/** Bring an existing code's rules up to date (after an upgrade of this file). */
function refreshCommands(code) {
    return [{ command: "modifyRole", rolename: roleName(code.id), acls: aclsFor(code) }];
}

/** Deleting the client also closes its connection. */
function deleteCommands(id) {
    return [
        { command: "deleteClient", username: id },
        { command: "deleteRole", rolename: roleName(id) },
    ];
}

/** Node-RED itself: the admin role may read everything; add writing to dhc/#. */
function selfCommands() {
    return [{ command: "addRoleACL", rolename: "admin", acltype: "publishClientSend", topic: "dhc/#", priority: 0, allow: true }];
}

module.exports = { CONTROL, RESPONSE, BASE, topicOf, roleName, aclsFor, createCommands, refreshCommands, deleteCommands, selfCommands, writableLeaves };
