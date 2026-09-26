```js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, "db.json");

const SPORTMONKS_TOKEN = process.env.SPORTMONKS_API_TOKEN || "";
const SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football";

const CACHE_TTL = 5 * 60 * 1000;
const TEAM_CACHE_TTL = 30 * 60 * 1000;

const cache = new Map();

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return {
        predictions: [],
        history: [],
        results: []
      };
    }

    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {
      predictions: [],
      history: [],
      results: []
    };
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("DB save error:", err.message);
  }
}

const db = loadDB();

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function sendError(res, status, message, extra = {}) {
  json(res, status, {
    ok: false,
    error: message,
    ...extra
  });
}

function getQuery(url) {
  return new URL(url, `http://localhost:${PORT}`).searchParams;
}

function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function getCached(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() - item.time > item.ttl) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCached(key, value, ttl = CACHE_TTL) {
  cache.set(key, {
    time: Date.now(),
    ttl,
    value
  });
}

async function sportmonksRequest(endpoint, options = {}) {
  if (!SPORTMONKS_TOKEN) {
    throw new Error(
      "SPORTMONKS_API_TOKEN haijawekwa kwenye Render Environment Variables."
    );
  }

  const separator = endpoint.includes("?") ? "&" : "?";

  const url =
    `${SPORTMONKS_BASE}${endpoint}` +
    `${separator}api_token=${encodeURIComponent(SPORTMONKS_TOKEN)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    },
    ...options
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Sportmonks ilirudisha response isiyokuwa JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      `Sportmonks HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.provider = data;

    throw error;
  }

  return data;
}

/* -------------------------------------------------------
   NORMALIZE SPORTMONKS FIXTURE
------------------------------------------------------- */

function normalizeFixture(fixture) {
  const participants = Array.isArray(fixture.participants)
    ? fixture.participants
    : [];

  let home = null;
  let away = null;

  for (const team of participants) {
    const meta = team.meta || {};

    if (
      meta.location === "home" ||
      meta.location === "Home" ||
      team.location === "home"
    ) {
      home = team;
    }

    if (
      meta.location === "away" ||
      meta.location === "Away" ||
      team.location === "away"
    ) {
      away = team;
    }
  }

  if (!home && participants[0]) home = participants[0];
  if (!away && participants[1]) away = participants[1];

  const league =
    fixture.league?.name ||
    fixture.league?.short_code ||
    "Unknown League";

  const homeName =
    home?.name ||
    home?.short_code ||
    "Home Team";

  const awayName =
    away?.name ||
    away?.short_code ||
    "Away Team";

  return {
    id: fixture.id,
    fixtureId: fixture.id,

    name:
      fixture.name ||
      `${homeName} vs ${awayName}`,

    starting_at: fixture.starting_at,

    homeTeam: {
      id: home?.id || null,
      name: homeName,
      logo: home?.image_path || null
    },

    awayTeam: {
      id: away?.id || null,
      name: awayName,
      logo: away?.image_path || null
    },

    league: {
      id: fixture.league?.id || null,
      name: league
    },

    season: {
      id: fixture.season?.id || null,
      name: fixture.season?.name || null
    },

    state: fixture.state || null,
    scores: fixture.scores || [],
    result_info: fixture.result_info || null,

    raw: fixture
  };
}

/* -------------------------------------------------------
   GET ALL FIXTURES FOR DATE
------------------------------------------------------- */

async function getFixturesByDate(date) {
  const cacheKey = `fixtures:${date}`;

  const cached = getCached(cacheKey);

  if (cached) {
    return cached;
  }

  let page = 1;
  const all = [];

  while (true) {
    const endpoint =
      `/fixtures/date/${encodeURIComponent(date)}` +
      `?per_page=50&page=${page}` +
      `&include=participants;league;season;scores`;

    const response = await sportmonksRequest(endpoint);

    const fixtures = Array.isArray(response.data)
      ? response.data
      : [];

    all.push(...fixtures);

    const hasMore =
      response.pagination?.has_more === true;

    if (!hasMore || fixtures.length === 0) {
      break;
    }

    page++;

    // Safety limit
    if (page > 20) {
      break;
    }
  }

  const normalized = all
    .map(normalizeFixture)
    .filter(match =>
      match.homeTeam?.name &&
      match.awayTeam?.name
    );

  const result = {
    date,
    count: normalized.length,
    matches: normalized,
    pagesFetched: page
  };

  setCached(cacheKey, result);

  return result;
}

/* -------------------------------------------------------
   GET FIXTURE BY ID
------------------------------------------------------- */

