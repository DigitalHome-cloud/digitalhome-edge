import React, { useEffect, useMemo, useState } from "react";
import { LANGS, useI18n } from "../i18n";
import { panelApi } from "../lib/api";
import { PasswordNote } from "./Codes";

// The home's words in EN, FR and DE. Each room and device keeps the name it
// has in the CCU or the Hue app (shown first, with its ID and channel); the
// translations live on the edge only, and an empty field means "show the name
// as it is". A change reaches the phones at once.
// Stored on the edge in /cbox/labels.json (runtime only, never committed).

// The table's column order (the rest of the portal keeps LANGS' order).
const COLS = ["en", "fr", "de"].map((id) => LANGS.find((l) => l.id === id)).filter(Boolean);

export default function Labels({ active }) {
  const { t } = useI18n();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("");        // a language: show only words missing in it
  const [where, setWhere] = useState("all");   // all | room | tile | chime | other | gone
  const [saved, setSaved] = useState({});      // original -> "ok" | "err"

  const load = () => panelApi("GET", "labels").then((j) => { setRows(j.entries || []); setErr(null); }, setErr);
  useEffect(() => { if (active) load(); }, [active]);

  const edit = (original, l, value) => setRows((rs) => rs.map((r) => (r.original === original ? { ...r, [l]: value } : r)));
  const save = async (row, l) => {
    try {
      await panelApi("PUT", "labels", { [row.original]: { [l]: row[l] || "" } });
      setSaved((s) => ({ ...s, [row.original]: "ok" }));
    } catch (e) { setSaved((s) => ({ ...s, [row.original]: "err" })); setErr(e); }
  };
  // The name as it is, in the language it is in: a quick way to fill one column.
  const keep = (row, l) => { edit(row.original, l, row.original); save({ ...row, [l]: row.original }, l); };

  const shown = useMemo(() => (rows || []).filter((r) => {
    if (q && !(r.original + " " + (r.names || []).join(" ") + " " + LANGS.map((l) => r[l.id] || "").join(" ") + " " + (r.rooms || []).join(" ")).toLowerCase().includes(q.toLowerCase())) return false;
    if (only && r[only]) return false;
    if (where === "gone") return r.where.length === 0;
    if (where !== "all" && !r.where.includes(where)) return false;
    return true;
  }), [rows, q, only, where]);

  if (!rows) return <PasswordNote err={err} retry={load} />;
  const missing = (l) => rows.filter((r) => r.where.length && !r[l]).length;
  const live = rows.filter((r) => r.where.length).length;
  const WHERE = [["all", t("All")], ["room", t("Rooms")], ["tile", t("Devices")], ["chime", t("Chimes")], ["other", t("Other devices")], ["gone", t("No longer in the twin")]];
  return (<>
    <section className="app-panel">
      <h2 className="app-panel__title">{t("The home's words")}<span className="app-shell__spacer" />
        {COLS.map((l) => <span key={l.id} className="dhe-count">{l.id.toUpperCase()} {live - missing(l.id)}/{live}</span>)}</h2>
      <p className="app-panel__hint">{t("Every room and device keeps the name it has in the CCU or the Hue app; the translations live on this edge only. Give it a word in each language; an empty field shows the name as it is. Phones get the new words at once, in their code's language.")}</p>
      <div className="app-row">
        <input className="app-input" style={{ flex: "1 1 14rem" }} type="search" placeholder={t("Search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="app-select" value={where} onChange={(e) => setWhere(e.target.value)}>{WHERE.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select className="app-select" value={only} onChange={(e) => setOnly(e.target.value)}>
          <option value="">{t("all words")}</option>
          {LANGS.map((l) => <option key={l.id} value={l.id}>{t("missing in {lang}", { lang: l.name })}</option>)}
        </select>
      </div>
      {err && <p className="app-msg app-msg--err">✗ {err.message}</p>}
    </section>

    <section className="app-panel">
      {rows.length === 0 ? <p className="app-panel__hint">{t("No words yet: the digital twin is empty.")}</p> : (
        <table className="app-table dhe-labels">
          <thead><tr><th>{t("Original (ID)")}</th>{COLS.map((l) => <th key={l.id}>{l.name}</th>)}</tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.original}>
              <td>{(r.names && r.names.length ? r.names : [r.original]).join(" · ")}{saved[r.original] === "ok" ? " ✓" : saved[r.original] === "err" ? " ✗" : ""}
                <small>{r.where.length ? r.where.map((w) => ({ room: t("room"), tile: t("device"), chime: t("chime"), other: t("other device") }[w])).join(", ") + (r.rooms && r.rooms.length ? " · " + r.rooms.join(", ") : "") : t("no longer in the twin")}</small></td>
              {COLS.map((l) => (
                <td key={l.id}>
                  <input className="app-input" lang={l.id} aria-label={r.original + " — " + l.name} placeholder={r.original} value={r[l.id] || ""} maxLength={80}
                    onChange={(e) => edit(r.original, l.id, e.target.value)} onBlur={() => save(r, l.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    onDoubleClick={() => { if (!r[l.id]) keep(r, l.id); }} />
                </td>
              ))}
            </tr>
          ))}</tbody>
        </table>
      )}
      {rows.length > 0 && <p className="app-panel__hint">{t("{n} of {all} shown. Double-click an empty field to keep the name as it is.", { n: shown.length, all: rows.length })}</p>}
    </section>
  </>);
}
