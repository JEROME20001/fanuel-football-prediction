const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const DB = path.join(DATA, "db.json");

const SPORTS_KEY = process.env.THE_SPORTS_DB_KEY || "123";
const SPORTS_BASE =
  `https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}`;

const PROVIDER_MIN_INTERVAL = 500;
const FIXTURE_CACHE_TTL = 5 * 60 * 1000;
const EVENT_CACHE_TTL = 30 * 60 * 1000;
const HISTORY_CACHE_TTL = 30 * 60 * 1000;

let lastProviderRequest = 0;
let providerQueue = Promise.resolve();

const fixtureCache = new Map();
const eventCache = new Map();

let historyCache = {
  expiresAt: 0,
  data: []
};

/* =========================
   DATABASE
========================= */

const initialDB = {
  settings: {
    siteName: "Fanuel Football Prediction",
    provider: "TheSportsDB"
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

    const data = JSON.parse(fs.readFileSync(DB, "utf8"));

    return {
      ...initialDB,
      ...data,
      predictions: data.predictions || [],
      results: data.results || [],
      history: data.history || []
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(initialDB));
  }
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("DB save error:", e.message);
  }
}

/* =========================
   HELPERS
========================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) return resolve({});

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

/* =========================
   PROVIDER REQUEST
========================= */

function providerRequest(endpoint, retry = 0) {
  providerQueue = providerQueue.then(async () => {
    const now = Date.now();
    const wait = PROVIDER_MIN_INTERVAL - (now - lastProviderRequest);

    if (wait > 0) {
      await sleep(wait);
    }

    lastProviderRequest = Date.now();

    const url = `${SPORTS_BASE}/${endpoint}`;

    let response;

    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(`TheSportsDB network error: ${error.message}`);
    }

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        raw: text
      };
    }

    /* RATE LIMIT */
    if (response.status === 429) {
      let retryAfter = 30;

      if (data && data.retry_after) {
        retryAfter = Number(data.retry_after) || 30;
      }

      if (retry < 2) {
        console.log(
          `TheSportsDB rate limit. Waiting ${retryAfter}s...`
        );

        await sleep(retryAfter * 1000);

        return providerRequest(endpoint, retry + 1);
      }

      const error = new Error(
        `TheSportsDB rate limit. Try again in ${retryAfter} seconds.`
      );

      error.status = 429;
      error.retryAfter = retryAfter;

      throw error;
    }

    if (!response.ok) {
      const error = new Error(
        `TheSportsDB HTTP ${response.status}: ${text}`
      );

      error.status = response.status;

      throw error;
    }

    return data;
  });

  return providerQueue;
}

/* =========================
   NORMALIZE EVENT
========================= */

function normalizeEvent(event) {
  if (!event) return null;

  const date =
    event.dateEvent ||
    event.strTimestamp?.slice(0, 10) ||
    "";

  const time =
    event.strTime ||
    event.strTimestamp?.slice(11, 19) ||
    "";

  let timestamp = null;

  if (event.strTimestamp) {
    const t = Date.parse(event.strTimestamp);
    if (!Number.isNaN(t)) timestamp = t;
  } else if (date && time) {
    const t = Date.parse(`${date}T${time}`);
    if (!Number.isNaN(t)) timestamp = t;
  }

  return {
    fixture: {
      id: String(event.idEvent || ""),
      date,
      time,
      timestamp,
      status: event.strStatus || event.strProgress || "Scheduled"
    },

    league: {
      id: event.idLeague || "",
      name: event.strLeague || "Unknown League"
    },

    teams: {
      home: {
        id: event.idHomeTeam || "",
        name: event.strHomeTeam || "Home Team",
        logo: event.strHomeTeamBadge || ""
      },

      away: {
        id: event.idAwayTeam || "",
        name: event.strAwayTeam || "Away Team",
        logo: event.strAwayTeamBadge || ""
      }
    },

    goals: {
      home:
        event.intHomeScore !== null &&
        event.intHomeScore !== undefined
          ? Number(event.intHomeScore)
          : null,

      away:
        event.intAwayScore !== null &&
        event.intAwayScore !== undefined
          ? Number(event.intAwayScore)
          : null
    },

    venue: event.strVenue || "",
    country: event.strCountry || "",
    sport: event.strSport || "Soccer",

    original: event
  };
}

