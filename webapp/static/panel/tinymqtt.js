// tinymqtt.js — a small MQTT 3.1.1 client over WebSocket for the panel page.
//
// Only what a panel needs: connect with a name, a password and a last will,
// subscribe, publish and receive at QoS 0, keep alive, and come back by itself
// when the link drops. Plain ES2017, no libraries, so an old phone runs it.
//
//   var link = tinymqtt({ url, username, password, will: { topic, payload, retain },
//                         onUp: function () {}, onDown: function (why) {}, onMessage: function (topic, text, retained, bytes) {} });
//   link.subscribe("a/#"); link.publish("a/b", "text", true); link.close();
//
// A topic ending in /frame is a picture: `text` is null and `bytes` (a Uint8Array) carries it.
// onDown gets "refused" when the broker turned the name and password down:
// the link then stays down (a revoked code must not keep knocking).
'use strict';

function tinymqtt(o) {
  var enc = new TextEncoder(), dec = new TextDecoder();
  var ws = null, up = false, closed = false, wait = 1000, ping = 0, buf = new Uint8Array(0), packetId = 1, subs = [];
  var keepalive = o.keepalive || 30;

  function str(s) { var b = enc.encode(s), out = new Uint8Array(b.length + 2); out[0] = b.length >> 8; out[1] = b.length & 255; out.set(b, 2); return out; }
  function join(parts) {
    var n = 0, i, at = 0; for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n); for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }
  function packet(first, parts) {
    var body = join(parts), len = body.length, head = [first];
    do { var d = len % 128; len = Math.floor(len / 128); head.push(len > 0 ? d | 128 : d); } while (len > 0);
    return join([new Uint8Array(head), body]);
  }
  function raw(bytes) { if (ws && ws.readyState === 1) ws.send(bytes); }

  function hello() {
    var flags = 0x02 | 0x80 | 0x40, parts = [str('MQTT'), null, str(o.clientId || ('panel-' + Math.random().toString(36).slice(2, 10)))];
    if (o.will) { flags |= 0x04 | (o.will.retain ? 0x20 : 0); parts.push(str(o.will.topic), str(o.will.payload)); }
    parts[1] = new Uint8Array([4, flags, keepalive >> 8, keepalive & 255]);
    parts.push(str(o.username), str(o.password));
    raw(packet(0x10, parts));
  }

  function take(type, flags, body) {
    if (type === 2) {                                  // CONNACK
      if (body[1] !== 0) { closed = true; ws.close(); if (o.onDown) o.onDown('refused'); return; }
      up = true; wait = 1000;
      subs.forEach(sendSub);
      clearInterval(ping); ping = setInterval(function () { raw(new Uint8Array([0xC0, 0])); }, keepalive * 500);
      if (o.onUp) o.onUp();
    } else if (type === 3) {                           // PUBLISH (QoS 0: no packet id)
      var tl = (body[0] << 8) | body[1], topic = dec.decode(body.subarray(2, 2 + tl));
      var at = 2 + tl + ((flags & 6) ? 2 : 0);
      var bytes = body.subarray(at), picture = /\/frame$/.test(topic);
      if (o.onMessage) o.onMessage(topic, picture ? null : dec.decode(bytes), !!(flags & 1), bytes);
    }
  }

  function feed(chunk) {
    buf = join([buf, new Uint8Array(chunk)]);
    for (;;) {
      if (buf.length < 2) return;
      var len = 0, mult = 1, i = 1, d;
      do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
      if (buf.length < i + len) return;
      var first = buf[0], body = buf.subarray(i, i + len);
      buf = buf.slice(i + len);
      take(first >> 4, first & 15, body);
    }
  }

  function sendSub(topic) { packetId = packetId % 65535 + 1; raw(packet(0x82, [new Uint8Array([packetId >> 8, packetId & 255]), str(topic), new Uint8Array([0])])); }

  function open() {
    if (closed) return;
    buf = new Uint8Array(0);
    try { ws = new WebSocket(o.url, 'mqtt'); } catch (e) { retry('error'); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = hello;
    ws.onmessage = function (e) { feed(e.data); };
    ws.onclose = function () { retry('lost'); };
  }
  function retry(why) {
    clearInterval(ping);
    var was = up; up = false;
    if (closed) return;
    if ((was || why === 'error') && o.onDown) o.onDown(why);
    setTimeout(open, wait); wait = Math.min(wait * 2, 15000);
  }

  open();
  return {
    subscribe: function (topic) { subs.push(topic); if (up) sendSub(topic); },
    publish: function (topic, text, retain) { if (!up) return false; raw(packet(0x30 | (retain ? 1 : 0), [str(topic), enc.encode(text || '')])); return true; },
    isUp: function () { return up; },
    // no DISCONNECT packet: the broker then publishes the last will, so the edge sees the phone go
    close: function () { closed = true; clearInterval(ping); if (ws) ws.close(); }
  };
}

if (typeof module !== 'undefined') module.exports = tinymqtt;
