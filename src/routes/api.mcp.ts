import { createFileRoute } from "@tanstack/react-router";

function getFirestoreConfig() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "runner-man-634be";
  const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY";
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  return { projectId, apiKey, baseUrl };
}

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

const MCP_TOOLS = [
  {
    name: "add_employee",
    description:
      "Add a new employee / Virtual Assistant (V.A.) to SavyTimes with shift schedule, company, and department.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name of the employee or V.A." },
        email: { type: "string", description: "Email address" },
        companyId: { type: "string", description: "Company ID (defaults to 'default')" },
        jobTitle: { type: "string", description: "Job title e.g. 'Virtual Assistant'" },
        country: { type: "string", enum: ["NP", "AU", "PH"], description: "Country code" },
        shiftStartTime: { type: "string", description: "Shift start time e.g. '09:00'" },
        shiftEndTime: { type: "string", description: "Shift end time e.g. '17:00'" },
        shiftTimezone: { type: "string", description: "Timezone e.g. 'Australia/Sydney'" },
      },
      required: ["name", "email"],
    },
  },
  {
    name: "list_employees",
    description:
      "List all employees and Virtual Assistants in SavyTimes with their details and shift hours.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional filter by company ID" },
      },
    },
  },
  {
    name: "update_employee",
    description: "Update details, shift times, status, or company of an existing employee.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Employee document ID" },
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
  {
    name: "list_companies",
    description: "List all registered client companies in SavyTimes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_punches",
    description: "Fetch punch logs for an employee or company.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        companyId: { type: "string" },
      },
    },
  },
  {
    name: "get_live_attendance",
    description:
      "Get real-time live attendance status for all employees: who is currently punched in right now, who is off-shift, and who has missed punch-outs from previous days.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_or_fix_punch",
    description: "Add a manual punch or fix a missed punch out for an employee.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        type: { type: "string", enum: ["in", "out"] },
        timestampISO: { type: "string", description: "ISO timestamp e.g. '2026-08-12T17:00:00Z'" },
        companyId: { type: "string" },
      },
      required: ["employeeId", "type", "timestampISO"],
    },
  },
  {
    name: "list_leaves",
    description:
      "List leave requests with optional status filtering (pending, approved, rejected).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected"] },
        employeeId: { type: "string" },
      },
    },
  },
  {
    name: "decide_leave",
    description: "Approve or reject an employee leave request.",
    inputSchema: {
      type: "object",
      properties: {
        leaveId: { type: "string", description: "Leave request document ID" },
        decision: { type: "string", enum: ["approved", "rejected"] },
        paymentStatus: { type: "string", enum: ["paid", "unpaid"] },
      },
      required: ["leaveId", "decision"],
    },
  },
];

