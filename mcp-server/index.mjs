#!/usr/bin/env node
/**
 * SavyTimes Admin Model Context Protocol (MCP) Server
 * Enables Claude, ChatGPT, Cursor, and AI agents to manage employees, companies,
 * shifts, punches, leaves, overtime approvals, and dispatch reports automatically.
 */

import readline from "node:readline";

const FIREBASE_PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID || "runner-man-634be";
const FIREBASE_API_KEY =
  process.env.VITE_FIREBASE_API_KEY || "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Helper: Convert JS object to Firestore Fields JSON
function toFirestoreFields(obj) {
  const fields = {};
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
            if (typeof item === "object") return { mapValue: { fields: toFirestoreFields(item) } };
            return { stringValue: String(item) };
          }),
        },
      };
    } else if (typeof value === "object") {
      fields[key] = { mapValue: { fields: toFirestoreFields(value) } };
    }
  }
  return fields;
}

// Helper: Convert Firestore Fields to plain JS object
function fromFirestoreFields(fields) {
  if (!fields) return {};
  const obj = {};
  for (const [key, value] of Object.entries(fields)) {
    if ("stringValue" in value) obj[key] = value.stringValue;
    else if ("integerValue" in value) obj[key] = parseInt(value.integerValue, 10);
    else if ("doubleValue" in value) obj[key] = value.doubleValue;
    else if ("booleanValue" in value) obj[key] = value.booleanValue;
    else if ("nullValue" in value) obj[key] = null;
    else if ("arrayValue" in value) {
      obj[key] = (value.arrayValue.values || []).map((v) => {
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

// List of available MCP tools
const TOOLS = [
  // 1. Employee Management
  {
    name: "add_employee",
    description:
      "Add a single employee or Virtual Assistant (V.A.) to SavyTimes with their shift schedule, company membership, country, and department. Can also accept a list in 'employees'.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name of the employee or V.A." },
        email: { type: "string", description: "Email address of the employee" },
        companyId: {
          type: "string",
          description: "Company ID to assign to (defaults to 'default')",
        },
        jobTitle: {
          type: "string",
          description: "Job title (e.g. 'Virtual Assistant', 'Developer', 'Support Specialist')",
        },
        deptId: { type: "string", description: "Department ID or name" },
        country: {
          type: "string",
          enum: ["NP", "AU", "PH"],
          description: "Country code: NP (Nepal), AU (Australia), PH (Philippines)",
        },
        state: { type: "string", description: "State or province (optional)" },
        shiftStartTime: {
          type: "string",
          description: "Shift start time in HH:mm format (e.g. '09:00')",
        },
        shiftEndTime: {
          type: "string",
          description: "Shift end time in HH:mm format (e.g. '17:00')",
        },
        shiftTimezone: {
          type: "string",
          description: "Timezone for shifts (e.g. 'Australia/Sydney', 'Asia/Kathmandu')",
        },
        employees: {
          type: "array",
          description: "Optional list of employees to add in batch",
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
    description: "List all employees and Virtual Assistants in SavyTimes with their details.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional filter by company ID" },
      },
    },
  },
  {
    name: "update_employee",
    description:
      "Update details, shift times, status, regular hours, or company of an existing employee.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Employee document ID" },
        name: { type: "string" },
        email: { type: "string" },
        jobTitle: { type: "string" },
        status: { type: "string", enum: ["active", "inactive"] },
        companyId: { type: "string" },
        shiftStartTime: { type: "string" },
        shiftEndTime: { type: "string" },
        shiftTimezone: { type: "string" },
        isMultipleShift: { type: "boolean" },
        shifts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startTime: { type: "string" },
              endTime: { type: "string" },
            },
          },
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_employee",
    description: "Delete or deactivate an employee from SavyTimes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Employee document ID" },
      },
      required: ["id"],
    },
  },

  // 2. Company & Client Management
  {
    name: "list_companies",
    description: "List all registered client companies in SavyTimes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_company",
    description:
      "Create a new client company profile in SavyTimes with full configuration (timezone, working days, default shift hours, break allowance, max daily breaks, grace minutes, holiday rules, and optional initial departments).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Company name (e.g. 'Ironbrij', 'Acme Corp')" },
        code: { type: "string", description: "Short identifier or code (e.g. 'IRON')" },
        timezone: { type: "string", description: "Primary company timezone (e.g. 'Australia/Sydney', 'Asia/Kathmandu')" },
        defaultShiftHours: { type: "number", description: "Default daily shift hours (e.g. 8)" },
        workingDays: {
          type: "array",
          items: { type: "number" },
          description: "Working days array where 0=Sun, 1=Mon..6=Sat (defaults to [1, 2, 3, 4, 5])",
        },
        lateGraceMinutes: { type: "number", description: "Grace minutes allowed before lateness starts (default 5)" },
        punchOutGraceMinutes: { type: "number", description: "Grace period in minutes after shift end before auto punch-out (default 30)" },
        punchOutReminderMinutes: { type: "number", description: "Minutes before shift end to send reminder email (default 20)" },
        breakAllowanceMinutes: { type: "number", description: "Break duration in minutes (e.g. 30, or 0 for N/A / no break)" },
        maxDailyBreaks: { type: "number", description: "Maximum breaks per shift (default 1, or 0 for N/A / no breaks)" },
        holidays: { type: "array", items: { type: "string" }, description: "Array of holiday dates in YYYY-MM-DD format" },
        clientEmail: { type: "string", description: "Client contact email" },
        ownerName: { type: "string", description: "Owner or manager name" },
        logoUrl: { type: "string", description: "Company logo URL" },
        notes: { type: "string", description: "Internal notes" },
        departments: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of initial department names to create (e.g. ['Operations', 'Accounts'])",
        },
        companies: {
          type: "array",
          description: "Optional list of multiple companies to create in batch",
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
    description: "Update company details, logo, timezone, working days, break rules, or grace minutes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company document ID or name" },
        companyId: { type: "string", description: "Company document ID" },
        name: { type: "string" },
        oldName: { type: "string", description: "Previous company name to look up" },
        newName: { type: "string", description: "New company name to apply" },
        code: { type: "string" },
        timezone: { type: "string" },
        defaultShiftHours: { type: "number" },
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
        logo: { type: "string", description: "Company logo URL alias" },
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
        id: { type: "string", description: "Company ID (e.g. 'comp_123' or 'default')" },
        companyId: { type: "string", description: "Company ID" },
        name: { type: "string", description: "Company name to look up" },
        oldName: { type: "string", description: "Current company name to look up" },
        newName: { type: "string", description: "New company name" },
        to: { type: "string", description: "New company name" },
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
        id: { type: "string", description: "Company ID" },
        companyId: { type: "string", description: "Company ID" },
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
        id: { type: "string", description: "Company ID" },
        companyId: { type: "string", description: "Company ID" },
        name: { type: "string", description: "Company name to restore" },
      },
    },
  },

  // 3. Punch & Attendance Management (Fix missed punches, edit intervals)
  {
    name: "list_punches",
    description: "Fetch punch logs for an employee, company, or date range.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        companyId: { type: "string" },
      },
    },
  },
  {
    name: "add_or_fix_punch",
    description: "Add a manual punch-in/out or fix a missed punch out for an employee.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        employeeName: { type: "string" },
        companyId: { type: "string" },
        type: { type: "string", enum: ["in", "out", "extra_in", "extra_out"] },
        timestampISO: {
          type: "string",
          description: "ISO date timestamp string (e.g. '2026-08-12T17:00:00Z')",
        },
        source: { type: "string", enum: ["app", "auto"], description: "Source of punch" },
      },
      required: ["employeeId", "type", "timestampISO"],
    },
  },

  // 4. Leave Management
  {
    name: "list_leaves",
    description: "List leave requests with optional status filtering.",
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
        decidedBy: { type: "string", description: "Admin name or email" },
      },
      required: ["leaveId", "decision"],
    },
  },
];

