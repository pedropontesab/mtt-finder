import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const OUT_PATH = path.join("public", "tournaments.json");
const IT_PATH = path.join("public", "tournaments_it.json");

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
      accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
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

function collectLobbyTypesDeep(obj) {
  const types = new Set();
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;

    if (cur.lobby) {
      const l = cur.lobby;
      const arr = Array.isArray(l) ? l : [l];
      for (const x of arr) {
        const t = x?.["@_type"] ?? x?.type ?? null;
        if (t) types.add(String(t));
      }
    }

    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return [...types].sort();
}

function findTournamentListDeep(obj) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;

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
    isArray: (name) => name === "tournament" || name === "lobby",
  });

  const parsed = parser.parse(xmlText);

  const topKeys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
  console.log("TOP_KEYS:", topKeys.join(", "));

  const lobbyTypes = collectLobbyTypesDeep(parsed);
  console.log("LOBBY_TYPES:", lobbyTypes.length ? lobbyTypes.join(", ") : "(none)");

  // tenta achar lista de torneios
  const candidates =
    parsed?.selected_tournaments?.tournament ??
    parsed?.tournaments?.tournament ??
    parsed?.tournament ??
    findTournamentListDeep(parsed) ??
    [];

  const list = Array.isArray(candidates) ? candidates : [candidates];

  // --- DEBUG: entender lobby dentro do torneio ---
  const total = list.length;
  const withLobbyField = list.filter((t) => t && t.lobby).length;

  const withIT = list.filter((t) => {
    if (!t?.lobby) return false;
    const arr = Array.isArray(t.lobby) ? t.lobby : [t.lobby];
    return arr.some((x) => String(x?.["@_type"] ?? x?.type ?? "") === "IT");
  }).length;

  console.log("DEBUG_TOURNAMENTS_TOTAL:", total);
  console.log("DEBUG_TOURNAMENTS_WITH_LOBBY_FIELD:", withLobbyField);
  console.log("DEBUG_TOURNAMENTS_WITH_IT_IN_LOBBY_FIELD:", withIT);

  if (list[0]) {
    console.log("DEBUG_FIRST_TOURNAMENT_KEYS:", Object.keys(list[0]).slice(0, 40).join(", "));
    console.log("DEBUG_FIRST_TOURNAMENT_HAS_LOBBY:", !!list[0].lobby);
  }

  const exampleWithLobby = list.find((t) => t && t.lobby);
  if (exampleWithLobby) {
    console.log("DEBUG_EXAMPLE_WITH_LOBBY_KEYS:", Object.keys(exampleWithLobby).slice(0, 40).join(", "));
    console.log(
      "DEBUG_EXAMPLE_WITH_LOBBY_LOBBY_FIELD:",
      JSON.stringify(exampleWithLobby.lobby).slice(0, 500)
    );
  }

  // montar items
  const items = [];
  for (const t of list) {
    const start = t?.start_date;
    const name = t?.name;
    if (!start || !name) continue;

    const lobbyTypesForT = new Set();
    if (t?.lobby) {
      const l = Array.isArray(t.lobby) ? t.lobby : [t.lobby];
      for (const x of l) {
        const tp = x?.["@_type"] ?? x?.type ?? null;
        if (tp) lobbyTypesForT.add(String(tp));
      }
    }

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
      lobby_types: [...lobbyTypesForT],
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

      console.log("[OK] fetch:", url);
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
  if (items.length === 0) throw new Error("Parsed 0 tournaments. Refusing to overwrite JSON.");

  const generatedAt = new Date().toISOString();

  // geral
  const payload = {
    meta: {
      generated_at: generatedAt,
      used_url: usedUrl,
      final_url: finalUrl,
      count: items.length,
    },
    items,
  };

  // IT (provisório: vamos consertar depois do debug)
  const itItems = items.filter((t) => (t.lobby_types || []).includes("IT"));

  const itPayload = {
    meta: {
      generated_at: generatedAt,
      used_url: usedUrl,
      final_url: finalUrl,
      filter: "LOBBY=IT (current method)",
      count: itItems.length,
    },
    items: itItems,
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");
  fs.writeFileSync(IT_PATH, JSON.stringify(itPayload, null, 2), "utf-8");

  console.log(`OK: ${items.length} tournaments -> ${OUT_PATH}`);
  console.log(`OK: ${itItems.length} IT tournaments -> ${IT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});