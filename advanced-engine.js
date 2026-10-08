/*
 * Fanuel Football Prediction - Advanced Multi-Model Engine v4
 *
 * Ten-layer decision system:
 * 1) team strength
 * 2) home/away specialist form
 * 3) recent form
 * 4) opponent-adjusted form when opponent data is available
 * 5) goal probability engine
 * 6) AI validation (AI is a validator, not the calculator)
 * 7) calibrated ensemble
 * 8) confidence calibration from settled history
 * 9) NO STRONG PICK abstention
 * 10) correct-score distribution
 *
 * This module never invents missing football data.
 */

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round(v, digits = 1) {
  const p = Math.pow(10, digits);
  return Math.round(Number(v || 0) * p) / p;
}

function mean(values, fallback = 0) {
  const valid = values.filter(v => Number.isFinite(Number(v))).map(Number);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : fallback;
}

function poisson(lambda, goals) {
  let factorial = 1;
  for (let i = 2; i <= goals; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function scoreMatrix(homeLambda, awayLambda, maxGoals = 7) {
  const cells = [];
  let total = 0;
  const rho = -0.05;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      let probability = poisson(homeLambda, h) * poisson(awayLambda, a);
      // Small Dixon-Coles style low-score correction.
      if (h === 0 && a === 0) probability *= 1 - homeLambda * awayLambda * rho;
      else if (h === 0 && a === 1) probability *= 1 + homeLambda * rho;
      else if (h === 1 && a === 0) probability *= 1 + awayLambda * rho;
      else if (h === 1 && a === 1) probability *= 1 - rho;
      cells.push({ home: h, away: a, probability });
      total += probability;
    }
  }
  if (total > 0) cells.forEach(c => c.probability /= total);
  return cells;
}

function probabilitiesFromMatrix(cells) {
  const out = { home: 0, draw: 0, away: 0, over15: 0, over25: 0, over35: 0, btts: 0 };
  for (const c of cells) {
    if (c.home > c.away) out.home += c.probability;
    else if (c.home === c.away) out.draw += c.probability;
    else out.away += c.probability;
    if (c.home + c.away >= 2) out.over15 += c.probability;
    if (c.home + c.away >= 3) out.over25 += c.probability;
    if (c.home + c.away >= 4) out.over35 += c.probability;
    if (c.home >= 1 && c.away >= 1) out.btts += c.probability;
  }
  return out;
}

function topScores(cells, limit = 5) {
  return [...cells]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit)
    .map(c => ({ score: `${c.home}-${c.away}`, probability: round(c.probability * 100, 1) }));
}

function teamStrength(form, venue = "overall") {
  const games = Number(form?.games || form?.matches || 0);
  const ppg = games ? (Number(form.wins || 0) * 3 + Number(form.draws || 0)) / games : 1.35;
  const gf = venue === "home" ? form.homeGoalsFor : venue === "away" ? form.awayGoalsFor : form.weightedGoalsFor;
  const ga = venue === "home" ? form.homeGoalsAgainst : venue === "away" ? form.awayGoalsAgainst : form.weightedGoalsAgainst;
  const attack = clamp(Number(gf || form.goalsFor || 1.35), 0.2, 4.5);
  const defense = clamp(Number(ga || form.goalsAgainst || 1.1), 0.2, 4.5);
  const rating = clamp(1500 + (ppg - 1.35) * 170 + (attack - defense) * 65, 1200, 1800);
  return {
    rating: round(rating, 1),
    ppg: round(ppg, 2),
    attack: round(attack, 2),
    defense: round(defense, 2),
    games
  };
}

function opponentAdjusted(form) {
  // The provider currently does not always expose opponent ratings.
  // Use opponent-adjusted data only when the history builder supplies it.
  const opponentRatings = Array.isArray(form?.opponentRatings) ? form.opponentRatings : [];
  if (!opponentRatings.length) {
    return { available: false, rating: null, factor: 1, note: "Opponent ratings not supplied by provider; no invented adjustment used." };
  }
  const avgOpponent = mean(opponentRatings, 1500);
  const factor = clamp(1 + (avgOpponent - 1500) / 5000, 0.85, 1.15);
  return { available: true, rating: round(avgOpponent, 1), factor: round(factor, 3), note: "Opponent strength adjustment applied from supplied ratings." };
}

