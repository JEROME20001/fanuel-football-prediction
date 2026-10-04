const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

// SportScore is the primary football data provider.
// Its current public API can be used without an API key on the free tier.
const SPORTSCORE_BASE = "https://sportscore.com";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* =====================================================
   DATABASE
===================================================== */

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return {
        predictions: [],
        results: []
      };
    }

    const data = JSON.parse(
      fs.readFileSync(DB_FILE, "utf8")
    );

    return {
      predictions: Array.isArray(data.predictions)
        ? data.predictions
        : [],

      results: Array.isArray(data.results)
        ? data.results
        : []
    };

  } catch (err) {
    console.log("DB load error:", err.message);

    return {
      predictions: [],
      results: []
    };
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(db, null, 2),
      "utf8"
    );
  } catch (err) {
    console.log(
      "DB save error:",
      err.message
    );
  }
}

const db = loadDB();

/* =====================================================
   CACHE
===================================================== */

const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function cacheSet(key, value, minutes) {
  cache.set(key, {
    value,
    expires:
      Date.now() +
      minutes * 60 * 1000
  });
}

/* =====================================================
   SPORTSCORE REQUEST
===================================================== */

async function sportScoreRequest(path) {
  const response = await fetch(SPORTSCORE_BASE + path, {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("SportScore ilirudisha response isiyo JSON. HTTP " + response.status);
  }

  if (!response.ok) {
    const message = data?.error || data?.message || ("SportScore HTTP " + response.status);
    throw new Error(message);
  }

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

function normalizeSportScoreMatch(match) {
  // SportScore widget responses use simple strings for home/away
  // (for example: { home: "Arsenal", away: "Chelsea" }).
  // REST responses may instead use team objects, so support both shapes.
  const homeRaw = match?.home || match?.home_team || match?.teams?.home || "";
  const awayRaw = match?.away || match?.away_team || match?.teams?.away || "";
  const home = typeof homeRaw === "string" ? { name: homeRaw } : (homeRaw || {});
  const away = typeof awayRaw === "string" ? { name: awayRaw } : (awayRaw || {});
  const competitionRaw = match?.competition || match?.league || {};
  const competition = typeof competitionRaw === "string"
    ? { name: competitionRaw }
    : (competitionRaw || {});

  const homeName = home.name || home.team_name || home.title || home.label || "Home Team";
  const awayName = away.name || away.team_name || away.title || away.label || "Away Team";
  const id = String(match?.slug || match?.id || match?.match_id || match?.fixture_id || "");

  return {
    id,
    name: homeName + " vs " + awayName,
    starting_at: match?.time || match?.starting_at || match?.date || match?.start || null,
    homeTeam: {
      id: home.id || home.team_id || home.slug || home.team_slug || homeName,
      name: homeName,
      logo: home.logo || home.logo_url || null,
      slug: home.slug || home.team_slug || null
    },
    awayTeam: {
      id: away.id || away.team_id || away.slug || away.team_slug || awayName,
      name: awayName,
      logo: away.logo || away.logo_url || null,
      slug: away.slug || away.team_slug || null
    },
    league: {
      id: competition.id || competition.slug || null,
      name: competition.name || competition.competition_name || "Football",
      country: competition.country || ""
    },
    season: match?.season || competition.season || null,
    status: match?.status || match?.status_text || "Scheduled",
    venue: match?.venue || null,
    slug: match?.slug || id,
    raw: match
  };
}

function fixturePriorityScore(match) {
  const league = String(match?.league?.name || "").toLowerCase();
  const text = String(
    (match?.homeTeam?.name || "") + " " +
    (match?.awayTeam?.name || "") + " " + league
  ).toLowerCase();

  const majorCompetitions = [
    ["champions league",110],["uefa champions",110],
    ["europa league",108],["conference league",106],
    ["premier league",100],["la liga",98],["serie a",96],
    ["bundesliga",94],["ligue 1",92],["eredivisie",88],
    ["primeira liga",86],["championship",82],["super lig",80],
    ["scottish premiership",78],["mls",76],["brasileirao",76],
    ["serie a brazil",76],["liga profesional",74]
  ];

  let score = 10;
  for (const [keyword, value] of majorCompetitions) {
    if (league.includes(keyword)) score = Math.max(score, value);
  }

  const majorTeams = [
    "arsenal","liverpool","manchester city","manchester united","chelsea","tottenham",
    "newcastle","real madrid","barcelona","atletico madrid","sevilla","athletic bilbao",
    "juventus","inter milan","ac milan","napoli","roma","lazio",
    "bayern munich","borussia dortmund","rb leipzig","bayer leverkusen",
    "psg","paris saint germain","marseille","lyon","monaco",
    "ajax","psv","feyenoord","benfica","porto","sporting cp",
    "galatasaray","fenerbahce","besiktas","celtic","rangers"
  ];
  const matchedTeams = majorTeams.filter(team => text.includes(team)).length;
  score += Math.min(18, matchedTeams * 9);

  if (/\b(u19|u20|u21|u23|b team|reserve|reserves)\b/i.test(text)) score -= 25;
  if (/\b(women|woman|womens|female)\b/i.test(text)) score -= 8;
  if (/\b(2\. divisjon|3\. divisjon|division 2|division 1|second league|third league|regional)\b/i.test(text)) score -= 12;

  return Math.max(0, score);
}

async function getFixtures(date) {
  const cacheKey = "fixtures:" + date;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // SportScore supports filtering by competition. The general daily endpoint
  // can be dominated by lower leagues, so we also query major competitions
  // explicitly and merge the results.
  const priorityCompetitions = [
    { slug: "premier-league", label: "Premier League", priority: 100 },
    { slug: "la-liga", label: "La Liga", priority: 98 },
    { slug: "serie-a", label: "Serie A", priority: 96 },
    { slug: "bundesliga", label: "Bundesliga", priority: 94 },
    { slug: "ligue-1", label: "Ligue 1", priority: 92 },
    { slug: "uefa-champions-league", label: "UEFA Champions League", priority: 110 },
    { slug: "uefa-europa-league", label: "UEFA Europa League", priority: 108 },
    { slug: "uefa-europa-conference-league", label: "UEFA Conference League", priority: 106 },
    { slug: "eredivisie", label: "Eredivisie", priority: 88 },
    { slug: "primeira-liga", label: "Primeira Liga", priority: 86 },
    { slug: "championship", label: "Championship", priority: 82 },
    { slug: "super-lig", label: "Turkish Super Lig", priority: 80 },
    { slug: "scottish-premiership", label: "Scottish Premiership", priority: 78 }
  ];

  const requests = [
    {
      name: "all",
      path: "/api/v1/fixtures/?sport=football&date=" +
        encodeURIComponent(date) + "&status=upcoming&limit=200",
      priority: 10
    },
    ...priorityCompetitions.map(item => ({
      name: item.label,
      path: "/api/v1/fixtures/?sport=football&date=" +
        encodeURIComponent(date) +
        "&status=upcoming&competition=" +
        encodeURIComponent(item.slug) +
        "&limit=200",
      priority: item.priority
    }))
  ];

  const responses = await Promise.all(
    requests.map(async request => {
      try {
        const data = await sportScoreRequest(request.path);
        return { request, matches: extractMatches(data) };
      } catch (err) {
        console.log("SportScore competition lookup failed:", request.name, err.message);
        return { request, matches: [] };
      }
    })
  );

  const seen = new Set();
  const now = Date.now();
  const allMatches = [];

  for (const response of responses) {
    for (const raw of response.matches) {
      const match = normalizeSportScoreMatch(raw);
      const key = String(
        match.slug ||
        match.id ||
        (match.name + "|" + (match.starting_at || ""))
      ).toLowerCase();

      if (seen.has(key)) continue;
      seen.add(key);

      if (!match.homeTeam?.name || !match.awayTeam?.name) continue;

      const rawStatus = match.status;
      const status = String(
        typeof rawStatus === "object"
          ? (rawStatus?.name || rawStatus?.type || rawStatus?.status || rawStatus?.short || "")
          : (rawStatus || "")
      ).toLowerCase().trim();

      const finishedStatuses = [
        "finished","ft","full time","ended","completed","complete",
        "after","cancelled","canceled","abandoned"
      ];

      const liveStatuses = [
        "live","inplay","in-play","1h","2h","ht","half time",
        "halftime","extra time","et","penalties"
      ];

      if (finishedStatuses.some(x => status.includes(x))) continue;
      if (liveStatuses.some(x => status.includes(x))) continue;

      if (match.starting_at) {
        const kickoff = new Date(match.starting_at).getTime();
        if (Number.isFinite(kickoff) && kickoff <= now) continue;
      }

      const sourcePriority = responses.find(
        x => x.matches.some(raw => {
          const n = normalizeSportScoreMatch(raw);
          return String(n.slug || n.id || "").toLowerCase() === key;
        })
      )?.request?.priority || 10;

      match.fixturePriority = sourcePriority;
      allMatches.push(match);
    }
  }

  // Major competitions first, then kickoff time.
  allMatches.sort((a, b) => {
    if ((b.fixturePriority || 0) !== (a.fixturePriority || 0)) {
      return (b.fixturePriority || 0) - (a.fixturePriority || 0);
    }
    return new Date(a.starting_at || 0).getTime() -
      new Date(b.starting_at || 0).getTime();
  });

  const result = {
    ok: true,
    provider: "SportScore",
    date,
    timezone: "UTC",
    count: allMatches.length,
    matches: allMatches,
    message: allMatches.length
      ? allMatches.length + " upcoming matches found, with major leagues prioritized."
      : "No upcoming matches found for " + date + "."
  };

  cacheSet(cacheKey, result, 2);
  return result;
}
async function getFixture(id) {
  const key = String(id || "").trim();
  if (!key) throw new Error("SportScore fixture ID/slug haipo.");

  const cacheKey = "fixture:" + key;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Try the widget endpoint first, then the REST match endpoint.
  let data;
  let lastError = null;

  for (const endpoint of [
    "/api/widget/match/?sport=football&slug=" + encodeURIComponent(key),
    "/api/v1/match/?sport=football&slug=" + encodeURIComponent(key)
  ]) {
    try {
      data = await sportScoreRequest(endpoint);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!data) {
    throw new Error(
      "SportScore haikuweza kufungua mchezo huu: " +
      (lastError?.message || "fixture not found")
    );
  }

  const raw =
    data?.match ||
    data?.fixture ||
    data?.data?.match ||
    data?.data?.fixture ||
    data?.data ||
    data;

  if (!raw || typeof raw !== "object") {
    throw new Error("SportScore fixture haijapatikana.");
  }

  const fixture = normalizeSportScoreMatch(raw);
  if (!fixture.homeTeam?.name || !fixture.awayTeam?.name) {
    throw new Error("SportScore fixture haina majina ya timu.");
  }

  fixture.raw = raw;
  cacheSet(cacheKey, fixture, 10);
  return fixture;
}

async function getTeamHistory(team) {
  const obj = typeof team === "object" ? team : { name: String(team || "") };
  const candidates = [obj.slug, obj.team_slug, obj.id, obj.team_id].filter(Boolean).map(String);
  const name = obj.name || obj.team_name || obj.title || obj.label;

  if (name) {
    try {
      const data = await sportScoreRequest("/api/v1/search/?q=" + encodeURIComponent(String(name)) + "&sport=football&limit=8");
      const found = findTeamSearchResult(data, name);
      if (found?.slug) candidates.push(String(found.slug));
    } catch (err) {
      console.log("Team search failed:", name, err.message);
    }
  }

  for (const slug of [...new Set(candidates)]) {
    const cacheKey = "team-last:" + slug;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    try {
      const data = await sportScoreRequest("/api/widget/team/?sport=football&slug=" + encodeURIComponent(slug) + "&limit=30");
      const fixtures = extractMatches(data);
      cacheSet(cacheKey, fixtures, 30);
      return fixtures;
    } catch (err) {
      console.log("Team history failed:", name || slug, err.message);
    }
  }
  return [];
}

function findTeamSearchResult(data, wantedName) {
  const wanted = String(wantedName || "").toLowerCase().trim();
  const found = [];
  function walk(v) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const name = v.name || v.team_name || v.title || v.label;
    const slug = v.slug || v.team_slug || v.id || v.team_id;
    if (name && slug) found.push({ name: String(name), slug: String(slug) });
    Object.keys(v).forEach(k => { if (k !== "raw") walk(v[k]); });
  }
  walk(data);
  return found.find(x => x.name.toLowerCase() === wanted) ||
    found.find(x => x.name.toLowerCase().includes(wanted) || wanted.includes(x.name.toLowerCase())) ||
    found[0] || null;
}

function fixtureForForm(raw) {
  const normalized = normalizeSportScoreMatch(raw);
  const homeScore =
    raw.home_score ??
    raw.homeScore ??
    raw.score?.home ??
    raw.scores?.home ??
    raw.home?.score;
  const awayScore =
    raw.away_score ??
    raw.awayScore ??
    raw.score?.away ??
    raw.scores?.away ??
    raw.away?.score;

  return {
    home: normalized.homeTeam,
    away: normalized.awayTeam,
    homeScore: Number(homeScore),
    awayScore: Number(awayScore),
    status: raw.status || raw.status_text || ""
  };
}

/* =====================================================
   FINISHED FIXTURE LOOKUP / AUTO SETTLEMENT
===================================================== */

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreFromRaw(raw) {
  const homeScore = Number(
    raw?.home_score ?? raw?.homeScore ??
    raw?.score?.home ?? raw?.scores?.home ??
    raw?.home?.score ?? raw?.scores?.full_time?.home
  );
  const awayScore = Number(
    raw?.away_score ?? raw?.awayScore ??
    raw?.score?.away ?? raw?.scores?.away ??
    raw?.away?.score ?? raw?.scores?.full_time?.away
  );
  return {
    homeScore,
    awayScore,
    valid: Number.isInteger(homeScore) && Number.isInteger(awayScore) &&
      homeScore >= 0 && awayScore >= 0
  };
}

async function findFinishedFixtureForPrediction(prediction) {
  const wantedId = String(prediction?.fixtureId || "").trim();
  const wantedHome = normalizeTeamName(prediction?.homeTeam);
  const wantedAway = normalizeTeamName(prediction?.awayTeam);

  const baseDate = new Date(
    prediction?.createdAt || prediction?.date || Date.now()
  );

  if (Number.isNaN(baseDate.getTime())) return null;

  const dates = [];
  for (const offset of [-1, 0, 1, 2]) {
    const d = new Date(baseDate.getTime() + offset * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }

  for (const date of [...new Set(dates)]) {
    try {
      const data = await sportScoreRequest(
        "/api/v1/fixtures/?sport=football&date=" +
        encodeURIComponent(date) + "&limit=200"
      );

      for (const raw of extractMatches(data)) {
        const normalized = normalizeSportScoreMatch(raw);
        const rawId = String(
          raw?.id || raw?.slug || raw?.match_id || raw?.fixture_id || normalized.id || ""
        );

        const homeName = normalizeTeamName(normalized.homeTeam?.name);
        const awayName = normalizeTeamName(normalized.awayTeam?.name);

        const idMatch = wantedId && (
          rawId === wantedId ||
          String(normalized.slug || "") === wantedId ||
          String(normalized.id || "") === wantedId
        );

        const teamMatch = wantedHome && wantedAway &&
          homeName === wantedHome && awayName === wantedAway;

        if (!idMatch && !teamMatch) continue;

        const score = scoreFromRaw(raw);
        if (!score.valid) continue;

        return {
          fixture: normalized,
          raw,
          homeScore: score.homeScore,
          awayScore: score.awayScore,
          matchedBy: idMatch ? "fixture-id" : "team-names",
          date
        };
      }
    } catch (err) {
      console.log("Finished fixture lookup failed:", date, err.message);
    }
  }

  return null;
}

/* =====================================================
   TEAM FORM
===================================================== */

function teamForm(teamRef, fixtures) {
  const games = [];
  const ref = typeof teamRef === "object" ? teamRef : { id: teamRef, name: teamRef };
  const wanted = new Set([ref.id, ref.slug, ref.team_id, ref.team_slug, ref.name, ref.team_name]
    .filter(Boolean).map(x => String(x).trim().toLowerCase()));

  for (const raw of fixtures || []) {
    const g = fixtureForForm(raw);
    const home = g.home || {};
    const away = g.away || {};
    const homeIds = [home.id, home.slug, home.name, home.team_id, home.team_slug].filter(Boolean).map(x => String(x).trim().toLowerCase());
    const awayIds = [away.id, away.slug, away.name, away.team_id, away.team_slug].filter(Boolean).map(x => String(x).trim().toLowerCase());
    const isHome = homeIds.some(x => wanted.has(x));
    const isAway = awayIds.some(x => wanted.has(x));

    if (!isHome && !isAway) continue;
    if (!Number.isFinite(g.homeScore) || !Number.isFinite(g.awayScore)) continue;

    const gf = isHome ? g.homeScore : g.awayScore;
    const ga = isHome ? g.awayScore : g.homeScore;
    let result = "D";
    if (gf > ga) result = "W";
    if (gf < ga) result = "L";
    games.push({ result, gf, ga, date: raw.starting_at || raw.date || raw.time || null, venueHome: isHome });
  }

  const last = games.sort((a,b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()).slice(0, 10);
  if (!last.length) {
    return {
      matches:0, games:0, wins:0, draws:0, losses:0, goalsFor:1.35, goalsAgainst:1.10, points:0,
      weightedPoints:0, weightedGoalsFor:1.35, weightedGoalsAgainst:1.10, goalDiff:0, strengthRating:1500,
      homeGames:0, awayGames:0, homeGoalsFor:1.35, homeGoalsAgainst:1.10, awayGoalsFor:1.35, awayGoalsAgainst:1.10,
      form:"N/A"
    };
  }
  let wins=0, draws=0, losses=0, goalsFor=0, goalsAgainst=0, weightedPoints=0, weightedGoalsFor=0, weightedGoalsAgainst=0, weightSum=0;
  const homeSplit=[], awaySplit=[];
  last.forEach((game,index)=>{
    const weight=Math.max(0.35,Math.exp(-0.18*index));
    const pts=game.result==="W"?3:game.result==="D"?1:0;
    goalsFor+=game.gf; goalsAgainst+=game.ga;
    weightedPoints+=pts*weight; weightedGoalsFor+=game.gf*weight; weightedGoalsAgainst+=game.ga*weight; weightSum+=weight;
    if(game.result==="W") wins++; else if(game.result==="D") draws++; else losses++;
    if(game.venueHome) homeSplit.push(game); else awaySplit.push(game);
  });
  const avg=arr=>arr.length?{gf:arr.reduce((n,g)=>n+g.gf,0)/arr.length,ga:arr.reduce((n,g)=>n+g.ga,0)/arr.length}:null;
  const ha=avg(homeSplit), aa=avg(awaySplit);
  const ppg=(wins*3+draws)/last.length, gd=(goalsFor-goalsAgainst)/last.length;
  const strengthRating=Math.max(1200,Math.min(1800,1500+(ppg-1.35)*180+gd*70));
  return {
    matches:last.length, games:last.length, wins, draws, losses,
    goalsFor:goalsFor/last.length, goalsAgainst:goalsAgainst/last.length, points:wins*3+draws,
    weightedPoints:weightSum?weightedPoints/weightSum:0,
    weightedGoalsFor:weightSum?weightedGoalsFor/weightSum:goalsFor/last.length,
    weightedGoalsAgainst:weightSum?weightedGoalsAgainst/weightSum:goalsAgainst/last.length,
    goalDiff:goalsFor-goalsAgainst, strengthRating:Math.round(strengthRating*10)/10,
    homeGames:homeSplit.length, awayGames:awaySplit.length,
    homeGoalsFor:ha?.gf??1.35, homeGoalsAgainst:ha?.ga??1.10,
    awayGoalsFor:aa?.gf??1.35, awayGoalsAgainst:aa?.ga??1.10,
    form:last.map(x=>x.result).join("")
  };
}

/* =====================================================
   DATA QUALITY
===================================================== */

function dataQuality(homeForm, awayForm) {
  const homeGames = Number(homeForm?.games || homeForm?.matches || 0);
  const awayGames = Number(awayForm?.games || awayForm?.matches || 0);
  const minimum = Math.min(homeGames, awayGames);
  const average = (homeGames + awayGames) / 2;

  let level = "low";
  let score = 25;
  let reason = "Recent form data is missing or very limited.";

  if (minimum >= 5) {
    level = "high";
    score = 100;
    reason = "Both teams have 5 recent matches with usable results.";
  } else if (minimum >= 3) {
    level = "medium";
    score = 70;
    reason = "Both teams have some recent form data, but the sample is incomplete.";
  } else if (average >= 2) {
    level = "medium";
    score = 50;
    reason = "Some recent form is available, but one or both teams have limited data.";
  }

  return { level, score, reason, homeGames, awayGames };
}

/* =====================================================
   POISSON
===================================================== */

function factorial(n) {

  let result = 1;

  for (
    let i = 2;
    i <= n;
    i++
  ) {
    result *= i;
  }

  return result;
}

function poisson(
  lambda,
  goals
) {

  return (
    Math.exp(-lambda) *
    Math.pow(
      lambda,
      goals
    ) /
    factorial(goals)
  );
}

/* =====================================================
   PROBABILITIES
===================================================== */

function probabilities(
  homeLambda,
  awayLambda
) {

  let home = 0;
  let draw = 0;
  let away = 0;

  let over25 = 0;
  let btts = 0;

  for (
    let h = 0;
    h <= 8;
    h++
  ) {

    for (
      let a = 0;
      a <= 8;
      a++
    ) {

      const p =
        poisson(
          homeLambda,
          h
        ) *
        poisson(
          awayLambda,
          a
        );

      if (h > a) {
        home += p;
      }
      else if (h === a) {
        draw += p;
      }
      else {
        away += p;
      }

      if (
        h + a >= 3
      ) {
        over25 += p;
      }

      if (
        h >= 1 &&
        a >= 1
      ) {
        btts += p;
      }
    }
  }

  const total =
    home +
    draw +
    away;

  return {

    home:
      home / total,

    draw:
      draw / total,

    away:
      away / total,

    over25,

    btts
  };
}

/* =====================================================
   PREDICTION
===================================================== */

function scoreMatrix(homeLambda, awayLambda, maxGoals=6) {
  const cells=[]; let total=0; const rho=-0.05;
  for(let h=0;h<=maxGoals;h++) for(let a=0;a<=maxGoals;a++){
    let p=poisson(homeLambda,h)*poisson(awayLambda,a);
    if(h===0&&a===0)p*=1-homeLambda*awayLambda*rho;
    else if(h===0&&a===1)p*=1+homeLambda*rho;
    else if(h===1&&a===0)p*=1+awayLambda*rho;
    else if(h===1&&a===1)p*=1-rho;
    cells.push({home:h,away:a,probability:p}); total+=p;
  }
  cells.forEach(x=>x.probability/=total); return cells;
}
function probabilitiesFromMatrix(cells){
  let home=0,draw=0,away=0,over15=0,over25=0,over35=0,btts=0;
  for(const c of cells){
    if(c.home>c.away)home+=c.probability; else if(c.home===c.away)draw+=c.probability; else away+=c.probability;
    if(c.home+c.away>=2)over15+=c.probability;
    if(c.home+c.away>=3)over25+=c.probability;
    if(c.home+c.away>=4)over35+=c.probability;
    if(c.home>=1&&c.away>=1)btts+=c.probability;
  }
  return {home,draw,away,over15,over25,over35,btts};
}
function topScores(cells,limit=3){
  return [...cells].sort((a,b)=>b.probability-a.probability).slice(0,limit).map(x=>({score:x.home+"-"+x.away,probability:Math.round(x.probability*1000)/10}));
}
function predict(fixture,homeForm,awayForm){
  const quality=dataQuality(homeForm,awayForm);
  const homeAttack=homeForm.homeGames>=2?homeForm.homeGoalsFor:homeForm.weightedGoalsFor;
  const homeDefense=homeForm.homeGames>=2?homeForm.homeGoalsAgainst:homeForm.weightedGoalsAgainst;
  const awayAttack=awayForm.awayGames>=2?awayForm.awayGoalsFor:awayForm.weightedGoalsFor;
  const awayDefense=awayForm.awayGames>=2?awayForm.awayGoalsAgainst:awayForm.weightedGoalsAgainst;
  const gap=(homeForm.strengthRating||1500)-(awayForm.strengthRating||1500);
  const sh=Math.max(0.82,Math.min(1.18,1+gap/1800)), sa=Math.max(0.82,Math.min(1.18,1-gap/1800));
  let homeLambda=((homeAttack+awayDefense)/2)*1.08*sh, awayLambda=((awayAttack+homeDefense)/2)*sa;
  const hr=homeForm.games?Math.max(0.85,Math.min(1.15,0.88+(homeForm.weightedPoints/3)*0.24)):1;
  const ar=awayForm.games?Math.max(0.85,Math.min(1.15,0.88+(awayForm.weightedPoints/3)*0.24)):1;
  homeLambda*=hr; awayLambda*=ar;
  homeLambda=Math.max(0.20,Math.min(homeLambda,4.2)); awayLambda=Math.max(0.15,Math.min(awayLambda,4.2));
  const cells=scoreMatrix(homeLambda,awayLambda,6), p=probabilitiesFromMatrix(cells);
  const homePct=Math.round(p.home*1000)/10, drawPct=Math.round(p.draw*1000)/10, awayPct=Math.round(p.away*1000)/10;
  let pick="Draw",confidence=drawPct;
  if(homePct>confidence){pick="Home Win";confidence=homePct;} if(awayPct>confidence){pick="Away Win";confidence=awayPct;}
  return {
    dataQuality:quality, fixtureId:fixture.fixture.id, match:`${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
    homeTeam:fixture.teams.home.name, awayTeam:fixture.teams.away.name, pick, confidence,
    probabilities:{home:homePct,draw:drawPct,away:awayPct}, doubleChance:homePct>=awayPct?"1X":"X2",
    over15:Math.round(p.over15*1000)/10, over25:Math.round(p.over25*1000)/10, over35:Math.round(p.over35*1000)/10,
    btts:Math.round(p.btts*1000)/10,
    expectedGoals:{home:Math.round(homeLambda*100)/100,away:Math.round(awayLambda*100)/100},
    topScores:topScores(cells,3),
    strength:{
      home:homeForm.strengthRating||1500,
      away:awayForm.strengthRating||1500,
      gap:Math.round(gap*10)/10,
      edge:Math.round(Math.abs(gap)*10)/10,
      edgeTeam:gap>0 ? fixture.teams.home.name : gap<0 ? fixture.teams.away.name : "Even"
    },
    form:{home:homeForm,away:awayForm}, model:"Fanuel Statistical Deep Engine", usesOdds:false, createdAt:new Date().toISOString()
  };
}


/* =====================================================
   OPENAI FOOTBALL AI
===================================================== */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const MAX_AI_DAILY = Math.max(1, Number(process.env.MAX_AI_DAILY || 150));

function aiUsageToday() {
  const today = new Date().toISOString().slice(0,10);
  const used = db.predictions.filter(p =>
    String(p.createdAt || "").slice(0,10) === today &&
    String(p.model || "").includes("Deep Ensemble")
  ).length;
  return { date: today, used, limit: MAX_AI_DAILY, remaining: Math.max(0, MAX_AI_DAILY-used) };
}

async function runFootballAI(context) {
  if (!OPENAI_API_KEY) {
    return {
      enabled: false,
      model: null,
      status: "OPENAI_API_KEY haijawekwa.",
      analysis: "AI kubwa haijawezeshwa; statistical model imetumika.",
      bestPick: context.statistical.pick,
      confidence: context.statistical.confidence,
      probabilities: context.statistical.probabilities,
      over25: context.statistical.over25,
      btts: context.statistical.btts,
      correctScore: "N/A",
      factors: [],
      risk: "AI haijawezeshwa", dataQuality: context.statistical.dataQuality, ensemble: { agreement:100, modelGap:0 }
    };
  }

  const quality = context.statistical.dataQuality || dataQuality(context.homeForm, context.awayForm);
  const dataWarning =
    quality.level === "low"
      ? "DATA QUALITY LOW: recent form is missing or very limited. Do not invent form, statistics, injuries, odds, or results. Treat uncertainty as high."
      : quality.level === "medium"
        ? "DATA QUALITY MEDIUM: recent form is incomplete. Do not invent missing information; reflect uncertainty."
        : "DATA QUALITY HIGH: both teams have a usable recent-form sample.";

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      bestPick: { type: "string", enum: ["Home Win", "Draw", "Away Win", "No Strong Pick"] },
      confidence: { type: "number", minimum: 0, maximum: 100 },
      homeProbability: { type: "number", minimum: 0, maximum: 100 },
      drawProbability: { type: "number", minimum: 0, maximum: 100 },
      awayProbability: { type: "number", minimum: 0, maximum: 100 },
      over25Probability: { type: "number", minimum: 0, maximum: 100 },
      bttsProbability: { type: "number", minimum: 0, maximum: 100 },
      correctScore: { type: "string" },
      analysis: { type: "string" },
      factors: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 6
      },
      risk: { type: "string" }
    },
    required: [
      "bestPick",
      "confidence",
      "homeProbability",
      "drawProbability",
      "awayProbability",
      "over25Probability",
      "bttsProbability",
      "correctScore",
      "analysis",
      "factors",
      "risk"
    ]
  };

  const input = [
    {
      role: "system",
      content: `You are the Fanuel Football AI analysis engine.
Analyze football fixtures using ONLY the supplied football data and statistical model output.
Do not use bookmaker odds as an input. Do not invent injuries, news, form or facts that are not supplied.
Treat prediction as probabilistic, never as certainty.
Return a balanced analysis based on form, goals, home/away context, team strength and the statistical baseline.
${dataWarning}
If evidence is weak or conflicting, use "No Strong Pick".
Keep analysis concise and factual.`
    },
    {
      role: "user",
      content: JSON.stringify(context)
    }
  ];

  const usage = aiUsageToday();
  if (usage.used >= usage.limit) {
    return {
      enabled: false,
      model: OPENAI_MODEL,
      status: "AI daily budget reached",
      analysis: "Daily AI limit reached; statistical engine used to protect API credits.",
      bestPick: context.statistical.pick,
      confidence: context.statistical.confidence,
      probabilities: context.statistical.probabilities,
      over25: context.statistical.over25,
      btts: context.statistical.btts,
      correctScore: context.statistical.topScores?.[0]?.score || "N/A",
      factors: ["AI daily budget reached", "Statistical model retained", "Credits protected"],
      risk: "AI budget limit",
      dataQuality: context.statistical.dataQuality,
      ensemble: { agreement:null, modelGap:null },
      aiUsage: usage
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning: { effort: "high" },
      input,
      text: {
        format: {
          type: "json_schema",
          name: "fanuel_football_prediction",
          strict: true,
          schema
        }
      },
      store: false
    })
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI ilirudisha response isiyo JSON. HTTP " + response.status);
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      ("OpenAI HTTP " + response.status);
    throw new Error(message);
  }

  const outputText =
    data.output_text ||
    data.output?.flatMap(x => x.content || [])
      .filter(x => x.type === "output_text")
      .map(x => x.text)
      .join("") ||
    "";

  if (!outputText) {
    throw new Error("OpenAI haikurudisha AI analysis.");
  }

  let ai;
  try {
    ai = JSON.parse(outputText);
  } catch {
    throw new Error("AI output haikuwa JSON iliyotarajiwa.");
  }

  return {
    enabled: true,
    model: OPENAI_MODEL,
    status: "AI analysis active",
    ...ai
  };
}

/* =====================================================
   ANALYZE FIXTURE
===================================================== */

async function analyze(fixtureId, suppliedMatch = null) {
  // Automatic prediction can work directly from the fixture-list object.
  // This avoids requiring a SportScore match ID/slug for every fixture.
  let fixture;

  if (suppliedMatch && typeof suppliedMatch === "object") {
    const rawMatch = suppliedMatch.raw || suppliedMatch;
    fixture = normalizeSportScoreMatch(rawMatch);

    if (!fixture.id) {
      fixture.id = String(
        suppliedMatch.id ||
        suppliedMatch.slug ||
        rawMatch.id ||
        rawMatch.slug ||
        rawMatch.match_id ||
        rawMatch.fixture_id ||
        ("auto-" +
          fixture.homeTeam.name +
          "-vs-" +
          fixture.awayTeam.name +
          "-" +
          (fixture.starting_at || ""))
      );
    }

    fixture.slug = suppliedMatch.slug || rawMatch.slug || fixture.id;
    fixture.raw = rawMatch;
  } else {
    fixture = await getFixture(fixtureId);
  }

  const home = fixture.homeTeam || {};
  const away = fixture.awayTeam || {};

  if (!home.name || !away.name) {
    throw new Error("SportScore haikurudisha home/away teams.");
  }

  const [homeHistory, awayHistory] = await Promise.all([
    getTeamHistory(home),
    getTeamHistory(away)
  ]);

  const homeForm = teamForm(home, homeHistory);
  const awayForm = teamForm(away, awayHistory);

  const statisticalFixture = {
    fixture: {
      id: fixture.id,
      date: fixture.starting_at,
      venue: fixture.venue
    },
    teams: {
      home: home,
      away: away
    },
    league: fixture.league
  };

  const statistical = predict(statisticalFixture, homeForm, awayForm);

  const rawSource = fixture.raw || {};
  const sourceIntelligence = {
    lineups: rawSource.lineups || rawSource.lineup || rawSource.formation || null,
    injuries: rawSource.injuries || rawSource.injury || rawSource.absences || null,
    teamNews: rawSource.team_news || rawSource.teamNews || rawSource.news || null
  };

  let ai;
  try {
    ai = await runFootballAI({
      fixture: {
        id: fixture.id,
        slug: fixture.slug,
        date: fixture.starting_at,
        league: fixture.league,
        home,
        away
      },
      homeForm,
      awayForm,
      sourceIntelligence,
      statistical
    });
  } catch (err) {
    console.log("OpenAI analysis error:", err.message);
    ai = {
      enabled: false,
      model: OPENAI_MODEL,
      status: "AI unavailable; statistical fallback used",
      error: err.message,
      bestPick: statistical.pick,
      confidence: statistical.confidence,
      homeProbability: statistical.probabilities.home,
      drawProbability: statistical.probabilities.draw,
      awayProbability: statistical.probabilities.away,
      over25Probability: statistical.over25,
      bttsProbability: statistical.btts,
      correctScore: "N/A",
      analysis: "AI haikupatikana; statistical baseline imetumika.",
      factors: [],
      risk: "AI unavailable", dataQuality: statistical.dataQuality, ensemble: { agreement:100, modelGap:0 }
    };
  }

  // Deep ensemble: never let the LLM overwrite the statistical model blindly.
  // Blend the two probability signals, then derive the final pick from the blend.
  const quality = statistical.dataQuality || dataQuality(homeForm, awayForm);
  const aiEnabled = Boolean(ai.enabled);
  const statPick = statistical.pick;
  const aiPick = ai.bestPick || statistical.pick;
  const keyForPick = pick => pick === "Home Win" ? "home" : pick === "Draw" ? "draw" : "away";
  const aiRaw = {
    home: Number(ai.homeProbability ?? statistical.probabilities.home),
    draw: Number(ai.drawProbability ?? statistical.probabilities.draw),
    away: Number(ai.awayProbability ?? statistical.probabilities.away)
  };
  const rawGap = Math.max(
    Math.abs(Number(statistical.probabilities.home || 0) - aiRaw.home),
    Math.abs(Number(statistical.probabilities.draw || 0) - aiRaw.draw),
    Math.abs(Number(statistical.probabilities.away || 0) - aiRaw.away)
  );

  let statWeight = quality.level === "high" ? 0.55 : quality.level === "medium" ? 0.65 : 0.75;
  if (!aiEnabled) statWeight = 1;
  if (aiEnabled && rawGap >= 18) statWeight = Math.min(0.90, statWeight + 0.10);
  if (aiEnabled && rawGap >= 28) statWeight = Math.min(0.95, statWeight + 0.05);
  const aiWeight = 1 - statWeight;
  const aiProb = {
    home: Number(ai.homeProbability ?? statistical.probabilities.home),
    draw: Number(ai.drawProbability ?? statistical.probabilities.draw),
    away: Number(ai.awayProbability ?? statistical.probabilities.away)
  };
  const aiSum = aiProb.home + aiProb.draw + aiProb.away;
  if (aiSum > 0) {
    aiProb.home = aiProb.home / aiSum * 100;
    aiProb.draw = aiProb.draw / aiSum * 100;
    aiProb.away = aiProb.away / aiSum * 100;
  }
  const blended = {
    home: statistical.probabilities.home * statWeight + aiProb.home * aiWeight,
    draw: statistical.probabilities.draw * statWeight + aiProb.draw * aiWeight,
    away: statistical.probabilities.away * statWeight + aiProb.away * aiWeight
  };
  const total = blended.home + blended.draw + blended.away;
  blended.home = blended.home / total * 100;
  blended.draw = blended.draw / total * 100;
  blended.away = blended.away / total * 100;

  const entries = [
    ["Home Win", blended.home],
    ["Draw", blended.draw],
    ["Away Win", blended.away]
  ].sort((a,b) => b[1] - a[1]);
  const finalPick = entries[0][0];
  const finalKey = keyForPick(finalPick);
  const probabilityMargin = entries[0][1] - entries[1][1];
  const topProbability = entries[0][1];

  const samePick = aiEnabled
    ? (aiPick === finalPick || (aiPick === "No Strong Pick" && statistical.pick === finalPick))
    : null;

  const probabilityGap = aiEnabled
    ? Math.max(
        Math.abs(Number(statistical.probabilities.home || 0) - Number(aiProb.home || 0)),
        Math.abs(Number(statistical.probabilities.draw || 0) - Number(aiProb.draw || 0)),
        Math.abs(Number(statistical.probabilities.away || 0) - Number(aiProb.away || 0))
      )
    : null;

  const modelGap = aiEnabled
    ? Math.abs(
        Number(statistical.probabilities[finalKey] || 0) -
        Number(aiProb[finalKey] || 0)
      )
    : null;

  // Agreement measures model alignment, not certainty.
  const agreement = aiEnabled
    ? Math.max(
        35,
        Math.min(
          94,
          74 + (samePick ? 20 : 0) - (probabilityGap * 1.8)
        )
      )
    : null;

  const marginBonus =
    probabilityMargin >= 35 ? 5 :
    probabilityMargin >= 25 ? 4 :
    probabilityMargin >= 18 ? 3 :
    probabilityMargin >= 12 ? 1 :
    probabilityMargin >= 7 ? 0 :
    -3;

  const agreementAdjustment = aiEnabled
    ? Math.max(-4, Math.min(3, (agreement - 75) / 6))
    : 0;

  const dataAdjustment =
    quality.level === "high" ? 2 :
    quality.level === "medium" ? -1 :
    -4;

  const riskAdjustment =
    probabilityMargin < 8 ? -4 :
    probabilityMargin < 15 ? -2 :
    0;

  const finalConfidence = Math.max(
    35,
    Math.min(
      92,
      topProbability +
      marginBonus +
      agreementAdjustment +
      dataAdjustment +
      riskAdjustment
    )
  );

  const edgeClass =
    (topProbability >= 70 && probabilityMargin >= 25) ||
    (topProbability >= 60 && probabilityMargin >= 15)
      ? "STRONG EDGE"
      : (topProbability >= 52 && probabilityMargin >= 8)
        ? "MODERATE EDGE"
        : "NO STRONG EDGE";

  const confidenceLevel =
    finalConfidence >= 80 ? "STRONG" :
    finalConfidence >= 65 ? "MODERATE" :
    "LOW";

  const stability = !aiEnabled
    ? "STATISTICAL ONLY"
    : probabilityGap < 5
      ? "STABLE"
      : probabilityGap <= 12
        ? "MODERATE"
        : "UNSTABLE";

  const risk =
    edgeClass === "NO STRONG EDGE" ||
    quality.level === "low" ||
    probabilityMargin < 8 ||
    (aiEnabled && agreement < 65)
      ? "HIGH"
      : edgeClass === "MODERATE EDGE" ||
        quality.level === "medium" ||
        probabilityMargin < 15 ||
        (aiEnabled && agreement < 82)
        ? "MEDIUM"
        : "LOW";

  const result = {
    ...statistical,
    pick: finalPick,
    confidence: Math.round(finalConfidence * 10) / 10,
    probabilities: {
      home: Math.round(blended.home * 10) / 10,
      draw: Math.round(blended.draw * 10) / 10,
      away: Math.round(blended.away * 10) / 10
    },
    over25: Math.round((Number(statistical.over25) * statWeight + Number(ai.over25Probability ?? statistical.over25) * aiWeight) * 10) / 10,
    btts: Math.round((Number(statistical.btts) * statWeight + Number(ai.bttsProbability ?? statistical.btts) * aiWeight) * 10) / 10,
    ensemble: {
      statisticalWeight: Math.round(statWeight * 100),
      aiWeight: Math.round(aiWeight * 100),
      agreement: aiEnabled ? Math.round(agreement * 10) / 10 : null,
      modelGap: aiEnabled ? Math.round(modelGap * 10) / 10 : null,
      probabilityGap: aiEnabled ? Math.round(probabilityGap * 10) / 10 : null,
      stability,
      probabilityMargin: Math.round(probabilityMargin * 10) / 10,
      samePick,
      edgeClass,
      confidenceLevel,
      eliteEngine: "v1-calibrated"
    },
    confidenceMetrics: {
      modelConfidence: Math.round(finalConfidence * 10) / 10,
      winProbability: Math.round(entries[0][1] * 10) / 10,
      dataConfidence: quality.level === "high" ? "HIGH" : quality.level === "medium" ? "MEDIUM" : "LOW",
      confidenceLevel,
      edgeClass,
      probabilityMargin: Math.round(probabilityMargin * 10) / 10
    },
    correctScore: statistical.topScores?.[0]?.score || "N/A",
    ai: {
      enabled: Boolean(ai.enabled),
      model: ai.model || null,
      status: ai.status || "",
      bestPick: ai.bestPick || statistical.pick,
      confidence: Number(ai.confidence ?? statistical.confidence),
      suggestedCorrectScore: String(ai.correctScore || "").trim() || "N/A",
      analysis: ai.analysis || "",
      factors: Array.isArray(ai.factors) ? ai.factors : [],
      risk: ai.risk || ""
    },
    dataQuality: quality,
    risk,
    model: ai.enabled ? "Fanuel Deep Ensemble (Statistical + AI)" : "Fanuel Statistical AI (AI fallback)",
    usesOdds: false,
    provider: "SportScore",
    predictionSnapshot: null
  };

  // Build the snapshot after the result object exists.
  result.predictionSnapshot = {
    probabilities: { ...result.probabilities },
    over25: result.over25,
    btts: result.btts,
    confidence: result.confidence,
    fixturePriority: Number(fixture.fixturePriority || 0),
    league: fixture.league || null
  };

  db.predictions.push(result);
  if (db.predictions.length > 500) db.predictions = db.predictions.slice(-500);
  saveDB(db);
  return result;
}

/* =====================================================
   JSON RESPONSE
===================================================== */

function sendJSON(
  res,
  status,
  data
) {

  res.writeHead(
    status,
    {

      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",

      "Access-Control-Allow-Origin":
        "*"
    }
  );

  res.end(
    JSON.stringify(
      data
    )
  );
}



function brierScore(actual, p) {
  const t = actual === "Home Win" ? [1,0,0] : actual === "Draw" ? [0,1,0] : [0,0,1];
  const v = [Number(p.home||0)/100, Number(p.draw||0)/100, Number(p.away||0)/100];
  return (v[0]-t[0])**2 + (v[1]-t[1])**2 + (v[2]-t[2])**2;
}
function logLossScore(actual, p) {
  const v = actual === "Home Win" ? Number(p.home||0)/100 : actual === "Draw" ? Number(p.draw||0)/100 : Number(p.away||0)/100;
  return -Math.log(Math.max(0.0001, Math.min(0.9999, v)));
}

function actualPickFromScore(homeScore, awayScore) {
  if (homeScore > awayScore) return "Home Win";
  if (homeScore < awayScore) return "Away Win";
  return "Draw";
}

function settlementMetrics(prediction, homeScore, awayScore) {
  const actualPick = actualPickFromScore(homeScore, awayScore);
  const total = homeScore + awayScore;
  const actualOver25 = total >= 3;
  const actualBTTS = homeScore >= 1 && awayScore >= 1;
  const predictedScore = String(prediction?.ai?.correctScore || prediction?.correctScore || prediction?.topScores?.[0]?.score || "");
  const actualScore = homeScore + "-" + awayScore;
  return {
    actualPick,
    actualOver25,
    actualBTTS,
    actualScore,
    correct: prediction?.pick === actualPick,
    over25Correct: Number(prediction?.over25 || 0) >= 50 ? actualOver25 : !actualOver25,
    bttsCorrect: Number(prediction?.btts || 0) >= 50 ? actualBTTS : !actualBTTS,
    correctScore: predictedScore === actualScore
  };
}

function findPrediction(fixtureId) {
  return [...db.predictions].reverse().find(p => String(p.fixtureId) === String(fixtureId));
}

function saveSettlement(prediction, fixtureId, homeScore, awayScore, source="SportScore") {
  const metrics = settlementMetrics(prediction, homeScore, awayScore);
  const result = {
    fixtureId: String(fixtureId),
    homeScore,
    awayScore,
    ...metrics,
    confidence: Number(prediction?.confidence || 0),
    predictedPick: prediction?.pick || "",
    predictedProbabilities: prediction?.probabilities || {},
    predictedOver25: Number(prediction?.over25 || 0),
    predictedBTTS: Number(prediction?.btts || 0),
    settledAt: new Date().toISOString(),
    source
  };
  db.results = db.results.filter(r => String(r.fixtureId) !== String(fixtureId));
  db.results.push(result);
  saveDB(db);
  return result;
}

function settlementRows() {
  return (db.results || []).map(result => {
    const prediction = findPrediction(result.fixtureId);
    return prediction ? { prediction, result } : null;
  }).filter(Boolean);
}

function calibrationBuckets(rows) {
  const buckets = {
    "50-59": {count:0, correct:0, avgConfidence:0},
    "60-69": {count:0, correct:0, avgConfidence:0},
    "70-79": {count:0, correct:0, avgConfidence:0},
    "80+": {count:0, correct:0, avgConfidence:0}
  };
  for (const row of rows) {
    const c=Math.max(0,Math.min(100,Number(row.prediction.confidence||0)));
    const key=c>=80?"80+":c>=70?"70-79":c>=60?"60-69":"50-59";
    buckets[key].count++;
    buckets[key].correct += row.result.correct ? 1 : 0;
    buckets[key].avgConfidence += c;
  }
  for (const b of Object.values(buckets)) {
    b.accuracy=b.count?Math.round(b.correct/b.count*1000)/10:null;
    b.avgConfidence=b.count?Math.round(b.avgConfidence/b.count*10)/10:null;
  }
  return buckets;
}
/* =====================================================
   API ROUTES
===================================================== */

async function api(
  req,
  res,
  url
) {


  /* ---------------------------------
     SPORTScore PROVIDER TEST
  --------------------------------- */
  if (url.pathname === "/api/sportscore-test") {
    const date = url.searchParams.get("date") ||
      new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendJSON(res, 400, {
        ok: false,
        error: "Tumia date ya YYYY-MM-DD"
      });
    }

    try {
      const data = await getFixtures(date);
      const matches = Array.isArray(data.matches) ? data.matches : [];
      return sendJSON(res, 200, {
        ok: true,
        provider: "SportScore",
        date,
        count: matches.length,
        matches,
        message: matches.length
          ? "SportScore data inafanya kazi."
          : "SportScore imerudisha 0 matches kwa tarehe hii."
      });
    } catch (err) {
      return sendJSON(res, 502, {
        ok: false,
        provider: "SportScore",
        date,
        error: err.message
      });
    }
  }

  /* ---------------------------------
     HEALTH
  --------------------------------- */

  if (
    url.pathname ===
    "/api/health"
  ) {

    return sendJSON(
      res,
      200,
      {

        ok: true,

        provider:
          "SportScore",

        tokenConfigured:
          true,

        aiConfigured:
          Boolean(OPENAI_API_KEY),

        aiModel:
          OPENAI_MODEL,

        service:
          "Fanuel Football Prediction",

        serverTime:
          new Date().toISOString()
      }
    );
  }

  /* ---------------------------------
     AI HEALTH
  --------------------------------- */

  if (
    url.pathname ===
    "/api/ai-health"
  ) {
    return sendJSON(
      res,
      200,
      {
        ok: true,
        configured: Boolean(OPENAI_API_KEY),
        model: OPENAI_MODEL,
        message: OPENAI_API_KEY
          ? "OpenAI football AI is configured."
          : "OPENAI_API_KEY haijawekwa kwenye Render."
      }
    );
  }

  /* ---------------------------------
     SYSTEM STATUS
  --------------------------------- */
  if (url.pathname === "/api/system-status") {
    const rows = settlementRows();
    return sendJSON(res,200,{
      ok:true,
      provider:"SportScore",
      ai:{configured:Boolean(OPENAI_API_KEY),model:OPENAI_MODEL,usage:aiUsageToday()},
      predictions:{total:db.predictions.length,settled:rows.length,pending:Math.max(0,db.predictions.length-rows.length)},
      calibrationReady:rows.length>=30,
      engine:"Fanuel Deep Ensemble (Statistical + AI)",
      oddsUsed:false
    });
  }

  /* ---------------------------------
     AI DEMO / ENGINE TEST
     This route does NOT call SportScore.
     It is only for verifying the AI engine.
  --------------------------------- */

  if (url.pathname === "/api/ai-demo") {

    try {
      const demoStatistical = {
        fixtureId: "demo-001",
        match: "Demo United vs Demo City",
        homeTeam: "Demo United",
        awayTeam: "Demo City",
        pick: "Home Win",
        confidence: 55,
        probabilities: { home: 55, draw: 25, away: 20 },
        doubleChance: "1X",
        over25: 58,
        btts: 54,
        expectedGoals: { home: 1.65, away: 1.05 },
        model: "Fanuel Statistical AI",
        usesOdds: false,
        createdAt: new Date().toISOString()
      };

      const demo = await runFootballAI({
        fixture: {
          id: "demo-001",
          date: new Date().toISOString(),
          league: { name: "AI Engine Test", country: "Demo" },
          home: { id: 1001, name: "Demo United" },
          away: { id: 1002, name: "Demo City" }
        },
        homeForm: {
          matches: 5, wins: 3, draws: 1, losses: 1,
          goalsFor: 1.8, goalsAgainst: 0.9,
          points: 10, form: "WWDLW"
        },
        awayForm: {
          matches: 5, wins: 2, draws: 1, losses: 2,
          goalsFor: 1.2, goalsAgainst: 1.4,
          points: 7, form: "WLWDL"
        },
        statistical: demoStatistical
      });

      return sendJSON(res, 200, {
        ok: true,
        engine: "Fanuel Football AI",
        provider: "OpenAI Responses API",
        model: OPENAI_MODEL,
        ai: demo
      });

    } catch (err) {
      return sendJSON(res, 500, {
        ok: false,
        engine: "Fanuel Football AI",
        model: OPENAI_MODEL,
        error: err.message
      });
    }
  }

  /* ---------------------------------
     SETTLE PREDICTION
     Saves an actual result against a stored prediction.
  --------------------------------- */

  if (url.pathname === "/api/settle") {

    if (req.method !== "POST") {
      return sendJSON(res, 405, {
        ok: false,
        error: "POST required"
      });
    }

    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
      if (body.length > 10000) req.destroy();
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const fixtureId = String(data.fixtureId || "");
        const homeScore = Number(data.homeScore);
        const awayScore = Number(data.awayScore);

        if (
          !fixtureId ||
          !Number.isInteger(homeScore) ||
          !Number.isInteger(awayScore) ||
          homeScore < 0 ||
          awayScore < 0
        ) {
          return sendJSON(res, 400, {
            ok: false,
            error: "fixtureId, homeScore and awayScore are required."
          });
        }

        const prediction = [...db.predictions]
          .reverse()
          .find(p => String(p.fixtureId) === fixtureId);

        if (!prediction) {
          return sendJSON(res, 404, {
            ok: false,
            error: "Prediction haijapatikana."
          });
        }

        let actualPick = "Draw";
        if (homeScore > awayScore) actualPick = "Home Win";
        if (homeScore < awayScore) actualPick = "Away Win";

        const correct = prediction.pick === actualPick;

        const result = saveSettlement(prediction, fixtureId, homeScore, awayScore, "manual");

        return sendJSON(res, 200, {
          ok: true,
          result
        });

      } catch (err) {
        return sendJSON(res, 400, {
          ok: false,
          error: "Invalid JSON or settlement data."
        });
      }
    });

    return;
  }

  /* ---------------------------------
     AUTO SETTLE A FINISHED FIXTURE
  --------------------------------- */

  if (url.pathname === "/api/settle-fixture") {
    if (req.method !== "POST") return sendJSON(res, 405, { ok:false, error:"POST required" });
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); if (body.length > 10000) req.destroy(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const fixtureId = String(data.fixtureId || "");
        if (!fixtureId) return sendJSON(res, 400, { ok:false, error:"fixtureId required" });

        const fixture = await getFixture(fixtureId);
        const raw = fixture.raw || {};
        const homeScore = Number(
          raw.home_score ?? raw.score?.home ?? raw.scores?.home ?? raw.home?.score
        );
        const awayScore = Number(
          raw.away_score ?? raw.score?.away ?? raw.scores?.away ?? raw.away?.score
        );

        if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
          return sendJSON(res, 409, {
            ok:false,
            settled:false,
            status: fixture.status || "unknown",
            error:"Mchezo bado hauna score ya mwisho kutoka SportScore."
          });
        }

        const prediction = [...db.predictions].reverse().find(p => String(p.fixtureId) === fixtureId);
        if (!prediction) return sendJSON(res, 404, { ok:false, error:"Prediction haijapatikana." });

        let actualPick = "Draw";
        if (homeScore > awayScore) actualPick = "Home Win";
        if (homeScore < awayScore) actualPick = "Away Win";

        const result = saveSettlement(prediction, fixtureId, homeScore, awayScore, "SportScore");
        return sendJSON(res, 200, { ok:true, settled:true, result });
      } catch (err) {
        return sendJSON(res, 500, { ok:false, error:err.message });
      }
    });
    return;
  }

  /* ---------------------------------
     AUTO SETTLE PENDING PREDICTIONS
  --------------------------------- */
  if (url.pathname === "/api/settle-pending") {
    if (req.method !== "POST" && req.method !== "GET") return sendJSON(res,405,{ok:false,error:"GET or POST required"});
    const cutoff=Date.now()-2*60*60*1000;
    const pending=[...db.predictions]
      .filter(p=>p.createdAt && new Date(p.createdAt).getTime() < cutoff)
      .filter(p=>!db.results.some(r=>String(r.fixtureId)===String(p.fixtureId)))
      .slice(-50);
    const settled=[], skipped=[];
    for(const p of pending){
      try{
        const found=await findFinishedFixtureForPrediction(p);

        if(found){
          settled.push(
            saveSettlement(
              p,
              p.fixtureId,
              found.homeScore,
              found.awayScore,
              "SportScore-auto-" + found.matchedBy
            )
          );
        } else {
          skipped.push({
            fixtureId:p.fixtureId,
            match:(p.homeTeam || "Home") + " vs " + (p.awayTeam || "Away"),
            reason:"Final score not found in SportScore historical fixture data yet"
          });
        }
      }catch(err){
        skipped.push({fixtureId:p.fixtureId,reason:err.message});
      }
    }
    return sendJSON(res,200,{ok:true,checked:pending.length,settled:settled.length,results:settled,skipped});
  }

  /* ---------------------------------
     UPCOMING FIXTURES
  --------------------------------- */

  if (url.pathname === "/api/upcoming") {

    const requestedDate =
      url.searchParams.get("date") ||
      new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return sendJSON(res, 400, {
        ok: false,
        error: "Tumia date ya YYYY-MM-DD"
      });
    }

    try {
      // Siku moja tu: SportScore ina limit ya 200, lakini app itatumia
      // hadi 150 upcoming matches kwa siku ili kudhibiti mzigo wa AI.
      const result = await getFixtures(requestedDate);
      const now = Date.now();

      const matches = (Array.isArray(result.matches) ? result.matches : [])
        .filter(match => {
          const kickoff = match.starting_at
            ? new Date(match.starting_at).getTime()
            : NaN;

          if (Number.isFinite(kickoff) && kickoff <= now) return false;
          return true;
        })
        .map(match => ({
          ...match,
          fixturePriority: Math.max(
            Number(match.fixturePriority || 0),
            fixturePriorityScore(match)
          )
        }))
        .sort((a, b) => {
          const pa = Number(a.fixturePriority || 0);
          const pb = Number(b.fixturePriority || 0);
          if (pb !== pa) return pb - pa;
          const ta = new Date(a.starting_at || 0).getTime();
          const tb = new Date(b.starting_at || 0).getTime();
          return ta - tb;
        })
        .slice(0, 150);

      return sendJSON(res, 200, {
        ok: true,
        provider: "SportScore",
        requestedDate,
        dailyLimit: 150,
        count: matches.length,
        matches,
        message:
          matches.length
            ? matches.length + " upcoming matches found for " + requestedDate + "."
            : "No upcoming matches found for " + requestedDate + "."
      });

    } catch (err) {
      console.log("Upcoming fixtures error:", err.message);

      return sendJSON(res, 500, {
        ok: false,
        error: err.message
      });
    }
  }

  /* ---------------------------------
     ANALYZE FIXTURE
  --------------------------------- */

  if (
    url.pathname ===
    "/api/analyze-fixture"
  ) {

    if (
      req.method !==
      "POST"
    ) {

      return sendJSON(
        res,
        405,
        {

          ok: false,

          error:
            "POST required"
        }
      );
    }

    let body = "";

    req.on(
      "data",
      chunk => {

        body +=
          chunk.toString();

        if (
          body.length >
          1024 * 1024
        ) {

          req.destroy();
        }
      }
    );

    req.on(
      "end",
      async () => {

        try {

          const data =
            JSON.parse(
              body ||
              "{}"
            );

          // Accept either a normal SportScore fixture ID/slug
          // or the complete match object sent by the automatic frontend.
          let fixtureId = String(data.fixtureId || "").trim();

          if (!fixtureId && data.match && typeof data.match === "object") {
            const m = data.match;
            fixtureId = String(
              m.fixture?.id ||
              m.fixture?.slug ||
              m.id ||
              m.slug ||
              m.raw?.id ||
              m.raw?.slug ||
              m.raw?.match_id ||
              m.raw?.fixture_id ||
              ""
            ).trim();
          }

          // For automatic prediction, the full fixture object is enough.
          // Only require an ID when the client did not send the match itself.
          if (!fixtureId && (!data.match || typeof data.match !== "object")) {
            return sendJSON(
              res,
              400,
              {
                ok: false,
                error: "SportScore match data haikupatikana."
              }
            );
          }

          const result =
            await analyze(
              fixtureId,
              data.match || null
            );

          return sendJSON(
            res,
            200,
            {

              ok: true,

              prediction:
                result
            }
          );

        } catch (err) {

          console.log(
            "Analysis error:",
            err.message
          );

          return sendJSON(
            res,
            500,
            {

              ok: false,

              error:
                err.message
            }
          );
        }
      }
    );

    return;
  }

  /* ---------------------------------
     PREDICTIONS
  --------------------------------- */

  if (
    url.pathname ===
    "/api/predictions"
  ) {

    return sendJSON(
      res,
      200,
      {

        ok: true,

        predictions:
          db.predictions
      }
    );
  }

  /* ---------------------------------
     PERFORMANCE
  --------------------------------- */

  if (url.pathname === "/api/performance" || url.pathname === "/api/backtest") {
    const rows = settlementRows();
    let correct=0, brier=0, logLoss=0, over25Correct=0, bttsCorrect=0, exactScore=0;
    for (const row of rows) {
      if (row.result.correct) correct++;
      if (row.result.over25Correct) over25Correct++;
      if (row.result.bttsCorrect) bttsCorrect++;
      if (row.result.correctScore) exactScore++;
      brier += brierScore(row.result.actualPick, row.prediction.probabilities || {});
      logLoss += logLossScore(row.result.actualPick, row.prediction.probabilities || {});
    }
    const accuracy=rows.length?Math.round(correct/rows.length*1000)/10:0;
    const over25Accuracy=rows.length?Math.round(over25Correct/rows.length*1000)/10:0;
    const bttsAccuracy=rows.length?Math.round(bttsCorrect/rows.length*1000)/10:0;
    const exactScoreAccuracy=rows.length?Math.round(exactScore/rows.length*1000)/10:0;
    return sendJSON(res,200,{
      ok:true,
      mode:url.pathname === "/api/backtest" ? "settled-history-backtest" : "live-performance",
      totalPredictions:db.predictions.length,
      settled:rows.length,
      completed:rows.length,
      correct,
      accuracy,
      over25Accuracy,
      bttsAccuracy,
      exactScoreAccuracy,
      brierScore:rows.length?Math.round(brier/rows.length*10000)/10000:null,
      logLoss:rows.length?Math.round(logLoss/rows.length*10000)/10000:null,
      calibration:calibrationBuckets(rows),
      aiUsage:aiUsageToday(),
      note:rows.length<30
        ? "Calibration is preliminary until 30+ settled predictions."
        : "Metrics use settled predictions only. Backtest here evaluates stored settled predictions; it does not invent historical results."
    });
  }

  /* ---------------------------------
     TEST API
  --------------------------------- */

  if (url.pathname === "/api/test") {
    try {
      const data = await sportScoreRequest(
        "/api/v1/fixtures/?sport=football&date=" +
        new Date().toISOString().slice(0,10) +
        "&limit=1"
      );
      const matches = extractMatches(data);
      return sendJSON(res, 200, {
        ok: true,
        provider: "SportScore",
        apiKey: false,
        keyRequired: false,
        matchesReturned: matches.length,
        message: "SportScore API inafanya kazi bila API key."
      });
    } catch (err) {
      return sendJSON(res, 502, {
        ok: false,
        provider: "SportScore",
        apiKey: false,
        keyRequired: false,
        error: err.message
      });
    }
  }

  return sendJSON(
    res,
    404,
    {

      ok: false,

      error:
        "API route not found"
    }
  );
}

/* =====================================================
   STATIC FILES
===================================================== */

function serveFile(
  req,
  res
) {

  let file;

  try {

    file =
      decodeURIComponent(
        new URL(
          req.url,
          "http://localhost"
        ).pathname
      );

  } catch (err) {

    res.writeHead(
      400
    );

    return res.end(
      "Bad Request"
    );
  }

  if (
    file === "/"
  ) {

    file =
      "/index.html";
  }

  const filePath =
    path.resolve(
      PUBLIC_DIR,
      "." +
      file
    );

  const publicRoot =
    path.resolve(
      PUBLIC_DIR
    );

  if (
    filePath !==
      publicRoot &&
    !filePath.startsWith(
      publicRoot +
      path.sep
    )
  ) {

    res.writeHead(
      403
    );

    return res.end(
      "Forbidden"
    );
  }

  fs.readFile(
    filePath,
    (err, data) => {

      if (err) {

        res.writeHead(
          404,
          {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        );

        return res.end(
          "Not found"
        );
      }

      const ext =
        path.extname(
          filePath
        ).toLowerCase();

      const types = {

        ".html":
          "text/html; charset=utf-8",

        ".js":
          "application/javascript; charset=utf-8",

        ".css":
          "text/css; charset=utf-8",

        ".json":
          "application/json; charset=utf-8",

        ".png":
          "image/png",

        ".jpg":
          "image/jpeg",

        ".jpeg":
          "image/jpeg",

        ".gif":
          "image/gif",

        ".svg":
          "image/svg+xml",

        ".ico":
          "image/x-icon",

        ".webp":
          "image/webp"
      };

      res.writeHead(
        200,
        {

          "Content-Type":
            types[ext] ||
            "application/octet-stream",

          "Cache-Control":
            ext === ".html"
              ? "no-cache"
              : "public, max-age=3600"
        }
      );

      res.end(
        data
      );
    }
  );
}

/* =====================================================
   SERVER
===================================================== */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            `http://localhost:${PORT}`
          );

        if (
          url.pathname.startsWith(
            "/api/"
          )
        ) {

          await api(
            req,
            res,
            url
          );

          return;
        }

        serveFile(
          req,
          res
        );

      } catch (err) {

        console.log(
          "Server error:",
          err.message
        );

        if (
          !res.headersSent
        ) {

          sendJSON(
            res,
            500,
            {

              ok: false,

              error:
                "Internal server error"
            }
          );
        }
      }
    }
  );

/* =====================================================
   START SERVER
===================================================== */

// Run settlement automatically in the background so performance does not
// depend on a user opening the dashboard.
async function runAutomaticSettlement() {
  try {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const pending = [...db.predictions]
      .filter(p => p.createdAt && new Date(p.createdAt).getTime() < cutoff)
      .filter(p => !db.results.some(r => String(r.fixtureId) === String(p.fixtureId)))
      .slice(-50);

    let settled = 0;
    for (const p of pending) {
      const found = await findFinishedFixtureForPrediction(p);
      if (found) {
        saveSettlement(
          p,
          p.fixtureId,
          found.homeScore,
          found.awayScore,
          "SportScore-background-" + found.matchedBy
        );
        settled++;
      }
    }
    if (pending.length) {
      console.log("Automatic settlement:", settled + "/" + pending.length, "predictions settled.");
    }
  } catch (err) {
    console.log("Automatic settlement error:", err.message);
  }
}

server.listen(
  PORT,
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "Fanuel Football Prediction"
    );

    console.log(
      "Server running on port:",
      PORT
    );

    console.log(
      "SportScore provider:",
      "configured"
    );

    console.log(
      "SportScore base:",
      SPORTSCORE_BASE
    );

    console.log(
      "======================================"
    );

    // First settlement pass shortly after startup, then every 15 minutes.
    setTimeout(runAutomaticSettlement, 5000);
    setInterval(runAutomaticSettlement, 15 * 60 * 1000);
  }
);
