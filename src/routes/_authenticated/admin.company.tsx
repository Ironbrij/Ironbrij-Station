import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import {
  Building2,
  Calendar,
  Check,
  Image as ImageIcon,
  MapPin,
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
import { normalizeState, STATE_NOT_APPLICABLE } from "@/lib/states";

export const Route = createFileRoute("/_authenticated/admin/company")({
  head: () => ({
    meta: [
      { title: "Company Settings — SavyTimes Admin" },
      { name: "description", content: "Manage company branding, logo, and holidays." },
      { property: "og:title", content: "Company Settings — SavyTimes Admin" },
      { property: "og:description", content: "Manage company branding, logo, and holidays." },
    ],
  }),
  component: CompanyPage,
});

const DEFAULT_LOGO =
  "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg";

function CompanyPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [company, setCompany] = useState<Company>({
    id: COMPANY_ID,
    name: "ironbrij",
    defaultShiftHours: 8,
    holidays: [],
    holidayAssignments: [],
    workingDays: [1, 2, 3, 4, 5],
    lateGraceMinutes: 5,
    logoUrl: DEFAULT_LOGO,
    isMain: true,
  });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAddCompanyModal, setShowAddCompanyModal] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);

  const [newHoliday, setNewHoliday] = useState("");
  const [holidayName, setHolidayName] = useState("");
  const [useCompanyScope, setUseCompanyScope] = useState(false);
  const [holidayTargetType, setHolidayTargetType] = useState<HolidayTargetType>("all");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>([]);
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<string[]>([]);
  const [selectedStateCodes, setSelectedStateCodes] = useState<string[]>([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [countryFilter, setCountryFilter] = useState<"all" | CountryCode>("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [sendHolidayNotice, setSendHolidayNotice] = useState(true);
  const [holidayNoticeMode, setHolidayNoticeMode] = useState<"instant" | "scheduled">("instant");
  const [holidayNoticeAt, setHolidayNoticeAt] = useState("");
  const [showTodayHolidayConfirmModal, setShowTodayHolidayConfirmModal] = useState(false);
  const [todayHolidayCompanyId, setTodayHolidayCompanyId] = useState("all");

  const todayStr = ymd(new Date());
  const isTodayHoliday = company.holidays.includes(todayStr);

  useEffect(() => {
    const unsubCompanies = onSnapshot(collection(db(), "companies"), (snapshot) => {
      const list = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Company, "id">),
      }));

      // Ensure main company document exists in list
      if (!list.some((c) => c.id === COMPANY_ID)) {
        const defaultCompany: Company = {
          id: COMPANY_ID,
          name: "ironbrij (Main)",
          defaultShiftHours: 8,
          holidays: [],
          workingDays: [1, 2, 3, 4, 5],
          lateGraceMinutes: 5,
          logoUrl: DEFAULT_LOGO,
          isMain: true,
          createdAt: new Date().toISOString(),
        };
        setDoc(doc(db(), "companies", COMPANY_ID), defaultCompany).catch(() => {});
        setCompanies([defaultCompany, ...list]);
      } else {
        setCompanies(list);
      }

      const mainComp = list.find((c) => c.id === COMPANY_ID || c.isMain);
      if (mainComp) {
        setCompany({
          ...mainComp,
          name: mainComp.name || "ironbrij",
          defaultShiftHours: mainComp.defaultShiftHours ?? 8,
          holidays: mainComp.holidays ?? [],
          holidayAssignments: mainComp.holidayAssignments ?? [],
          workingDays: mainComp.workingDays ?? [1, 2, 3, 4, 5],
          lateGraceMinutes: Math.max(5, mainComp.lateGraceMinutes ?? 5),
          logoUrl: mainComp.logoUrl || DEFAULT_LOGO,
          isMain: true,
        });
      }
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
      unsubCompanies();
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
        lateGraceMinutes: Math.max(5, updatedCompany.lateGraceMinutes ?? 5),
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

  async function confirmTodayHoliday(targetCompId: string) {
    let updatedHolidays: string[];
    let updatedAssignments = [...(company.holidayAssignments ?? [])];

    if (isTodayHoliday) {
      updatedHolidays = company.holidays.filter((d) => d !== todayStr);
      updatedAssignments = updatedAssignments.filter((a) => a.date !== todayStr);
    } else if (targetCompId === "all") {
      updatedHolidays = company.holidays.includes(todayStr)
        ? company.holidays
        : [...company.holidays, todayStr].sort();
    } else {
      updatedHolidays = company.holidays;
      updatedAssignments.push({
        id: `today-${todayStr}-${Date.now()}`,
        date: todayStr,
        name: "Instant Company Off",
        targetType: "companies",
        companyIds: [targetCompId],
      });
    }

    const updated = {
      ...company,
      holidays: updatedHolidays,
      holidayAssignments: updatedAssignments,
    };
    setCompany(updated);
    await save(updated);
    setShowTodayHolidayConfirmModal(false);
    toast.success(
      isTodayHoliday
        ? "Today's holiday cancelled!"
        : `Declared today (${todayStr}) as a Holiday! 🎉`,
    );
  }

  async function addHoliday() {
    if (!newHoliday) return;
    if (useCompanyScope && selectedCompanyIds.length === 0) {
      toast.error("Select at least one company.");
      return;
    }
    if (holidayTargetType === "departments" && selectedDepartmentIds.length === 0) {
      toast.error("Select at least one department.");
      return;
    }
    if (holidayTargetType === "states" && selectedStateCodes.length === 0) {
      toast.error("Select at least one state.");
      return;
    }
    if (holidayTargetType === "employees" && selectedEmployeeIds.length === 0) {
      toast.error("Select at least one employee.");
      return;
    }
    if (sendHolidayNotice && holidayNoticeMode === "scheduled" && !holidayNoticeAt) {
      toast.error("Choose when the holiday notification should be delivered.");
      return;
    }
    const noticePublishAt =
      holidayNoticeMode === "scheduled"
        ? new Date(holidayNoticeAt).toISOString()
        : new Date().toISOString();
    if (
      sendHolidayNotice &&
      holidayNoticeMode === "scheduled" &&
      new Date(noticePublishAt).getTime() <= Date.now()
    ) {
      toast.error("Scheduled notification time must be in the future.");
      return;
    }

    let updated: Company;
    if (holidayTargetType === "all" && !useCompanyScope) {
      updated = { ...company, holidays: [...company.holidays, newHoliday].sort() };
    } else {
      const assignment: CompanyHoliday = {
        id: `${newHoliday}-${Date.now()}`,
        date: newHoliday,
        name: holidayName.trim() || "Company Holiday",
        targetType: holidayTargetType,
        ...(useCompanyScope && selectedCompanyIds.length > 0
          ? { companyIds: selectedCompanyIds }
          : {}),
        ...(holidayTargetType === "departments"
          ? { departmentIds: selectedDepartmentIds }
          : holidayTargetType === "states"
            ? { stateCodes: selectedStateCodes }
            : holidayTargetType === "employees"
              ? {
                  employeeIds: [
                    ...new Set(
                      employees
                        .filter((employee) => selectedEmployeeIds.includes(employee.id))
                        .flatMap((employee) => [employee.id, employee.authUid].filter(Boolean)),
                    ),
                  ] as string[],
                }
              : {}),
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
    setSelectedStateCodes([]);
    setSelectedEmployeeIds([]);
    await save(updated);
    if (sendHolidayNotice) {
      try {
        const target =
          holidayTargetType === "all"
            ? { targetType: "all" as const }
            : holidayTargetType === "departments"
              ? {
                  targetType: "dept" as const,
                  targetDeptIds: selectedDepartmentIds,
                  ...(selectedDepartmentIds.length === 1
                    ? { targetDeptId: selectedDepartmentIds[0] }
                    : {}),
                }
              : holidayTargetType === "states"
                ? {
                    targetType: "states" as const,
                    targetStateCodes: selectedStateCodes,
                  }
                : {
                    targetType: "employee" as const,
                    targetEmployeeIds: selectedEmployeeIds,
                    ...(selectedEmployeeIds.length === 1
                      ? { targetEmployeeId: selectedEmployeeIds[0] }
                      : {}),
                  };
        await addDoc(collection(db(), "notices"), {
          title: holidayName.trim() || "Company Holiday",
          message: `${holidayName.trim() || "A company holiday"} is scheduled for ${newHoliday}. You are not required to punch in on this date.`,
          priority: "info",
          ...target,
          createdAt: new Date().toISOString(),
          publishAt: noticePublishAt,
          authorName: "Admin",
        });
        toast.success(
          holidayNoticeMode === "scheduled"
            ? `Holiday notification scheduled for ${new Date(noticePublishAt).toLocaleString()}`
            : "Holiday notification sent",
        );
      } catch (error) {
        toast.error("Holiday was saved, but its notification could not be created.");
        console.error(error);
      }
    }
    setHolidayNoticeMode("instant");
    setHolidayNoticeAt("");
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

  const visibleHolidayDepartments = useMemo(() => {
    if (!useCompanyScope || selectedCompanyIds.length === 0) return departments;
    return departments.filter((d) => {
      return (
        (d.companyId && selectedCompanyIds.includes(d.companyId)) ||
        (!d.companyId && selectedCompanyIds.includes(COMPANY_ID))
      );
    });
  }, [departments, useCompanyScope, selectedCompanyIds]);

  const visibleEmployees = useMemo(
    () =>
      employees
        .filter((employee) => employee.status === "active")
        .filter((employee) => {
          if (!useCompanyScope || selectedCompanyIds.length === 0) return true;
          const empCompIds = [employee.companyId, ...(employee.companyIds || [])].filter(
            Boolean,
          ) as string[];
          return selectedCompanyIds.some(
            (cId) => empCompIds.includes(cId) || (!employee.companyId && cId === COMPANY_ID),
          );
        })
        .filter(
          (employee) => countryFilter === "all" || (employee.country || "NP") === countryFilter,
        )
        .filter(
          (employee) => stateFilter === "all" || normalizeState(employee.state) === stateFilter,
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, useCompanyScope, selectedCompanyIds, countryFilter, stateFilter],
  );

  const availableStates = useMemo(
    () =>
      [...new Set(employees.map((employee) => normalizeState(employee.state)))]
        .filter((state) => state !== STATE_NOT_APPLICABLE)
        .sort(),
    [employees],
  );

  function holidayAudienceLabel(holiday: CompanyHoliday) {
    if (holiday.targetType === "all") return "Everyone";
    if (holiday.targetType === "departments") {
      const names = departments
        .filter((department) => holiday.departmentIds?.includes(department.id))
        .map((department) => department.name);
      return names.length ? names.join(", ") : "Selected departments";
    }
    if (holiday.targetType === "states") {
      return holiday.stateCodes?.length ? holiday.stateCodes.join(", ") : "Selected states";
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <Building2 className="h-6 w-6" /> Company Management & Holidays
          </h1>
          <p className="text-sm text-muted-foreground">
            Create companies, set logos, and allocate departments and employees.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddCompanyModal(true)}
          className="btn-lift rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-sm flex items-center gap-1.5 shrink-0"
        >
          <Building2 className="h-4 w-4" /> + Create New Company
        </button>
      </div>

      {/* Companies List */}
      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-4">
        <h3 className="font-extrabold text-base text-primary flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" /> Active Companies ({companies.length})
        </h3>

        <div className="grid gap-3 sm:grid-cols-2">
          {companies.map((c) => {
            const compDepts = departments.filter(
              (d) => d.companyId === c.id || (!d.companyId && (c.id === COMPANY_ID || c.isMain)),
            ).length;
            const compEmps = employees.filter(
              (e) =>
                e.companyId === c.id ||
                e.companyIds?.includes(c.id || "") ||
                (!e.companyId && (c.id === COMPANY_ID || c.isMain)),
            ).length;

            return (
              <div
                key={c.id || c.name}
                className="rounded-xl border p-4 bg-secondary/20 hover:bg-secondary/40 transition-colors flex items-start gap-3 justify-between"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <img
                    src={c.logoUrl || DEFAULT_LOGO}
                    alt={c.name}
                    className="h-10 w-10 rounded-full object-cover border shrink-0 bg-background"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-foreground truncate block">
                        {c.name}
                      </span>
                      {(c.id === COMPANY_ID || c.isMain) && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-primary/15 text-primary border border-primary/20 shrink-0">
                          Main
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {compEmps} Employees · {compDepts} Departments
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 font-medium">
                      Shift: {c.defaultShiftHours || 8}h · Grace: {c.lateGraceMinutes || 5}m
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setEditingCompany(c)}
                  className="rounded-lg border px-2.5 py-1 text-xs font-bold text-primary hover:bg-background transition-colors shrink-0"
                >
                  Edit
                </button>
              </div>
            );
          })}
        </div>
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
            onClick={() => setShowTodayHolidayConfirmModal(true)}
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
          Select the company scope, then specify departments, states, or specific people for this
          holiday.
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

        {/* Step 1: Company Scope Selector */}
        <div className="rounded-lg border bg-secondary/30 p-3 space-y-2">
          <div className="text-xs font-extrabold text-primary flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5" /> 1. Target Company Scope
          </div>
          <div className="flex items-center gap-4 text-xs font-semibold">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="companyScope"
                checked={!useCompanyScope}
                onChange={() => {
                  setUseCompanyScope(false);
                  setSelectedCompanyIds([]);
                }}
              />
              <span>All Companies</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="companyScope"
                checked={useCompanyScope}
                onChange={() => setUseCompanyScope(true)}
              />
              <span>Specific Companies ({selectedCompanyIds.length})</span>
            </label>
          </div>

          {useCompanyScope && (
            <div className="grid gap-2 sm:grid-cols-2 pt-2 border-t mt-2">
              {companies.map((c) => (
                <label
                  key={c.id || c.name}
                  className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={selectedCompanyIds.includes(c.id || COMPANY_ID)}
                    onChange={() =>
                      toggleSelection(c.id || COMPANY_ID, selectedCompanyIds, setSelectedCompanyIds)
                    }
                  />
                  <span>
                    {c.name} {c.isMain ? "(Main)" : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Step 2: Target Audience inside Company */}
        <div className="space-y-2">
          <div className="text-xs font-extrabold text-primary">
            2. Target Audience inside Company
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {(
              [
                ["all", "Everyone in Company"],
                ["departments", "Specific Departments"],
                ["states", "Specific States"],
                ["employees", "Specific People"],
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
        </div>

        {holidayTargetType === "departments" && (
          <div className="rounded-lg border bg-secondary/20 p-3 space-y-2">
            <div className="text-xs font-bold flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" /> Select departments
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleHolidayDepartments.map((department) => (
                <label
                  key={department.id}
                  className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm cursor-pointer select-none"
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
                  <span>{department.name}</span>
                </label>
              ))}
            </div>
            {visibleHolidayDepartments.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-semibold p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                No departments belong to the selected company. You can assign this holiday to
                &quot;Everyone in Company&quot; or assign departments to this company in the
                Departments tab.
              </p>
            )}
          </div>
        )}

        {holidayTargetType === "states" && (
          <div className="rounded-lg border bg-secondary/20 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-bold flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> Select one or more states
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedStateCodes(availableStates)}
                  className="text-xs font-bold text-primary hover:underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedStateCodes([])}
                  className="text-xs font-bold text-muted-foreground hover:underline"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {availableStates.map((state) => (
                <label
                  key={state}
                  className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedStateCodes.includes(state)}
                    onChange={() =>
                      toggleSelection(state, selectedStateCodes, setSelectedStateCodes)
                    }
                  />
                  {state}
                </label>
              ))}
              {availableStates.length === 0 && (
                <span className="text-xs text-muted-foreground italic">
                  No employee states have been assigned yet.
                </span>
              )}
            </div>
            <div className="text-xs font-semibold text-primary">
              {selectedStateCodes.length} state{selectedStateCodes.length === 1 ? "" : "s"} selected
            </div>
          </div>
        )}

        {holidayTargetType === "employees" && (
          <div className="rounded-lg border bg-secondary/20 p-3 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs font-bold flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> Select specific people
              </div>
              <div className="flex flex-wrap gap-2">
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
                <select
                  value={stateFilter}
                  onChange={(event) => setStateFilter(event.target.value)}
                  className="rounded-md border bg-background px-2 py-1.5 text-xs font-medium"
                >
                  <option value="all">All states</option>
                  <option value={STATE_NOT_APPLICABLE}>N/A</option>
                  {availableStates.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedEmployeeIds((current) => [
                      ...new Set([...current, ...visibleEmployees.map((employee) => employee.id)]),
                    ])
                  }
                  className="text-xs font-bold text-primary hover:underline"
                >
                  Select filtered
                </button>
              </div>
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

        <fieldset className="rounded-lg border bg-sky-500/5 p-3 space-y-3">
          <legend className="px-1 text-xs font-bold text-primary">Holiday notification</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={sendHolidayNotice}
              onChange={(event) => setSendHolidayNotice(event.target.checked)}
            />
            Notify the selected users about this holiday
          </label>
          {sendHolidayNotice && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setHolidayNoticeMode("instant")}
                  className={`rounded-md border px-3 py-2 text-xs font-bold ${
                    holidayNoticeMode === "instant"
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background"
                  }`}
                >
                  Send instantly
                </button>
                <button
                  type="button"
                  onClick={() => setHolidayNoticeMode("scheduled")}
                  className={`rounded-md border px-3 py-2 text-xs font-bold ${
                    holidayNoticeMode === "scheduled"
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background"
                  }`}
                >
                  Schedule
                </button>
              </div>
              {holidayNoticeMode === "scheduled" && (
                <label className="block text-xs font-bold text-muted-foreground">
                  Notification calendar and clock
                  <input
                    type="datetime-local"
                    value={holidayNoticeAt}
                    onChange={(event) => setHolidayNoticeAt(event.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                  />
                  <span className="mt-1 block font-normal">
                    Uses your current device timezone. Employees will see it at the same instant.
                  </span>
                </label>
              )}
            </>
          )}
        </fieldset>

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

      {showAddCompanyModal && (
        <CompanyModal
          companyToEdit={editingCompany}
          onClose={() => {
            setShowAddCompanyModal(false);
            setEditingCompany(null);
          }}
        />
      )}

      {showTodayHolidayConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-lift space-y-4 text-left border border-border">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-lg font-bold text-primary flex items-center gap-2">
                <PartyPopper className="h-5 w-5 text-purple-600" />
                {isTodayHoliday ? "Cancel Today's Holiday" : "Confirm Today's Holiday"}
              </h3>
              <button
                type="button"
                onClick={() => setShowTodayHolidayConfirmModal(false)}
                className="rounded p-1 hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-foreground font-medium">
              {isTodayHoliday
                ? `Are you sure you want to cancel today's holiday (${todayStr})? Regular shift schedules will resume.`
                : `Are you sure you want to declare today (${todayStr}) as a Holiday? Employees will have regular punching disabled.`}
            </p>

            {!isTodayHoliday && (
              <div className="space-y-1.5 pt-1">
                <label className="block text-xs font-bold text-muted-foreground">
                  Apply Holiday To Company:
                </label>
                <select
                  value={todayHolidayCompanyId}
                  onChange={(e) => setTodayHolidayCompanyId(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-semibold text-foreground outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="all">All Companies ({companies.length})</option>
                  {companies.map((c) => (
                    <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                      {c.name} {c.isMain ? "(Main)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t">
              <button
                type="button"
                onClick={() => setShowTodayHolidayConfirmModal(false)}
                className="rounded-lg border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirmTodayHoliday(todayHolidayCompanyId)}
                className={`rounded-lg px-5 py-2 text-xs font-bold text-white shadow-md ${
                  isTodayHoliday
                    ? "bg-rose-600 hover:bg-rose-700"
                    : "bg-purple-600 hover:bg-purple-700"
                }`}
              >
                {isTodayHoliday ? "Yes, Cancel Holiday" : "Yes, Declare Holiday"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompanyModal({
  companyToEdit,
  onClose,
}: {
  companyToEdit?: Company | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(companyToEdit?.name ?? "");
  const [code, setCode] = useState(companyToEdit?.code ?? "");
  const [logoUrl, setLogoUrl] = useState(companyToEdit?.logoUrl ?? DEFAULT_LOGO);
  const [defaultShiftHours, setDefaultShiftHours] = useState(companyToEdit?.defaultShiftHours ?? 8);
  const [lateGraceMinutes, setLateGraceMinutes] = useState(companyToEdit?.lateGraceMinutes ?? 5);
  const [busy, setBusy] = useState(false);

  async function handleSaveCompany(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Company name is required");
      return;
    }
    setBusy(true);
    try {
      if (companyToEdit?.id) {
        await updateDoc(doc(db(), "companies", companyToEdit.id), {
          name: name.trim(),
          code: code.trim().toUpperCase(),
          logoUrl: logoUrl.trim() || DEFAULT_LOGO,
          defaultShiftHours: Number(defaultShiftHours) || 8,
          lateGraceMinutes: Math.max(5, Number(lateGraceMinutes) || 5),
        });
        toast.success(`Updated ${name}`);
      } else {
        const compRef = doc(collection(db(), "companies"));
        await setDoc(compRef, {
          name: name.trim(),
          code: code.trim().toUpperCase(),
          logoUrl: logoUrl.trim() || DEFAULT_LOGO,
          defaultShiftHours: Number(defaultShiftHours) || 8,
          lateGraceMinutes: Math.max(5, Number(lateGraceMinutes) || 5),
          workingDays: [0, 1, 2, 3, 4, 5],
          holidays: [],
          isMain: false,
          createdAt: new Date().toISOString(),
        });
        toast.success(`Created company ${name}`);
      }
      onClose();
    } catch (err) {
      toast.error("Failed to save company: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={handleSaveCompany}
        className="w-full max-w-md rounded-xl bg-card p-6 shadow-lift space-y-4 text-left max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="text-lg font-bold text-primary">
            {companyToEdit ? "Edit Company Settings" : "Create New Company"}
          </h3>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div>
          <label className="text-sm font-medium">Company Name *</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. SavyKids AU"
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
          />
        </div>

        <div>
          <label className="text-sm font-medium">Short Code (Optional)</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. SK-AU"
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium uppercase"
          />
        </div>

        <div>
          <label className="text-sm font-medium">Logo Image URL</label>
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://..."
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
          />
          {logoUrl && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Logo preview:</span>
              <img
                src={logoUrl}
                alt="Preview"
                className="h-8 w-8 rounded-full border object-cover"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Default Shift (Hours)</label>
            <input
              type="number"
              value={defaultShiftHours}
              onChange={(e) => setDefaultShiftHours(Number(e.target.value))}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Late Grace (Minutes)</label>
            <input
              type="number"
              value={lateGraceMinutes}
              onChange={(e) => setLateGraceMinutes(Number(e.target.value))}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-bold shadow-xs hover:bg-primary/90"
          >
            {busy ? "Saving..." : companyToEdit ? "Save Changes" : "Create Company"}
          </button>
        </div>
      </form>
    </div>
  );
}
