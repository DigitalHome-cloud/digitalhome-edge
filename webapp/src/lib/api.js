import { useEffect, useRef, useState } from "react";

// /app-api/*: the edge's open status and onboarding endpoints (Node-RED flows).
export const appApi = (path, body, method = "POST") =>
  fetch(`/app-api/${path}`, method === "GET" ? { cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// /api/panel/*: behind the edge's password; the browser asks for it once (user dhcedge).
export class NeedPassword extends Error {}
export async function panelApi(method, path, body) {
  const r = await fetch("/api/panel/" + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (r.status === 401) throw new NeedPassword("password needed (user dhcedge)");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "request failed (" + r.status + ")");
  return j;
}

// The edge's live status: a WebSocket, with polling while it is down.
export function useEdgeStream() {
  const [data, setData] = useState(null);
  const [live, setLive] = useState(false);
  const pollRef = useRef(null);
  useEffect(() => {
    let closed = false;
    const startPoll = () => {
      if (pollRef.current) return;
      const p = async () => { try { setData(await appApi("status", null, "GET")); } catch { setLive(false); } };
      p(); pollRef.current = setInterval(p, 3000);
    };
    const stopPoll = () => { clearInterval(pollRef.current); pollRef.current = null; };
    const connect = () => {
      try {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${window.location.host}/app-api/ws`);
        ws.onmessage = (e) => { stopPoll(); setLive(true); try { setData(JSON.parse(e.data)); } catch { /* ignore */ } };
        ws.onclose = () => { setLive(false); startPoll(); if (!closed) setTimeout(connect, 5000); };
        ws.onerror = () => ws.close();
      } catch { startPoll(); }
    };
    connect(); startPoll();
    return () => { closed = true; stopPoll(); };
  }, []);
  return { data, live };
}

// Home words (rooms, devices) in the portal's language, from the edge's label dictionary.
export function useHomeWords(lang, enabled) {
  const [dict, setDict] = useState({});
  useEffect(() => {
    if (!enabled) return;
    panelApi("GET", "labels").then((j) => { const d = {}; for (const e of j.entries || []) d[e.original] = e; setDict(d); }, () => {});
  }, [enabled]);
  return (word, inLang) => (dict[word] && dict[word][inLang || lang]) || word;
}

export const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
