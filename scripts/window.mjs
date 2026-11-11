#!/usr/bin/env node
// Looks outside over Alexandria and redraws the almanac in the README: the
// sun's path for the day, where the sun and the moon are on it now, and in
// the margin a note about the weather and the day's figures. Runs every hour on GitHub Actions.
// No dependencies, Node 20+.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const PLACE = { name: "Alexandria", country: "Egypt", lat: 31.2001, lon: 29.9187, tz: "Africa/Cairo" };

const OUT = new URL(process.env.WINDOW_OUT ? `file://${process.env.WINDOW_OUT}/` : "../window/", import.meta.url);

// The picture is set in mohanadtarek.com's type and colours. An SVG shown
// through <img> cannot load a webfont, and this file has no dependencies to
// shape text with, so scripts/type.py hands it both ready-made: the site's
// palette and measure, and every glyph of the three styles used here.
const SITE = JSON.parse(await readFile(new URL("../type/atlas.json", import.meta.url), "utf8"));

// ------------------------------------------------------------------ time
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const RAD = Math.PI / 180;

function tzOffset(utcMs, tz = PLACE.tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

// All times below are "local wall clock as if it were UTC" so they compare cleanly.
function now() {
  if (process.env.WINDOW_AT) {
    const local = Date.parse(process.env.WINDOW_AT + "Z");
    return { local, utc: local - tzOffset(local - tzOffset(local)) };
  }
  const utc = Date.now();
  return { local: utc + tzOffset(utc), utc };
}

// NOAA's solar approximations: the equation of time in minutes and the sun's
// declination in radians, for a fractional year g.
function solar(g) {
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  return { eq, decl };
}

const dayOfYear = (ms) => Math.floor((ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / DAY) + 1;

// Sunrise and sunset, used when the weather API can't be reached.
function solarEvents(dayLocal) {
  const d = new Date(dayLocal);
  const { eq, decl } = solar((2 * Math.PI / 365) * (dayOfYear(dayLocal) - 1));
  const lat = PLACE.lat * RAD;
  const ha = Math.acos(Math.cos(90.833 * RAD) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl)) / RAD;
  const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const toLocal = (mins) => { const u = midnightUtc + mins * MIN; return u + tzOffset(u); };
  return { rise: toLocal(720 - 4 * (PLACE.lon + ha) - eq), set: toLocal(720 - 4 * (PLACE.lon - ha) - eq) };
}

// The sun's height above the horizon in degrees, at a moment in real UTC.
function sunElevation(utc) {
  const hours = (((utc % DAY) + DAY) % DAY) / HOUR;
  const { eq, decl } = solar((2 * Math.PI / 365) * (dayOfYear(utc) - 1 + (hours - 12) / 24));
  const solarMinutes = hours * 60 + eq + 4 * PLACE.lon;
  const hourAngle = (solarMinutes / 4 - 180) * RAD;
  const lat = PLACE.lat * RAD;
  return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)) / RAD;
}

// ------------------------------------------------------------------ weather
async function lookOutside(t) {
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: PLACE.lat, longitude: PLACE.lon, timezone: PLACE.tz, past_days: 1, forecast_days: 2,
    current: "temperature_2m,weather_code,cloud_cover", daily: "sunrise,sunset",
  });
  let weather = null, events = null;
  if (!process.env.WINDOW_OFFLINE) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      weather = { temp: j.current.temperature_2m, code: j.current.weather_code, cloud: j.current.cloud_cover };
      events = [
        ...j.daily.sunrise.map((s) => ({ at: Date.parse(s + ":00Z"), kind: "rise" })),
        ...j.daily.sunset.map((s) => ({ at: Date.parse(s + ":00Z"), kind: "set" })),
      ];
    } catch (err) {
      console.warn(`Weather API unavailable (${err.message}); drawing from astronomy alone.`);
    }
  }
  if (process.env.WINDOW_WEATHER) weather = JSON.parse(process.env.WINDOW_WEATHER);
  if (!events) {
    events = [-1, 0, 1].flatMap((k) => {
      const { rise, set } = solarEvents(t.local + k * DAY);
      return [{ at: rise, kind: "rise" }, { at: set, kind: "set" }];
    });
  }
  events.sort((a, b) => a.at - b.at);
  return { weather, events };
}

const SKY_WORDS = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

// ------------------------------------------------------------------ the moon
function moonPhase(utc) {
  const synodic = 29.530588853;
  const age = (((utc - Date.UTC(2000, 0, 6, 18, 14)) / DAY) % synodic + synodic) % synodic;
  const p = age / synodic;
  return { p, lit: (1 - Math.cos(2 * Math.PI * p)) / 2, waxing: p < 0.5 };
}

