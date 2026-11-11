import React, { useEffect, useState } from "react";
import { LANGS, tIn, useI18n } from "../i18n";
import { NeedPassword, panelApi, toggle, useHomeWords } from "../lib/api";

// Scan and control: make, print and revoke the QR codes that let a phone show
// and switch a part of the house (docs/specs/panel-scan-and-control.md), and
// choose what a ring sets off. Over /api/panel/*, behind the edge's password.
//
// A code's secret exists only in its QR code: the edge does not keep it. So a
// code is shown here once, right after it is made. Lost? Revoke it, make a new one.
// Each card speaks its code's language: the badge, the words under the QR, the
// room names, and the phone page it opens (&l= in the link).

const KIND_LABEL = { light: "Lights (Hue, dimmers)", switch: "Switches and sockets", blind: "Blinds", heating: "Heating" };
const BELL_LABEL = { none: "no bell", listen: "rings with the door bell", ring: "is the door bell" };
const LOCAL = /\/\/(localhost|127\.|\[::1\])/;

function Qr({ text }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let on = true;
    import("qrcode").then((m) => (m.default || m).toDataURL(text, { margin: 1, width: 480, errorCorrectionLevel: "M" })).then((u) => on && setSrc(u), () => {});
    return () => { on = false; };
  }, [text]);
  return src ? <img className="dhe-card__qr" src={src} alt="QR" /> : <div className="dhe-card__qr" />;
}

export function PasswordNote({ err, retry }) {
  const { t } = useI18n();
  if (!err) return null;
  const need = err instanceof NeedPassword;
  return (
    <div className="app-empty">
      <p className={need ? "" : "app-msg--err"}>{need ? t("This part needs the edge's password: user dhcedge, the password from `sudo dhcedge show-secrets`.") : "✗ " + err.message}</p>
      <button className="app-button app-button--ghost app-button--small" onClick={retry}>{t("Try again")}</button>
    </div>
  );
}

// Where a code applies, in a given language (the portal's, or the card's).
function whereText(c, cat, word, lang) {
  const s = c.scope || {};
  if (s.none) return tIn(lang, "bell only");
  const rooms = new Map(cat.rooms.map((r) => [r.id, r.name || r.label]));
  const parts = [...(s.floors || []).map((n) => tIn(lang, "floor {n}", { n })), ...(s.rooms || []).map((id) => word(rooms.get(id) || "?", lang))];
  return (parts.join(", ") || tIn(lang, "whole house")) + ((s.kinds || []).length ? " · " + s.kinds.map((k) => tIn(lang, KIND_LABEL[k])).join(", ") : "");
}

