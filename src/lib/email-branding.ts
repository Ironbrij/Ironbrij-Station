import { COMPANY_ID, type Company, type Department, type Employee } from "@/lib/types";

export type CompanyEmailBranding = {
  id?: string;
  name: string;
  logoUrl?: string;
};

export function companyEmailBranding(
  company: Company | null | undefined,
  fallbackId?: string,
): CompanyEmailBranding {
  const name = company?.name?.trim() || "SavyTimes";
  const logoUrl = company?.logoUrl?.trim();

  return {
    ...(company?.id || fallbackId ? { id: company?.id || fallbackId } : {}),
    name,
    ...(logoUrl ? { logoUrl } : {}),
  };
}

export function findCompanyById(
  companies: Company[],
  companyId: string | null | undefined,
): Company | undefined {
  const resolvedId = companyId?.trim() || COMPANY_ID;
  return (
    companies.find((company) => company.id === resolvedId) ||
    (resolvedId === COMPANY_ID ? companies.find((company) => company.isMain) : undefined)
  );
}

export function findEmployeeCompany(
  employee: Employee,
  companies: Company[],
  departments: Department[] = [],
): Company | undefined {
  const departmentCompanyId = departments.find(
    (department) => department.id === employee.deptId,
  )?.companyId;
  const candidateIds = [
    employee.companyId,
    departmentCompanyId,
    ...(employee.companyIds || []),
    COMPANY_ID,
  ].filter((id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index);

  for (const companyId of candidateIds) {
    const company = findCompanyById(companies, companyId);
    if (company) return company;
  }

  return companies.find((company) => company.isMain);
}