function moonName({ lit, waxing }) {
  if (lit < 0.02) return "New";
  if (lit > 0.98) return "Full";
  if (Math.abs(lit - 0.5) < 0.04) return `${waxing ? "First" : "Last"} quarter`;
  return `${waxing ? "Waxing" : "Waning"} ${lit < 0.5 ? "crescent" : "gibbous"}, ${Math.round(lit * 100)}%`;
}

// ------------------------------------------------------------------ words
const clock = (local) => new Date(local).toISOString().slice(11, 16);
const sameDay = (a, b) => Math.floor(a / DAY) === Math.floor(b / DAY);

// What the picture says beside itself, and to someone who cannot see it.
function note(t, weather, events) {
  const prev = events.filter((e) => e.at <= t.local).at(-1);
  const next = events.find((e) => e.at > t.local);
  const out = [];
  if (weather) {
    const sky = SKY_WORDS[weather.code] ?? "weather unknown";
    out.push(`${sky[0].toUpperCase()}${sky.slice(1)}, ${Math.round(weather.temp).toString().replace("-", "−")}°C.`);
  }
  if (prev.kind === "rise") out.push(`The sun is up until ${clock(next.at)}.`);
  else if (sameDay(prev.at, t.local)) out.push(`The sun set at ${clock(prev.at)}.`);
  else out.push(`The sun rises at ${clock(next.at)}.`);
  return out.join(" ");
}

// ------------------------------------------------------------------ type
const n1 = (v) => Math.round(v * 10) / 10;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Every glyph the picture uses is defined once and placed by reference.
const defs = new Map();

function glyphId(styleName, key) {
  const id = styleName[0] + [...key].map((c) => c.codePointAt(0).toString(36)).join("-");
  if (!defs.has(id)) defs.set(id, SITE.styles[styleName].glyphs[key][1]);
  return id;
}

// One line of text as glyphs and positions, in font units: ligatures where the
// font has them, kerning between neighbours, then the style's letter-spacing.
function shape(text, styleName) {
  const style = SITE.styles[styleName];
  const tracking = style.letterSpacing * style.upem;
  const run = [];
  let x = 0;
  for (let i = 0; i < text.length;) {
    const key = [3, 2, 1].map((n) => text.slice(i, i + n)).find((k) => k.length && style.glyphs[k]) ?? "?";
    const next = text[i + key.length];
    run.push({ key, x });
    x += style.glyphs[key][0] + tracking + (key.length === 1 && next ? style.kerning[key + next] ?? 0 : 0);
    i += Math.max(1, key.length);
  }
  return { run, width: (x - (run.length ? tracking : 0)) * style.px / style.upem };
}

// A line set at a baseline. `anchor` is where x falls on it: start, middle or end.
function line(text, styleName, x, baseline, fill, anchor = "start") {
  const style = SITE.styles[styleName];
  const { run, width } = shape(text, styleName);
  const left = x - (anchor === "end" ? width : anchor === "middle" ? width / 2 : 0);
  const scale = style.px / style.upem;
  const uses = run
    .filter(({ key }) => style.glyphs[key][1])
    .map(({ key, x: gx }) => `<use href="#${glyphId(styleName, key)}" x="${gx}"/>`).join("");
  return `<g fill="${fill}" transform="translate(${n1(left)},${n1(baseline)}) scale(${scale},${-scale})">${uses}</g>`;
}

// Breaks a sentence into lines no longer than the site's measure.
function wrap(text, styleName, maxWidth) {
  const lines = [];
  for (const word of text.split(" ")) {
    const candidate = lines.length ? `${lines.at(-1)} ${word}` : word;
    if (lines.length && shape(candidate, styleName).width <= maxWidth) lines[lines.length - 1] = candidate;
    else lines.push(word);
  }
  return lines;
}

// ------------------------------------------------------------------ drawing
// Laid out as the site lays out a page with sidenotes: the chart in the text
// column, and a gutter away, a note column for the words and the figures.
const W = SITE.measure.copy;
const NOTE_X = W + SITE.measure.gutter;
const FULL = NOTE_X + SITE.measure.note;
const ROW = 26; // one row of the table of figures
const DEGREE = 1; // px of height per degree of elevation
// The highest the sun ever stands here, at noon on the June solstice. The
// chart is drawn to hold it, so the curve's height through the year is real.
const ZENITH = Math.ceil(90 - PLACE.lat + 23.44);

const LABEL_BASELINE = 13;
const CHART_TOP = 62; // below the labels and the time over the now-line
const HORIZON = CHART_TOP + ZENITH * DEGREE;
const CHART_BOTTOM = HORIZON + ZENITH * DEGREE;
const AXIS_BASELINE = CHART_BOTTOM + 34;

