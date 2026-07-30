# Employee invite email workflow

1. Import `invite-email.workflow.json` into n8n.
2. Open **Send Invite with Gmail** and connect the Gmail account that should send invitations.
3. Activate the workflow and copy its production webhook URL.
4. Set that URL as `N8N_INVITE_WEBHOOK_URL` in the Time Station deployment.
5. Set `APP_URL` to the public Time Station URL.

When an admin creates an employee, Time Station stores one invite token and sends that exact
activation link to n8n. If email delivery fails, the employee record remains saved and the admin can
copy the same activation link from the confirmation dialog.
