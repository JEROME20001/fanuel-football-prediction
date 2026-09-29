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
  const home = match.home || match.home_team || match.teams?.home || {};
  const away = match.away || match.away_team || match.teams?.away || {};
  const competition = match.competition || match.league || {};
  const id = String(match.slug || match.id || match.match_id || "");

  return {
    id,
    name: (home.name || home.team_name || "Home") + " vs " + (away.name || away.team_name || "Away"),
    starting_at: match.time || match.starting_at || match.date || match.start || null,
    homeTeam: {
      id: home.id || home.team_id || home.slug || home.name || null,
      name: home.name || home.team_name || "Home Team",
      logo: home.logo || home.logo_url || null,
      slug: home.slug || home.team_slug || null
    },
    awayTeam: {
      id: away.id || away.team_id || away.slug || away.name || null,
      name: away.name || away.team_name || "Away Team",
      logo: away.logo || away.logo_url || null,
      slug: away.slug || away.team_slug || null
    },
    league: {
      id: competition.id || competition.slug || null,
      name: competition.name || competition.competition_name || "Football",
      country: competition.country || ""
    },
    season: match.season || competition.season || null,
    status: match.status || match.status_text || "Scheduled",
    venue: match.venue || null,
    slug: match.slug || id,
    raw: match
  };
}

async function getFixtures(date) {
  const cacheKey = "fixtures:" + date;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await sportScoreRequest(
    "/api/v1/fixtures/?sport=football&date=" +
    encodeURIComponent(date) +
    "&limit=200"
  );

  const matches = extractMatches(data).map(normalizeSportScoreMatch);
  const result = {
    ok: true,
    provider: "SportScore",
    date,
    timezone: "UTC",
    count: matches.length,
    matches,
    message: matches.length
      ? matches.length + " matches found."
      : "SportScore returned 0 matches for " + date + "."
  };

  cacheSet(cacheKey, result, 2);
  return result;
}

async function getFixture(id) {
  const key = String(id || "");
  const cacheKey = "fixture:" + key;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // The frontend sends the SportScore slug as the fixture id.
  const data = await sportScoreRequest(
    "/api/widget/match/?sport=football&slug=" + encodeURIComponent(key)
  );

  const raw = data?.match || data?.data?.match || data?.data || data;
  if (!raw || typeof raw !== "object") {
    throw new Error("SportScore fixture haijapatikana.");
  }

  const fixture = normalizeSportScoreMatch(raw);
  fixture.raw = raw;
  cacheSet(cacheKey, fixture, 10);
  return fixture;
}