function almanac(theme, { t, events, phase, text, figures }) {
  const c = SITE.palette[theme];
  const midnight = Math.floor(t.local / DAY) * DAY;
  const offset = t.local - t.utc;
  const xAt = (local) => ((local - midnight) / DAY) * W;
  const yAt = (degrees) => HORIZON - degrees * DEGREE;
  const parts = [];

  // What is drawn where: place on the left, the date on the far right.
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(t.local));
  parts.push(line(`${PLACE.name}, ${PLACE.country}`.toUpperCase(), "label", 0, LABEL_BASELINE, c.muted));
  parts.push(line(date.replace(",", "").toUpperCase(), "label", FULL, LABEL_BASELINE, c.muted, "end"));

  // The sun's path over the whole day: drawn in full above the horizon, and
  // dotted below it, where it is real but cannot be seen.
  const path = [];
  for (let m = 0; m <= 24 * 60; m += 10) {
    const local = midnight + m * MIN;
    path.push(`${path.length ? "L" : "M"}${n1(xAt(local))} ${n1(yAt(sunElevation(local - offset)))}`);
  }
  parts.push(
    `<clipPath id="up"><rect width="${W}" height="${HORIZON}"/></clipPath>`,
    `<clipPath id="down"><rect y="${HORIZON}" width="${W}" height="${CHART_BOTTOM - HORIZON + 2}"/></clipPath>`,
    `<path d="${path.join("")}" fill="none" stroke="${c.muted}" stroke-width="1" stroke-dasharray="1 4" stroke-linecap="round" clip-path="url(#down)"/>`,
    `<path d="${path.join("")}" fill="none" stroke="${c.fg}" stroke-width="1.25" clip-path="url(#up)"/>`,
    `<path d="M0 ${HORIZON}.5H${W}" stroke="${c.muted}" stroke-width="1"/>`,
  );

  // Now: the present hour, and the heights the sun and the moon stand at. The
  // moon follows the sun's path but runs late by its age, so its height is
  // the sun's that much of a day ago.
  const x = Math.min(W - 7, Math.max(7, xAt(t.local)));
  const sun = sunElevation(t.utc), moon = sunElevation(t.utc - phase.p * DAY);

  // Sunrise and sunset: a tick on the horizon and the time beside it, below
  // the line on the daylight side, where the path is overhead and the space
  // is empty. If the present hour falls on that spot, the time moves to the
  // empty space on the other side: above the line, over the night.
  for (const e of events.filter((e) => sameDay(e.at, t.local))) {
    const tick = Math.round(xAt(e.at)) + 0.5;
    const toDay = e.kind === "rise" ? 1 : -1;
    const taken = (x - tick) * toDay > -12 && (x - tick) * toDay < shape(clock(e.at), "meta").width + 19;
    const side = taken ? -toDay : toDay;
    parts.push(`<path d="M${tick} ${HORIZON - 4}V${HORIZON + 5}" stroke="${c.muted}" stroke-width="1"/>`);
    parts.push(line(clock(e.at), "meta", tick + side * 7, taken ? HORIZON - 8 : HORIZON + 19, c.muted, side > 0 ? "start" : "end"));
  }

  // The hours, along the bottom.
  for (let h = 0; h <= 24; h++) {
    const x = Math.min(W - 0.5, Math.round((h / 24) * W) + 0.5);
    const major = h % 6 === 0;
    parts.push(`<path d="M${x} ${CHART_BOTTOM + 8}v${major ? 7 : 3}" stroke="${c.muted}" stroke-width="1"/>`);
    if (major) parts.push(line(String(h).padStart(2, "0"), "meta", h === 0 ? 0 : h === 24 ? W : x, AXIS_BASELINE, c.muted, h === 0 ? "start" : h === 24 ? "end" : "middle"));
  }

  // A hairline at the present hour, down to whichever of the two is lower.
  const hair = Math.round(x) + 0.5;
  parts.push(`<path d="M${hair} ${CHART_TOP - 6}V${n1(Math.max(HORIZON, yAt(sun), yAt(moon)))}" stroke="${c.rule}" stroke-width="1"/>`);
  parts.push(line(clock(t.local), "meta", Math.min(W - 19, Math.max(19, x)), CHART_TOP - 14, c.fg, "middle"));

  // The moon, as it looks: a ring with its lit part filled in. The bright limb
  // faces the sun, which is to the right of a waxing moon seen from the north.
  {
    const y = yAt(moon), r = 6;
    const rx = n1(r * Math.abs(1 - 2 * phase.lit));
    const right = phase.waxing;
    const term = (phase.lit < 0.5) === right ? 0 : 1;
    const lit = `M${n1(x)} ${n1(y - r)}A${r} ${r} 0 0 ${right ? 1 : 0} ${n1(x)} ${n1(y + r)}A${rx} ${r} 0 0 ${term} ${n1(x)} ${n1(y - r)}Z`;
    if (phase.lit >= 0.02) parts.push(`<path d="${lit}" fill="${c.fg}"/>`);
    parts.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${r - 0.5}" fill="none" stroke="${c.fg}" stroke-width="1"/>`);
  }

  // The sun, in the one colour: solid while it is up, a ring once it has set.
  parts.push(sun >= 0
    ? `<circle cx="${n1(x)}" cy="${n1(yAt(sun))}" r="5" fill="${c.accent}"/>`
    : `<circle cx="${n1(x)}" cy="${n1(yAt(sun))}" r="4.25" fill="none" stroke="${c.accent}" stroke-width="1.5"/>`);

  // The margin. At the top, the note, set as the site sets a sidenote.
  const small = SITE.styles.note, leading = small.px * small.lineHeight;
  const lines = wrap(text, "note", SITE.measure.note);
  const top = CHART_TOP - 32;
  const firstBaseline = top + (leading - (small.ascender - small.descender) * small.px / small.upem) / 2 + small.ascender * small.px / small.upem;
  lines.forEach((l, i) => parts.push(line(l, "note", NOTE_X, firstBaseline + i * leading, c.fg)));

  // Under it, the day's figures as a table: a hairline over each row, the
  // name on the left and the figure on the right. The last row sits on the
  // same baseline as the hours, unless the note above needs the room.
  const noteBottom = top + lines.length * leading;
  const last = Math.max(AXIS_BASELINE, noteBottom + 16 + figures.length * ROW - 8);
  figures.forEach(([name, value], i) => {
    const baseline = last - (figures.length - 1 - i) * ROW;
    parts.push(`<path d="M${NOTE_X} ${baseline - 17.5}H${FULL}" stroke="${c.rule}" stroke-width="1"/>`);
    parts.push(line(name.toUpperCase(), "label", NOTE_X, baseline, c.muted));
    parts.push(line(value, "meta", FULL, baseline, c.fg, "end"));
  });

  return { height: Math.ceil(last + 8), body: parts.join("\n") };
}

