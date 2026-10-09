#!/usr/bin/env node
// Looks outside over Alexandria and redraws the window in the README.
// Runs every hour on GitHub Actions. No dependencies, Node 20+.

import { mkdir, writeFile } from "node:fs/promises";

const PLACE = { name: "Alexandria", lat: 31.2001, lon: 29.9187, tz: "Africa/Cairo" };

// What the caption says at each time of day. Make these yours.
const MOODS = {
  lateNight: "Still up. Probably rewriting something that already worked.",
  dawn: "First light over the Mediterranean.",
  morning: "Morning in Alexandria.",
  afternoon: "Afternoon. The sea is doing its thing.",
  golden: "Golden hour on the Corniche.",
  dusk: "The sun just slipped into the sea.",
  evening: "Evening by the sea. Good time to build something.",
  rain: "It's raining in Alexandria. Doesn't happen often.",
  storm: "Thunderstorm over the Mediterranean.",
  fog: "Fog over the harbor. Can barely see the lighthouse.",
};

const OUT = new URL(process.env.WINDOW_OUT ? `file://${process.env.WINDOW_OUT}/` : "../window/", import.meta.url);

// ------------------------------------------------------------------ time
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

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

// NOAA sunrise equation, used when the weather API can't be reached.
function solarEvents(dayLocal) {
  const d = new Date(dayLocal);
  const n = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
  const g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const lat = PLACE.lat * Math.PI / 180;
  const ha = Math.acos(Math.cos(90.833 * Math.PI / 180) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl)) * 180 / Math.PI;
  const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const toLocal = (mins) => { const u = midnightUtc + mins * MIN; return u + tzOffset(u); };
  return { rise: toLocal(720 - 4 * (PLACE.lon + ha) - eq), set: toLocal(720 - 4 * (PLACE.lon - ha) - eq) };
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
  95: "thunderstorm", 96: "thunderstorm, hail", 99: "thunderstorm, hail",
};
const isRain = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const isStorm = (c) => c >= 95;
const isFog = (c) => c === 45 || c === 48;

// ------------------------------------------------------------------ the moment
function moment(t, events) {
  const prev = events.filter((e) => e.at <= t.local).at(-1);
  const next = events.find((e) => e.at > t.local);
  const day = prev.kind === "rise";
  const f = (t.local - prev.at) / (next.at - prev.at);
  const elev = (day ? 1 : -1) * Math.sin(Math.PI * f); // -1 midnight .. 0 horizon .. 1 noon
  const since = (t.local - prev.at) / MIN, until = (next.at - t.local) / MIN;
  const hour = new Date(t.local).getUTCHours();
  let mood;
  if (day) mood = until <= 45 ? "golden" : since <= 40 ? "dawn" : hour < 12 ? "morning" : "afternoon";
  else mood = since <= 45 ? "dusk" : until <= 50 ? "dawn" : hour < 12 ? "lateNight" : "evening";
  return { day, f, elev, mood };
}

function moonPhase(utc) {
  const synodic = 29.530588853;
  const age = (((utc - Date.UTC(2000, 0, 6, 18, 14)) / DAY) % synodic + synodic) % synodic;
  const p = age / synodic;
  return { lit: (1 - Math.cos(2 * Math.PI * p)) / 2, waxing: p < 0.5 };
}

// ------------------------------------------------------------------ color
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