async function getFixtureById(id) {
  const cacheKey = `fixture:${id}`;

  const cached = getCached(cacheKey);

  if (cached) {
    return cached;
  }

  const endpoint =
    `/fixtures/${encodeURIComponent(id)}` +
    `?include=participants;league;season;scores`;

  const response = await sportmonksRequest(endpoint);

  const fixture = response.data;

  if (!fixture) {
    throw new Error("Fixture haijapatikana.");
  }

  const normalized = normalizeFixture(fixture);

  setCached(cacheKey, normalized, TEAM_CACHE_TTL);

  return normalized;
}

/* -------------------------------------------------------
   TEAM HISTORICAL FIXTURES
------------------------------------------------------- */

async function getTeamHistory(teamId, days = 90) {
  if (!teamId) return [];

  const cacheKey = `team-history:${teamId}:${days}`;

  const cached = getCached(cacheKey);

  if (cached) {
    return cached;
  }

  const end = new Date();

  const start = new Date(
    end.getTime() - days * 24 * 60 * 60 * 1000
  );

  const startDate =
    start.toISOString().slice(0, 10);

  const endDate =
    end.toISOString().slice(0, 10);

  const endpoint =
    `/fixtures/between/${startDate}/${endDate}/${teamId}` +
    `?per_page=50&page=1` +
    `&include=participants;scores;league`;

  const response = await sportmonksRequest(endpoint);

  const fixtures = Array.isArray(response.data)
    ? response.data
    : [];

  const history = fixtures
    .map(normalizeFixture)
    .sort(
      (a, b) =>
        new Date(b.starting_at) -
        new Date(a.starting_at)
    );

  setCached(cacheKey, history, TEAM_CACHE_TTL);

  return history;
}

/* -------------------------------------------------------
   SCORE EXTRACTION
------------------------------------------------------- */

function getFinalScore(match) {
  if (!Array.isArray(match.scores)) {
    return null;
  }

  let home = null;
  let away = null;

  for (const score of match.scores) {
    const description =
      String(score.description || "").toLowerCase();

    const type =
      String(score.type_id || "").toLowerCase();

    const participant =
      String(
        score.participant_id ||
        score.participant ||
        ""
      );

    const goals =
      score.score?.goals ??
      score.goals ??
      null;

    if (goals === null) continue;

    if (
      description.includes("current") ||
      description.includes("ft") ||
      description.includes("full") ||
      type === "2"
    ) {
      if (
        participant ===
        String(match.homeTeam.id)
      ) {
        home = Number(goals);
      }

      if (
        participant ===
        String(match.awayTeam.id)
      ) {
        away = Number(goals);
      }
    }
  }

  // Fallback: use score entries by participant
  if (home === null || away === null) {
    for (const score of match.scores) {
      const goals =
        score.score?.goals ??
        score.goals;

      if (goals === undefined) continue;

      if (
        String(score.participant_id) ===
        String(match.homeTeam.id)
      ) {
        home = Number(goals);
      }

      if (
        String(score.participant_id) ===
        String(match.awayTeam.id)
      ) {
        away = Number(goals);
      }
    }
  }

  if (
    Number.isFinite(home) &&
    Number.isFinite(away)
  ) {
    return { home, away };
  }

  return null;
}

/* -------------------------------------------------------
   FORM CALCULATION
------------------------------------------------------- */

function calculateTeamForm(teamId, fixtures) {
  const finished = [];

  for (const match of fixtures) {
    const score = getFinalScore(match);

    if (!score) continue;

    const isHome =
      String(match.homeTeam.id) ===
      String(teamId);

    const isAway =
      String(match.awayTeam.id) ===
      String(teamId);

    if (!isHome && !isAway) continue;

    const gf = isHome
      ? score.home
      : score.away;

    const ga = isHome
      ? score.away
      : score.home;

    let result = "D";

    if (gf > ga) result = "W";
    if (gf < ga) result = "L";

    finished.push({
      result,
      gf,
      ga
    });
  }

  const lastFive = finished.slice(0, 5);

  if (!lastFive.length) {
    return {
      matches: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
      averageGoalsFor: 1.35,
      averageGoalsAgainst: 1.05,
      form: "N/A"
    };
  }

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const game of lastFive) {
    if (game.result === "W") wins++;
    if (game.result === "D") draws++;
    if (game.result === "L") losses++;

    goalsFor += game.gf;
    goalsAgainst += game.ga;
  }

  const points =
    wins * 3 +
    draws;

  return {
    matches: lastFive.length,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points,
    averageGoalsFor:
      goalsFor / lastFive.length,
    averageGoalsAgainst:
      goalsAgainst / lastFive.length,
    form: lastFive
      .map(x => x.result)
      .join("")
  };
}