async function getTeamHistory(team) {
  const slug = typeof team === "object"
    ? (team.slug || team.id || team.name)
    : team;

  if (!slug) return [];

  const cacheKey = "team-last:" + slug;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await sportScoreRequest(
    "/api/widget/team/?sport=football&slug=" +
    encodeURIComponent(String(slug)) +
    "&limit=30"
  );

  const fixtures = extractMatches(data);
  cacheSet(cacheKey, fixtures, 30);
  return fixtures;
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
   TEAM FORM
===================================================== */

function teamForm(teamId, fixtures) {
  const games = [];

  for (const raw of fixtures || []) {
    const g = fixtureForForm(raw);
    const home = g.home || {};
    const away = g.away || {};
    const isHome = String(home.id || home.slug || home.name) === String(teamId);
    const isAway = String(away.id || away.slug || away.name) === String(teamId);

    if (!isHome && !isAway) continue;
    if (!Number.isFinite(g.homeScore) || !Number.isFinite(g.awayScore)) continue;

    const gf = isHome ? g.homeScore : g.awayScore;
    const ga = isHome ? g.awayScore : g.homeScore;
    let result = "D";
    if (gf > ga) result = "W";
    if (gf < ga) result = "L";
    games.push({ result, gf, ga });
  }

  const last = games.slice(0, 5);

  if (!last.length) {
    return {
      matches: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 1.35, goalsAgainst: 1.10, points: 0, form: "N/A"
    };
  }

  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  for (const game of last) {
    goalsFor += game.gf;
    goalsAgainst += game.ga;
    if (game.result === "W") wins++;
    else if (game.result === "D") draws++;
    else losses++;
  }

  return {
    matches: last.length,
    wins, draws, losses,
    goalsFor: goalsFor / last.length,
    goalsAgainst: goalsAgainst / last.length,
    points: wins * 3 + draws,
    form: last.map(x => x.result).join("")
  };
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

function predict(
  fixture,
  homeForm,
  awayForm
) {

  let homeLambda =
    (
      homeForm.goalsFor +
      awayForm.goalsAgainst
    ) / 2;

  let awayLambda =
    (
      awayForm.goalsFor +
      homeForm.goalsAgainst
    ) / 2;

  /* HOME ADVANTAGE */

  homeLambda *=
    1.08;

  /* FORM */

  const homeFormFactor =
    homeForm.points /
    Math.max(
      1,
      homeForm.matches * 3
    );

  const awayFormFactor =
    awayForm.points /
    Math.max(
      1,
      awayForm.matches * 3
    );

  if (
    homeForm.matches > 0
  ) {

    homeLambda *=
      0.90 +
      homeFormFactor *
      0.20;
  }

  if (
    awayForm.matches > 0
  ) {

    awayLambda *=
      0.90 +
      awayFormFactor *
      0.20;
  }

  homeLambda =
    Math.max(
      0.25,
      Math.min(
        homeLambda,
        4
      )
    );

  awayLambda =
    Math.max(
      0.20,
      Math.min(
        awayLambda,
        4
      )
    );

  const p =
    probabilities(
      homeLambda,
      awayLambda
    );

  const homePct =
    Math.round(
      p.home * 1000
    ) / 10;

  const drawPct =
    Math.round(
      p.draw * 1000
    ) / 10;

  const awayPct =
    Math.round(
      p.away * 1000
    ) / 10;

  let pick =
    "Draw";

  let confidence =
    drawPct;

  if (
    homePct >
    confidence
  ) {

    pick =
      "Home Win";

    confidence =
      homePct;
  }

  if (
    awayPct >
    confidence
  ) {

    pick =
      "Away Win";

    confidence =
      awayPct;
  }

  return {

    fixtureId:
      fixture.fixture.id,

    match:
      `${fixture.teams.home.name} vs ` +
      `${fixture.teams.away.name}`,

    homeTeam:
      fixture.teams.home.name,

    awayTeam:
      fixture.teams.away.name,

    pick,

    confidence,

    probabilities: {

      home:
        homePct,

      draw:
        drawPct,

      away:
        awayPct
    },

    doubleChance:
      homePct >= awayPct
        ? "1X"
        : "X2",

    over25:
      Math.round(
        p.over25 * 1000
      ) / 10,

    btts:
      Math.round(
        p.btts * 1000
      ) / 10,

    expectedGoals: {

      home:
        Math.round(
          homeLambda * 100
        ) / 100,

      away:
        Math.round(
          awayLambda * 100
        ) / 100
    },

    form: {

      home:
        homeForm,

      away:
        awayForm
    },

    model:
      "Fanuel Statistical AI",

    usesOdds:
      false,

    createdAt:
      new Date().toISOString()
  };
}


/* =====================================================
   OPENAI FOOTBALL AI
===================================================== */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

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
      risk: "AI haijawezeshwa"
    };
  }

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
Return a balanced analysis based on form, goals, home/away context and the statistical baseline.
If evidence is weak or conflicting, use "No Strong Pick".
Keep analysis concise and factual.`
    },
    {
      role: "user",
      content: JSON.stringify(context)
    }
  ];

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

async function analyze(fixtureId) {
  const fixture = await getFixture(fixtureId);
  const home = fixture.homeTeam || {};
  const away = fixture.awayTeam || {};

  if (!home.name || !away.name) {
    throw new Error("SportScore haikurudisha home/away teams.");
  }

  const [homeHistory, awayHistory] = await Promise.all([
    getTeamHistory(home.slug || home.id || home.name),
    getTeamHistory(away.slug || away.id || away.name)
  ]);

  const homeForm = teamForm(home.slug || home.id || home.name, homeHistory);
  const awayForm = teamForm(away.slug || away.id || away.name, awayHistory);

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
      risk: "AI unavailable"
    };
  }

  const result = {
    ...statistical,
    pick: ai.bestPick === "No Strong Pick" ? statistical.pick : ai.bestPick,
    confidence: Math.round(Number(ai.confidence || statistical.confidence) * 10) / 10,
    probabilities: {
      home: Math.round(Number(ai.homeProbability ?? statistical.probabilities.home) * 10) / 10,
      draw: Math.round(Number(ai.drawProbability ?? statistical.probabilities.draw) * 10) / 10,
      away: Math.round(Number(ai.awayProbability ?? statistical.probabilities.away) * 10) / 10
    },
    over25: Math.round(Number(ai.over25Probability ?? statistical.over25) * 10) / 10,
    btts: Math.round(Number(ai.bttsProbability ?? statistical.btts) * 10) / 10,
    ai: {
      enabled: Boolean(ai.enabled),
      model: ai.model || OPENAI_MODEL,
      status: ai.status || "",
      bestPick: ai.bestPick || statistical.pick,
      confidence: Number(ai.confidence ?? statistical.confidence),
      correctScore: ai.correctScore || "N/A",
      analysis: ai.analysis || "",
      factors: Array.isArray(ai.factors) ? ai.factors : [],
      risk: ai.risk || ""
    },
    model: ai.enabled ? "Fanuel AI + Statistical Engine" : "Fanuel Statistical AI (AI fallback)",
    usesOdds: false,
    provider: "SportScore"
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

    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
      return sendJSON(res, 400, {
        ok: false,
        error: "Tumia date ya YYYY-MM-DD"
      });
    }

    try {
      const data = await getSportScoreFixtures(date);
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

        const result = {
          fixtureId,
          homeScore,
          awayScore,
          actualPick,
          correct,
          settledAt: new Date().toISOString()
        };

        db.results = db.results.filter(
          r => String(r.fixtureId) !== fixtureId
        );
        db.results.push(result);
        saveDB(db);

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

        const result = {
          fixtureId, homeScore, awayScore, actualPick,
          correct: prediction.pick === actualPick,
          settledAt: new Date().toISOString(),
          source: "SportScore"
        };

        db.results = db.results.filter(r => String(r.fixtureId) !== fixtureId);
        db.results.push(result);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, settled:true, result });
      } catch (err) {
        return sendJSON(res, 500, { ok:false, error:err.message });
      }
    });
    return;
  }

  /* ---------------------------------
     UPCOMING FIXTURES
  --------------------------------- */

  if (
    url.pathname ===
    "/api/upcoming"
  ) {

    const date =
      url.searchParams.get(
        "date"
      ) ||
      new Date()
        .toISOString()
        .slice(
          0,
          10
        );

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        date
      )
    ) {

      return sendJSON(
        res,
        400,
        {

          ok: false,

          error:
            "Tumia date ya YYYY-MM-DD"
        }
      );
    }

    try {

      const result =
        await getFixtures(
          date
        );

      return sendJSON(
        res,
        200,
        result
      );

    } catch (err) {

      console.log(
        "Fixture error:",
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

          if (
            !data.fixtureId
          ) {

            return sendJSON(
              res,
              400,
              {

                ok: false,

                error:
                  "fixtureId required"
              }
            );
          }

          const result =
            await analyze(
              data.fixtureId
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

  if (
    url.pathname ===
    "/api/performance"
  ) {

    const results =
      db.results ||
      [];

    const settled =
      results.length;

    const correct =
      results.filter(
        x =>
          x.correct ===
          true
      ).length;

    return sendJSON(
      res,
      200,
      {

        ok: true,

        totalPredictions:
          db.predictions.length,

        settled,

        correct,

        accuracy:
          settled
            ? Math.round(
                (
                  correct /
                  settled
                ) *
                1000
              ) / 10
            : 0
      }
    );
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
  }
);
