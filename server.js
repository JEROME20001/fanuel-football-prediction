const http = require("http");
const fs = require("fs");
const path = require("path");
const engine = require("./advanced-engine");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SPORTSCORE_BASE = "https://sportscore.com";
const SPORTYBET_BASE = "https://www.sportybet.com";
const SPORTYBET_REGION = process.env.SPORTYBET_REGION || "tz";
const SPORTYBET_ENABLED = String(process.env.SPORTYBET_ENABLED ?? "true").toLowerCase() !== "false";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const MAX_AI_DAILY = Math.max(1, Number(process.env.MAX_AI_DAILY || 150));
const VIP_CANDIDATES = Math.max(10, Math.min(150, Number(process.env.VIP_CANDIDATES || 150)));
const DEEP_ANALYSIS_LIMIT = Math.max(20, Math.min(150, Number(process.env.DEEP_ANALYSIS_LIMIT || 150)));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { predictions: [], results: [], dailyOdds15: [] };
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      predictions: Array.isArray(data.predictions) ? data.predictions : [],
      results: Array.isArray(data.results) ? data.results : [],
      dailyOdds15: Array.isArray(data.dailyOdds15) ? data.dailyOdds15 : []
    };
  } catch (e) {
    console.log("DB load error:", e.message);
    return { predictions: [], results: [], dailyOdds15: [] };
  }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8"); }
  catch (e) { console.log("DB save error:", e.message); }
}
const db = loadDB();
const seenPredictionFixtures = new Set();
const dedupedPredictions = [];
for (let i = db.predictions.length - 1; i >= 0; i--) {
  const prediction = db.predictions[i];
  const key = String(prediction?.fixtureId || "");
  if (key && seenPredictionFixtures.has(key)) continue;
  if (key) seenPredictionFixtures.add(key);
  dedupedPredictions.unshift(prediction);
}
if (dedupedPredictions.length !== db.predictions.length) {
  db.predictions = dedupedPredictions;
  saveDB(db);
}
const cache = new Map();
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { cache.delete(key); return null; }
  return item.value;
}
function cacheSet(key, value, minutes) {
  cache.set(key, { value, expires: Date.now() + minutes * 60000 });
}

