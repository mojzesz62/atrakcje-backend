const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

let EVENTS = [];
let LAST_REFRESH = null;
let REFRESH_STATUS = { ok: false, problems: [] };

const SOURCES = [
  { name: 'Visit Opolskie', url: 'https://visitopolskie.pl/wydarzenia', parse: parseVisit },
  { name: 'Opolskie Lamy', url: 'https://festiwal.opolskielamy.pl', parse: parseLamyV2 },
  { name: 'opole.pl', url: 'https://www.opole.pl/dla-mieszka%C5%84ca', parse: parseOpole }
];

function pad(n){ return String(n).padStart(2,'0'); }
function todayISO(d = new Date()){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }

function allDates(text){
  const out = [];
  const src = String(text||'');
  let m;
  const re1 = /(\d{1,2})[.](\d{1,2})[.](\d{4})/g;
  while ((m = re1.exec(src))) out.push(m[3]+'-'+pad(m[2])+'-'+pad(m[1]));
  const re2 = /(\d{4})-(\d{2})-(\d{2})/g;
  while ((m = re2.exec(src))) out.push(m[0]);
    const re3 = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
  while ((m = re3.exec(src))) out.push(m[3]+'-'+pad(m[2])+'-'+pad(m[1]));
  return out;
}

function makeId(title, date){
  return (title+'-'+date).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,72);
}

function buildEvent(p){
  const title = String(p.title||'').replace(/\s+/g,' ').trim();
  return {
    id: makeId(title, p.startDate) || ('ev-'+Date.now()),
    title,
    category: p.category || 'Rodzinne',
    city: p.city || 'Opolskie',
    venue: p.venue || p.city || '',
    startDate: p.startDate,
    endDate: p.endDate || p.startDate,
    time: p.time || '',
    description: (p.description || title).replace(/\s+/g,' ').trim().slice(0,400),
    price: 'sprawdź u organizatora',
    audience: 'dla wszystkich',
    tags: ['z sieci'],
    sourceUrl: p.sourceUrl,
    sourceName: p.sourceName,
    fetchedAt: todayISO(),
    lat: null,
    lng: null
  };
}

// ===== VISIT OPOLSKIE =====
function parseVisit(html){
  const $ = cheerio.load(html);
  const out = [];

  $('.wiersz-wydarzenia').each((i, row) => {
    const a = $(row).find('a').first();
    const titleEl = $(row).find('.opolskie-top-tytul-kolor');
    let title = (titleEl.length ? titleEl.text() : a.attr('title') || '')
      .replace(/\s+/g, ' ')
      .trim();
    const info = $(row).find('.info').text().replace(/\s+/g, ' ').trim();
    const href = a.attr('href') || '';
    if (!title || !href) return;

    // Regex na DD/MM/YYYY (Visit Opolskie używa slasha!)
    const found = [];
    const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
    let m;
    while ((m = re.exec(info))) {
      found.push(m[3] + '-' + pad(m[2]) + '-' + pad(m[1]));
    }
    if (!found.length) return;

    let city = 'Opolskie';
    const bits = title.split('|');
    if (bits.length > 1 && bits[0].trim().length < 32) {
      city = bits[0].trim();
      title = bits.slice(1).join('|').trim();
    }

    const sourceUrl = href.startsWith('http')
      ? href
      : 'https://visitopolskie.pl' + href;

    out.push(buildEvent({
      title,
      city,
      startDate: found[0],
      endDate: found[found.length - 1],
      description: info.replace(/^Data wydarzenia:\s*/i, '').trim() || title,
      sourceUrl,
      sourceName: 'Visit Opolskie'
    }));
  });

  return out;
}

