const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const API_KEY = process.env.API_FOOTBALL_KEY || "";
const API_BASE = "https://v3.football.api-sports.io";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ================================
   DATABASE
================================ */

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return {
        predictions: [],
        results: []
      };
    }

    return JSON.parse(
      fs.readFileSync(DB_FILE, "utf8")
    );
  } catch {
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
      JSON.stringify(db, null, 2)
    );
  } catch (err) {
    console.log("DB save error:", err.message);
  }
}

const db = loadDB();

/* ================================
   CACHE
================================ */

const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function cacheSet(key, value, minutes) {
  cache.set(key, {
    value,
    expires: Date.now() + minutes * 60 * 1000
  });
}

/* ================================
   API-FOOTBALL REQUEST
================================ */

async function apiRequest(endpoint) {
  if (!API_KEY) {
    throw new Error(
      "API_FOOTBALL_KEY haijawekwa kwenye Render."
    );
  }

  const response = await fetch(
    API_BASE + endpoint,
    {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "Accept": "application/json"
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "API-Football ilirudisha response isiyo JSON. HTTP " +
      response.status
    );
  }

  if (!response.ok) {
    const message =
      Array.isArray(data.errors)
        ? data.errors.join(", ")
        : data.message ||
          "API-Football HTTP " +
          response.status;

    throw new Error(message);
  }

  if (
    Array.isArray(data.errors) &&
    data.errors.length > 0
  ) {
    throw new Error(
      data.errors.join(", ")
    );
  }

  return data;
}

/* ================================
   GET FIXTURES BY DATE
================================ */

async function getFixtures(date) {
  const cacheKey = "fixtures:" + date;

  const cached = cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const endpoint =
    "/fixtures?date=" +
    encodeURIComponent(date) +
    "&timezone=Africa%2FDar_es_Salaam";

  const response =
    await apiRequest(endpoint);

  const fixtures =
    Array.isArray(response.response)
      ? response.response
      : [];

  console.log(
    "API-Football:",
    date,
    "fixtures:",
    fixtures.length
  );

  /*
   * API inaweza kurudisha errors bila
   * HTTP error.
   */
  if (
    Array.isArray(response.errors) &&
    response.errors.length > 0
  ) {
    throw new Error(
      "API-Football: " +
      response.errors.join(", ")
    );
  }

  if (!fixtures.length) {
    return {
      ok: true,
      provider: "API-Football",
      date,
      timezone:
        "Africa/Dar_es_Salaam",
      count: 0,
      matches: [],
      message:
        "Hakuna mechi zilizorudishwa na API-Football kwa tarehe hii."
    };
  }

  const matches =
    fixtures.map(formatFixture);

  const result = {
    ok: true,
    provider: "API-Football",
    date,
    timezone:
      "Africa/Dar_es_Salaam",
    count: matches.length,
    matches
  };

  cacheSet(
    cacheKey,
    result,
    5
  );

  return result;
}

/* ================================
   FORMAT FIXTURE
================================ */

function formatFixture(fixture) {
  const f =
    fixture.fixture || {};

  const teams =
    fixture.teams || {};

  const league =
    fixture.league || {};

  return {
    id: f.id,

    name:
      `${teams.home?.name || "Home"} vs ` +
      `${teams.away?.name || "Away"}`,

    starting_at:
      f.date || null,

    homeTeam: {
      id:
        teams.home?.id || null,

      name:
        teams.home?.name || "Home Team",

      logo:
        teams.home?.logo || null
    },

    awayTeam: {
      id:
        teams.away?.id || null,

      name:
        teams.away?.name || "Away Team",

      logo:
        teams.away?.logo || null
    },

    league: {
      id:
        league.id || null,

      name:
        league.name || "Unknown League",

      country:
        league.country || ""
    },

    season:
      league.season || null,

    status:
      f.status || null,

    venue:
      f.venue || null,

    raw:
      fixture
  };
}

/* ================================
   GET FIXTURE
================================ */

