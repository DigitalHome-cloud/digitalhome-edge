import React, { useEffect, useState } from "react";

// Scan and control: make, print and revoke the QR codes that let a phone show
// and switch a part of the house (docs/specs/panel-scan-and-control.md).
// Talks to /api/panel/codes, which is behind the edge's password: the browser
// asks for it once (user dhcedge; `sudo dhcedge show-secrets`).
//
// A code's secret exists only in its QR code: the edge does not keep it. So a
// code is shown here once, right after it is made. Lost? Revoke it, make a new one.

// The twin cannot tell a lamp on a Homematic switch from a socket: those are "switches".
const KIND_LABEL = { light: "Lights (Hue, dimmers)", switch: "Switches and sockets", blind: "Blinds", heating: "Heating" };
const BELL_LABEL = { none: "no bell", listen: "rings with the door bell", ring: "is the door bell" };

async function call(method, path, body) {
  const r = await fetch("/api/panel/" + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (r.status === 401) throw new Error("password needed (user dhcedge)");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "request failed (" + r.status + ")");
  return j;
}

const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function Qr({ text }) {
  const [src, setSrc] = useState("");
  useEffect(() => { let on = true; import("qrcode").then((m) => (m.default || m).toDataURL(text, { margin: 1, width: 480, errorCorrectionLevel: "M" })).then((u) => on && setSrc(u), () => {}); return () => { on = false; }; }, [text]);
  return src ? <img className="qr" src={src} alt="QR code" /> : <div className="qr" />;
}

