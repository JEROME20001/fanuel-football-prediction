const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");

if (!fs.existsSync(DATA)) {
  fs.mkdirSync(DATA, { recursive: true });
}

const DB = path.join(DATA, "db.json");

const SPORTS_KEY = process.env.THE_SPORTS_DB_KEY || "123";
const SPORTS_BASE =
  `https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}`;

const initialDB = {
  settings: {
    siteName: "Fanuel Football Prediction",
    provider: "TheSportsDB",
    version: "2.0"
  },
  predictions: [],
  results: [],
  history: []
};

function loadDB() {
  try {
    if (!fs.existsSync(DB)) {
      fs.writeFileSync(DB, JSON.stringify(initialDB, null, 2));
      return JSON.parse(JSON.stringify(initialDB));
    }

    const raw = fs.readFileSync(DB, "utf8");
    const db = JSON.parse(raw);

    return {
      ...initialDB,
      ...db,
      predictions: Array.isArray(db.predictions) ? db.predictions : [],
      results: Array.isArray(db.results) ? db.results : [],
      history: Array.isArray(db.history) ? db.history : []
    };
  } catch (error) {
    console.error("DB LOAD ERROR:", error.message);
    return JSON.parse(JSON.stringify(initialDB));
  }
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error("DB SAVE ERROR:", error.message);
  }
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(text);
}

function sendError(res, status, message, extra = {}) {
  sendJSON(res, status, {
    ok: false,
    error: message,
    ...extra
  });
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function sportsRequest(endpoint) {
  const url = `${SPORTS_BASE}/${endpoint}`;

  console.log("TheSportsDB:", url.replace(SPORTS_KEY, "***"));

  let response;

  try {
    response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Fanuel-Football-Prediction/2.0"
      }
    });
  } catch (error) {
    throw new Error(`TheSportsDB connection failed: ${error.message}`);
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `TheSportsDB returned invalid JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `TheSportsDB HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

/*
---------------------------------------------------------
NORMALIZE SPORTSMONKS-LIKE UI FORMAT
---------------------------------------------------------
This converts TheSportsDB events into the format
expected by our existing index.html.
---------------------------------------------------------
*/

function normalizeEvent(event) {
  if (!event) return null;

  const homeTeam =
    event.strHomeTeam ||
    event.strHomeTeam2 ||
    "Home";

  const awayTeam =
    event.strAwayTeam ||
    event.strAwayTeam2 ||
    "Away";

  const date =
    event.dateEvent ||
    event.dateEventLocal ||
    "";

  const time =
    event.strTime ||
    event.strTimeLocal ||
    "";

  const homeScore =
    event.intHomeScore !== null &&
    event.intHomeScore !== undefined
      ? safeNumber(event.intHomeScore)
      : null;

  const awayScore =
    event.intAwayScore !== null &&
    event.intAwayScore !== undefined
      ? safeNumber(event.intAwayScore)
      : null;

  let status = "scheduled";

  if (homeScore !== null && awayScore !== null) {
    status = "finished";
  }

  const eventId =
    event.idEvent ||
    event.id ||
    crypto.randomUUID();

  return {
    fixture: {
      id: String(eventId),
      date,
      time,
      timestamp: date && time
        ? `${date}T${time}`
        : date,
      status: {
        short: status
      }
    },

    league: {
      id: event.idLeague || "",
      name: event.strLeague || "Football"
    },

    teams: {
      home: {
        id: event.idHomeTeam || "",
        name: homeTeam,
        logo: event.strHomeTeamBadge || ""
      },
      away: {
        id: event.idAwayTeam || "",
        name: awayTeam,
        logo: event.strAwayTeamBadge || ""
      }
    },

    goals: {
      home: homeScore,
      away: awayScore
    },

    venue: {
      name: event.strVenue || ""
    },

    country: event.strCountry || "",
    sport: event.strSport || "Soccer",

    original: event
  };
}

/*
---------------------------------------------------------
GET MATCHES FOR A DATE
---------------------------------------------------------
*/

async function getMatchesForDate(date) {
  const data = await sportsRequest(
    `eventsday.php?d=${encodeURIComponent(date)}&s=Soccer`
  );

  const events = Array.isArray(data.events)
    ? data.events
    : [];

  return events
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(match => {
      const sport =
        String(match.sport || "").toLowerCase();

      return sport === "soccer" || sport === "football";
    })
    .sort((a, b) => {
      const ta =
        new Date(a.fixture.timestamp || a.fixture.date).getTime();

      const tb =
        new Date(b.fixture.timestamp || b.fixture.date).getTime();

      return ta - tb;
    });
}

/*
---------------------------------------------------------
GET FULL EVENT
---------------------------------------------------------
*/

async function getEvent(eventId) {
  const data = await sportsRequest(
    `lookupevent.php?id=${encodeURIComponent(eventId)}`
  );

  const event =
    Array.isArray(data.events) && data.events.length
      ? data.events[0]
      : null;

  if (!event) {
    return null;
  }

  return normalizeEvent(event);
}

/*
---------------------------------------------------------
HISTORICAL DATA
---------------------------------------------------------
We collect recent football matches from previous days.
This allows the prediction engine to learn recent form
without using bookmaker odds.
---------------------------------------------------------
*/

async function getHistoricalMatches(days = 10) {
  const today = new Date();
  const dates = [];

  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);

    const date = d.toISOString().slice(0, 10);
    dates.push(date);
  }

  const all = [];

  /*
   We deliberately process sequentially.
   This avoids firing many requests at once and helps
   stay within the free API rate limits.
  */

  for (const date of dates) {
    try {
      const matches = await getMatchesForDate(date);

      for (const match of matches) {
        if (
          match.goals.home !== null &&
          match.goals.away !== null
        ) {
          all.push(match);
        }
      }
    } catch (error) {
      console.warn(
        `Historical data failed for ${date}:`,
        error.message
      );
    }
  }

  return all;
}

