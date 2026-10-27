/**
 * QA — weather notices (0178): reading Open-Meteo into a level, the extra
 * minutes, what customers and riders are told, when riders get a push, and the
 * extra minutes reaching the advertised band.
 * Usage: npx tsx scripts/qa/weather.ts
 */
import { readFileSync } from "node:fs";
import {
  customerWeatherText,
  levelFromReading,
  riderWeatherText,
  shouldTellRiders,
  weatherExtraMinutes,
  weatherMinutesFor,
  isWeatherLevel,
  parseWeatherOverride,
} from "../../src/lib/weather/levels";
import { kitchenPace } from "../../src/lib/orders/kitchen-pace";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra === undefined ? "" : `\n         ${JSON.stringify(extra)}`}`); }
}
const r = (o: Partial<{ precipitation: number; weatherCode: number; gusts: number; temperature: number }>) =>
  levelFromReading({ precipitation: 0, weatherCode: 0, gusts: 0, temperature: 30, ...o });

console.log("\n── reading ──");
check("dry and mild is clear", r({}) === "clear");
check("0.5 mm/h is rain", r({ precipitation: 0.5 }) === "rain");
check("7.6 mm/h is heavy rain", r({ precipitation: 7.6 }) === "heavy_rain");
check("a thunderstorm code is a storm, even with little rain", r({ weatherCode: 95, precipitation: 0.2 }) === "storm");
check("gusts of 60 km/h are a storm", r({ gusts: 60 }) === "storm");
check("43 °C is heat", r({ temperature: 43 }) === "heat");
check("rain wins over heat", r({ temperature: 44, precipitation: 1 }) === "rain");
check("a missing number counts as nothing, not a warning", levelFromReading({ precipitation: NaN, weatherCode: NaN, gusts: NaN, temperature: NaN }) === "clear");

console.log("\n── minutes and words ──");
check("extra minutes match 0178", weatherExtraMinutes("clear") === 0 && weatherExtraMinutes("rain") === 10 && weatherExtraMinutes("heavy_rain") === 20
  && weatherExtraMinutes("storm") === 30 && weatherExtraMinutes("heat") === 5);
check("customers are told the zone and the minutes", customerWeatherText("rain", "Bemetara") === "Rain in Bemetara: deliveries may take about 10 minutes longer.");
check("riders are told to ride carefully", /ride carefully/i.test(riderWeatherText("rain", "Bemetara").body));
check("nothing to say when clear", customerWeatherText("clear", "Bemetara") === "");
check("levels are a closed list", isWeatherLevel("storm") && !isWeatherLevel("snow"));

console.log("\n── when riders are pushed ──");
check("clear → rain: tell them", shouldTellRiders("clear", "rain"));
check("rain → storm: tell them", shouldTellRiders("rain", "storm"));
check("storm → rain: not again", !shouldTellRiders("storm", "rain"));
check("rain → clear: no push", !shouldTellRiders("rain", "clear"));
check("heat → rain: tell them", shouldTellRiders("heat", "rain"));

console.log("\n── delivery time ──");
const map = new Map([["z1", 20]]);
check("a shop in a zone with weather gets its minutes", weatherMinutesFor(map, "z1") === 20 && weatherMinutesFor(map, "z2") === 0 && weatherMinutesFor(map, null) === 0);
const pace = kitchenPace({ etaMin: 25, etaMax: 35, busyUntil: null, busyExtraMinutes: 0, weatherExtraMinutes: 20 });
check("the advertised band moves by the weather minutes", pace.etaMin === 45 && pace.etaMax === 55, pace);
const both = kitchenPace({ etaMin: 25, etaMax: 35, busyUntil: new Date(Date.now() + 600_000).toISOString(), busyExtraMinutes: 10, weatherExtraMinutes: 10 });
check("busy and weather add up", both.etaMin === 45 && both.etaMax === 55, both);

console.log("\n── manager override ──");
const Z = "11111111-1111-4111-8111-111111111111", K = "22222222-2222-4222-8222-222222222222";
let o = parseWeatherOverride({ zoneId: Z, level: "storm", hours: 3, note: " Cyclone warning ", clientActionId: K });
check("storm for 3 hours with a note", o.ok && o.value.level === "storm" && o.value.hours === 3 && o.value.note === "Cyclone warning", o);
o = parseWeatherOverride({ zoneId: Z, level: "auto", clientActionId: K });
check("'auto' needs no hours", o.ok && o.value.hours === null, o);
check("hours outside 1–12 are refused", !parseWeatherOverride({ zoneId: Z, level: "rain", hours: 13, clientActionId: K }).ok);
check("a level needs hours", !parseWeatherOverride({ zoneId: Z, level: "rain", clientActionId: K }).ok);
check("an unknown level is refused", !parseWeatherOverride({ zoneId: Z, level: "snow", hours: 1, clientActionId: K }).ok);
check("a zone id must be a uuid", !parseWeatherOverride({ zoneId: "a", level: "rain", hours: 1, clientActionId: K }).ok);

console.log("\n── wiring ──");
const tracking = readFileSync("src/lib/data-access/order-tracking.ts", "utf8");
check("live tracking adds the zone's weather", tracking.includes("weatherExtraMinutes"));
const restaurants = readFileSync("src/lib/data-access/restaurants.ts", "utf8");
check("restaurant cards add the zone's weather", restaurants.includes("weatherExtraMinutes"));
const cron = readFileSync("src/app/api/cron/weather/route.ts", "utf8");
check("the cron route needs CRON_SECRET", cron.includes("cronAuthorized("));
const mroute = readFileSync("src/app/api/manager/weather/route.ts", "utf8");
check("setting weather needs manager.weather.manage", mroute.includes('"manager.weather.manage"'));
check("a zone outside the manager's zones is a 404", mroute.includes("scopeZoneIds(") && mroute.includes("not_found"));
const dash = readFileSync("src/app/api/rider/dashboard/route.ts", "utf8");
check("the rider home gets its zones' weather", dash.includes("weatherForRider("));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
