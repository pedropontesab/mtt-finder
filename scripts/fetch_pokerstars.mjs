import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.pokerstars.com/datafeed_global/tournaments/all.xml";

async function run() {

  console.log("Baixando torneios...");

  const response = await fetch(FEED_URL);

  if (!response.ok) {
    throw new Error("Erro ao baixar feed: " + response.status);
  }

  const xml = await response.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_"
  });

  const data = parser.parse(xml);

  let tournaments = [];

  if (data?.tournaments?.tournament) {
    tournaments = data.tournaments.tournament;
  }

  if (!Array.isArray(tournaments)) {
    tournaments = [tournaments];
  }

  const result = tournaments.map(t => ({
    name: t.name,
    start: t.start_date,
    game: t.game,
    buyin: t.buy_in_fee
  }));

  fs.mkdirSync("public", { recursive: true });

  fs.writeFileSync(
    "public/tournaments.json",
    JSON.stringify(result, null, 2)
  );

  console.log("Arquivo criado: public/tournaments.json");
}

run();