# SavyTimes - n8n Workflows

This directory contains pre-configured n8n workflow JSON files that can be directly imported into your n8n instance.

---

## 1. Employee Invite Email Workflow (`invite-email.workflow.json`)

### How to Host & Setup:

1. Open your n8n dashboard -> **Workflows** -> **Import from File**.
2. Select `invite-email.workflow.json`.
3. Open the **Send Invite with Gmail** node and connect your sending Gmail / SMTP credential.
4. Toggle the workflow to **Active**.
5. Copy the Webhook Production URL (e.g. `https://your-n8n-instance.com/webhook/time-station-employee-invite`).
6. Set `N8N_INVITE_WEBHOOK_URL` in your SavyTimes deployment environment variables.

---

## 2. SOD/EOD, Help & Feedback Email Workflow (`sod-mention-notification.workflow.json`)

### How to Host & Setup:

1. Open your n8n dashboard -> **Workflows** -> **Import from File**.
2. Select `sod-mention-notification.workflow.json`.
3. Open the **Send Gmail Notification** node and connect your sending Gmail credential.
4. Toggle the workflow to **Active**.
5. Copy the Webhook Production URL (e.g. `https://your-n8n-instance.com/webhook/time-station-sod-mention`).
6. Set `N8N_SOD_MENTION_WEBHOOK_URL` in the SavyTimes production environment.

When updating an existing production workflow, replace the old **Loop Over Items** node with the
included **Split Recipients** node. The old node does not split `body.mentions`, so the Gmail node
receives no recipient address. Keep the existing Gmail credential connected after importing.

---

## Expected Webhook Payload

```json
{
  "reportId": "emp_123_2026-08-07_sod",
  "reportType": "sod",
  "reportDate": "2026-08-07",
  "authorName": "Bevet Smith",
  "authorEmail": "bevet@company.com",
  "answer": "Hey @Engineering and @Alex, please check the deployment today.",
  "mentions": [
    {
      "email": "engineer@company.com",
      "recipientEmail": "engineer@company.com",
      "name": "Engineer",
      "targetName": "Engineering",
      "targetType": "department",
      "subject": "Mentioned in SOD Report by Bevet Smith (2026-08-07)",
      "html": "<p>Rendered email content</p>"
    },
    {
      "email": "alex@company.com",
      "recipientEmail": "alex@company.com",
      "name": "Alex Johnson",
      "targetName": "Alex Johnson",
      "targetType": "person",
      "subject": "Mentioned in SOD Report by Bevet Smith (2026-08-07)",
      "html": "<p>Rendered email content</p>"
    }
  ]
}
```

---

## 3. Punch-out Reminder Email (`punch-out-reminder.workflow.json`)

1. Import `punch-out-reminder.workflow.json` into n8n.
2. Connect the Gmail credential on **Send Punch Out Reminder**.
3. Activate the workflow.
4. Set `N8N_PUNCH_OUT_REMINDER_WEBHOOK_URL` to its production webhook URL.

The app claims one `attendanceReminders` document per open attendance session before calling this
workflow. That idempotency record prevents the once-per-minute check from sending the same reminder
twice.

---

## 4. Attendance Report Email (`report-email.workflow.json`)

Delivers every attendance report the app sends, both the **Send** button on the
Reports screen and the weekly automation below. Without it, `/api/send-report`
has nowhere to post and reports are never delivered.

1. Import `report-email.workflow.json` into n8n.
2. Connect the Gmail credential on **Send Report with Gmail**.
3. Activate the workflow.
4. Set `N8N_REPORT_WEBHOOK_URL` in the SavyTimes deployment to its production
   webhook URL, e.g. `https://your-n8n-instance.com/webhook/time-station-report-email`.

---

## 5. Weekly Monday-to-Friday Report (`weekly-report.workflow.json`)

Sends each client their own Monday-to-Friday report once a week, plus one
combined report across every client. Import `report-email.workflow.json` first —
this workflow builds the reports, that one delivers them.

### Setup

1. Import `weekly-report.workflow.json` into n8n.
2. Open the **Config** node, the only node you edit:
   - `baseUrl` — your SavyTimes URL, e.g. `https://station.savykids.com`
   - `adminKey` — must match `ADMIN_API_KEY` in the SavyTimes deployment
   - `weeksAgo` — leave at `0`
3. Open **Email The Run Summary**, connect the Gmail credential and set your own
   address. Delete the node if you do not want a summary.
4. Check the schedule on **Every Saturday 18:00** and the workflow timezone in
   Settings. Both default to Saturday evening, Australia/Sydney.
5. Run it once by hand and read the summary before activating.

### Who gets what

Recipients live in the app, not in this workflow: **Admin → Company → edit a
client → Weekly report recipients**. The main company also has an **All-clients
report recipients** field for the combined report.

`List Clients To Send` asks the app which clients have recipients configured, so
adding or removing a client never means touching this workflow. A client with no
recipients is simply not sent.

### How it behaves

- One client at a time, two seconds apart, so a slow client cannot stall the run.
- A client that fails does not stop the others; it is reported in the summary.
- A client with no attendance that week is skipped rather than sent an empty
  report, and the summary says so.
- The week is chosen by the app from the run time, so a Saturday run always
  reports the Monday-to-Friday that just finished. Nothing in n8n computes dates.

### Replaying a missed week

Set `weeksAgo` in the **Config** node to `1` and run once by hand, then set it
back to `0`.

See `docs/weekly-report-automation.md` for the endpoint itself, including the
`dryRun` option for checking a client's figures before switching the schedule on.