/* -------------------------------------------------------
   POISSON
------------------------------------------------------- */

function factorial(n) {
  if (n <= 1) return 1;

  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function poisson(lambda, goals) {
  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial(goals)
  );
}

function poissonMatrix(homeLambda, awayLambda) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  let over25 = 0;
  let btts = 0;

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const probability =
        poisson(homeLambda, h) *
        poisson(awayLambda, a);

      if (h > a) {
        homeWin += probability;
      } else if (h === a) {
        draw += probability;
      } else {
        awayWin += probability;
      }

      if (h + a >= 3) {
        over25 += probability;
      }

      if (h >= 1 && a >= 1) {
        btts += probability;
      }
    }
  }

  const total =
    homeWin +
    draw +
    awayWin;

  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
    over25,
    btts
  };
}

/* -------------------------------------------------------
   AI-ASSISTED PREDICTION
------------------------------------------------------- */

function createPrediction(match, homeForm, awayForm) {
  /*
    Hakuna bookmaker odds zinatumika hapa.
    Model inategemea team form + goals + home advantage.
  */

  const homeAttack =
    homeForm.averageGoalsFor;

  const homeDefense =
    homeForm.averageGoalsAgainst;

  const awayAttack =
    awayForm.averageGoalsFor;

  const awayDefense =
    awayForm.averageGoalsAgainst;

  let homeLambda =
    (homeAttack + awayDefense) / 2;

  let awayLambda =
    (awayAttack + homeDefense) / 2;

  // Home advantage
  homeLambda *= 1.08;

  // Prevent unrealistic values
  homeLambda =
    Math.max(
      0.25,
      Math.min(homeLambda, 3.8)
    );

  awayLambda =
    Math.max(
      0.20,
      Math.min(awayLambda, 3.5)
    );

  const matrix =
    poissonMatrix(
      homeLambda,
      awayLambda
    );

  const probabilities = {
    home:
      Math.round(matrix.homeWin * 1000) / 10,

    draw:
      Math.round(matrix.draw * 1000) / 10,

    away:
      Math.round(matrix.awayWin * 1000) / 10
  };

  let pick = "Draw";
  let confidence = probabilities.draw;

  if (probabilities.home > confidence) {
    pick = "Home Win";
    confidence = probabilities.home;
  }

  if (probabilities.away > confidence) {
    pick = "Away Win";
    confidence = probabilities.away;
  }

  let doubleChance = "1X";

  if (
    probabilities.home >= probabilities.away &&
    probabilities.home >= probabilities.draw
  ) {
    doubleChance = "1X";
  } else if (
    probabilities.away >= probabilities.home &&
    probabilities.away >= probabilities.draw
  ) {
    doubleChance = "X2";
  } else {
    doubleChance = "1X";
  }

  const confidenceLabel =
    confidence >= 70
      ? "High"
      : confidence >= 55
      ? "Medium"
      : "Low";

  return {
    fixtureId: match.fixtureId,

    match: match.name,

    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,

    league: match.league.name,

    pick,

    confidence:
      Math.round(confidence * 10) / 10,

    confidenceLabel,

    probabilities,

    doubleChance,

    over25:
      Math.round(matrix.over25 * 1000) / 10,

    btts:
      Math.round(matrix.btts * 1000) / 10,

    expectedGoals: {
      home:
        Math.round(homeLambda * 100) / 100,

      away:
        Math.round(awayLambda * 100) / 100
    },

    form: {
      home: homeForm,
      away: awayForm
    },

    model: "Poisson + Team Form",

    usesOdds: false,

    createdAt:
      new Date().toISOString()
  };
}

/* -------------------------------------------------------
   ANALYZE MATCH
------------------------------------------------------- */

async function analyzeFixture(fixtureId) {
  const match =
    await getFixtureById(fixtureId);

  const homeId =
    match.homeTeam.id;

  const awayId =
    match.awayTeam.id;

  const [
    homeHistory,
    awayHistory
  ] = await Promise.all([
    getTeamHistory(homeId, 120),
    getTeamHistory(awayId, 120)
  ]);

  const homeForm =
    calculateTeamForm(
      homeId,
      homeHistory
    );

  const awayForm =
    calculateTeamForm(
      awayId,
      awayHistory
    );

  const prediction =
    createPrediction(
      match,
      homeForm,
      awayForm
    );

  db.predictions.push(prediction);

  if (db.pre
```
