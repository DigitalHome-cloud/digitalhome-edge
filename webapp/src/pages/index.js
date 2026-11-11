import React, { useEffect, useState } from "react";
import { I18nProvider, LANGS, store, useI18n } from "../i18n";
import { useEdgeStream } from "../lib/api";
import { Devices, Network, Overview, Twin } from "../components/Status";
import Codes, { Bell } from "../components/Codes";
import Labels from "../components/Labels";

// The edge portal: what this edge sees, connects and offers the house.
// Served by Node-RED at /app; LAN only. One page, a view per #hash, every view
// kept mounted so a QR sheet survives a look elsewhere. The D-LAB-5 design:
// a rail on the left, panels on the page (src/styles/portal.css).

const I = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  plug: <><path d="M9 2v6M15 2v6" /><path d="M6 8h12v4a6 6 0 0 1-12 0z" /><path d="M12 18v4" /></>,
  twin: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></>,
  net: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5M12 12l-6 5M12 12l6 5" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  words: <><path d="M4 5h7M7.5 3v2c0 4-2 7-4.5 8M5.5 9c1 2.5 3 4 5.5 4.5" /><path d="M13 21l4-9 4 9M14.5 18h5" /></>,
  out: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
};
const Icon = ({ name }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[name]}</svg>
);

const SECTIONS = [
  { label: "This edge", items: [["overview", "Overview", "home"], ["devices", "Devices", "plug"], ["twin", "Digital twin", "twin"], ["network", "Home network", "net"]] },
  { label: "Scan and control", items: [["codes", "Codes", "qr"], ["bell", "Door bell", "bell"], ["labels", "Labels", "words"]] },
];
const VIEWS = SECTIONS.flatMap((s) => s.items.map((i) => i[0]));
const LEDE = {
  overview: "What this edge is connected to, and what it reads right now.",
  devices: "Connect the Homematic CCU, the Hue bridge and the solar system. Only this edge talks to them.",
  twin: "The house as data: rooms, devices and points, built from the devices' own configuration.",
  network: "Every device on the home network, and what it is.",
  codes: "QR codes that open only the switches of a floor, a room or a function on any phone in the house. No app, no login.",
  bell: "A phone at the door is the bell. Choose what rings inside.",
  labels: "Rooms and devices in English, German and French: for the phones, the cards and this portal.",
};

function useTheme() {
  const [theme, setTheme] = useState("dark");
  useEffect(() => { setTheme(document.documentElement.getAttribute("data-app-theme") === "light" ? "light" : "dark"); }, []);
  const pick = (v) => { setTheme(v); document.documentElement.setAttribute("data-app-theme", v); store.set("dhe.theme", v); };
  return [theme, pick];
}

function Portal() {
  const { t, lang, setLang } = useI18n();
  const { data: s, live } = useEdgeStream();
  const [view, setView] = useState("overview");
  const [theme, setTheme] = useTheme();
  useEffect(() => {
    const read = () => { const h = window.location.hash.slice(1); setView(VIEWS.includes(h) ? h : "overview"); };
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const go = (v) => { window.location.hash = v; };
  const title = SECTIONS.flatMap((x) => x.items).find((i) => i[0] === view)[1];
  const linked = (k) => s && s[k] && s[k].link && s[k].link.state === "linked";

  return (
    <div className="app-shell app-shell--railed">
      <nav className="app-rail" aria-label="digitalhome.edge">
        <a className="app-rail__brand" href="#overview"><span className="app-mark"><Icon name="home" /></span><span>digitalhome<span className="app-rail__brandaccent">.edge</span></span></a>
        {SECTIONS.map((sec) => (
          <div className="app-rail__section" key={sec.label}>
            <h2 className="app-rail__sectionlabel">{t(sec.label)}</h2>
            <ul className="app-rail__items">{sec.items.map(([id, label, icon]) => (
              <li key={id}><a className={"app-rail__item" + (view === id ? " app-rail__item--on" : "")} href={"#" + id} aria-current={view === id ? "page" : undefined}>
                <Icon name={icon} /><span>{t(label)}</span>
                {id === "devices" && s && !(linked("ccu") || linked("hue")) && <span className="app-rail__dot" title={t("nothing connected yet")} />}
              </a></li>))}</ul>
          </div>
        ))}
        <div className="app-rail__foot">
          <ul className="app-rail__items"><li><a className="app-rail__item" href="/ui"><Icon name="out" /><span>{t("Node-RED dashboard")}</span></a></li></ul>
          <div className="app-seg" role="group" aria-label={t("Language")}>{LANGS.map((l) => (
            <button key={l.id} className={"app-seg__option" + (lang === l.id ? " app-seg__option--on" : "")} onClick={() => setLang(l.id)} title={l.name}>{l.id}</button>))}</div>
          <div className="app-seg" role="group" aria-label={t("Theme")}>{["dark", "light"].map((v) => (
            <button key={v} className={"app-seg__option" + (theme === v ? " app-seg__option--on" : "")} onClick={() => setTheme(v)}>{t(v)}</button>))}</div>
          <p className="app-rail__note">{t("Home network only. Nothing here leaves the house.")}</p>
        </div>
      </nav>

      <div className="app-shell__body">
        <header className="app-shell__header">
          <h1 className="app-shell__title">{t(title)}</h1>
          <span className="app-shell__spacer" />
          <span className={"app-dot" + (live ? " app-dot--on" : "")} />
          <span className="app-shell__meta">{s ? t("updated {time}", { time: new Date(s.ts).toLocaleTimeString(lang) }) + " · " + (live ? t("live") : t("polling")) : t("connecting…")}</span>
        </header>
        <main className="app-shell__main">
          <p className="app-lede">{t(LEDE[view])}</p>
          <div hidden={view !== "overview"} style={{ display: "contents" }}><Overview s={s} go={go} /></div>
          <div hidden={view !== "devices"} style={{ display: "contents" }}><Devices s={s} /></div>
          <div hidden={view !== "twin"} style={{ display: "contents" }}><Twin s={s} /></div>
          <div hidden={view !== "network"} style={{ display: "contents" }}><Network /></div>
          <div hidden={view !== "codes"} style={{ display: "contents" }}><Codes active={view === "codes"} /></div>
          <div hidden={view !== "bell"} style={{ display: "contents" }}><Bell active={view === "bell"} /></div>
          <div hidden={view !== "labels"} style={{ display: "contents" }}><Labels active={view === "labels"} /></div>
        </main>
      </div>
    </div>
  );
}

export default function Home() {
  return <I18nProvider><Portal /></I18nProvider>;
}

export const Head = () => <title>digitalhome.edge</title>;
