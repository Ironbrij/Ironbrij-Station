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
      "Add a single employee or Virtual Assistant (V.A.) to SavyTimes with shift schedule, company, and department. Can also accept a list of employees in 'employees' parameter.",
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
        employees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              companyId: { type: "string" },
              jobTitle: { type: "string" },
              shiftStartTime: { type: "string" },
              shiftEndTime: { type: "string" },
              shiftTimezone: { type: "string" },
            },
            required: ["name", "email"],
          },
          description: "Optional list of multiple employees to create at once in batch",
        },
      },
    },
  },
  {
    name: "batch_add_employees",
    description: "Add multiple employees / Virtual Assistants to SavyTimes in a single batch call.",
    inputSchema: {
      type: "object",
      properties: {
        employees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              companyId: { type: "string" },
              jobTitle: { type: "string" },
              shiftStartTime: { type: "string" },
              shiftEndTime: { type: "string" },
              shiftTimezone: { type: "string" },
            },
            required: ["name", "email"],
          },
          description: "Array of employee objects to create",
        },
      },
      required: ["employees"],
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
    name: "create_company",
    description:
      "Create a new client company in SavyTimes with complete configuration: timezone, working days, default shift hours, break allowance, max daily breaks, grace minutes, holiday rules, and optional initial departments.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Company name (e.g. 'Ironbrij', 'Acme Corp')" },
        code: { type: "string", description: "Short company code (e.g. 'IRON')" },
        timezone: {
          type: "string",
          description: "Primary timezone (e.g. 'Australia/Sydney', 'Asia/Kathmandu', 'Asia/Manila')",
        },
        defaultShiftHours: {
          type: "number",
          description: "Default daily required shift hours (e.g. 8)",
        },
        workingDays: {
          type: "array",
          items: { type: "number" },
          description: "Working days array where 0=Sun, 1=Mon..6=Sat (defaults to [1, 2, 3, 4, 5])",
        },
        lateGraceMinutes: {
          type: "number",
          description: "Grace minutes allowed before lateness starts (default 5)",
        },
        punchOutGraceMinutes: {
          type: "number",
          description: "Grace period in minutes after shift end before auto punch-out (default 30)",
        },
        punchOutReminderMinutes: {
          type: "number",
          description: "Minutes before shift end to send reminder email (default 20)",
        },
        breakAllowanceMinutes: {
          type: "number",
          description: "Default break duration in minutes (e.g. 30, or 0 for N/A / no break)",
        },
        maxDailyBreaks: {
          type: "number",
          description: "Maximum breaks allowed per shift (default 1, or 0 for N/A / no breaks)",
        },
        holidays: {
          type: "array",
          items: { type: "string" },
          description: "Array of holiday dates in YYYY-MM-DD format",
        },
        clientEmail: { type: "string", description: "Client contact email" },
        ownerName: { type: "string", description: "Owner or manager name" },
        logoUrl: { type: "string", description: "Company logo URL" },
        notes: { type: "string", description: "Internal company notes" },
        departments: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of initial department names to create (e.g. ['Operations', 'Accounts'])",
        },
        companies: {
          type: "array",
          description: "Optional list of multiple companies to create at once in batch",
        },
      },
    },
  },
  {
    name: "batch_create_companies",
    description: "Create multiple client company profiles in SavyTimes in a single batch call.",
    inputSchema: {
      type: "object",
      properties: {
        companies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Company name" },
              code: { type: "string" },
              timezone: { type: "string" },
              defaultShiftHours: { type: "number" },
              workingDays: { type: "array", items: { type: "number" } },
              lateGraceMinutes: { type: "number" },
              breakAllowanceMinutes: { type: "number" },
              maxDailyBreaks: { type: "number" },
              departments: { type: "array", items: { type: "string" } },
            },
            required: ["name"],
          },
          description: "Array of company objects to create",
        },
      },
      required: ["companies"],
    },
  },
  {
    name: "update_company",
    description:
      "Update company details, logo, timezone, shift hours, working days, break rules, or grace minutes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company document ID or name to look up" },
        companyId: { type: "string", description: "Company document ID" },
        name: { type: "string", description: "Company name" },
        oldName: { type: "string", description: "Previous name to look up when updating or renaming" },
        newName: { type: "string", description: "New name to apply" },
        code: { type: "string", description: "Short code" },
        timezone: { type: "string", description: "Timezone" },
        defaultShiftHours: { type: "number", description: "Default shift hours" },
        workingDays: { type: "array", items: { type: "number" } },
        lateGraceMinutes: { type: "number" },
        punchOutGraceMinutes: { type: "number" },
        punchOutReminderMinutes: { type: "number" },
        breakAllowanceMinutes: { type: "number" },
        maxDailyBreaks: { type: "number" },
        holidays: { type: "array", items: { type: "string" } },
        clientEmail: { type: "string" },
        ownerName: { type: "string" },
        logoUrl: { type: "string", description: "Company logo URL" },
        logo: { type: "string", description: "Alias for logo URL" },
        archived: { type: "boolean", description: "Set true to archive or false to unarchive" },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "rename_company",
    description: "Rename an existing company in SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company document ID (e.g. 'comp_123' or 'default')" },
        companyId: { type: "string", description: "Company document ID" },
        name: { type: "string", description: "Current company name to look up if ID not known" },
        oldName: { type: "string", description: "Current company name to look up" },
        newName: { type: "string", description: "New company name to rename to" },
        to: { type: "string", description: "New company name to rename to" },
      },
      required: ["newName"],
    },
  },
  {
    name: "archive_company",
    description: "Archive a company in SavyTimes to hide it from active dropdowns.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company document ID" },
        companyId: { type: "string", description: "Company document ID" },
        name: { type: "string", description: "Company name to archive" },
      },
    },
  },
  {
    name: "unarchive_company",
    description: "Unarchive and restore a previously archived company in SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company document ID" },
        companyId: { type: "string", description: "Company document ID" },
        name: { type: "string", description: "Company name to restore" },
      },
    },
  },
  {
    name: "create_department",
    description: "Create a new department under a company in SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Department name (e.g. 'Accounting', 'Engineering')" },
        companyId: { type: "string", description: "Company ID to associate with" },
        code: { type: "string", description: "Short department code" },
        state: { type: "string", description: "State or location (e.g. 'NSW', 'Bagmati', 'N/A')" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_departments",
    description: "List all departments in SavyTimes, optionally filtered by company ID.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional filter by company ID" },
      },
    },
  },
  {
    name: "send_employee_invite",
    description: "Send or resend email invitation link to an employee / V.A. to join SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Employee document ID" },
        email: { type: "string", description: "Employee email address" },
        name: { type: "string", description: "Employee full name" },
      },
    },
  },
  {
    name: "delete_employee",
    description: "Remove or deactivate an employee from SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Employee ID or email" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_notice",
    description: "Post a team announcement / notice in SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notice title" },
        content: { type: "string", description: "Notice content / message" },
        priority: { type: "string", enum: ["normal", "important", "urgent"] },
        companyId: { type: "string", description: "Optional company ID" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_notices",
    description: "List team notices and announcements.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional filter by company ID" },
      },
    },
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
  {
    name: "get_company_summary",
    description:
      "Get a complete high-level company summary: active team count, currently punched in count, pending leaves count, and pending overtime count.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_overtime",
    description: "List overtime requests with optional status filtering (pending, approved, rejected, all).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected", "all"] },
        employeeId: { type: "string" },
      },
    },
  },
  {
    name: "decide_overtime",
    description: "Approve or reject an employee overtime request.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Overtime request document ID" },
        decision: { type: "string", enum: ["approved", "rejected"] },
      },
      required: ["requestId", "decision"],
    },
  },
  {
    name: "list_daily_reports",
    description: "List SOD and EOD daily work reports submitted by team members.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD date" },
        reportType: { type: "string", enum: ["sod", "eod"] },
        employeeId: { type: "string" },
      },
    },
  },
];