/*
---------------------------------------------------------
TEAM FORM
---------------------------------------------------------
*/

function getTeamForm(teamId, teamName, historical) {
  const normalizedName =
    String(teamName || "").toLowerCase().trim();

  const matches = historical
    .filter(match => {
      const homeId = String(
        match.teams.home.id || ""
      );

      const awayId = String(
        match.teams.away.id || ""
      );

      const homeName =
        String(match.teams.home.name || "")
          .toLowerCase()
          .trim();

      const awayName =
        String(match.teams.away.name || "")
          .toLowerCase()
          .trim();

      return (
        (teamId && homeId === String(teamId)) ||
        (teamId && awayId === String(teamId)) ||
        (normalizedName && homeName === normalizedName) ||
        (normalizedName && awayName === normalizedName)
      );
    })
    .sort((a, b) => {
      const da = new Date(
        a.fixture.date
      ).getTime();

      const dbb = new Date(
        b.fixture.date
      ).getTime();

      return dbb - da;
    })
    .slice(0, 5);

  let wins = 0;
  let draws = 0;
  let losses = 0;

  let goalsFor = 0;
  let goalsAgainst = 0;

  const form = [];

  for (const match of matches) {
    const home =
      String(match.teams.home.id || "") === String(teamId) ||
      String(match.teams.home.name || "")
        .toLowerCase()
        .trim() === normalizedName;

    const gf = home
      ? safeNumber(match.goals.home)
      : safeNumber(match.goals.away);

    const ga = home
      ? safeNumber(match.goals.away)
      : safeNumber(match.goals.home);

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) {
      wins++;
      form.push("W");
    } else if (gf === ga) {
      draws++;
      form.push("D");
    } else {
      losses++;
      form.push("L");
    }
  }

  return {
    matches: matches.length,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    averageGoalsFor:
      matches.length
        ? goalsFor / matches.length
        : 1.2,
    averageGoalsAgainst:
      matches.length
        ? goalsAgainst / matches.length
        : 1.2,
    form
  };
}

/*
---------------------------------------------------------
LOCAL SAVED HISTORY
---------------------------------------------------------
*/

