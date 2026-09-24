# Weekly report automation

Emails a client's Monday-to-Friday attendance report. One call per client, plus
one for every client combined.

## The endpoint

```
POST https://station.savykids.com/api/weekly-report?companyId=<id|all>
x-admin-key: <ADMIN_API_KEY>
```

`GET` works identically, so a scheduler that only issues GETs is fine.

| Parameter | Meaning |
| --- | --- |
| `companyId` | A company document id, or `all` for the combined report. Defaults to `all`. |
| `weeksAgo` | `0` (default) is the week just finished. `1` replays the week before, and so on, up to 52. |
| `recipients` | Comma-separated override. Without it, the addresses saved on the company are used. |
| `dryRun` | `true` returns the report and its rows without emailing. Use this to check a client before switching the schedule on. |
| `token` | The admin key, if you cannot set the `x-admin-key` header. |

### Which week it picks

Resolved from the run time in the company's timezone, so the scheduler never
has to compute dates:

- **Saturday or Sunday** → the week that just finished (Mon–Fri).
- **Monday to Friday** → the previous week, because this week is still being worked.

Running Saturday 26 September reports Mon 21 – Fri 25 September. Running the
following Wednesday reports the same week. Once the next Monday passes, a
Saturday run rolls forward on its own.

### Response

```json
{
  "ok": true,
  "companyId": "acme",
  "companyName": "Acme",
  "period": "Mon 21 Sep - Fri 25 Sep 2026",
  "from": "2026-09-21",
  "to": "2026-09-25",
  "employees": 12,
  "totalHours": 421.5,
  "totalOvertime": 6.5,
  "recipients": ["client@example.com"],
  "sent": true
}
```

`sent: false` with a `skippedReason` means nothing was emailed — either no
recipients are configured, or nobody worked that week. Both are `200`, so a
scheduler will not retry them as failures. Delivery problems return `502`.

## Setting recipients

Admin → Company → edit a client → **Weekly report recipients**. Commas between
addresses. Leaving it empty switches that client's automation off.

On the main company there is a second field, **All-clients report recipients**,
used by `companyId=all`.

## Scheduling it

Any scheduler works — the endpoint holds no state. Run it once a week, on
Saturday, in the timezone your clients read.

### Cloudflare Cron Triggers

Add to `wrangler.jsonc` and handle the cron event in the worker, or simply have
the cron hit the URL.

```jsonc
"triggers": { "crons": ["0 22 * * SAT"] }
```

### n8n (matches the existing webhook setup)

A Schedule trigger → HTTP Request node per client:

- Method `POST`
- URL `https://station.savykids.com/api/weekly-report?companyId=acme`
- Header `x-admin-key: <ADMIN_API_KEY>`

Add one node per client, plus one with `companyId=all`. Run them in sequence so
each client's report is sent separately.

### cron on your own box

```bash
0 22 * * 6 curl -fsS -X POST \
  -H "x-admin-key: $ADMIN_API_KEY" \
  "https://station.savykids.com/api/weekly-report?companyId=acme"
```

## Before switching it on

Check a client with `dryRun` and read the totals back:

```bash
curl -fsS -H "x-admin-key: $ADMIN_API_KEY" \
  "https://station.savykids.com/api/weekly-report?companyId=acme&dryRun=true"
```

The figures come from the same builder as the Reports screen, so a dry run and
the screen for that week agree. If they do not, the report page is the one to
trust and the difference is a bug worth reporting.

## Notes

- The email is rendered and delivered by `/api/send-report`, the same path the
  Reports screen uses when an admin sends by hand.
- `ADMIN_API_KEY` currently lives in `wrangler.jsonc`. It grants report access,
  so move it to a Cloudflare secret (`wrangler secret put ADMIN_API_KEY`) rather
  than leaving it in the repo.
