# knowledge/

Structured cache for external intel that feeds the LINE bot. Each fetch job writes JSON entries with:

```json
{
  "id": "kgifund-ACCP138-TFO3",
  "sourceId": "kgi-balanced",
  "title": "",
  "summary": "",
  "url": "",
  "tags": ["fund", "balanced"],
  "fetchedAt": "2026-03-05T02:40:00+08:00"
}
```

For now we keep a single `entries.json` snapshot (latest data for each source). Background jobs can extend this into a rolling log if needed.