function getLocalTeamHistory(teamName) {
  const name =
    String(teamName || "")
      .toLowerCase()
      .trim();

  return db.results.filter(result => {
    const home =
      String(result.homeTeam || "")
        .toLowerCase()
        .trim();

    const away =
      String(result.awayTeam || "")
        .toLowerCase()
        .trim();

    return home === name || away === name;
  });
}

/*
---------------------------------------------------------
COMBINE API HISTORY + OUR OWN SAVED HISTORY
---------------------------------------------------------
*/

function improveWithLocalHistory(team, baseStats) {
  const local = getLocalTeamHistory(team.name);

  if (!local.length) {
    return baseStats;
  }

  let wins = baseStats.wins;
  let draws = baseStats.draws;
  let losses = baseStats.losses;
  let gf = baseStats.goalsFor;
  let ga = baseStats.goalsAgainst;
  let count = baseStats.matches;

  for (const result of local.slice(-20)) {
    const isHome =
      String(result.homeTeam || "")
        .toLowerCase()
        .trim() ===
      String(team.name || "")
        .toLowerCase()
        .trim();

    const homeScore = safeNumber(result.homeScore);
    const awayScore = safeNumber(result.awayScore);

    const teamGF = isHome ? homeScore : awayScore;
    const teamGA = isHome ? awayScore : homeScore;

    gf += teamGF;
    ga += teamGA;
    count++;

    if (teamGF > teamGA) wins++;
    else if (teamGF === teamGA) draws++;
    else losses++;
  }

  return {
    ...baseStats,
    matches: count,
    wins,
    draws,
    losses,
    goalsFor: gf,
    goalsAgainst: ga,
    averageGoalsFor: count ? gf / count : 1.2,
    averageGoalsAgainst: count ? ga / count : 1.2
  };
}

/*
---------------------------------------------------------
POISSON
---------------------------------------------------------
*/

function factorial(n) {
  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function poisson(lambda, k) {
  if (lambda <= 0) {
    return k === 0 ? 1 : 0;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial(k)
  );
}

/*
---------------------------------------------------------
PREDICTION ENGINE
---------------------------------------------------------
No bookmaker odds are used.
---------------------------------------------------------
*/

function predictMatch(home, away, historical) {
  let homeStats = getTeamForm(
    home.id,
    home.name,
    historical
  );

  let awayStats = getTeamForm(
    away.id,
    away.name,
    historical
  );

  homeStats = improveWithLocalHistory(home, homeStats);
  awayStats = improveWithLocalHistory(away, awayStats);

  /*
   Default values when historical data is limited.
  */

  const homeAttack =
    clamp(homeStats.averageGoalsFor, 0.3, 3.5);

  const awayAttack =
    clamp(awayStats.averageGoalsFor, 0.3, 3.5);

  const homeDefense =
    clamp(homeStats.averageGoalsAgainst, 0.3, 3.5);

  const awayDefense =
    clamp(awayStats.averageGoalsAgainst, 0.3, 3.5);

  /*
   Home advantage + attacking/defensive strength.
  */

  let expectedHome =
    (homeAttack * 0.62) +
    (awayDefense * 0.38) +
    0.25;

  let expectedAway =
    (awayAttack * 0.62) +
    (homeDefense * 0.38);

  expectedHome = clamp(expectedHome, 0.2, 4.5);
  expectedAway = clamp(expectedAway, 0.2, 4.5);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let btts = 0;

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p =
        poisson(expectedHome, h) *
        poisson(expectedAway, a);

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h + a >= 3) {
        over25 += p;
      }

      if (h >= 1 && a >= 1) {
        btts += p;
      }
    }
  }

  /*
   Normalize probabilities.
  */

  const total =
    homeWin + draw + awayWin;

  homeWin /= total;
  draw /= total;
  awayWin /= total;

  const probabilities = {
    home: homeWin,
    draw,
    away: awayWin
  };

  let pick = "DRAW";
  let highest = draw;

  if (homeWin > highest) {
    pick = "HOME";
    highest = homeWin;
  }

  if (awayWin > highest) {
    pick = "AWAY";
    highest = awayWin;
  }

  const confidence =
    clamp(
      50 +
      Math.abs(highest - 0.333) * 90 +
      Math.min(
        homeStats.matches + awayStats.matches,
        10
      ) * 1.2,
      50,
      94
    );

  let doubleChance = "1X";

  if (awayWin > homeWin && awayWin >= 0.40) {
    doubleChance = "X2";
  }

  if (homeWin >= 0.40) {
    doubleChance = "1X";
  }

  if (
    Math.abs(homeWin - awayWin) < 0.08
  ) {
    doubleChance = "12";
  }

  const totalExpected =
    expectedHome + expectedAway;

  const h2hGames =
    findLocalH2H(
      home.name,
      away.name
    ).length;

  return {
    pick,
    probabilities: {
      home: Number(homeWin.toFixed(4)),
      draw: Number(draw.toFixed(4)),
      away: Number(awayWin.toFixed(4))
    },

    confidence: Number(
      confidence.toFixed(1)
    ),

    doubleChance,

    over25: Number(
      clamp(over25, 0, 1).toFixed(4)
    ),

    bttsYes: Number(
      clamp(btts, 0, 1).toFixed(4)
    ),

    expectedGoals: {
      home: Number(
        expectedHome.toFixed(2)
      ),
      away: Number(
        expectedAway.toFixed(2)
      ),
      total: Number(
        totalExpected.toFixed(2)
      )
    },

    form: {
      home: homeStats,
      away: awayStats
    },

    h2hGames,

    model: {
      name: "Fanuel Statistical AI Engine",
      usesOdds: false,
      historicalWindowDays: 10,
      factors: [
        "Recent form",
        "Goals scored",
        "Goals conceded",
        "Home advantage",
        "Poisson goal model",
        "Saved prediction results"
      ]
    }
  };
}

