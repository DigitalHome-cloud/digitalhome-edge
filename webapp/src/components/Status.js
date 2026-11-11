import React, { useState } from "react";
import { useI18n } from "../i18n";
import { appApi } from "../lib/api";

// What the edge sees: the overview, connecting the devices, the digital twin
// and the network map. All over /app-api/* (open on the LAN, no password).

const fmt = (v) => (v === null || v === undefined || v === "" ? "—" : v);
export const Msg = ({ m }) => <p className={"app-msg" + (m && m.cls ? " app-msg--" + m.cls : "")} role="status">{m ? m.text : ""}</p>;

function LinkBadge({ link }) {
  const { t } = useI18n();
  const on = link && link.state === "linked";
  return <span className={"app-badge" + (on ? " app-badge--ok" : "")}>{on ? t("connected") : (link && link.state) || "—"}</span>;
}

function StatusPanel({ title, link, rows }) {
  return (
    <section className="app-panel">
      <h2 className="app-panel__title">{title}<span className="app-shell__spacer" /><LinkBadge link={link} /></h2>
      <dl className="app-kv">{rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{fmt(v)}</dd></React.Fragment>))}</dl>
    </section>
  );
}

export function Overview({ s, go }) {
  const { t } = useI18n();
  const solar = (s && s.solar) || {}, ccu = (s && s.ccu) || {}, hue = (s && s.hue) || {}, pl = (s && s.pipeline) || {};
  const sd = (solar.latest && solar.latest.data) || {};
  const cbox = (s && s.cbox) || null;
  return (<>
    <div className="app-grid">
      <StatusPanel title={t("Solar")} link={solar.link} rows={[[t("Account"), solar.link && solar.link.email], [t("PV power"), sd.generationPower != null ? sd.generationPower + " W" : null], [t("Load"), sd.usePower != null ? sd.usePower + " W" : null], [t("Battery"), sd.batterySoc != null ? sd.batterySoc + " %" : null]]} />
      <StatusPanel title="Homematic CCU" link={ccu.link} rows={[["IP", ccu.link && ccu.link.ip], [t("Devices"), ccu.latest && ccu.latest.devices], [t("Datapoints"), ccu.latest && ccu.latest.datapoints]]} />
      <StatusPanel title="Philips Hue" link={hue.link} rows={[["IP", hue.link && hue.link.ip], [t("Lights"), hue.latest && hue.latest.lights], [t("Sensors"), hue.latest && hue.latest.sensors]]} />
      <StatusPanel title={t("Data pipeline")} link={{ state: pl.recent_mapped ? "linked" : "idle" }} rows={[[t("Sources"), (pl.sources || []).join(", ")], [t("Mappings"), pl.counts ? t("{n} fields", { n: pl.counts.sourceMap }) : null], [t("Recent readings"), pl.recent_mapped]]} />
    </div>
    <section className="app-panel">
      <h2 className="app-panel__title">{t("Digital twin")}</h2>
      <p className="app-panel__hint">{cbox ? t("{rooms} rooms · {devices} devices · {points} points", cbox) : t("No digital twin yet: connect the CCU or Hue, then generate it.")}</p>
      <div className="app-row">
        <button className="app-button app-button--ghost app-button--small" onClick={() => go("devices")}>{t("Devices")}</button>
        <button className="app-button app-button--ghost app-button--small" onClick={() => go("twin")}>{t("Digital twin")}</button>
        <button className="app-button app-button--ghost app-button--small" onClick={() => go("codes")}>{t("Scan and control")}</button>
      </div>
    </section>
  </>);
}