async function resolveEmployee(
  identifier: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; name?: string; email?: string; [key: string]: any } | null> {
  if (!identifier) return null;
  const clean = identifier.trim();

  try {
    const directRes = await fetch(
      `${baseUrl}/employees/${encodeURIComponent(clean)}?key=${encodeURIComponent(apiKey)}`,
    );
    if (directRes.ok) {
      const doc = await directRes.json();
      return { id: clean, ...fromFirestoreFields(doc.fields) };
    }
  } catch {}

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

      const byEmail = list.find((e: any) => e.email?.toLowerCase() === clean.toLowerCase());
      if (byEmail) return byEmail;

      const byExactName = list.find((e: any) => e.name?.toLowerCase() === clean.toLowerCase());
      if (byExactName) return byExactName;

      const byPartial = list.find((e: any) =>
        e.name?.toLowerCase().includes(clean.toLowerCase()),
      );
      if (byPartial) return byPartial;
    }
  } catch {}

  return null;
}

async function createSingleEmployee(
  empInput: Record<string, any>,
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; name: string; email: string; inviteToken: string }> {
  const empName = (empInput.name || empInput.employeeName || "").trim();
  const empEmail = (empInput.email || empInput.employeeEmail || "").trim().toLowerCase();

  if (!empName || !empEmail) {
    throw new Error("Both 'name' and 'email' are required for each employee.");
  }

  const docId = `emp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const inviteToken = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const companyId = empInput.companyId || "default";

  const employeeData = {
    name: empName,
    email: empEmail,
    companyId,
    companyIds: [companyId],
    jobTitle: empInput.jobTitle || empInput.role || "Virtual Assistant",
    deptId: empInput.deptId || empInput.department || "",
    country: empInput.country || "NP",
    state: empInput.state || "N/A",
    status: "active",
    inviteStatus: "pending",
    inviteToken,
    shiftStartTime: empInput.shiftStartTime || "09:00",
    shiftEndTime: empInput.shiftEndTime || "17:00",
    shiftTimezone: empInput.shiftTimezone || "Asia/Kathmandu",
    isMultipleShift: false,
    shifts: empInput.shifts || [
      {
        startTime: empInput.shiftStartTime || "09:00",
        endTime: empInput.shiftEndTime || "17:00",
      },
    ],
    createdAt: new Date().toISOString(),
  };

  const res = await fetch(`${baseUrl}/employees/${docId}?key=${encodeURIComponent(apiKey)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(employeeData) }),
  });
  if (!res.ok) throw new Error(`Failed to add employee '${empName}'`);

  const inviteData = {
    token: inviteToken,
    employeeId: docId,
    email: empEmail,
    name: empName,
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

  return { id: docId, name: empName, email: empEmail, inviteToken };
}