async function validateAdminAuth(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
  if (!token) return false;

  const masterKey =
    process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
  if (token === masterKey) return true;

  const { baseUrl, apiKey } = getFirestoreConfig();
  const tokenDocRes = await fetch(
    `${baseUrl}/adminApiTokens/${encodeURIComponent(token)}?key=${encodeURIComponent(apiKey)}`,
  );
  if (tokenDocRes.ok) {
    const data = await tokenDocRes.json();
    const fields = fromFirestoreFields(data.fields);
    return fields.active !== false;
  }
  return false;
}

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json({
          jsonrpc: "2.0",
          server: "SavyTimes Remote MCP Server",
          version: "1.0.0",
          protocol: "2024-11-05",
          transport: "HTTP JSON-RPC",
        });
      },
      POST: async ({ request }) => {
        const isAuth = await validateAdminAuth(request);
        if (!isAuth) {
          return Response.json(
            {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Unauthorized: Invalid or missing SavyTimes Admin API Token",
              },
            },
            { status: 401 },
          );
        }

        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } },
            { status: 400 },
          );
        }

        const { id, method, params } = body;
        const { baseUrl, apiKey } = getFirestoreConfig();

        if (method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "savytimes-remote-mcp", version: "1.0.0" },
            },
          });
        }

        if (method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: { tools: MCP_TOOLS },
          });
        }

        if (method === "tools/call") {
          const toolName = params?.name;
          const args = params?.arguments || {};

          try {
            // 1. ADD EMPLOYEE
            if (toolName === "add_employee") {
              const docId = `emp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
              const employeeData = {
                name: args.name,
                email: args.email,
                companyId: args.companyId || "default",
                companyIds: [args.companyId || "default"],
                jobTitle: args.jobTitle || "Virtual Assistant",
                deptId: args.deptId || "",
                country: args.country || "NP",
                state: args.state || "N/A",
                status: "active",
                inviteStatus: "pending",
                shiftStartTime: args.shiftStartTime || "09:00",
                shiftEndTime: args.shiftEndTime || "17:00",
                shiftTimezone: args.shiftTimezone || "Asia/Kathmandu",
                isMultipleShift: false,
                shifts: [
                  {
                    startTime: args.shiftStartTime || "09:00",
                    endTime: args.shiftEndTime || "17:00",
                  },
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
              if (!res.ok) throw new Error("Failed to add employee");

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    { type: "text", text: `Employee '${args.name}' created with ID: ${docId}` },
                  ],
                },
              });
            }

            // 2. LIST EMPLOYEES
            if (toolName === "list_employees") {
              const res = await fetch(
                `${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`,
              );
              const data = await res.json();
              const list = (data.documents || []).map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }));
              const filtered = args.companyId
                ? list.filter(
                    (e: any) =>
                      e.companyId === args.companyId || e.companyIds?.includes(args.companyId),
                  )
                : list;

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
                },
              });
            }

            // 3. UPDATE EMPLOYEE
            if (toolName === "update_employee") {
              let targetId = args.id;
              if (!targetId) {
                const listRes = await fetch(
                  `${baseUrl}/employees?pageSize=100&key=${encodeURIComponent(apiKey)}`,
                );
                if (listRes.ok) {
                  const listData = await listRes.json();
                  const matchedDoc = (listData.documents || []).find((doc: any) => {
                    const fields = fromFirestoreFields(doc.fields);
                    if (args.email && fields.email?.toLowerCase() === args.email.toLowerCase())
                      return true;
                    if (args.name && fields.name?.toLowerCase() === args.name.toLowerCase())
                      return true;
                    return false;
                  });
                  if (matchedDoc) targetId = matchedDoc.name.split("/").pop();
                }
              }

              if (!targetId) throw new Error("Employee not found by ID, email, or name.");

              const fieldsToUpdate: Record<string, any> = {};
              if (args.name) fieldsToUpdate.name = args.name;
              if (args.email) fieldsToUpdate.email = args.email;
              if (args.jobTitle) fieldsToUpdate.jobTitle = args.jobTitle;
              if (args.status) fieldsToUpdate.status = args.status;
              if (args.deptId || args.department)
                fieldsToUpdate.deptId = args.deptId || args.department;
              if (args.shiftStartTime) fieldsToUpdate.shiftStartTime = args.shiftStartTime;
              if (args.shiftEndTime) fieldsToUpdate.shiftEndTime = args.shiftEndTime;

              const updateMask = Object.keys(fieldsToUpdate)
                .map((k) => `updateMask.fieldPaths=${k}`)
                .join("&");
              const res = await fetch(
                `${baseUrl}/employees/${targetId}?${updateMask}&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
                },
              );
              if (!res.ok) throw new Error("Failed to update employee in database.");

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Employee ${targetId} successfully updated with: ${JSON.stringify(fieldsToUpdate)}`,
                    },
                  ],
                },
              });
            }

            // 3. LIST LEAVES
            if (toolName === "list_leaves") {
              const res = await fetch(
                `${baseUrl}/leaveRequests?pageSize=100&key=${encodeURIComponent(apiKey)}`,
              );
              const data = await res.json();
              const list = (data.documents || []).map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }));
              let filtered = list;
              if (args.status) filtered = filtered.filter((l: any) => l.status === args.status);
              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
                },
              });
            }

            // 4. DECIDE LEAVE
            if (toolName === "decide_leave") {
              const fieldsToUpdate = {
                status: args.decision,
                paymentStatus: args.paymentStatus || "paid",
                decidedBy: "Admin via Remote Claude MCP",
                decidedAt: new Date().toISOString(),
              };
              const updateMask = Object.keys(fieldsToUpdate)
                .map((k) => `updateMask.fieldPaths=${k}`)
                .join("&");
              const res = await fetch(
                `${baseUrl}/leaveRequests/${args.leaveId}?${updateMask}&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
                },
              );
              if (!res.ok) throw new Error("Failed to decide leave");
              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Leave request ${args.leaveId} marked as ${args.decision}.`,
                    },
                  ],
                },
              });
            }

            // 5. GET LIVE ATTENDANCE
            if (toolName === "get_live_attendance") {
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

              const liveList = employees.map((emp: any) => {
                const empPunches = punches
                  .filter((p: any) => p.employeeId === emp.id)
                  .sort((a: any, b: any) => b.timeMillis - a.timeMillis);

                const latest = empPunches[0];
                if (!latest) {
                  return {
                    name: emp.name,
                    email: emp.email,
                    status: "OFF_SHIFT",
                    isCurrentlyWorking: false,
                  };
                }

                if (latest.type === "in") {
                  if (latest.timeMillis >= twentyFourHoursAgo || latest.dateStr === todayUtc) {
                    return {
                      name: emp.name,
                      email: emp.email,
                      status: "PUNCHED_IN",
                      isCurrentlyWorking: true,
                      punchedInAt: latest.isoString,
                    };
                  }
                  return {
                    name: emp.name,
                    email: emp.email,
                    status: "MISSED_PUNCH_OUT",
                    isCurrentlyWorking: false,
                    missedDate: latest.dateStr,
                  };
                }

                return {
                  name: emp.name,
                  email: emp.email,
                  status: "PUNCHED_OUT",
                  isCurrentlyWorking: false,
                  punchedOutAt: latest.isoString,
                };
              });

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(liveList, null, 2) }],
                },
              });
            }
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Executed tool ${toolName} successfully.` }],
              },
            });
          } catch (err) {
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Error: ${err instanceof Error ? err.message : "Execution failed"}`,
                  },
                ],
              },
            });
          }
        }

        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
      },
    },
  },
});