/* =========================
   GET MATCHES FOR DATE
========================= */

async function getMatchesForDate(date) {
  const cached = fixtureCache.get(date);

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached.data;
  }

  const data = await providerRequest(
    `eventsday.php?d=${encodeURIComponent(date)}&s=Soccer`
  );

  const events = Array.isArray(data?.events)
    ? data.events
    : [];

  /*
    IMPORTANT:
    Hapa hatuchukui matches 3 tu.
    Tunachukua events zote zinazopatikana.
  */

  const matches = events
    .map(normalizeEvent)
    .filter(Boolean)
    .filter(match => match.fixture.id);

  /*
    Save each event into cache so later analysis
    does not need another API call.
  */

  for (const match of matches) {
    eventCache.set(match.fixture.id, {
      expiresAt: Date.now() + EVENT_CACHE_TTL,
      data: match
    });
  }

  fixtureCache.set(date, {
    expiresAt: Date.now() + FIXTURE_CACHE_TTL,
    data: matches
  });

  return matches;
}

/* =========================
   GET EVENT
========================= */

async function getEvent(eventId) {
  const cached = eventCache.get(String(eventId));

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached.data;
  }

  const data = await providerRequest(
    `lookupevent.php?id=${encodeURIComponent(eventId)}`
  );

  const event =
    Array.isArray(data?.events) &&
    data.events.length
      ? normalizeEvent(data.events[0])
      : null;

  if (event) {
    eventCache.set(String(eventId), {
      expiresAt: Date.now() + EVENT_CACHE_TTL,
      data: event
    });
  }

  return event;
}

/* =========================
   HISTORICAL DATA
========================= */

async function getHistoricalMatches(days = 7) {
  if (
    historyCache.expiresAt > Date.now() &&
    historyCache.data.length
  ) {
    return historyCache.data;
  }

  const results = [];
  const today = new Date();

  /*
    Fetch previous days slowly.
    Cache prevents this from happening
    every time the user analyzes a match.
  */

  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);

    const date =
      d.toISOString().slice(0, 10);

    try {
      const matches = await getMatchesForDate(date);

      for (const match of matches) {
        const homeGoals = match.goals.home;
        const awayGoals = match.goals.away;

        if (
          homeGoals !== null &&
          awayGoals !== null
        ) {
          results.push(match);
        }
      }
    } catch (error) {
      console.log(
        `History ${date} skipped:`,
        error.message
      );
    }
  }

  historyCache = {
    expiresAt: Date.now() + HISTORY_CACHE_TTL,
    data: results
  };

  return results;
}

/* =========================
   TEAM FORM
========================= */

function getTeamForm(teamId, historical) {
  const games = historical
    .filter(match =>
      String(match.teams.home.id) === String(teamId) ||
      String(match.teams.away.id) === String(teamId)
    )
    .sort((a, b) => {
      return (
        (b.fixture.timestamp || 0) -
        (a.fixture.timestamp || 0)
      );
    })
    .slice(0, 5);

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const game of games) {
    const home =
      Number(game.goals.home || 0);

    const away =
      Number(game.goals.away || 0);

    const isHome =
      String(game.teams.home.id) === String(teamId);

    const gf = isHome ? home : away;
    const ga = isHome ? away : home;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
  }

  return {
    games: games.length,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points:
      wins * 3 + draws,
    averageGoalsFor:
      games.length
        ? goalsFor / games.length
        : 0,
    averageGoalsAgainst:
      games.length
        ? goalsAgainst / games.length
        : 0
  };
}