const SKY = [
  [-1.0, "#03060f", "#070d1f", "#0d1730"],
  [-0.35, "#050a18", "#0b1530", "#16224a"],
  [-0.12, "#0d1838", "#25285a", "#4a3266"],
  [-0.03, "#1c2b5c", "#6a4a7e", "#e07a6a"],
  [0.0, "#2f4a86", "#b0748a", "#f79a5e"],
  [0.08, "#43699f", "#c79a8e", "#f8b977"],
  [0.18, "#4f86c9", "#a9c0d8", "#f1d5aa"],
  [0.35, "#3f86d8", "#86bce9", "#cfe6f5"],
  [1.0, "#2a7de0", "#6fb2ee", "#bfe0f7"],
];
function skyAt(e) {
  const i = Math.max(0, SKY.findIndex((k) => k[0] >= e) - 1);
  const [a, b] = [SKY[i], SKY[Math.min(i + 1, SKY.length - 1)]];
  const t = b[0] === a[0] ? 0 : clamp((e - a[0]) / (b[0] - a[0]));
  return [1, 2, 3].map((j) => mix(a[j], b[j], t));
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const n1 = (v) => Math.round(v * 10) / 10;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------ drawing
const W = 900, SH = 330, H = 420, HZ = 232, BASE = HZ - 7;
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

function scene({ m, weather, moon }) {
  const code = weather?.code ?? 0;
  const rain = isRain(code), storm = isStorm(code), fog = isFog(code);
  const cloud = clamp((weather?.cloud ?? 10) / 100);
  const [top, mid, bottom] = skyAt(m.elev);
  const dayness = clamp((m.elev + 0.05) / 0.3);
  const glow = clamp(1 - Math.abs(m.elev) / 0.22) * (1 - cloud * 0.7) * (rain || fog ? 0.2 : 1);

  const grey = rain ? mix("#12161d", "#5d6875", dayness) : fog ? mix("#2a2f38", "#c1c8cf", dayness) : mix("#1a1f2a", "#9aa6b4", dayness);
  const overcast = clamp(cloud * 0.2 + clamp((cloud - 0.5) / 0.5) * 0.45 + (rain ? 0.35 : 0) + (storm ? 0.15 : 0) + (fog ? 0.55 : 0));
  const sky = [top, mid, bottom].map((c) => mix(c, grey, overcast));
  const hidden = rain || cloud > 0.9;
  let seaTop = mix(sky[2], mix("#04101f", "#0f4c74", dayness), 0.62);
  const warm = clamp(1 - Math.abs(m.elev) / 0.3) * (1 - cloud * 0.7) * (rain || fog ? 0 : 1);
  seaTop = mix(seaTop, mix(sky[2], "#2b3354", 0.45), warm * 0.7);
  const seaBot = mix(seaTop, "#020610", 0.55);
  const stone = mix(seaTop, "#000000", 0.55 - dayness * 0.15);
  const far = mix(stone, sky[2], 0.32);
  const lights = m.elev < 0.02 || fog;
  const parts = [];

  // sky + horizon glow
  const sunX = W - 80 - m.f * (W - 160);
  const glowX = m.day ? sunX : m.f < 0.5 ? 80 : W - 80;
  parts.push(`<rect width="${W}" height="${SH}" fill="url(#sky)"/>`);
  if (glow > 0.02) parts.push(`<ellipse cx="${n1(glowX)}" cy="${HZ}" rx="420" ry="150" fill="url(#glow)" opacity="${n1(glow)}"/>`);

  // stars
  const starVis = clamp((-m.elev - 0.06) / 0.2) * (1 - cloud * 0.9);
  if (starVis > 0.02) {
    const r = rng(7);
    for (let i = 0; i < 80; i++) {
      const x = r() * W, y = r() * (HZ - 30), s = 0.5 + r() * 1.1, o = (0.35 + r() * 0.65) * starVis;
      const tw = r() < 0.3 ? ` class="tw" style="animation-duration:${n1(3 + r() * 4)}s;animation-delay:-${n1(r() * 6)}s"` : "";
      parts.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${n1(s)}" fill="#ffffff" opacity="${n1(o)}"${tw}/>`);
    }
  }

  // sun or moon
  let body = null, sunCol = "#fff6dc";
  if (m.day) {
    const y = HZ - Math.sin(Math.PI * m.f) * 190;
    const col = mix("#ffb067", "#fff6dc", clamp(m.elev / 0.3));
    const o = n1(fog ? 0.35 : 1 - cloud * 0.5);
    sunCol = col;
    if (!hidden) parts.push(`<circle cx="${n1(sunX)}" cy="${n1(y)}" r="70" fill="url(#sunglow)" opacity="${o}"/>`,
      `<circle cx="${n1(sunX)}" cy="${n1(y)}" r="19" fill="${col}" opacity="${hidden ? 0 : o}"/>`);
    body = hidden ? null : { x: sunX, col, strength: clamp(1 - cloud * 0.8) * (fog ? 0.25 : 1) };
  } else {
    const x = W - 110 - m.f * (W - 220), y = HZ - 40 - Math.sin(Math.PI * m.f) * 140, r = 14;
    const o = n1(1 - cloud * 0.7);
    const rx = n1(r * Math.abs(1 - 2 * moon.lit));
    const term = (moon.lit < 0.5) !== moon.waxing ? 1 : 0;
    const path = `M${n1(x)} ${n1(y - r)}A${r} ${r} 0 0 ${moon.waxing ? 1 : 0} ${n1(x)} ${n1(y + r)}A${rx} ${r} 0 0 ${term} ${n1(x)} ${n1(y - r)}Z`;
    if (!hidden && !fog) parts.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="60" fill="url(#moonglow)" opacity="${n1(o * moon.lit * 0.9)}"/>`,
      `<circle cx="${n1(x)}" cy="${n1(y)}" r="${r}" fill="#c9cfdd" opacity="${hidden || fog ? 0 : n1(o * 0.1)}"/>`,
      `<path d="${path}" fill="#f1ecdc" opacity="${hidden || fog ? 0 : o}"/>`);
    body = hidden || fog ? null : { x, col: "#f1ecdc", strength: moon.lit * clamp(1 - cloud * 0.8) * 0.75 };
  }

  // clouds
  if (cloud > 0.1) {
    const r = rng(11), count = Math.round(2 + cloud * 8 + (rain ? 6 : 0));
    const fill = rain ? mix(grey, "#000000", 0.12) : mix(mix(mix("#2a3550", "#ffffff", dayness), "#ffc9a6", glow * 0.55), sky[1], 0.15 + overcast * 0.5);
    for (let i = 0; i < count; i++) {
      const x = r() * (W + 100) - 50, y = (rain ? 10 : 25) + r() * (HZ - (rain ? 130 : 100)), s = 0.6 + r() * 0.9 + (rain ? 0.6 : 0);
      const puffs = [[0, 0, 52, 13], [-34, 5, 32, 9], [36, 4, 36, 10], [6, -8, 30, 11]]
        .map(([dx, dy, rx, ry]) => `<ellipse cx="${n1(dx * s)}" cy="${n1(dy * s)}" rx="${n1(rx * s)}" ry="${n1(ry * s)}"/>`).join("");
      parts.push(`<g class="drift" style="animation-duration:${n1(50 + r() * 40)}s;animation-delay:-${n1(r() * 40)}s" opacity="${n1(0.55 + cloud * 0.35)}"><g transform="translate(${n1(x)} ${n1(y)})" fill="${fill}">${puffs}</g></g>`);
    }
    if (cloud > 0.8 || rain || fog) parts.push(`<rect width="${W}" height="${HZ}" fill="${grey}" opacity="${n1(0.18 + cloud * 0.15 + (rain ? 0.15 : 0))}"/>`);
  }

  // birds on calm days
  if (m.day && m.elev > 0.1 && cloud < 0.6 && !rain) {
    const r = rng(23);
    for (let i = 0; i < 3; i++) {
      const x = 180 + r() * 380, y = 70 + r() * 70, s = 0.8 + r() * 0.5;
      parts.push(`<g class="bird" style="animation-delay:-${n1(r() * 30)}s"><path transform="translate(${n1(x)} ${n1(y)}) scale(${n1(s)})" d="M0 0q4-4 8 0q4-4 8 0" fill="none" stroke="${stone}" stroke-width="1.4" stroke-linecap="round"/></g>`);
    }
  }

  // sea
  parts.push(`<rect y="${HZ}" width="${W}" height="${SH - HZ}" fill="url(#sea)"/>`);
  if (body && body.strength > 0.05) {
    const r = rng(31);
    for (let i = 0; i < 14; i++) {
      const y = HZ + 5 + i * 6.6, w = (10 + i * 4.5) * (0.6 + r() * 0.8);
      parts.push(`<rect class="glint" style="animation-delay:-${n1(r() * 3)}s" x="${n1(body.x - w / 2 + (r() - 0.5) * 8)}" y="${n1(y)}" width="${n1(w)}" height="1.6" rx=".8" fill="${body.col}" opacity="${n1((0.6 - i * 0.03) * body.strength)}"/>`);
    }
  }
  {
    const r = rng(41), wave = mix(seaTop, "#ffffff", 0.22);
    for (let i = 0; i < 10; i++) {
      const y = HZ + 4 + (SH - HZ - 8) * Math.pow((i + 1) / 10, 1.7);
      const a = 20 + r() * 70, b = 30 + r() * 110;
      parts.push(`<line class="wave" style="--d:${-n1((a + b) * 2)}px;animation-duration:${n1(16 + r() * 22)}s" x1="0" x2="${W}" y1="${n1(y)}" y2="${n1(y)}" stroke="${wave}" stroke-width="${n1(0.7 + i * 0.09)}" stroke-dasharray="${n1(a)} ${n1(b)}" opacity="${n1(0.12 + i * 0.025)}"/>`);
    }
  }

  // the far shore: the Corniche, low and hazy
  {
    const r = rng(5);
    let x = 0;
    while (x < 470) {
      const w = 10 + r() * 24, h = r() < 0.15 ? 14 + r() * 12 : 4 + r() * 10;
      parts.push(`<rect x="${n1(x)}" y="${n1(HZ - h)}" width="${n1(w + 0.5)}" height="${n1(h)}" fill="${far}"/>`);
      if (lights) for (let k = 0; k < 3; k++) if (r() < 0.35) parts.push(`<rect x="${n1(x + 2 + r() * (w - 4))}" y="${n1(HZ - 2 - r() * (h - 3))}" width="1.4" height="1.4" fill="#ffd58a" opacity="${n1(0.5 + r() * 0.4)}"/>`);
      x += w;
    }
    if (lights) for (let lx = 3; lx < 470; lx += 9) parts.push(`<circle cx="${lx}" cy="${HZ - 0.8}" r=".8" fill="#ffcf7a" opacity=".55"/>`);
  }

  // the citadel and the lighthouse
  const S = [];
  S.push(`<path d="M575 ${HZ}L605 ${BASE + 1}L${W} ${BASE - 1}V${HZ}Z"/>`, `<rect x="500" y="${BASE - 1}" width="110" height="${HZ - BASE + 1}"/>`);
  S.push(`<rect x="640" y="${BASE - 30}" width="220" height="31"/>`);
  for (let x = 640; x < 858; x += 10) S.push(`<rect x="${x}" y="${BASE - 35}" width="5" height="6"/>`);
  for (const x of [632, 850]) {
    S.push(`<rect x="${x}" y="${BASE - 40}" width="18" height="41"/>`);
    for (let k = 0; k < 3; k++) S.push(`<rect x="${x + k * 7}" y="${BASE - 45}" width="4" height="6"/>`);
  }
  S.push(`<rect x="718" y="${BASE - 66}" width="64" height="37"/>`);
  for (let x = 718; x < 780; x += 9) S.push(`<rect x="${x}" y="${BASE - 71}" width="5" height="6"/>`);
  for (const x of [713, 777]) S.push(`<rect x="${x}" y="${BASE - 74}" width="10" height="45"/>`);
  S.push(`<rect x="746" y="${BASE - 96}" width="8" height="31"/>`, `<rect x="742" y="${BASE - 85}" width="16" height="3"/>`,
    `<circle cx="750" cy="${BASE - 97}" r="4.5"/>`, `<rect x="749.4" y="${BASE - 106}" width="1.2" height="6"/>`);
  S.push(`<path d="M533 ${BASE}L547 ${BASE}L544 ${BASE - 50}L536 ${BASE - 50}Z"/>`, `<rect x="532" y="${BASE - 53}" width="16" height="3"/>`,
    `<path d="M533 ${BASE - 62}L547 ${BASE - 62}L540 ${BASE - 69}Z"/>`);
  if (lights) {
    const ox = 540, oy = BASE - 57.5;
    parts.push(`<g class="beam" style="transform-origin:${ox}px ${oy}px"><path d="M${ox} ${oy}L${ox - 420} ${oy - 34}L${ox - 420} ${oy + 22}Z" fill="url(#beam)" opacity="${fog ? 0.9 : 0.6}"/></g>`);
  }
  parts.push(`<g fill="${stone}">${S.join("")}</g>`);
  parts.push(`<rect x="535" y="${BASE - 62}" width="10" height="9" fill="${lights ? "#ffe3a3" : mix(stone, sky[2], 0.3)}"/>`);
  if (lights) {
    parts.push(`<circle class="lamp" cx="540" cy="${BASE - 57.5}" r="16" fill="url(#lampglow)"/>`);
    for (const [x, y] of [[730, BASE - 52], [764, BASE - 52], [660, BASE - 18]]) parts.push(`<rect x="${x}" y="${y}" width="3" height="5" fill="#ffcf7a" opacity=".8"/>`);
  }

  // weather on top
  if (fog) parts.push(`<rect width="${W}" height="${SH}" fill="url(#fog)"/>`);
  if (rain) {
    const r = rng(53), drops = storm ? 140 : 90, col = mix("#ffffff", sky[1], 0.4);
    for (let i = 0; i < drops; i++) {
      const x = r() * (W + 80), y = r() * SH - 40;
      parts.push(`<line class="drop" style="animation-duration:${n1(0.6 + r() * 0.5)}s;animation-delay:-${n1(r())}s" x1="${n1(x)}" y1="${n1(y)}" x2="${n1(x - 5)}" y2="${n1(y + 15)}" stroke="${col}" stroke-width="1" opacity="${n1(0.25 + r() * 0.3)}"/>`);
    }
  }
  if (storm) parts.push(`<rect class="flash" width="${W}" height="${SH}" fill="#e8ecff"/>`);

  const defs = `
  <clipPath id="frame"><rect width="${W}" height="${SH}" rx="18"/></clipPath>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset=".62" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[2]}"/></linearGradient>
  <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${seaTop}"/><stop offset="1" stop-color="${seaBot}"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#ffb27a" stop-opacity=".75"/><stop offset="1" stop-color="#ffb27a" stop-opacity="0"/></radialGradient>
  <radialGradient id="sunglow"><stop offset="0" stop-color="${sunCol}" stop-opacity=".55"/><stop offset="1" stop-color="${sunCol}" stop-opacity="0"/></radialGradient>
  <radialGradient id="moonglow"><stop offset="0" stop-color="#e9e4cf" stop-opacity=".35"/><stop offset="1" stop-color="#e9e4cf" stop-opacity="0"/></radialGradient>
  <radialGradient id="lampglow"><stop offset="0" stop-color="#ffe3a3" stop-opacity=".7"/><stop offset="1" stop-color="#ffe3a3" stop-opacity="0"/></radialGradient>
  <linearGradient id="beam" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#fff1c8" stop-opacity=".55"/><stop offset="1" stop-color="#fff1c8" stop-opacity="0"/></linearGradient>
  <linearGradient id="fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${grey}" stop-opacity=".25"/><stop offset=".68" stop-color="${grey}" stop-opacity=".72"/><stop offset="1" stop-color="${grey}" stop-opacity=".4"/></linearGradient>`;

  return { defs, body: `<g clip-path="url(#frame)">${parts.join("")}<rect x=".5" y=".5" width="${W - 1}" height="${SH - 1}" rx="18" fill="none" stroke="#ffffff" stroke-opacity=".07"/></g>` };
}

const THEMES = {
  dark: { text: "#e6edf3", muted: "#9198a1" },
  light: { text: "#1f2328", muted: "#59636e" },
};

function svg(theme, s, caption) {
  const c = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t">
<title id="t">${esc(caption.alt)}</title>
<style>
  .tw { animation: tw 4s ease-in-out infinite alternate; }
  .drift { animation: drift 60s ease-in-out infinite alternate; }
  .bird { animation: bird 40s ease-in-out infinite alternate; }
  .glint { animation: glint 2.6s ease-in-out infinite alternate; }
  .wave { animation: wave 24s linear infinite; }
  .beam { animation: beam 7s ease-in-out infinite alternate; }
  .lamp { animation: lamp 3.5s ease-in-out infinite alternate; }
  .drop { animation: drop .8s linear infinite; }
  .flash { opacity: 0; animation: flash 9s linear infinite; }
  @keyframes tw { from { opacity: .15; } }
  @keyframes drift { to { transform: translateX(40px); } }
  @keyframes bird { to { transform: translate(-90px, 12px); } }
  @keyframes glint { from { opacity: .15; } }
  @keyframes wave { to { stroke-dashoffset: var(--d); } }
  @keyframes beam { from { transform: rotate(-9deg); } to { transform: rotate(7deg); } }
  @keyframes lamp { from { opacity: .55; } to { opacity: 1; } }
  @keyframes drop { to { transform: translate(-20px, 60px); } }
  @keyframes flash { 0%, 91%, 93.5%, 95%, 100% { opacity: 0; } 92% { opacity: .55; } 94.2% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } .flash { opacity: 0; } }
  .mood { font: 500 23px ${SANS}; fill: ${c.text}; letter-spacing: -.2px; }
  .meta { font: 400 17px ${MONO}; fill: ${c.muted}; }
</style>
<defs>${s.defs}</defs>
${s.body}
<text class="mood" x="4" y="${SH + 42}">${esc(caption.mood)}</text>
<text class="meta" x="4" y="${SH + 75}">${esc(caption.meta)}</text>
<text class="meta" x="${W - 4}" y="${SH + 75}" text-anchor="end">${esc(caption.note)}</text>
</svg>`;
}

// ------------------------------------------------------------------ go
const t = now();
const { weather, events } = await lookOutside(t);
const m = moment(t, events);
const moon = moonPhase(t.utc);
const code = weather?.code;
const mood = code == null ? m.mood : isStorm(code) ? "storm" : isRain(code) ? "rain" : isFog(code) ? "fog" : m.mood;
const hhmm = new Date(t.local).toISOString().slice(11, 16);
const meta = [PLACE.name, weather && `${Math.round(weather.temp)}°C`, weather && SKY_WORDS[code]].filter(Boolean).join("  ·  ");
const caption = {
  meta, mood: MOODS[mood], note: `looked outside at ${hhmm}`,
  alt: `A window over the sea in ${PLACE.name} at ${hhmm}${weather ? `, ${SKY_WORDS[code]}` : ""}. ${MOODS[mood]}`,
};
const s = scene({ m, weather, moon });

await mkdir(OUT, { recursive: true });
for (const theme of Object.keys(THEMES)) await writeFile(new URL(`window-${theme}.svg`, OUT), svg(theme, s, caption));
console.log(`${hhmm} · ${mood} · elevation ${n1(m.elev)} · moon ${Math.round(moon.lit * 100)}% · ${meta}`);