// Helper: Create single employee
async function createSingleEmployee(empInput) {
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
    jobTitle: empInput.jobTitle || "Virtual Assistant",
    deptId: empInput.deptId || "",
    country: empInput.country || "NP",
    state: empInput.state || "N/A",
    status: "active",
    inviteStatus: "pending",
    inviteToken,
    shiftStartTime: empInput.shiftStartTime || "09:00",
    shiftEndTime: empInput.shiftEndTime || "17:00",
    shiftTimezone: empInput.shiftTimezone || "Asia/Kathmandu",
    isMultipleShift: Boolean(empInput.isMultipleShift),
    shifts: empInput.shifts || [
      { startTime: empInput.shiftStartTime || "09:00", endTime: empInput.shiftEndTime || "17:00" },
    ],
    createdAt: new Date().toISOString(),
  };

  const res = await fetch(
    `${FIRESTORE_BASE_URL}/employees/${docId}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: toFirestoreFields(employeeData) }),
    },
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `Failed to create employee '${empName}'`);
  }

  return { id: docId, name: empName, email: empEmail, inviteToken, employee: employeeData };
}

// Helper: Create single company
async function createSingleCompany(compInput) {
  const companyName = (
    compInput.name ||
    compInput.companyName ||
    compInput.company_name ||
    compInput.company ||
    compInput.title ||
    compInput.clientName ||
    ""
  ).trim();

  if (!companyName) {
    throw new Error("Company name is strictly required.");
  }

  const docId = `comp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  let workingDays = [1, 2, 3, 4, 5];
  if (Array.isArray(compInput.workingDays)) {
    workingDays = compInput.workingDays.map((d) => {
      if (typeof d === "number") return d;
      const lower = String(d).toLowerCase().slice(0, 3);
      const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      return map[lower] !== undefined ? map[lower] : 1;
    });
  }

  const companyData = {
    name: companyName,
    code: (compInput.code || companyName.slice(0, 4)).toUpperCase(),
    timezone: compInput.timezone || "Australia/Sydney",
    defaultShiftHours: typeof compInput.defaultShiftHours === "number" ? compInput.defaultShiftHours : 8,
    workingDays,
    lateGraceMinutes: typeof compInput.lateGraceMinutes === "number" ? compInput.lateGraceMinutes : 5,
    punchOutGraceMinutes: typeof compInput.punchOutGraceMinutes === "number" ? compInput.punchOutGraceMinutes : 30,
    punchOutReminderMinutes: typeof compInput.punchOutReminderMinutes === "number" ? compInput.punchOutReminderMinutes : 20,
    breakAllowanceMinutes: compInput.breakAllowanceMinutes !== undefined ? Number(compInput.breakAllowanceMinutes) : 30,
    maxDailyBreaks: compInput.maxDailyBreaks !== undefined ? Number(compInput.maxDailyBreaks) : 1,
    holidays: Array.isArray(compInput.holidays) ? compInput.holidays : [],
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

  const res = await fetch(
    `${FIRESTORE_BASE_URL}/companies/${docId}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: toFirestoreFields(companyData) }),
    },
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `Failed to create company '${companyName}'`);
  }

  // Auto-create departments if specified
  const createdDepartments = [];
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
        await fetch(
          `${FIRESTORE_BASE_URL}/departments/${deptDocId}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
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

  return { id: docId, name: companyName, company: companyData, departments: createdDepartments };
}

// Tool Executors
async function executeTool(name, args) {
  // 1. Add Employee / Batch Add Employees
  if (name === "add_employee" || name === "batch_add_employees") {
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
          const created = await createSingleEmployee(empItem);
          results.push(created);
        } catch (err) {
          errors.push({ employee: empItem, error: err.message });
        }
      }

      return {
        success: errors.length === 0 || results.length > 0,
        message: `Batch added ${results.length} of ${employeeList.length} employees with invites!`,
        count: results.length,
        employees: results,
        errors: errors.length > 0 ? errors : undefined,
      };
    }

    const created = await createSingleEmployee(args);
    return {
      success: true,
      message: `Employee '${created.name}' successfully added to SavyTimes!`,
      employeeId: created.id,
      inviteToken: created.inviteToken,
      data: created.employee,
    };
  }

  // 2. List Employees
  if (name === "list_employees") {
    const res = await fetch(
      `${FIRESTORE_BASE_URL}/employees?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to fetch employees");
    }
    const data = await res.json();
    const list = (data.documents || []).map((doc) => {
      const id = doc.name.split("/").pop();
      return { id, ...fromFirestoreFields(doc.fields) };
    });

    const filtered = args.companyId
      ? list.filter((e) => e.companyId === args.companyId || e.companyIds?.includes(args.companyId))
      : list;

    return {
      success: true,
      count: filtered.length,
      employees: filtered,
    };
  }

  // 3. Update Employee
  if (name === "update_employee") {
    const { id, ...fieldsToUpdate } = args;
    const updateMask = Object.keys(fieldsToUpdate)
      .map((k) => `updateMask.fieldPaths=${k}`)
      .join("&");

    const res = await fetch(
      `${FIRESTORE_BASE_URL}/employees/${id}?${updateMask}&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
      },
    );

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to update employee");
    }

    return {
      success: true,
      message: `Employee '${id}' updated successfully.`,
      updatedFields: fieldsToUpdate,
    };
  }

  // 4. Delete Employee
  if (name === "delete_employee") {
    const res = await fetch(
      `${FIRESTORE_BASE_URL}/employees/${args.id}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to delete employee");
    }
    return { success: true, message: `Employee '${args.id}' deleted.` };
  }

  // 5. List Companies
  if (name === "list_companies") {
    const res = await fetch(
      `${FIRESTORE_BASE_URL}/companies?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to fetch companies");
    }
    const data = await res.json();
    const list = (data.documents || []).map((doc) => {
      const id = doc.name.split("/").pop();
      return { id, ...fromFirestoreFields(doc.fields) };
    });

    return { success: true, count: list.length, companies: list };
  }

  // 6. Create Company / Batch Create Companies
  if (name === "create_company" || name === "batch_create_companies") {
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
          const created = await createSingleCompany(compItem);
          results.push(created);
        } catch (err) {
          errors.push({ company: compItem, error: err.message });
        }
      }

      return {
        success: errors.length === 0 || results.length > 0,
        message: `Batch created ${results.length} of ${companyList.length} companies!`,
        count: results.length,
        companies: results,
        errors: errors.length > 0 ? errors : undefined,
      };
    }

    const created = await createSingleCompany(args);
    return {
      success: true,
      message: `Company '${created.name}' created successfully with ID: ${created.id}`,
      companyId: created.id,
      company: created.company,
      departments: created.departments,
    };
  }

  // 7. Update Company
  if (name === "update_company") {
    const listRes = await fetch(`${FIRESTORE_BASE_URL}/companies?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`);
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
      const docById = allDocs.find((d) => d.name.split("/").pop() === targetId);
      if (docById) {
        const fields = fromFirestoreFields(docById.fields);
        currentCompanyName = fields.name || targetId;
      }
    } else if (searchLookupName) {
      const docByName = allDocs.find((d) => {
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
      const docByName = allDocs.find((d) => {
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
      return { success: false, error: "Company not found. Provide a valid 'id', 'name', or 'oldName'." };
    }

    const fieldsToUpdate = {};

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

    const updateMask = Object.keys(fieldsToUpdate)
      .map((k) => `updateMask.fieldPaths=${k}`)
      .join("&");

    const res = await fetch(
      `${FIRESTORE_BASE_URL}/companies/${targetId}?${updateMask}&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
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
    return {
      success: true,
      message: `Company '${fieldsToUpdate.name || currentCompanyName || targetId}' updated.`,
      updatedFields: fieldsToUpdate,
    };
  }

  // 7b. Rename Company
  if (name === "rename_company") {
    const listRes = await fetch(`${FIRESTORE_BASE_URL}/companies?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`);
    const listData = await listRes.json();
    const allDocs = listData.documents || [];

    let targetId = args.id || args.companyId;
    let currentName = "";

    const searchLookupName = (args.oldName || args.from || args.fromName || args.currentName || args.name || args.companyName || "").trim().toLowerCase();

    if (targetId) {
      const docById = allDocs.find((d) => d.name.split("/").pop() === targetId);
      if (docById) {
        const fields = fromFirestoreFields(docById.fields);
        currentName = fields.name || targetId;
      }
    } else if (searchLookupName) {
      const docByName = allDocs.find((d) => {
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
      return { success: false, error: "Company not found. Provide 'oldName', 'name', or 'id'." };
    }

    const newName = (args.newName || args.to || args.renameTo || args.name || "").trim();
    if (!newName) {
      return { success: false, error: "'newName' is required to rename the company." };
    }

    const res = await fetch(
      `${FIRESTORE_BASE_URL}/companies/${targetId}?updateMask.fieldPaths=name&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields({ name: newName }) }),
      },
    );
    if (!res.ok) throw new Error("Failed to rename company");

    return {
      success: true,
      message: `Company successfully renamed from '${currentName}' to '${newName}' (ID: ${targetId}).`,
      companyId: targetId,
      previousName: currentName,
      name: newName,
    };
  }

  // 7c. Archive Company
  if (name === "archive_company") {
    const listRes = await fetch(`${FIRESTORE_BASE_URL}/companies?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`);
    const listData = await listRes.json();
    const allDocs = listData.documents || [];

    let targetId = args.id || args.companyId;
    let currentName = "";
    let isMain = false;

    const searchLookupName = (args.name || args.companyName || "").trim().toLowerCase();

    if (targetId) {
      const docById = allDocs.find((d) => d.name.split("/").pop() === targetId);
      if (docById) {
        const fields = fromFirestoreFields(docById.fields);
        currentName = fields.name || targetId;
        isMain = Boolean(fields.isMain || targetId === "default");
      }
    } else if (searchLookupName) {
      const docByName = allDocs.find((d) => {
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
      return { success: false, error: "Company not found." };
    }
    if (isMain || targetId === "default") {
      return { success: false, error: "The main company cannot be archived." };
    }

    await fetch(
      `${FIRESTORE_BASE_URL}/companies/${targetId}?updateMask.fieldPaths=archived&updateMask.fieldPaths=status&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields({ archived: true, status: "archived" }) }),
      },
    );

    return {
      success: true,
      message: `Company '${currentName}' (ID: ${targetId}) has been archived.`,
      companyId: targetId,
      archived: true,
    };
  }

  // 7d. Unarchive Company
  if (name === "unarchive_company") {
    const listRes = await fetch(`${FIRESTORE_BASE_URL}/companies?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`);
    const listData = await listRes.json();
    const allDocs = listData.documents || [];

    let targetId = args.id || args.companyId;
    let currentName = "";

    const searchLookupName = (args.name || args.companyName || "").trim().toLowerCase();

    if (targetId) {
      const docById = allDocs.find((d) => d.name.split("/").pop() === targetId);
      if (docById) {
        const fields = fromFirestoreFields(docById.fields);
        currentName = fields.name || targetId;
      }
    } else if (searchLookupName) {
      const docByName = allDocs.find((d) => {
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
      return { success: false, error: "Company not found." };
    }

    await fetch(
      `${FIRESTORE_BASE_URL}/companies/${targetId}?updateMask.fieldPaths=archived&updateMask.fieldPaths=status&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields({ archived: false, status: "active" }) }),
      },
    );

    return {
      success: true,
      message: `Company '${currentName}' (ID: ${targetId}) has been restored and unarchived.`,
      companyId: targetId,
      archived: false,
    };
  }

  // 8. List Punches
  if (name === "list_punches") {
    const res = await fetch(
      `${FIRESTORE_BASE_URL}/punches?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to fetch punches");
    }
    const data = await res.json();
    const list = (data.documents || []).map((doc) => {
      const id = doc.name.split("/").pop();
      return { id, ...fromFirestoreFields(doc.fields) };
    });

    let filtered = list;
    if (args.employeeId) filtered = filtered.filter((p) => p.employeeId === args.employeeId);
    if (args.companyId) filtered = filtered.filter((p) => p.companyId === args.companyId);

    return { success: true, count: filtered.length, punches: filtered };
  }

  // 9. Add or Fix Punch
  if (name === "add_or_fix_punch") {
    const docId = `punch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const punchData = {
      employeeId: args.employeeId,
      employeeName: args.employeeName || "",
      companyId: args.companyId || "default",
      type: args.type,
      source: args.source || "app",
      timestamp: {
        seconds: Math.floor(new Date(args.timestampISO).getTime() / 1000),
        nanoseconds: 0,
      },
    };

    const res = await fetch(
      `${FIRESTORE_BASE_URL}/punches/${docId}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields(punchData) }),
      },
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to record punch");
    }
    return { success: true, message: `Punch recorded with ID: ${docId}`, punch: punchData };
  }

  // 10. List Leaves
  if (name === "list_leaves") {
    const res = await fetch(
      `${FIRESTORE_BASE_URL}/leaveRequests?pageSize=100&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to fetch leave requests");
    }
    const data = await res.json();
    const list = (data.documents || []).map((doc) => {
      const id = doc.name.split("/").pop();
      return { id, ...fromFirestoreFields(doc.fields) };
    });

    let filtered = list;
    if (args.status) filtered = filtered.filter((l) => l.status === args.status);
    if (args.employeeId) filtered = filtered.filter((l) => l.employeeId === args.employeeId);

    return { success: true, count: filtered.length, leaves: filtered };
  }

  // 11. Decide Leave
  if (name === "decide_leave") {
    const fieldsToUpdate = {
      status: args.decision,
      paymentStatus: args.paymentStatus || "paid",
      decidedBy: args.decidedBy || "Admin (via AI MCP)",
      decidedAt: new Date().toISOString(),
    };
    const updateMask = Object.keys(fieldsToUpdate)
      .map((k) => `updateMask.fieldPaths=${k}`)
      .join("&");

    const res = await fetch(
      `${FIRESTORE_BASE_URL}/leaveRequests/${args.leaveId}?${updateMask}&key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields(fieldsToUpdate) }),
      },
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Failed to update leave");
    }
    return { success: true, message: `Leave request ${args.leaveId} marked as ${args.decision}.` };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// JSON-RPC 2.0 stdio MCP Server loop
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    const response = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "savytimes-admin-mcp",
          version: "1.0.0",
        },
      },
    };
    process.stdout.write(JSON.stringify(response) + "\n");
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    const response = {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS,
      },
    };
    process.stdout.write(JSON.stringify(response) + "\n");
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      // Validate Token if provided in env
      const adminToken = process.env.SAVYTIMES_ADMIN_TOKEN;
      const masterKey = "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
      if (adminToken && adminToken !== masterKey) {
        const tokenRes = await fetch(
          `${FIRESTORE_BASE_URL}/adminApiTokens/${encodeURIComponent(adminToken)}?key=${encodeURIComponent(
            FIREBASE_API_KEY,
          )}`,
        );
        if (!tokenRes.ok) {
          throw new Error(
            "Unauthorized: Invalid or revoked SAVYTIMES_ADMIN_TOKEN. Please check your key in the Admin AI & MCP tab.",
          );
        }
      }

      const output = await executeTool(toolName, toolArgs);
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(output, null, 2),
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing ${toolName}: ${err.message}`,
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    }
    return;
  }

  // Fallback for unhandled methods
  if (id !== undefined) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      }) + "\n",
    );
  }
});