export default function Codes({ active }) {
  const { t, lang } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [made, setMade] = useState([]);   // codes made in this visit: the only moment their QR exists
  const [base, setBase] = useState("");
  const [f, setF] = useState({ name: "", floors: [], rooms: [], kinds: [], bell: "none", lang: null });
  const word = useHomeWords(lang, !!data);

  const load = () => panelApi("GET", "codes").then((j) => { setData(j); setErr(null); }, setErr);
  useEffect(() => { if (active && !data) load(); }, [active]);
  useEffect(() => { if (!active || !data) return undefined; const id = setInterval(load, 5000); return () => clearInterval(id); }, [active, !!data]);
  useEffect(() => { setBase(window.location.origin); }, []);
  // Opened on the edge itself (localhost): the phones need its address on the home network instead.
  useEffect(() => {
    const lan = data && data.lan && data.lan[0];
    if (!lan || !LOCAL.test(window.location.origin)) return;
    setBase((b) => (LOCAL.test(b) ? `http://${lan}${window.location.port ? ":" + window.location.port : ""}` : b));
  }, [data && data.lan && data.lan[0]]);

  const codeLang = f.lang || lang;
  const make = async () => {
    try {
      const j = await panelApi("POST", "codes", { name: f.name, bell: f.bell, lang: codeLang, scope: { floors: f.floors, rooms: f.rooms, kinds: f.kinds } });
      setMade((m) => [{ ...j.code, secret: j.secret, port: j.ws_port }, ...m]);
      setF({ ...f, name: "" }); setErr(null); load();
    } catch (e) { setErr(e); }
  };
  const revoke = async (c) => {
    if (!window.confirm(t("Revoke \"{name}\"? Every phone and printed card with this code stops working.", { name: c.name }))) return;
    try { await panelApi("DELETE", "codes/" + c.id); setMade((m) => m.filter((x) => x.id !== c.id)); load(); } catch (e) { setErr(e); }
  };
  const link = (c) => `${base.replace(/\/+$/, "")}/app/panel/#c=${c.id}.${c.secret}&l=${c.lang}${c.port && c.port !== 9001 ? "&p=" + c.port : ""}`;

  if (!data) return <PasswordNote err={err} retry={load} />;
  const cat = data.catalog;
  return (<>
    {err && <PasswordNote err={err} retry={load} />}
    {cat.tiles === 0 && <div className="app-empty"><p>{t("The digital twin has nothing to switch yet: connect the CCU or Hue, update their configuration and generate the twin.")}</p></div>}

    <section className="app-panel">
      <h2 className="app-panel__title">{t("New code")}<span className="app-shell__spacer" />
        <span className={"app-badge" + (data.broker.connected ? " app-badge--ok" : " app-badge--bad")}>{data.broker.connected ? t("broker connected") : t("no broker")}</span>
      </h2>
      <label className="app-field"><span>{t("Name on the card")}</span>
        <input className="app-input" placeholder={t("e.g. Ground floor lights")} value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      {f.bell !== "ring" && (<>
        <div className="app-field"><span>{t("Floors")}</span><div className="app-chips">{cat.floors.map((n) => (
          <button key={n} className={"app-chip" + (f.floors.includes(n) ? " app-chip--on" : "")} onClick={() => setF({ ...f, floors: toggle(f.floors, n) })}>{t("floor {n}", { n })}</button>))}</div></div>
        <div className="app-field"><span>{t("Rooms")}</span><div className="app-chips">{cat.rooms.map((r) => (
          <button key={r.id} className={"app-chip" + (f.rooms.includes(r.id) ? " app-chip--on" : "")} onClick={() => setF({ ...f, rooms: toggle(f.rooms, r.id) })}>{word(r.name || r.label)}{r.source === "hue" ? <small>Hue</small> : null}</button>))}</div></div>
        <div className="app-field"><span>{t("Functions")}</span><div className="app-chips">{cat.kinds.map((k) => (
          <button key={k} className={"app-chip" + (f.kinds.includes(k) ? " app-chip--on" : "")} onClick={() => setF({ ...f, kinds: toggle(f.kinds, k) })}>{t(KIND_LABEL[k])}</button>))}</div></div>
        <p className="app-panel__hint">{t("Nothing chosen under floors and rooms: the whole house. Nothing under functions: all of them.")}</p>
      </>)}
      <div className="app-row">
        <label className="app-field"><span>{t("Door bell")}</span>
          <select className="app-select" value={f.bell} onChange={(e) => setF({ ...f, bell: e.target.value })}>
            <option value="none">{t("no bell")}</option>
            <option value="listen">{t("this phone rings with the door bell")}</option>
            <option value="ring">{t("this phone is the door bell (no tiles)")}</option>
          </select></label>
        <div className="app-field"><span>{t("Language of the card and the phone")}</span>
          <div className="app-seg" style={{ margin: 0 }} role="group">{LANGS.map((l) => (
            <button key={l.id} className={"app-seg__option" + (codeLang === l.id ? " app-seg__option--on" : "")} onClick={() => setF({ ...f, lang: l.id })} title={l.name}>{l.id}</button>))}</div></div>
      </div>
      <div className="app-row"><button className="app-button" onClick={make} disabled={!f.name.trim() || !data.broker.connected}>{t("Make code")}</button></div>
    </section>

    {made.length > 0 && (
      <section className="app-panel dhe-print">
        <h2 className="app-panel__title">{t("New: print or scan now")}<span className="app-shell__spacer" />
          <button className="app-button app-button--small" onClick={() => window.print()}>{t("Print")}</button></h2>
        <p className="app-panel__hint">{t("The edge does not keep a code's secret: these QR codes are gone when you leave this page.")}</p>
        <label className="app-field"><span>{t("Address the phones use for this edge")}</span><input className="app-input" value={base} onChange={(e) => setBase(e.target.value)} /></label>
        {LOCAL.test(base) && <p className="app-msg app-msg--err">{t("This address only works on this computer. Enter the edge's address on the home network, e.g. http://192.168.x.x:1880.")}</p>}
        <div className="dhe-sheet">{made.map((c) => (
          <div className="dhe-card" key={c.id} lang={c.lang}>
            <span className="dhe-card__lang" title={(LANGS.find((l) => l.id === c.lang) || {}).name}>{String(c.lang).toUpperCase()}</span>
            <span className="dhe-card__brand">digitalhome</span>
            <Qr text={link(c)} />
            <div className="dhe-card__name">{c.name}</div>
            <div className="dhe-card__sub">{whereText(c, cat, word, c.lang)}{c.bell !== "none" ? " · " + tIn(c.lang, BELL_LABEL[c.bell]) : ""}</div>
            <div className="dhe-card__how">{tIn(c.lang, "Scan with the phone's camera, on the home Wi-Fi")}</div>
          </div>
        ))}</div>
      </section>
    )}

    <section className="app-panel">
      <h2 className="app-panel__title">{t("Codes")}<span className="app-shell__spacer" /><span className="dhe-count">{t("{n} tiles in the twin", { n: cat.tiles })}</span></h2>
      {data.codes.length === 0 && <p className="app-panel__hint">{t("No codes yet.")}</p>}
      <div>{data.codes.map((c) => (
        <div className="dhe-code" key={c.id}>
          <span className={"app-dot" + (c.online ? " app-dot--on" : "")} title={c.online ? t("a phone is using it") : t("not in use")} />
          <span>{c.name} <span className="dhe-lang app-muted">{String(c.lang || "en").toUpperCase()}</span></span>
          <span className="dhe-code__where">{whereText(c, cat, word, lang)} · {t("{n} tiles", { n: c.tiles })}{c.bell !== "none" ? " · " + t(BELL_LABEL[c.bell]) : ""}</span>
          <button className="app-button app-button--ghost app-button--danger app-button--small" onClick={() => revoke(c)}>{t("Revoke")}</button>
        </div>
      ))}</div>
    </section>
  </>);
}

