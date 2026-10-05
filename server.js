const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== STAN ==========
let EVENTS = [];
let LAST_REFRESH = null;
let REFRESH_STATUS = { ok: false, problems: [] };

// ========== ŹRÓDŁA ==========
const SOURCES = [
  {
    name: 'Visit Opolskie',
    url: 'https://visitopolskie.pl/wydarzenia',
    parse: parseVisit
  },
  {
    name: 'Opolskie Lamy',
    url: 'https://festiwal.opolskielamy.pl',
    parse: parseLamy
  },
  {
    name: 'opole.pl',
    url: 'https://www.opole.pl/dla-mieszka%C5%84ca/wydarzenia',
    parse: parseOpole
  }
];

// ========== NARZĘDZIA ==========
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

// ========== PARSERY ==========
function parseVisit(html){
  const $ = cheerio.load(html);
  const out = [];
  $('.wiersz-wydarzenia').each((i, row) => {
    const a = $(row).find('a').first();
    const titleEl = $(row).find('.opolskie-top-tytul-kolor');
    let title = (titleEl.length ? titleEl.text() : a.attr('title') || '').replace(/\s+/g,' ').trim();
    const info = $(row).find('.info').text() || '';
    const dates = allDates(info);
    if (!a.length || !title || !dates.length) return;
    let city = 'Opolskie';
    const bits = title.split('|');
    if (bits.length > 1 && bits[0].trim().length < 32){
      city = bits[0].trim();
      title = bits.slice(1).join('|').trim();
    }
    const href = a.attr('href') || '';
    const link = href.startsWith('http') ? href : 'https://visitopolskie.pl' + href;
    out.push(buildEvent({
      title, city,
      startDate: dates[0],
      endDate: dates[dates.length-1],
      description: info,
      sourceUrl: link,
      sourceName: 'Visit Opolskie'
    }));
  });
  return out;
}

function parseLamy(html){
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('.scheduled-event').each((i, row) => {
    const titleEl = $(row).find('.event-title');
    const title = titleEl.length ? titleEl.text().replace(/\s+/g,' ').trim() : '';
    const date = $(row).attr('data-date') || allDates($(row).text())[0] || '';
    if (!title || !date) return;
    const key = title.toLowerCase()+'|'+date;
    if (seen.has(key)) return;
    seen.add(key);
    const timeEl = $(row).find('.time-starts');
    const descEl = $(row).find('.event-content');
    const a = $(row).find('.event-content a').first();
    const href = a.length ? (a.attr('href')||'') : 'https://festiwal.opolskielamy.pl';
    out.push(buildEvent({
      title,
      city: 'Opole',
      venue: ($(row).attr('data-location')||'Opole').replace(/-/g,' '),
      startDate: date,
      endDate: date,
      time: timeEl.length ? timeEl.text().trim() : '',
      description: descEl.length ? descEl.text() : title,
      sourceUrl: href.startsWith('http') ? href : 'https://festiwal.opolskielamy.pl'+href,
      sourceName: 'Opolskie Lamy',
      category: 'Film'
    }));
  });
  return out;
}

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

// ========== ODSWIEZANIE ==========
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

// ========== API ==========
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

// ========== CRON ==========
// Co 6 godzin: 0:00, 6:00, 12:00, 18:00
cron.schedule('0 */6 * * *', () => {
  console.log('[cron] Automatyczne odświeżanie...');
  refreshAll();
});

// ========== START ==========
app.listen(PORT, () => {
  console.log(`Backend działa na porcie ${PORT}`);
  // Pierwsze odświeżenie po starcie
  refreshAll();
});