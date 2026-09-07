import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  normalizeCompanyId,
} from "./company-context.ts";
import type { Company, Department, Employee } from "./types.ts";

export const GENERAL_DEPARTMENT_FILTER = "__no_department__";

function departmentIds(employee: Employee, companyId: string): string[] {
  const companyIds = companyId === "all" ? getEmployeeCompanyIds(employee) : [companyId];
  return companyIds.map((id) => getEmployeeForCompany(employee, id).deptId?.trim() || "");
}

function isGeneral(id: string, departments: Department[]): boolean {
  const department = departments.find((item) => item.id === id);
  return !id || (department?.name || id).trim().toLowerCase() === "general";
}

export function getEmployeeListDepartmentLabel(
  employee: Employee,
  companyId: string,
  departments: Department[],
): string {
  return [
    ...new Set(
      departmentIds(employee, companyId).map((id) =>
        isGeneral(id, departments)
          ? "General"
          : departments.find((item) => item.id === id)?.name || "Unknown department",
      ),
    ),
  ].join(", ");
}

export function filterEmployeeList(
  employees: Employee[],
  companies: Company[],
  departments: Department[],
  companyId: string,
  departmentId: string,
  searchQuery: string,
): Employee[] {
  const query = searchQuery.trim().toLowerCase();
  return employees
    .filter((employee) => {
      if (companyId !== "all") {
        const ids = getEmployeeCompanyIds(employee);
        const matchesCompany = ids.includes(normalizeCompanyId(companyId));
        const legacyMainEmployee =
          !employee.companyId &&
          !employee.companyIds?.length &&
          !Object.keys(employee.companyMemberships || {}).length &&
          companies.some((company) => company.id === companyId && company.isMain);
        if (!matchesCompany && !legacyMainEmployee) return false;
      }
      if (departmentId) {
        const ids = departmentIds(employee, companyId);
        const generalFilter = departmentId === GENERAL_DEPARTMENT_FILTER;
        if (!ids.some((id) => (generalFilter ? isGeneral(id, departments) : id === departmentId)))
          return false;
      }
      return (
        !query ||
        [employee.name, employee.email, employee.jobTitle, employee.id].some((value) =>
          value?.toLowerCase().includes(query),
        )
      );
    })
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
}
