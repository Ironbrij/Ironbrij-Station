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
