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

/* === FILTR KATEGORII DO USUNIĘCIA === */
const EXCLUDED_CATEGORIES = ['Wystawa', 'Teatr'];
function isExcludedCategory(category) {
  return EXCLUDED_CATEGORIES.includes(category);
}

/* === DODATKOWY FILTR TYTUŁÓW TEATRALNYCH === */
/* Spektakle, które nie mają w tytule "teatr" ani "spektakl" */
const THEATER_TITLE_PATTERNS = [
  /sztuka kochania/i,
  /wyszłam z siebie/i,
  /wyszedłem z siebie/i,
  /ziemia obiecana/i,
  /autentik/i,
  /sprawiedliwy/i,
  /między łóżkami/i,
  /ding dong/i,
  /mąż mojej żony/i,
  /spektakl/i,
  /przedstawienie/i,
  /monodram/i,
  /lalki i aktora/i,
  /teatr/i,
  /teatraln/i,
  /balet/i,
  /opera\b/i,
];
function isTheaterTitle(title) {
  return THEATER_TITLE_PATTERNS.some(re => re.test(String(title||'')));
}

/* === cleanVenue – tylko ucinanie długich === */
function cleanVenue(venue, city) {
  let v = String(venue || '').replace(/\s+/g, ' ').trim();
  if (!v) return city;
  
  if (v.length > 100 || v.includes('…') || v.includes('...')) {
    const cut = v.split(/[.,]/)[0].trim();
    if (cut.length >= 3 && cut.length <= 60) return cut;
    return city;
  }
  
  return v;
}

function buildEvent(p){
  const title = String(p.title||'').replace(/\s+/g,' ').trim();
  const city = p.city || 'Opolskie';
  const venue = cleanVenue(p.venue, city);
  return {
    id: makeId(title, p.startDate) || ('ev-'+Date.now()),
    title,
    category: p.category || 'Rodzinne',
    city,
    venue,
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

/* === KATEGORIE === */
function guessCategory(title) {
  const t = String(title||'').toLowerCase();
  if (/stand-?up/.test(t)) return 'Stand-up';
  if (/teatr|spektakl|lalki|monodram|przedstawienie|balet|opera/.test(t)) return 'Teatr';
  if (/wystaw|wernisaż|wernisaz|galeri|ekspozycj|muzeum|fotogaleria/.test(t)) return 'Wystawa';
  if (/koncert|filharmonia|recital|orkiestr|muzyka|jazz|organow|tenor|śpiew|piosenk|zespół|grupa|trasa|tour|diamentowa|symfonicz|kwartet|chór/.test(t)) return 'Koncert';
  if (/film|kino|projekcj|seans|festiwal film|pokaz film|multimedia/.test(t)) return 'Film';
  if (/senior/.test(t)) return 'Seniorzy';
  if (/bieg|półmaraton|polmaraton|maraton|parkrun|mecz|turniej|sport|zawody|zumba|joga|pływanie|siłownia/.test(t)) return 'Sport';
  if (/warsztat|zajęcia|zajecia|lekcj|spotkanie autorsk|konferencj|forum|wykład|prelekcj|spotkanie|klub|dyskusyjny/.test(t)) return 'Warsztaty';
  if (/kulin|kolacj|food|degustac|gotowan|czekolad|kawa|herbata|słodkości|smak/.test(t)) return 'Kulinaria';
  if (/festyn|jarmark|odpust|piknik|festiwal|fest/.test(t)) return 'Festyn';
  if (/msza|paraf|pielgrzym|religij|kościół|kosciol|misterium|modlitw|kolędy|koledy/.test(t)) return 'Religijne';
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
  
  if (/opole\.pl|filharmonia\.opole|teatropole|galeriaopole|kinomeduza|mbp\.opole|muzeum\.opole|biletyna\.pl|faktyopole|halaopole|itakaarena|muzeumpiosenki|visitopolskie|teatr|filharmonia/.test(sourceHost)) return 'Opole';
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
    if (isTheaterTitle(title)) return;  // NOWE: filtr teatru po tytule
    
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
    const category = guessCategory(title);

    // Pomijamy wykluczone kategorie
    if (isExcludedCategory(category)) return;

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
      category
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

/* === DEDUPLIKACJA + ZWIJANIE POWTARZALNYCH + FUZZY MATCHING === */
function normTitle(title){
  return String(title||'')
    .toLowerCase()
    .replace(/[""''„"]/g, '')
    .replace(/[^a-z0-9ąćęłńóśźż\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKey(title, date){
  return normTitle(title) + '|' + (date || '');
}

/* === FUZZY: podobieństwo tytułów (ile wspólnych słów) === */
function titleSimilarity(a, b) {
  const stopWords = new Set(['w', 'we', 'na', 'do', 'z', 'ze', 'i', 'o', 'od', 'po', 'za', 'dla', 'się', 'sie', 'the', 'a', 'an']);
  const wordsA = normTitle(a).split(' ').filter(w => w.length > 2 && !stopWords.has(w));
  const wordsB = normTitle(b).split(' ').filter(w => w.length > 2 && !stopWords.has(w));
  if (!wordsA.length || !wordsB.length) return 0;
  
  const setA = new Set(wordsA);
  let common = 0;
  for (const w of wordsB) {
    if (setA.has(w)) common++;
  }
  return common / Math.min(wordsA.length, wordsB.length);
}

/* === Główna funkcja deduplikacji === */
function mergeEvents(events){
  // Krok 1: Deduplikacja po tytuł + data
  const map = new Map();
  events.forEach(e => {
    const key = normKey(e.title, e.startDate);
    if (!map.has(key)) map.set(key, e);
  });
  
  // Krok 2: Fuzzy deduplikacja – usuń wydarzenia, które są bardzo podobne do już dodanych
  const unique = [];
  [...map.values()].forEach(e => {
    const isDuplicate = unique.some(u => {
      // Ten sam dzień?
      if (u.startDate !== e.startDate) return false;
      // Ten sam typ?
      if (u.category !== e.category) return false;
      // Podobne tytuły (> 70% wspólnych słów)?
      return titleSimilarity(u.title, e.title) >= 0.7;
    });
    if (!isDuplicate) unique.push(e);
  });
  
  // Krok 3: Zwiń powtarzalne (ten sam tytuł, różne daty)
  const byTitle = new Map();
  unique.forEach(e => {
    const tKey = normTitle(e.title);
    if (!byTitle.has(tKey)) byTitle.set(tKey, []);
    byTitle.get(tKey).push(e);
  });
  
  const result = [];
  byTitle.forEach((group) => {
    group.sort((a,b) => a.startDate.localeCompare(b.startDate));
    
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }
    
    const first = group[0];
    const laterCount = group.length - 1;
    first.description = (first.description + ` (i ${laterCount} innych terminów)`).slice(0, 400);
    result.push(first);
  });
  
  return result;
}

async function refreshAll(){
  console.log('[refresh] Start', new Date().toISOString());
  const all = [];
  const problems = [];
  for (const src of SOURCES){
    try {
      const items = await scrapeSource(src);
      console.log(`[refresh] ${src.name}: ${items.length} wydarzeń (po filtrach)`);
      if (!items.length) problems.push(src.name+' (0)');
      all.push(...items);
    } catch (err){
      console.error(`[refresh] ${src.name}: BŁĄD`, err.message);
      problems.push(src.name);
    }
  }
  const before = all.length;
  EVENTS = mergeEvents(all);
  const after = EVENTS.length;
  console.log(`[refresh] Deduplikacja: ${before} → ${after} (zwinięto ${before - after})`);
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
