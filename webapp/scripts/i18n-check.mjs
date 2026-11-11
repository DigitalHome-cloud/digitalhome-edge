// npm run i18n-check — every English text the portal shows has a German and a
// French entry, and no dictionary keeps a text the code no longer uses.
// Texts are found as t("…"), tIn(x, "…") and in the constant tables the code
// passes to t() (the rail, the ledes, the functions, the bell roles).
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = ["pages/index.js", "components/Status.js", "components/Codes.js", "components/Labels.js"].map((f) => path.join(root, f));
const unq = (s) => JSON.parse(s);
const used = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/\b(?:t\(|tIn\([\w.]+,\s*)("(?:[^"\\]|\\.)*")/g)) used.add(unq(m[1]));
  // constant tables: SECTIONS, LEDE, KIND_LABEL, BELL_LABEL, the theme names
  for (const block of src.matchAll(/const (SECTIONS|LEDE|KIND_LABEL|BELL_LABEL) = ([\s\S]*?\n?\};|\[[\s\S]*?\n\];)/g)) {
    for (const m of block[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const s = unq('"' + m[1] + '"');
      if (/\s|^[A-Z]/.test(s) && !/^[a-z]+$/.test(s)) used.add(s);
    }
  }
}
used.add("dark"); used.add("light");

let bad = 0;
for (const lang of ["de", "fr"]) {
  const dict = (await import(pathToFileURL(path.join(root, "i18n", lang + ".js")).href)).default;
  const missing = [...used].filter((k) => !(k in dict));
  const extra = Object.keys(dict).filter((k) => !used.has(k));
  for (const k of missing) { console.log(`${lang}: missing  ${JSON.stringify(k)}`); bad++; }
  for (const k of extra) console.log(`${lang}: unused   ${JSON.stringify(k)}`);
  console.log(`${lang}: ${Object.keys(dict).length} entries, ${missing.length} missing, ${extra.length} unused`);
}
process.exit(bad ? 1 : 0);