export function Bell({ active }) {
  const { t, lang } = useI18n();
  const [bell, setBell] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState("");
  const word = useHomeWords(lang, !!bell);
  const load = () => panelApi("GET", "bell").then((j) => { setBell(j); setErr(null); }, setErr);
  useEffect(() => { if (active && !bell) load(); }, [active]);
  if (!bell) return <PasswordNote err={err} retry={load} />;
  const pick = (kind, id) => {
    const next = { ...bell.bell, [kind]: toggle(bell.bell[kind], id) };
    setBell({ ...bell, bell: next });
    panelApi("PUT", "bell", next).then(setBell, setErr);
  };
  const test = () => panelApi("POST", "bell/test").then((j) => setMsg(j.targets ? t("sent to {n}", { n: j.targets }) : t("nothing chosen")), (e) => setMsg(e.message));
  return (
    <section className="app-panel">
      <h2 className="app-panel__title">{t("When the door bell rings")}<span className="app-shell__spacer" />
        <button className="app-button app-button--ghost app-button--small" onClick={test}>{t("Test")}</button></h2>
      <p className="app-panel__hint">{t("Phones with a listening code always ring. Choose what else in the house announces it: Hue lights blink for 15 seconds, a Homematic chime sounds.")}</p>
      {msg && <p className="app-msg app-msg--busy">{msg}</p>}
      {err && <p className="app-msg app-msg--err">✗ {err.message}</p>}
      <div className="app-field"><span>{t("Hue lights blink")}</span>
        {bell.options.lights.length === 0 ? <p className="app-panel__hint">{t("no Hue lights in the twin")}</p> : <div className="app-chips">{bell.options.lights.map((l) => (
          <button key={l.id} className={"app-chip" + (bell.bell.lights.includes(l.id) ? " app-chip--on" : "")} onClick={() => pick("lights", l.id)}>{word(l.label)}{l.room ? <small>{word(String(l.room).replace(/^\d+\.\s*/, ""))}</small> : null}</button>))}</div>}</div>
      <div className="app-field"><span>{t("Chime")}</span>
        {bell.options.chimes.length === 0 ? <p className="app-panel__hint">{t("no Homematic chime in the twin")}</p> : <div className="app-chips">{bell.options.chimes.map((c) => (
          <button key={c.id} className={"app-chip" + (bell.bell.chimes.includes(c.id) ? " app-chip--on" : "")} onClick={() => pick("chimes", c.id)}>{word(c.label)}</button>))}</div>}</div>
    </section>
  );
}