function findLocalH2H(homeName, awayName) {
  const h =
    String(homeName || "")
      .toLowerCase()
      .trim();

  const a =
    String(awayName || "")
      .toLowerCase()
      .trim();

  return db.results.filter(result => {
    const rh =
      String(result.homeTeam || "")
        .toLowerCase()
        .trim();

    const ra =
      String(result.awayTeam || "")
        .toLowerCase()
        .trim();

    return (
      (rh === h && ra === a) ||
      (rh === a && ra === h)
    );
  });
}

/*
---------------------------------------------------------
SAVE PREDICTION
---------------------------------------------------------
*/

function savePrediction(match, analysis) {
  const prediction = {
    id: crypto.randomUUID(),

    createdAt: new Date().toISOString(),

    fixtureId: match.fixture.id,

    date: match.fixture.date,

    homeTeam: match.teams.home.name,

    awayTeam: match.teams.away.name,

    league: match.league.name,

    prediction: analysis.pick,

    confidence: analysis.confidence,

    probabilities:
      analysis.probabilities,

    doubleChance:
      analysis.doubleChance,

    over25:
      analysis.over25,

    bttsYes:
      analysis.bttsYes,

    expectedGoals:
      analysis.expectedGoals,

    status: "pending"
  };

  db.predictions.unshift(prediction);

  /*
   Keep database manageable.
  */

  db.predictions =
    db.predictions.slice(0, 1000);

  saveDB();

  return prediction;
}

/*
---------------------------------------------------------
HEALTH
---------------------------------------------------------
*/

async function healthCheck() {
  try {
    const data = await sportsRequest(
      "eventsday.php?d=2026-01-01&s=Soccer"
    );

    return {
      ok: true,
      liveData: true,
      provider: "TheSportsDB",
      keyConfigured: Boolean(SPORTS_KEY),
      apiResponse: Boolean(data)
    };
  } catch (error) {
    return {
      ok: false,
      liveData: false,
      provider: "TheSportsDB",
      error: error.message
    };
  }
}