function svg(theme, scene) {
  defs.clear();
  const { height, body } = almanac(theme, scene);
  const glyphs = [...defs].map(([id, d]) => `<path id="${id}" d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FULL} ${height}" width="${FULL}" height="${height}" role="img" aria-labelledby="t">
<!-- Drawn by scripts/window.mjs. The type is mohanadtarek.com's, traced by scripts/type.py. -->
<title id="t">${esc(scene.alt)}</title>
<defs>${glyphs}</defs>
${body}
</svg>
`;
}

// ------------------------------------------------------------------ go
const t = now();
const { weather, events } = await lookOutside(t);
const phase = moonPhase(t.utc);
const text = note(t, weather, events);

// The figures for the table. Solar noon is when the sun crosses the meridian:
// 12:00 by the sun, moved by the equation of time and by how far the place
// sits from the middle of its time zone.
const today = events.filter((e) => sameDay(e.at, t.local));
const rise = today.find((e) => e.kind === "rise"), set = today.find((e) => e.kind === "set");
const daylight = Math.round((set.at - rise.at) / MIN);
const dayStart = Math.floor(t.local / DAY) * DAY;
const { eq } = solar((2 * Math.PI / 365) * (dayOfYear(dayStart) - 0.5));
const noonUtc = dayStart + (720 - eq - 4 * PLACE.lon) * MIN;
const degrees = (v) => `${Math.round(v)}\u00b0`.replace("-", "\u2212");
const figures = [
  ["Daylight", `${Math.floor(daylight / 60)} h ${String(daylight % 60).padStart(2, "0")} min`],
  ["Solar noon", `${clock(noonUtc + (t.local - t.utc))}, ${degrees(sunElevation(noonUtc))}`],
  ["Sun height", degrees(sunElevation(t.utc))],
  ["Moon", moonName(phase)],
];

const scene = {
  t, events, phase, text, figures,
  alt: `The sun's path over ${PLACE.name} today, with the sun and the moon where they stand at ${clock(t.local)}. ${text} ${figures.map(([name, value]) => `${name}: ${value}.`).join(" ")}`,
};

await mkdir(OUT, { recursive: true });
for (const theme of Object.keys(SITE.palette)) await writeFile(new URL(`window-${theme}.svg`, OUT), svg(theme, scene));
console.log(`${clock(t.local)} · ${text} ${figures.map((f) => f.join(" ")).join(" · ")}`);
