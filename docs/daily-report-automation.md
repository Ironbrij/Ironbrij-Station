# Daily report automation

Emails a client their VAs' attendance for the day, as soon as every shift that
day has finished. One call covers every client that has switched it on.

It is separate from the weekly report and does not replace it: the weekly report
is the final figure for the week, and the daily one is the same report for one
day, sent while the day is fresh.

## Switching it on for a client

Admin → Company → edit a client → **Send the client** → **Daily attendance
report**. It is off until ticked, unlike the other client emails, because it
arrives every working day. It goes to the client's email addresses, the same
list as the weekly report. The client needs at least one address.

## The endpoint

```
POST https://station.savykids.com/api/daily-report
x-admin-key: <ADMIN_API_KEY>
```

`GET` works identically. Call it every 15 minutes; `n8n/daily-report.workflow.json`
does that.

| Parameter | Meaning |
| --- | --- |
| `companyId` | Only this client. Without it, every client that has the daily report on. `all` is refused: the report is per client. |
| `date` | `YYYY-MM-DD`. Replays one day instead of yesterday and today. Still waits for the shifts and still will not send a day twice. |
| `dryRun` | `true` says what would be sent and to whom, without emailing or recording. |
| `force` | `true` sends now, ignoring the wait, the expiry and the already-sent check. For a manual resend. |
| `graceMinutes` | How long after a shift ends the VA has to clock out. Default 15. |
| `maxWaitMinutes` | The longest a report is held for someone still clocked in. Default 180. |
| `recipients` | Comma-separated override. |

## When a day is ready

Each run looks at yesterday and today on the client's clock. Yesterday is there
because a shift that starts late in one day ends in the next, and is reported
for the day it started.

A day is sent once **all** of these are true:

1. Every VA due to work that day has passed the end of their last shift, plus the
   clock-out grace. VAs on leave, on a holiday or day off, inactive, or who have
   not accepted their invite are not waited for.
2. No one is still clocked in.
3. No shift that ended is missing its clock-out.

A VA who has not started has no row in the report yet, which is why the
schedules are checked as well as the punches.

If someone never clocks out, the report is held for `maxWaitMinutes` after the
last shift ends and then sent anyway. Their row says **Missing Clock-out (hours
not counted)** or **In Progress**, so the client is not told a figure that is not
there. Fix the punch on the Reports page and the weekly report will have it.

A day nobody worked, and nobody was absent, sends nothing. A day nobody is due to
work (weekend, holiday, everyone on leave) sends nothing and reads nothing.

A day older than 12 hours past its last possible send is dropped rather than
sent late. Replay it with `date` and `force` if you want it.

## It is sent once

The report is recorded in the report history under one id per client per day
(`daily-<client>-<date>`). The next run finds it and says `already sent`. This
needs the automation's login: set `AUTOMATION_EMAIL` and `AUTOMATION_PASSWORD`
(an admin account), as for the weekly report's history. **Without them the daily
report refuses to send**, because nothing could stop it repeating every 15
minutes. If the record cannot be read, it does not send either.

The history panel on the Reports page shows each one, sent by **Daily
automation**.

## The figures

The same builder as the Reports page, run for that single day at the moment of
sending, with any edits an admin saved for that day laid over it. Punches are
read live on every run; nothing is cached between them.

## Response

```json
{
  "ok": true,
  "now": "2026-09-10T17:20:00.000Z",
  "sent": 1,
  "reports": [
    {
      "companyId": "acme",
      "companyName": "Acme",
      "date": "2026-09-10",
      "period": "Thu 10 Sep 2026",
      "status": "sent",
      "employees": 4,
      "totalHours": 31.5,
      "totalOvertime": 0,
      "recipients": ["client@example.com"],
      "historySaved": true
    }
  ]
}
```

`status` is one of `sent`, `ready` (dry run), `waiting` (with `waitingFor` and
`sendAnywayAt`), `already sent`, `nothing to report`, `expired`, `no recipients`,
`needs automation login` and `failed`. A `failed` entry returns `502`.

## Cost of polling

A run reads companies, employees and the leave that could still matter, and one
history record per client and day. Punches and the rest are read only when a day
could be ready, so most runs are small.

## Notes

- The day follows each VA's own shift clock, as the Reports page does. A client far
  from their VAs' clock (a US client with VAs saved on Manila time) can see a day
  boundary that does not match theirs.
- Two runs at the same moment could both send. The scheduler runs one at a time;
  do not also trigger by hand while it is mid-run.
