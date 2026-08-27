import { createFileRoute } from "@tanstack/react-router";
import { resolveAppUrl } from "@/lib/app-url";

function getFirestoreConfig() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "runner-man-634be";
  const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY";
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  return { projectId, apiKey, baseUrl };
}

// Helper: Convert JS object to Firestore Fields JSON
function toFirestoreFields(obj: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value === null) {
      fields[key] = { nullValue: null };
    } else if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        fields[key] = { integerValue: String(value) };
      } else {
        fields[key] = { doubleValue: value };
      }
    } else if (typeof value === "string") {
      fields[key] = { stringValue: value };
    } else if (Array.isArray(value)) {
      fields[key] = {
        arrayValue: {
          values: value.map((item) => {
            if (typeof item === "string") return { stringValue: item };
            if (typeof item === "number") return { doubleValue: item };
            if (typeof item === "boolean") return { booleanValue: item };
            if (typeof item === "object")
              return { mapValue: { fields: toFirestoreFields(item as Record<string, unknown>) } };
            return { stringValue: String(item) };
          }),
        },
      };
    } else if (typeof value === "object") {
      fields[key] = { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
    }
  }
  return fields;
}

// Helper: Convert Firestore Fields to plain JS object
function fromFirestoreFields(fields: Record<string, any>) {
  if (!fields) return {};
  const obj: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if ("stringValue" in value) obj[key] = value.stringValue;
    else if ("integerValue" in value) obj[key] = parseInt(value.integerValue, 10);
    else if ("doubleValue" in value) obj[key] = value.doubleValue;
    else if ("booleanValue" in value) obj[key] = value.booleanValue;
    else if ("nullValue" in value) obj[key] = null;
    else if ("arrayValue" in value) {
      obj[key] = (value.arrayValue.values || []).map((v: any) => {
        if ("stringValue" in v) return v.stringValue;
        if ("integerValue" in v) return parseInt(v.integerValue, 10);
        if ("doubleValue" in v) return v.doubleValue;
        if ("booleanValue" in v) return v.booleanValue;
        if ("mapValue" in v) return fromFirestoreFields(v.mapValue.fields);
        return v;
      });
    } else if ("mapValue" in value) {
      obj[key] = fromFirestoreFields(value.mapValue.fields);
    }
  }
  return obj;
}

// Validate Admin Token
async function validateAdminToken(token: string): Promise<{ ok: boolean; adminEmail?: string }> {
  if (!token || token.length < 20) return { ok: false };

  // Master Admin Key
  const masterKey =
    process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
  if (token === masterKey) {
    return { ok: true, adminEmail: "pabibek9@gmail.com" };
  }

  const { baseUrl, apiKey } = getFirestoreConfig();

  // Check if token exists in Firestore adminApiTokens
  const tokenDocRes = await fetch(
    `${baseUrl}/adminApiTokens/${encodeURIComponent(token)}?key=${encodeURIComponent(apiKey)}`,
  );
  if (tokenDocRes.ok) {
    const data = await tokenDocRes.json();
    const fields = fromFirestoreFields(data.fields);
    if (fields.active !== false) {
      return { ok: true, adminEmail: fields.adminEmail || "admin@savytimes.com" };
    }
  }

  // Fallback: check Firebase ID Token
  const identityResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    },
  );
  if (identityResponse.ok) {
    const identityPayload = (await identityResponse.json()) as {
      users?: Array<{ email?: string }>;
    };
    return { ok: true, adminEmail: identityPayload.users?.[0]?.email };
  }

  return { ok: false };
}

// Helper: Resolve employee by ID, Email, or Partial Name
async function resolveEmployee(
  identifier: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; name?: string; email?: string; [key: string]: any } | null> {
  if (!identifier) return null;
  const clean = identifier.trim();

  // 1. Direct ID lookup
  try {
    const directRes = await fetch(
      `${baseUrl}/employees/${encodeURIComponent(clean)}?key=${encodeURIComponent(apiKey)}`,
    );
    if (directRes.ok) {
      const doc = await directRes.json();
      return { id: clean, ...fromFirestoreFields(doc.fields) };
    }
  } catch {}

  // 2. Fetch employee list and match by email or name
  try {
    const listRes = await fetch(
      `${baseUrl}/employees?pageSize=200&key=${encodeURIComponent(apiKey)}`,
    );
    if (listRes.ok) {
      const data = await listRes.json();
      const list = (data.documents || []).map((doc: any) => ({
        id: doc.name.split("/").pop(),
        ...fromFirestoreFields(doc.fields),
      }));

      // Exact email
      const byEmail = list.find((e: any) => e.email?.toLowerCase() === clean.toLowerCase());
      if (byEmail) return byEmail;

      // Exact name
      const byExactName = list.find((e: any) => e.name?.toLowerCase() === clean.toLowerCase());
      if (byExactName) return byExactName;

      // Partial name (e.g. "Rose" matches "Rose Miller" or "bibek" matches "Bibek")
      const byPartial = list.find((e: any) =>
        e.name?.toLowerCase().includes(clean.toLowerCase()),
      );
      if (byPartial) return byPartial;
    }
  } catch {}

  return null;
}