/* =========================
   LOCAL HISTORY
========================= */

function getLocalTeamForm(teamId) {
  const games = db.history
    .filter(game =>
      String(game.homeTeamId) === String(teamId) ||
      String(game.awayTeamId) === String(teamId)
    )
    .slice(-10)
    .reverse();

  let wins = 0;
  let draws = 0;
  let losses = 0;

  for (const game of games) {
    const home =
      Number(game.homeScore || 0);

    const away =
      Number(game.awayScore || 0);

    const isHome =
      String(game.homeTeamId) === String(teamId);

    const gf = isHome ? home : away;
    const ga = isHome ? away : home;

    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
  }

  return {
    games: games.length,
    wins,
    draws,
    losses,
    points:
      wins * 3 + draws
  };
}

/* =========================
   POISSON
========================= */

function factorial(n) {
  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function poisson(lambda, k) {
  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial(k)
  );
}

/* =========================
   PREDICTION ENGINE
========================= */

function predictMatch(match, historical) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;

  const homeForm =
    getTeamForm(homeId, historical);

  const awayForm =
    getTeamForm(awayId, historical);

  const localHome =
    getLocalTeamForm(homeId);

  const localAway =
    getLocalTeamForm(awayId);

  /*
    Base expected goals.
    NO BOOKMAKER ODDS ARE USED.
  */

  let homeLambda = 1.35;
  let awayLambda = 1.05;

  if (homeForm.games > 0) {
    homeLambda =
      0.75 +
      homeForm.averageGoalsFor * 0.55 +
      Math.max(
        0,
        1 - homeForm.averageGoalsAgainst * 0.15
      );
  }

  if (awayForm.games > 0) {
    awayLambda =
      0.65 +
      awayForm.averageGoalsFor * 0.55 +
      Math.max(
        0,
        1 - awayForm.averageGoalsAgainst * 0.15
      );
  }

  /*
    Local historical learning.
  */

  if (localHome.games > 0) {
    homeLambda +=
      (localHome.points / localHome.games) * 0.08;
  }

  if (localAway.games > 0) {
    awayLambda +=
      (localAway.points / localAway.games) * 0.08;
  }

  homeLambda = Math.max(
    0.25,
    Math.min(homeLambda, 3.5)
  );

  awayLambda = Math.max(
    0.20,
    Math.min(awayLambda, 3.2)
  );

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

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 3) {
        over25 += probability;
      }

      if (h > 0 && a > 0) {
        btts += probability;
      }
    }
  }

  const probabilities = {
    home:
      Math.round(homeWin * 1000) / 10,

    draw:
      Math.round(draw * 1000) / 10,

    away:
      Math.round(awayWin * 1000) / 10
  };

  let pick = "DRAW";
  let highest = draw;

  if (homeWin > highest) {
    highest = homeWin;
    pick = "HOME WIN";
  }

  if (awayWin > highest) {
    highest = awayWin;
    pick = "AWAY WIN";
  }

  const confidence =
    Math.round(highest * 100);

  let doubleChance = "1X";

  if (
    awayWin > homeWin &&
    awayWin > draw
  ) {
    doubleChance = "X2";
  } else if (
    homeWin > awayWin &&
    homeWin > draw
  ) {
    doubleChance = "1X";
  } else {
    doubleChance = "12";
  }

  return {
    pick,

    confidence,

    probabilities,

    doubleChance,

    over25: Math.round(over25 * 1000) / 10,

    btts: Math.round(btts * 1000) / 10,

    expectedGoals: {
      home:
        Math.round(homeLambda * 100) / 100,

      away:
        Math.round(awayLambda * 100) / 100,

      total:
        Math.round(
          (homeLambda + awayLambda) * 100
        ) / 100
    },

    form: {
      home: homeForm,
      away: awayForm
    },

    localLearning: {
      home: localHome,
      away: localAway
    },

    model:
      "Poisson + Team Form + Historical Learning",

    usesOdds: false,

    generatedAt:
      new Date().toISOString()
  };
}