/*
---------------------------------------------------------
HTTP SERVER
---------------------------------------------------------
*/

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    /*
    -----------------------------------------------------
    HEALTH
    -----------------------------------------------------
    */

    if (
      req.method === "GET" &&
      url.pathname === "/api/health"
    ) {
      const health = await healthCheck();
      return sendJSON(
        res,
        health.ok ? 200 : 503,
        health
      );
    }

    /*
    -----------------------------------------------------
    UPCOMING MATCHES
    -----------------------------------------------------
    */

    if (
      req.method === "GET" &&
      url.pathname === "/api/upcoming"
    ) {
      const date =
        url.searchParams.get("date") ||
        new Date().toISOString().slice(0, 10);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return sendError(
          res,
          400,
          "Invalid date. Use YYYY-MM-DD."
        );
      }

      const matches =
        await getMatchesForDate(date);

      return sendJSON(res, 200, matches);
    }

    /*
    -----------------------------------------------------
    ANALYZE FIXTURE
    -----------------------------------------------------
    */

    if (
      req.method === "POST" &&
      url.pathname === "/api/analyze-fixture"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const payload =
            body ? JSON.parse(body) : {};

          const fixtureId =
            payload.fixtureId ||
            payload.id;

          if (!fixtureId) {
            return sendError(
              res,
              400,
              "fixtureId is required."
            );
          }

          /*
           Get complete event.
          */

          const match =
            await getEvent(fixtureId);

          if (!match) {
            return sendError(
              res,
              404,
              "Fixture not found on TheSportsDB."
            );
          }

          /*
           Historical data.
          */

          const historical =
            await getHistoricalMatches(10);

          const analysis =
            predictMatch(
              match.teams.home,
              match.teams.away,
              historical
            );

          const prediction =
            savePrediction(
              match,
              analysis
            );

          return sendJSON(res, 200, {
            ok: true,

            fixture: match,

            analysis,

            prediction,

            dataQuality: {
              historicalMatches:
                historical.length,

              homeFormMatches:
                analysis.form.home.matches,

              awayFormMatches:
                analysis.form.away.matches,

              h2hGames:
                analysis.h2hGames
            }
          });
        } catch (error) {
          console.error(
            "ANALYZE ERROR:",
            error
          );

          return sendError(
            res,
            500,
            error.message
          );
        }
      });

      return;
    }

    /*
    -----------------------------------------------------
    PREDICTIONS
    -----------------------------------------------------
    */

    if (
      req.method === "GET" &&
      url.pathname === "/api/predictions"
    ) {
      return sendJSON(
        res,
        200,
        db.predictions.slice(0, 100)
      );
    }

    /*
    -----------------------------------------------------
    PERFORMANCE
    -----------------------------------------------------
    */

    if (
      req.method === "GET" &&
      url.pathname === "/api/performance"
    ) {
      const completed =
        db.results.length;

      const correct =
        db.results.filter(
          x => x.correct === true
        ).length;

      const accuracy =
        completed
          ? (correct / completed) * 100
          : 0;

      return sendJSON(res, 200, {
        ok: true,
        predictions:
          db.predictions.length,
        completed,
        correct,
        accuracy: Number(
          accuracy.toFixed(2)
        )
      });
    }

    /*
    -----------------------------------------------------
    RESULT
    -----------------------------------------------------
    */

    if (
      req.method === "POST" &&
      url.pathname === "/api/result"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", () => {
        try {
          const payload =
            body ? JSON.parse(body) : {};

          const {
            predictionId,
            homeScore,
            awayScore
          } = payload;

          if (!predictionId) {
            return sendError(
              res,
              400,
              "predictionId is required."
            );
          }

          const prediction =
            db.predictions.find(
              p => p.id === predictionId
            );

          if (!prediction) {
            return sendError(
              res,
              404,
              "Prediction not found."
            );
          }

          const hs =
            safeNumber(homeScore);

          const as =
            safeNumber(awayScore);

          let actual = "DRAW";

          if (hs > as) actual = "HOME";
          if (as > hs) actual = "AWAY";

          const correct =
            prediction.prediction === actual;

          const result = {
            id: crypto.randomUUID(),

            predictionId,

            date:
              new Date().toISOString(),

            homeTeam:
              prediction.homeTeam,

            awayTeam:
              prediction.awayTeam,

            homeScore: hs,

            awayScore: as,

            actual,

            predicted:
              prediction.prediction,

            correct
          };

          db.results.unshift(result);

          db.history.unshift({
            predictionId,
            predicted:
              prediction.prediction,
            actual,
            correct,
            homeTeam:
              prediction.homeTeam,
            awayTeam:
              prediction.awayTeam,
            homeScore: hs,
            awayScore: as,
            date:
              result.date
          });

          prediction.status =
            "completed";

          prediction.actual =
            actual;

          prediction.correct =
            correct;

          saveDB();

          return sendJSON(
            res,
            200,
            {
              ok: true,
              result
            }
          );
        } catch (error) {
          return sendError(
            res,
            400,
            error.message
          );
        }
      });

      return;
    }

    /*
    -----------------------------------------------------
    MANUAL PREDICT
    -----------------------------------------------------
    */

    if (
      req.method === "POST" &&
      url.pathname === "/api/manual-predict"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const payload =
            body ? JSON.parse(body) : {};

          const homeTeam =
            String(
              payload.homeTeam || ""
            ).trim();

          const awayTeam =
            String(
              payload.awayTeam || ""
            ).trim();

          if (!homeTeam || !awayTeam) {
            return sendError(
              res,
              400,
              "homeTeam and awayTeam are required."
            );
          }

          const historical =
            await getHistoricalMatches(10);

          const analysis =
            predictMatch(
              {
                id: "",
                name: homeTeam
              },
              {
                id: "",
                name: awayTeam
              },
              historical
            );

          return sendJSON(res, 200, {
            ok: true,

            homeTeam,

            awayTeam,

            analysis
          });
        } catch (error) {
          return sendError(
            res,
            500,
            error.message
          );
        }
      });

      return;
    }

    /*
    -----------------------------------------------------
    CORS PREFLIGHT
    -----------------------------------------------------
    */

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type"
      });

      return res.end();
    }

    /*
    -----------------------------------------------------
    STATIC FILES
    -----------------------------------------------------
    */

    let requestedPath =
      decodeURIComponent(url.pathname);

    if (requestedPath === "/") {
      requestedPath = "/index.html";
    }

    const filePath =
      path.normalize(
        path.join(
          PUB,
          requestedPath
        )
      );

    if (!filePath.startsWith(PUB)) {
      return sendText(
        res,
        403,
        "Forbidden"
      );
    }

    if (!fs.existsSync(filePath)) {
      return sendText(
        res,
        404,
        "Not found"
      );
    }

    const stat =
      fs.statSync(filePath);

    if (!stat.isFile()) {
      return sendText(
        res,
        404,
        "Not found"
      );
    }

    const ext =
      path.extname(filePath)
        .toLowerCase();

    const types = {
      ".html":
        "text/html; charset=utf-8",

      ".css":
        "text/css; charset=utf-8",

      ".js":
        "application/javascript; charset=utf-8",

      ".json":
        "application/json; charset=utf-8",

      ".png":
        "image/png",

      ".jpg":
        "image/jpeg",

      ".jpeg":
        "image/jpeg",

      ".svg":
        "image/svg+xml",

      ".ico":
        "image/x-icon"
    };

    res.writeHead(200, {
      "Content-Type":
        types[ext] ||
        "application/octet-stream",

      "Cache-Control":
        ext === ".html"
          ? "no-cache"
          : "public, max-age=3600"
    });

    fs.createReadStream(filePath)
      .pipe(res);

  } catch (error) {
    console.error(
      "SERVER ERROR:",
      error
    );

    if (!res.headersSent) {
      sendError(
        res,
        500,
        error.message
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(
    `Fanuel Football Prediction running on port ${PORT}`
  );

  console.log(
    "Data provider: TheSportsDB"
  );

  console.log(
    "API key configured:",
    Boolean(SPORTS_KEY)
  );
});