export default function Codes() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [made, setMade] = useState([]);   // codes made in this visit: the only moment their QR exists
  const [base, setBase] = useState("");
  const [bell, setBell] = useState(null);   // what a ring sets off in the house, and what could
  const [bellMsg, setBellMsg] = useState("");
  const [f, setF] = useState({ name: "", floors: [], rooms: [], kinds: [], bell: "none", lang: "en" });

  const load = () => call("GET", "codes").then((j) => { setData(j); setErr(""); return call("GET", "bell").then(setBell); }).catch((e) => setErr(e.message));
  const pickBell = (kind, id) => { const next = { ...bell.bell, [kind]: toggle(bell.bell[kind], id) }; setBell({ ...bell, bell: next }); call("PUT", "bell", next).then(setBell, (e) => setErr(e.message)); };
  const testBell = () => call("POST", "bell/test").then((j) => setBellMsg(j.targets ? `sent to ${j.targets}` : "nothing ticked"), (e) => setBellMsg(e.message));
  useEffect(() => { setBase(window.location.origin); }, []);
  // Opened on the edge itself (localhost): the phones need its address on the home network instead.
  useEffect(() => {
    const lan = data && data.lan && data.lan[0];
    if (!lan || !/\/\/(localhost|127\.|\[::1\])/.test(window.location.origin)) return;
    setBase((b) => (/\/\/(localhost|127\.|\[::1\])/.test(b) ? `http://${lan}${window.location.port ? ":" + window.location.port : ""}` : b));
  }, [data && data.lan && data.lan[0]]);
  useEffect(() => { if (!data) return undefined; const t = setInterval(load, 5000); return () => clearInterval(t); }, [!!data]);

  const make = async () => {
    try {
      const j = await call("POST", "codes", { name: f.name, bell: f.bell, lang: f.lang, scope: { floors: f.floors, rooms: f.rooms, kinds: f.kinds } });
      setMade((m) => [{ ...j.code, secret: j.secret, port: j.ws_port }, ...m]);
      setF({ ...f, name: "" }); setErr(""); load();
    } catch (e) { setErr(e.message); }
  };
  const revoke = async (c) => {
    if (!window.confirm(`Revoke "${c.name}"? Every phone and printed card with this code stops working.`)) return;
    try { await call("DELETE", "codes/" + c.id); setMade((m) => m.filter((x) => x.id !== c.id)); load(); } catch (e) { setErr(e.message); }
  };
  const link = (c) => `${base.replace(/\/+$/, "")}/app/panel/#c=${c.id}.${c.secret}${c.port && c.port !== 9001 ? "&p=" + c.port : ""}`;
  const local = /\/\/(localhost|127\.|\[::1\])/.test(base);

  if (!data) return (<>
    <div className="section-title">Scan and control
      <button className="ghost" style={{ marginLeft: 12 }} onClick={load}>Manage codes</button>
    </div>
    <div className="card"><div style={{ color: "var(--muted)", fontSize: 13 }}>QR codes that open only the functions of a floor, a room or a function on any phone on the home network. Asks for the edge's password.</div>
      {err && <div className="msg err">✗ {err}</div>}</div>
  </>);

  const cat = data.catalog, where = (c) => {
    const s = c.scope || {}; if (s.none) return "bell only";
    const parts = [...(s.floors || []).map((n) => "floor " + n), ...(s.rooms || []).map((id) => (cat.rooms.find((r) => r.id === id) || {}).label || "?")];
    return (parts.join(", ") || "whole house") + ((s.kinds || []).length ? " · " + s.kinds.map((k) => KIND_LABEL[k]).join(", ") : "");
  };
  return (<>
    <div className="section-title">Scan and control
      <span className={"badge" + (data.broker.connected ? " ok" : "")} style={{ marginLeft: 12 }}>{data.broker.connected ? "broker connected" : "no broker"}</span>
      <span className="src" style={{ marginLeft: 10 }}>{cat.tiles} tiles in the twin</span>
    </div>
    {err && <div className="card"><div className="msg err">✗ {err}</div></div>}
    {cat.tiles === 0 && <div className="card"><div className="msg err">The digital twin has nothing to switch yet: connect the CCU or Hue, update their config and generate the C-BOX above.</div></div>}

    <div className="card codes-form">
      <h2>New code</h2>
      <input placeholder="Name on the card, e.g. Ground floor lights" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} />
      {f.bell !== "ring" && (<>
        <div className="pick"><span className="k">Floors</span>{cat.floors.map((n) => (<label key={n}><input type="checkbox" checked={f.floors.includes(n)} onChange={() => setF({ ...f, floors: toggle(f.floors, n) })} /> {n}</label>))}</div>
        <div className="pick"><span className="k">Rooms</span>{cat.rooms.map((r) => (<label key={r.id}><input type="checkbox" checked={f.rooms.includes(r.id)} onChange={() => setF({ ...f, rooms: toggle(f.rooms, r.id) })} /> {r.label}{r.source === "hue" ? " (Hue)" : ""}</label>))}</div>
        <div className="pick"><span className="k">Functions</span>{cat.kinds.map((k) => (<label key={k}><input type="checkbox" checked={f.kinds.includes(k)} onChange={() => setF({ ...f, kinds: toggle(f.kinds, k) })} /> {KIND_LABEL[k]}</label>))}</div>
        <div className="hint">Nothing ticked under floors and rooms: the whole house. Nothing under functions: all of them.</div>
      </>)}
      <div className="pick"><span className="k">Door bell</span>
        <select value={f.bell} onChange={(e) => setF({ ...f, bell: e.target.value })}>
          <option value="none">no bell</option><option value="listen">this phone rings with the door bell</option><option value="ring">this phone is the door bell (no tiles)</option>
        </select>
        <span className="k" style={{ marginLeft: 12 }}>Language</span>
        <select value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}><option value="en">English</option><option value="de">Deutsch</option><option value="fr">Français</option></select>
      </div>
      <button onClick={make} disabled={!f.name.trim() || !data.broker.connected}>Make code</button>
    </div>

    {made.length > 0 && (
      <div className="card">
        <h2>New: print or scan now <button className="ghost" style={{ marginLeft: "auto" }} onClick={() => window.print()}>Print</button></h2>
        <div className="hint">The edge does not keep a code's secret: these QR codes are gone when you leave this page.</div>
        <input value={base} onChange={(e) => setBase(e.target.value)} aria-label="Address the phones use for this edge" />
        {local && <div className="msg err">This address only works on this computer. Enter the edge's address on the home network, e.g. http://192.168.x.x:1880.</div>}
        <div className="sheet">{made.map((c) => (
          <div className="qr-card" key={c.id}><Qr text={link(c)} /><div className="qr-name">{c.name}</div><div className="qr-sub">{where(c)}{c.bell !== "none" ? " · " + BELL_LABEL[c.bell] : ""}</div></div>
        ))}</div>
      </div>
    )}

    {bell && (
      <div className="card codes-form">
        <h2>When the door bell rings <button className="ghost" style={{ marginLeft: "auto" }} onClick={testBell}>Test</button></h2>
        <div className="hint">Phones with a listening code always ring. Tick what else should announce it. {bellMsg}</div>
        <div className="pick"><span className="k">Hue blink</span>{bell.options.lights.length === 0 && <span className="hint">no Hue lights in the twin</span>}
          {bell.options.lights.map((l) => (<label key={l.id}><input type="checkbox" checked={bell.bell.lights.includes(l.id)} onChange={() => pickBell("lights", l.id)} /> {l.label}{l.room ? " (" + l.room + ")" : ""}</label>))}</div>
        <div className="pick"><span className="k">Chime</span>{bell.options.chimes.length === 0 && <span className="hint">no Homematic chime in the twin</span>}
          {bell.options.chimes.map((c) => (<label key={c.id}><input type="checkbox" checked={bell.bell.chimes.includes(c.id)} onChange={() => pickBell("chimes", c.id)} /> {c.label}</label>))}</div>
      </div>
    )}

    <div className="card">
      <h2>Codes</h2>
      {data.codes.length === 0 && <div style={{ color: "var(--muted)" }}>No codes yet.</div>}
      {data.codes.map((c) => (
        <div className="code-row" key={c.id}>
          <span className="dot2" style={{ background: c.online ? "var(--ok)" : "var(--off)" }} title={c.online ? "a phone is using it" : "not in use"} />
          <span className="nm">{c.name}</span>
          <span className="ty">{where(c)} · {c.tiles} tiles{c.bell !== "none" ? " · " + BELL_LABEL[c.bell] : ""}</span>
          <button className="ghost" onClick={() => revoke(c)}>Revoke</button>
        </div>
      ))}
    </div>
    <style>{css}</style>
  </>);
}