async function getFixture(id) {
  const cacheKey =
    "fixture:" + id;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const response =
    await apiRequest(
      "/fixtures?id=" +
      encodeURIComponent(id)
    );

  if (
    !Array.isArray(response.response) ||
    !response.response.length
  ) {
    throw new Error(
      "Fixture haijapatikana."
    );
  }

  const fixture =
    response.response[0];

  cacheSet(
    cacheKey,
    fixture,
    30
  );

  return fixture;
}

/* ================================
   TEAM LAST MATCHES
================================ */

async function getTeamHistory(teamId) {
  if (!teamId) {
    return [];
  }

  const cacheKey =
    "team-last:" + teamId;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const response =
    await apiRequest(
      "/fixtures?team=" +
      encodeURIComponent(teamId) +
      "&last=10"
    );

  const fixtures =
    Array.isArray(response.response)
      ? response.response
      : [];

  cacheSet(
    cacheKey,
    fixtures,
    30
  );

  return fixtures;
}

/* ================================
   TEAM FORM
================================ */

function teamForm(
  teamId,
  fixtures
) {
  const games = [];

  fixtures.forEach(fixture => {
    const teams =
      fixture.teams || {};

    const home =
      teams.home;

    const away =
      teams.away;

    const goals =
      fixture.goals || {};

    if (
      !home ||
      !away ||
      goals.home === null ||
      goals.away === null ||
      goals.home === undefined ||
      goals.away === undefined
    ) {
      return;
    }

    const isHome =
      String(home.id) ===
      String(teamId);

    const isAway =
      String(away.id) ===
      String(teamId);

    if (!isHome && !isAway) {
      return;
    }

    const gf =
      isHome
        ? Number(goals.home)
        : Number(goals.away);

    const ga =
      isHome
        ? Number(goals.away)
        : Number(goals.home);

    if (
      !Number.isFinite(gf) ||
      !Number.isFinite(ga)
    ) {
      return;
    }

    let result = "D";

    if (gf > ga) {
      result = "W";
    }

    if (gf < ga) {
      result = "L";
    }

    games.push({
      result,
      gf,
      ga
    });
  });

  const last =
    games.slice(0, 5);

  if (!last.length) {
    return {
      matches: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 1.35,
      goalsAgainst: 1.10,
      points: 0,
      form: "N/A"
    };
  }

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  last.forEach(game => {
    goalsFor += game.gf;
    goalsAgainst += game.ga;

    if (game.result === "W") wins++;
    if (game.result === "D") draws++;
    if (game.result === "L") losses++;
  });

  return {
    matches: last.length,
    wins,
    draws,
    losses,

    goalsFor:
      goalsFor / last.length,

    goalsAgainst:
      goalsAgainst / last.length,

    points:
      wins * 3 + draws,

    form:
      last
        .map(x => x.result)
        .join("")
  };
}

/* ================================
   POISSON
================================ */

function factorial(n) {
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

function probabilities(
  homeLambda,
  awayLambda
) {
  let home = 0;
  let draw = 0;
  let away = 0;
  let over25 = 0;
  let btts = 0;

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p =
        poisson(homeLambda, h) *
        poisson(awayLambda, a);

      if (h > a) {
        home += p;
      } else if (h === a) {
        draw += p;
      } else {
        away += p;
      }

      if (h + a >= 3) {
        over25 += p;
      }

      if (h >= 1 && a >= 1) {
        btts += p;
      }
    }
  }

  const total =
    home + draw + away;

  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
    over25,
    btts
  };
}

