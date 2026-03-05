# Automation Worker

This folder contains the Python tooling that scrapes insurance/fund news, builds the daily digest, renders the Gemini cover image, and pushes the finished package to LINE.

## Structure

- `ingestion/`: HTML snapshot fetchers + parsers writing into `knowledge/insurance.db`.
- `scripts/`: Digest + cover + LINE push utilities.
- `knowledge/schema.sql`: SQLite schema applied on first run.
- `run_worker.sh`: Convenience entrypoint that runs ingestion → parsing → LINE push.
- `requirements.txt`: Python dependencies used by the worker.

## Secrets

To avoid checking secrets into git, the scripts prefer environment variables:

- `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`

(Optionally you can drop JSON files under `automation/config/` for local testing.)

## Typical cron command

```
cd automation && ./run_worker.sh
```

That command will:

1. Fetch the latest insurance/fund sources (`ingestion/run_ingestion.py`).
2. Parse snapshots into normalized tables (`ingestion/process_snapshots.py`).
3. Generate digest markdown/JSON + Gemini cover and broadcast via LINE (`scripts/push_daily_digest.py`).
```