const css = `
  .codes-form .pick{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:8px 0;font-size:14px}
  .codes-form .pick .k{color:var(--muted);min-width:76px} .codes-form .pick label{white-space:nowrap} .codes-form .pick input{width:auto;margin:0 4px 0 0}
  main>.card+.card{margin-top:16px}
  select{padding:8px 10px;background:#0b1324;border:1px solid var(--line);border-radius:8px;color:var(--fg);font-size:14px}
  .hint{color:var(--muted);font-size:13px;margin:4px 0 8px}
  .sheet{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-top:12px}
  .qr-card{background:#fff;color:#0f172a;border-radius:12px;padding:14px;text-align:center;break-inside:avoid}
  .qr{width:100%;aspect-ratio:1;display:block} .qr-name{font-size:18px;font-weight:700;margin-top:8px;overflow-wrap:anywhere} .qr-sub{font-size:12px;color:#475569}
  .code-row{display:grid;grid-template-columns:14px minmax(120px,1fr) 2fr auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed rgba(148,163,184,.12);font-size:14px}
  .code-row:last-child{border:0} .code-row .ty{color:var(--muted);font-size:13px}
  @media (max-width:640px){.code-row{grid-template-columns:14px 1fr auto} .code-row .ty{grid-column:2 / 4;grid-row:2}}
  @media print{
    body{background:#fff} header,footer,.section-title,.card>h2,.card>.hint,.card>input,.card>.msg{display:none!important}
    main>*{display:none!important} main>.card:has(.sheet){display:block!important;border:0;background:none;padding:0}
    .sheet{grid-template-columns:repeat(3,1fr);gap:8mm} .qr-card{border:1px solid #94a3b8}
  }
`;