function dataQuality(homeForm, awayForm) {
  const hg = Number(homeForm?.games || 0);
  const ag = Number(awayForm?.games || 0);
  const minimum = Math.min(hg, ag);
  if (minimum >= 8) return { level: "high", score: 100, homeGames: hg, awayGames: ag, reason: "Both teams have 8+ usable recent matches." };
  if (minimum >= 5) return { level: "high", score: 90, homeGames: hg, awayGames: ag, reason: "Both teams have 5+ usable recent matches." };
  if (minimum >= 3) return { level: "medium", score: 70, homeGames: hg, awayGames: ag, reason: "Both teams have some recent data, but the sample is limited." };
  return { level: "low", score: 35, homeGames: hg, awayGames: ag, reason: "Recent form data is missing or very limited." };
}

function normalizeProbabilities(p) {
  const home = clamp(p.home, 0, 100);
  const draw = clamp(p.draw, 0, 100);
  const away = clamp(p.away, 0, 100);
  const total = home + draw + away || 100;
  return { home: home / total * 100, draw: draw / total * 100, away: away / total * 100 };
}

function buildStatisticalModel(fixture, homeForm, awayForm) {
  const quality = dataQuality(homeForm, awayForm);
  const homeStrength = teamStrength(homeForm, "home");
  const awayStrength = teamStrength(awayForm, "away");
  const homeOverall = teamStrength(homeForm, "overall");
  const awayOverall = teamStrength(awayForm, "overall");
  const homeOpp = opponentAdjusted(homeForm);
  const awayOpp = opponentAdjusted(awayForm);

  const strengthGap = homeOverall.rating - awayOverall.rating;
  const venueGap = homeStrength.rating - awayStrength.rating;

  let homeAttack = clamp(mean([
    homeForm.homeGoalsFor,
    homeForm.weightedGoalsFor,
    homeForm.goalsFor
  ], 1.35), 0.2, 4.5);
  let homeDefense = clamp(mean([
    homeForm.homeGoalsAgainst,
    homeForm.weightedGoalsAgainst,
    homeForm.goalsAgainst
  ], 1.1), 0.2, 4.5);
  let awayAttack = clamp(mean([
    awayForm.awayGoalsFor,
    awayForm.weightedGoalsFor,
    awayForm.goalsFor
  ], 1.25), 0.2, 4.5);
  let awayDefense = clamp(mean([
    awayForm.awayGoalsAgainst,
    awayForm.weightedGoalsAgainst,
    awayForm.goalsAgainst
  ], 1.15), 0.2, 4.5);

  if (homeOpp.available) homeAttack *= homeOpp.factor;
  if (awayOpp.available) awayAttack *= awayOpp.factor;

  const strengthHome = clamp(1 + strengthGap / 2400, 0.82, 1.20);
  const strengthAway = clamp(1 - strengthGap / 2400, 0.82, 1.20);
  const venueHome = clamp(1.08 + venueGap / 5000, 1.02, 1.16);

  let homeLambda = ((homeAttack + awayDefense) / 2) * venueHome * strengthHome;
  let awayLambda = ((awayAttack + homeDefense) / 2) * strengthAway;

  // Recent point form affects scoring modestly, never overwhelmingly.
  const homeFormFactor = clamp(0.93 + (Number(homeForm.weightedPoints || 1.35) / 3) * 0.16, 0.93, 1.09);
  const awayFormFactor = clamp(0.93 + (Number(awayForm.weightedPoints || 1.35) / 3) * 0.16, 0.93, 1.09);
  homeLambda *= homeFormFactor;
  awayLambda *= awayFormFactor;

  // Prevent extreme expected-goal inflation from small samples.
  homeLambda = clamp(homeLambda, 0.25, 3.8);
  awayLambda = clamp(awayLambda, 0.20, 3.2);

  const cells = scoreMatrix(homeLambda, awayLambda, 7);
  const p = probabilitiesFromMatrix(cells);
  const probabilities = normalizeProbabilities({ home: p.home * 100, draw: p.draw * 100, away: p.away * 100 });
  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const topProbability = sorted[0][1];
  const margin = sorted[0][1] - sorted[1][1];
  const pick = margin < 4.5 ? "No Strong Pick" : sorted[0][0] === "home" ? "Home Win" : sorted[0][0] === "away" ? "Away Win" : "Draw";

  return {
    fixtureId: fixture.id,
    match: `${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
    homeTeam: fixture.teams.home.name,
    awayTeam: fixture.teams.away.name,
    pick,
    confidence: round(clamp(topProbability + (margin >= 18 ? 3 : margin >= 10 ? 1 : 0), 35, 90), 1),
    probabilities: {
      home: round(probabilities.home, 1),
      draw: round(probabilities.draw, 1),
      away: round(probabilities.away, 1)
    },
    doubleChance: pick === "No Strong Pick" ? "N/A" : probabilities.home >= probabilities.away ? "1X" : "X2",
    over15: round(p.over15 * 100, 1),
    over25: round(p.over25 * 100, 1),
    over35: round(p.over35 * 100, 1),
    btts: round(p.btts * 100, 1),
    expectedGoals: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    topScores: topScores(cells, 5),
    strength: {
      home: homeOverall.rating,
      away: awayOverall.rating,
      gap: round(strengthGap, 1),
      edge: round(Math.abs(strengthGap), 1),
      edgeTeam: strengthGap > 0 ? fixture.teams.home.name : strengthGap < 0 ? fixture.teams.away.name : "Even"
    },
    diagnostics: {
      homeStrength,
      awayStrength,
      homeOverall,
      awayOverall,
      homeAwayGap: round(venueGap, 1),
      opponentAdjusted: { home: homeOpp, away: awayOpp },
      probabilityMargin: round(margin, 1),
      topProbability: round(topProbability, 1)
    },
    dataQuality: quality,
    model: "Fanuel Advanced Statistical Engine v4",
    usesOdds: false,
    createdAt: new Date().toISOString()
  };
}

function ensemble(statistical, ai, calibration = null) {
  const aiEnabled = Boolean(ai?.enabled);
  const quality = statistical.dataQuality?.level || "low";
  let statWeight = quality === "high" ? 0.62 : quality === "medium" ? 0.72 : 0.82;
  if (!aiEnabled) statWeight = 1;

  const stat = normalizeProbabilities(statistical.probabilities || {});
  const aiProb = normalizeProbabilities({
    home: Number(ai?.homeProbability ?? stat.home),
    draw: Number(ai?.drawProbability ?? stat.draw),
    away: Number(ai?.awayProbability ?? stat.away)
  });
  const aiWeight = 1 - statWeight;

  const blended = normalizeProbabilities({
    home: stat.home * statWeight + aiProb.home * aiWeight,
    draw: stat.draw * statWeight + aiProb.draw * aiWeight,
    away: stat.away * statWeight + aiProb.away * aiWeight
  });

  const distributionDistance = aiEnabled
    ? (Math.abs(stat.home - aiProb.home) + Math.abs(stat.draw - aiProb.draw) + Math.abs(stat.away - aiProb.away)) / 2
    : null;
  const sorted = Object.entries(blended).sort((a, b) => b[1] - a[1]);
  const margin = sorted[0][1] - sorted[1][1];
  const aiPick = ai?.bestPick || "No Strong Pick";
  const rawPick = sorted[0][0] === "home" ? "Home Win" : sorted[0][0] === "away" ? "Away Win" : "Draw";
  const samePick = !aiEnabled ? null : aiPick === rawPick;
  const noStrongPick = margin < 6 || sorted[0][1] < 48 || (aiEnabled && aiPick === "No Strong Pick" && (margin < 11 || distributionDistance > 12));
  const finalPick = noStrongPick ? "No Strong Pick" : rawPick;

  let confidence = sorted[0][1];
  confidence += margin >= 20 ? 3 : margin >= 12 ? 1 : margin < 7 ? -3 : 0;
  if (aiEnabled && distributionDistance > 15) confidence -= 5;
  else if (aiEnabled && distributionDistance > 9) confidence -= 2;
  if (quality === "medium") confidence -= 2;
  if (quality === "low") confidence -= 6;
  if (noStrongPick) confidence -= 7;

  if (calibration?.multiplier) confidence *= calibration.multiplier;
  confidence = clamp(confidence, 35, 92);

  const agreement = aiEnabled ? clamp(100 - distributionDistance * 2.4, 0, 100) : null;
  const decisionAgreement = aiEnabled ? (samePick ? 100 : 0) : null;
  const risk = noStrongPick || quality === "low" || (aiEnabled && agreement < 65) ? "HIGH" : (margin < 14 || quality === "medium" || (aiEnabled && agreement < 82) ? "MEDIUM" : "LOW");
  const stability = !aiEnabled ? "STATISTICAL ONLY" : noStrongPick ? "ABSTAIN / UNCERTAIN" : !samePick ? (distributionDistance <= 8 ? "MODERATE" : "UNSTABLE") : distributionDistance <= 3 ? "STABLE" : distributionDistance <= 8 ? "MODERATE" : "UNSTABLE";

  const over25 = round(Number(statistical.over25 || 0) * statWeight + Number(ai?.over25Probability ?? statistical.over25 ?? 0) * aiWeight, 1);
  const btts = round(Number(statistical.btts || 0) * statWeight + Number(ai?.bttsProbability ?? statistical.btts ?? 0) * aiWeight, 1);

  return {
    probabilities: { home: round(blended.home, 1), draw: round(blended.draw, 1), away: round(blended.away, 1) },
    pick: finalPick,
    confidence: round(confidence, 1),
    doubleChance: noStrongPick ? "N/A" : blended.home >= blended.away ? "1X" : "X2",
    over25,
    btts,
    decisionStatus: noStrongPick ? "NO_STRONG_PICK" : "PICK_AVAILABLE",
    risk,
    ensemble: {
      statisticalWeight: Math.round(statWeight * 100),
      aiWeight: Math.round(aiWeight * 100),
      agreement: agreement == null ? null : round(agreement, 1),
      agreementBand: agreement == null ? "STATISTICAL ONLY" : agreement >= 95 ? "VERY HIGH" : agreement >= 85 ? "HIGH" : agreement >= 70 ? "MODERATE" : "LOW",
      decisionAgreement,
      decisionAgreementLabel: decisionAgreement == null ? "N/A" : samePick ? "SAME PICK" : "DIFFERENT PICK",
      modelGap: aiEnabled ? round(Math.max(Math.abs(stat.home - aiProb.home), Math.abs(stat.draw - aiProb.draw), Math.abs(stat.away - aiProb.away)), 1) : null,
      distributionDistance: distributionDistance == null ? null : round(distributionDistance, 1),
      probabilityMargin: round(margin, 1),
      stability,
      noStrongPick,
      edgeClass: noStrongPick ? "NO STRONG EDGE" : margin >= 15 ? "STRONG EDGE" : "MODERATE EDGE",
      confidenceLevel: confidence >= 80 ? "STRONG" : confidence >= 65 ? "MODERATE" : "LOW",
      eliteEngine: "v4-multi-model-calibrated"
    },
    calibration
  };
}

function confidenceCalibration(rows) {
  const usable = Array.isArray(rows) ? rows.filter(r => r && r.prediction && r.result && r.prediction.pick !== "No Strong Pick") : [];
  if (usable.length < 10) return { ready: false, samples: usable.length, multiplier: 1, reason: "Need at least 10 settled directional predictions." };
  const buckets = { "50-59": [], "60-69": [], "70-79": [], "80+": [] };
  for (const row of usable) {
    const c = clamp(row.prediction.confidence, 0, 100);
    const key = c >= 80 ? "80+" : c >= 70 ? "70-79" : c >= 60 ? "60-69" : "50-59";
    buckets[key].push(row);
  }
  let weightedError = 0;
  let weightedCount = 0;
  const detail = {};
  for (const [key, list] of Object.entries(buckets)) {
    if (!list.length) { detail[key] = { count: 0, accuracy: null, avgConfidence: null }; continue; }
    const accuracy = list.filter(r => r.result.correct === true).length / list.length * 100;
    const avgConfidence = mean(list.map(r => Number(r.prediction.confidence)), 0);
    detail[key] = { count: list.length, accuracy: round(accuracy, 1), avgConfidence: round(avgConfidence, 1) };
    weightedError += (accuracy - avgConfidence) * list.length;
    weightedCount += list.length;
  }
  const calibrationError = weightedCount ? weightedError / weightedCount : 0;
  // Small, bounded correction. Never allow historical noise to swing confidence wildly.
  const multiplier = clamp(1 + calibrationError / 250, 0.94, 1.06);
  return { ready: true, samples: usable.length, multiplier: round(multiplier, 4), calibrationError: round(calibrationError, 2), buckets: detail, reason: "Confidence correction learned from settled predictions." };
}

function buildFinal(statistical, ai, historyRows = [], forms = null) {
  const calibration = confidenceCalibration(historyRows);
  const e = ensemble(statistical, ai, calibration);
  const final = {
    ...statistical,
    ...e,
    probabilities: e.probabilities,
    expectedGoals: statistical.expectedGoals,
    topScores: statistical.topScores,
    correctScore: e.decisionStatus === "NO_STRONG_PICK" ? "N/A" : statistical.topScores?.[0]?.score || "N/A",
    vip: vipSelection({ ...statistical, ...e, form: forms || null }, ai),
    confidenceMetrics: {
      modelConfidence: e.confidence,
      winProbability: Math.max(e.probabilities.home, e.probabilities.draw, e.probabilities.away),
      dataConfidence: statistical.dataQuality?.level === "high" ? "HIGH" : statistical.dataQuality?.level === "medium" ? "MEDIUM" : "LOW",
      confidenceLevel: e.ensemble.confidenceLevel,
      edgeClass: e.ensemble.edgeClass,
      noStrongPick: e.ensemble.noStrongPick,
      probabilityMargin: e.ensemble.probabilityMargin,
      calibrationReady: calibration.ready
    }
  };
  return final;
}

function vipSelection(prediction, ai) {
  const probs = prediction?.probabilities || {};
  const home = Number(probs.home || 0);
  const drawProb = Number(probs.draw || 0);
  const away = Number(probs.away || 0);

  const statBtts = clamp(Number(prediction?.btts || 0), 0, 100);
  const aiBtts = clamp(Number(ai?.bttsProbability ?? statBtts), 0, 100);
  const bttsDistance = Math.abs(statBtts - aiBtts);

  const values = [
    ["Home Win", home],
    ["Draw", drawProb],
    ["Away Win", away]
  ].sort((a,b)=>b[1]-a[1]);

  const topPick = values[0][0];
  const topProbability = values[0][1];
  const secondProbability = values[1][1];
  const margin = topProbability - secondProbability;

  const aiActive = Boolean(ai?.enabled);
  const top150Team = prediction?.top150Team === true;
  const sportBetAvailable = prediction?.sportyBetAvailable === true;
  const sportBetMarkets = prediction?.sportyBetMarkets || {};
  const sportBetOneXTwoAvailable = sportBetAvailable && sportBetMarkets.oneXTwo !== false;
  const sportBetBttsAvailable = sportBetAvailable && sportBetMarkets.btts !== false;
  const aiPick = String(ai?.bestPick || "No Strong Pick");
  const agreement = Number(prediction?.ensemble?.agreement ?? 0);
  const distance = Number(prediction?.ensemble?.distributionDistance ?? 999);
  const stability = String(prediction?.ensemble?.stability || "");
  const stabilityOK = stability === "STABLE" || stability === "MODERATE";
  const coverageStabilityOK = stabilityOK || !stability || stability === "UNCERTAIN";

  const homeGames = Number(prediction?.dataQuality?.homeGames || prediction?.form?.home?.games || 0);
  const awayGames = Number(prediction?.dataQuality?.awayGames || prediction?.form?.away?.games || 0);
  const homeVenueGames = Number(prediction?.form?.home?.homeGames || 0);
  const awayVenueGames = Number(prediction?.form?.away?.awayGames || 0);
  const dataLevel = String(prediction?.dataQuality?.level || "").toLowerCase();
  const usableData = dataLevel === "high" || dataLevel === "medium";
  const sampleOK = homeGames >= 3 && awayGames >= 3;
  const venueSampleOK = (homeVenueGames === 0 || homeVenueGames >= 2 || homeGames >= 5) &&
    (awayVenueGames === 0 || awayVenueGames >= 2 || awayGames >= 5);

  const oneXTwoStrict =
    sportBetOneXTwoAvailable && aiActive && usableData && sampleOK && venueSampleOK &&
    Number(prediction?.confidence || 0) >= 56 &&
    topProbability >= 52 && margin >= 6 &&
    agreement >= 75 && aiPick === topPick &&
    distance <= 14 && stabilityOK;

  const oneXTwoCoverage =
    sportBetOneXTwoAvailable && top150Team && aiActive && usableData && sampleOK && venueSampleOK &&
    Number(prediction?.confidence || 0) >= 52 &&
    topProbability >= 50 && margin >= 4 &&
    agreement >= 65 && aiPick === topPick &&
    distance <= 20 && coverageStabilityOK;

  const oneXTwo = {
    market: "1X2",
    pick: topPick,
    probability: round(topProbability, 1),
    margin: round(margin, 1),
    strictEligible: oneXTwoStrict,
    coverageEligible: oneXTwoCoverage,
    eligible: oneXTwoStrict || oneXTwoCoverage,
    strength: oneXTwoStrict ? "STRONG" : oneXTwoCoverage ? "COVERAGE" : "REJECTED",
    criteria: {
      sportBetOneXTwoAvailable, sportBetBttsAvailable, sportBetAvailable, top150Team, aiActive, usableData, minimumSample: sampleOK, venueSample: venueSampleOK,
      strict: {
        confidenceMin56: Number(prediction?.confidence || 0) >= 56,
        probabilityMin52: topProbability >= 52,
        marginMin6: margin >= 6,
        agreementMin75: agreement >= 75,
        aiSamePick: aiPick === topPick,
        modelDistanceMax14: distance <= 14,
        stabilityOK
      },
      coverage: {
        confidenceMin52: Number(prediction?.confidence || 0) >= 52,
        probabilityMin50: topProbability >= 50,
        marginMin4: margin >= 4,
        agreementMin65: agreement >= 65,
        aiSamePick: aiPick === topPick,
        modelDistanceMax20: distance <= 20,
        coverageStabilityOK
      }
    }
  };

  const drawEdge = drawProb - Math.max(home, away);
  const drawStrict =
    sportBetOneXTwoAvailable && aiActive && usableData && sampleOK && venueSampleOK &&
    drawProb >= 29 && drawEdge >= 2 &&
    aiPick === "Draw" && agreement >= 75 &&
    distance <= 14 && stabilityOK;

  const drawCoverage =
    sportBetOneXTwoAvailable && top150Team && aiActive && usableData && sampleOK && venueSampleOK &&
    drawProb >= 28 && drawEdge >= 1 &&
    aiPick === "Draw" && agreement >= 65 &&
    distance <= 20 && coverageStabilityOK;

  const draw = {
    market: "DRAW",
    pick: "Draw",
    probability: round(drawProb, 1),
    margin: round(drawEdge, 1),
    strictEligible: drawStrict,
    coverageEligible: drawCoverage,
    eligible: drawStrict || drawCoverage,
    strength: drawStrict ? "STRONG" : drawCoverage ? "COVERAGE" : "REJECTED",
    criteria: {
      sportBetOneXTwoAvailable, sportBetAvailable, top150Team, aiActive, usableData, minimumSample: sampleOK, venueSample: venueSampleOK,
      strict: {
        probabilityMin29: drawProb >= 29,
        drawEdgeMin2: drawEdge >= 2,
        aiDraw: aiPick === "Draw",
        agreementMin75: agreement >= 75,
        modelDistanceMax14: distance <= 14,
        stabilityOK
      },
      coverage: {
        probabilityMin28: drawProb >= 28,
        drawEdgeMin1: drawEdge >= 1,
        aiDraw: aiPick === "Draw",
        agreementMin65: agreement >= 65,
        modelDistanceMax20: distance <= 20,
        coverageStabilityOK
      }
    }
  };

  const bttsPick = statBtts >= 50 ? "BTTS YES" : "BTTS NO";
  const aiBttsPick = aiBtts >= 50 ? "BTTS YES" : "BTTS NO";
  const bttsProbability = bttsPick === "BTTS YES" ? statBtts : 100 - statBtts;
  const bttsAiProbability = bttsPick === "BTTS YES" ? aiBtts : 100 - aiBtts;
  const bttsConfidence = Math.max(statBtts, 100 - statBtts);
  const bttsEdge = Math.abs(statBtts - 50);

  const bttsStrict =
    sportBetBttsAvailable && aiActive && usableData && sampleOK && venueSampleOK &&
    bttsConfidence >= 56 && bttsEdge >= 6 &&
    aiBttsPick === bttsPick && bttsDistance <= 14 &&
    agreement >= 75 && stabilityOK;

  const bttsCoverage =
    sportBetBttsAvailable && top150Team && aiActive && usableData && sampleOK && venueSampleOK &&
    bttsConfidence >= 53 && bttsEdge >= 4 &&
    aiBttsPick === bttsPick && bttsDistance <= 20 &&
    agreement >= 65 && coverageStabilityOK;

  const btts = {
    market: "BTTS",
    pick: bttsPick,
    probability: round(bttsProbability, 1),
    aiProbability: round(bttsAiProbability, 1),
    edge: round(bttsEdge, 1),
    modelDistance: round(bttsDistance, 1),
    strictEligible: bttsStrict,
    coverageEligible: bttsCoverage,
    eligible: bttsStrict || bttsCoverage,
    strength: bttsStrict ? "STRONG" : bttsCoverage ? "COVERAGE" : "REJECTED",
    criteria: {
      sportBetBttsAvailable, sportBetAvailable, top150Team, aiActive, usableData, minimumSample: sampleOK, venueSample: venueSampleOK,
      strict: {
        confidenceMin56: bttsConfidence >= 56,
        edgeMin6: bttsEdge >= 6,
        aiSameSignal: aiBttsPick === bttsPick,
        bttsModelDistanceMax14: bttsDistance <= 14,
        agreementMin75: agreement >= 75,
        stabilityOK
      },
      coverage: {
        confidenceMin53: bttsConfidence >= 53,
        edgeMin4: bttsEdge >= 4,
        aiSameSignal: aiBttsPick === bttsPick,
        bttsModelDistanceMax20: bttsDistance <= 20,
        agreementMin65: agreement >= 65,
        coverageStabilityOK
      }
    }
  };

  const markets = { oneXTwo, draw, btts };
  const eligibleMarkets = Object.values(markets).filter(m => m.eligible);
  const primary = [...eligibleMarkets].sort((a,b)=>(Number(b.probability||0)-Number(a.probability||0)))[0] || null;

  const scoreFor = m => {
    const probability = Number(m.probability || 0);
    const edge = Math.abs(Number(m.margin ?? m.edge ?? 0));
    const tierBonus = m.strength === "STRONG" ? 12 : m.strength === "COVERAGE" ? 0 : -20;
    return round((m.eligible ? 60 : 0) + tierBonus + Math.min(25, Math.max(0, (probability - 50) * 1.5)) + Math.min(15, Math.max(0, edge)), 1);
  };
  for (const market of Object.values(markets)) market.score = scoreFor(market);

  const eligibleWithScores = Object.values(markets).filter(m => m.eligible).sort((a,b)=>b.score-a.score);
  const best = eligibleWithScores[0] || null;

  return {
    eligible: eligibleWithScores.length > 0,
    tier: eligibleWithScores.length ? (eligibleWithScores.some(m => m.strength === "STRONG") ? "VIP STRONG" : "VIP COVERAGE") : "REJECTED",
    primaryMarket: best?.market || null,
    primaryPick: best?.pick || null,
    score: best?.score || 0,
    topProbability: best?.probability || 0,
    probabilityMargin: best?.margin ?? best?.edge ?? 0,
    markets,
    eligibleMarkets: eligibleWithScores.map(m => ({
      market: m.market,
      pick: m.pick,
      probability: m.probability,
      score: m.score
    })),
    reasons: Object.values(markets).filter(m=>!m.eligible).map(m=>m.market + ": rejected"),
    criteria: { sportBetAvailable, sportBetOneXTwoAvailable, sportBetBttsAvailable, top150Team, aiActive, usableData, minimumSample: sampleOK, venueSample: venueSampleOK }
  };
}

module.exports = {
  buildStatisticalModel,
  buildFinal,
  confidenceCalibration,
  scoreMatrix,
  probabilitiesFromMatrix,
  topScores,
  dataQuality,
  vipSelection,
  vvipSelection: vipSelection
};
