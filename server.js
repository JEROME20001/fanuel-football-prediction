const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY || "";
const API_BASE = "https://v3.football.api-sports.io";

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify({
      predictions: [],
      results: []
    }, null, 2)
  );
}

function readDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

    if (!Array.isArray(db.predictions)) {
      db.predictions = [];
    }

    if (!Array.isArray(db.results)) {
      db.results = [];
    }

    return db;
  } catch {
    return {
      predictions: [],
      results: []
    };
  }
}

function saveDB(data) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(data, null, 2)
  );
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  res.writeHead(200, {
    "Content-Type": contentType
  });

  res.end(fs.readFileSync(filePath));
}

async function apiRequest(endpoint) {
  if (!API_KEY) {
    throw new Error(
      "API_FOOTBALL_KEY haijawekwa kwenye Render Environment Variables."
    );
  }

  const response = await fetch(
    API_BASE + endpoint,
    {
      headers: {
        "x-apisports-key": API_KEY
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `API-Football error: HTTP ${response.status}`
    );
  }

  return data;
}


/* =========================
   FORM ANALYSIS
========================= */

function getFormStats(form) {
  const text = String(form || "").toUpperCase();

  const wins = (text.match(/W/g) || []).length;
  const draws = (text.match(/D/g) || []).length;
  const losses = (text.match(/L/g) || []).length;

  const total = wins + draws + losses || 1;

  return {
    wins: wins / total,
    draws: draws / total,
    losses: losses / total
  };
}


/* =========================
   POISSON MODEL
========================= */

function poisson(k, lambda) {
  let probability = Math.exp(-lambda);
  let term = 1;

  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
  }

  return probability * term;
}


/* =========================
   HISTORICAL LEARNING
========================= */

function getLearningAdjustment() {
  const db = readDB();

  const completed = db.predictions.filter(
    p => p.status === "correct" || p.status === "incorrect"
  );

  if (completed.length < 5) {
    return {
      sampleSize: completed.length,
      accuracy: null,
      adjustment: 0
    };
  }

  const correct = completed.filter(
    p => p.status === "correct"
  ).length;

  const accuracy = correct / completed.length;

  /*
    Mfumo haujifanyi kuwa accurate kwa sababu tu
    kuna data kidogo. Adjustment inakuwa ndogo.
  */

  let adjustment = 0;

  if (accuracy >= 0.65) {
    adjustment = 0.04;
  } else if (accuracy >= 0.55) {
    adjustment = 0.02;
  } else if (accuracy < 0.45) {
    adjustment = -0.03;
  }

  return {
    sampleSize: completed.length,
    accuracy: Number((accuracy * 100).toFixed(1)),
    adjustment
  };
}


/* =========================
   PREDICTION ENGINE
========================= */

function predictionModel(home, away) {

  const homeForm =
    getFormStats(home.form);

  const awayForm =
    getFormStats(away.form);

  const homeGF =
    Number(home.goals?.for?.average) || 1.2;

  const homeGA =
    Number(home.goals?.against?.average) || 1.2;

  const awayGF =
    Number(away.goals?.for?.average) || 1.2;

  const awayGA =
    Number(away.goals?.against?.average) || 1.2;


  /* Form strength */

  const homeFormBoost =
    0.25 * homeForm.wins -
    0.12 * homeForm.losses;

  const awayFormBoost =
    0.25 * awayForm.wins -
    0.12 * awayForm.losses;


  /* Expected goals */

  let expectedHomeGoals =
    0.60 * homeGF +
    0.40 * awayGA +
    0.18 +
    homeFormBoost;

  let expectedAwayGoals =
    0.60 * awayGF +
    0.40 * homeGA +
    awayFormBoost;


  /* Historical learning */

  const learning =
    getLearningAdjustment();

  if (learning.adjustment > 0) {
    expectedHomeGoals *=
      1 + learning.adjustment * 0.5;

    expectedAwayGoals *=
      1 + learning.adjustment * 0.5;
  }


  expectedHomeGoals =
    Math.max(0.20, expectedHomeGoals);

  expectedAwayGoals =
    Math.max(0.20, expectedAwayGoals);


  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  let over25 = 0;
  let bttsYes = 0;

  let totalProbability = 0;


  for (
    let homeGoals = 0;
    homeGoals <= 7;
    homeGoals++
  ) {

    for (
      let awayGoals = 0;
      awayGoals <= 7;
      awayGoals++
    ) {

      const probability =
        poisson(
          homeGoals,
          expectedHomeGoals
        ) *
        poisson(
          awayGoals,
          expectedAwayGoals
        );

      totalProbability += probability;


      if (homeGoals > awayGoals) {
        homeWin += probability;

      } else if (
        homeGoals === awayGoals
      ) {
        draw += probability;

      } else {
        awayWin += probability;
      }


      if (
        homeGoals + awayGoals >= 3
      ) {
        over25 += probability;
      }


      if (
        homeGoals > 0 &&
        awayGoals > 0
      ) {
        bttsYes += probability;
      }
    }
  }


  homeWin /= totalProbability;
  draw /= totalProbability;
  awayWin /= totalProbability;
  over25 /= totalProbability;
  bttsYes /= totalProbability;


  const probabilities = [
    homeWin,
    draw,
    awayWin
  ];

  const maximum =
    Math.max(...probabilities);


  let pick = "DRAW";

  if (maximum === homeWin) {
    pick = "HOME";
  } else if (maximum === awayWin) {
    pick = "AWAY";
  }


  let doubleChance = "X2";

  if (homeWin >= awayWin) {
    doubleChance = "1X";
  }


  return {

    expectedGoals: {
      home: Number(
        expectedHomeGoals.toFixed(2)
      ),
      away: Number(
        expectedAwayGoals.toFixed(2)
      )
    },

    probabilities: {
      home: Number(
        (homeWin * 100).toFixed(1)
      ),
      draw: Number(
        (draw * 100).toFixed(1)
      ),
      away: Number(
        (awayWin * 100).toFixed(1)
      )
    },

    pick,

    confidence: Number(
      (maximum * 100).toFixed(1)
    ),

    doubleChance,

    over25: Number(
      (over25 * 100).toFixed(1)
    ),

    under25: Number(
      ((1 - over25) * 100).toFixed(1)
    ),

    bttsYes: Number(
      (bttsYes * 100).toFixed(1)
    ),

    bttsNo: Number(
      ((1 - bttsYes) * 100).toFixed(1)
    ),

    learning: {
      historicalGames:
        learning.sampleSize,

      historicalAccuracy:
        learning.accuracy
    }
  };
}


