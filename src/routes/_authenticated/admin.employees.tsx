import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type CompanyMembership,
  type CountryCode,
  type Department,
  type Employee,
  type Punch,
  type ShiftInterval,
} from "@/lib/types";
import { COUNTRY_TIMEZONES } from "@/lib/time";
import { getStateOptions, normalizeState } from "@/lib/states";
import { ATTENDANCE_TIMEZONES, DEFAULT_SHIFT_TIMEZONE } from "@/lib/attendance";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { companyEmailBranding, findCompanyById } from "@/lib/email-branding";
import {
  buildCompanyMembership,
  calculateShiftEndTime,
  calculateShiftMinutes,
  calculateTotalShiftMinutes,
  cleanFirestoreData,
  getCompanyMembership,
  getEmployeeCompanyIds,
} from "@/lib/company-context";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand
  }
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);
    return successful;
  } catch {
    return false;
  }
}

export const DAY_OPTIONS = [
  { value: 0, label: "Sun", short: "Sun" },
  { value: 1, label: "Mon", short: "Mon" },
  { value: 2, label: "Tue", short: "Tue" },
  { value: 3, label: "Wed", short: "Wed" },
  { value: 4, label: "Thu", short: "Thu" },
  { value: 5, label: "Fri", short: "Fri" },
  { value: 6, label: "Sat", short: "Sat" },
];

export function formatWorkingDaysSummary(days?: number[]): string {
  const resolved = Array.isArray(days) && days.length > 0 ? days : [0, 1, 2, 3, 4, 5];
  if (resolved.length === 7) return "7 Days (Sun–Sat)";
  if (resolved.length === 6 && resolved.join(",") === "0,1,2,3,4,5") return "6 Days (Sun–Fri)";
  if (resolved.length === 5 && resolved.join(",") === "1,2,3,4,5") return "5 Days (Mon–Fri)";
  const labels = resolved.map((d) => DAY_OPTIONS.find((o) => o.value === d)?.short || d);
  return `${resolved.length} Days (${labels.join(", ")})`;
}