/* ================================
   PREDICTION
================================ */

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

  /*
    HOME ADVANTAGE
  */

  homeLambda *= 1.08;

  /*
    FORM ADJUSTMENT
  */

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

  if (homeForm.matches > 0) {
    homeLambda *=
      0.90 +
      homeFormFactor * 0.20;
  }

  if (awayForm.matches > 0) {
    awayLambda *=
      0.90 +
      awayFormFactor * 0.20;
  }

  homeLambda =
    Math.max(
      0.25,
      Math.min(homeLambda, 4)
    );

  awayLambda =
    Math.max(
      0.20,
      Math.min(awayLambda, 4)
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

  let pick = "Draw";
  let confidence = drawPct;

  if (homePct > confidence) {
    pick = "Home Win";
    confidence = homePct;
  }

  if (awayPct > confidence) {
    pick = "Away Win";
    confidence = awayPct;
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
      home: homePct,
      draw: drawPct,
      away: awayPct
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
      home: homeForm,
      away: awayForm
    },

    model:
      "Fanuel Statistical AI",

    usesOdds:
      false,

    createdAt:
      new Date().toISOString()
  };
}

/* ================================
   ANALYZE FIXTURE
================================ */

async function analyze(fixtureId) {
  const fixture =
    await getFixture(fixtureId);

  const teams =
    fixture.teams || {};

  const home =
    teams.home;

  const away =
    teams.away;

  if (!home || !away) {
    throw new Error(
      "API-Football haikurudisha home/away teams."
    );
  }

  const [
    homeHistory,
    awayHistory
  ] = await Promise.all([
    getTeamHistory(home.id),
    getTeamHistory(away.id)
  ]);

  const homeForm =
    teamForm(
      home.id,
      homeHistory
    );

  const awayForm =
    teamForm(
      away.id,
      awayHistory
    );

  const result =
    predict(
      fixture,
      homeForm,
      awayForm
    );

  db.predictions.push(result);

  if (
    db.predictions.length > 500
  ) {
    db.predictions =
      db.predictions.slice(-500);
  }

  saveDB(db);

  return result;
}

/* ================================
   JSON
================================ */

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
        "no-store"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}

/* ================================
   API ROUTES
================================ */

async function api(
  req,
  res,
  url
) {
  /* HEALTH */

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
          "API-Football",

        tokenConfigured:
          Boolean(API_KEY),

        service:
          "Fanuel Football Prediction"
      }
    );
  }

  /* UPCOMING */

  if (
    url.pathname ===
    "/api/upcoming"
  ) {
    const date =
      url.searchParams.get("date") ||
      new Date()
        .toISOString()
        .slice(0, 10);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
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
        await getFixtures(date);

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

  /* ANALYZE */

  if (
    url.pathname ===
    "/api/analyze-fixture"
  ) {
    if (req.method !== "POST") {
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
        body += chunk;
      }
    );

    req.on(
      "end",
      async () => {
        try {
          const data =
            JSON.parse(
              body || "{}"
            );

          if (!data.fixtureId) {
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

  /* PREDICTIONS */

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

  /* PERFORMANCE */

  if (
    url.pathname ===
    "/api/performance"
  ) {
    const results =
      db.results || [];

    const settled =
      results.length;

    const correct =
      results.filter(
        x => x.correct === true
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
                ) * 1000
              ) / 10
            : 0
      }
    );
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

/* ================================
   STATIC FILES
================================ */

function serveFile(
  req,
  res
) {
  let file =
    decodeURIComponent(
      new URL(
        req.url,
        "http://localhost"
      ).pathname
    );

  if (file === "/") {
    file = "/index.html";
  }

  const filePath =
    path.join(
      PUBLIC_DIR,
      file
    );

  if (
    !filePath.startsWith(
      PUBLIC_DIR
    )
  ) {
    res.writeHead(403);
    return res.end(
      "Forbidden"
    );
  }

  fs.readFile(
    filePath,
    (err, data) => {
      if (err) {
        res.writeHead(404);
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

        ".svg":
          "image/svg+xml"
      };

      res.writeHead(
        200,
        {
          "Content-Type":
            types[ext] ||
            "application/octet-stream"
        }
      );

      res.end(data);
    }
  );
}

/* ================================
   SERVER
================================ */

const server =
  http.createServer(
    async (req, res) => {
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
  );

server.listen(
  PORT,
  () => {
    console.log(
      "Fanuel Football Prediction running on port " +
      PORT
    );

    console.log(
      "API-Football key configured:",
      Boolean(API_KEY)
    );
  }
);
