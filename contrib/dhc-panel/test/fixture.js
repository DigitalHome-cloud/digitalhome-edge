// An invented home in the twin's shape (no real names): two floors, Homematic and Hue.
"use strict";

const point = (id, cap, ref, dev) => ({ "@id": id, "@type": "brick:Point", "dhc:capability": "dhc:capability/" + cap, "dhc:sourceRef": ref, "brick:isPointOf": dev });

function ccuDevice(name, type, room, refs) {
    const dev = "urn:dhe:device:ccu:" + name.replace(/[^A-Za-z0-9]+/g, "_");
    const pts = refs.map(([ch, dp, cap]) => point("urn:dhe:point:ccu:" + name + ":" + ch + ":" + dp, cap, "ccu:" + name + ":" + ch + "/" + dp, dev));
    return [{ "@id": dev, "@type": "brick:Equipment", "rec:label": name, "dhc:deviceType": type, "dhc:source": "ccu", "dhc:sourceRef": "ccu:" + name, "rec:isLocatedIn": room, "brick:hasPoint": pts.map((p) => p["@id"]) }, ...pts];
}

function hueLight(uid, label, room, caps) {
    const dev = "urn:dhe:device:hue:" + uid;
    const pts = caps.map((c) => point("urn:dhe:point:hue:" + uid + ":" + c, c, "hue:" + uid + "/" + c, dev));
    return [{ "@id": dev, "@type": "brick:Luminaire", "rec:label": label, "dhc:source": "hue", "dhc:sourceRef": "hue:" + uid, "rec:isLocatedIn": room, "brick:hasPoint": pts.map((p) => p["@id"]) }, ...pts];
}

const KITCHEN = "urn:dhe:room:ccu:101", BEDROOM = "urn:dhe:room:ccu:201", LOUNGE = "urn:dhe:room:hue:g1";

const graph = [
    { "@id": "urn:dhe:home:test", "@type": "rec:Building" },
    { "@id": KITCHEN, "@type": "rec:Room", "rec:label": "0.Kitchen", "dhc:floor": 0 },
    { "@id": BEDROOM, "@type": "rec:Room", "rec:label": "1.Bedroom", "dhc:floor": 1 },
    { "@id": LOUNGE, "@type": "rec:Room", "rec:label": "Lounge" },
    ...ccuDevice("HM-LC-Sw2-FM Kitchen ceiling", "HM-LC-Sw2-FM", KITCHEN, [["1", "STATE", "on"], ["2", "STATE", "on"]]),
    ...ccuDevice("HmIP-BSM Kitchen counter", "HmIP-BSM", KITCHEN, [["3", "STATE", "on"], ["4", "STATE", "on"], ["5", "STATE", "on"]]),
    ...ccuDevice("HM-LC-Dim1T-CV Bedroom lamp", "HM-LC-Dim1T-CV", BEDROOM, [["1", "LEVEL", "brightness"]]),
    ...ccuDevice("HM-CC-RT-DN Bedroom heating", "HM-CC-RT-DN", BEDROOM, [["4", "SET_TEMPERATURE", "setpoint"], ["4", "ACTUAL_TEMPERATURE", "temperature"]]),
    ...ccuDevice("HM-LC-Bl1-SM Bedroom blind", "HM-LC-Bl1-SM", BEDROOM, [["1", "LEVEL", "brightness"]]),
    // never tiles: a siren, a window contact, a chime, the CCU's copy of a Hue light
    ...ccuDevice("HmIP-ASIR Hall", "HmIP-ASIR", KITCHEN, [["2", "STATE", "on"]]),
    ...ccuDevice("HM-Sec-SC-2 Window", "HM-Sec-SC-2", KITCHEN, [["1", "STATE", "on"]]),
    ...ccuDevice("HM-OU-CF-Pl Chime", "HM-OU-CF-Pl", KITCHEN, [["1", "STATE", "on"], ["2", "STATE", "on"]]),
    ...ccuDevice("VIR-LG-DIM Copy", "VIR-LG-DIM", BEDROOM, [["1", "LEVEL", "brightness"]]),
    ...hueLight("00:17:88:01:aa-0b", "Lounge lamp", LOUNGE, ["on", "brightness", "reachable"]),
    ...hueLight("00:17:88:01:bb-0b", "Lounge plug", LOUNGE, ["on", "reachable"]),
];

module.exports = { graph, cbox: { "@graph": graph } };
