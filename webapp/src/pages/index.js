import React, { useEffect, useRef, useState } from "react";

// Hybrid edge UI:
//  • Gatsby/React static shell + design (this file)
//  • live data via a React hook over WebSocket push (/app-api/ws), polling fallback
//  • interactive onboarding reused from the Node-RED Dashboard via <iframe> (/ui)
// The rich UX is the cloud Portal; this stays minimal.

const fmt = (v) => (v === null || v === undefined ? "—" : v);

// ── the live hook: subscribes to the edge's WebSocket, falls back to polling ──
function useEdgeStream() {
  const [data, setData] = useState(null);
  const [live, setLive] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    let closed = false;
    const startPoll = () => {
      if (pollRef.current) return;
      const p = async () => {
        try {
          const r = await fetch("/app-api/status", { cache: "no-store" });
          setData(await r.json());
        } catch {
          setLive(false);
        }
      };
      p();
      pollRef.current = setInterval(p, 3000);
    };
    const stopPoll = () => { clearInterval(pollRef.current); pollRef.current = null; };

    const connect = () => {
      try {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${window.location.host}/app-api/ws`);
        ws.onmessage = (e) => { stopPoll(); setLive(true); try { setData(JSON.parse(e.data)); } catch {} };
        ws.onclose = () => { setLive(false); startPoll(); if (!closed) setTimeout(connect, 5000); };
        ws.onerror = () => ws.close();
      } catch { startPoll(); }
    };
    connect();
    startPoll(); // until the first ws frame

    return () => { closed = true; stopPoll(); };
  }, []);

  return { data, live };
}

function Tile({ title, link, rows }) {
  const linked = link && link.state === "linked";
  return (
    <div className="card">
      <h2>{title}
        <span className={"badge" + (linked ? " ok" : "")}>
          {linked ? "connected" : (link && link.state) || "unlinked"}
        </span>
      </h2>
      {rows.map(([k, v]) => (
        <div className="kv" key={k}><span className="k">{k}</span><span className="v">{fmt(v)}</span></div>
      ))}
    </div>
  );
}

export default function Home() {
  const { data: s, live } = useEdgeStream();
  const solar = (s && s.solar) || {}, ccu = (s && s.ccu) || {}, hue = (s && s.hue) || {}, pl = (s && s.pipeline) || {};
  const sd = (solar.latest && solar.latest.data) || {};

  return (
    <>
      <header>
        <span className={"dot" + (live ? " live" : "")} />
        <h1>digitalhome.edge</h1>
        <span className="badge">{s ? "updated " + new Date(s.ts).toLocaleTimeString() : "connecting…"}</span>
        <span className="src">{live ? "live · websocket" : "polling"}</span>
      </header>
      <main>
        <div className="grid">
          <Tile title="Solar (Solarman)" link={solar.link} rows={[
            ["Account", solar.link && solar.link.email],
            ["PV power", sd.generationPower != null ? sd.generationPower + " W" : "—"],
            ["House load", sd.usePower != null ? sd.usePower + " W" : "—"],
            ["Battery SOC", sd.batterySoc != null ? sd.batterySoc + " %" : "—"],
            ["Today", sd.generationValue != null ? sd.generationValue + " kWh" : "—"],
          ]} />
          <Tile title="Homematic CCU" link={ccu.link} rows={[
            ["IP", ccu.link && ccu.link.ip],
            ["Devices", ccu.latest && ccu.latest.devices],
            ["Datapoints", ccu.latest && ccu.latest.datapoints],
          ]} />
          <Tile title="Philips Hue" link={hue.link} rows={[
            ["IP", hue.link && hue.link.ip],
            ["Sensors", hue.latest && hue.latest.sensors],
            ["Lights", hue.latest && hue.latest.lights],
          ]} />
          <Tile title="Pipeline" link={{ state: pl.recent_mapped ? "linked" : "idle" }} rows={[
            ["Sources", (pl.sources || []).join(", ") || "—"],
            ["Mappings", pl.counts ? pl.counts.sourceMap + " fields" : "—"],
            ["Recent obs", pl.recent_mapped],
          ]} />
        </div>

        <div className="section-title">Onboarding &amp; controls (Node-RED Dashboard, embedded)</div>
        <iframe src="/ui/pairing" title="Node-RED controls" loading="lazy" />
      </main>
      <footer>Live over WebSocket · React shell + embedded Node-RED controls = hybrid</footer>
      <style>{css}</style>
    </>
  );
}

const css = `
  :root{--bg:#0f172a;--card:#1e293b;--line:rgba(148,163,184,.25);--fg:#e2e8f0;--muted:#94a3b8;--ok:#22c55e;--off:#64748b;--accent:#38bdf8}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
  header h1{font-size:18px;margin:0;font-weight:600}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--off)}
  .dot.live{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  .src{font-size:11px;color:var(--muted)}
  main{max-width:1040px;margin:0 auto;padding:24px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  .card h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .badge{font-size:12px;padding:2px 8px;border-radius:999px;background:rgba(100,116,139,.25);color:var(--muted)}
  .badge.ok{background:rgba(34,197,94,.15);color:var(--ok)}
  .kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.12)}
  .kv:last-child{border:0}.kv .k{color:var(--muted)}.kv .v{font-variant-numeric:tabular-nums}
  .section-title{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.05em;margin:28px 4px 12px}
  iframe{width:100%;height:560px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
  footer{text-align:center;color:var(--muted);font-size:12px;padding:18px}
  a{color:var(--accent)}
`;

export const Head = () => <title>digitalhome.edge</title>;
