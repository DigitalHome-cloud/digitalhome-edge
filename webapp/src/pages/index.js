import React, { useEffect, useState } from "react";

// Thin edge UI: poll the headless /app-api/status and render onboarding/status
// tiles. Same-origin fetch (served under /app by Node-RED httpStatic), so no
// API base URL is needed. This is intentionally minimal — the rich UX is the
// cloud Portal; the edge app only does what needs the LAN.

const API = "/app-api";
const fmt = (v) => (v === null || v === undefined ? "—" : v);

function Tile({ title, link, rows }) {
  const linked = link && link.state === "linked";
  return (
    <div className="card">
      <h2>
        {title}
        <span className={"badge" + (linked ? " ok" : "")}>
          {linked ? "connected" : (link && link.state) || "unlinked"}
        </span>
      </h2>
      {rows.map(([k, v]) => (
        <div className="kv" key={k}>
          <span className="k">{k}</span>
          <span className="v">{fmt(v)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [s, setS] = useState(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/status`, { cache: "no-store" });
        const j = await r.json();
        if (!stop) { setS(j); setLive(true); }
      } catch {
        if (!stop) setLive(false);
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const solar = (s && s.solar) || {};
  const ccu = (s && s.ccu) || {};
  const hue = (s && s.hue) || {};
  const pl = (s && s.pipeline) || {};
  const sd = (solar.latest && solar.latest.data) || {};

  return (
    <>
      <header>
        <span className={"dot" + (live ? " live" : "")} />
        <h1>digitalhome.edge</h1>
        <span className="badge">
          {s ? "updated " + new Date(s.ts).toLocaleTimeString() : "connecting…"}
        </span>
      </header>
      <main>
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
      </main>
      <footer>
        Served statically by Node-RED · <a href="/ui">Node-RED dashboard</a>
      </footer>
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
  main{max-width:960px;margin:0 auto;padding:24px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  .card h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .badge{font-size:12px;padding:2px 8px;border-radius:999px;background:rgba(100,116,139,.25);color:var(--muted)}
  .badge.ok{background:rgba(34,197,94,.15);color:var(--ok)}
  .kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.12)}
  .kv:last-child{border:0}.kv .k{color:var(--muted)}.kv .v{font-variant-numeric:tabular-nums}
  footer{text-align:center;color:var(--muted);font-size:12px;padding:18px}
  a{color:var(--accent)}
`;

export const Head = () => <title>digitalhome.edge</title>;
