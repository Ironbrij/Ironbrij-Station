# Employee invite email workflow

1. Import `invite-email.workflow.json` into n8n.
2. Open **Send Invite with Gmail** and connect the Gmail account that should send invitations.
3. Activate the workflow and copy its production webhook URL.
4. Set that URL as `N8N_INVITE_WEBHOOK_URL` in the Time Station deployment.
5. Set `APP_URL` to the public Time Station URL.

When an admin creates an employee, Time Station stores one invite token and sends that exact
activation link to n8n. If email delivery fails, the employee record remains saved and the admin can
copy the same activation link from the confirmation dialog.

## Attendance event endpoint

Time Station calls `/api/attendance-event` after every successful manual punch. Set
`N8N_ATTENDANCE_WEBHOOK_URL` to the production webhook for the workflow that should receive these
events.

The webhook payload has an `event` value of `punch_in` or `punch_out`, plus:

- `employee.id`, `employee.authUid`, `employee.name`, and `employee.email`
- department, role, country, timezone, and shift details
- `attendance.punchId`, type, status, local date, and exact event time
- a stable `idempotencyKey` based on the recorded punch

Use `employee.id` or `employee.email` in the workflow condition to target one specific employee.
