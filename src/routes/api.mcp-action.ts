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
            if (typeof item === "object") return { mapValue: { fields: toFirestoreFields(item as Record<string, unknown>) } };
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
  const masterKey = process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
  if (token === masterKey) {
    return { ok: true, adminEmail: "pabibek9@gmail.com" };
  }

  const { baseUrl, apiKey } = getFirestoreConfig();

  // Check if token exists in Firestore adminApiTokens
  const tokenDocRes = await fetch(
    `${baseUrl}/adminApiTokens/${encodeURIComponent(token)}?key=${encodeURIComponent(
      apiKey,
    )}`,
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
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
      apiKey,
    )}`,
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

// OpenAPI 3.1.0 schema for ChatGPT Custom GPT Actions
function getOpenApiSchema(appUrl: string) {
  const jsonResponse = (desc: string) => ({
    "200": {
      description: desc,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              result: { type: "object" },
            },
          },
        },
      },
    },
    "401": { description: "Unauthorized — invalid or missing admin API token" },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "SavyTimes Admin API",
      description:
        "Full admin API for SavyTimes (https://station.savykids.com). You can list employees, add new Virtual Assistants, fix missed punch-outs, view and approve/reject leave requests, list client companies, and more. All actions require a Bearer admin API token.",
      version: "1.1.0",
    },
    servers: [{ url: appUrl }],
    paths: {
      "/api/mcp-action#listEmployees": {
        post: {
          summary: "List all employees and Virtual Assistants",
          description:
            "Returns all employees/VAs in SavyTimes with their name, email, shift times, company, department, and status. You can optionally filter by companyId.",
          operationId: "listEmployees",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["list_employees"] },
                    params: {
                      type: "object",
                      properties: {
                        companyId: { type: "string", description: "Optional company ID to filter by" },
                      },
                    },
                  },
                  required: ["action"],
                },
              },
            },
          },
          responses: jsonResponse("List of employees returned successfully"),
        },
      },
      "/api/mcp-action#addEmployee": {
        post: {
          summary: "Add a new employee or Virtual Assistant",
          description:
            "Creates a new employee/VA record in SavyTimes. Provide their name, email, job title, shift start/end times, timezone, country, and company assignment.",
          operationId: "addEmployee",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["add_employee"] },
                    params: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Full name of the employee" },
                        email: { type: "string", description: "Email address" },
                        jobTitle: { type: "string", description: "Job title e.g. 'Virtual Assistant'" },
                        companyId: { type: "string", description: "Company ID (defaults to 'default')" },
                        shiftStartTime: { type: "string", description: "Shift start in HH:mm e.g. '09:00'" },
                        shiftEndTime: { type: "string", description: "Shift end in HH:mm e.g. '17:00'" },
                        shiftTimezone: { type: "string", description: "Timezone e.g. 'Australia/Sydney'" },
                        country: { type: "string", enum: ["NP", "AU", "PH"], description: "Country code" },
                      },
                      required: ["name", "email"],
                    },
                  },
                  required: ["action", "params"],
                },
              },
            },
          },
          responses: jsonResponse("Employee created successfully"),
        },
      },
      "/api/mcp-action#updateEmployee": {
        post: {
          summary: "Update an existing employee's details",
          description:
            "Update name, email, job title, shift times, status (active/inactive), or company assignment for an employee. You must provide the employee's document ID.",
          operationId: "updateEmployee",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["update_employee"] },
                    params: {
                      type: "object",
                      properties: {
                        id: { type: "string", description: "Employee document ID (get from listEmployees)" },
                        name: { type: "string" },
                        email: { type: "string" },
                        jobTitle: { type: "string" },
                        status: { type: "string", enum: ["active", "inactive"] },
                        shiftStartTime: { type: "string" },
                        shiftEndTime: { type: "string" },
                      },
                      required: ["id"],
                    },
                  },
                  required: ["action", "params"],
                },
              },
            },
          },
          responses: jsonResponse("Employee updated successfully"),
        },
      },
      "/api/mcp-action#listLeaves": {
        post: {
          summary: "List leave requests (pending, approved, or rejected)",
          description:
            "Returns all leave requests from employees. You can filter by status (pending/approved/rejected) and/or employeeId. Use this to check who has submitted leave requests and their current approval status.",
          operationId: "listLeaves",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["list_leaves"] },
                    params: {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["pending", "approved", "rejected"], description: "Filter by leave status" },
                        employeeId: { type: "string", description: "Filter by specific employee ID" },
                      },
                    },
                  },
                  required: ["action"],
                },
              },
            },
          },
          responses: jsonResponse("Leave requests returned successfully"),
        },
      },
      "/api/mcp-action#decideLeave": {
        post: {
          summary: "Approve or reject a leave request",
          description:
            "Approve or reject a pending leave request. Specify the leaveId, decision (approved/rejected), and optionally paymentStatus (paid/unpaid).",
          operationId: "decideLeave",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["decide_leave"] },
                    params: {
                      type: "object",
                      properties: {
                        leaveId: { type: "string", description: "Leave request document ID (get from listLeaves)" },
                        decision: { type: "string", enum: ["approved", "rejected"] },
                        paymentStatus: { type: "string", enum: ["paid", "unpaid"], description: "Whether the leave is paid or unpaid" },
                      },
                      required: ["leaveId", "decision"],
                    },
                  },
                  required: ["action", "params"],
                },
              },
            },
          },
          responses: jsonResponse("Leave decision applied successfully"),
        },
      },
      "/api/mcp-action#listCompanies": {
        post: {
          summary: "List all client companies",
          description: "Returns all registered client companies in SavyTimes with their names, timezones, and settings.",
          operationId: "listCompanies",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["list_companies"] },
                    params: { type: "object" },
                  },
                  required: ["action"],
                },
              },
            },
          },
          responses: jsonResponse("Companies returned successfully"),
        },
      },
      "/api/mcp-action#listPunches": {
        post: {
          summary: "List punch-in/out attendance logs",
          description:
            "Returns punch-in and punch-out attendance logs. Filter by employeeId or companyId. Use this to check who punched in/out and when.",
          operationId: "listPunches",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["list_punches"] },
                    params: {
                      type: "object",
                      properties: {
                        employeeId: { type: "string" },
                        companyId: { type: "string" },
                      },
                    },
                  },
                  required: ["action"],
                },
              },
            },
          },
          responses: jsonResponse("Punch logs returned successfully"),
        },
      },
      "/api/mcp-action#addOrFixPunch": {
        post: {
          summary: "Add a manual punch or fix a missed punch-out",
          description:
            "Record a manual punch-in or punch-out for an employee, or fix a missed punch-out. Provide employeeId, type (in/out), and the timestamp in ISO format.",
          operationId: "addOrFixPunch",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["add_or_fix_punch"] },
                    params: {
                      type: "object",
                      properties: {
                        employeeId: { type: "string", description: "Employee ID" },
                        employeeName: { type: "string", description: "Employee name (optional)" },
                        type: { type: "string", enum: ["in", "out"], description: "Punch type" },
                        timestampISO: { type: "string", description: "ISO timestamp e.g. '2026-08-12T17:00:00Z'" },
                        companyId: { type: "string" },
                      },
                      required: ["employeeId", "type", "timestampISO"],
                    },
                  },
                  required: ["action", "params"],
                },
              },
            },
          },
          responses: jsonResponse("Punch recorded successfully"),
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "SavyTimes Admin API Token. Generate one from the Admin > AI & MCP tab at https://station.savykids.com/admin/mcp-connect",
        },
      },
    },
    security: [{ BearerAuth: [] }],
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

        let body: { action: string; params?: Record<string, any> };
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        const { action, params = {} } = body;
        const { baseUrl, apiKey } = getFirestoreConfig();

        try {
          // 1. ADD EMPLOYEE
          if (action === "add_employee") {
            const docId = `emp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const employeeData = {
              name: params.name,
              email: params.email,
              companyId: params.companyId || "default",
              companyIds: [params.companyId || "default"],
              jobTitle: params.jobTitle || "Virtual Assistant",
              deptId: params.deptId || "",
              country: params.country || "NP",
              state: params.state || "N/A",
              status: "active",
              inviteStatus: "pending",
              shiftStartTime: params.shiftStartTime || "09:00",
              shiftEndTime: params.shiftEndTime || "17:00",
              shiftTimezone: params.shiftTimezone || "Asia/Kathmandu",
              isMultipleShift: Boolean(params.isMultipleShift),
              shifts: params.shifts || [
                { startTime: params.shiftStartTime || "09:00", endTime: params.shiftEndTime || "17:00" },
              ],
              createdAt: new Date().toISOString(),
            };

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
            return Response.json({
              ok: true,
              result: { message: `Employee '${params.name}' added successfully.`, employeeId: docId, data: employeeData },
            });
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
              ? list.filter((e: any) => e.companyId === params.companyId || e.companyIds?.includes(params.companyId))
              : list;
            return Response.json({ ok: true, result: { count: filtered.length, employees: filtered } });
          }

          // 3. UPDATE EMPLOYEE
          if (action === "update_employee") {
            let targetId = params.id;
            let targetEmail = params.email;
            let targetName = params.name;

            // If ID is missing, search by email or name
            if (!targetId) {
              const listRes = await fetch(`${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              if (listRes.ok) {
                const listData = await listRes.json();
                const matchedDoc = (listData.documents || []).find((doc: any) => {
                  const fields = fromFirestoreFields(doc.fields);
                  if (targetEmail && fields.email?.toLowerCase() === targetEmail.toLowerCase()) return true;
                  if (targetName && fields.name?.toLowerCase() === targetName.toLowerCase()) return true;
                  return false;
                });
                if (matchedDoc) {
                  targetId = matchedDoc.name.split("/").pop();
                }
              }
            }

            if (!targetId) {
              return Response.json(
                { ok: false, error: "Employee not found. Please provide employee ID or valid email address." },
                { status: 404 },
              );
            }

            // Extract fields to update
            const fieldsToUpdate: Record<string, any> = {};
            if (params.name) fieldsToUpdate.name = params.name;
            if (params.email) fieldsToUpdate.email = params.email;
            if (params.jobTitle || params.role) fieldsToUpdate.jobTitle = params.jobTitle || params.role;
            if (params.status) fieldsToUpdate.status = params.status;
            if (params.deptId || params.department) fieldsToUpdate.deptId = params.deptId || params.department;
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
            const res = await fetch(
              `${baseUrl}/companies?key=${encodeURIComponent(apiKey)}`,
            );
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
            const punchData = {
              employeeId: params.employeeId,
              employeeName: params.employeeName || "",
              companyId: params.companyId || "default",
              type: params.type,
              source: params.source || "app",
              timestamp: {
                seconds: Math.floor(new Date(params.timestampISO).getTime() / 1000),
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
            return Response.json({ ok: true, result: { message: `Punch saved with ID ${docId}`, punch: punchData } });
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
            if (params.employeeId) filtered = filtered.filter((l: any) => l.employeeId === params.employeeId);
            return Response.json({ ok: true, result: { count: filtered.length, leaves: filtered } });
          }

          // 7. LIST PUNCHES
          if (action === "list_punches") {
            const res = await fetch(
              `${baseUrl}/punches?pageSize=100&key=${encodeURIComponent(apiKey)}`,
            );
            const data = await res.json();
            const list = (data.documents || []).map((doc: any) => {
              const id = doc.name.split("/").pop();
              return { id, ...fromFirestoreFields(doc.fields) };
            });
            let filtered = list;
            if (params.employeeId) filtered = filtered.filter((p: any) => p.employeeId === params.employeeId);
            if (params.companyId) filtered = filtered.filter((p: any) => p.companyId === params.companyId);
            return Response.json({ ok: true, result: { count: filtered.length, punches: filtered } });
          }

          // 8. DECIDE LEAVE
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
            return Response.json({ ok: true, result: { message: `Leave request ${params.leaveId} marked as ${params.decision}.` } });
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
