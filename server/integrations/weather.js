'use strict';
/**
 * Weather, free and with no key (Nov 15, Ryan's screenshot: Corbin was asked "find me the weather in long island
 * from today" and searched web pages, then stalled). Open-Meteo: the place is looked up with its free geocoder, then
 * today's conditions and the next days' forecast come back as numbers, so the answer is written in code (no AI, no
 * guessing) in Fahrenheit and mph. Places the geocoder doesn't know as one town (Long Island, upstate...) are mapped
 * to a town in the middle of them.
 */
const safefetch = require('./safefetch');

const GEO = process.env.EUCLIDEAN_WEATHER_GEO_URL || 'https://geocoding-api.open-meteo.com';
const API = process.env.EUCLIDEAN_WEATHER_URL || 'https://api.open-meteo.com';

// Regions people say that aren't one town: a town near their middle.
const REGIONS = {
  'long island': 'Hauppauge, New York', 'li': 'Hauppauge, New York', 'nassau county': 'Mineola, New York', 'suffolk county': 'Hauppauge, New York',
  'the hamptons': 'Southampton, New York', 'hamptons': 'Southampton, New York', 'westchester': 'White Plains, New York', 'westchester county': 'White Plains, New York',
  'upstate new york': 'Syracuse, New York', 'upstate ny': 'Syracuse, New York', 'nyc': 'New York, New York', 'new york city': 'New York, New York', 'the city': 'New York, New York',
  'manhattan': 'New York, New York', 'brooklyn': 'Brooklyn, New York', 'queens': 'Queens, New York', 'the bronx': 'Bronx, New York', 'staten island': 'Staten Island, New York',
  'connecticut': 'Hartford, Connecticut', 'ct': 'Hartford, Connecticut', 'fairfield county': 'Bridgeport, Connecticut', 'new jersey': 'Trenton, New Jersey', 'jersey shore': 'Asbury Park, New Jersey',
};
const STATES = { ny: 'New York', ct: 'Connecticut', nj: 'New Jersey', ma: 'Massachusetts', ri: 'Rhode Island', pa: 'Pennsylvania', ca: 'California', fl: 'Florida', tx: 'Texas' };
const CODES = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail' };

/** Is this a weather question? Returns { place, when } or null. */
function ask(text) {
  const t = String(text || '').toLowerCase();
  if (!/\b(weather|forecast|temperature|temp|how (hot|cold|warm)|rain(ing|y)?|snow(ing|y)?|sunny|humid(ity)?|windy?)\b/.test(t)) return null;
  if (/\b(clip|video|short|music|mood|song|track)\b/.test(t)) return null; // "rainy mood music" is not a forecast
  const DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
  const when = /\btomorrow\b/.test(t) ? 'tomorrow' : /\b(this )?week(end)?\b|next (few )?days\b/.test(t) || DAY.test(t) ? 'week' : 'today';
  // "on Monday in Albany": a day is not a place, so look past it.
  const u = t.replace(/\b(?:on|for|this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, ' ');
  const m = /\b(?:in|on|for|at|around|near|over)\s+([a-z][a-z .,'-]{1,60}?)(?=\s+(?:today|tonight|tomorrow|this|right now|now|from|on|for|at|during|over|next)\b|[?!.]|\s+\d|$)/.exec(u);
  let place = m ? m[1].replace(/\s+/g, ' ').replace(/[ ,.]+$/, '').replace(DAY, '').trim() : '';
  if (/^(the )?(morning|afternoon|evening|weekend|week|area)$/.test(place)) place = '';
  return { place, when };
}

async function getJson(url) {
  const r = await safefetch.get(url, { headers: { accept: 'application/json' } });
  if (r.status && r.status >= 400) throw new Error(`The weather service answered ${r.status}.`);
  return JSON.parse(r.text || '{}');
}

/** The place as { name, region, lat, lon, tz }. */
async function locate(place) {
  const p = String(place || '').trim().toLowerCase();
  const known = REGIONS[p.replace(/^the /, '')] || REGIONS[p];
  let name = known || place; let state = null;
  const parts = String(name).split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) { name = parts[0]; state = STATES[parts[1].toLowerCase()] || parts[1]; }
  const j = await getJson(`${GEO}/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
  const list = (j.results || []).filter((x) => x.country_code === 'US' || !state);
  const hit = (state && list.find((x) => String(x.admin1 || '').toLowerCase() === String(state).toLowerCase())) || list.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  if (!hit) return null;
  return { name: known ? place.replace(/\b\w/g, (c) => c.toUpperCase()) : hit.name, region: hit.admin1 || hit.country || '', lat: hit.latitude, lon: hit.longitude, tz: hit.timezone || 'auto', near: known ? `${hit.name}, ${hit.admin1 || ''}`.replace(/, $/, '') : null };
}

/** Today's conditions and the forecast for a place. Throws with a plain reason when it can't. */
async function forecast(place, when = 'today') {
  if (!place) throw new Error('Which place? Say "weather in <town>".');
  const loc = await locate(place);
  if (!loc) throw new Error(`I couldn't find a place called "${place}".`);
  const q = `latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(loc.tz)}&forecast_days=${when === 'week' ? 7 : 3}`;
  const j = await getJson(`${API}/v1/forecast?${q}`);
  const c = j.current || {}; const d = j.daily || {};
  const day = (i) => ({ date: d.time?.[i], sky: CODES[d.weather_code?.[i]] || 'mixed', hi: Math.round(d.temperature_2m_max?.[i]), lo: Math.round(d.temperature_2m_min?.[i]), rain: d.precipitation_probability_max?.[i], wind: Math.round(d.wind_speed_10m_max?.[i] || 0) });
  const days = (d.time || []).map((_, i) => day(i));
  return { place: loc, when, now: { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), sky: CODES[c.weather_code] || 'mixed', humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m || 0), at: c.time }, days, source: 'Open-Meteo (open-meteo.com)' };
}

const dayName = (iso) => { try { return new Date(`${iso}T12:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }); } catch { return iso; } };
/** The forecast as a short plain-English answer. */
function format(f) {
  const where = `${f.place.name}${f.place.region && !f.place.name.includes(f.place.region) ? `, ${f.place.region}` : ''}`;
  const line = (x, label) => `${label}: ${x.sky}, high ${x.hi}°F, low ${x.lo}°F${x.rain != null ? `, ${x.rain}% chance of rain` : ''}${x.wind ? `, wind up to ${x.wind} mph` : ''}.`;
  const out = [`Weather for ${where}${f.place.near ? ` (measured at ${f.place.near})` : ''}:`];
  if (f.when !== 'tomorrow') out.push(`Right now: ${f.now.temp}°F (feels like ${f.now.feels}°F), ${f.now.sky}, humidity ${f.now.humidity}%, wind ${f.now.wind} mph.`);
  if (f.when === 'week') f.days.forEach((x, i) => out.push(line(x, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayName(x.date))));
  else if (f.when === 'tomorrow') { if (f.days[1]) out.push(line(f.days[1], `Tomorrow (${dayName(f.days[1].date)})`)); }
  else { if (f.days[0]) out.push(line(f.days[0], 'Today')); if (f.days[1]) out.push(line(f.days[1], 'Tomorrow')); }
  out.push(`Source: ${f.source}.`);
  return out.join('\n');
}

module.exports = { ask, locate, forecast, format, REGIONS };