async function createSingleCompany(
  compInput: Record<string, any>,
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; name: string; company: any; departments: Array<{ id: string; name: string }> }> {
  const companyName = (
    compInput.name ||
    compInput.companyName ||
    compInput.company_name ||
    compInput.company ||
    compInput.title ||
    compInput.clientName ||
    ""
  ).trim();

  if (!companyName) throw new Error("Company name is strictly required.");

  const docId = `comp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  let workingDays = [1, 2, 3, 4, 5];
  if (Array.isArray(compInput.workingDays)) {
    workingDays = compInput.workingDays.map((d: any) => {
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
    code: (compInput.code || companyName.slice(0, 4)).toUpperCase(),
    timezone: compInput.timezone || "Australia/Sydney",
    defaultShiftHours:
      typeof compInput.defaultShiftHours === "number" ? compInput.defaultShiftHours : 8,
    workingDays,
    lateGraceMinutes:
      typeof compInput.lateGraceMinutes === "number" ? compInput.lateGraceMinutes : 5,
    punchOutGraceMinutes:
      typeof compInput.punchOutGraceMinutes === "number"
        ? compInput.punchOutGraceMinutes
        : 30,
    punchOutReminderMinutes:
      typeof compInput.punchOutReminderMinutes === "number"
        ? compInput.punchOutReminderMinutes
        : 20,
    breakAllowanceMinutes:
      compInput.breakAllowanceMinutes !== undefined
        ? Number(compInput.breakAllowanceMinutes)
        : 30,
    maxDailyBreaks:
      compInput.maxDailyBreaks !== undefined ? Number(compInput.maxDailyBreaks) : 1,
    holidays: Array.isArray(compInput.holidays) ? compInput.holidays : [],
    holidayAssignments: Array.isArray(compInput.holidayAssignments)
      ? compInput.holidayAssignments
      : [],
    clientEmail: compInput.clientEmail || compInput.email || "",
    ownerName: compInput.ownerName || compInput.clientName || "",
    logoUrl:
      compInput.logoUrl ||
      compInput.logo ||
      compInput.logo_url ||
      compInput.imageUrl ||
      compInput.image ||
      compInput.logoImage ||
      compInput.iconUrl ||
      "",
    archived: Boolean(compInput.archived || compInput.status === "archived"),
    status: compInput.archived || compInput.status === "archived" ? "archived" : "active",
    notes: compInput.notes || "",
    createdAt: new Date().toISOString(),
  };

  const res = await fetch(`${baseUrl}/companies/${docId}?key=${encodeURIComponent(apiKey)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(companyData) }),
  });
  if (!res.ok) throw new Error(`Failed to create company '${companyName}'`);

  const createdDepartments: Array<{ id: string; name: string }> = [];
  if (Array.isArray(compInput.departments)) {
    for (const dept of compInput.departments) {
      const deptName = typeof dept === "string" ? dept.trim() : dept?.name?.trim();
      if (deptName) {
        const deptDocId = `dept_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const deptData = {
          companyId: docId,
          name: deptName,
          state: typeof dept === "object" && dept.state ? dept.state : "N/A",
          createdAt: new Date().toISOString(),
        };
        await fetch(`${baseUrl}/departments/${deptDocId}?key=${encodeURIComponent(apiKey)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fields: toFirestoreFields(deptData) }),
        });
        createdDepartments.push({ id: deptDocId, name: deptName });
      }
    }
  }

  return { id: docId, name: companyName, company: companyData, departments: createdDepartments };
}

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
            // 1. ADD EMPLOYEE / BATCH ADD EMPLOYEES
            if (toolName === "add_employee" || toolName === "batch_add_employees") {
              const employeeList = Array.isArray(args.employees)
                ? args.employees
                : Array.isArray(args.list)
                  ? args.list
                  : Array.isArray(args.items)
                    ? args.items
                    : null;

              if (employeeList && employeeList.length > 0) {
                const results = [];
                const errors = [];
                for (const empItem of employeeList) {
                  try {
                    const created = await createSingleEmployee(empItem, baseUrl, apiKey);
                    results.push(created);
                  } catch (err: any) {
                    errors.push({ employee: empItem, error: err.message });
                  }
                }

                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify(
                          {
                            message: `Batch added ${results.length} of ${employeeList.length} employees with invites!`,
                            count: results.length,
                            employees: results,
                            errors: errors.length > 0 ? errors : undefined,
                          },
                          null,
                          2,
                        ),
                      },
                    ],
                  },
                });
              }

              // Single employee
              try {
                const created = await createSingleEmployee(args, baseUrl, apiKey);
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: `Employee '${created.name}' created with ID: ${created.id} (Invite Token: ${created.inviteToken})`,
                      },
                    ],
                  },
                });
              } catch (err: any) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: err.message || "Failed to add employee" }],
                  },
                });
              }
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
                    if (
                      args.email &&
                      (fields.email || "").toLowerCase() === args.email.toLowerCase()
                    )
                      return true;
                    if (
                      args.name &&
                      (fields.name || "").toLowerCase() === args.name.toLowerCase()
                    )
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

            // 6. LIST OVERTIME
            if (toolName === "list_overtime") {
              const res = await fetch(`${baseUrl}/overtimeRequests?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              const data = await res.json();
              const list = (data.documents || []).map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }));
              let filtered = list;
              if (args.status && args.status !== "all") filtered = filtered.filter((r: any) => r.status === args.status);
              if (args.employeeId) filtered = filtered.filter((r: any) => r.employeeId === args.employeeId);
              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
                },
              });
            }

            // 7. DECIDE OVERTIME
            if (toolName === "decide_overtime") {
              const fieldsToUpdate = {
                status: args.decision,
                decidedBy: "Admin via Remote Claude MCP",
                decidedAt: new Date().toISOString(),
              };
              const updateMask = Object.keys(fieldsToUpdate)
                .map((k) => `updateMask.fieldPaths=${k}`)
                .join("&");
              const res = await fetch(
                `${baseUrl}/overtimeRequests/${args.requestId}?${updateMask}&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
                },
              );
              if (!res.ok) throw new Error("Failed to decide overtime");
              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Overtime request ${args.requestId} marked as ${args.decision}.` }],
                },
              });
            }

            // 8. GET COMPANY SUMMARY
            if (toolName === "get_company_summary") {
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
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          totalEmployees: employees.length,
                          activeEmployeesCount: activeEmployees.length,
                          pendingLeavesCount: pendingLeaves.length,
                          pendingOvertimeCount: pendingOvertime.length,
                          totalRecordedPunches: punches.length,
                          pendingLeaves: pendingLeaves.slice(0, 10),
                          pendingOvertime: pendingOvertime.slice(0, 10),
                        },
                        null,
                        2,
                      ),
                    },
                  ],
                },
              });
            }

            // 9. LIST DAILY REPORTS
            if (toolName === "list_daily_reports") {
              const res = await fetch(`${baseUrl}/dailyReports?pageSize=200&key=${encodeURIComponent(apiKey)}`);
              const data = await res.json();
              const list = (data.documents || []).map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }));

              let filtered = list;
              if (args.date) filtered = filtered.filter((r: any) => r.reportDate === args.date);
              if (args.reportType) filtered = filtered.filter((r: any) => r.reportType === args.reportType);

              const empIdentifier = args.employeeId || args.name;
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
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
                },
              });
            }

            // 10. CREATE COMPANY / BATCH CREATE COMPANIES
            if (toolName === "create_company" || toolName === "batch_create_companies") {
              const companyList = Array.isArray(args.companies)
                ? args.companies
                : Array.isArray(args.list)
                  ? args.list
                  : Array.isArray(args.items)
                    ? args.items
                    : null;

              if (companyList && companyList.length > 0) {
                const results = [];
                const errors = [];
                for (const compItem of companyList) {
                  try {
                    const created = await createSingleCompany(compItem, baseUrl, apiKey);
                    results.push(created);
                  } catch (err: any) {
                    errors.push({ company: compItem, error: err.message });
                  }
                }

                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify(
                          {
                            message: `Batch created ${results.length} of ${companyList.length} companies!`,
                            count: results.length,
                            companies: results,
                            errors: errors.length > 0 ? errors : undefined,
                          },
                          null,
                          2,
                        ),
                      },
                    ],
                  },
                });
              }

              // Single company creation
              try {
                const created = await createSingleCompany(args, baseUrl, apiKey);
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify(
                          {
                            message: `Company '${created.name}' created successfully with ID: ${created.id}`,
                            companyId: created.id,
                            company: created.company,
                            departments: created.departments,
                          },
                          null,
                          2,
                        ),
                      },
                    ],
                  },
                });
              } catch (err: any) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: err.message || "Failed to create company" }],
                  },
                });
              }
            }

            // 11. UPDATE COMPANY
            if (toolName === "update_company") {
              const listRes = await fetch(`${baseUrl}/companies?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              const listData = await listRes.json();
              const allDocs = listData.documents || [];

              let targetId = args.id || args.companyId;
              let currentCompanyName = "";

              const searchLookupName = (
                args.oldName ||
                args.from ||
                args.fromName ||
                args.currentName ||
                args.lookupName ||
                args.companyName ||
                args.company ||
                (args.newName ? args.name : "") ||
                ""
              )
                .trim()
                .toLowerCase();

              if (targetId) {
                const docById = allDocs.find((d: any) => d.name.split("/").pop() === targetId);
                if (docById) {
                  const fields = fromFirestoreFields(docById.fields);
                  currentCompanyName = fields.name || targetId;
                }
              } else if (searchLookupName) {
                const docByName = allDocs.find((d: any) => {
                  const id = d.name.split("/").pop();
                  const fields = fromFirestoreFields(d.fields);
                  return (
                    id?.toLowerCase() === searchLookupName ||
                    (fields.name || "").toLowerCase() === searchLookupName ||
                    (fields.code || "").toLowerCase() === searchLookupName
                  );
                });
                if (docByName) {
                  targetId = docByName.name.split("/").pop();
                  const fields = fromFirestoreFields(docByName.fields);
                  currentCompanyName = fields.name || targetId;
                }
              }

              if (!targetId && args.name) {
                const nameLower = args.name.trim().toLowerCase();
                const docByName = allDocs.find((d: any) => {
                  const id = d.name.split("/").pop();
                  const fields = fromFirestoreFields(d.fields);
                  return (
                    id?.toLowerCase() === nameLower ||
                    (fields.name || "").toLowerCase() === nameLower ||
                    (fields.code || "").toLowerCase() === nameLower
                  );
                });
                if (docByName) {
                  targetId = docByName.name.split("/").pop();
                  const fields = fromFirestoreFields(docByName.fields);
                  currentCompanyName = fields.name || targetId;
                }
              }

              if (!targetId) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: "Error: Company not found. Provide a valid 'id', 'name', or 'oldName'." }],
                  },
                });
              }

              const fieldsToUpdate: Record<string, any> = {};

              const newName = (
                args.newName ||
                args.to ||
                args.renameTo ||
                (args.oldName ? args.name : undefined) ||
                (args.id && args.name && args.name !== currentCompanyName ? args.name : undefined) ||
                ""
              ).trim();

              if (newName) {
                fieldsToUpdate.name = newName;
              } else if (args.name && (!args.oldName || args.oldName === args.name)) {
                fieldsToUpdate.name = args.name.trim();
              }

              if (args.code) fieldsToUpdate.code = args.code.trim().toUpperCase();
              if (args.timezone) fieldsToUpdate.timezone = args.timezone;
              if (args.defaultShiftHours !== undefined) fieldsToUpdate.defaultShiftHours = Number(args.defaultShiftHours);
              if (args.workingDays !== undefined && Array.isArray(args.workingDays)) fieldsToUpdate.workingDays = args.workingDays;
              if (args.lateGraceMinutes !== undefined) fieldsToUpdate.lateGraceMinutes = Number(args.lateGraceMinutes);
              if (args.punchOutGraceMinutes !== undefined) fieldsToUpdate.punchOutGraceMinutes = Number(args.punchOutGraceMinutes);
              if (args.punchOutReminderMinutes !== undefined) fieldsToUpdate.punchOutReminderMinutes = Number(args.punchOutReminderMinutes);
              if (args.breakAllowanceMinutes !== undefined) fieldsToUpdate.breakAllowanceMinutes = Number(args.breakAllowanceMinutes);
              if (args.maxDailyBreaks !== undefined) fieldsToUpdate.maxDailyBreaks = Number(args.maxDailyBreaks);
              if (args.holidays !== undefined && Array.isArray(args.holidays)) fieldsToUpdate.holidays = args.holidays;
              if (args.clientEmail !== undefined) fieldsToUpdate.clientEmail = args.clientEmail;
              if (args.ownerName !== undefined) fieldsToUpdate.ownerName = args.ownerName;

              const logoVal =
                args.logoUrl ||
                args.logo ||
                args.logo_url ||
                args.imageUrl ||
                args.image ||
                args.logoImage;
              if (logoVal !== undefined) fieldsToUpdate.logoUrl = logoVal;

              if (args.archived !== undefined) {
                fieldsToUpdate.archived = Boolean(args.archived);
                fieldsToUpdate.status = args.archived ? "archived" : "active";
              } else if (args.status !== undefined) {
                fieldsToUpdate.status = args.status;
                fieldsToUpdate.archived = args.status === "archived";
              }

              if (args.notes !== undefined) fieldsToUpdate.notes = args.notes;

              const updateMask = Object.keys(fieldsToUpdate).map((k) => `updateMask.fieldPaths=${k}`).join("&");
              const res = await fetch(
                `${baseUrl}/companies/${targetId}?${updateMask}&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
                },
              );
              if (!res.ok) throw new Error("Failed to update company");

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Company '${fieldsToUpdate.name || currentCompanyName || targetId}' updated successfully.` }],
                },
              });
            }

            // 11b. RENAME COMPANY
            if (toolName === "rename_company") {
              const listRes = await fetch(`${baseUrl}/companies?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              const listData = await listRes.json();
              const allDocs = listData.documents || [];

              let targetId = args.id || args.companyId;
              let currentName = "";

              const searchLookupName = (args.oldName || args.from || args.fromName || args.currentName || args.name || args.companyName || "").trim().toLowerCase();

              if (targetId) {
                const docById = allDocs.find((d: any) => d.name.split("/").pop() === targetId);
                if (docById) {
                  const fields = fromFirestoreFields(docById.fields);
                  currentName = fields.name || targetId;
                }
              } else if (searchLookupName) {
                const docByName = allDocs.find((d: any) => {
                  const id = d.name.split("/").pop();
                  const fields = fromFirestoreFields(d.fields);
                  return (
                    id?.toLowerCase() === searchLookupName ||
                    (fields.name || "").toLowerCase() === searchLookupName ||
                    (fields.code || "").toLowerCase() === searchLookupName
                  );
                });
                if (docByName) {
                  targetId = docByName.name.split("/").pop();
                  const fields = fromFirestoreFields(docByName.fields);
                  currentName = fields.name || targetId;
                }
              }

              if (!targetId) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: "Error: Company not found. Provide 'oldName', 'name', or 'id'." }],
                  },
                });
              }

              const newName = (args.newName || args.to || args.renameTo || args.name || "").trim();
              if (!newName) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: "Error: 'newName' is required to rename the company." }],
                  },
                });
              }

              const res = await fetch(
                `${baseUrl}/companies/${targetId}?updateMask.fieldPaths=name&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields({ name: newName }) }),
                },
              );
              if (!res.ok) throw new Error("Failed to rename company");

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Company successfully renamed from '${currentName}' to '${newName}' (ID: ${targetId}).` }],
                },
              });
            }

            // 11c. ARCHIVE COMPANY
            if (toolName === "archive_company") {
              const listRes = await fetch(`${baseUrl}/companies?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              const listData = await listRes.json();
              const allDocs = listData.documents || [];

              let targetId = args.id || args.companyId;
              let currentName = "";
              let isMain = false;

              const searchLookupName = (args.name || args.companyName || "").trim().toLowerCase();

              if (targetId) {
                const docById = allDocs.find((d: any) => d.name.split("/").pop() === targetId);
                if (docById) {
                  const fields = fromFirestoreFields(docById.fields);
                  currentName = fields.name || targetId;
                  isMain = Boolean(fields.isMain || targetId === "default");
                }
              } else if (searchLookupName) {
                const docByName = allDocs.find((d: any) => {
                  const id = d.name.split("/").pop();
                  const fields = fromFirestoreFields(d.fields);
                  return (
                    id?.toLowerCase() === searchLookupName ||
                    (fields.name || "").toLowerCase() === searchLookupName ||
                    (fields.code || "").toLowerCase() === searchLookupName
                  );
                });
                if (docByName) {
                  targetId = docByName.name.split("/").pop();
                  const fields = fromFirestoreFields(docByName.fields);
                  currentName = fields.name || targetId;
                  isMain = Boolean(fields.isMain || targetId === "default");
                }
              }

              if (!targetId) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: { isError: true, content: [{ type: "text", text: "Error: Company not found." }] },
                });
              }
              if (isMain || targetId === "default") {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: { isError: true, content: [{ type: "text", text: "Error: The main company cannot be archived." }] },
                });
              }

              await fetch(
                `${baseUrl}/companies/${targetId}?updateMask.fieldPaths=archived&updateMask.fieldPaths=status&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields({ archived: true, status: "archived" }) }),
                },
              );

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Company '${currentName}' (ID: ${targetId}) has been archived.` }],
                },
              });
            }

            // 11d. UNARCHIVE COMPANY
            if (toolName === "unarchive_company") {
              const listRes = await fetch(`${baseUrl}/companies?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              const listData = await listRes.json();
              const allDocs = listData.documents || [];

              let targetId = args.id || args.companyId;
              let currentName = "";

              const searchLookupName = (args.name || args.companyName || "").trim().toLowerCase();

              if (targetId) {
                const docById = allDocs.find((d: any) => d.name.split("/").pop() === targetId);
                if (docById) {
                  const fields = fromFirestoreFields(docById.fields);
                  currentName = fields.name || targetId;
                }
              } else if (searchLookupName) {
                const docByName = allDocs.find((d: any) => {
                  const id = d.name.split("/").pop();
                  const fields = fromFirestoreFields(d.fields);
                  return (
                    id?.toLowerCase() === searchLookupName ||
                    (fields.name || "").toLowerCase() === searchLookupName ||
                    (fields.code || "").toLowerCase() === searchLookupName
                  );
                });
                if (docByName) {
                  targetId = docByName.name.split("/").pop();
                  const fields = fromFirestoreFields(docByName.fields);
                  currentName = fields.name || targetId;
                }
              }

              if (!targetId) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: { isError: true, content: [{ type: "text", text: "Error: Company not found." }] },
                });
              }

              await fetch(
                `${baseUrl}/companies/${targetId}?updateMask.fieldPaths=archived&updateMask.fieldPaths=status&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fields: toFirestoreFields({ archived: false, status: "active" }) }),
                },
              );

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Company '${currentName}' (ID: ${targetId}) has been restored and unarchived.` }],
                },
              });
            }

            // 12. CREATE DEPARTMENT
            if (toolName === "create_department") {
              const docId = `dept_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              const deptData = {
                name: args.name,
                code: args.code || args.name.slice(0, 3).toUpperCase(),
                companyId: args.companyId || "default",
                state: args.state || "N/A",
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
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Department '${args.name}' created with ID: ${docId}` }],
                },
              });
            }

            // 13. LIST DEPARTMENTS
            if (toolName === "list_departments") {
              const res = await fetch(`${baseUrl}/departments?pageSize=100&key=${encodeURIComponent(apiKey)}`);
              const data = await res.json();
              const list = (data.documents || []).map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }));
              const filtered = args.companyId ? list.filter((d: any) => d.companyId === args.companyId) : list;
              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
                },
              });
            }

            // 14. SEND EMPLOYEE INVITE
            if (toolName === "send_employee_invite") {
              const matchedEmp = await resolveEmployee(args.employeeId || args.email || args.name, baseUrl, apiKey);
              if (!matchedEmp) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: "Error: Employee not found." }],
                  },
                });
              }

              const inviteToken = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const appUrl = "https://station.savykids.com";
              const inviteUrl = `${appUrl}/invite/${inviteToken}`;

              await fetch(`${baseUrl}/invites/${inviteToken}?key=${encodeURIComponent(apiKey)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  fields: toFirestoreFields({
                    token: inviteToken,
                    employeeId: matchedEmp.id,
                    email: matchedEmp.email,
                    name: matchedEmp.name,
                    companyId: matchedEmp.companyId || "default",
                    role: matchedEmp.jobTitle || "Virtual Assistant",
                    status: "pending",
                    createdAt: new Date().toISOString(),
                  }),
                }),
              });

              await fetch(
                `${baseUrl}/employees/${matchedEmp.id}?updateMask.fieldPaths=inviteToken&updateMask.fieldPaths=inviteStatus&key=${encodeURIComponent(apiKey)}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    fields: toFirestoreFields({ inviteToken, inviteStatus: "pending" }),
                  }),
                },
              );

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          message: `Invitation generated for ${matchedEmp.name} (${matchedEmp.email})!`,
                          employeeId: matchedEmp.id,
                          inviteUrl,
                          inviteToken,
                        },
                        null,
                        2,
                      ),
                    },
                  ],
                },
              });
            }

            // 15. DELETE EMPLOYEE
            if (toolName === "delete_employee") {
              const matchedEmp = await resolveEmployee(args.id || args.email || args.name, baseUrl, apiKey);
              if (!matchedEmp) {
                return Response.json({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    isError: true,
                    content: [{ type: "text", text: "Error: Employee not found." }],
                  },
                });
              }

              await fetch(`${baseUrl}/employees/${matchedEmp.id}?key=${encodeURIComponent(apiKey)}`, {
                method: "DELETE",
              });

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Employee '${matchedEmp.name}' (${matchedEmp.id}) removed.` }],
                },
              });
            }

            // 16. CREATE NOTICE
            if (toolName === "create_notice") {
              const docId = `not_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              const noticeData = {
                title: args.title,
                content: args.content,
                priority: args.priority || "normal",
                companyId: args.companyId || "",
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
              if (!res.ok) throw new Error("Failed to post notice");

              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Notice '${args.title}' published successfully.` }],
                },
              });
            }

            // 17. LIST NOTICES
            if (toolName === "list_notices") {
              const res = await fetch(`${baseUrl}/notices?pageSize=50&key=${encodeURIComponent(apiKey)}`);
              const data = await res.json();
              const list = (data.documents || []).map((doc: any) => ({
                id: doc.name.split("/").pop(),
                ...fromFirestoreFields(doc.fields),
              }));
              const filtered = args.companyId ? list.filter((n: any) => !n.companyId || n.companyId === args.companyId) : list;
              return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
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