async function sportScoreRequest(apiPath) {
  const response = await fetch(SPORTSCORE_BASE + apiPath, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("SportScore response is not JSON. HTTP " + response.status); }
  if (!response.ok) throw new Error(data?.error || data?.message || ("SportScore HTTP " + response.status));
  return data;
}
function extractMatches(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.matches)) return data.matches;
  if (Array.isArray(data?.fixtures)) return data.fixtures;
  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.matches)) return data.data.matches;
  if (Array.isArray(data?.data?.fixtures)) return data.data.fixtures;
  if (Array.isArray(data?.response)) return data.response;
  return [];
}
function normalizeMatch(match) {
  const homeRaw = match?.home || match?.home_team || match?.teams?.home || {};
  const awayRaw = match?.away || match?.away_team || match?.teams?.away || {};
  const home = typeof homeRaw === "string" ? { name: homeRaw } : homeRaw;
  const away = typeof awayRaw === "string" ? { name: awayRaw } : awayRaw;
  const leagueRaw = match?.competition || match?.league || {};
  const league = typeof leagueRaw === "string" ? { name: leagueRaw } : leagueRaw;
  const homeName = home.name || home.team_name || home.title || home.label || "Home Team";
  const awayName = away.name || away.team_name || away.title || away.label || "Away Team";
  const id = String(match?.slug || match?.id || match?.match_id || match?.fixture_id || "");
  return {
    id,
    name: `${homeName} vs ${awayName}`,
    starting_at: match?.time || match?.starting_at || match?.date || match?.start || null,
    homeTeam: { id: home.id || home.team_id || home.slug || home.team_slug || homeName, name: homeName, logo: home.logo || home.logo_url || null, slug: home.slug || home.team_slug || null },
    awayTeam: { id: away.id || away.team_id || away.slug || away.team_slug || awayName, name: awayName, logo: away.logo || away.logo_url || null, slug: away.slug || away.team_slug || null },
    league: { id: league.id || league.slug || null, name: league.name || league.competition_name || "Football", country: league.country || "" },
    season: match?.season || league.season || null,
    status: match?.status || match?.status_text || "Scheduled",
    venue: match?.venue || null,
    slug: match?.slug || id,
    raw: match
  };
}
function fixturePriorityScore(match) {
  const text = String(`${match?.homeTeam?.name || ""} ${match?.awayTeam?.name || ""} ${match?.league?.name || ""}`).toLowerCase();
  const major = [
    ["champions league",140],["europa league",135],["conference league",130],
    ["premier league",125],["la liga",122],["serie a",120],["bundesliga",118],["ligue 1",116],
    ["eredivisie",110],["primeira liga",108],["championship",100],["super lig",96],["mls",92],["brasileirao",92]
  ];
  let score = 10;
  for (const [k,v] of major) if (text.includes(k)) score = Math.max(score, v);
  if (/\b(u17|u18|u19|u20|u21|u23|women|womens|reserve|reserves)\b/i.test(text)) score -= 30;
  return Math.max(0, score);
}
function isBigLeague(match) {
  const text = String(match?.league?.name || "").toLowerCase();
  return [
    "champions league","europa league","conference league","premier league",
    "la liga","serie a","bundesliga","ligue 1","eredivisie","primeira liga",
    "championship","super lig","mls","brasileirao"
  ].some(k => text.includes(k));
}
function addDays(dateString, days) {
  const d = new Date(dateString + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function normalizeBookmakerTeamName(name){
  return String(name||"")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[’']/g,"")
    .replace(/\b(fc|sc|cf|afc|fk|club|sports club|football club)\b/gi," ")
    .replace(/\b(football|soccer)\b/gi," ")
    .replace(/\b(under[- ]?\d{2}|u\d{2})\b/gi," ")
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .replace(/\s+/g," ");
}
function bookmakerMatchKey(home, away){
  return normalizeBookmakerTeamName(home)+"|"+normalizeBookmakerTeamName(away);
}
function teamNamesMatch(a,b){
  const x=normalizeBookmakerTeamName(a), y=normalizeBookmakerTeamName(b);
  if(!x || !y) return false;
  if(x===y) return true;
  const ax=new Set(x.split(" ")), ay=new Set(y.split(" "));
  const overlap=[...ax].filter(t=>ay.has(t));
  const ratio=overlap.length/Math.max(ax.size,ay.size);
  return ratio >= 0.8 && Math.min(ax.size,ay.size) >= 2;
}
const TOP_150_TEAMS = new Set(["Real Madrid","Barcelona","Atletico Madrid","Athletic Bilbao","Real Sociedad","Villarreal","Real Betis","Sevilla","Valencia","Girona","Manchester City","Liverpool","Arsenal","Manchester United","Chelsea","Tottenham Hotspur","Newcastle United","Aston Villa","West Ham United","Brighton","Bayern Munich","Borussia Dortmund","RB Leipzig","Bayer Leverkusen","Eintracht Frankfurt","Stuttgart","Wolfsburg","Mainz","Union Berlin","Borussia Monchengladbach","Inter Milan","AC Milan","Juventus","Napoli","AS Roma","Lazio","Atalanta","Fiorentina","Bologna","Torino","Paris Saint Germain","Marseille","Monaco","Lyon","Lille","Nice","Lens","Rennes","Strasbourg","Nantes","Ajax","PSV Eindhoven","Feyenoord","AZ Alkmaar","Twente","Porto","Benfica","Sporting CP","Braga","Vitoria Guimaraes","Galatasaray","Fenerbahce","Besiktas","Trabzonspor","Basaksehir","Sivasspor","Club Brugge","Anderlecht","Genk","Union Saint Gilloise","Al Nassr","Al Hilal","Al Ittihad","Al Ahli","Al Shabab","Al Ettifaq","Al Qadsiah","Al Gharafa","Al Sadd","Al Duhail","Al Ain","Shabab Al Ahli","Al Jazira","Urawa Red Diamonds","Yokohama F Marinos","Kawasaki Frontale","Vissel Kobe","Gamba Osaka","FC Seoul","Jeonbuk Hyundai Motors","Shanghai Port","Shandong Taishan","Beijing Guoan","Ulsan Hyundai","Pohang Steelers","Daejeon Hana Citizen","Buriram United","Johor Darul Ta'zim","Persib Bandung","Muangthong United","Flamengo","Palmeiras","Botafogo","Fluminense","Atletico Mineiro","Gremio","Internacional","Sao Paulo","Corinthians","Cruzeiro","River Plate","Boca Juniors","Racing Club","Independiente","Estudiantes","Colo Colo","Universidad de Chile","Nacional","Penarol","Olimpia","LA Galaxy","Inter Miami","New York City FC","Seattle Sounders","Los Angeles FC","Atlanta United","CF Montreal","Toronto FC","FC Cincinnati","Columbus Crew","Celtic","Rangers","Red Bull Salzburg","Rapid Vienna","Young Boys","Basel","Dinamo Zagreb","Crvena zvezda","Olympiacos","FCSB","Slavia Prague","Sparta Prague","Shakhtar Donetsk","Dynamo Kyiv","Ferencvaros","Maccabi Tel Aviv","PAOK","Panathinaikos","Freiburg","Maribor"].map(normalizeBookmakerTeamName));
function isTop150Team(name){
  const n=normalizeBookmakerTeamName(name);
  if(!n) return false;
  return TOP_150_TEAMS.has(n) || [...TOP_150_TEAMS].some(x => n===x || n.includes(x) || x.includes(n));
}
function isTop150Fixture(home, away){ return isTop150Team(home) || isTop150Team(away); }

function sportBetMarketFlags(event){
  const flags={oneXTwo:false,draw:false,btts:false};
  let sawMarket=false;
  function walk(v){
    if(!v || typeof v!=="object") return;
    if(Array.isArray(v)){ v.forEach(walk); return; }

    const text=Object.entries(v)
      .filter(([k])=>/name|desc|title|market/i.test(k))
      .map(([,val])=>String(val||""))
      .join(" ")
      .toLowerCase();

    if(/(^|\\b)(1x2|1\\s*x\\s*2|match result|full time result)(\\b|$)/i.test(text)){
      flags.oneXTwo=true;
      sawMarket=true;
    }
    if(/(^|\\b)(gg\\s*\/\\s*ng|btts|both teams to score)(\\b|$)/i.test(text)){
      flags.btts=true;
      sawMarket=true;
    }

    if(Array.isArray(v.outcomes) && v.outcomes.length){
      const active=v.outcomes.some(o=>o?.isActive!==false && o?.status!==0 && o?.status!=="0");
      if(active && /1x2|match result|full time result/i.test(text)){ flags.oneXTwo=true; sawMarket=true; }
      if(active && /gg\\s*\/\\s*ng|btts|both teams to score/i.test(text)){ flags.btts=true; sawMarket=true; }
    }
    for(const [k,val] of Object.entries(v)){
      if(k!=="raw") walk(val);
    }
  }
  walk(event);

  // SportyBet's football schedule endpoint is queried with the standard 1X2 and
  // GG/NG market groups. If a returned event has no expanded market payload,
  // treat 1X2/Draw as available rather than falsely rejecting the event.
  if(!flags.oneXTwo && !sawMarket) flags.oneXTwo=true;
  flags.draw=flags.oneXTwo;
  return flags;
}

function sportBetOddsForEvent(event){
  const out={oneXTwo:[],btts:[],doubleChance:[],totals:{}};
  const marketsRaw=Array.isArray(event?.markets)?event.markets:
    Array.isArray(event?.market)?event.market:
    (event?.markets&&typeof event.markets==="object"?Object.values(event.markets):[]);
  const activeValue=v=>v!==false&&v!==0&&v!=="0"&&String(v).toLowerCase()!=="false"&&String(v).toLowerCase()!=="suspended";
  const normalizeMarketId=m=>String(m?.id??m?.marketId??m?.marketID??"");
  const normalizeDesc=m=>String(m?.desc??m?.description??m?.name??m?.marketName??"").toLowerCase();
  const normalizeOutcomes=m=>Array.isArray(m?.outcomes)?m.outcomes:
    Array.isArray(m?.outcome)?m.outcome:
    (m?.outcomes&&typeof m.outcomes==="object"?Object.values(m.outcomes):[]);
  for(const market of marketsRaw){
    if(!activeValue(market?.status??market?.marketStatus)) continue;
    const mid=normalizeMarketId(market), desc=normalizeDesc(market);
    const outcomes=normalizeOutcomes(market);
    const is1x2=mid==="1"||/1x2|match result|full time result/.test(desc);
    const isBtts=mid==="29"||/gg\s*\/\s*ng|both teams to score|btts/.test(desc);
    const isDc=mid==="10"||/double chance/.test(desc);
    const isTotal=mid==="18"||/over\s*\/\s*under|total goals|over\s*under/.test(desc);
    for(const rawOutcome of outcomes){
      const o=rawOutcome?.outcome&&typeof rawOutcome.outcome==="object"?rawOutcome.outcome:rawOutcome;
      if(!activeValue(o?.isActive??o?.active??o?.status)) continue;
      const odds=Number(o?.odds??o?.odd??o?.price);
      if(!Number.isFinite(odds)||odds<=1) continue;
      const od=String(o?.desc??o?.description??o?.name??o?.outcomeName??"").toLowerCase();
      const item={
        marketId:mid,
        marketDesc:String(market?.desc??market?.description??market?.name??market?.marketName??""),
        specifier:market?.specifier??market?.spec??null,
        outcomeId:String(o?.id??o?.outcomeId??""),
        outcomeDesc:String(o?.desc??o?.description??o?.name??o?.outcomeName??""),
        odds
      };
      if(is1x2){
        const id=item.outcomeId;
        const pick=id==="1"?"Home Win":id==="2"?"Draw":id==="3"?"Away Win":
          /\bhome\b/.test(od)?"Home Win":/\b(draw|tie)\b/.test(od)?"Draw":/\baway\b/.test(od)?"Away Win":null;
        if(pick) out.oneXTwo.push({...item,pick});
      }else if(isBtts){
        const pick=/^(yes|gg)\b|\byes\b|\bgg\b/.test(od)?"BTTS YES":/^(no|ng)\b|\bno\b|\bng\b/.test(od)?"BTTS NO":null;
        if(pick) out.btts.push({...item,pick});
      }else if(isDc){
        const pick=/\b1x\b|home\s*\/\s*draw|home\s+or\s+draw/.test(od)?"1X":
          /\bx2\b|draw\s*\/\s*away|draw\s+or\s+away/.test(od)?"X2":
          /\b12\b|home\s*\/\s*away|home\s+or\s+away/.test(od)?"12":null;
        if(pick) out.doubleChance.push({...item,pick});
      }else if(isTotal){
        const spec=String(item.specifier||"");
        const sm=spec.match(/total\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
        const lm=od.match(/(?:over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
        const line=sm?sm[1]:(lm?lm[1]:null);
        const pick=/\bunder\b/.test(od)?"Under "+line:/\bover\b/.test(od)?"Over "+line:null;
        if(line&&pick){if(!out.totals[line])out.totals[line]=[];out.totals[line].push({...item,pick});}
      }
    }
  }
  return out;
}
function sportBetTimestamp(value){
  const n=Number(value);
  if(!Number.isFinite(n) || n<=0) return null;
  return n < 100000000000 ? n * 1000 : n;
}
async function getSportyBetUpcoming(days=1,targetDate=null){
  if(!SPORTYBET_ENABLED) return {enabled:false,matches:[],byKey:new Map(),count:0,message:"SportyBet filter disabled."};
  const cacheKey="sportybet:upcoming:"+SPORTYBET_REGION+":"+(targetDate||"all")+":"+days;
  const cached=cacheGet(cacheKey); if(cached) return cached;
  const timeline=720;
  const all=[];
  for(let page=1;page<=5;page++){
    const pathApi=`/api/${SPORTYBET_REGION}/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1%2C18%2C10%2C29%2C11%2C26%2C36%2C14%2C60100&pageSize=100&pageNum=${page}&todayGames=false&timeline=${timeline}&_t=${Date.now()}`;
    try{
      const data=await (async()=>{
        const response=await fetch(SPORTYBET_BASE+pathApi,{headers:{
          Accept:"application/json","Content-Type":"application/json","Current-Country":SPORTYBET_REGION.toUpperCase()
        }});
        const raw=await response.text(); let json;
        try{json=JSON.parse(raw);}catch{throw new Error("SportyBet response is not JSON. HTTP "+response.status);}
        if(!response.ok) throw new Error(json?.message||json?.error||("SportyBet HTTP "+response.status));
        return json;
      })();
      const tournaments=Array.isArray(data?.data?.tournaments)?data.data.tournaments:[];
      for(const tournament of tournaments){
        for(const event of tournament?.events||[]){
          const home=event?.homeTeamName||event?.home_team_name;
          const away=event?.awayTeamName||event?.away_team_name;
          const eventId=String(event?.eventId||event?.id||"");
          if(!home||!away||!eventId) continue;
          const ts=sportBetTimestamp(event?.estimateStartTime ?? event?.startTime);
          const eventDate = ts
            ? new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Dar_es_Salaam"}).format(new Date(ts))
            : null;
          if(targetDate && eventDate !== targetDate) continue;
          const flags=sportBetMarketFlags(event);
          const odds=sportBetOddsForEvent(event);
          all.push({
            eventId,homeTeam:home,awayTeam:away,
            league:tournament?.name||event?.tournamentName||"Football",
            category:tournament?.categoryName||"",
            starting_at:ts?new Date(ts).toISOString():null,
            oneXTwo:flags.oneXTwo,draw:flags.draw,btts:flags.btts,odds,
            bookmaker:"SportyBet",bookmakerRegion:SPORTYBET_REGION
          });
        }
      }
      const total=Number(data?.data?.totalNum||0);
      if(!tournaments.length || page*100>=total) break;
    }catch(err){
      console.log("SportyBet lookup failed:",err.message);
      break;
    }
  }
  const dedupe=new Map();
  for(const m of all) dedupe.set(m.eventId,m);
  const matches=[...dedupe.values()];
  const byKey=new Map();
  for(const m of matches) byKey.set(bookmakerMatchKey(m.homeTeam,m.awayTeam),m);
  const result={enabled:true,matches,byKey,count:matches.length,checkedAt:new Date().toISOString(),message:`${matches.length} SportyBet football events loaded.`};
  cacheSet(cacheKey,result,2);
  return result;
}
function markSportyBetAvailability(matches, sporty){
  const byKey=sporty?.byKey instanceof Map ? sporty.byKey : new Map();
  const sportyMatches=Array.isArray(sporty?.matches) ? sporty.matches : [];
  return (matches||[]).map(m=>{
    const homeName=m?.homeTeam?.name, awayName=m?.awayTeam?.name;
    const key=bookmakerMatchKey(homeName,awayName);
    let sb=byKey.get(key)||null;

    // Fuzzy fallback: tolerate FC/SC/CF suffixes, punctuation and minor naming variants.
    if(!sb){
      sb=sportyMatches.find(x=>
        teamNamesMatch(homeName,x?.homeTeam) &&
        teamNamesMatch(awayName,x?.awayTeam)
      ) || null;
    }

    m.sportyBetAvailable=Boolean(sb);
    m.top150Team=isTop150Fixture(homeName,awayName);
    m.vipCandidate=Boolean(m.sportyBetAvailable && m.top150Team);
    m.sportyBetEventId=sb?.eventId||null;
    m.sportyBetMarkets=sb?{
      oneXTwo:Boolean(sb.oneXTwo),
      draw:Boolean(sb.draw),
      btts:Boolean(sb.btts)
    }:{oneXTwo:false,draw:false,btts:false};
    m.sportyBetOdds=sb?.odds||{oneXTwo:[],btts:[],doubleChance:[],totals:{}};
    m.bookmaker=sb?"SportyBet":null;
    return m;
  });
}
async function getFixturesWindow(startDate, days = 1) {
  const all = [];
  const seen = new Set();
  const sporty = await getSportyBetUpcoming(1,startDate);
  for (let offset = 0; offset < 1; offset++) {
    const date = addDays(startDate, offset);
    try {
      const result = await getFixtures(date);
      for (const match of result.matches || []) {
        const key = String(match.slug || match.id || (match.name + "|" + match.starting_at)).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        match.bigLeague = isBigLeague(match);
        match.windowDate = date;
        all.push(match);
      }
    } catch (e) {
      console.log("Fixture window lookup failed:", date, e.message);
    }
  }
  const marked = markSportyBetAvailability(all, sporty);
  marked.sort((a,b) =>
    Number(b.vipCandidate) - Number(a.vipCandidate) ||
    Number(b.sportyBetAvailable) - Number(a.sportyBetAvailable) ||
    Number(b.top150Team) - Number(a.top150Team) ||
    Number(b.bigLeague) - Number(a.bigLeague) ||
    (b.fixturePriority-a.fixturePriority) ||
    (new Date(a.starting_at||0)-new Date(b.starting_at||0))
  );
  return marked;
}
async function getFixtures(date) {
  const key = "fixtures:" + date;
  const cached = cacheGet(key);
  if (cached) return cached;
  const paths = [
    `/api/v1/fixtures/?sport=football&date=${encodeURIComponent(date)}&status=upcoming&limit=200`
  ];
  const data = await sportScoreRequest(paths[0]);
  const now = Date.now();
  const seen = new Set();
  const matches = [];
  for (const raw of extractMatches(data)) {
    const m = normalizeMatch(raw);
    const key2 = String(m.slug || m.id || `${m.name}|${m.starting_at}`).toLowerCase();
    if (seen.has(key2) || !m.homeTeam.name || !m.awayTeam.name) continue;
    seen.add(key2);
    const status = String(typeof m.status === "object" ? (m.status.name || m.status.type || m.status.short || "") : m.status).toLowerCase();
    if (/finished|ft|ended|completed|cancelled|abandoned|live|inplay|1h|2h|ht|halftime|extra time|penalties/.test(status)) continue;
    const kickoff = new Date(m.starting_at || 0).getTime();
    if (Number.isFinite(kickoff) && kickoff <= now) continue;
    m.fixturePriority = fixturePriorityScore(m);
    matches.push(m);
  }
  matches.sort((a,b) => (b.fixturePriority-a.fixturePriority) || (new Date(a.starting_at||0)-new Date(b.starting_at||0)));
  const result = { ok:true, provider:"SportScore", date, timezone:"UTC", count:matches.length, matches, message:`${matches.length} upcoming matches found.` };
  cacheSet(key, result, 2);
  return result;
}
async function getFixture(id) {
  const key = String(id || "").trim();
  if (!key) throw new Error("SportScore fixture ID/slug haipo.");
  const cached = cacheGet("fixture:"+key);
  if (cached) return cached;
  let data = null, last = null;
  for (const p of [`/api/widget/match/?sport=football&slug=${encodeURIComponent(key)}`, `/api/v1/match/?sport=football&slug=${encodeURIComponent(key)}`]) {
    try { data = await sportScoreRequest(p); break; } catch(e) { last=e; }
  }
  if (!data) throw new Error("SportScore haikuweza kufungua mchezo: " + (last?.message || "fixture not found"));
  const raw = data?.match || data?.fixture || data?.data?.match || data?.data?.fixture || data?.data || data;
  const fixture = normalizeMatch(raw);
  if (!fixture.homeTeam.name || !fixture.awayTeam.name) throw new Error("SportScore fixture haina home/away teams.");
  cacheSet("fixture:"+key, fixture, 10);
  return fixture;
}
function teamSlugCandidates(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return [];
  const variants = new Set();
  const compact = raw
    .normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (compact) variants.add(compact);
  const withoutClubSuffix = compact.replace(/-(fc|sc|cf|afc|fk|club|football-club|sports-club)$/i, "");
  if (withoutClubSuffix) variants.add(withoutClubSuffix);
  return [...variants];
}
function findTeamSearchResult(data, wanted) {
  const list=[];
  const pushCandidate=(name,slug)=>{
    if(!name || !slug) return;
    const s=String(slug).trim();
    if(!s || /^\\d+$/.test(s)) return;
    list.push({name:String(name),slug:s.replace(/^.*\//,"").replace(/\?.*$/,"").replace(/#.*$/,"")});
  };
  function walk(v) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const name=v.name||v.team_name||v.title||v.label;
    const slug=v.slug||v.team_slug;
    pushCandidate(name,slug);
    if (name && (v.site_url||v.url||v.href)) {
      const link=String(v.site_url||v.url||v.href);
      const parts=link.split("/").filter(Boolean);
      const last=parts[parts.length-1];
      if(last) pushCandidate(name,last);
    }
    for(const k of Object.keys(v)) if(k!=="raw") walk(v[k]);
  }
  walk(data);
  const w=String(wanted||"").toLowerCase().trim();
  return list.find(x=>x.name.toLowerCase()===w) ||
    list.find(x=>x.name.toLowerCase().includes(w)||w.includes(x.name.toLowerCase())) ||
    list[0] || null;
}
async function getTeamHistory(team) {
  const obj=typeof team === "object" ? team : {name:String(team||"")};
  const directSlugs=[obj.slug,obj.team_slug].filter(Boolean).map(String);
  const generatedSlugs=teamSlugCandidates(obj.name);
  const candidates=[...new Set([...directSlugs,...generatedSlugs])];

  async function tryCandidates(list){
    for(const slug of [...new Set(list)]){
      const key="team:"+slug, cached=cacheGet(key);
      if(cached) return cached;
      const attempts=[
        `/api/v1/fixtures/?sport=football&team=${encodeURIComponent(slug)}&status=finished&limit=30`,
        `/api/widget/team/?sport=football&slug=${encodeURIComponent(slug)}&limit=30`,
        `/api/v1/team/?sport=football&slug=${encodeURIComponent(slug)}&limit=30`
      ];
      for(const endpoint of attempts){
        try{
          const data=await sportScoreRequest(endpoint);
          const fixtures=extractMatches(data);
          if(fixtures.length){ cacheSet(key,fixtures,30); return fixtures; }
        }catch(e){
          const msg=String(e?.message||"");
          if(!/404|not found/i.test(msg)) console.log("Team history lookup failed:",obj.name||slug,msg);
        }
      }
    }
    return null;
  }

  let fixtures=await tryCandidates(candidates);
  if(fixtures) return fixtures;

  if(obj.name){
    try{
      const searchData=await sportScoreRequest(
        `/api/v1/search/?q=${encodeURIComponent(obj.name)}&sport=football&limit=20`
      );
      const found=findTeamSearchResult(searchData,obj.name);
      if(found?.slug){
        fixtures=await tryCandidates([found.slug]);
        if(fixtures) return fixtures;
      }
    }catch(e){
      console.log("Team search lookup failed:",obj.name,e.message);
    }
  }

  console.log("Team history unavailable after slug/search lookup:",obj.name||candidates[0]||"Unknown team");
  return [];
}

function scoreFromRaw(raw){
  const hs=Number(raw?.home_score ?? raw?.homeScore ?? raw?.score?.home ?? raw?.scores?.home ?? raw?.home?.score ?? raw?.scores?.full_time?.home);
  const as=Number(raw?.away_score ?? raw?.awayScore ?? raw?.score?.away ?? raw?.scores?.away ?? raw?.away?.score ?? raw?.scores?.full_time?.away);
  return {homeScore:hs,awayScore:as,valid:Number.isInteger(hs)&&Number.isInteger(as)&&hs>=0&&as>=0};
}
function fixtureForForm(raw){
  const n=normalizeMatch(raw), s=scoreFromRaw(raw);
  return {home:n.homeTeam,away:n.awayTeam,homeScore:s.homeScore,awayScore:s.awayScore,status:raw?.status||"",date:n.starting_at};
}
function teamForm(team, fixtures){
  const ref=typeof team === "object" ? team : {name:String(team||"")};
  const wanted=new Set([ref.id,ref.slug,ref.team_id,ref.team_slug,ref.name,ref.team_name].filter(Boolean).map(x=>String(x).trim().toLowerCase()));
  const games=[];
  for(const raw of fixtures||[]){
    const g=fixtureForForm(raw); const hi=[g.home.id,g.home.slug,g.home.name].filter(Boolean).map(x=>String(x).toLowerCase()); const ai=[g.away.id,g.away.slug,g.away.name].filter(Boolean).map(x=>String(x).toLowerCase());
    const isHome=hi.some(x=>wanted.has(x)), isAway=ai.some(x=>wanted.has(x)); if(!isHome&&!isAway||!Number.isFinite(g.homeScore)||!Number.isFinite(g.awayScore)) continue;
    const gf=isHome?g.homeScore:g.awayScore, ga=isHome?g.awayScore:g.homeScore; const result=gf>ga?"W":gf<ga?"L":"D";
    games.push({result,gf,ga,date:g.date,venueHome:isHome});
  }
  games.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const last=games.slice(0,10);
  if(!last.length) return {games:0,matches:0,wins:0,draws:0,losses:0,goalsFor:1.35,goalsAgainst:1.1,weightedPoints:1.35,weightedGoalsFor:1.35,weightedGoalsAgainst:1.1,homeGames:0,awayGames:0,homeGoalsFor:1.35,homeGoalsAgainst:1.1,awayGoalsFor:1.25,awayGoalsAgainst:1.15,form:"N/A",opponentRatings:[]};
  let wins=0,draws=0,losses=0,gf=0,ga=0,wp=0,wgf=0,wga=0,ws=0; const home=[],away=[];
  last.forEach((g,i)=>{const w=Math.max(.35,Math.exp(-.18*i)),pts=g.result==="W"?3:g.result==="D"?1:0; if(g.result==="W")wins++;else if(g.result==="D")draws++;else losses++;gf+=g.gf;ga+=g.ga;wp+=pts*w;wgf+=g.gf*w;wga+=g.ga*w;ws+=w;(g.venueHome?home:away).push(g);});
  const avg=arr=>arr.length?{gf:arr.reduce((s,g)=>s+g.gf,0)/arr.length,ga:arr.reduce((s,g)=>s+g.ga,0)/arr.length}:null; const h=avg(home),a=avg(away);
  const ppg=(wins*3+draws)/last.length,gd=(gf-ga)/last.length; const rating=Math.max(1200,Math.min(1800,1500+(ppg-1.35)*180+gd*70));
  return {games:last.length,matches:last.length,wins,draws,losses,goalsFor:gf/last.length,goalsAgainst:ga/last.length,weightedPoints:ws?wp/ws:1.35,weightedGoalsFor:ws?wgf/ws:gf/last.length,weightedGoalsAgainst:ws?wga/ws:ga/last.length,goalDiff:gf-ga,strengthRating:Math.round(rating*10)/10,homeGames:home.length,awayGames:away.length,homeGoalsFor:h?.gf??1.35,homeGoalsAgainst:h?.ga??1.1,awayGoalsFor:a?.gf??1.25,awayGoalsAgainst:a?.ga??1.15,form:last.map(x=>x.result).join(""),opponentRatings:[]};
}

function aiUsageToday(){const today=new Date().toISOString().slice(0,10);const used=db.predictions.filter(p=>String(p.createdAt||"").slice(0,10)===today&&p.ai?.enabled).length;return {date:today,used,limit:MAX_AI_DAILY,remaining:Math.max(0,MAX_AI_DAILY-used)};}
async function runFootballAI(context){
  if(!OPENAI_API_KEY) return {enabled:false,model:null,status:"OPENAI_API_KEY haijawekwa.",bestPick:"No Strong Pick",confidence:0,homeProbability:context.statistical.probabilities.home,drawProbability:context.statistical.probabilities.draw,awayProbability:context.statistical.probabilities.away,over25Probability:context.statistical.over25,bttsProbability:context.statistical.btts,correctScore:"N/A",factors:[],analysis:"AI haijawezeshwa; statistical engine imetumika.",risk:"AI unavailable"};
  const usage=aiUsageToday();
  if(usage.used>=usage.limit) return {enabled:false,model:OPENAI_MODEL,status:"AI daily budget reached",bestPick:"No Strong Pick",confidence:0,homeProbability:context.statistical.probabilities.home,drawProbability:context.statistical.probabilities.draw,awayProbability:context.statistical.probabilities.away,over25Probability:context.statistical.over25,bttsProbability:context.statistical.btts,correctScore:"N/A",factors:["Daily AI limit reached","Statistical engine retained","Credits protected"],analysis:"AI daily limit reached; statistical engine retained.",risk:"AI budget limit",usage};
  const schema={type:"object",additionalProperties:false,properties:{bestPick:{type:"string",enum:["Home Win","Draw","Away Win","No Strong Pick"]},confidence:{type:"number",minimum:0,maximum:100},homeProbability:{type:"number",minimum:0,maximum:100},drawProbability:{type:"number",minimum:0,maximum:100},awayProbability:{type:"number",minimum:0,maximum:100},over25Probability:{type:"number",minimum:0,maximum:100},bttsProbability:{type:"number",minimum:0,maximum:100},correctScore:{type:"string"},analysis:{type:"string"},factors:{type:"array",items:{type:"string"},minItems:3,maxItems:6},risk:{type:"string"}},required:["bestPick","confidence","homeProbability","drawProbability","awayProbability","over25Probability","bttsProbability","correctScore","analysis","factors","risk"]};
  const prompt={role:"system",content:`You are Fanuel Football Prediction AI Validator. You are NOT the primary calculator. Validate the supplied statistical model. Use only supplied football data. Never invent injuries, odds, news, form or results. Check home/away strength, recent form, goal profile, sample size and uncertainty. If evidence conflicts or is too weak, return No Strong Pick. Do not force a winner. Your probabilities are an independent validation signal and must be realistic, not extreme without evidence. Return concise factual reasoning.`};
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+OPENAI_API_KEY},body:JSON.stringify({model:OPENAI_MODEL,reasoning:{effort:"high"},input:[prompt,{role:"user",content:JSON.stringify(context)}],text:{format:{type:"json_schema",name:"fanuel_football_validator",strict:true,schema}},store:false})});
  const raw=await response.text(); let data; try{data=JSON.parse(raw);}catch{throw new Error("OpenAI response is not JSON. HTTP "+response.status);}
  if(!response.ok) throw new Error(data?.error?.message||("OpenAI HTTP "+response.status));
  const text=data.output_text||data.output?.flatMap(x=>x.content||[]).filter(x=>x.type==="output_text").map(x=>x.text).join("")||""; if(!text) throw new Error("OpenAI haikurudisha analysis.");
  let ai; try{ai=JSON.parse(text);}catch{throw new Error("AI output haikuwa JSON.");}
  return {enabled:true,model:OPENAI_MODEL,status:"AI validation active",...ai};
}
function historyRows(){return db.results.map(r=>{const p=db.predictions.find(x=>String(x.fixtureId)===String(r.fixtureId));return p&&(p.vip?.eligible===true||p.vvip?.eligible===true)?{prediction:p,result:r}:null;}).filter(Boolean);}
function attachAI(result,ai){result.ai={enabled:Boolean(ai.enabled),model:ai.model||null,status:ai.status||"",bestPick:ai.bestPick||"No Strong Pick",confidence:Number(ai.confidence||0),suggestedCorrectScore:result.decisionStatus==="NO_STRONG_PICK"?"N/A":(ai.correctScore||"N/A"),analysis:result.decisionStatus==="NO_STRONG_PICK"&&ai.enabled?"No Strong Pick: models do not justify forcing a directional winner.":(ai.analysis||""),factors:Array.isArray(ai.factors)?ai.factors:[],risk:result.risk};return result;}
async function analyze(fixtureId,suppliedMatch,options={}){
  const deepAnalysis = options.deepAnalysis !== false;
  let fixture;
  if(suppliedMatch&&typeof suppliedMatch==="object"){
    const raw=suppliedMatch.raw||suppliedMatch;
    const suppliedSportyAvailable = suppliedMatch.sportyBetAvailable === true;
    const suppliedSportyMarkets = suppliedMatch.sportyBetMarkets || null;
    const suppliedSportyEventId = suppliedMatch.sportyBetEventId || null;
    const suppliedSportyOdds = suppliedMatch.sportyBetOdds || null;
    fixture=normalizeMatch(raw);
    fixture.id=String(suppliedMatch.id||suppliedMatch.slug||raw.id||raw.slug||raw.match_id||raw.fixture_id||fixture.id||("auto-"+fixture.homeTeam.name+"-"+fixture.awayTeam.name+"-"+Date.now()));
    fixture.slug=suppliedMatch.slug||raw.slug||fixture.id;
    fixture.raw=raw;
    fixture.sportyBetAvailable=suppliedSportyAvailable;
    fixture.sportyBetMarkets=suppliedSportyMarkets;
    fixture.sportyBetEventId=suppliedSportyEventId;
    fixture.bookmaker=suppliedSportyAvailable ? "SportyBet" : null;
  }else fixture=await getFixture(fixtureId);
  if(!fixture.homeTeam.name||!fixture.awayTeam.name) throw new Error("SportScore haikurudisha home/away teams.");
  const existingPrediction = [...db.predictions].reverse().find(p => String(p.fixtureId) === String(fixture.id));
  if (existingPrediction) return {...existingPrediction, duplicateRequest:true, duplicateOfCreatedAt:existingPrediction.createdAt};
  const [hh,ah]=await Promise.all([getTeamHistory(fixture.homeTeam),getTeamHistory(fixture.awayTeam)]);
  fixture.sportyBetAvailable = fixture.sportyBetAvailable === true || fixture.bookmaker === "SportyBet";
  const homeForm=teamForm(fixture.homeTeam,hh), awayForm=teamForm(fixture.awayTeam,ah);
  const statistical=engine.buildStatisticalModel({id:fixture.id,teams:{home:fixture.homeTeam,away:fixture.awayTeam},league:fixture.league},homeForm,awayForm);
  statistical.sportyBetAvailable = fixture.sportyBetAvailable === true;
  statistical.bookmaker = fixture.sportyBetAvailable ? "SportyBet" : null;
  statistical.sportyBetEventId = fixture.sportyBetEventId || null;
  statistical.sportyBetMarkets = fixture.sportyBetMarkets || null;
  statistical.top150Team = fixture.top150Team === true;
  let ai;
  try{
    ai=await runFootballAI({
      fixture:{
        id:fixture.id,
        slug:fixture.slug,
        date:fixture.starting_at,
        league:fixture.league,
        home:fixture.homeTeam,
        away:fixture.awayTeam
      },
      homeForm,
      awayForm,
      statistical
    });
    if(!ai?.enabled) throw new Error(ai?.status || "AI validation unavailable");
  }catch(e){
    console.log("OpenAI deep-analysis error:",e.message);
    throw new Error("AI Deep Analysis unavailable: " + e.message);
  }
  const result=engine.buildFinal(statistical,ai,historyRows(),{home:homeForm,away:awayForm});
  result.form={home:homeForm,away:awayForm};
  result.provider="SportScore"; result.usesOdds=false; result.sportyBetOdds=fixture.sportyBetOdds||null; result.sportyBetEventId=fixture.sportyBetEventId||null; result.top150Team = fixture.top150Team === true; result.predictionSnapshot={probabilities:{...result.probabilities},over25:result.over25,btts:result.btts,confidence:result.confidence,league:fixture.league||null};
  result.createdAt=new Date().toISOString();
  attachAI(result,ai);
  // VIP mode: qualifying matches are stored; non-qualifying fixtures remain visible in the frontend.
  result.vip = engine.vipSelection(result,ai);
  if(!result.vip.eligible) return result;

  // Prevent duplicate AI usage/storage for the same fixture.
  const existing = [...db.predictions].reverse().find(p => String(p.fixtureId) === String(result.fixtureId));
  if (existing) {
    return {
      ...existing,
      duplicateRequest: true,
      duplicateOfCreatedAt: existing.createdAt
    };
  }

  db.predictions.push(result);
  if (db.predictions.length > 500) db.predictions = db.predictions.slice(-500);
  saveDB(db);
  return result;
}

function countSportyOdds(o){
  if(!o) return 0;
  const t=o.totals&&typeof o.totals==="object" ? Object.values(o.totals).reduce((n,a)=>n+(Array.isArray(a)?a.length:0),0) : 0;
  return (o.oneXTwo||[]).length+(o.btts||[]).length+(o.doubleChance||[]).length+t;
}
function dailyOdds15Candidates(predictions){
  const rows=[];
  const dcProb=(p,pick)=>{
    const home=Number(p.probabilities?.home||0);
    const draw=Number(p.probabilities?.draw||0);
    const away=Number(p.probabilities?.away||0);
    return pick==="1X"?home+draw:pick==="X2"?away+draw:home+away;
  };
  for(const p of predictions||[]){
    if(!p?.ai?.enabled||p.pick==="No Strong Pick") continue;
    const quality=String(p.dataQuality?.level||"low").toLowerCase();
    if(quality!=="high"&&quality!=="medium") continue;
    const confidence=Number(p.confidence||p.ai?.confidence||0);
    if(confidence<55) continue;
    const odds=p.sportyBetOdds||{};
    const add=(market,pick,odd,prob)=>{
      const o=Number(odd), pr=Number(prob);
      if(!Number.isFinite(o)||o<=1||!Number.isFinite(pr)||pr<55) return;
      const implied=100/o;
      const edge=pr-implied;
      const risk=String(p.risk||p.ai?.risk||"Unknown");
      const penalty=/high/i.test(risk)?12:0;
      const safety=pr+(quality==="high"?6:2)+(confidence-50)*0.3+edge*0.45-penalty;
      rows.push({
        fixtureId:String(p.fixtureId||""),
        match:p.match||((p.homeTeam||"Home")+" vs "+(p.awayTeam||"Away")),
        homeTeam:p.homeTeam||"",
        awayTeam:p.awayTeam||"",
        league:p.league?.name||p.league||"Football",
        market,pick,odds:o,probability:Math.round(pr*10)/10,
        impliedProbability:Math.round(implied*10)/10,edge:Math.round(edge*10)/10,
        confidence:Math.round(confidence*10)/10,quality,risk,safetyScore:Math.round(safety*10)/10,
        sportyBetEventId:p.sportyBetEventId||null
      });
    };

    if(p.pick==="Home Win"||p.pick==="Away Win"){
      const oneX=Array.isArray(odds.oneXTwo)?odds.oneXTwo:[];
      const x=oneX.find(v=>v.pick===p.pick);
      const pr=p.pick==="Home Win"?Number(p.probabilities?.home||0):Number(p.probabilities?.away||0);
      if(x) add("1X2",p.pick,x.odds,pr);
    }

    const dc=Array.isArray(odds.doubleChance)?odds.doubleChance:[];
    for(const pick of ["1X","X2","12"]){
      const x=dc.find(v=>v.pick===pick);
      if(x){
        const pr=dcProb(p,pick);
        if(pr>=62) add("Double Chance",pick,x.odds,pr);
      }
    }

    const bProb=Number(p.btts||p.ai?.bttsProbability||0);
    const bPick=bProb>=50?"BTTS YES":"BTTS NO";
    const bx=(Array.isArray(odds.btts)?odds.btts:[]).find(v=>v.pick===bPick);
    if(bx) add("GG/NG",bPick,bx.odds,bProb);

    const totals=odds.totals||{};
    for(const spec of [["1.5","Over 1.5",Number(p.over15||0)],["2.5","Over 2.5",Number(p.over25||0)],["3.5","Over 3.5",Number(p.over35||0)]]){
      const line=spec[0], overPick=spec[1], overProb=spec[2];
      const arr=Array.isArray(totals[line])?totals[line]:[];
      const wanted=overProb>=55?overPick:"Under "+line;
      const prob=overProb>=55?overProb:100-overProb;
      const x=arr.find(v=>v.pick===wanted);
      if(x&&prob>=60) add("Total Goals",wanted,x.odds,prob);
    }
  }
  const best=new Map();
  for(const x of rows){
    const key=x.fixtureId+"|"+x.market+"|"+x.pick;
    const prev=best.get(key);
    if(!prev||x.safetyScore>prev.safetyScore) best.set(key,x);
  }
  return [...best.values()].sort((a,b)=>b.safetyScore-a.safetyScore);
}

async function buildDailyOdds15(date,predictions){
  let sporty={matches:[]};
  try{
    sporty=await getSportyBetUpcoming(1,date);
  }catch(e){
    console.log("Daily Odds 15 SportyBet refresh failed:",e.message);
  }
  const sportyMatches=Array.isArray(sporty?.matches)?sporty.matches:[];
  const enriched=(predictions||[]).map(p=>{
    if(countSportyOdds(p?.sportyBetOdds)>0) return p;
    const home=p?.homeTeam||"";
    const away=p?.awayTeam||"";
    const sb=sportyMatches.find(x=>
      (p?.sportyBetEventId && String(x?.eventId||"")===String(p.sportyBetEventId)) ||
      (teamNamesMatch(home,x?.homeTeam)&&teamNamesMatch(away,x?.awayTeam))
    );
    return sb?{...p,sportyBetOdds:sb.odds||{oneXTwo:[],btts:[],doubleChance:[],totals:{}},sportyBetEventId:sb.eventId}:p;
  });

  const all=dailyOdds15Candidates(enriched);
  const pool=all.filter(x=>x.odds<=3.5&&x.probability>=58).slice(0,60);
  let best=null;

  const dfs=(start,chosen,product,safety,used)=>{
    if(chosen.length===5){
      if(product>=14&&product<=16.25){
        const score=Math.abs(Math.log(product/15))*45-(safety/5)*0.35;
        if(!best||score<best.score) best={score,product,chosen:[...chosen],avgSafety:safety/5};
      }
      return;
    }
    for(let i=start;i<pool.length;i++){
      const x=pool[i];
      if(used.has(x.fixtureId)) continue;
      const next=product*x.odds;
      if(next>16.25) continue;
      const used2=new Set(used);used2.add(x.fixtureId);
      dfs(i+1,[...chosen,x],next,safety+x.safetyScore,used2);
    }
  };

  dfs(0,[],1,0,new Set());

  const diag={
    candidateCount:all.length,
    sportyBetEventsChecked:sportyMatches.length,
    sportyBetEventsWithOdds:sportyMatches.filter(x=>countSportyOdds(x?.odds)>0).length
  };

  if(!best){
    return {
      eligible:false,date,selections:[],totalOdds:null,
      ...diag,
      message:"Hakuna combination ya selections 5 yenye odds karibu 15.00 bila kuongeza selection yenye risk kubwa. Mfumo haujalazimisha slip."
    };
  }

  return {
    eligible:true,type:"DAILY ODDS 15",label:"15 ODDS SURE — 5 PICKS",
    date,bookmaker:"SportyBet Tanzania",targetOdds:15,
    totalOdds:Math.round(best.product*100)/100,
    selections:best.chosen.map((x,i)=>({...x,number:i+1})),
    averageSafety:Math.round(best.avgSafety*10)/10,
    ...diag,generatedAt:new Date().toISOString(),
    disclaimer:"Conservative model selection only. No bet is guaranteed; total odds near 15 carry substantial loss risk."
  };
}

function sendJSON(res,status,data){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"});res.end(JSON.stringify(data));}
function normalizeTeamName(name){return String(name||"").toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9]+/g," ").trim();}
function actualPick(h,a){return h>a?"Home Win":h<a?"Away Win":"Draw";}
function settlementMetrics(prediction,homeScore,awayScore){const pick=actualPick(homeScore,awayScore),total=homeScore+awayScore;const predictedScore=String(prediction?.correctScore||"");return {actualPick:pick,actualOver25:total>=3,actualBTTS:homeScore>=1&&awayScore>=1,actualScore:`${homeScore}-${awayScore}`,correct:prediction?.pick==="No Strong Pick"?null:prediction?.pick===pick,over25Correct:Number(prediction?.over25||0)>=50?total>=3:total<3,bttsCorrect:Number(prediction?.btts||0)>=50?(homeScore>=1&&awayScore>=1):!(homeScore>=1&&awayScore>=1),correctScore:predictedScore===`${homeScore}-${awayScore}`};}
function saveSettlement(prediction,fixtureId,homeScore,awayScore,source){const r={fixtureId:String(fixtureId),homeScore,awayScore,...settlementMetrics(prediction,homeScore,awayScore),confidence:Number(prediction?.confidence||0),predictedPick:prediction?.pick||"",predictedProbabilities:prediction?.probabilities||{},predictedOver25:Number(prediction?.over25||0),predictedBTTS:Number(prediction?.btts||0),settledAt:new Date().toISOString(),source};db.results=db.results.filter(x=>String(x.fixtureId)!==String(fixtureId));db.results.push(r);saveDB(db);return r;}
async function findFinishedFixtureForPrediction(prediction){const id=String(prediction?.fixtureId||""),home=normalizeTeamName(prediction?.homeTeam),away=normalizeTeamName(prediction?.awayTeam),base=new Date(prediction?.createdAt||Date.now());if(Number.isNaN(base.getTime()))return null;for(const offset of [-2,-1,0,1,2]){const d=new Date(base.getTime()+offset*86400000).toISOString().slice(0,10);try{const data=await sportScoreRequest(`/api/v1/fixtures/?sport=football&date=${d}&limit=200`);for(const raw of extractMatches(data)){const n=normalizeMatch(raw),rid=String(raw?.id||raw?.slug||raw?.match_id||raw?.fixture_id||n.id||""),team=normalizeTeamName(n.homeTeam.name)===home&&normalizeTeamName(n.awayTeam.name)===away;if((id&&(rid===id||n.slug===id)||team)){const s=scoreFromRaw(raw);if(s.valid)return{homeScore:s.homeScore,awayScore:s.awayScore,matchedBy:id===rid?"fixture-id":"team-names"};}}}catch(e){console.log("Settlement lookup failed:",d,e.message);}}return null;}
function brier(actual,p){const t=actual==="Home Win"?[1,0,0]:actual==="Draw"?[0,1,0]:[0,0,1],v=[Number(p.home||0)/100,Number(p.draw||0)/100,Number(p.away||0)/100];return(v[0]-t[0])**2+(v[1]-t[1])**2+(v[2]-t[2])**2;}
function logLoss(actual,p){const v=actual==="Home Win"?Number(p.home||0)/100:actual==="Draw"?Number(p.draw||0)/100:Number(p.away||0)/100;return-Math.log(Math.max(.0001,Math.min(.9999,v)));}
function calibrationBuckets(rows){const b={"50-59":{count:0,correct:0,avgConfidence:0},"60-69":{count:0,correct:0,avgConfidence:0},"70-79":{count:0,correct:0,avgConfidence:0},"80+":{count:0,correct:0,avgConfidence:0}};for(const r of rows){if(r.prediction.pick==="No Strong Pick")continue;const c=Math.max(0,Math.min(100,Number(r.prediction.confidence||0))),k=c>=80?"80+":c>=70?"70-79":c>=60?"60-69":"50-59";b[k].count++;b[k].correct+=r.result.correct===true?1:0;b[k].avgConfidence+=c;}for(const x of Object.values(b)){x.accuracy=x.count?Math.round(x.correct/x.count*1000)/10:null;x.avgConfidence=x.count?Math.round(x.avgConfidence/x.count*10)/10:null;}return b;}

async function api(req,res,url){
  if(url.pathname==="/api/health")return sendJSON(res,200,{ok:true,provider:"SportScore",tokenConfigured:true,aiConfigured:Boolean(OPENAI_API_KEY),aiModel:OPENAI_MODEL,vipOnly:false,bookmaker:"SportyBet",sportyBetEnabled:SPORTYBET_ENABLED,dailyOdds15Enabled:true,vipCandidates:VIP_CANDIDATES,service:"Fanuel Football Prediction",engine:"v4-multi-model-calibrated",serverTime:new Date().toISOString()});
  if(url.pathname==="/api/ai-health")return sendJSON(res,200,{ok:true,configured:Boolean(OPENAI_API_KEY),model:OPENAI_MODEL,message:OPENAI_API_KEY?"OpenAI football AI is configured.":"OPENAI_API_KEY haijawekwa kwenye Render."});
  if(url.pathname==="/api/system-status"){const rows=historyRows();return sendJSON(res,200,{ok:true,provider:"SportScore",ai:{configured:Boolean(OPENAI_API_KEY),model:OPENAI_MODEL,usage:aiUsageToday()},predictions:{total:db.predictions.filter(p=>p.vip?.eligible===true||p.vvip?.eligible===true).length,storedTotal:db.predictions.length,settled:rows.length,pending:Math.max(0,db.predictions.filter(p=>p.vip?.eligible===true||p.vvip?.eligible===true).length-rows.length)},calibrationReady:rows.length>=10,vipOnly:false,bookmaker:"SportyBet",sportyBetEnabled:SPORTYBET_ENABLED,dailyOdds15Enabled:true,vipCandidates:VIP_CANDIDATES,vipCriteria:{markets:["1X2","DRAW","BTTS"],aiActive:true,bookmaker:"SportyBet",dataQuality:["HIGH","MEDIUM"],minimumSample:3,venueFallback:true,oneXTwo:{confidenceMin:56,topProbabilityMin:52,marginMin:6,agreementMin:75,distributionDistanceMax:14,stability:["STABLE","MODERATE"],requiresSportyBet1X2:true},draw:{probabilityMin:29,drawEdgeMin:2,agreementMin:75,distributionDistanceMax:14,stability:["STABLE","MODERATE"]},btts:{confidenceMin:56,edgeMin:6,modelDistanceMax:14,agreementMin:75,stability:["STABLE","MODERATE"],requiresSportyBetGGNG:true}},engine:"Fanuel Advanced Multi-Model v4",layers:["team strength","home/away specialist","recent form","opponent-adjusted when available","goal probabilities","AI validation","ensemble","calibration","NO STRONG PICK","VIP gate","correct-score distribution"],oddsUsed:false});}
  if(url.pathname==="/api/upcoming"){
    const date=url.searchParams.get("date")||new Date().toISOString().slice(0,10);
    const days=1;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return sendJSON(res,400,{ok:false,error:"Tumia date ya YYYY-MM-DD"});
    try{
      const windowMatches=await getFixturesWindow(date,days);
      const matches=windowMatches.slice(0,150);
      const bigLeagueCount=matches.filter(m=>m.bigLeague).length;
      const sportyBetCount=matches.filter(m=>m.sportyBetAvailable).length;
      const top150Count=matches.filter(m=>m.top150Team).length;
      const vipCandidateCount=matches.filter(m=>m.vipCandidate).length;
      const toDate=date;
      return sendJSON(res,200,{ok:true,provider:"SportScore",requestedDate:date,searchDays:days,fromDate:date,toDate,dailyLimit:150,vvipOnly:false,allMatches:true,priorityMode:"SPORTYBET_AVAILABLE_FIRST_THEN_BIG_LEAGUES",bookmaker:"SportyBet",sportyBetEnabled:SPORTYBET_ENABLED,sportyBetCount,top150Count,vipCandidateCount,deepAnalysisLimit:DEEP_ANALYSIS_LIMIT,bigLeagueCount,candidateCount:matches.length,count:matches.length,matches,message:`${matches.length} matches for ${date}; SportyBet-listed matches are prioritized, then big leagues; VIP-qualified picks are highlighted first.`});
    }catch(e){return sendJSON(res,500,{ok:false,error:e.message});}
  }
  if(url.pathname==="/api/sportscore-test"||url.pathname==="/api/test"){
    const date=url.searchParams.get("date")||new Date().toISOString().slice(0,10);try{const r=await getFixtures(date);return sendJSON(res,200,{ok:true,provider:"SportScore",date,count:r.matches.length,matches:r.matches.slice(0,10),message:"SportScore API inafanya kazi."});}catch(e){return sendJSON(res,502,{ok:false,provider:"SportScore",error:e.message});}
  }
  if(url.pathname==="/api/analyze-fixture"){
    if(req.method!=="POST")return sendJSON(res,405,{ok:false,error:"POST required"});let body="";req.on("data",c=>{body+=c.toString();if(body.length>1024*1024)req.destroy();});req.on("end",async()=>{try{const data=JSON.parse(body||"{}"),m=data.match||null,id=String(data.fixtureId||m?.fixture?.id||m?.fixture?.slug||m?.id||m?.slug||"");if(!id&&!m)return sendJSON(res,400,{ok:false,error:"SportScore match data haikupatikana."});const prediction=await analyze(id,m,{deepAnalysis:data.deepAnalysis !== false});return sendJSON(res,200,{ok:true,prediction});}catch(e){console.log("Analysis error:",e.message);return sendJSON(res,500,{ok:false,error:e.message});}});return;
  }
  if(url.pathname==="/api/predictions"){const predictions=db.predictions.filter(p=>p.vip?.eligible===true||p.vvip?.eligible===true);return sendJSON(res,200,{ok:true,vipOnly:false,predictions});}
  if(url.pathname==="/api/performance"||url.pathname==="/api/backtest"){
    const rows=historyRows().filter(r=>r.prediction.pick!=="No Strong Pick");let correct=0,o=0,b=0,exact=0,bs=0,ll=0;for(const r of rows){if(r.result.correct)correct++;if(r.result.over25Correct)o++;if(r.result.bttsCorrect)b++;if(r.result.correctScore)exact++;bs+=brier(r.result.actualPick,r.prediction.probabilities);ll+=logLoss(r.result.actualPick,r.prediction.probabilities);}return sendJSON(res,200,{ok:true,mode:url.pathname==="/api/backtest"?"settled-history-backtest":"live-performance",totalPredictions:db.predictions.length,settled:rows.length,completed:rows.length,correct,accuracy:rows.length?Math.round(correct/rows.length*1000)/10:0,over25Accuracy:rows.length?Math.round(o/rows.length*1000)/10:0,bttsAccuracy:rows.length?Math.round(b/rows.length*1000)/10:0,exactScoreAccuracy:rows.length?Math.round(exact/rows.length*1000)/10:0,brierScore:rows.length?Math.round(bs/rows.length*10000)/10000:null,logLoss:rows.length?Math.round(ll/rows.length*10000)/10000:null,calibration:calibrationBuckets(rows),calibrationModel:engine.confidenceCalibration(rows),aiUsage:aiUsageToday(),note:rows.length<10?"Calibration is preliminary until 10+ settled directional predictions.":"Calibration uses settled directional predictions only; abstentions are excluded from win/loss accuracy."});
  }
  if(url.pathname==="/api/settle"){
    if(req.method!=="POST")return sendJSON(res,405,{ok:false,error:"POST required"});let body="";req.on("data",c=>body+=c.toString());req.on("end",()=>{try{const d=JSON.parse(body||"{}"),id=String(d.fixtureId||""),hs=Number(d.homeScore),as=Number(d.awayScore),p=[...db.predictions].reverse().find(x=>String(x.fixtureId)===id);if(!id||!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return sendJSON(res,400,{ok:false,error:"fixtureId, homeScore and awayScore are required."});if(!p)return sendJSON(res,404,{ok:false,error:"Prediction haijapatikana."});return sendJSON(res,200,{ok:true,result:saveSettlement(p,id,hs,as,"manual")});}catch(e){return sendJSON(res,400,{ok:false,error:"Invalid JSON or settlement data."});}});return;
  }
  if(url.pathname==="/api/settle-fixture"){
    if(req.method!=="POST")return sendJSON(res,405,{ok:false,error:"POST required"});let body="";req.on("data",c=>body+=c.toString());req.on("end",async()=>{try{const d=JSON.parse(body||"{}"),id=String(d.fixtureId||"");if(!id)return sendJSON(res,400,{ok:false,error:"fixtureId required"});const f=await getFixture(id),s=scoreFromRaw(f.raw||{});if(!s.valid)return sendJSON(res,409,{ok:false,settled:false,status:f.status,error:"Mchezo bado hauna score ya mwisho kutoka SportScore."});const p=[...db.predictions].reverse().find(x=>String(x.fixtureId)===id);if(!p)return sendJSON(res,404,{ok:false,error:"Prediction haijapatikana."});return sendJSON(res,200,{ok:true,settled:true,result:saveSettlement(p,id,s.homeScore,s.awayScore,"SportScore")});}catch(e){return sendJSON(res,500,{ok:false,error:e.message});}});return;
  }
  if(url.pathname==="/api/settle-pending"){
    if(req.method!=="GET"&&req.method!=="POST")return sendJSON(res,405,{ok:false,error:"GET or POST required"});const cutoff=Date.now()-2*3600000,pending=db.predictions.filter(p=>p.createdAt&&new Date(p.createdAt).getTime()<cutoff&&!db.results.some(r=>String(r.fixtureId)===String(p.fixtureId))).slice(-50),settled=[],skipped=[];for(const p of pending){try{const f=await findFinishedFixtureForPrediction(p);if(f)settled.push(saveSettlement(p,p.fixtureId,f.homeScore,f.awayScore,"SportScore-auto-"+f.matchedBy));else skipped.push({fixtureId:p.fixtureId,reason:"Final score not found yet"});}catch(e){skipped.push({fixtureId:p.fixtureId,reason:e.message});}}return sendJSON(res,200,{ok:true,checked:pending.length,settled:settled.length,results:settled,skipped});
  }

  if(url.pathname==="/api/daily-odds15"){
    if(req.method==="GET"){
      const date=url.searchParams.get("date")||new Date().toISOString().slice(0,10);
      const slip=[...db.dailyOdds15].reverse().find(x=>x.date===date)||null;
      return sendJSON(res,200,{ok:true,date,slip});
    }
    if(req.method!=="POST") return sendJSON(res,405,{ok:false,error:"GET or POST required"});
    let body="";req.on("data",c=>{body+=c.toString();if(body.length>5*1024*1024)req.destroy();});
    req.on("end",()=>{
      try{
        const d=JSON.parse(body||"{}"),date=String(d.date||"").trim(),predictions=Array.isArray(d.predictions)?d.predictions:[];
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return sendJSON(res,400,{ok:false,error:"date ya YYYY-MM-DD inahitajika"});
        const slip=await buildDailyOdds15(date,predictions);
        db.dailyOdds15=db.dailyOdds15.filter(x=>x.date!==date);db.dailyOdds15.push(slip);
        if(db.dailyOdds15.length>60)db.dailyOdds15=db.dailyOdds15.slice(-60);
        saveDB(db);return sendJSON(res,200,{ok:true,slip});
      }catch(e){return sendJSON(res,400,{ok:false,error:"Daily Odds 15 generation failed: "+e.message});}
    });return;
  }

  if(url.pathname==="/api/ai-demo"){
    try{const stat={fixtureId:"demo-001",match:"Demo United vs Demo City",homeTeam:"Demo United",awayTeam:"Demo City",pick:"Home Win",confidence:55,probabilities:{home:55,draw:25,away:20},over25:58,btts:54};const ai=await runFootballAI({fixture:{id:"demo-001",home:{name:"Demo United"},away:{name:"Demo City"},league:{name:"AI Test"}},homeForm:{games:5,wins:3,draws:1,losses:1,goalsFor:1.8,goalsAgainst:.9},awayForm:{games:5,wins:2,draws:1,losses:2,goalsFor:1.2,goalsAgainst:1.4},statistical:stat});return sendJSON(res,200,{ok:true,engine:"Fanuel Football AI Validator",model:OPENAI_MODEL,ai});}catch(e){return sendJSON(res,500,{ok:false,error:e.message});}
  }
  return sendJSON(res,404,{ok:false,error:"API route not found"});
}
function serveFile(req,res){let file;try{file=decodeURIComponent(new URL(req.url,"http://localhost").pathname);}catch{return res.writeHead(400),res.end("Bad Request");}if(file==="/")file="/index.html";const root=path.resolve(PUBLIC_DIR),fp=path.resolve(PUBLIC_DIR,"."+file);if(fp!==root&&!fp.startsWith(root+path.sep))return res.writeHead(403),res.end("Forbidden");fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});return res.end("Not found");}const ext=path.extname(fp).toLowerCase(),types={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".svg":"image/svg+xml",".ico":"image/x-icon",".webp":"image/webp"};res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":ext===".html"?"no-cache":"public, max-age=3600"});res.end(data);});}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://localhost:${PORT}`);if(url.pathname.startsWith("/api/"))return await api(req,res,url);serveFile(req,res);}catch(e){console.log("Server error:",e.message);if(!res.headersSent)sendJSON(res,500,{ok:false,error:"Internal server error"});}});
async function runAutomaticSettlement(){try{const cutoff=Date.now()-2*3600000,pending=db.predictions.filter(p=>p.createdAt&&new Date(p.createdAt).getTime()<cutoff&&!db.results.some(r=>String(r.fixtureId)===String(p.fixtureId))).slice(-50);let settled=0;for(const p of pending){const f=await findFinishedFixtureForPrediction(p);if(f){saveSettlement(p,p.fixtureId,f.homeScore,f.awayScore,"SportScore-background-"+f.matchedBy);settled++;}}if(pending.length)console.log("Automatic settlement:",settled+"/"+pending.length);}catch(e){console.log("Automatic settlement error:",e.message);}}
server.listen(PORT,()=>{console.log("======================================");console.log("Fanuel Football Prediction v4");console.log("Server running on port:",PORT);console.log("SportScore provider:",SPORTSCORE_BASE);console.log("OpenAI configured:",Boolean(OPENAI_API_KEY));console.log("Engine: v4-multi-model-calibrated");console.log("======================================");setTimeout(runAutomaticSettlement,5000);setInterval(runAutomaticSettlement,15*60000);});
