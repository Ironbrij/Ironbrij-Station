import type { Department, Employee, MentionItem } from "./types";
import { COMPANY_ID } from "./types";

export interface MentionCandidate {
  id: string; // employeeId or departmentId
  type: "person" | "department";
  name: string;
  displayTag: string; // e.g. "@Bevet Smith" or "@Engineering"
  subtitle?: string; // e.g. "Software Engineer • Engineering" or "Department"
  deptId?: string;
  deptName?: string;
  companyId?: string;
  email?: string;
}

export function sanitizeFirestoreObject<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeFirestoreObject(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] =
        typeof value === "object" && value !== null && !(value instanceof Date) && typeof (value as { toMillis?: unknown }).toMillis !== "function"
          ? sanitizeFirestoreObject(value)
          : value;
    }
  }
  return result as T;
}

export function getUserCompanyIds(employee: Employee | null): Set<string> {
  const set = new Set<string>();
  if (employee?.companyId) set.add(employee.companyId);
  if (Array.isArray(employee?.companyIds)) {
    employee.companyIds.forEach((id) => {
      if (id) set.add(id);
    });
  }
  if (set.size === 0) {
    set.add(COMPANY_ID);
  }
  return set;
}

export function isEmployeeInCompany(
  targetEmp: Employee,
  userCompanyIds: Set<string>,
): boolean {
  const empCompanyIds = [
    targetEmp.companyId,
    ...(targetEmp.companyIds || []),
  ].filter(Boolean) as string[];

  if (empCompanyIds.length === 0) {
    empCompanyIds.push(COMPANY_ID);
  }

  return empCompanyIds.some((cId) => userCompanyIds.has(cId));
}

export function isDepartmentInCompany(
  dept: Department,
  userCompanyIds: Set<string>,
): boolean {
  const deptCompanyId = dept.companyId || COMPANY_ID;
  return userCompanyIds.has(deptCompanyId);
}

export function buildMentionCandidates(
  employees: Employee[],
  departments: Department[],
  currentEmployee: Employee | null,
): MentionCandidate[] {
  const userCompanyIds = getUserCompanyIds(currentEmployee);
  const deptMap = new Map<string, string>();
  departments.forEach((d) => deptMap.set(d.id, d.name));

  const scopedEmployees = employees.filter(
    (e) => e.status !== "inactive" && isEmployeeInCompany(e, userCompanyIds),
  );

  const scopedDepartments = departments.filter((d) =>
    isDepartmentInCompany(d, userCompanyIds),
  );

  const peopleCandidates: MentionCandidate[] = scopedEmployees.map((emp) => {
    const deptName = emp.deptId ? deptMap.get(emp.deptId) || "" : "";
    const titleParts = [emp.jobTitle, deptName].filter(Boolean);
    const candidate: MentionCandidate = {
      id: emp.id,
      type: "person",
      name: emp.name,
      displayTag: `@${emp.name}`,
      subtitle: titleParts.join(" • ") || "Employee",
    };
    if (emp.deptId) candidate.deptId = emp.deptId;
    if (deptName) candidate.deptName = deptName;
    if (emp.companyId) candidate.companyId = emp.companyId;
    if (emp.email) candidate.email = emp.email;
    return candidate;
  });

  const departmentCandidates: MentionCandidate[] = scopedDepartments.map((dept) => {
    const candidate: MentionCandidate = {
      id: dept.id,
      type: "department",
      name: dept.name,
      displayTag: `@${dept.name}`,
      subtitle: "Department",
      deptId: dept.id,
      deptName: dept.name,
    };
    if (dept.companyId) candidate.companyId = dept.companyId;
    return candidate;
  });

  return [...peopleCandidates, ...departmentCandidates];
}

export function extractMentionsFromText(
  text: string,
  allCandidates: MentionCandidate[],
): MentionItem[] {
  if (!text || !allCandidates.length) return [];

  const foundMentions: MentionItem[] = [];
  const lowerText = text.toLowerCase();

  // Sort candidates by length descending so longer matching names are checked first
  const sortedCandidates = [...allCandidates].sort(
    (a, b) => b.displayTag.length - a.displayTag.length,
  );

  const matchedIds = new Set<string>();

  for (const candidate of sortedCandidates) {
    if (matchedIds.has(candidate.id)) continue;
    const lowerTag = candidate.displayTag.toLowerCase();
    if (lowerText.includes(lowerTag)) {
      matchedIds.add(candidate.id);
      const mentionItem: MentionItem = {
        id: candidate.id,
        type: candidate.type,
        name: candidate.name,
        displayTag: candidate.displayTag,
      };
      if (candidate.deptId) mentionItem.deptId = candidate.deptId;
      if (candidate.deptName) mentionItem.deptName = candidate.deptName;
      if (candidate.companyId) mentionItem.companyId = candidate.companyId;
      if (candidate.email) mentionItem.email = candidate.email;
      foundMentions.push(mentionItem);
    }
  }

  return foundMentions;
}

export function resolveMentionRecipients(
  mentions: MentionItem[],
  employees: Employee[],
  authorEmail?: string,
): Array<{ email: string; name: string; targetName: string; targetType: "person" | "department" }> {
  const recipients: Array<{ email: string; name: string; targetName: string; targetType: "person" | "department" }> = [];
  const seenEmails = new Set<string>();
  const cleanAuthorEmail = authorEmail?.trim().toLowerCase();

  for (const m of mentions) {
    if (m.type === "person") {
      const emp = employees.find(
        (e) => e.id === m.id || e.authUid === m.id || e.name.toLowerCase() === m.name.toLowerCase(),
      );
      const email = (emp?.email || m.email || "").trim().toLowerCase();
      if (email && email !== cleanAuthorEmail && !seenEmails.has(email)) {
        seenEmails.add(email);
        recipients.push({
          email,
          name: emp?.name || m.name,
          targetName: m.name,
          targetType: "person",
        });
      }
    } else if (m.type === "department") {
      const deptId = m.deptId || m.id;
      const deptEmployees = employees.filter(
        (e) => e.status !== "inactive" && e.deptId === deptId,
      );
      for (const emp of deptEmployees) {
        const email = emp.email?.trim().toLowerCase();
        if (email && email !== cleanAuthorEmail && !seenEmails.has(email)) {
          seenEmails.add(email);
          recipients.push({
            email,
            name: emp.name,
            targetName: m.name,
            targetType: "department",
          });
        }
      }
    }
  }

  return recipients;
}