export function WorkingDaysPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (days: number[]) => void;
}) {
  const toggleDay = (day: number) => {
    if (value.includes(day)) {
      if (value.length === 1) return;
      onChange(value.filter((d) => d !== day).sort((a, b) => a - b));
    } else {
      onChange([...value, day].sort((a, b) => a - b));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Working days ({value.length} days/week)</label>
        <div className="flex gap-1.5 text-[11px]">
          <button
            type="button"
            onClick={() => onChange([0, 1, 2, 3, 4, 5, 6])}
            className="text-primary hover:underline font-bold"
          >
            All 7d
          </button>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            onClick={() => onChange([0, 1, 2, 3, 4, 5])}
            className="text-primary hover:underline font-bold"
          >
            Sun–Fri (6d)
          </button>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            onClick={() => onChange([1, 2, 3, 4, 5])}
            className="text-primary hover:underline font-bold"
          >
            Mon–Fri (5d)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {DAY_OPTIONS.map((day) => {
          const selected = value.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              onClick={() => toggleDay(day.value)}
              className={`py-1.5 rounded-lg border text-xs font-bold transition-all ${
                selected
                  ? "bg-primary text-primary-foreground border-primary shadow-xs"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              }`}
            >
              {day.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function formatShiftRange(
  start?: string,
  end?: string,
  isMultipleShift?: boolean,
  shifts?: ShiftInterval[],
): string {
  const formatTimeStr = (tStr: string) => {
    if (!tStr) return "";
    const [h, m] = tStr.split(":").map(Number);
    const d = new Date();
    d.setHours(isNaN(h) ? 9 : h, isNaN(m) ? 0 : m, 0, 0);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  };

  if (isMultipleShift && Array.isArray(shifts) && shifts.length > 0) {
    return shifts
      .map((s) => `${formatTimeStr(s.startTime)} - ${formatTimeStr(s.endTime)}`)
      .join(", ");
  }

  const s = start || "09:00";
  const e = end || "17:00";
  return `${formatTimeStr(s)} - ${formatTimeStr(e)}`;
}

export const Route = createFileRoute("/_authenticated/admin/employees")({
  head: () => ({
    meta: [
      { title: "Employees — SavyTimes Admin" },
      { name: "description", content: "Manage your team." },
      { property: "og:title", content: "Employees — SavyTimes Admin" },
      { property: "og:description", content: "Manage your team." },
    ],
  }),
  component: EmployeesPage,
});

function EmployeesPage() {
  const matchRoute = useMatchRoute();
  const employeeProfileMatch = matchRoute({
    to: "/admin/employees/$id",
    fuzzy: false,
  });

  if (employeeProfileMatch) return <Outlet />;
  return <EmployeesListPage />;
}

function EmployeesListPage() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [depts, setDepts] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [empToDelete, setEmpToDelete] = useState<Employee | null>(null);
  const [empToPromote, setEmpToPromote] = useState<Employee | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterCompany, setFilterCompany] = useState<string>("all");
  const [filterDept, setFilterDept] = useState<string>("");

  useEffect(() => {
    const unsubCompanies = onSnapshot(collection(db(), "companies"), (snap) =>
      setCompanies(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Company, "id">),
        })),
      ),
    );
    const unsubDepts = onSnapshot(collection(db(), "departments"), (snap) =>
      setDepts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) }))),
    );
    const unsubEmps = onSnapshot(collection(db(), "employees"), (snap) =>
      setEmployees(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) }))),
    );
    const unsubPunches = onSnapshot(collection(db(), "punches"), (snap) =>
      setPunches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }))),
    );
    return () => {
      unsubCompanies();
      unsubDepts();
      unsubEmps();
      unsubPunches();
    };
  }, []);

  function getPunchStatus(empId: string): "in" | "out" {
    const userPunches = punches.filter((p) => p.employeeId === empId && p.timestamp);
    if (userPunches.length === 0) return "out";
    userPunches.sort((a, b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0));
    return userPunches[userPunches.length - 1].type === "in" ? "in" : "out";
  }

  async function handleCopyInviteLink(emp: Employee) {
    try {
      let token = "";
      const q = query(
        collection(db(), "invites"),
        where("employeeId", "==", emp.id),
        where("used", "==", false),
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        token = snap.docs[0].id;
      } else {
        token = crypto.randomUUID().replace(/-/g, "");
        await setDoc(doc(db(), "invites", token), {
          employeeId: emp.id,
          email: (emp.email || "").toLowerCase(),
          createdAt: new Date().toISOString(),
          used: false,
        });
      }
      const url = `${window.location.origin}/invite/${token}`;
      const success = await copyToClipboard(url);
      if (success) {
        toast.success(`Invite link for ${emp.name} copied!`);
      } else {
        prompt(`Copy invite link for ${emp.name}:`, url);
      }
    } catch (err) {
      toast.error("Failed to generate invite link: " + (err as Error).message);
    }
  }

  async function confirmDeleteEmployee() {
    if (!empToDelete) return;
    try {
      await deleteDoc(doc(db(), "employees", empToDelete.id));
      toast.success(`${empToDelete.name} removed successfully`);
      setEmpToDelete(null);
    } catch (err) {
      toast.error("Failed to remove employee: " + (err as Error).message);
    }
  }

  const uniqueEmps = new Map<string, Employee>();
  (employees ?? []).forEach((e) => {
    const emailStr = (e.email || e.id || "").toLowerCase().trim();
    if (!emailStr) return;
    const existing = uniqueEmps.get(emailStr);
    if (!existing || (existing.inviteStatus === "pending" && e.inviteStatus === "accepted")) {
      uniqueEmps.set(emailStr, e);
    }
  });

  const filtered = Array.from(uniqueEmps.values()).filter((e) => {
    if (filterCompany !== "all") {
      const matchComp =
        e.companyId === filterCompany ||
        e.companyIds?.includes(filterCompany) ||
        (!e.companyId &&
          (filterCompany === COMPANY_ID || companies.find((c) => c.id === filterCompany)?.isMain));
      if (!matchComp) return false;
    }
    if (filterDept && e.deptId !== filterDept) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      const matchName = e.name.toLowerCase().includes(q);
      const matchEmail = (e.email || "").toLowerCase().includes(q);
      const matchTitle = (e.jobTitle || "").toLowerCase().includes(q);
      return matchName || matchEmail || matchTitle;
    }
    return true;
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary">Employees</h1>
          <p className="text-sm text-muted-foreground">
            Manage profiles, locations, shifts, and attendance.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="btn-lift rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground font-bold"
        >
          + Add Person
        </button>
      </div>

      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search employee by name, email, or job title..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm font-medium pr-8"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-2.5 text-xs text-muted-foreground hover:text-foreground font-bold"
            >
              ✕
            </button>
          )}
        </div>
        <select
          value={filterCompany}
          onChange={(e) => setFilterCompany(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm font-semibold sm:w-48 cursor-pointer"
        >
          <option value="all">All companies ({companies.length})</option>
          {companies.map((c) => (
            <option key={c.id || c.name} value={c.id || COMPANY_ID}>
              {c.name} {c.isMain ? "(Main)" : ""}
            </option>
          ))}
        </select>
        <select
          value={filterDept}
          onChange={(e) => setFilterDept(e.target.value)}
          className="rounded-md border px-3 py-2 text-sm font-medium"
        >
          <option value="">All departments</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 rounded-xl border bg-card overflow-hidden">
        {employees === null ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 skeleton-shimmer" />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Title</th>
                <th className="p-3">Department</th>
                <th className="p-3">Shift Hours</th>
                <th className="p-3">Status</th>
                <th className="p-3">Invite Link</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    No employees yet.
                  </td>
                </tr>
              )}
              {filtered.map((e) => (
                <tr key={e.id} className="border-t hover:bg-sky-soft/40 transition-colors">
                  <td className="p-3 font-medium">
                    <Link
                      to="/admin/employees/$id"
                      params={{ id: e.id }}
                      className="text-primary hover:underline font-bold block"
                    >
                      {e.name}
                    </Link>
                    <div className="text-xs text-muted-foreground font-normal">{e.email}</div>
                  </td>
                  <td className="p-3">{e.jobTitle}</td>
                  <td className="p-3">{depts.find((d) => d.id === e.deptId)?.name ?? "—"}</td>
                  <td className="p-3 text-xs whitespace-nowrap">
                    <div className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                      ⏰{" "}
                      {formatShiftRange(
                        e.shiftStartTime,
                        e.shiftEndTime,
                        e.isMultipleShift,
                        e.shifts,
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground font-medium mt-0.5">
                      📅 {formatWorkingDaysSummary(e.workingDays)}
                    </div>
                  </td>
                  <td className="p-3">
                    {e.inviteStatus === "pending" ? (
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                        Pending Invite
                      </span>
                    ) : e.status === "inactive" ? (
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-600 border border-rose-500/20">
                        Suspended
                      </span>
                    ) : getPunchStatus(e.id) === "in" ? (
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Active (Punched In)
                      </span>
                    ) : (
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-500/10 text-slate-500 border border-slate-500/20">
                        Off Shift (Punched Out)
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    {e.inviteStatus === "accepted" ? (
                      <span className="text-emerald-600 font-medium">Accepted</span>
                    ) : (
                      <button
                        onClick={() => handleCopyInviteLink(e)}
                        className="btn-lift rounded border border-primary/30 px-2 py-1 text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
                      >
                        Copy Link
                      </button>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setEmpToPromote(e)}
                        className="btn-lift text-xs px-2.5 py-1 rounded border border-amber-500/30 text-amber-700 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500 hover:text-white font-bold transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setEmpToDelete(e)}
                        className="btn-lift text-xs px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {empToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-w-sm w-full rounded-xl bg-card p-6 shadow-lift text-left">
            <h3 className="text-lg font-bold text-destructive">Remove Employee?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to permanently remove <strong>{empToDelete.name}</strong>?
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setEmpToDelete(null)}
                className="btn-lift rounded-md border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteEmployee}
                className="btn-lift rounded-md bg-destructive text-destructive-foreground px-4 py-2 text-sm font-medium"
              >
                Yes, Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {empToPromote && (
        <PromoteModal
          emp={empToPromote}
          depts={depts}
          companies={companies}
          onClose={() => setEmpToPromote(null)}
        />
      )}

      {showForm && (
        <NewEmployeeForm
          departments={depts}
          companies={companies}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function initialMemberships(
  employee: Employee | null,
  companyIds: string[],
  defaults?: Partial<CompanyMembership>,
): Record<string, CompanyMembership> {
  return Object.fromEntries(
    companyIds.map((companyId) => [
      companyId,
      employee
        ? buildCompanyMembership(companyId, getCompanyMembership(employee, companyId))
        : buildCompanyMembership(companyId, defaults || {}),
    ]),
  );
}

function ShiftHoursInput({
  hours,
  onChangeHours,
}: {
  hours: number;
  onChangeHours: (newHours: number) => void;
}) {
  const [text, setText] = useState<string>(() => String(hours));

  useEffect(() => {
    setText(String(hours));
  }, [hours]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const val = e.target.value;
        setText(val);
        const parsed = parseFloat(val);
        if (!isNaN(parsed) && parsed > 0) {
          onChangeHours(parsed);
        }
      }}
      onBlur={() => {
        const parsed = parseFloat(text);
        if (isNaN(parsed) || parsed <= 0) {
          setText(String(hours));
        } else {
          setText(String(parsed));
        }
      }}
      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-primary/20"
      placeholder="e.g. 8"
    />
  );
}

function CompanyMembershipSettings({
  companies,
  selectedCompanyIds,
  value,
  onChange,
}: {
  companies: Company[];
  selectedCompanyIds: string[];
  value: Record<string, CompanyMembership>;
  onChange: (memberships: Record<string, CompanyMembership>) => void;
}) {
  if (selectedCompanyIds.length === 0) return null;

  function update(companyId: string, change: Partial<CompanyMembership>) {
    const current = value[companyId] || buildCompanyMembership(companyId, {});
    const isMulti = change.isMultipleShift ?? current.isMultipleShift ?? false;
    let shifts = change.shifts ?? current.shifts;

    if (isMulti && (!shifts || shifts.length === 0)) {
      shifts = [
        { startTime: "04:00", endTime: "07:00" },
        { startTime: "12:00", endTime: "15:00" },
      ];
    } else if (!isMulti) {
      shifts = undefined;
    }

    const updatedStart =
      shifts?.[0]?.startTime ?? change.shiftStartTime ?? current.shiftStartTime ?? "09:00";
    let updatedEnd =
      shifts?.[shifts.length - 1]?.endTime ??
      change.shiftEndTime ??
      current.shiftEndTime ??
      "17:00";

    if (!isMulti && (change.shiftStartTime || change.requiredWorkMinutes)) {
      if (!change.shiftEndTime) {
        const hours = change.requiredWorkMinutes
          ? change.requiredWorkMinutes / 60
          : calculateShiftMinutes(
              current.shiftStartTime || "09:00",
              current.shiftEndTime || "17:00",
            ) / 60;
        updatedEnd = calculateShiftEndTime(updatedStart, hours);
      }
    }

    const calculatedMinutes = calculateTotalShiftMinutes(isMulti, shifts, updatedStart, updatedEnd);

    onChange({
      ...value,
      [companyId]: buildCompanyMembership(companyId, {
        ...current,
        ...change,
        isMultipleShift: isMulti,
        shifts,
        shiftStartTime: updatedStart,
        shiftEndTime: updatedEnd,
        requiredWorkMinutes: calculatedMinutes,
      }),
    });
  }

  function handleToggleMultiple(companyId: string) {
    const current = value[companyId] || buildCompanyMembership(companyId, {});
    const currentlyMulti = Boolean(current.isMultipleShift);
    const nextMulti = !currentlyMulti;
    if (nextMulti) {
      const defaultShifts: ShiftInterval[] =
        current.shifts && current.shifts.length > 0
          ? current.shifts
          : [
              { startTime: "04:00", endTime: "07:00" },
              { startTime: "12:00", endTime: "15:00" },
            ];
      update(companyId, {
        isMultipleShift: true,
        shifts: defaultShifts,
      });
    } else {
      update(companyId, {
        isMultipleShift: false,
        shifts: undefined,
      });
    }
  }

  function handleAddShiftSlot(companyId: string) {
    const current = value[companyId] || buildCompanyMembership(companyId, {});
    const existingShifts = current.shifts || [
      { startTime: "04:00", endTime: "07:00" },
      { startTime: "12:00", endTime: "15:00" },
    ];
    const lastShift = existingShifts[existingShifts.length - 1];
    let nextStart = "16:00";
    let nextEnd = "19:00";
    if (lastShift) {
      const [h, m] = lastShift.endTime.split(":").map(Number);
      if (!isNaN(h)) {
        const startH = (h + 1) % 24;
        const endH = (startH + 3) % 24;
        nextStart = `${String(startH).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
        nextEnd = `${String(endH).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
      }
    }
    const updatedShifts = [...existingShifts, { startTime: nextStart, endTime: nextEnd }];
    update(companyId, {
      isMultipleShift: true,
      shifts: updatedShifts,
    });
  }

  function handleRemoveShiftSlot(companyId: string, index: number) {
    const current = value[companyId] || buildCompanyMembership(companyId, {});
    const existingShifts = current.shifts || [];
    if (existingShifts.length <= 1) return;
    const updatedShifts = existingShifts.filter((_, i) => i !== index);
    update(companyId, {
      isMultipleShift: true,
      shifts: updatedShifts,
    });
  }

  function handleShiftIntervalChange(
    companyId: string,
    index: number,
    field: "startTime" | "endTime",
    val: string,
  ) {
    const current = value[companyId] || buildCompanyMembership(companyId, {});
    const existingShifts = [...(current.shifts || [])];
    if (!existingShifts[index]) return;
    existingShifts[index] = {
      ...existingShifts[index],
      [field]: val,
    };
    update(companyId, {
      isMultipleShift: true,
      shifts: existingShifts,
    });
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">Company-specific work settings</div>
      {selectedCompanyIds.map((companyId) => {
        const membership = value[companyId] || buildCompanyMembership(companyId, {});
        const companyName =
          companies.find((company) => (company.id || COMPANY_ID) === companyId)?.name ||
          "Main Company";
        const isMulti = Boolean(membership.isMultipleShift);
        const shifts = membership.shifts || [
          { startTime: "04:00", endTime: "07:00" },
          { startTime: "12:00", endTime: "15:00" },
        ];
        const durationMins = calculateTotalShiftMinutes(
          isMulti,
          shifts,
          membership.shiftStartTime || "09:00",
          membership.shiftEndTime || "17:00",
        );
        const shiftHoursVal = Number((durationMins / 60).toFixed(1));
        const hoursLabel = `${shiftHoursVal} Hours${isMulti ? ` (${shifts.length} shifts)` : ""}`;

        return (
          <div key={companyId} className="rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-foreground">{companyName}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleMultiple(companyId)}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition-all border ${
                    isMulti
                      ? "bg-primary text-primary-foreground border-primary shadow-xs"
                      : "bg-background text-muted-foreground border-border hover:bg-muted"
                  }`}
                >
                  {isMulti ? "✓ Multiple Shift" : "+ Multiple Shift"}
                </button>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                  {hoursLabel}
                </span>
              </div>
            </div>

            {isMulti ? (
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Multiple Shift Intervals ({shifts.length})
                  </span>
                  <div className="w-44">
                    <select
                      value={membership.shiftTimezone || DEFAULT_SHIFT_TIMEZONE}
                      onChange={(event) => update(companyId, { shiftTimezone: event.target.value })}
                      className="w-full rounded-md border bg-background px-2 py-1 text-xs font-medium"
                    >
                      {ATTENDANCE_TIMEZONES.map((zone) => (
                        <option key={zone.value} value={zone.value}>
                          {zone.short}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  {shifts.map((s, idx) => {
                    const singleMins = calculateShiftMinutes(s.startTime, s.endTime);
                    const singleHours = Number((singleMins / 60).toFixed(1));
                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-2 p-2 rounded-md bg-background border text-xs"
                      >
                        <span className="font-bold text-muted-foreground min-w-[48px] shrink-0">
                          Shift #{idx + 1}
                        </span>
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <div>
                            <span className="text-[10px] text-muted-foreground block">Start</span>
                            <input
                              type="time"
                              value={s.startTime}
                              onChange={(e) =>
                                handleShiftIntervalChange(
                                  companyId,
                                  idx,
                                  "startTime",
                                  e.target.value,
                                )
                              }
                              className="rounded border bg-background px-1.5 py-1 text-xs font-semibold"
                            />
                          </div>
                          <span className="text-muted-foreground mt-3">–</span>
                          <div>
                            <span className="text-[10px] text-muted-foreground block">End</span>
                            <input
                              type="time"
                              value={s.endTime}
                              onChange={(e) =>
                                handleShiftIntervalChange(companyId, idx, "endTime", e.target.value)
                              }
                              className="rounded border bg-background px-1.5 py-1 text-xs font-semibold"
                            />
                          </div>
                        </div>
                        <span className="font-mono text-[11px] text-primary font-bold px-1.5 py-0.5 rounded bg-primary/5 border border-primary/10 shrink-0">
                          {singleHours}h
                        </span>
                        {shifts.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveShiftSlot(companyId, idx)}
                            className="p-1 rounded text-rose-500 hover:bg-rose-500/10 font-bold text-xs shrink-0"
                            title="Remove shift"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => handleAddShiftSlot(companyId)}
                  className="w-full py-1.5 rounded-md border border-dashed border-primary/40 text-primary hover:bg-primary/5 text-xs font-bold flex items-center justify-center gap-1 transition-colors"
                >
                  + Add Shift Slot
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium">Shift Hours</label>
                    <ShiftHoursInput
                      hours={shiftHoursVal}
                      onChangeHours={(newHours) => {
                        const newEnd = calculateShiftEndTime(
                          membership.shiftStartTime || "09:00",
                          newHours,
                        );
                        update(companyId, {
                          shiftStartTime: membership.shiftStartTime || "09:00",
                          shiftEndTime: newEnd,
                          requiredWorkMinutes: Math.round(newHours * 60),
                        });
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">Shift timezone</label>
                    <select
                      value={membership.shiftTimezone || DEFAULT_SHIFT_TIMEZONE}
                      onChange={(event) => update(companyId, { shiftTimezone: event.target.value })}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      {ATTENDANCE_TIMEZONES.map((zone) => (
                        <option key={zone.value} value={zone.value}>
                          {zone.short}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium">Shift start</label>
                    <input
                      type="time"
                      value={membership.shiftStartTime || "09:00"}
                      onChange={(event) => {
                        const newStart = event.target.value;
                        const newEnd = calculateShiftEndTime(newStart, shiftHoursVal);
                        update(companyId, {
                          shiftStartTime: newStart,
                          shiftEndTime: newEnd,
                          requiredWorkMinutes: Math.round(shiftHoursVal * 60),
                        });
                      }}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">Shift end</label>
                    <input
                      type="time"
                      value={membership.shiftEndTime || "17:00"}
                      onChange={(event) => {
                        const newEnd = event.target.value;
                        const calculatedMins = calculateShiftMinutes(
                          membership.shiftStartTime || "09:00",
                          newEnd,
                        );
                        update(companyId, {
                          shiftEndTime: newEnd,
                          requiredWorkMinutes: calculatedMins,
                        });
                      }}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PromoteModal({
  emp,
  depts,
  companies = [],
  onClose,
}: {
  emp: Employee;
  depts: Department[];
  companies?: Company[];
  onClose: () => void;
}) {
  const initialCompanyIds = getEmployeeCompanyIds(emp);
  const [name, setName] = useState(emp.name ?? "");
  const [email, setEmail] = useState(emp.email ?? "");
  const [jobTitle, setJobTitle] = useState(emp.jobTitle ?? "");
  const [deptId, setDeptId] = useState(emp.deptId ?? "");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>(initialCompanyIds);
  const [companyMemberships, setCompanyMemberships] = useState<Record<string, CompanyMembership>>(
    () => initialMemberships(emp, initialCompanyIds),
  );
  const [country, setCountry] = useState<CountryCode>(emp.country ?? "NP");
  const [state, setState] = useState(
    normalizeState(emp.state ?? depts.find((department) => department.id === emp.deptId)?.state),
  );
  const [shiftTimezone, setShiftTimezone] = useState(emp.shiftTimezone || DEFAULT_SHIFT_TIMEZONE);
  const [shiftStartTime, setShiftStartTime] = useState(emp.shiftStartTime ?? "09:00");
  const [shiftEndTime, setShiftEndTime] = useState(emp.shiftEndTime ?? "17:00");
  const [workingDays, setWorkingDays] = useState<number[]>(emp.workingDays ?? [0, 1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const { user, company } = useAuth();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const cleanEmail = email.toLowerCase().trim();
    const cleanName = name.trim() || emp.name;
    const emailChanged = cleanEmail && cleanEmail !== (emp.email || "").toLowerCase().trim();

    try {
      const finalCompanyIds = selectedCompanyIds.length > 0 ? selectedCompanyIds : [COMPANY_ID];
      const normalizedMemberships = Object.fromEntries(
        finalCompanyIds.map((companyId) => [
          companyId,
          buildCompanyMembership(companyId, {
            ...(companyMemberships[companyId] || {}),
            departmentId: deptId,
            workingDays,
          }),
        ]),
      );
      const primaryMembership = normalizedMemberships[finalCompanyIds[0]];
      await updateDoc(
        doc(db(), "employees", emp.id),
        cleanFirestoreData({
          name: cleanName,
          email: cleanEmail || emp.email,
          jobTitle: jobTitle.trim() || emp.jobTitle,
          deptId: deptId || "",
          companyId: finalCompanyIds[0],
          companyIds: finalCompanyIds,
          companyMemberships: normalizedMemberships,
          country,
          state: state || "N/A",
          timezone: COUNTRY_TIMEZONES[country].timezone,
          requiredWorkMinutes: primaryMembership.requiredWorkMinutes,
          isMultipleShift: primaryMembership.isMultipleShift ?? false,
          shifts: primaryMembership.shifts || [],
          shiftTimezone: primaryMembership.shiftTimezone || shiftTimezone,
          shiftStartTime: primaryMembership.shiftStartTime || shiftStartTime || "09:00",
          shiftEndTime: primaryMembership.shiftEndTime || shiftEndTime || "17:00",
          workingDays,
        }),
      );

      if (emailChanged) {
        if (emp.inviteStatus === "pending") {
          const token = crypto.randomUUID().replace(/-/g, "");
          await setDoc(doc(db(), "invites", token), {
            employeeId: emp.id,
            email: cleanEmail,
            createdAt: new Date().toISOString(),
            used: false,
          });

          let emailSent = false;
          try {
            const idToken = await user?.getIdToken();
            if (idToken) {
              const notificationResponse = await fetch("/api/invite-notification", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${idToken}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  employeeId: emp.id,
                  employeeName: cleanName,
                  employeeEmail: cleanEmail,
                  inviteToken: token,
                  company: companyEmailBranding(
                    findCompanyById(companies, selectedCompanyIds[0]) || company,
                    selectedCompanyIds[0] || COMPANY_ID,
                  ),
                  departmentName: depts.find((d) => d.id === deptId)?.name || "",
                  jobTitle: jobTitle.trim() || emp.jobTitle,
                  country,
                  state,
                  shiftStartTime: primaryMembership.shiftStartTime,
                  shiftEndTime: primaryMembership.shiftEndTime,
                  shiftTimezone: primaryMembership.shiftTimezone,
                }),
              });
              emailSent = notificationResponse.ok;
            }
          } catch {
            emailSent = false;
          }

          if (emailSent) {
            toast.success(`Updated email to ${cleanEmail} & re-sent invitation email!`);
          } else {
            toast.warning(
              `Updated email to ${cleanEmail}, but email sending failed. Copy link from list.`,
            );
          }
        } else {
          toast.success(`Updated email to ${cleanEmail} (accepted employee profile updated)`);
        }
      } else {
        toast.success(`Updated ${cleanName}`);
      }
      onClose();
    } catch (err) {
      toast.error("Failed to save updates: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={save}
        className="w-full max-w-md rounded-xl bg-card p-6 shadow-lift max-h-[90vh] overflow-y-auto space-y-4 text-left"
      >
        <div>
          <h3 className="text-lg font-bold text-primary">Edit Employee Profile</h3>
          <p className="text-xs text-muted-foreground">
            Update employee details, email, location, and working shift schedule.
          </p>
        </div>
        <Field label="Full name" value={name} onChange={setName} />
        <Field label="Email address" type="email" value={email} onChange={setEmail} />
        <Field label="Job title" value={jobTitle} onChange={setJobTitle} />
        <div>
          <label className="text-sm font-medium">Department</label>
          <select
            value={deptId}
            onChange={(e) => {
              setDeptId(e.target.value);
              const departmentState = depts.find(
                (department) => department.id === e.target.value,
              )?.state;
              if (departmentState) setState(normalizeState(departmentState));
            }}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
          >
            <option value="">Select department</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">Company Allocation</label>
          <div className="mt-1 space-y-1.5 rounded-md border bg-background p-2.5 max-h-36 overflow-y-auto">
            {(companies.length > 0
              ? companies
              : [{ id: COMPANY_ID, name: "Main Company", isMain: true }]
            ).map((c) => {
              const cId = c.id || COMPANY_ID;
              const isChecked = selectedCompanyIds.includes(cId);
              return (
                <label
                  key={cId}
                  className="flex items-center gap-2 text-xs font-semibold cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {
                      setSelectedCompanyIds((prev) => {
                        if (isChecked) return prev.filter((id) => id !== cId);
                        setCompanyMemberships((current) => ({
                          ...current,
                          [cId]:
                            current[cId] ||
                            buildCompanyMembership(cId, {
                              shiftStartTime,
                              shiftEndTime,
                              shiftTimezone,
                              workingDays,
                              departmentId: deptId,
                            }),
                        }));
                        return [...prev, cId];
                      });
                    }}
                  />
                  <span>
                    {c.name} {c.isMain ? "(Main)" : ""}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <CompanyMembershipSettings
          companies={companies}
          selectedCompanyIds={selectedCompanyIds}
          value={companyMemberships}
          onChange={setCompanyMemberships}
        />
        <div>
          <label className="text-sm font-medium">Employee location</label>
          <select
            value={country}
            onChange={(e) => {
              setCountry(e.target.value as CountryCode);
              setState("N/A");
            }}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
          >
            <option value="NP">Nepal (Asia/Kathmandu)</option>
            <option value="AU">Australia (Australia/Sydney)</option>
            <option value="PH">Philippines (Asia/Manila)</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">State / province / region (optional)</label>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
          >
            {getStateOptions(country).map((option) => (
              <option key={option} value={option}>
                {option === "N/A" ? "N/A — no state" : option}
              </option>
            ))}
          </select>
        </div>
        <WorkingDaysPicker value={workingDays} onChange={setWorkingDays} />
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-lift rounded-md border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="btn-lift rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-bold"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
function NewEmployeeForm({
  departments,
  companies = [],
  onClose,
}: {
  departments: Department[];
  companies?: Company[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [deptId, setDeptId] = useState(departments[0]?.id ?? "");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>([COMPANY_ID]);
  const [companyMemberships, setCompanyMemberships] = useState<Record<string, CompanyMembership>>(
    () =>
      initialMemberships(null, [COMPANY_ID], {
        requiredWorkMinutes: 480,
        shiftStartTime: "09:00",
        shiftEndTime: "17:00",
        shiftTimezone: DEFAULT_SHIFT_TIMEZONE,
      }),
  );
  const [country, setCountry] = useState<CountryCode>("PH");
  const [state, setState] = useState(
    normalizeState(departments.find((department) => department.id === departments[0]?.id)?.state),
  );
  const [shiftTimezone, setShiftTimezone] = useState(DEFAULT_SHIFT_TIMEZONE);
  const [shiftStartTime, setShiftStartTime] = useState("09:00");
  const [shiftEndTime, setShiftEndTime] = useState("17:00");
  const [workingDays, setWorkingDays] = useState<number[]>([0, 1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [createdEmpId, setCreatedEmpId] = useState<string | null>(null);
  const [inviteEmailSent, setInviteEmailSent] = useState<boolean | null>(null);
  const { user, company } = useAuth();
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cleanEmail = email.toLowerCase().trim();
    const cleanName = name.trim();
    if (!cleanEmail || !cleanName) return;
    setBusy(true);
    const empRef = doc(collection(db(), "employees"));
    const empId = empRef.id;
    const token = crypto.randomUUID().replace(/-/g, "");
    const inviteUrl = `${window.location.origin}/invite/${token}`;
    try {
      const finalCompanyIds = selectedCompanyIds.length > 0 ? selectedCompanyIds : [COMPANY_ID];
      const normalizedMemberships = Object.fromEntries(
        finalCompanyIds.map((companyId) => [
          companyId,
          buildCompanyMembership(companyId, {
            ...(companyMemberships[companyId] || {}),
            departmentId: deptId,
            workingDays,
          }),
        ]),
      );
      const primaryMembership = normalizedMemberships[finalCompanyIds[0]];
      const existingEmployees = await getDocs(
        query(collection(db(), "employees"), where("email", "==", cleanEmail)),
      );
      if (!existingEmployees.empty) {
        const existingDoc =
          existingEmployees.docs.find((item) => item.data().inviteStatus === "accepted") ||
          existingEmployees.docs[0];
        const existingEmployee = {
          id: existingDoc.id,
          ...(existingDoc.data() as Omit<Employee, "id">),
        };
        const existingCompanyIds = getEmployeeCompanyIds(existingEmployee);
        const mergedCompanyIds = [...new Set([...existingCompanyIds, ...finalCompanyIds])];
        await updateDoc(
          existingDoc.ref,
          cleanFirestoreData({
            companyId: existingEmployee.companyId || mergedCompanyIds[0],
            companyIds: mergedCompanyIds,
            companyMemberships: {
              ...initialMemberships(existingEmployee, existingCompanyIds),
              ...(existingEmployee.companyMemberships || {}),
              ...normalizedMemberships,
            },
            updatedAt: new Date().toISOString(),
          }),
        );
        toast.success(
          `${existingEmployee.name} was added to the selected company without a duplicate account.`,
        );
        onClose();
        navigate({ to: "/admin/employees/$id", params: { id: existingEmployee.id } });
        return;
      }

      await Promise.all([
        setDoc(
          empRef,
          cleanFirestoreData({
            companyId: finalCompanyIds[0],
            companyIds: finalCompanyIds,
            companyMemberships: normalizedMemberships,
            deptId: deptId || "",
            name: cleanName,
            email: cleanEmail,
            jobTitle: jobTitle.trim() || "Virtual Assistant",
            requiredWorkMinutes: primaryMembership.requiredWorkMinutes,
            isMultipleShift: primaryMembership.isMultipleShift ?? false,
            shifts: primaryMembership.shifts || [],
            shiftStartTime: primaryMembership.shiftStartTime || shiftStartTime || "09:00",
            shiftEndTime: primaryMembership.shiftEndTime || shiftEndTime || "17:00",
            shiftTimezone: primaryMembership.shiftTimezone || shiftTimezone,
            workingDays: workingDays || [0, 1, 2, 3, 4, 5],
            country: country || "NP",
            state: state || "N/A",
            timezone: COUNTRY_TIMEZONES[country]?.timezone || "Asia/Kathmandu",
            status: "active",
            inviteStatus: "pending",
            reportingRequirement: "sod_eod",
            createdAt: new Date().toISOString(),
          }),
        ),
        setDoc(doc(db(), "invites", token), {
          employeeId: empId,
          email: cleanEmail,
          createdAt: new Date().toISOString(),
          used: false,
        }),
      ]);
      setCreatedInviteUrl(inviteUrl);
      setCreatedEmpId(empId);

      let emailSent = false;
      try {
        const idToken = await user?.getIdToken();
        if (idToken) {
          const notificationResponse = await fetch("/api/invite-notification", {
            method: "POST",
            headers: {
              authorization: `Bearer ${idToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              employeeId: empId,
              employeeName: cleanName,
              employeeEmail: cleanEmail,
              inviteToken: token,
              company: companyEmailBranding(
                findCompanyById(companies, selectedCompanyIds[0]) || company,
                selectedCompanyIds[0] || COMPANY_ID,
              ),
              departmentName:
                departments.find((department) => department.id === deptId)?.name || "",
              jobTitle: jobTitle.trim(),
              country,
              state,
              shiftStartTime: primaryMembership.shiftStartTime,
              shiftEndTime: primaryMembership.shiftEndTime,
              shiftTimezone: primaryMembership.shiftTimezone,
            }),
          });
          emailSent = notificationResponse.ok;
        }
      } catch {
        emailSent = false;
      }
      setInviteEmailSent(emailSent);
      const emailAttemptedAt = new Date().toISOString();
      updateDoc(doc(db(), "invites", token), {
        emailStatus: emailSent ? "sent" : "failed",
        emailAttemptedAt,
        ...(emailSent ? { emailSentAt: emailAttemptedAt } : {}),
      }).catch(() => {});
      if (emailSent) {
        toast.success(`Employee created and invite emailed to ${cleanEmail}`);
      } else {
        toast.warning(
          "Employee created, but invite email could not be sent. Copy the link instead.",
        );
      }
    } catch (err) {
      toast.error("Database save failed: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (createdInviteUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-xl bg-card p-6 shadow-lift text-center">
          <h3 className="text-lg font-bold text-primary">Employee created</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {inviteEmailSent
              ? `An invitation email was sent automatically to ${email}.`
              : `Email delivery is unavailable. Share this activation link with ${name}.`}
          </p>
          <input
            readOnly
            value={createdInviteUrl}
            onClick={(e) => e.currentTarget.select()}
            className="mt-4 w-full rounded-md border bg-secondary/50 p-2 text-xs font-mono"
          />
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() =>
                copyToClipboard(createdInviteUrl).then(
                  (ok) => ok && toast.success("Invite link copied"),
                )
              }
              className="rounded-md border px-4 py-2 text-sm"
            >
              Copy link
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                if (createdEmpId)
                  navigate({ to: "/admin/employees/$id", params: { id: createdEmpId } });
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            >
              View profile
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-card p-6 shadow-lift max-h-[90vh] overflow-y-auto"
      >
        <h3 className="text-lg font-semibold text-primary">Add person to company</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          If the email already exists, the person is attached to the selected companies without a
          duplicate account.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Full name" value={name} onChange={setName} />
          <Field label="Email" type="email" value={email} onChange={setEmail} />
          <Field label="Job title" value={jobTitle} onChange={setJobTitle} />
          <div>
            <label className="text-sm font-medium">Department</label>
            <select
              required
              value={deptId}
              onChange={(e) => {
                setDeptId(e.target.value);
                setState(
                  normalizeState(
                    departments.find((department) => department.id === e.target.value)?.state,
                  ),
                );
              }}
              className="mt-1 w-full rounded-md border px-3 py-2 bg-background font-medium"
            >
              <option value="">Select department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Company Allocation</label>
            <div className="mt-1 space-y-1.5 rounded-md border bg-background p-2.5 max-h-36 overflow-y-auto">
              {(companies.length > 0
                ? companies
                : [{ id: COMPANY_ID, name: "Main Company", isMain: true }]
              ).map((c) => {
                const cId = c.id || COMPANY_ID;
                const isChecked = selectedCompanyIds.includes(cId);
                return (
                  <label
                    key={cId}
                    className="flex items-center gap-2 text-xs font-semibold cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        setSelectedCompanyIds((prev) => {
                          if (isChecked) return prev.filter((id) => id !== cId);
                          setCompanyMemberships((current) => ({
                            ...current,
                            [cId]:
                              current[cId] ||
                              buildCompanyMembership(cId, {
                                shiftStartTime,
                                shiftEndTime,
                                shiftTimezone,
                                workingDays,
                                departmentId: deptId,
                              }),
                          }));
                          return [...prev, cId];
                        });
                      }}
                    />
                    <span>
                      {c.name} {c.isMain ? "(Main)" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <CompanyMembershipSettings
            companies={companies}
            selectedCompanyIds={selectedCompanyIds}
            value={companyMemberships}
            onChange={setCompanyMemberships}
          />
          <div>
            <label className="text-sm font-medium">Employee location</label>
            <select
              value={country}
              onChange={(e) => {
                setCountry(e.target.value as CountryCode);
                setState("N/A");
              }}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
            >
              <option value="NP">Nepal (Asia/Kathmandu)</option>
              <option value="AU">Australia (Australia/Sydney)</option>
              <option value="PH">Philippines (Asia/Manila)</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">State / province / region (optional)</label>
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
            >
              {getStateOptions(country).map((option) => (
                <option key={option} value={option}>
                  {option === "N/A" ? "N/A — no state" : option}
                </option>
              ))}
            </select>
          </div>
          <WorkingDaysPicker value={workingDays} onChange={setWorkingDays} />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {busy ? "Saving…" : "Add / Invite"}
          </button>
        </div>
      </form>
    </div>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <input
        required
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border px-3 py-2"
      />
    </div>
  );
}
