import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import de from "./de";
import fr from "./fr";

// The portal's words. The English text is the key: t("Scan network") looks it
// up in de.js / fr.js and falls back to itself, so a missing translation shows
// English, never a blank or a key. "{n}" in a text is filled from `vars`.
//
// The home's own words (rooms, devices) work the same way, with the name from
// the CCU or the Hue app as the key; they live on the edge (/api/panel/labels),
// because the phones need them too. See components/Labels.js.

export const LANGS = [
  { id: "en", name: "English" },
  { id: "de", name: "Deutsch" },
  { id: "fr", name: "Français" },
];
const DICTS = { en: {}, de, fr };

const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : text);

const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
  set(key, v) { try { window.localStorage.setItem(key, v); } catch (_) { /* private window */ } },
};

/** A text in a given language, whatever the portal's: a printed card speaks its code's language. */
export const tIn = (lang, text, vars) => fill((DICTS[lang] || {})[text] || text, vars);

const I18n = createContext({ lang: "en", setLang: () => {}, t: (s, v) => fill(s, v) });

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState("en");
  useEffect(() => {
    const saved = store.get("dhe.lang");
    const guess = (navigator.language || "en").slice(0, 2);
    const pick = DICTS[saved] ? saved : DICTS[guess] ? guess : "en";
    setLangState(pick);
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l) => { if (DICTS[l]) { setLangState(l); store.set("dhe.lang", l); } }, []);
  const t = useCallback((text, vars) => fill(DICTS[lang][text] || text, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);

export { store };
