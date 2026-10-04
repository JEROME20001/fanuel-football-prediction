const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "server.js");
const runtimePath = path.join(__dirname, ".fanuel-runtime-server.js");

const source = fs.readFileSync(sourcePath, "utf8");

const start = source.indexOf("  // Never present identical model outputs as 100% agreement:");
const end = source.indexOf("  const result = {", start);

if (start < 0 || end < 0) {
  throw new Error("Fanuel confidence engine patch target not found.");
}

const replacement = `  // Elite Confidence Engine:
  // Confidence measures calibrated model strength, NOT certainty.
  // It is anchored to the blended win probability and then adjusted
  // conservatively for separation, model agreement, data quality and risk.
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

  const finalKey = keyForPick(finalPick);

  const modelGap = aiEnabled
    ? Math.abs(
        Number(statistical.probabilities[finalKey] || 0) -
        Number(aiProb[finalKey] || 0)
      )
    : null;

  // Agreement is a consistency score between the statistical engine and AI.
  // It must not become a proxy for certainty, so it has a lower ceiling.
  const agreement = aiEnabled
    ? Math.max(
        35,
        Math.min(
          94,
          74 +
          (samePick ? 20 : 0) -
          (probabilityGap * 1.8)
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

`;

const patched = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(runtimePath, patched, "utf8");

process.env.FANUEL_CONFIDENCE_ENGINE = "elite-v1";
require(runtimePath);
