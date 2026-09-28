# Fanuel Football Prediction

AI-assisted football prediction web app using API-Football data, a statistical baseline, OpenAI deep analysis, and prediction-performance tracking.

## Features

- Live fixture lookup by date
- Team last-10-match form analysis
- Statistical probability baseline
- OpenAI football analysis layer
- No bookmaker odds are sent to the AI as an input
- AI engine demo that works independently of API-Football
- Prediction history
- Manual result settlement
- Automatic result settlement from API-Football when a fixture has a final score
- Accuracy/performance dashboard

## Required Render environment variables

Set these in the Render Web Service environment:

- `API_FOOTBALL_KEY` — API-Football key
- `OPENAI_API_KEY` — OpenAI API key
- `OPENAI_MODEL` — `gpt-5.6-luna`

Never commit API keys to GitHub or paste them into chat.

## Important provider dependency

The application can start without a working API-Football subscription, and the **Test AI Engine** button can still verify the OpenAI layer. Live fixtures, historical team data, and automatic result settlement require API-Football access to be active.

## Main endpoints

- `/api/health` — application and AI configuration status
- `/api/ai-health` — AI configuration status
- `/api/ai-demo` — AI engine test without API-Football
- `/api/upcoming?date=YYYY-MM-DD` — fixtures
- `/api/analyze-fixture` — deep prediction for a fixture
- `/api/predictions` — stored predictions
- `/api/performance` — prediction accuracy
- `/api/settle` — manually settle a prediction with a score
- `/api/settle-fixture` — fetch a fixture's score and settle it automatically
- `/api/test` — API-Football connectivity test

## Render deployment

Connect the GitHub repository to a Render Web Service, use:

- Build command: leave empty
- Start command: `npm start`

After each push to `main`, Render should deploy the latest commit if automatic deploys are enabled.

## Prediction disclaimer

Predictions are probabilistic estimates, not guarantees. The system should report uncertainty rather than present any match outcome as certain.
