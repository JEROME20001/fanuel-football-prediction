```js
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const TOKEN = process.env.SPORTMONKS_API_TOKEN || "";
const API_BASE = "https://api.sportmonks.com/v3/football";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
    expires:
      Date.now() +
      minutes * 60 * 1000
  });
}

async function apiRequest(endpoint) {
  if (!TOKEN) {
    throw new Error(
      "SPORTMONKS_API_TOKEN haijawekwa kwenye Render."
    );
  }

  const separator =
    endpoint.includes("?")
      ? "&"
      : "?";

  const url =
    API_BASE +
    endpoint +
    separator +
    "api_token=" +
    encodeURIComponent(TOKEN);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Sportmonks ilirudisha response isiyo JSON. HTTP " +
      response.status
    );
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
      "Sportmonks HTTP " +
      response.status
    );
  }

  return data;
}

/* ================================
   GET FIXTURES BY DATE
================================ */

async function getFixtures(date) {
  const cacheKey = "date:" + date;

  const cached = cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  let page = 1;
  let all = [];

  while (true) {
    const endpoint =
      "/fixtures/date/" +
      date +
      "?per_page=50&page=" +
      page +
      "&include=participants;league;season";

    const response =
      await apiRequest(endpoint);

    const fixtures =
      Array.isArray(response.data)
        ? response.data
        : [];

    all = all.concat(fixtures);

    if (
      !response.pagination ||
      response.pagination.has_more !== true ||
      fixtures.length === 0
    ) {
      break;
    }

    page++;

    if (page > 20) {
      break;
    }
  }

  const matches = all.map(formatFixture);

  const result = {
    ok: true,
    provider: "Sportmonks",
    date,
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
  const participants =
    Array.isArray(fixture.participants)
      ? fixture.participants
      : [];

  let home = null;
  let away = null;

  participants.forEach(team => {
    const location =
      team.meta &&
      team.meta.location;

    if (location === "home") {
      home = team;
    }

    if (location === "away") {
      away = team;
    }
  });

  if (!home && participants[0]) {
    home = participants[0];
  }

  if (!away && participants[1]) {
    away = participants[1];
  }

  return {
    id: fixture.id,

    name:
      fixture.name ||
      "Unknown Match",

    starting_at:
      fixture.starting_at,

    homeTeam: {
      id: home ? home.id : null,
      name:
        home
          ? home.name
          : "Home Team",

      logo:
        home
          ? home.image_path || null
          : null
    },

    awayTeam: {
      id: away ? away.id : null,
      name:
        away
          ? away.name
          : "Away Team",

      logo:
        away
          ? away.image_path || null
          : null
    },

    league: {
      id:
        fixture.league
          ? fixture.league.id
          : fixture.league_id,

      name:
        fixture.league
          ? fixture.league.name
          : "Unknown League"
    },

    season:
      fixture.season || null,

    state:
      fixture.state || null,

    result_info:
      fixture.result_info || null,

    starting_at_timestamp:
      fixture.starting_at_timestamp || null
  };
}

/* ================================
   GET FIXTURE BY ID
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
      "/fixtures/" +
      encodeURIComponent(id) +
      "?include=participants;league;season;scores"
    );

  if (!response.data) {
    throw new Error(
      "Fixture haijapatikana."
    );
  }

  cacheSet(
    cacheKey,
    response.data,
    30
  );

  return response.data;
}

/* ================================
   TEAM HISTORY
================================ */

async function getTeamHistory(teamId) {
  if (!teamId) {
    return [];
  }

  const end =
    new Date();

  const start =
    new Date(
      end.getTime() -
      120 *
      24 *
      60 *
      60 *
      1000
    );

  const startDate =
    start
      .toISOString()
      .slice(0, 10);

  const endDate =
    end
      .toISOString()
      .slice(0, 10);

  const cacheKey =
    "history:" +
    teamId +
    ":" +
    startDate +
    ":" +
    endDate;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const endpoint =
    "/fixtures/between/" +
    startDate +
    "/" +
    endDate +
    "/" +
    teamId +
    "?per_page=50&page=1" +
    "&include=participants;scores;league";

  const response =
    await apiRequest(endpoint);

  const fixtures =
    Array.isArray(response.data)
      ? response.data
      : [];

  cacheSet(
    cacheKey,
    fixtures,
    30
  );

  return fixtures;
}

/* ================================
   SCORE
================================ */

function getScore(
  fixture,
  homeId,
  awayId
) {
  if (
    !Array.isArray(
      fixture.scores
    )
  ) {
    return null;
  }

  let home = null;
  let away = null;

  fixture.scores.forEach(score => {
    const participant =
      score.participant_id;

    const goals =
      score.score &&
      score.score.goals;

    if (
      goals === undefined ||
      goals === null
    ) {
      return;
    }

    if (
      String(participant) ===
      String(homeId)
    ) {
      home = Number(goals);
    }

    if (
      String(participant) ===
      String(awayId)
    ) {
      away = Number(goals);
    }
  });

  if (
    Number.isFinite(home) &&
    Number.isFinite(away)
  ) {
    return {
      home,
      away
    };
  }

  return null;
}

/* ================================
   TEAM FORM
================================ */

function teamForm(
  teamId,
  fixtures
) {
  const games = [];

  fixtures
    .sort(
      (a, b) =>
        new Date(b.starting_at) -
        new Date(a.starting_at)
    )
    .forEach(fixture => {
      const participants =
        fixture.participants || [];

      let home = null;
      let away = null;

      participants.forEach(team => {
        const loc =
          team.meta &&
          team.meta.location;

        if (loc === "home") {
          home = team;
        }

        if (loc === "away") {
          away = team;
        }
      });

      if (!home || !away) {
        return;
      }

      const score =
        getScore(
          fixture,
          home.id,
          away.id
        );

      if (!score) {
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
          ? score.home
          : score.away;

      const ga =
        isHome
          ? score.away
          : score.home;

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
  let gf = 0;
  let ga = 0;

  last.forEach(game => {
    gf += game.gf;
    ga += game.ga;

    if (game.result === "W") {
      wins++;
    }

    if (game.result === "D") {
      draws++;
    }

    if (game.result === "L") {
      losses++;
    }
  });

  return {
    matches: last.length,

    wins,

    draws,

    losses,

    goalsFor:
      gf / last.length,

    goalsAgainst:
      ga / last.length,

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
      } else if (h === a) {
        draw += p;
      } else {
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

  // Home advantage
  homeLambda *= 1.08;

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

  let pick = "Draw";
  let confidence =
    drawPct;

  if (
    homePct >
    confidence
  ) {
    pick = "Home Win";
    confidence =
      homePct;
  }

  if (
    awayPct >
    confidence
  ) {
    pick = "Away Win";
    confidence =
      awayPct;
  }

  return {
    fixtureId:
      fixture.id,

    match:
      fixture.name,

    homeTeam:
      fixture.participants
        ? fixture.participants[0]?.name
        : "Home",

    awayTeam:
      fixture.participants
        ? fixture.participants[1]?.name
        : "Away",

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

/* ================================
   ANALYZE
================================ */

async function analyze(
  fixtureId
) {
  const fixture =
    await getFixture(
      fixtureId
    );

  const participants =
    fixture.participants || [];

  let home = null;
  let away = null;

  participants.forEach(team => {
    const location =
      team.meta &&
      team.meta.location;

    if (location === "home") {
      home = team;
    }

    if (location === "away") {
      away = team;
    }
  });

  if (
    !home ||
    !away
  ) {
    throw new Error(
      "Sportmonks haikurudisha home/away teams."
    );
  }

  const [
    homeHistory,
    awayHistory
  ] =
    await Promise.all([
      getTeamHistory(
        home.id
      ),

      getTeamHistory(
        away.id
      )
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
      {
        ...fixture,
        name:
          fixture.name ||
          `${home.name} vs ${away.name}`
      },
      homeForm,
      awayForm
    );

  db.predictions.push(
    result
  );

  if (
    db.predictions.length >
    500
  ) {
    db.predictions =
      db.predictions.slice(
        -500
      );
  }

  saveDB(db);

  return result;
}

/* ================================
   JSON RESPONSE
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
   API
================================ */

async function api(
  req,
  res,
  url
) {
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
          "Sportmonks",
        tokenConfigured:
          Boolean(TOKEN),
        service:
          "Fanuel Football Prediction"
      }
    );
  }

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
        .slice(0, 10);

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
        x =>
          x.correct === true
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

  if (
    file === "/"
  ) {
    file =
      "/index.html";
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
      "Sportmonks token configured:",
      Boolean(TOKEN)
    );
  }
);
```