/* =========================
   FIXTURE ANALYSIS
========================= */

async function analyzeFixture(fixture) {

  const leagueId =
    fixture.league?.id;

  const season =
    fixture.league?.season;

  const homeTeam =
    fixture.teams?.home;

  const awayTeam =
    fixture.teams?.away;


  if (
    !leagueId ||
    !season ||
    !homeTeam?.id ||
    !awayTeam?.id
  ) {
    throw new Error(
      "Fixture data haijakamilika."
    );
  }


  const [
    homeStats,
    awayStats,
    h2h
  ] = await Promise.all([

    apiRequest(
      `/teams/statistics?league=${leagueId}&season=${season}&team=${homeTeam.id}`
    ),

    apiRequest(
      `/teams/statistics?league=${leagueId}&season=${season}&team=${awayTeam.id}`
    ),

    apiRequest(
      `/fixtures/headtohead?h2h=${homeTeam.id}-${awayTeam.id}&last=5`
    )

  ]);


  const analysis =
    predictionModel(
      homeStats.response || {},
      awayStats.response || {}
    );


  const record = {

    id:
      Date.now().toString(),

    fixtureId:
      fixture.fixture?.id || null,

    date:
      fixture.fixture?.date || null,

    league:
      fixture.league?.name || "",

    home:
      homeTeam.name,

    away:
      awayTeam.name,

    homeTeamId:
      homeTeam.id,

    awayTeamId:
      awayTeam.id,

    analysis,

    h2hGames:
      h2h.response?.length || 0,

    status:
      "pending",

    actualResult:
      null,

    createdAt:
      new Date().toISOString()
  };


  const database =
    readDB();

  database.predictions.unshift(record);

  saveDB(database);

  return record;
}


/* =========================
   READ BODY
========================= */

function readRequestBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";

      req.on(
        "data",
        chunk => {
          body += chunk;
        }
      );

      req.on(
        "end",
        () => {

          if (!body) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(body)
            );
          } catch (error) {
            reject(error);
          }

        }
      );

    }
  );
}


/* =========================
   RECORD RESULT
========================= */

function determineResult(
  homeGoals,
  awayGoals
) {

  if (homeGoals > awayGoals) {
    return "HOME";
  }

  if (homeGoals < awayGoals) {
    return "AWAY";
  }

  return "DRAW";
}


function updatePredictionResult(
  prediction,
  homeGoals,
  awayGoals
) {

  const actual =
    determineResult(
      homeGoals,
      awayGoals
    );

  const predicted =
    prediction.analysis?.pick;

  const status =
    predicted === actual
      ? "correct"
      : "incorrect";

  prediction.status =
    status;

  prediction.actualResult = {
    homeGoals,
    awayGoals,
    result: actual
  };

  prediction.evaluatedAt =
    new Date().toISOString();

  return status;
}