// OpenAPI 3.1.0 schema for ChatGPT Custom GPT Actions
function getOpenApiSchema(appUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "SavyTimes Admin API",
      description:
        "Full admin API for SavyTimes (https://station.savykids.com). Manage employees, create companies, send invites, fix punch-outs, approve leaves, manage departments, and post notices.",
      version: "1.3.0",
    },
    servers: [{ url: appUrl }],
    paths: {
      "/api/mcp-action": {
        post: {
          summary: "Execute SavyTimes Admin Tool Action",
          description: "Execute administrative actions across all modules of SavyTimes.",
          operationId: "executeAdminAction",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AdminActionRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Action executed successfully",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/AdminActionResponse",
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized - Missing or invalid Admin API Token",
            },
          },
        },
      },
    },
    components: {
      schemas: {
        AdminActionRequest: {
          type: "object",
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [
                "get_company_summary",
                "get_live_attendance",
                "list_employees",
                "add_employee",
                "send_employee_invite",
                "update_employee",
                "delete_employee",
                "create_company",
                "update_company",
                "list_companies",
                "create_department",
                "list_departments",
                "add_or_fix_punch",
                "list_punches",
                "list_leaves",
                "decide_leave",
                "list_overtime",
                "decide_overtime",
                "list_daily_reports",
                "create_notice",
                "list_notices",
              ],
              description: "The admin tool action to execute.",
            },
            name: {
              type: "string",
              description:
                "Name of the company, employee, or department (e.g. 'Ironbrij', 'Alex Smith', 'Accounts')",
            },
            companyName: {
              type: "string",
              description: "Company name when creating or updating a company",
            },
            companyId: {
              type: "string",
              description: "Company ID (defaults to 'default')",
            },
            code: {
              type: "string",
              description: "Short company or department identifier code (e.g. 'IRON')",
            },
            timezone: {
              type: "string",
              description: "Primary timezone (e.g. 'Australia/Sydney', 'Asia/Kathmandu', 'Asia/Manila')",
            },
            defaultShiftHours: {
              type: "number",
              description: "Default daily required shift hours (default: 8)",
            },
            workingDays: {
              type: "array",
              items: { type: "number" },
              description: "Working days where 0=Sun, 1=Mon..6=Sat (e.g. [1, 2, 3, 4, 5])",
            },
            lateGraceMinutes: {
              type: "number",
              description: "Grace minutes allowed before lateness starts (default: 5)",
            },
            punchOutGraceMinutes: {
              type: "number",
              description: "Grace period in minutes after shift end before auto punch-out (default: 30)",
            },
            punchOutReminderMinutes: {
              type: "number",
              description: "Minutes before shift end to send reminder email (default: 20)",
            },
            breakAllowanceMinutes: {
              type: "number",
              description: "Break duration in minutes (default: 30, or 0 for N/A / no break)",
            },
            maxDailyBreaks: {
              type: "number",
              description: "Maximum breaks allowed per shift (default: 1, or 0 for N/A / no breaks)",
            },
            departments: {
              type: "array",
              items: { type: "string" },
              description:
                "List of initial department names to create under the company (e.g. ['Operations', 'Accounts'])",
            },
            email: {
              type: "string",
              description: "Email address for employee or client contact",
            },
            jobTitle: {
              type: "string",
              description: "Job title (e.g. 'Virtual Assistant', 'Software Engineer')",
            },
            shiftStartTime: {
              type: "string",
              description: "Shift start time in HH:MM format (e.g. '09:00')",
            },
            shiftEndTime: {
              type: "string",
              description: "Shift end time in HH:MM format (e.g. '17:00')",
            },
            shiftTimezone: {
              type: "string",
              description: "Shift timezone for employee",
            },
            country: {
              type: "string",
              enum: ["NP", "AU", "PH"],
              description: "Country code",
            },
            type: {
              type: "string",
              enum: ["in", "out"],
              description: "Punch type for add_or_fix_punch",
            },
            timestampISO: {
              type: "string",
              description: "ISO 8601 timestamp (e.g. '2026-08-27T09:00:00Z')",
            },
            leaveId: {
              type: "string",
              description: "Leave request document ID",
            },
            decision: {
              type: "string",
              enum: ["approved", "rejected"],
              description: "Decision for leave or overtime approval",
            },
            paymentStatus: {
              type: "string",
              enum: ["paid", "unpaid"],
              description: "Payment status for approved leave",
            },
            requestId: {
              type: "string",
              description: "Overtime request document ID",
            },
            reportType: {
              type: "string",
              enum: ["sod", "eod"],
              description: "Report type for list_daily_reports",
            },
            title: {
              type: "string",
              description: "Notice title",
            },
            content: {
              type: "string",
              description: "Notice message content",
            },
            priority: {
              type: "string",
              enum: ["normal", "important", "urgent"],
              description: "Notice priority",
            },
            params: {
              type: "object",
              description:
                "Optional nested parameters object. You may pass parameters either nested here or as top-level fields on the request.",
            },
          },
        },
        AdminActionResponse: {
          type: "object",
          properties: {
            ok: {
              type: "boolean",
            },
            result: {
              type: "object",
            },
          },
        },
      },
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "SavyTimes Admin API Token (st_adm_...)",
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
  };
}

