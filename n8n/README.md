# Time Station - n8n Workflows

This directory contains pre-configured n8n workflow JSON files that can be directly imported into your n8n instance.

---

## 1. Employee Invite Email Workflow (`invite-email.workflow.json`)

### How to Host & Setup:
1. Open your n8n dashboard -> **Workflows** -> **Import from File**.
2. Select `invite-email.workflow.json`.
3. Open the **Send Invite with Gmail** node and connect your sending Gmail / SMTP credential.
4. Toggle the workflow to **Active**.
5. Copy the Webhook Production URL (e.g. `https://your-n8n-instance.com/webhook/time-station-employee-invite`).
6. Set `N8N_INVITE_WEBHOOK_URL` in your Time Station deployment environment variables.

---

## 2. SOD @Mentions Notification Workflow (`sod-mention-notification.workflow.json`)

### How to Host & Setup:
1. Open your n8n dashboard -> **Workflows** -> **Import from File**.
2. Select `sod-mention-notification.workflow.json`.
3. Open the **Send Gmail Notification** node and connect your sending Gmail / SMTP credential.
4. Toggle the workflow to **Active**.
5. Copy the Webhook Production URL (e.g. `https://your-n8n-instance.com/webhook/time-station-sod-mention`).
6. Set `N8N_SOD_MENTION_WEBHOOK_URL` in your Time Station deployment environment variables when enabling email notifications for @mentions.

---

## Expected Webhook Payload for SOD @Mentions:

```json
{
  "reportId": "emp_123_2026-08-07_sod",
  "reportType": "sod",
  "reportDate": "2026-08-07",
  "authorName": "Bevet Smith",
  "authorEmail": "bevet@company.com",
  "question": "Is there anything important the team should know?",
  "answer": "Hey @Engineering and @Alex, please check the deployment today.",
  "mentions": [
    {
      "id": "dept_eng",
      "type": "department",
      "name": "Engineering",
      "displayTag": "@Engineering"
    },
    {
      "id": "emp_456",
      "type": "person",
      "name": "Alex Johnson",
      "displayTag": "@Alex Johnson",
      "email": "alex@company.com"
    }
  ]
}
```