/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        if (
          req.method === "OPTIONS"
        ) {

          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers":
                "Content-Type"
            }
          );

          res.end();

          return;
        }


        /* HEALTH */

        if (
          req.method === "GET" &&
          req.url === "/api/health"
        ) {

          sendJSON(
            res,
            200,
            {
              ok: true,
              app:
                "Fanuel Football Prediction",
              liveData:
                Boolean(API_KEY)
            }
          );

          return;
        }


        /* PREDICTIONS */

        if (
          req.method === "GET" &&
          req.url === "/api/predictions"
        ) {

          const database =
            readDB();

          sendJSON(
            res,
            200,
            database.predictions
          );

          return;
        }


        /* PERFORMANCE */

        if (
          req.method === "GET" &&
          req.url === "/api/performance"
        ) {

          const database =
            readDB();

          const completed =
            database.predictions.filter(
              p =>
                p.status === "correct" ||
                p.status === "incorrect"
            );

          const correct =
            completed.filter(
              p =>
                p.status === "correct"
            ).length;

          const incorrect =
            completed.filter(
              p =>
                p.status === "incorrect"
            ).length;

          const accuracy =
            completed.length > 0
              ? (correct /
                  completed.length) *
                100
              : null;

          sendJSON(
            res,
            200,
            {
              totalPredictions:
                database.predictions.length,

              evaluated:
                completed.length,

              correct,

              incorrect,

              accuracy:
                accuracy === null
                  ? null
                  : Number(
                      accuracy.toFixed(1)
                    )
            }
          );

          return;
        }


        /* UPCOMING */

        if (
          req.method === "GET" &&
          req.url.startsWith(
            "/api/upcoming"
          )
        ) {

          const url =
            new URL(
              req.url,
              "http://localhost"
            );

          const date =
            url.searchParams.get(
              "date"
            ) ||
            new Date()
              .toISOString()
              .slice(0, 10);


          const data =
            await apiRequest(
              `/fixtures?date=${date}`
            );


          sendJSON(
            res,
            200,
            data.response || []
          );

          return;
        }


        /* ANALYZE FIXTURE */

        if (
          req.method === "POST" &&
          req.url ===
            "/api/analyze-fixture"
        ) {

          const body =
            await readRequestBody(req);

          let fixture =
            body.fixture;


          if (
            !fixture &&
            body.fixtureId
          ) {

            const data =
              await apiRequest(
                `/fixtures?id=${body.fixtureId}`
              );

            fixture =
              data.response?.[0];
          }


          if (!fixture) {
            throw new Error(
              "Tuma fixture au fixtureId."
            );
          }


          const result =
            await analyzeFixture(
              fixture
            );


          sendJSON(
            res,
            200,
            result
          );

          return;
        }


        /* MANUAL PREDICTION */

        if (
          req.method === "POST" &&
          req.url ===
            "/api/manual-predict"
        ) {

          const body =
            await readRequestBody(req);


          const result =
            predictionModel(
              body.home || {},
              body.away || {}
            );


          sendJSON(
            res,
            200,
            result
          );

          return;
        }


        /* RECORD RESULT */

        if (
          req.method === "POST" &&
          req.url ===
            "/api/result"
        ) {

          const body =
            await readRequestBody(req);

          const database =
            readDB();


          let prediction = null;


          if (body.predictionId) {

            prediction =
              database.predictions.find(
                p =>
                  p.id ===
                  String(
                    body.predictionId
                  )
              );

          }


          if (prediction) {

            updatePredictionResult(
              prediction,
              Number(
                body.homeGoals
              ),
              Number(
                body.awayGoals
              )
            );

          }


          database.results.unshift({

            predictionId:
              body.predictionId ||
              null,

            homeGoals:
              Number(
                body.homeGoals
              ),

            awayGoals:
              Number(
                body.awayGoals
              ),

            result:
              determineResult(
                Number(
                  body.homeGoals
                ),
                Number(
                  body.awayGoals
                )
              ),

            recordedAt:
              new Date().toISOString()

          });


          saveDB(database);


          sendJSON(
            res,
            200,
            {
              ok: true,

              predictionStatus:
                prediction
                  ? prediction.status
                  : "prediction not found"
            }
          );

          return;
        }


        /* STATIC FILES */

        let requested =
          req.url.split("?")[0];


        if (
          requested === "/"
        ) {
          requested =
            "/index.html";
        }


        const filePath =
          path.join(
            PUBLIC_DIR,
            requested
          );


        if (
          !filePath.startsWith(
            PUBLIC_DIR
          ) ||
          !fs.existsSync(
            filePath
          )
        ) {

          sendJSON(
            res,
            404,
            {
              error:
                "Not found"
            }
          );

          return;
        }


        const extension =
          path.extname(
            filePath
          );


        const contentTypes = {

          ".html":
            "text/html; charset=utf-8",

          ".js":
            "text/javascript; charset=utf-8",

          ".css":
            "text/css; charset=utf-8",

          ".json":
            "application/json; charset=utf-8"

        };


        sendFile(
          res,
          filePath,
          contentTypes[
            extension
          ] ||
            "application/octet-stream"
        );


      } catch (error) {

        console.error(error);

        sendJSON(
          res,
          500,
          {
            error:
              error.message
          }
        );

      }

    }
  );


server.listen(
  PORT,
  () => {

    console.log(
      `Fanuel Football Prediction running on port ${PORT}`
    );

  }
);