export const Route = createFileRoute("/api/mcp-action")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const appUrl = resolveAppUrl(request.url);

        // Return OpenAPI Schema for ChatGPT
        if (url.searchParams.get("openapi") === "true") {
          return Response.json(getOpenApiSchema(appUrl), {
            headers: {
              "access-control-allow-origin": "*",
              "content-type": "application/json",
            },
          });
        }

        return Response.json({
          ok: true,
          service: "SavyTimes Admin AI / MCP Action Endpoint",
          openapiUrl: `${appUrl}/api/mcp-action?openapi=true`,
        });
      },
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") || "";
        const token = authorization.startsWith("Bearer ")
          ? authorization.slice(7).trim()
          : authorization.trim();

        if (!token) {
          return Response.json(
            { ok: false, error: "Unauthorized: Missing Admin Token in Authorization header" },
            { status: 401 },
          );
        }

        const authResult = await validateAdminToken(token);
        if (!authResult.ok) {
          return Response.json(
            { ok: false, error: "Unauthorized: Invalid or revoked Admin API Token" },
            { status: 401 },
          );
        }

        let body: Record<string, any> = {};
        try {
          body = (await request.json()) || {};
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        const action = body.action || body.name || body.tool;
        const rawParams = body.params && typeof body.params === "object" ? body.params : {};
        const { action: _a, params: _p, ...topLevelFields } = body;
        const params: Record<string, any> = {
          ...topLevelFields,
          ...rawParams,
        };

        const { baseUrl, apiKey } = getFirestoreConfig();

        try {
          // 1. ADD EMPLOYEE (with automatic invite token and email dispatch)
          if (action === "add_employee") {
            const empName = (params.name || params.employeeName || "").trim();
            const empEmail = (params.email || params.employeeEmail || "").trim().toLowerCase();

            if (!empName || !empEmail) {
              return Response.json(
                {
                  ok: false,
                  error: "Missing required fields: Both 'name' and 'email' are required to create an employee.",
                },
                { status: 400 },
              );
            }

            const docId = `emp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const inviteToken = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const companyId = params.companyId || "default";

            const employeeData = {
              name: empName,
              email: empEmail,
              companyId,
              companyIds: [companyId],
              jobTitle: params.jobTitle || params.role || "Virtual Assistant",
              deptId: params.deptId || params.department || "",
              country: params.country || "NP",
              state: params.state || "N/A",
              status: "active",
              inviteStatus: "pending",
              inviteToken,
              shiftStartTime: params.shiftStartTime || "09:00",
              shiftEndTime: params.shiftEndTime || "17:00",
              shiftTimezone: params.shiftTimezone || "Asia/Kathmandu",
              isMultipleShift: Boolean(params.isMultipleShift),
              shifts: params.shifts || [
                {
                  startTime: params.shiftStartTime || "09:00",
                  endTime: params.shiftEndTime || "17:00",
                },
              ],
              createdAt: new Date().toISOString(),
            };

            // Save employee document
            const res = await fetch(
              `${baseUrl}/employees/${docId}?key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(employeeData) }),
              },
            );
            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error?.message || "Failed to add employee");
            }

            // Save invite document
            const inviteData = {
              token: inviteToken,
              employeeId: docId,
              email: params.email,
              name: params.name,
              companyId,
              role: employeeData.jobTitle,
              status: "pending",
              createdAt: new Date().toISOString(),
            };
            await fetch(`${baseUrl}/invites/${inviteToken}?key=${encodeURIComponent(apiKey)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fields: toFirestoreFields(inviteData) }),
            });

            // Dispatch invite email if webhook exists
            const appUrl = resolveAppUrl();
            const inviteUrl = `${appUrl}/invite/${inviteToken}`;
            const webhookUrl =
              process.env.N8N_INVITE_WEBHOOK_URL ||
              "https://vmi3182726.contaboserver.net/webhook/time-station-invite";
            if (params.sendInviteEmail !== false) {
              try {
                await fetch(webhookUrl, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    employeeId: docId,
                    employeeName: params.name,
                    employeeEmail: params.email,
                    inviteToken,
                    inviteUrl,
                    companyName: companyId,
                    jobTitle: employeeData.jobTitle,
                    shiftStartTime: employeeData.shiftStartTime,
                    shiftEndTime: employeeData.shiftEndTime,
                  }),
                });
              } catch {
                // non-blocking
              }
            }

            return Response.json({
              ok: true,
              result: {
                message: `Employee '${params.name}' successfully added and invite generated!`,
                employeeId: docId,
                inviteUrl,
                inviteToken,
                employee: employeeData,
              },
            });
          }

          // 2. SEND / RESEND EMPLOYEE INVITE
          if (action === "send_employee_invite") {
            let targetId = params.id || params.employeeId;
            let targetEmail = params.email;
            let targetName = params.name;

            const listRes = await fetch(
              `${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`,
            );
            const listData = await listRes.json();
            const matchedDoc = (listData.documents || []).find((doc: any) => {
              const id = doc.name.split("/").pop();
              const fields = fromFirestoreFields(doc.fields);
              if (targetId && id === targetId) return true;
              if (targetEmail && fields.email?.toLowerCase() === targetEmail.toLowerCase())
                return true;
              if (targetName && fields.name?.toLowerCase() === targetName.toLowerCase())
                return true;
              return false;
            });

            if (!matchedDoc) {
              return Response.json({ ok: false, error: "Employee not found." }, { status: 404 });
            }

            const empId = matchedDoc.name.split("/").pop();
            const empFields = fromFirestoreFields(matchedDoc.fields);
            const inviteToken = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const appUrl = resolveAppUrl();
            const inviteUrl = `${appUrl}/invite/${inviteToken}`;

            // Save invite doc
            await fetch(`${baseUrl}/invites/${inviteToken}?key=${encodeURIComponent(apiKey)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                fields: toFirestoreFields({
                  token: inviteToken,
                  employeeId: empId,
                  email: empFields.email,
                  name: empFields.name,
                  companyId: empFields.companyId || "default",
                  role: empFields.jobTitle || "Virtual Assistant",
                  status: "pending",
                  createdAt: new Date().toISOString(),
                }),
              }),
            });

            // Update employee with invite token
            await fetch(
              `${baseUrl}/employees/${empId}?updateMask.fieldPaths=inviteToken&updateMask.fieldPaths=inviteStatus&key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  fields: toFirestoreFields({ inviteToken, inviteStatus: "pending" }),
                }),
              },
            );

            // Dispatch email webhook
            const webhookUrl = process.env.N8N_INVITE_WEBHOOK_URL;
            if (webhookUrl) {
              try {
                await fetch(webhookUrl, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    employeeId: empId,
                    employeeName: empFields.name,
                    employeeEmail: empFields.email,
                    inviteToken,
                    inviteUrl,
                    companyName: empFields.companyId || "default",
                    jobTitle: empFields.jobTitle,
                  }),
                });
              } catch {
                // non-blocking
              }
            }

            return Response.json({
              ok: true,
              result: {
                message: `Invitation generated and dispatched for ${empFields.name} (${empFields.email})!`,
                employeeId: empId,
                inviteUrl,
                inviteToken,
              },
            });
          }

          // 3. DELETE / DEACTIVATE EMPLOYEE
          if (action === "delete_employee") {
            let targetId = params.id || params.employeeId;
            if (!targetId && params.email) {
              const listRes = await fetch(
                `${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`,
              );
              const listData = await listRes.json();
              const matchedDoc = (listData.documents || []).find((doc: any) => {
                const fields = fromFirestoreFields(doc.fields);
                return fields.email?.toLowerCase() === params.email.toLowerCase();
              });
              if (matchedDoc) targetId = matchedDoc.name.split("/").pop();
            }

            if (!targetId) {
              return Response.json({ ok: false, error: "Employee not found." }, { status: 404 });
            }

            await fetch(`${baseUrl}/employees/${targetId}?key=${encodeURIComponent(apiKey)}`, {
              method: "DELETE",
            });

            return Response.json({
              ok: true,
              result: { message: `Employee '${targetId}' removed from SavyTimes.` },
            });
          }

          // 4. CREATE COMPANY
          if (action === "create_company") {
            const companyName = (
              params.name ||
              params.companyName ||
              params.company_name ||
              params.company ||
              params.title ||
              params.clientName ||
              params.client_name ||
              ""
            ).trim();
            if (!companyName) {
              return Response.json(
                {
                  ok: false,
                  error:
                    "Missing required field: Company name is strictly required. Please provide 'name' or 'companyName'. (Received keys: " +
                    Object.keys(params).join(", ") +
                    ")",
                },
                { status: 400 },
              );
            }

            const docId = `comp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

            // Parse working days: supports [1, 2, 3, 4, 5] or ["Monday", "Tuesday", ...]
            let workingDays = [1, 2, 3, 4, 5];
            if (Array.isArray(params.workingDays)) {
              workingDays = params.workingDays.map((d: any) => {
                if (typeof d === "number") return d;
                const lower = String(d).toLowerCase().slice(0, 3);
                const map: Record<string, number> = {
                  sun: 0,
                  mon: 1,
                  tue: 2,
                  wed: 3,
                  thu: 4,
                  fri: 5,
                  sat: 6,
                };
                return map[lower] !== undefined ? map[lower] : 1;
              });
            }

            const companyData: Record<string, any> = {
              name: companyName,
              code: (params.code || companyName.slice(0, 4)).toUpperCase(),
              timezone: params.timezone || "Australia/Sydney",
              defaultShiftHours:
                typeof params.defaultShiftHours === "number" ? params.defaultShiftHours : 8,
              workingDays,
              lateGraceMinutes:
                typeof params.lateGraceMinutes === "number" ? params.lateGraceMinutes : 5,
              punchOutGraceMinutes:
                typeof params.punchOutGraceMinutes === "number"
                  ? params.punchOutGraceMinutes
                  : 30,
              punchOutReminderMinutes:
                typeof params.punchOutReminderMinutes === "number"
                  ? params.punchOutReminderMinutes
                  : 20,
              breakAllowanceMinutes:
                params.breakAllowanceMinutes !== undefined
                  ? Number(params.breakAllowanceMinutes)
                  : 30,
              maxDailyBreaks:
                params.maxDailyBreaks !== undefined ? Number(params.maxDailyBreaks) : 1,
              holidays: Array.isArray(params.holidays) ? params.holidays : [],
              holidayAssignments: Array.isArray(params.holidayAssignments)
                ? params.holidayAssignments
                : [],
              clientEmail: params.clientEmail || params.email || "",
              ownerName: params.ownerName || params.clientName || "",
              logoUrl: params.logoUrl || "",
              notes: params.notes || "",
              createdAt: new Date().toISOString(),
            };

            const res = await fetch(
              `${baseUrl}/companies/${docId}?key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(companyData) }),
              },
            );
            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error?.message || "Failed to create company");
            }

            // Auto-create initial departments if provided
            const createdDepartments: Array<{ id: string; name: string }> = [];
            if (Array.isArray(params.departments)) {
              for (const dept of params.departments) {
                const deptName = typeof dept === "string" ? dept.trim() : dept?.name?.trim();
                if (deptName) {
                  const deptDocId = `dept_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                  const deptData = {
                    companyId: docId,
                    name: deptName,
                    state: typeof dept === "object" && dept.state ? dept.state : "N/A",
                    createdAt: new Date().toISOString(),
                  };
                  await fetch(
                    `${baseUrl}/departments/${deptDocId}?key=${encodeURIComponent(apiKey)}`,
                    {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ fields: toFirestoreFields(deptData) }),
                    },
                  );
                  createdDepartments.push({ id: deptDocId, name: deptName });
                }
              }
            }

            return Response.json({
              ok: true,
              result: {
                message: `Client company '${companyName}' created successfully with ID: ${docId}`,
                companyId: docId,
                company: companyData,
                departments: createdDepartments,
              },
            });
          }

          // 5. UPDATE COMPANY
          if (action === "update_company") {
            let targetId = params.id || params.companyId;
            if (!targetId && (params.name || params.companyName)) {
              const searchName = (params.name || params.companyName).trim().toLowerCase();
              const listRes = await fetch(
                `${baseUrl}/companies?pageSize=100&key=${encodeURIComponent(apiKey)}`,
              );
              const listData = await listRes.json();
              const matchedDoc = (listData.documents || []).find((doc: any) => {
                const fields = fromFirestoreFields(doc.fields);
                return (
                  (fields.name || "").toLowerCase() === searchName ||
                  (fields.code || "").toLowerCase() === searchName
                );
              });
              if (matchedDoc) targetId = matchedDoc.name.split("/").pop();
            }

            if (!targetId) {
              return Response.json(
                {
                  ok: false,
                  error:
                    "Company not found. Please provide a valid 'id', 'companyId', or 'name'.",
                },
                { status: 404 },
              );
            }

            const fieldsToUpdate: Record<string, any> = {};
            if (params.name) fieldsToUpdate.name = params.name.trim();
            if (params.code) fieldsToUpdate.code = params.code.trim().toUpperCase();
            if (params.timezone) fieldsToUpdate.timezone = params.timezone;
            if (params.defaultShiftHours !== undefined)
              fieldsToUpdate.defaultShiftHours = Number(params.defaultShiftHours);
            if (params.workingDays !== undefined && Array.isArray(params.workingDays)) {
              fieldsToUpdate.workingDays = params.workingDays;
            }
            if (params.lateGraceMinutes !== undefined)
              fieldsToUpdate.lateGraceMinutes = Number(params.lateGraceMinutes);
            if (params.punchOutGraceMinutes !== undefined)
              fieldsToUpdate.punchOutGraceMinutes = Number(params.punchOutGraceMinutes);
            if (params.punchOutReminderMinutes !== undefined)
              fieldsToUpdate.punchOutReminderMinutes = Number(params.punchOutReminderMinutes);
            if (params.breakAllowanceMinutes !== undefined)
              fieldsToUpdate.breakAllowanceMinutes = Number(params.breakAllowanceMinutes);
            if (params.maxDailyBreaks !== undefined)
              fieldsToUpdate.maxDailyBreaks = Number(params.maxDailyBreaks);
            if (params.holidays !== undefined && Array.isArray(params.holidays))
              fieldsToUpdate.holidays = params.holidays;
            if (params.holidayAssignments !== undefined)
              fieldsToUpdate.holidayAssignments = params.holidayAssignments;
            if (params.clientEmail !== undefined) fieldsToUpdate.clientEmail = params.clientEmail;
            if (params.ownerName !== undefined) fieldsToUpdate.ownerName = params.ownerName;
            if (params.logoUrl !== undefined) fieldsToUpdate.logoUrl = params.logoUrl;
            if (params.notes !== undefined) fieldsToUpdate.notes = params.notes;

            const updateMask = Object.keys(fieldsToUpdate)
              .map((k) => `updateMask.fieldPaths=${k}`)
              .join("&");

            const res = await fetch(
              `${baseUrl}/companies/${targetId}?${updateMask}&key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
              },
            );
            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error?.message || "Failed to update company");
            }

            return Response.json({
              ok: true,
              result: {
                message: `Company '${targetId}' updated successfully.`,
                companyId: targetId,
                updatedFields: fieldsToUpdate,
              },
            });
          }

          // 6. CREATE DEPARTMENT
          if (action === "create_department") {
            const docId = `dept_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const deptData = {
              name: params.name,
              code: params.code || params.name.slice(0, 3).toUpperCase(),
              companyId: params.companyId || "default",
              description: params.description || "",
              createdAt: new Date().toISOString(),
            };
            const res = await fetch(
              `${baseUrl}/departments/${docId}?key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(deptData) }),
              },
            );
            if (!res.ok) throw new Error("Failed to create department");

            return Response.json({
              ok: true,
              result: {
                message: `Department '${params.name}' created with ID: ${docId}`,
                departmentId: docId,
                department: deptData,
              },
            });
          }

          // 7. LIST DEPARTMENTS
          if (action === "list_departments") {
            const res = await fetch(`${baseUrl}/departments?key=${encodeURIComponent(apiKey)}`);
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => ({
              id: doc.name.split("/").pop(),
              ...fromFirestoreFields(doc.fields),
            }));
            const filtered = params.companyId
              ? list.filter((d: any) => d.companyId === params.companyId)
              : list;
            return Response.json({
              ok: true,
              result: { count: filtered.length, departments: filtered },
            });
          }

          // 8. CREATE NOTICE / ANNOUNCEMENT
          if (action === "create_notice") {
            const docId = `notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const noticeData = {
              title: params.title,
              content: params.content,
              companyId: params.companyId || "default",
              priority: params.priority || "normal",
              targetDepartments: params.targetDepartments || [],
              createdBy: authResult.adminEmail || "Admin",
              createdAt: new Date().toISOString(),
            };
            const res = await fetch(
              `${baseUrl}/notices/${docId}?key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(noticeData) }),
              },
            );
            if (!res.ok) throw new Error("Failed to create notice");
            return Response.json({
              ok: true,
              result: { message: `Notice '${params.title}' posted successfully.`, noticeId: docId },
            });
          }

          // 9. LIST NOTICES
          if (action === "list_notices") {
            const res = await fetch(`${baseUrl}/notices?key=${encodeURIComponent(apiKey)}`);
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => ({
              id: doc.name.split("/").pop(),
              ...fromFirestoreFields(doc.fields),
            }));
            return Response.json({ ok: true, result: { count: list.length, notices: list } });
          }

          // 2. LIST EMPLOYEES
          if (action === "list_employees") {
            const res = await fetch(
              `${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`,
            );
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => {
              const id = doc.name.split("/").pop();
              return { id, ...fromFirestoreFields(doc.fields) };
            });
            const filtered = params.companyId
              ? list.filter(
                  (e: any) =>
                    e.companyId === params.companyId || e.companyIds?.includes(params.companyId),
                )
              : list;
            return Response.json({
              ok: true,
              result: { count: filtered.length, employees: filtered },
            });
          }

          // 3. UPDATE EMPLOYEE
          if (action === "update_employee") {
            let targetId = params.id;
            let targetEmail = params.email;
            let targetName = params.name;

            // If ID is missing, search by email or name
            if (!targetId) {
              const listRes = await fetch(
                `${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`,
              );
              if (listRes.ok) {
                const listData = await listRes.json();
                const matchedDoc = (listData.documents || []).find((doc: any) => {
                  const fields = fromFirestoreFields(doc.fields);
                  if (targetEmail && fields.email?.toLowerCase() === targetEmail.toLowerCase())
                    return true;
                  if (targetName && fields.name?.toLowerCase() === targetName.toLowerCase())
                    return true;
                  return false;
                });
                if (matchedDoc) {
                  targetId = matchedDoc.name.split("/").pop();
                }
              }
            }

            if (!targetId) {
              return Response.json(
                {
                  ok: false,
                  error: "Employee not found. Please provide employee ID or valid email address.",
                },
                { status: 404 },
              );
            }

            // Extract fields to update
            const fieldsToUpdate: Record<string, any> = {};
            if (params.name) fieldsToUpdate.name = params.name;
            if (params.email) fieldsToUpdate.email = params.email;
            if (params.jobTitle || params.role)
              fieldsToUpdate.jobTitle = params.jobTitle || params.role;
            if (params.status) fieldsToUpdate.status = params.status;
            if (params.deptId || params.department)
              fieldsToUpdate.deptId = params.deptId || params.department;
            if (params.companyId) {
              fieldsToUpdate.companyId = params.companyId;
              fieldsToUpdate.companyIds = [params.companyId];
            }
            if (params.shiftStartTime) fieldsToUpdate.shiftStartTime = params.shiftStartTime;
            if (params.shiftEndTime) fieldsToUpdate.shiftEndTime = params.shiftEndTime;
            if (params.shiftTimezone) fieldsToUpdate.shiftTimezone = params.shiftTimezone;

            const updateMask = Object.keys(fieldsToUpdate)
              .map((k) => `updateMask.fieldPaths=${k}`)
              .join("&");

            const patchUrl = updateMask
              ? `${baseUrl}/employees/${targetId}?${updateMask}&key=${encodeURIComponent(apiKey)}`
              : `${baseUrl}/employees/${targetId}?key=${encodeURIComponent(apiKey)}`;

            const res = await fetch(patchUrl, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
            });

            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error?.message || "Failed to update employee");
            }

            const updatedDoc = await res.json();
            const updatedFields = fromFirestoreFields(updatedDoc.fields);

            return Response.json({
              ok: true,
              result: {
                message: `Employee '${updatedFields.name || targetId}' updated successfully.`,
                employeeId: targetId,
                updatedFields: fieldsToUpdate,
                employee: { id: targetId, ...updatedFields },
              },
            });
          }

          // 4. LIST COMPANIES
          if (action === "list_companies") {
            const res = await fetch(`${baseUrl}/companies?key=${encodeURIComponent(apiKey)}`);
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => {
              const id = doc.name.split("/").pop();
              return { id, ...fromFirestoreFields(doc.fields) };
            });
            return Response.json({ ok: true, result: { count: list.length, companies: list } });
          }

          // 5. ADD OR FIX PUNCH
          if (action === "add_or_fix_punch") {
            const docId = `punch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            let empId = params.employeeId || "";
            let empName = params.employeeName || params.name || "";

            const targetEmp = await resolveEmployee(empId || empName, baseUrl, apiKey);
            if (targetEmp) {
              empId = targetEmp.id;
              empName = targetEmp.name || empName;
            }

            const timestampISO = params.timestampISO || new Date().toISOString();
            const punchData = {
              employeeId: empId,
              employeeName: empName,
              companyId: params.companyId || targetEmp?.companyId || "default",
              type: params.type || "out",
              source: "admin",
              timestamp: {
                seconds: Math.floor(new Date(timestampISO).getTime() / 1000),
                nanoseconds: 0,
              },
            };
            const res = await fetch(
              `${baseUrl}/punches/${docId}?key=${encodeURIComponent(apiKey)}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(punchData) }),
              },
            );
            if (!res.ok) throw new Error("Failed to add punch");
            return Response.json({
              ok: true,
              result: {
                message: `Punch ${params.type || "out"} successfully logged for ${empName || empId} at ${timestampISO}`,
                punchId: docId,
                punch: punchData,
              },
            });
          }

          // 6. LIST LEAVES
          if (action === "list_leaves") {
            const res = await fetch(
              `${baseUrl}/leaveRequests?pageSize=100&key=${encodeURIComponent(apiKey)}`,
            );
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => {
              const id = doc.name.split("/").pop();
              return { id, ...fromFirestoreFields(doc.fields) };
            });
            let filtered = list;
            if (params.status) filtered = filtered.filter((l: any) => l.status === params.status);
            if (params.employeeId)
              filtered = filtered.filter((l: any) => l.employeeId === params.employeeId);
            return Response.json({
              ok: true,
              result: { count: filtered.length, leaves: filtered },
            });
          }

          // 7. LIST PUNCHES (Sorted with readable timestamps)
          if (action === "list_punches") {
            const res = await fetch(
              `${baseUrl}/punches?pageSize=300&key=${encodeURIComponent(apiKey)}`,
            );
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => {
              const id = doc.name.split("/").pop();
              const fields = fromFirestoreFields(doc.fields);
              let timestampISO = "";
              if (fields.timestamp?.seconds) {
                timestampISO = new Date(fields.timestamp.seconds * 1000).toISOString();
              } else if (typeof fields.timestamp === "string") {
                timestampISO = fields.timestamp;
              }
              return {
                id,
                ...fields,
                timestampISO,
                date: timestampISO ? timestampISO.slice(0, 10) : "N/A",
                time: timestampISO
                  ? new Date(timestampISO).toLocaleTimeString("en-AU", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                    })
                  : "N/A",
              };
            });

            // Sort newest first
            list.sort(
              (a: any, b: any) =>
                new Date(b.timestampISO || 0).getTime() - new Date(a.timestampISO || 0).getTime(),
            );

            let filtered = list;
            if (params.employeeId)
              filtered = filtered.filter((p: any) => p.employeeId === params.employeeId);
            if (params.companyId)
              filtered = filtered.filter((p: any) => p.companyId === params.companyId);
            if (params.date) filtered = filtered.filter((p: any) => p.date === params.date);

            return Response.json({
              ok: true,
              result: { count: filtered.length, punches: filtered },
            });
          }

          // 8. GET LIVE ATTENDANCE (Real-time live status for all employees)
          if (action === "get_live_attendance") {
            const [empRes, punchRes] = await Promise.all([
              fetch(`${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`),
              fetch(`${baseUrl}/punches?pageSize=500&key=${encodeURIComponent(apiKey)}`),
            ]);

            const empData = await empRes.json();
            const punchData = await punchRes.json();

            const employees = (empData.documents || [])
              .map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }))
              .filter((e: any) => e.status !== "inactive");

            const punches = (punchData.documents || []).map((doc: any) => {
              const id = doc.name.split("/").pop();
              const fields = fromFirestoreFields(doc.fields);
              const sec = fields.timestamp?.seconds;
              const dateObj = sec ? new Date(sec * 1000) : new Date(fields.timestamp || 0);
              return {
                id,
                ...fields,
                timeMillis: dateObj.getTime(),
                isoString: dateObj.toISOString(),
                dateStr: dateObj.toISOString().slice(0, 10),
              };
            });

            const now = new Date();
            const todayUtc = now.toISOString().slice(0, 10);
            const twentyFourHoursAgo = now.getTime() - 24 * 60 * 60 * 1000;

            const liveStatusList = employees.map((emp: any) => {
              const empPunches = punches
                .filter((p: any) => p.employeeId === emp.id)
                .sort((a: any, b: any) => b.timeMillis - a.timeMillis);

              const latestPunch = empPunches[0];

              if (!latestPunch) {
                return {
                  employeeId: emp.id,
                  name: emp.name,
                  email: emp.email,
                  department: emp.deptId || "General",
                  companyId: emp.companyId || "default",
                  shiftHours: `${emp.shiftStartTime || "09:00"} - ${emp.shiftEndTime || "17:00"}`,
                  liveStatus: "OFF_SHIFT",
                  isCurrentlyPunchedIn: false,
                  note: "No punch records found",
                };
              }

              const isRecent = latestPunch.timeMillis >= twentyFourHoursAgo;
              const isToday = latestPunch.dateStr === todayUtc;

              if (latestPunch.type === "in") {
                if (isRecent || isToday) {
                  return {
                    employeeId: emp.id,
                    name: emp.name,
                    email: emp.email,
                    department: emp.deptId || "General",
                    companyId: emp.companyId || "default",
                    shiftHours: `${emp.shiftStartTime || "09:00"} - ${emp.shiftEndTime || "17:00"}`,
                    liveStatus: "PUNCHED_IN",
                    isCurrentlyPunchedIn: true,
                    punchedInAt: latestPunch.isoString,
                    punchTime: new Date(latestPunch.timeMillis).toLocaleTimeString("en-AU", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                    }),
                    note: `Currently working (punched in at ${new Date(latestPunch.timeMillis).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: true })})`,
                  };
                } else {
                  // Old unclosed punch from a previous day
                  return {
                    employeeId: emp.id,
                    name: emp.name,
                    email: emp.email,
                    department: emp.deptId || "General",
                    companyId: emp.companyId || "default",
                    shiftHours: `${emp.shiftStartTime || "09:00"} - ${emp.shiftEndTime || "17:00"}`,
                    liveStatus: "MISSED_PUNCH_OUT",
                    isCurrentlyPunchedIn: false,
                    missedDate: latestPunch.dateStr,
                    note: `Missed punch-out from ${latestPunch.dateStr} (Not currently working today)`,
                  };
                }
              }

              // Latest punch is "out"
              return {
                employeeId: emp.id,
                name: emp.name,
                email: emp.email,
                department: emp.deptId || "General",
                companyId: emp.companyId || "default",
                shiftHours: `${emp.shiftStartTime || "09:00"} - ${emp.shiftEndTime || "17:00"}`,
                liveStatus: "PUNCHED_OUT",
                isCurrentlyPunchedIn: false,
                punchedOutAt: latestPunch.isoString,
                punchTime: new Date(latestPunch.timeMillis).toLocaleTimeString("en-AU", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: true,
                }),
                note: `Punched out at ${new Date(latestPunch.timeMillis).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: true })}`,
              };
            });

            const currentlyWorking = liveStatusList.filter((e: any) => e.isCurrentlyPunchedIn);
            const missedPunches = liveStatusList.filter(
              (e: any) => e.liveStatus === "MISSED_PUNCH_OUT",
            );

            return Response.json({
              ok: true,
              result: {
                totalEmployees: liveStatusList.length,
                currentlyWorkingCount: currentlyWorking.length,
                currentlyWorking,
                missedPunchOutsCount: missedPunches.length,
                missedPunchOuts: missedPunches,
                allEmployeesStatus: liveStatusList,
              },
            });
          }

          // 9. DECIDE LEAVE
          if (action === "decide_leave") {
            const fieldsToUpdate = {
              status: params.decision,
              paymentStatus: params.paymentStatus || "paid",
              decidedBy: params.decidedBy || authResult.adminEmail || "Admin",
              decidedAt: new Date().toISOString(),
            };
            const updateMask = Object.keys(fieldsToUpdate)
              .map((k) => `updateMask.fieldPaths=${k}`)
              .join("&");
            const res = await fetch(
              `${baseUrl}/leaveRequests/${params.leaveId}?${updateMask}&key=${encodeURIComponent(
                apiKey,
              )}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
              },
            );
            if (!res.ok) throw new Error("Failed to decide leave");

            // Also trigger decision notification webhook asynchronously
            try {
              const leaveGetRes = await fetch(
                `${baseUrl}/leaveRequests/${params.leaveId}?key=${encodeURIComponent(apiKey)}`,
              );
              if (leaveGetRes.ok) {
                const leaveDoc = await leaveGetRes.json();
                const leaveData = fromFirestoreFields(leaveDoc.fields);
                const webhookUrl =
                  process.env.N8N_LEAVE_DECISION_WEBHOOK_URL ||
                  "https://vmi3182726.contaboserver.net/webhook/time-station-leave-decision";

                const approved = params.decision === "approved";
                const dateRange =
                  leaveData.dateFrom === leaveData.dateTo
                    ? leaveData.dateFrom
                    : `${leaveData.dateFrom} to ${leaveData.dateTo}`;
                const subject = approved
                  ? "Your leave request was approved"
                  : "Your leave request was rejected";
                const text = `Hi ${leaveData.employeeName || "Employee"},\n\nYour leave request for ${dateRange} has been ${params.decision}.\n\nReason: ${leaveData.reason || "N/A"}`;

                await fetch(webhookUrl, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    event: approved ? "leave_approved" : "leave_rejected",
                    leaveRequestId: params.leaveId,
                    employeeId: leaveData.employeeId,
                    employeeName: leaveData.employeeName,
                    employeeEmail: leaveData.employeeEmail,
                    dateFrom: leaveData.dateFrom,
                    dateTo: leaveData.dateTo,
                    reason: leaveData.reason || "",
                    status: params.decision,
                    decidedBy: fieldsToUpdate.decidedBy,
                    decidedAt: fieldsToUpdate.decidedAt,
                    email: {
                      to: leaveData.employeeEmail,
                      subject,
                      text,
                    },
                  }),
                });
              }
            } catch (notifyErr) {
              console.warn("Decision webhook dispatch failed:", notifyErr);
            }

            return Response.json({
              ok: true,
              result: {
                message: `Leave request ${params.leaveId} marked as ${params.decision} and notification dispatched.`,
              },
            });
          }

          // 10. LIST OVERTIME REQUESTS
          if (action === "list_overtime") {
            const res = await fetch(
              `${baseUrl}/overtimeRequests?pageSize=200&key=${encodeURIComponent(apiKey)}`,
            );
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => ({
              id: doc.name.split("/").pop(),
              ...fromFirestoreFields(doc.fields),
            }));

            let filtered = list;
            if (params.status && params.status !== "all") {
              filtered = filtered.filter((r: any) => r.status === params.status);
            }
            if (params.employeeId) {
              filtered = filtered.filter((r: any) => r.employeeId === params.employeeId);
            }
            if (params.date) {
              filtered = filtered.filter((r: any) => r.date === params.date);
            }

            return Response.json({
              ok: true,
              result: { count: filtered.length, overtimeRequests: filtered },
            });
          }

          // 11. DECIDE OVERTIME
          if (action === "decide_overtime") {
            if (!params.requestId || !params.decision) {
              return Response.json(
                { ok: false, error: "Missing requestId or decision ('approved' | 'rejected')" },
                { status: 400 },
              );
            }

            const fieldsToUpdate = {
              status: params.decision,
              decidedBy: authResult.adminEmail || "Admin via MCP",
              decidedAt: new Date().toISOString(),
            };

            const updateMask = Object.keys(fieldsToUpdate)
              .map((k) => `updateMask.fieldPaths=${k}`)
              .join("&");

            const patchUrl = `${baseUrl}/overtimeRequests/${params.requestId}?${updateMask}&key=${encodeURIComponent(apiKey)}`;
            const res = await fetch(patchUrl, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
            });

            if (!res.ok) throw new Error("Failed to update overtime decision");

            return Response.json({
              ok: true,
              result: {
                message: `Overtime request ${params.requestId} marked as ${params.decision}.`,
              },
            });
          }

          // 0. GET COMPANY SUMMARY (Instant workspace overview for ChatGPT)
          if (action === "get_company_summary") {
            const [empRes, punchRes, leaveRes, otRes] = await Promise.all([
              fetch(`${baseUrl}/employees?pageSize=200&key=${encodeURIComponent(apiKey)}`),
              fetch(`${baseUrl}/punches?pageSize=200&key=${encodeURIComponent(apiKey)}`),
              fetch(`${baseUrl}/leaveRequests?pageSize=100&key=${encodeURIComponent(apiKey)}`),
              fetch(`${baseUrl}/overtimeRequests?pageSize=100&key=${encodeURIComponent(apiKey)}`),
            ]);

            const [empData, punchData, leaveData, otData] = await Promise.all([
              empRes.json(),
              punchRes.json(),
              leaveRes.json(),
              otRes.json(),
            ]);

            const employees = (empData.documents || []).map((d: any) => ({
              id: d.name.split("/").pop(),
              ...fromFirestoreFields(d.fields),
            }));

            const punches = (punchData.documents || []).map((d: any) => ({
              id: d.name.split("/").pop(),
              ...fromFirestoreFields(d.fields),
            }));

            const leaves = (leaveData.documents || []).map((d: any) => ({
              id: d.name.split("/").pop(),
              ...fromFirestoreFields(d.fields),
            }));

            const overtimeRequests = (otData.documents || []).map((d: any) => ({
              id: d.name.split("/").pop(),
              ...fromFirestoreFields(d.fields),
            }));

            const activeEmployees = employees.filter((e: any) => e.status !== "inactive");
            const pendingLeaves = leaves.filter((l: any) => l.status === "pending");
            const pendingOvertime = overtimeRequests.filter((o: any) => o.status === "pending");

            return Response.json({
              ok: true,
              result: {
                totalEmployees: employees.length,
                activeEmployeesCount: activeEmployees.length,
                pendingLeavesCount: pendingLeaves.length,
                pendingOvertimeCount: pendingOvertime.length,
                totalRecordedPunches: punches.length,
                pendingLeaves: pendingLeaves.slice(0, 10),
                pendingOvertime: pendingOvertime.slice(0, 10),
              },
            });
          }

          // 12. LIST DAILY REPORTS (SOD / EOD Reports)
          if (action === "list_daily_reports") {
            const res = await fetch(
              `${baseUrl}/dailyReports?pageSize=200&key=${encodeURIComponent(apiKey)}`,
            );
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => ({
              id: doc.name.split("/").pop(),
              ...fromFirestoreFields(doc.fields),
            }));

            let filtered = list;
            if (params.date) filtered = filtered.filter((r: any) => r.reportDate === params.date);
            if (params.reportType)
              filtered = filtered.filter((r: any) => r.reportType === params.reportType);

            const empIdentifier = params.employeeId || params.employeeName || params.name;
            if (empIdentifier) {
              const matchedEmp = await resolveEmployee(empIdentifier, baseUrl, apiKey);
              if (matchedEmp) {
                filtered = filtered.filter(
                  (r: any) =>
                    r.employeeId === matchedEmp.id ||
                    r.userId === matchedEmp.id ||
                    r.userId === matchedEmp.authUid ||
                    r.userEmail?.toLowerCase() === matchedEmp.email?.toLowerCase(),
                );
              }
            }

            return Response.json({
              ok: true,
              result: { count: filtered.length, reports: filtered },
            });
          }

          return Response.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
        } catch (execErr) {
          return Response.json(
            { ok: false, error: execErr instanceof Error ? execErr.message : "Execution failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