/* =========================
   SAVE PREDICTION
========================= */

function savePrediction(match, prediction) {
  const item = {
    id: crypto.randomUUID(),

    fixtureId: match.fixture.id,

    date: match.fixture.date,

    homeTeam: match.teams.home.name,

    awayTeam: match.teams.away.name,

    prediction,

    createdAt:
      new Date().toISOString(),

    result: null
  };

  db.predictions.push(item);

  /*
    Keep database manageable.
  */

  if (db.predictions.length > 1000) {
    db.predictions =
      db.predictions.slice(-1000);
  }

  saveDB();

  return item;
}

/* =========================
   PERFORMANCE
========================= */

function getPerformance() {
  const predictions = db.predictions;

  let correct = 0;
  let completed = 0;

  for (const p of predictions) {
    if (!p.result) continue;

    completed++;

    if (p.result.correct === true) {
      correct++;
    }
  }

  return {
    totalPredictions:
      predictions.length,

    completed,

    correct,

    wrong:
      completed - correct,

    accuracy:
      completed
        ? Math.round(
            (correct / completed) * 1000
          ) / 10
        : 0
  };
}

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(
  async (req, res) => {

    try {

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      const pathname = parsed.pathname;

      /* HEALTH */

      if (
        req.method === "GET" &&
        pathname === "/api/health"
      ) {
        /*
          IMPORTANT:
          Health no longer calls TheSportsDB.
          This prevents unnecessary 429 errors.
        */

        return json(res, 200, {
          ok: true,
          app: "Fanuel Football Prediction",
          provider: "TheSportsDB",
          liveData: true,
          keyConfigured:
            Boolean(SPORTS_KEY),
          time:
            new Date().toISOString()
        });
      }

      /* UPCOMING */

      if (
        req.method === "GET" &&
        pathname === "/api/upcoming"
      ) {

        const date =
          parsed.searchParams.get("date") ||
          new Date()
            .toISOString()
            .slice(0, 10);

        const matches =
          await getMatchesForDate(date);

        return json(res, 200, {
          success: true,
          date,
          count: matches.length,
          matches
        });
      }

      /* ANALYZE */

      if (
        req.method === "POST" &&
        pathname === "/api/analyze-fixture"
      ) {

        const body =
          await readBody(req);

        const fixtureId =
          body.fixtureId;

        if (!fixtureId) {
          return json(res, 400, {
            success: false,
            error: "fixtureId is required"
          });
        }

        let match =
          eventCache.get(String(fixtureId))
            ?.data;

        /*
          Normally the match should already be
          cached from /api/upcoming.
        */

        if (!match) {
          match =
            await getEvent(fixtureId);
        }

        if (!match) {
          return json(res, 404, {
            success: false,
            error: "Match not found"
          });
        }

        /*
          Historical data is cached.
        */

        const historical =
          await getHistoricalMatches(7);

        const prediction =
          predictMatch(
            match,
            historical
          );

        const saved =
          savePrediction(
            match,
            prediction
          );

        return json(res, 200, {
          success: true,
          match,
          prediction,
          savedPrediction: saved
        });
      }

      /* PREDICTIONS */

      if (
        req.method === "GET" &&
        pathname === "/api/predictions"
      ) {

        return json(res, 200, {
          success: true,
          predictions:
            db.predictions
              .slice()
              .reverse()
        });
      }

      /* PERFORMANCE */

      if (
        req.method === "GET" &&
        pathname === "/api/performance"
      ) {

        return json(res, 200, {
          success: true,
          performance:
            getPerformance()
        });
      }

      /* RECORD RESULT */

      if (
        req.method === "POST" &&
        pathname === "/api/result"
      ) {

        const body =
          await readBody(req);

        const prediction =
          db.predictions.find(
            p =>
              p.id === body.predictionId
          );

        if (!prediction) {
          return json(res, 404, {
            success: false,
            error: "Prediction not found"
          });
        }

        prediction.result = {
          homeScore:
            Number(body.homeScore),

          awayScore:
            Number(body.awayScore),

          correct:
            body.correct === true,

          recordedAt:
            new Date().toISOString()
        };

        /*
          Save learning history.
        */

        db.history.push({
          predictionId:
            prediction.id,

          fixtureId:
            prediction.fixtureId,

          homeTeam:
            prediction.homeTeam,

          awayTeam:
            prediction.awayTeam,

          homeScore:
            Number(body.homeScore),

          awayScore:
            Number(body.awayScore),

          homeTeamId:
            body.homeTeamId || "",

          awayTeamId:
            body.awayTeamId || "",

          recordedAt:
            new Date().toISOString()
        });

        saveDB();

        return json(res, 200, {
          success: true,
          performance:
            getPerformance()
        });
      }

      /* MANUAL PREDICT */

      if (
        req.method === "POST" &&
        pathname === "/api/manual-predict"
      ) {

        const body =
          await readBody(req);

        if (
          !body.homeTeam ||
          !body.awayTeam
        ) {
          return json(res, 400, {
            success: false,
            error:
              "homeTeam and awayTeam are required"
          });
        }

        const match = {
          fixture: {
            id: crypto.randomUUID(),
            date:
              new Date()
                .toISOString()
                .slice(0, 10),
            time: "",
            timestamp: Date.now(),
            status: "Manual"
          },

          league: {
            id: "",
            name:
              body.league ||
              "Manual Match"
          },

          teams: {
            home: {
              id:
                body.homeTeamId ||
                body.homeTeam,
              name: body.homeTeam
            },

            away: {
              id:
                body.awayTeamId ||
                body.awayTeam,
              name: body.awayTeam
            }
          },

          goals: {
            home: null,
            away: null
          }
        };

        const historical =
          await getHistoricalMatches(7);

        const prediction =
          predictMatch(
            match,
            historical
          );

        const saved =
          savePrediction(
            match,
            prediction
          );

        return json(res, 200, {
          success: true,
          match,
          prediction,
          savedPrediction: saved
        });
      }

      /* STATIC FILES */

      let filePath;

      if (pathname === "/") {
        filePath =
          path.join(PUB, "index.html");
      } else {
        filePath =
          path.join(
            PUB,
            pathname.replace(/^\/+/, "")
          );
      }

      /*
        Prevent directory traversal.
      */

      const safeRoot =
        path.resolve(PUB);

      const safeFile =
        path.resolve(filePath);

      if (
        !safeFile.startsWith(safeRoot)
      ) {
        return json(res, 403, {
          error: "Forbidden"
        });
      }

      if (
        fs.existsSync(safeFile) &&
        fs.statSync(safeFile).isFile()
      ) {

        const ext =
          path.extname(safeFile)
            .toLowerCase();

        const types = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".svg": "image/svg+xml"
        };

        res.writeHead(200, {
          "Content-Type":
            types[ext] ||
            "application/octet-stream"
        });

        return fs.createReadStream(
          safeFile
        ).pipe(res);
      }

      return json(res, 404, {
        error: "Not found"
      });

    } catch (error) {

      console.error(
        "SERVER ERROR:",
        error
      );

      if (error.status === 429) {
        return json(res, 429, {
          success: false,
          error:
            "TheSportsDB is temporarily rate-limiting requests.",
          retryAfter:
            error.retryAfter || 30
        });
      }

      return json(res, 500, {
        success: false,
        error:
          error.message ||
          "Internal server error"
      });
    }
  }
);

server.listen(PORT, () => {
  console.log(
    `Fanuel Football Prediction running on port ${PORT}`
  );
});
