const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

let EVENTS = [];
let LAST_REFRESH = null;
let REFRESH_STATUS = { ok: false, problems: [] };

/* ===== JEDNO ŹRÓDŁO: tuopolskie.pl ===== */
const SOURCES = [
  { name: 'tuopolskie.pl', url: 'https://tuopolskie.pl/', parse: parseTuOpolskie }
];

function pad(n){ return String(n).padStart(2,'0'); }
function todayISO(d = new Date()){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }

function makeId(title, date){
  return (title+'-'+date).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,72);
}

/* === FILTR ŚMIECI === */
const JUNK_PATTERNS = [
  /^godziny otwarcia$/i,
  /^dziś w bibliotece$/i,
  /^dzis w bibliotece$/i,
  /^wystawy czasowe$/i,
  /zaproszenie do składania ofert/i,
  /przetarg/i,
  /^ogloszenie$/i,
  /^ogłoszenie$/i,
];
function isJunk(title) {
  return JUNK_PATTERNS.some(re => re.test(String(title||'').trim()));
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

/* === POPRAWIONA KOLEJNOŚĆ KATEGORII === */
function guessCategory(title) {
  const t = String(title||'').toLowerCase();
  
  // Stand-up
  if (/stand-?up/.test(t)) return 'Stand-up';
  
  // Teatr (przed filmem!)
  if (/teatr|spektakl|lalki|monodram|przedstawienie|balet|opera/.test(t)) return 'Teatr';
  
  // Wystawa (przed filmem!)
  if (/wystaw|wernisaż|wernisaz|galeri|ekspozycj|muzeum|wystaw|fotogaleria/.test(t)) return 'Wystawa';
  
  // Koncert (przed filmem!)
  if (/koncert|filharmonia|recital|orkiestr|muzyka|jazz|organow|tenor|śpiew|piosenk|zespół|grupa|trasa|tour|diamentowa|symfonicz|kwartet|chór|chór/.test(t)) return 'Koncert';
  
  // Film
  if (/film|kino|projekcj|seans|festiwal film|pokaz film|multimedia/.test(t)) return 'Film';
  
  // Seniorzy
  if (/senior/.test(t)) return 'Seniorzy';
  
  // Sport
  if (/bieg|półmaraton|polmaraton|maraton|parkrun|mecz|turniej|sport|zawody|zumba|joga|pływanie|siłownia/.test(t)) return 'Sport';
  
  // Warsztaty / spotkania
  if (/warsztat|zajęcia|zajecia|lekcj|spotkanie autorsk|konferencj|forum|wykład|prelekcj|spotkanie|klub|dyskusyjny/.test(t)) return 'Warsztaty';
  
  // Kulinaria
  if (/kulin|kolacj|food|degustac|gotowan|czekolad|kawa|herbata|słodkości|smak/.test(t)) return 'Kulinaria';
  
  // Festyn / jarmark
  if (/festyn|jarmark|odpust|piknik|festiwal|fest/.test(t)) return 'Festyn';
  
  // Religijne
  if (/msza|paraf|pielgrzym|religij|kościół|kosciol|misterium|modlitw|kolędy|koledy/.test(t)) return 'Religijne';
  
  // Rodzinne (na końcu)
  if (/dzieci|rodzin|bajk|lalk|mama|tata|maluch|przedszkol/.test(t)) return 'Rodzinne';
  
  return 'Rodzinne';
}

/* === MIASTA === */
const TUO_CITIES = [
  'Kędzierzyn-Koźle', 'Strzelce Opolskie', 'Kluczbork', 'Namysłów',
  'Głuchołazy', 'Krapkowice', 'Prudnik', 'Opole', 'Nysa', 'Brzeg',
  'Ozimek', 'Grodków', 'Łambinowice', 'Prószków', 'Otmuchów',
  'Głubczyce', 'Niemodlin', 'Paczków', 'Moszna', 'Baborów',
  'Zdzieszowice', 'Kolonowskie', 'Dobrodzień', 'Olesno', 'Wołczyn',
  'Byczyna', 'Gogolin', 'Korfantów', 'Lubsza', 'Skarbimierz'
];

function guessCity(title, venue, sourceHost) {
  const blob = `${title} ${venue}`.toLowerCase();
  const pref = (title.split('|')[0] || '').trim().toLowerCase();
  
  for (const city of TUO_CITIES) {
    if (pref.startsWith(city.toLowerCase())) return city;
  }
  for (const city of TUO_CITIES) {
    if (blob.includes(city.toLowerCase())) return city;
  }
  if (/opole\.pl|filharmonia\.opole|teatropole|galeriaopole|kinomeduza|mbp\.opole|muzeum\.opole/.test(sourceHost)) return 'Opole';
  return 'Opolskie';
}

/* === PARSER tuopolskie.pl === */
function parseTuOpolskie(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('article.event-card').each((i, el) => {
    const card = $(el);
    const btn = card.find('button.calendar-add').first();
    const title = (btn.attr('data-title') || card.find('h3').first().text() || '')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (!title) return;
    if (isJunk(title)) return;
    
    const startDate = (btn.attr('data-date') || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return;

    let endDate = (btn.attr('data-end-date') || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) endDate = startDate;

    let time = (btn.attr('data-time') || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      const meta = card.find('.event-meta').first().text();
      const m = meta.match(/(\d{1,2}:\d{2})/);
      time = m ? m[1] : '';
    }

    const venue = card.find('.event-location').first().text().replace(/\s+/g, ' ').trim()
      || (btn.attr('data-location') || '').replace(/\s+/g, ' ').trim();
    const sourceHost = card.find('.event-meta .source').first().text().trim();

    let sourceUrl = (btn.attr('data-url') || card.find('a.event-link').attr('href') || '').trim();
    if (!sourceUrl) {
      const internal = card.find('a[href^="/wydarzenie/"]').attr('href') || '';
      sourceUrl = internal ? 'https://tuopolskie.pl' + internal : 'https://tuopolskie.pl/';
    }

    const city = guessCity(title, venue, sourceHost);

    out.push(buildEvent({
      title,
      city,
      venue: venue || city,
      startDate,
      endDate,
      time,
      description: venue ? `${title}. ${venue}` : title,
      sourceUrl,
      sourceName: 'tuopolskie.pl',
      category: guessCategory(title)
    }));
  });

  return out;
}

/* === POBIERANIE === */
async function scrapeSource(source){
  const res = await axios.get(source.url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AtrakcjeBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  return source.parse(res.data);
}

/* === DEDUPLIKACJA (prosta, bo mamy 1 źródło) === */
function normKey(title, date){
  const normalized = String(title||'')
    .toLowerCase()
    .replace(/[""''„"]/g, '')
    .replace(/[^a-z0-9ąćęłńóśźż\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized + '|' + (date || '');
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

/* === API === */
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

/* === CRON === */
cron.schedule('0 */6 * * *', () => {
  console.log('[cron] Automatyczne odświeżanie...');
  refreshAll();
});

/* === START === */
app.listen(PORT, () => {
  console.log(`Backend działa na porcie ${PORT}`);
  refreshAll();
});