export function Devices({ s }) {
  const { t } = useI18n();
  const [f, setF] = useState({ solarEmail: "", solarPass: "", ccuIp: "", ccuToken: "", hueIp: "" });
  const [msg, setMsg] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const say = (src, text, cls) => setMsg((m) => ({ ...m, [src]: { text, cls } }));
  const scan = async (source) => {
    say(source, t("scanning…"), "busy");
    try {
      const j = await appApi("scan", { source });
      if (j.candidates && j.candidates.length) { setF((x) => ({ ...x, [source + "Ip"]: j.candidates[0].ip })); say(source, t("found: {ips}", { ips: j.candidates.map((c) => c.ip).join(", ") }), "ok"); }
      else say(source, t("nothing found on {net}", { net: (j.subnet || "?") + ".0/24" }), "err");
    } catch { say(source, t("scan failed"), "err"); }
  };
  const connect = async (source) => {
    let body = { source };
    if (source === "ccu") body = { source, ip: f.ccuIp.trim(), token: f.ccuToken.trim() };
    else if (source === "hue") { body = { source, ip: f.hueIp.trim() }; say("hue", t("pairing… press the bridge button now (up to 30 s)"), "busy"); }
    else if (source === "solar") body = { source, email: f.solarEmail.trim(), password: f.solarPass };
    if (source !== "hue") say(source, t("connecting…"), "busy");
    try {
      const j = await appApi("connect", body);
      say(source, (j.ok ? "✓ " : "✗ ") + (j.message || (j.ok ? t("connected") : t("failed"))), j.ok ? "ok" : "err");
      if (source === "solar") setF((x) => ({ ...x, solarPass: "" }));
    } catch { say(source, t("request failed"), "err"); }
  };
  const configPull = async (source) => {
    say(source + "cfg", t("downloading the configuration…"), "busy");
    try {
      const j = await appApi("config-pull", { source });
      const parts = source === "ccu" ? t("{rooms} rooms · {functions} functions · {devices} devices", j) : t("{lights} lights · {rooms} rooms · {scenes} scenes · {sensors} sensors", j);
      say(source + "cfg", (j.ok ? "✓ " : "✗ ") + (j.ok ? parts : j.message), j.ok ? "ok" : "err");
    } catch { say(source + "cfg", t("request failed"), "err"); }
  };
  const solar = (s && s.solar) || {}, ccu = (s && s.ccu) || {}, hue = (s && s.hue) || {};
  const cfg = (s && s.config) || {};
  const linked = (l) => l && l.state === "linked";
  return (
    <div className="app-grid">
      <section className="app-panel">
        <h2 className="app-panel__title">{t("Solar (Solarman)")}<span className="app-shell__spacer" /><LinkBadge link={solar.link} /></h2>
        <label className="app-field"><span>{t("Solarman email")}</span><input value={f.solarEmail} onChange={set("solarEmail")} autoComplete="off" /></label>
        <label className="app-field"><span>{t("Solarman password")}</span><input type="password" value={f.solarPass} onChange={set("solarPass")} autoComplete="off" /></label>
        <div className="app-row"><button className="app-button" onClick={() => connect("solar")}>{t("Connect")}</button></div>
        <Msg m={msg.solar} />
      </section>
      <section className="app-panel">
        <h2 className="app-panel__title">Homematic CCU<span className="app-shell__spacer" /><LinkBadge link={ccu.link} /></h2>
        <label className="app-field"><span>{t("CCU address")}</span><input value={f.ccuIp} onChange={set("ccuIp")} /></label>
        <label className="app-field"><span>{t("API token (recommended)")}</span><input value={f.ccuToken} onChange={set("ccuToken")} autoComplete="off" /></label>
        <div className="app-row">
          <button className="app-button app-button--ghost" onClick={() => scan("ccu")}>{t("Scan network")}</button>
          <button className="app-button" onClick={() => connect("ccu")}>{t("Connect")}</button>
          {linked(ccu.link) && <button className="app-button app-button--ghost" onClick={() => configPull("ccu")}>{t("Update configuration")}</button>}
        </div>
        <Msg m={msg.ccu} />
        {linked(ccu.link) && <Msg m={msg.ccucfg || (cfg.ccu && { text: t("{rooms} rooms · {devices} devices", cfg.ccu) })} />}
      </section>
      <section className="app-panel">
        <h2 className="app-panel__title">Philips Hue<span className="app-shell__spacer" /><LinkBadge link={hue.link} /></h2>
        <label className="app-field"><span>{t("Hue bridge address")}</span><input value={f.hueIp} onChange={set("hueIp")} /></label>
        <div className="app-row">
          <button className="app-button app-button--ghost" onClick={() => scan("hue")}>{t("Scan network")}</button>
          <button className="app-button" onClick={() => connect("hue")}>{t("Connect (press the bridge button)")}</button>
          {linked(hue.link) && <button className="app-button app-button--ghost" onClick={() => configPull("hue")}>{t("Update configuration")}</button>}
        </div>
        <Msg m={msg.hue} />
        {linked(hue.link) && <Msg m={msg.huecfg || (cfg.hue && { text: t("{lights} lights · {rooms} rooms", cfg.hue) })} />}
      </section>
    </div>
  );
}

