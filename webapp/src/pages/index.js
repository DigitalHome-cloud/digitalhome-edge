import React, { useEffect, useRef, useState } from "react";

// Native LAN edge UI (no cloud): Gatsby/React shell, live over WebSocket,
// onboarding + LAN discovery via /app-api/*. Header toggles to the Node-RED /ui.

const fmt = (v) => (v === null || v === undefined ? "—" : v);
const api = (path, body, method = "POST") =>
  fetch(`/app-api/${path}`, method === "GET" ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

function useEdgeStream() {
  const [data, setData] = useState(null);
  const [live, setLive] = useState(false);
  const pollRef = useRef(null);
  useEffect(() => {
    let closed = false;
    const startPoll = () => { if (pollRef.current) return; const p = async () => { try { setData(await (await fetch("/app-api/status", { cache: "no-store" })).json()); } catch { setLive(false); } }; p(); pollRef.current = setInterval(p, 3000); };
    const stopPoll = () => { clearInterval(pollRef.current); pollRef.current = null; };
    const connect = () => { try { const proto = window.location.protocol === "https:" ? "wss" : "ws"; const ws = new WebSocket(`${proto}://${window.location.host}/app-api/ws`);
      ws.onmessage = (e) => { stopPoll(); setLive(true); try { setData(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => { setLive(false); startPoll(); if (!closed) setTimeout(connect, 5000); };
      ws.onerror = () => ws.close(); } catch { startPoll(); } };
    connect(); startPoll();
    return () => { closed = true; stopPoll(); };
  }, []);
  return { data, live };
}

function Tile({ title, link, rows }) {
  const on = link && link.state === "linked";
  return (<div className="card"><h2>{title}<span className={"badge" + (on ? " ok" : "")}>{on ? "connected" : (link && link.state) || "—"}</span></h2>
    {rows.map(([k, v]) => (<div className="kv" key={k}><span className="k">{k}</span><span className="v">{fmt(v)}</span></div>))}</div>);
}
const Msg = ({ m }) => <div className={"msg " + ((m && m.cls) || "")}>{m ? m.text : ""}</div>;
function Onboard({ source, link, children, onConnect, connectLabel }) {
  const on = link && link.state === "linked";
  return (<div className="card"><h2>{{ solar: "Solar (Solarman)", ccu: "Homematic CCU", hue: "Philips Hue" }[source]}
    <span className={"badge" + (on ? " ok" : "")}>{on ? "connected" : (link && link.state) || "—"}</span></h2>
    {children}<button onClick={onConnect}>{connectLabel || "Connect"}</button></div>);
}

const roleColor = { gateway: "#f59e0b", integration: "#22c55e", network: "#38bdf8", device: "#64748b" };
function NetworkMap() {
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setScan(await api("lan-scan", {})); } catch { setScan({ error: "scan failed" }); } setBusy(false); };
  const groups = [["gateway", "Gateway"], ["integration", "Integrations"], ["network", "Network / powerline (devolo)"], ["device", "Other devices"]];
  const devs = (scan && scan.devices) || [];
  return (
    <>
      <div className="section-title">LAN discovery
        <button className="ghost" style={{ marginLeft: 12 }} onClick={run} disabled={busy}>{busy ? "scanning…" : "Scan LAN"}</button>
        {scan && !scan.error && <span className="src" style={{ marginLeft: 10 }}>{scan.count} devices on {scan.subnet}</span>}
      </div>
      {scan && scan.error && <div className="card"><Msg m={{ text: "✗ " + scan.error, cls: "err" }} /></div>}
      {scan && !scan.error && (
        <div className="net">
          {groups.map(([role, label]) => {
            const rows = devs.filter((d) => d.role === role);
            if (!rows.length) return null;
            return (
              <div className="net-group" key={role}>
                <div className="net-h" style={{ color: roleColor[role] }}>{label}</div>
                {rows.map((d) => (
                  <div className="net-row" key={d.ip}>
                    <span className="dot2" style={{ background: roleColor[d.role] }} />
                    <span className="ip">{d.ip}</span>
                    <span className="ty">{d.type}{d.hostname && d.hostname !== "blocked.local" ? " · " + d.hostname : ""}</span>
                    <span className="mac">{d.mac}</span>
                    <span className="ports">{(d.ports || []).join(" ") || "—"}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {!scan && <div className="card" style={{ color: "var(--muted)" }}>Crawls the /24, reads ARP for MACs, identifies vendors (Raspberry Pi=CCU, Signify=Hue, devolo, AVM…), reverse-DNS, ports, and role.</div>}
    </>
  );
}

export default function Home() {
  const { data: s, live } = useEdgeStream();
  const [f, setF] = useState({ solarEmail: "", solarPass: "", ccuIp: "", ccuToken: "", hueIp: "" });
  const [msg, setMsg] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const say = (src, text, cls) => setMsg((m) => ({ ...m, [src]: { text, cls } }));
  const scan = async (source) => { say(source, "scanning…", "busy"); try { const j = await api("scan", { source });
    if (j.candidates && j.candidates.length) { setF((x) => ({ ...x, [source + "Ip"]: j.candidates[0].ip })); say(source, "found: " + j.candidates.map((c) => c.ip).join(", "), "ok"); }
    else say(source, `no ${source.toUpperCase()} found on ${j.subnet || "?"}.0/24`, "err"); } catch { say(source, "scan failed", "err"); } };
  const connect = async (source) => { let body = { source };
    if (source === "ccu") body = { source, ip: f.ccuIp.trim(), token: f.ccuToken.trim() };
    else if (source === "hue") { body = { source, ip: f.hueIp.trim() }; say("hue", "pairing… press the bridge button now (up to 30s)", "busy"); }
    else if (source === "solar") body = { source, email: f.solarEmail.trim(), password: f.solarPass };
    if (source !== "hue") say(source, "connecting…", "busy");
    try { const j = await api("connect", body); say(source, (j.ok ? "✓ " : "✗ ") + (j.message || (j.ok ? "connected" : "failed")), j.ok ? "ok" : "err"); if (source === "solar") setF((x) => ({ ...x, solarPass: "" })); } catch { say(source, "request failed", "err"); } };

  const solar = (s && s.solar) || {}, ccu = (s && s.ccu) || {}, hue = (s && s.hue) || {}, pl = (s && s.pipeline) || {};
  const sd = (solar.latest && solar.latest.data) || {};
  return (
    <>
      <header>
        <span className={"dot" + (live ? " live" : "")} />
        <h1>digitalhome.edge</h1>
        <span className="badge">{s ? "updated " + new Date(s.ts).toLocaleTimeString() : "connecting…"}</span>
        <span className="src">{live ? "live · websocket" : "polling"}</span>
        <a className="toggle" href="/ui">Node-RED dashboard →</a>
      </header>
      <main>
        <div className="grid">
          <Tile title="Solar" link={solar.link} rows={[["Account", solar.link && solar.link.email], ["PV power", sd.generationPower != null ? sd.generationPower + " W" : "—"], ["Load", sd.usePower != null ? sd.usePower + " W" : "—"], ["Battery", sd.batterySoc != null ? sd.batterySoc + " %" : "—"]]} />
          <Tile title="CCU" link={ccu.link} rows={[["IP", ccu.link && ccu.link.ip], ["Devices", ccu.latest && ccu.latest.devices], ["Datapoints", ccu.latest && ccu.latest.datapoints]]} />
          <Tile title="Hue" link={hue.link} rows={[["IP", hue.link && hue.link.ip], ["Sensors", hue.latest && hue.latest.sensors], ["Lights", hue.latest && hue.latest.lights]]} />
          <Tile title="Pipeline" link={{ state: pl.recent_mapped ? "linked" : "idle" }} rows={[["Sources", (pl.sources || []).join(", ") || "—"], ["Mappings", pl.counts ? pl.counts.sourceMap + " fields" : "—"], ["Recent obs", pl.recent_mapped]]} />
        </div>

        <div className="section-title">Onboarding</div>
        <div className="grid">
          <Onboard source="solar" link={solar.link} onConnect={() => connect("solar")}>
            <input placeholder="Solarman email" value={f.solarEmail} onChange={set("solarEmail")} />
            <input type="password" placeholder="Solarman password" value={f.solarPass} onChange={set("solarPass")} /><Msg m={msg.solar} />
          </Onboard>
          <Onboard source="ccu" link={ccu.link} onConnect={() => connect("ccu")}>
            <button className="ghost" onClick={() => scan("ccu")}>Scan network</button>
            <input placeholder="CCU IP" value={f.ccuIp} onChange={set("ccuIp")} />
            <input placeholder="API token (recommended)" value={f.ccuToken} onChange={set("ccuToken")} /><Msg m={msg.ccu} />
          </Onboard>
          <Onboard source="hue" link={hue.link} onConnect={() => connect("hue")} connectLabel="Connect (press bridge button)">
            <button className="ghost" onClick={() => scan("hue")}>Scan network</button>
            <input placeholder="Hue bridge IP" value={f.hueIp} onChange={set("hueIp")} /><Msg m={msg.hue} />
          </Onboard>
        </div>

        <NetworkMap />
      </main>
      <footer>digitalhome.edge · LAN-only · React shell + /app-api backend</footer>
      <style>{css}</style>
    </>
  );
}

const css = `
  :root{--bg:#0f172a;--card:#1e293b;--line:rgba(148,163,184,.25);--fg:#e2e8f0;--muted:#94a3b8;--ok:#22c55e;--off:#64748b;--accent:#38bdf8;--err:#ef4444}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
  header h1{font-size:18px;margin:0;font-weight:600}
  .toggle{margin-left:auto;font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--line);padding:6px 12px;border-radius:8px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--off)} .dot.live{background:var(--ok);box-shadow:0 0 8px var(--ok)} .src{font-size:11px;color:var(--muted)}
  main{max-width:1000px;margin:0 auto;padding:24px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  .card h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .badge{font-size:12px;padding:2px 8px;border-radius:999px;background:rgba(100,116,139,.25);color:var(--muted)} .badge.ok{background:rgba(34,197,94,.15);color:var(--ok)}
  .kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.12)} .kv:last-child{border:0} .kv .k{color:var(--muted)} .kv .v{font-variant-numeric:tabular-nums}
  .section-title{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.05em;margin:28px 4px 12px;display:flex;align-items:center}
  input{width:100%;margin:6px 0;padding:9px 11px;background:#0b1324;border:1px solid var(--line);border-radius:8px;color:var(--fg);font-size:14px}
  button{padding:9px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer;margin:4px 6px 4px 0} button.ghost{background:#334155} button:disabled{opacity:.5}
  .msg{font-size:13px;margin-top:8px;min-height:18px} .msg.ok{color:var(--ok)} .msg.err{color:var(--err)} .msg.busy{color:var(--accent)}
  .net{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 16px}
  .net-group{padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)} .net-group:last-child{border:0}
  .net-h{font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:4px 0 8px}
  .net-row{display:grid;grid-template-columns:14px 110px 1fr 150px 90px;gap:10px;align-items:center;padding:4px 0;font-size:13px}
  .dot2{width:9px;height:9px;border-radius:50%} .net-row .ip{font-variant-numeric:tabular-nums} .net-row .ty{color:var(--fg)} .net-row .mac{color:var(--muted);font-family:ui-monospace,monospace;font-size:12px} .net-row .ports{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
  footer{text-align:center;color:var(--muted);font-size:12px;padding:18px} a{color:var(--accent)}
`;

export const Head = () => <title>digitalhome.edge</title>;
