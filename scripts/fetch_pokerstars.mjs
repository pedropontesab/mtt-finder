import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const OUT_PATH = path.join("public", "tournaments.json");
const UA = "mtt-finder/0.1 (public-data; github-actions)";

const URLS = [
  "https://www.pokerstars.it/datafeed_global/tournaments/all.xml",
  "https://www.pokerstars.com/datafeed_global/tournaments/all.xml",
];

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url} (final: ${res.url})`);
  return { text, finalUrl: res.url };
}

function parseMoney(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { raw: "", buyin: null, fee: null, currency: null };
  if (/freeroll/i.test(s)) return { raw: s, buyin: 0, fee: 0, currency: null };

  let currency = null;
  if (s.includes("€")) currency = "EUR";
  if (s.includes("$")) currency = "USD";

  const clean = s.replace(/[€$ ]/g, "");
  const [a, b] = clean.split("+");
  const buyin = a ? Number(a.replace(",", ".")) : null;
  const fee = b ? Number(b.replace(",", ".")) : 0;

  return { raw: s, buyin: Number.isFinite(buyin) ? buyin : null, fee, currency };
}

function findTournamentListDeep(obj) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;

    // Se já for uma lista de torneios
    if (Array.isArray(cur) && cur.length && cur[0]?.start_date && cur[0]?.name) {
      return cur;
    }

    // Caso clássico: algum nó tem a chave "tournament"
    if (cur.tournament) return cur.tournament;

    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function extractTournaments(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // isso ajuda quando tem nós únicos e às vezes arrays:
    isArray: (name, jpath, isLeafNode, isAttribute) => name === "tournament",
  });

  const parsed = parser.parse(xmlText);

  // Debug: mostrar as chaves do topo (uma vez)
  const topKeys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
  console.log("TOP_KEYS:", topKeys.join(", "));

  let candidates =
    parsed?.selected_tournaments?.tournament ??
    parsed?.tournaments?.tournament ??
    parsed?.tournament ??
    findTournamentListDeep(parsed) ??
    [];

  const list = Array.isArray(candidates) ? candidates : [candidates];

  const items = [];
  for (const t of list) {
    const start = t?.start_date;
    const name = t?.name;
    if (!start || !name) continue;

    const money = parseMoney(t?.buy_in_fee);
    const id = sha1(`${start}|${name}`);

    items.push({
      id,
      start_date: start,
      name,
      game: t?.game ?? null,
      buyin_raw: money.raw,
      buyin: money.buyin,
      fee: money.fee,
      currency: money.currency,
      players: t?.["@_players"] ? Number(t["@_players"]) : (t?.players ? Number(t.players) : null),
    });
  }

  items.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  return items.slice(0, 5000);
}

async function main() {
  let xmlText = null;
  let usedUrl = null;
  let finalUrl = null;
  let lastErr = null;

  for (const url of URLS) {
    try {
      const r = await fetchText(url);
      xmlText = r.text;
      usedUrl = url;
      finalUrl = r.finalUrl;

      console.log("USED_URL:", usedUrl);
      console.log("FINAL_URL:", finalUrl);
      console.log("XML_PREFIX:", xmlText.slice(0, 300).replace(/\s+/g, " "));

      break;
    } catch (e) {
      lastErr = e;
      console.error("[FAIL]", url, e.message);
    }
  }

  if (!xmlText) throw new Error(`Failed to fetch any feed. Last error: ${lastErr?.message}`);

  const items = extractTournaments(xmlText);

  if (items.length === 0) {
    throw new Error("Parsed 0 tournaments. Refusing to overwrite tournaments.json with empty data.");
  }

  const payload = {
    meta: {
      generated_at: new Date().toISOString(),
      used_url: usedUrl,
      final_url: finalUrl,
      count: items.length,
    },
    items,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`OK: ${items.length} tournaments written -> ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});