export function Twin({ s }) {
  const { t } = useI18n();
  const [msg, setMsg] = useState(null);
  const cbox = (s && s.cbox) || null;
  const gen = async () => {
    setMsg({ text: t("generating the digital twin…"), cls: "busy" });
    try {
      const j = await appApi("cbox-generate", {});
      setMsg({ text: (j.ok ? "✓ " : "✗ ") + (j.ok ? t("{rooms} rooms · {devices} devices · {points} points", j) : j.message), cls: j.ok ? "ok" : "err" });
    } catch { setMsg({ text: t("request failed"), cls: "err" }); }
  };
  return (
    <section className="app-panel">
      <h2 className="app-panel__title">C-BOX</h2>
      <p className="app-panel__hint">{t("Builds a Brick/REC digital twin from the downloaded CCU and Hue configuration: rooms, devices and points, each linked to the live readings. The phones' tiles and the label dictionary are read from it.")}</p>
      <Msg m={msg || (cbox && { text: t("{rooms} rooms · {devices} devices · {points} points", cbox) })} />
      <div className="app-row">
        <button className="app-button" onClick={gen}>{t("Generate the twin")}</button>
        {cbox && <a className="app-button app-button--ghost" href="/app-api/cbox" target="_blank" rel="noreferrer">{t("Download JSON-LD")}</a>}
      </div>
    </section>
  );
}

const ROLE_COLOR = { gateway: "var(--app-cat-2)", integration: "var(--app-cat-4)", network: "var(--app-cat-1)", device: "var(--app-cat-6)" };
export function Network() {
  const { t } = useI18n();
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setScan(await appApi("lan-scan", {})); } catch { setScan({ error: t("scan failed") }); } setBusy(false); };
  const groups = [["gateway", t("Gateway")], ["integration", t("Integrations")], ["network", t("Network and powerline")], ["device", t("Other devices")]];
  const devs = (scan && scan.devices) || [];
  return (
    <section className="app-panel">
      <h2 className="app-panel__title">{t("Home network")}<span className="app-shell__spacer" />
        {scan && !scan.error && <span className="app-muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>{t("{n} devices on {net}", { n: scan.count, net: scan.subnet })}</span>}
        <button className="app-button app-button--ghost app-button--small" onClick={run} disabled={busy}>{busy ? t("scanning…") : t("Scan the network")}</button>
      </h2>
      {!scan && <p className="app-panel__hint">{t("Looks at every address of the home network: hardware vendor, name, open ports and role (CCU, Hue bridge, powerline adapters, router).")}</p>}
      {scan && scan.error && <Msg m={{ text: "✗ " + scan.error, cls: "err" }} />}
      {groups.map(([role, label]) => {
        const rows = devs.filter((d) => d.role === role);
        if (!rows.length) return null;
        return (
          <div className="dhe-net__group" key={role}>
            <div className="dhe-net__head" style={{ color: ROLE_COLOR[role] }}>{label}</div>
            {rows.map((d) => (
              <div className="dhe-net__row" key={d.ip}>
                <span className="app-dot" style={{ background: ROLE_COLOR[d.role] }} />
                <span className="app-mono">{d.ip}</span>
                <span>{d.type}{d.hostname && d.hostname !== "blocked.local" ? " · " + d.hostname : ""}</span>
                <span className="app-mono">{d.mac}</span>
                <span className="app-mono" style={{ textAlign: "right" }}>{(d.ports || []).join(" ") || "—"}</span>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
