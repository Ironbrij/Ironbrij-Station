import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, setDoc } from "firebase/firestore";
import {
  Building2,
  Calendar,
  Check,
  Image as ImageIcon,
  PartyPopper,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type CompanyHoliday,
  type CountryCode,
  type Department,
  type Employee,
  type HolidayTargetType,
} from "@/lib/types";
import { ymd } from "@/lib/time";

export const Route = createFileRoute("/_authenticated/admin/company")({
  head: () => ({
    meta: [
      { title: "Company Settings — Time Station Admin" },
      { name: "description", content: "Manage company branding, logo, and holidays." },
      { property: "og:title", content: "Company Settings — Time Station Admin" },
      { property: "og:description", content: "Manage company branding, logo, and holidays." },
    ],
  }),
  component: CompanyPage,
});

const DEFAULT_LOGO =
  "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg";

function CompanyPage() {
  const [company, setCompany] = useState<Company>({
    name: "ironbrij",
    defaultShiftHours: 8,
    holidays: [],
    holidayAssignments: [],
    workingDays: [1, 2, 3, 4, 5],
    lateGraceMinutes: 1,
    logoUrl: DEFAULT_LOGO,
  });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(false);
  const [newHoliday, setNewHoliday] = useState("");
  const [holidayName, setHolidayName] = useState("");
  const [holidayTargetType, setHolidayTargetType] = useState<HolidayTargetType>("all");
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<string[]>([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [countryFilter, setCountryFilter] = useState<"all" | CountryCode>("all");

  const todayStr = ymd(new Date());
  const isTodayHoliday = company.holidays.includes(todayStr);

  useEffect(() => {
    const unsubCompany = onSnapshot(doc(db(), "companies", COMPANY_ID), (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data() as Company;
      setCompany({
        name: data.name || "ironbrij",
        defaultShiftHours: data.defaultShiftHours ?? 8,
        holidays: data.holidays ?? [],
        holidayAssignments: data.holidayAssignments ?? [],
        workingDays: data.workingDays ?? [1, 2, 3, 4, 5],
        lateGraceMinutes: data.lateGraceMinutes ?? 1,
        logoUrl: data.logoUrl || DEFAULT_LOGO,
      });
    });
    const unsubDepartments = onSnapshot(collection(db(), "departments"), (snapshot) =>
      setDepartments(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Department, "id">),
        })),
      ),
    );
    const unsubEmployees = onSnapshot(collection(db(), "employees"), (snapshot) =>
      setEmployees(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Employee, "id">),
        })),
      ),
    );
    return () => {
      unsubCompany();
      unsubDepartments();
      unsubEmployees();
    };
  }, []);

  async function save(updatedCompany: Company = company) {
    setBusy(true);
    try {
      const payload: Company = {
        name: updatedCompany.name.trim() || "ironbrij",
        defaultShiftHours: updatedCompany.defaultShiftHours || 8,
        holidays: updatedCompany.holidays,
        holidayAssignments: updatedCompany.holidayAssignments ?? [],
        workingDays: updatedCompany.workingDays,
        lateGraceMinutes: Math.max(0, updatedCompany.lateGraceMinutes ?? 1),
        logoUrl: updatedCompany.logoUrl?.trim() || DEFAULT_LOGO,
      };
      await setDoc(doc(db(), "companies", COMPANY_ID), payload, { merge: true });
      toast.success("Company settings and holidays updated successfully!");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTodayHoliday() {
    const updatedHolidays = isTodayHoliday
      ? company.holidays.filter((holiday) => holiday !== todayStr)
      : [...company.holidays, todayStr].sort();
    const updated = { ...company, holidays: updatedHolidays };
    setCompany(updated);
    await save(updated);
  }

  async function addHoliday() {
    if (!newHoliday) return;
    if (holidayTargetType === "all" && company.holidays.includes(newHoliday)) {
      toast.error("That company-wide holiday already exists.");
      return;
    }
    if (holidayTargetType === "departments" && selectedDepartmentIds.length === 0) {
      toast.error("Select at least one department.");
      return;
    }
    if (holidayTargetType === "employees" && selectedEmployeeIds.length === 0) {
      toast.error("Select at least one employee.");
      return;
    }

    let updated: Company;
    if (holidayTargetType === "all") {
      updated = { ...company, holidays: [...company.holidays, newHoliday].sort() };
    } else {
      const assignment: CompanyHoliday = {
        id: `${newHoliday}-${Date.now()}`,
        date: newHoliday,
        name: holidayName.trim() || "Company Holiday",
        targetType: holidayTargetType,
        ...(holidayTargetType === "departments"
          ? { departmentIds: selectedDepartmentIds }
          : {
              employeeIds: [
                ...new Set(
                  employees
                    .filter((employee) => selectedEmployeeIds.includes(employee.id))
                    .flatMap((employee) => [employee.id, employee.authUid].filter(Boolean)),
                ),
              ] as string[],
            }),
      };
      updated = {
        ...company,
        holidayAssignments: [...(company.holidayAssignments ?? []), assignment].sort((a, b) =>
          a.date.localeCompare(b.date),
        ),
      };
    }

    setCompany(updated);
    setNewHoliday("");
    setHolidayName("");
    setSelectedDepartmentIds([]);
    setSelectedEmployeeIds([]);
    await save(updated);
  }

  async function removeGlobalHoliday(date: string) {
    const updated = {
      ...company,
      holidays: company.holidays.filter((holiday) => holiday !== date),
    };
    setCompany(updated);
    await save(updated);
  }

  async function removeHolidayAssignment(id: string) {
    const updated = {
      ...company,
      holidayAssignments: (company.holidayAssignments ?? []).filter((holiday) => holiday.id !== id),
    };
    setCompany(updated);
    await save(updated);
  }

  function toggleSelection(id: string, selected: string[], update: (ids: string[]) => void) {
    update(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }

  const visibleEmployees = useMemo(
    () =>
      employees
        .filter((employee) => employee.status === "active")
        .filter(
          (employee) => countryFilter === "all" || (employee.country || "NP") === countryFilter,
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, countryFilter],
  );

  function holidayAudienceLabel(holiday: CompanyHoliday) {
    if (holiday.targetType === "all") return "Everyone";
    if (holiday.targetType === "departments") {
      const names = departments
        .filter((department) => holiday.departmentIds?.includes(department.id))
        .map((department) => department.name);
      return names.length ? names.join(", ") : "Selected departments";
    }
    const names = employees
      .filter(
        (employee) =>
          holiday.employeeIds?.includes(employee.id) ||
          Boolean(employee.authUid && holiday.employeeIds?.includes(employee.authUid)),
      )
      .map((employee) => employee.name);
    return names.length ? names.join(", ") : "Selected employees";
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <Building2 className="h-6 w-6" /> Company Settings & Holiday Manager
        </h1>
        <p className="text-sm text-muted-foreground">
          Assign holidays to everyone, departments, or specific people.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="font-extrabold text-base text-primary flex items-center gap-2">
              <PartyPopper className="h-5 w-5 text-purple-600" /> Today&apos;s Company Off Status
            </h3>
            <p className="text-xs text-muted-foreground font-medium mt-0.5">
              This quick action assigns today as a holiday to everyone.
            </p>
          </div>
          <button
            disabled={busy}
            onClick={toggleTodayHoliday}
            className={`btn-lift px-5 py-2.5 rounded-xl font-extrabold text-xs flex items-center gap-2 shadow-sm ${
              isTodayHoliday ? "bg-rose-600 text-white" : "bg-purple-600 text-white"
            }`}
          >
            {isTodayHoliday ? (
              <>
                <X className="h-4 w-4" /> Cancel Today&apos;s Holiday
              </>
            ) : (
              <>
                <PartyPopper className="h-4 w-4" /> Holiday for Everyone ({todayStr})
              </>
            )}
          </button>
        </div>
        {isTodayHoliday && (
          <div className="p-3.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-900 dark:text-purple-300 text-xs font-bold flex items-center gap-2">
            <Check className="h-4 w-4 text-purple-600" />
            Today is a holiday for every employee.
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-4">
        <h2 className="font-bold text-primary flex items-center gap-2">
          <Calendar className="h-4 w-4" /> Assign a Company Holiday
        </h2>
        <p className="text-xs text-muted-foreground">
          Only assigned employees will have regular punching disabled and their attendance status
          shown as Holiday.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <input
            type="date"
            value={newHoliday}
            onChange={(event) => setNewHoliday(event.target.value)}
            className="rounded-md border px-3 py-2 text-sm bg-background font-medium"
          />
          <input
            value={holidayName}
            onChange={(event) => setHolidayName(event.target.value)}
            placeholder="Holiday name (optional)"
            className="rounded-md border px-3 py-2 text-sm bg-background font-medium"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(
            [
              ["all", "Everyone"],
              ["departments", "Departments"],
              ["employees", "Specific people"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setHolidayTargetType(value)}
              className={`rounded-lg border px-3 py-2 text-xs font-bold ${
                holidayTargetType === value
                  ? "border-primary bg-primary/10 text-primary"
                  : "bg-background text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {holidayTargetType === "departments" && (
          <div className="rounded-lg border bg-secondary/20 p-3 space-y-2">
            <div className="text-xs font-bold flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" /> Select departments
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {departments.map((department) => (
                <label
                  key={department.id}
                  className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedDepartmentIds.includes(department.id)}
                    onChange={() =>
                      toggleSelection(
                        department.id,
                        selectedDepartmentIds,
                        setSelectedDepartmentIds,
                      )
                    }
                  />
                  {department.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {holidayTargetType === "employees" && (
          <div className="rounded-lg border bg-secondary/20 p-3 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs font-bold flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> Select specific people
              </div>
              <select
                value={countryFilter}
                onChange={(event) => setCountryFilter(event.target.value as "all" | CountryCode)}
                className="rounded-md border bg-background px-2 py-1.5 text-xs font-medium"
              >
                <option value="all">All countries</option>
                <option value="AU">Australia</option>
                <option value="PH">Philippines</option>
                <option value="NP">Nepal</option>
              </select>
            </div>
            <div className="max-h-64 overflow-y-auto grid gap-2 sm:grid-cols-2">
              {visibleEmployees.map((employee) => (
                <label
                  key={employee.id}
                  className="flex items-start gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedEmployeeIds.includes(employee.id)}
                    onChange={() =>
                      toggleSelection(employee.id, selectedEmployeeIds, setSelectedEmployeeIds)
                    }
                  />
                  <span>
                    <span className="font-semibold block">{employee.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {departments.find((department) => department.id === employee.deptId)?.name ||
                        "No department"}{" "}
                      · {employee.country || "NP"}
                    </span>
                  </span>
                </label>
              ))}
              {visibleEmployees.length === 0 && (
                <span className="text-xs text-muted-foreground italic">
                  No active employees in this country.
                </span>
              )}
            </div>
            <div className="text-xs font-semibold text-primary">
              {selectedEmployeeIds.length} employee
              {selectedEmployeeIds.length === 1 ? "" : "s"} selected
            </div>
          </div>
        )}

        <button
          onClick={addHoliday}
          disabled={busy || !newHoliday}
          className="btn-lift rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          Assign Holiday
        </button>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-3">
        <h2 className="font-bold text-primary">
          Scheduled Holidays ({company.holidays.length + (company.holidayAssignments?.length ?? 0)})
        </h2>
        <ul className="space-y-2">
          {company.holidays.map((date) => (
            <li
              key={date}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs bg-purple-500/10 text-purple-700 border border-purple-500/20"
            >
              <span>
                <strong>{date}</strong> · Company Holiday · Everyone
              </span>
              <button onClick={() => removeGlobalHoliday(date)} title="Remove holiday">
                <X className="h-3.5 w-3.5 text-rose-500" />
              </button>
            </li>
          ))}
          {(company.holidayAssignments ?? []).map((holiday) => (
            <li
              key={holiday.id}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs bg-sky-500/10 text-sky-800 dark:text-sky-300 border border-sky-500/20"
            >
              <span>
                <strong>{holiday.date}</strong> · {holiday.name || "Company Holiday"} ·{" "}
                {holidayAudienceLabel(holiday)}
              </span>
              <button onClick={() => removeHolidayAssignment(holiday.id)} title="Remove holiday">
                <X className="h-3.5 w-3.5 text-rose-500" />
              </button>
            </li>
          ))}
          {company.holidays.length === 0 && (company.holidayAssignments?.length ?? 0) === 0 && (
            <li className="text-sm text-muted-foreground italic">No holidays set.</li>
          )}
        </ul>
      </div>

      <div className="rounded-xl border bg-card p-6 space-y-4 shadow-lift">
        <h2 className="font-bold text-primary flex items-center gap-2">
          <ImageIcon className="h-4 w-4" /> Company Settings
        </h2>
        <div>
          <label className="text-sm font-semibold">Company Name</label>
          <input
            value={company.name}
            onChange={(event) => setCompany({ ...company, name: event.target.value })}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
          />
        </div>
        <div>
          <label className="text-sm font-semibold">Logo Image URL</label>
          <input
            value={company.logoUrl ?? ""}
            onChange={(event) => setCompany({ ...company, logoUrl: event.target.value })}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
          />
        </div>
        <div>
          <label className="text-sm font-semibold">Default Shift Duration (Hours)</label>
          <input
            type="number"
            value={company.defaultShiftHours}
            onChange={(event) =>
              setCompany({
                ...company,
                defaultShiftHours: Number(event.target.value) || 8,
              })
            }
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
          />
        </div>
        <button
          disabled={busy}
          onClick={() => save()}
          className="btn-lift rounded-md bg-primary text-primary-foreground px-8 py-3 text-sm font-bold"
        >
          {busy ? "Saving Settings..." : "Save Company Settings"}
        </button>
      </div>
    </div>
  );
}
