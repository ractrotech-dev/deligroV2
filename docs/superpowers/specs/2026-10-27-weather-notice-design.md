# Weather notice for delivery times — design

**Asked for (owner, 2026-10-27):** "weather thing for delivery time, like the way we get a message in the server — weather condition for riders and customers." The owner left the details to Claude ("do it by yourself"). Everything below is Claude's call unless marked.

## What it does

Each delivery zone has a weather state: `clear`, `rain`, `heavy_rain`, `storm` or `heat`.

| Level | Extra minutes on delivery time | Customers see | Riders see |
|---|---|---|---|
| clear | 0 | nothing | nothing |
| rain | +10 | "Rain in <zone>: deliveries may take about 10 minutes longer." | "Rain in <zone>. Ride carefully — customers have been told to expect delays." |
| heavy_rain | +20 | "Heavy rain …about 20 minutes longer." | "Heavy rain … slow down; wet roads." |
| storm | +30 | "Storm …about 30 minutes longer." | "Storm … take shelter if it is unsafe; delays are expected." |
| heat | +5 | "Very hot in <zone>: deliveries may take a little longer." | "Very hot … drink water and take breaks." |

- **Automatic:** the server checks Open-Meteo (free, no key) for each active zone's centre at most every 15 minutes. Mapping: thunderstorm weather codes (95–99) or gusts ≥ 60 km/h → storm; precipitation ≥ 7.6 mm/h → heavy_rain; ≥ 0.5 mm/h → rain; temperature ≥ 43 °C → heat; else clear. A reading older than 3 hours counts as clear (never a stale warning).
- **Manual:** a manager (in that zone) or an admin sets a level for 1–12 hours, or "back to automatic". Manual wins while it lasts. Audited (`zone.weather`).
- **Delivery time:** the extra minutes are added to the advertised band on restaurant cards (web and customer app) and to the road leg of live tracking, so the promise and the countdown both move. Same place the shop's "busy" extra already goes.
- **Riders:** when a zone's level goes up (clear→rain, rain→storm …), riders in that zone get one push + inbox line; the rider home shows the notice while it lasts.
- **Customers:** a banner on the app home and on live tracking.

## Where it runs

- No Vercel cron ships in this project (see `src/app/api/cron/dispatch-sweep`). The refresh runs from `/api/cron/weather` (CRON_SECRET, for an external pinger or pg_cron) **and** opportunistically from the existing throttled dispatch sweep that vendor/rider screens already trigger, throttled to once per 15 minutes per zone by `auto_checked_at`.
- Open-Meteo failing never raises a warning and never clears a manual one; it just leaves the last reading to age out.

## Non-goals

No per-address weather, no forecasts, no surge pricing, no rider pay change (riders are salaried), no Hindi (manager side English only; customer copy is English like the rest).

## Permission

`manager.weather.manage` ("Weather notices", default on — low risk, operational). Admins always.