// ===== OPOLSKIE LAMY (JEDNO WYDARZENIE) =====
function parseLamyV2(html){
  const out = [];
  // Jedno wydarzenie: cały festiwal
  out.push(buildEvent({
    title: "24. Festiwal Filmowy Opolskie Lamy",
    city: "Opole",
    venue: "Kina Meduza, Helios, Studio (MDK)",
    startDate: "2026-10-02",
    endDate: "2026-10-10",
    description: "Festiwal filmowy pod motywem DOBRO. Pokazy filmów, spotkania z twórcami, konkursy. Kina: Meduza, Helios Solaris, Studio (MDK), Urban Lab.",
    sourceUrl: "https://festiwal.opolskielamy.pl",
    sourceName: "Opolskie Lamy",
    category: "Film"
  }));
  return out;
}

// ===== OPLE.PL =====
const CAT_MAP = {
  'koncerty': 'Koncert',
  'filmy / spektakle': 'Film',
  'sport': 'Sport',
  'spotkania / warsztaty': 'Warsztaty',
  'wystawy / targi': 'Wystawa'
};

function parseOpole(html){
  const $ = cheerio.load(html);
  const out = [];
  $('article.node--type-event').each((i, art) => {
    const titleA = $(art).find('.field--name-node-title a').first();
    const dateEl = $(art).find('.field--name-field-event-date time.datetime').first();
    const catEl = $(art).find('.field--name-field-event-category .field__item').first();
    if (!titleA.length || !dateEl.length) return;
    const title = titleA.text().replace(/\s+/g,' ').trim();
    const href = titleA.attr('href') || '';
    const link = href.startsWith('http') ? href : 'https://www.opole.pl' + href;
    const dateText = dateEl.text().replace(/\s+/g,' ').trim();
    const dates = allDates(dateText);
    if (!title || !dates.length) return;
    const catRaw = catEl.length ? catEl.text().trim().toLowerCase() : '';
    const category = CAT_MAP[catRaw] || 'Rodzinne';
    out.push(buildEvent({
      title,
      city: 'Opole',
      venue: 'Opole',
      startDate: dates[0],
      endDate: dates[dates.length-1] || dates[0],
      description: title,
      sourceUrl: link,
      sourceName: 'opole.pl',
      category
    }));
  });
  return out;
}

// ===== POBIERANIE =====
async function scrapeSource(source){
  const res = await axios.get(source.url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AtrakcjeBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  return source.parse(res.data);
}

function normKey(title, date){
  return String(title||'').toLowerCase().replace(/\s+/g,' ').trim()+'|'+(date||'');
}

function mergeEvents(events){
  const map = new Map();
  events.forEach(e => {
    const key = normKey(e.title, e.startDate);
    if (!map.has(key)) map.set(key, e);
  });
  return [...map.values()];
}

async function refreshAll(){
  console.log('[refresh] Start', new Date().toISOString());
  const all = [];
  const problems = [];
  for (const src of SOURCES){
    try {
      const items = await scrapeSource(src);
      console.log(`[refresh] ${src.name}: ${items.length} wydarzeń`);
      if (!items.length) problems.push(src.name+' (0)');
      all.push(...items);
    } catch (err){
      console.error(`[refresh] ${src.name}: BŁĄD`, err.message);
      problems.push(src.name);
    }
  }
  EVENTS = mergeEvents(all);
  LAST_REFRESH = new Date().toISOString();
  REFRESH_STATUS = { ok: problems.length === 0, problems };
  console.log(`[refresh] Gotowe. ${EVENTS.length} unikalnych wydarzeń.`);
}

app.get('/api/events', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({
    ok: true,
    refreshedAt: LAST_REFRESH,
    count: EVENTS.length,
    status: REFRESH_STATUS,
    events: EVENTS
  });
});

app.get('/api/refresh', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    await refreshAll();
    res.json({ ok: true, count: EVENTS.length, refreshedAt: LAST_REFRESH });
  } catch (err){
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    refreshedAt: LAST_REFRESH,
    count: EVENTS.length,
    uptime: process.uptime()
  });
});

cron.schedule('0 */6 * * *', () => {
  console.log('[cron] Automatyczne odświeżanie...');
  refreshAll();
});

app.listen(PORT, () => {
  console.log(`Backend działa na porcie ${PORT}`);
  refreshAll();
});
