import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { collection, doc, onSnapshot, runTransaction, setDoc, updateDoc } from "firebase/firestore";
import { DEFAULT_SHIFT_TIMEZONE, zonedDateKey } from "@/lib/attendance";
import {
  Archive,
  ArchiveRestore,
  Building2,
  Check,
  Image as ImageIcon,
  MapPin,
  PartyPopper,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type CompanyHoliday,
  type Department,
  type Employee,
} from "@/lib/types";
import { formatWorkingDaysSummary, WorkingDaysPicker } from "@/components/WorkingDaysPicker";
import { HolidayPlanner } from "@/components/HolidayPlanner";
import { DaylightSavingCard } from "@/components/DaylightSavingCard";
import { HolidayAnswersCard } from "@/components/HolidayAnswersCard";
import { CompanyOverviewCard } from "@/components/CompanyOverviewCard";
import { EmailChipsInput } from "@/components/EmailChipsInput";
import {
  CLIENT_EMAIL_TOPICS,
  clientWants,
  companyClientEmails,
  parseClientEmails,
  type ClientEmailTopic,
} from "@/lib/client-emails";
import {
  companyState,
  countryInfo,
  HOLIDAY_COUNTRIES,
  regionCountry,
  regionLabel,
} from "@/lib/holidays";

export const Route = createFileRoute("/_authenticated/admin/company")({
  head: () => ({
    meta: [
      { title: "Company Settings — SavyTime Admin" },
      { name: "description", content: "Manage company branding, logo, and holidays." },
      { property: "og:title", content: "Company Settings — SavyTime Admin" },
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
    name: "Ironbrij",
    defaultShiftHours: 8,
    holidays: [],
    holidayAssignments: [],
    workingDays: [1, 2, 3, 4, 5],
    lateGraceMinutes: 5,
    punchOutGraceMinutes: 20,
    punchOutReminderMinutes: 20,
    logoUrl: DEFAULT_LOGO,
    isMain: true,
  });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAddCompanyModal, setShowAddCompanyModal] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [companyFilterTab, setCompanyFilterTab] = useState<"active" | "archived" | "all">("active");

  const [showTodayHolidayConfirmModal, setShowTodayHolidayConfirmModal] = useState(false);
  const [todayHolidayCompanyId, setTodayHolidayCompanyId] = useState("all");

  // "Today" is the company's day, not whatever day the admin's browser is in.
  const todayStr = zonedDateKey(new Date(), company.timezone || DEFAULT_SHIFT_TIMEZONE);
  // Typing in the settings form must not be undone by a snapshot of an
  // unrelated change; holidays on screen still follow the saved company.
  const settingsDirtyRef = useRef(false);
  function editSettings(next: Company) {
    settingsDirtyRef.current = true;
    setCompany(next);
  }
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
          name: "Ironbrij (Main)",
          defaultShiftHours: 8,
          holidays: [],
          workingDays: [1, 2, 3, 4, 5],
          lateGraceMinutes: 5,
          punchOutGraceMinutes: 20,
          punchOutReminderMinutes: 20,
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
        const saved: Company = {
          ...mainComp,
          name: mainComp.name || "Ironbrij",
          defaultShiftHours: mainComp.defaultShiftHours ?? 8,
          holidays: mainComp.holidays ?? [],
          holidayAssignments: mainComp.holidayAssignments ?? [],
          workingDays: mainComp.workingDays ?? [1, 2, 3, 4, 5],
          lateGraceMinutes: Math.max(5, mainComp.lateGraceMinutes ?? 5),
          punchOutGraceMinutes: Math.max(0, mainComp.punchOutGraceMinutes ?? 20),
          punchOutReminderMinutes: Math.max(0, mainComp.punchOutReminderMinutes ?? 20),
          logoUrl: mainComp.logoUrl || DEFAULT_LOGO,
          isMain: true,
        };
        setCompany((current) =>
          settingsDirtyRef.current
            ? {
                ...current,
                holidays: saved.holidays,
                holidayAssignments: saved.holidayAssignments,
                timezone: saved.timezone,
              }
            : saved,
        );
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
      // Only the settings this form shows. Holidays are saved on their own, so
      // saving settings can never put back a holiday someone else removed.
      const payload: Omit<Company, "holidays"> = {
        name: updatedCompany.name.trim() || "Ironbrij",
        defaultShiftHours: updatedCompany.defaultShiftHours || 8,
        workingDays: updatedCompany.workingDays,
        lateGraceMinutes: Math.max(5, updatedCompany.lateGraceMinutes ?? 5),
        punchOutGraceMinutes: Math.max(0, updatedCompany.punchOutGraceMinutes ?? 20),
        punchOutReminderMinutes: Math.max(0, updatedCompany.punchOutReminderMinutes ?? 20),
        logoUrl: updatedCompany.logoUrl?.trim() || DEFAULT_LOGO,
      };
      await setDoc(doc(db(), "companies", COMPANY_ID), payload, { merge: true });
      settingsDirtyRef.current = false;
      toast.success("Company settings and holidays updated successfully!");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Changes the holiday lists against what is saved now, in a transaction, so
   * two admins adding or removing holidays at once both keep their change. The
   * list on screen follows the saved company; a failed save changes nothing.
   */
  async function updateHolidays(
    change: (
      holidays: string[],
      assignments: CompanyHoliday[],
    ) => {
      holidays: string[];
      assignments: CompanyHoliday[];
    },
  ): Promise<boolean> {
    try {
      await runTransaction(db(), async (transaction) => {
        const ref = doc(db(), "companies", COMPANY_ID);
        const snapshot = await transaction.get(ref);
        const saved = (snapshot.data() ?? {}) as Partial<Company>;
        const next = change(saved.holidays ?? [], saved.holidayAssignments ?? []);
        transaction.set(
          ref,
          {
            holidays: [...new Set(next.holidays)].sort(),
            holidayAssignments: next.assignments.sort((a, b) => a.date.localeCompare(b.date)),
          },
          { merge: true },
        );
      });
      return true;
    } catch (error) {
      toast.error("Holidays could not be saved: " + (error as Error).message);
      return false;
    }
  }

  async function toggleArchiveCompany(c: Company) {
    if (c.id === COMPANY_ID || c.isMain) {
      toast.error("The main company cannot be archived.");
      return;
    }
    if (!c.id) return;
    const isArchived = Boolean(c.archived || c.status === "archived");
    const nextArchived = !isArchived;
    try {
      await updateDoc(doc(db(), "companies", c.id), {
        archived: nextArchived,
        status: nextArchived ? "archived" : "active",
      });
      toast.success(
        nextArchived
          ? `Company '${c.name}' has been archived.`
          : `Company '${c.name}' has been unarchived and restored!`,
      );
    } catch (err: any) {
      toast.error("Failed to update company: " + err.message);
    }
  }

  async function confirmTodayHoliday(targetCompId: string) {
    const cancelling = isTodayHoliday;
    const saved = await updateHolidays((holidays, assignments) =>
      cancelling
        ? {
            holidays: holidays.filter((d) => d !== todayStr),
            assignments: assignments.filter((a) => a.date !== todayStr),
          }
        : targetCompId === "all"
          ? { holidays: [...holidays, todayStr], assignments }
          : {
              holidays,
              assignments: [
                ...assignments,
                {
                  id: `today-${todayStr}-${Date.now()}`,
                  date: todayStr,
                  name: "Instant Company Off",
                  targetType: "companies",
                  companyIds: [targetCompId],
                },
              ],
            },
    );
    setShowTodayHolidayConfirmModal(false);
    if (!saved) return;
    toast.success(
      isTodayHoliday
        ? "Today's holiday cancelled!"
        : `Declared today (${todayStr}) as a Holiday! 🎉`,
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <Building2 className="h-6 w-6" /> Company Management & Holidays
          </h1>
          <p className="text-sm text-muted-foreground">
            Create companies, set logos, and allocate departments and employees.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingCompany(null);
            setShowAddCompanyModal(true);
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 hover:text-primary-foreground"
        >
          <Building2 className="h-4 w-4" /> + Create New Company
        </button>
      </div>

      {/* Wide screens: companies and holidays on the left, the overview beside them. */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          {/* Companies List */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-3">
              <div>
                <h3 className="font-semibold text-base text-foreground flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-muted-foreground" /> Registered Companies (
                  {companies.length})
                </h3>
                <p className="text-xs text-muted-foreground">
                  Manage client companies, logos, working days, and status.
                </p>
              </div>

              {/* Filter Tabs */}
              <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setCompanyFilterTab("active")}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    companyFilterTab === "active"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Active ({companies.filter((c) => !c.archived && c.status !== "archived").length})
                </button>
                <button
                  type="button"
                  onClick={() => setCompanyFilterTab("archived")}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    companyFilterTab === "archived"
                      ? "bg-background text-amber-600 dark:text-amber-400 font-bold shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Archived (
                  {companies.filter((c) => Boolean(c.archived || c.status === "archived")).length})
                </button>
                <button
                  type="button"
                  onClick={() => setCompanyFilterTab("all")}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    companyFilterTab === "all"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  All ({companies.length})
                </button>
              </div>
            </div>

            {companies.filter((c) => {
              const isArchived = Boolean(c.archived || c.status === "archived");
              if (companyFilterTab === "active") return !isArchived;
              if (companyFilterTab === "archived") return isArchived;
              return true;
            }).length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground">
                No {companyFilterTab === "archived" ? "archived" : "active"} companies found.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {companies
                  .filter((c) => {
                    const isArchived = Boolean(c.archived || c.status === "archived");
                    if (companyFilterTab === "active") return !isArchived;
                    if (companyFilterTab === "archived") return isArchived;
                    return true;
                  })
                  .map((c) => {
                    const compDepts = departments.filter(
                      (d) =>
                        d.companyId === c.id || (!d.companyId && (c.id === COMPANY_ID || c.isMain)),
                    ).length;
                    const compEmps = employees.filter(
                      (e) =>
                        e.companyId === c.id ||
                        e.companyIds?.includes(c.id || "") ||
                        (!e.companyId && (c.id === COMPANY_ID || c.isMain)),
                    ).length;
                    const isArchived = Boolean(c.archived || c.status === "archived");
                    const isMainCompany = c.id === COMPANY_ID || c.isMain;

                    return (
                      <div
                        key={c.id || c.name}
                        className={`flex items-start justify-between gap-3 rounded-lg border p-4 transition-colors ${
                          isArchived ? "bg-muted/20 border-dashed opacity-80" : "hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <img
                            src={c.logoUrl || DEFAULT_LOGO}
                            alt={c.name}
                            className="h-9 w-9 rounded-lg border bg-background object-contain shrink-0 mt-0.5"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).src = DEFAULT_LOGO;
                            }}
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-sm text-foreground truncate block">
                                {c.name}
                              </span>
                              {isMainCompany && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-primary/15 text-primary border border-primary/20 shrink-0">
                                  Main
                                </span>
                              )}
                              {isArchived && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25 shrink-0">
                                  Archived
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {compEmps} Employees · {compDepts} Departments
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-0.5 font-medium">
                              Shift: {c.defaultShiftHours || 8}h · Grace: {c.lateGraceMinutes || 5}m
                            </div>
                            <div className="text-[11px] text-primary mt-1 font-semibold flex items-center gap-1">
                              <span>📅 {formatWorkingDaysSummary(c.workingDays)}</span>
                            </div>
                            <div className="text-[11px] mt-0.5 text-muted-foreground truncate">
                              ✉{" "}
                              {companyClientEmails(c).length > 0
                                ? companyClientEmails(c).join(", ")
                                : "No client email"}
                            </div>
                            <div className="text-[11px] mt-0.5 font-semibold flex items-center gap-1">
                              <MapPin className="h-3 w-3 text-muted-foreground" />
                              {companyState(c) ? (
                                <span className="text-foreground">
                                  {regionLabel(companyState(c))},{" "}
                                  {countryInfo(regionCountry(companyState(c)) ?? "AU").name}
                                </span>
                              ) : (
                                <span className="text-amber-600 dark:text-amber-400">
                                  No state set — state holidays won&apos;t reach it
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCompany(c);
                              setShowAddCompanyModal(true);
                            }}
                            className="rounded-lg border px-2.5 py-1 text-xs font-bold text-primary hover:bg-background transition-colors"
                          >
                            Edit
                          </button>

                          {!isMainCompany && (
                            <button
                              type="button"
                              onClick={() => toggleArchiveCompany(c)}
                              className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors flex items-center gap-1 ${
                                isArchived
                                  ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                                  : "text-muted-foreground hover:text-amber-600 border-muted hover:border-amber-500/30 hover:bg-amber-500/10"
                              }`}
                              title={isArchived ? "Restore / Unarchive Company" : "Archive Company"}
                            >
                              {isArchived ? (
                                <>
                                  <ArchiveRestore className="h-3 w-3" /> Unarchive
                                </>
                              ) : (
                                <>
                                  <Archive className="h-3 w-3" /> Archive
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-lift space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-extrabold text-base text-primary flex items-center gap-2">
                  <PartyPopper className="h-5 w-5 text-purple-600" /> Today&apos;s Company Off
                  Status
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

          <HolidayPlanner
            calendar={company}
            companies={companies}
            departments={departments}
            employees={employees}
            todayStr={todayStr}
            updateHolidays={updateHolidays}
          />
        </div>

        <aside className="min-w-0 space-y-6">
          <CompanyOverviewCard
            calendar={company}
            companies={companies}
            employees={employees}
            todayStr={todayStr}
            onEdit={(target) => {
              setEditingCompany(target);
              setShowAddCompanyModal(true);
            }}
          />

          <HolidayAnswersCard todayStr={todayStr} />

          <DaylightSavingCard />

          <div className="rounded-xl border bg-card p-6 space-y-4 shadow-lift">
            <h2 className="font-bold text-primary flex items-center gap-2">
              <ImageIcon className="h-4 w-4" /> Company Settings
            </h2>
            <div>
              <label className="text-sm font-semibold">Company Name</label>
              <input
                value={company.name}
                onChange={(event) => editSettings({ ...company, name: event.target.value })}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
              />
            </div>
            <div>
              <label className="text-sm font-semibold">Logo Image URL</label>
              <input
                value={company.logoUrl ?? ""}
                onChange={(event) => editSettings({ ...company, logoUrl: event.target.value })}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
              />
            </div>
            <div>
              <label className="text-sm font-semibold">Default Shift Duration (Hours)</label>
              <input
                type="number"
                value={company.defaultShiftHours}
                onChange={(event) =>
                  editSettings({
                    ...company,
                    defaultShiftHours: Number(event.target.value) || 8,
                  })
                }
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
              />
            </div>
            <div className="pt-2 border-t">
              <WorkingDaysPicker
                label="Company Default Working Days"
                value={company.workingDays}
                onChange={(days) => editSettings({ ...company, workingDays: days })}
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
        </aside>
      </div>

      {(showAddCompanyModal || editingCompany !== null) && (
        <CompanyModal
          companyToEdit={editingCompany}
          people={employees}
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
  people = [],
  onClose,
}: {
  companyToEdit?: Company | null;
  /** Everyone we know, so an address shows its person's name and photo. */
  people?: Employee[];
  onClose: () => void;
}) {
  const [name, setName] = useState(companyToEdit?.name ?? "");
  const [code, setCode] = useState(companyToEdit?.code ?? "");
  const [state, setState] = useState(companyState(companyToEdit));
  const [logoUrl, setLogoUrl] = useState(companyToEdit?.logoUrl ?? DEFAULT_LOGO);
  const [defaultShiftHours, setDefaultShiftHours] = useState(companyToEdit?.defaultShiftHours ?? 8);
  const [lateGraceMinutes, setLateGraceMinutes] = useState(companyToEdit?.lateGraceMinutes ?? 5);
  const [autoDeductUnloggedBreak, setAutoDeductUnloggedBreak] = useState(
    companyToEdit?.autoDeductUnloggedBreak !== false,
  );
  const [clientEmails, setClientEmails] = useState<string[]>(companyClientEmails(companyToEdit));
  const [clientTopics, setClientTopics] = useState(
    () =>
      Object.fromEntries(
        CLIENT_EMAIL_TOPICS.map(({ topic }) => [topic, clientWants(companyToEdit, topic)]),
      ) as Record<ClientEmailTopic, boolean>,
  );
  const [weeklyReportAllRecipients, setWeeklyReportAllRecipients] = useState<string[]>(
    parseClientEmails(companyToEdit?.weeklyReportAllRecipients),
  );
  const splitEmails = (value: string[]) => parseClientEmails(value);
  const [punchOutGraceMinutes, setPunchOutGraceMinutes] = useState(
    companyToEdit?.punchOutGraceMinutes ?? 20,
  );
  const [punchOutReminderMinutes, setPunchOutReminderMinutes] = useState(
    companyToEdit?.punchOutReminderMinutes ?? 20,
  );
  const [workingDays, setWorkingDays] = useState<number[]>(
    companyToEdit?.workingDays ?? [0, 1, 2, 3, 4, 5],
  );
  const [archived, setArchived] = useState<boolean>(
    Boolean(companyToEdit?.archived || companyToEdit?.status === "archived"),
  );
  const [busy, setBusy] = useState(false);
  const isMain = companyToEdit?.id === COMPANY_ID || companyToEdit?.isMain;

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
          state,
          logoUrl: logoUrl.trim() || DEFAULT_LOGO,
          defaultShiftHours: Number(defaultShiftHours) || 8,
          lateGraceMinutes: Math.max(5, Number(lateGraceMinutes) || 5),
          punchOutGraceMinutes: Math.max(0, Number(punchOutGraceMinutes) || 0),
          autoDeductUnloggedBreak,
          clientEmails: splitEmails(clientEmails),
          clientEmailTopics: clientTopics,
          weeklyReportRecipients: splitEmails(clientEmails),
          ...(isMain ? { weeklyReportAllRecipients: splitEmails(weeklyReportAllRecipients) } : {}),
          punchOutReminderMinutes: Math.max(0, Number(punchOutReminderMinutes) || 0),
          workingDays: workingDays && workingDays.length > 0 ? workingDays : [0, 1, 2, 3, 4, 5],
          archived: isMain ? false : archived,
          status: isMain || !archived ? "active" : "archived",
        });
        toast.success(`Updated ${name}`);
      } else {
        const compRef = doc(collection(db(), "companies"));
        await setDoc(compRef, {
          name: name.trim(),
          code: code.trim().toUpperCase(),
          state,
          logoUrl: logoUrl.trim() || DEFAULT_LOGO,
          defaultShiftHours: Number(defaultShiftHours) || 8,
          lateGraceMinutes: Math.max(5, Number(lateGraceMinutes) || 5),
          punchOutGraceMinutes: Math.max(0, Number(punchOutGraceMinutes) || 0),
          autoDeductUnloggedBreak,
          clientEmails: splitEmails(clientEmails),
          clientEmailTopics: clientTopics,
          weeklyReportRecipients: splitEmails(clientEmails),
          ...(isMain ? { weeklyReportAllRecipients: splitEmails(weeklyReportAllRecipients) } : {}),
          punchOutReminderMinutes: Math.max(0, Number(punchOutReminderMinutes) || 0),
          workingDays: workingDays && workingDays.length > 0 ? workingDays : [0, 1, 2, 3, 4, 5],
          holidays: [],
          isMain: false,
          archived: false,
          status: "active",
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
          <label className="text-sm font-medium">State</label>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
          >
            <option value="">Not set</option>
            {HOLIDAY_COUNTRIES.map((country) => (
              <optgroup key={country.code} label={country.name}>
                {country.regions.map((region) => (
                  <option key={region.code} value={region.code}>
                    {region.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Holidays for this state give everyone the holiday for their work here. People who also
            work for a company in another state keep working there as normal.
          </p>
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
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).src = DEFAULT_LOGO;
                }}
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Punch-out Grace (Minutes)</label>
            <input
              type="number"
              min={0}
              value={punchOutGraceMinutes}
              onChange={(event) => setPunchOutGraceMinutes(Number(event.target.value))}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Reminder Before End (Minutes)</label>
            <input
              type="number"
              min={0}
              value={punchOutReminderMinutes}
              onChange={(event) => setPunchOutReminderMinutes(Number(event.target.value))}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium"
            />
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
          <div>
            <label className="text-sm font-medium">Client email</label>
            <p className="text-xs text-muted-foreground">
              Everyone at this client our emails go to. Type an address and press Enter or +. Leave
              empty and the client gets no emails.
            </p>
            <div className="mt-1.5">
              <EmailChipsInput
                value={clientEmails}
                onChange={setClientEmails}
                people={people}
                placeholder="client@example.com"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-muted-foreground">Send the client</div>
            {CLIENT_EMAIL_TOPICS.map(({ topic, label, hint }) => (
              <label key={topic} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={clientTopics[topic]}
                  onChange={(event) =>
                    setClientTopics({ ...clientTopics, [topic]: event.target.checked })
                  }
                />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {isMain && (
            <div className="border-t pt-2.5">
              <label className="text-sm font-medium">All-clients report recipients</label>
              <p className="text-xs text-muted-foreground">
                Who receives the combined report covering every client.
              </p>
              <div className="mt-1.5">
                <EmailChipsInput
                  value={weeklyReportAllRecipients}
                  onChange={setWeeklyReportAllRecipients}
                  people={people}
                  placeholder="ops@example.com"
                />
              </div>
            </div>
          )}
        </div>

        <label className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autoDeductUnloggedBreak}
            onChange={(event) => setAutoDeductUnloggedBreak(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Deduct an unlogged break</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              When a shift runs a full break longer than its required hours and nobody punched a
              break, charge the employee's break allowance instead of counting it as overtime.
            </span>
          </span>
        </label>

        <div className="pt-2 border-t">
          <WorkingDaysPicker
            label="Working Days for this Company"
            value={workingDays}
            onChange={setWorkingDays}
            compact
          />
        </div>

        {companyToEdit && !isMain && (
          <div className="rounded-lg border bg-muted/30 p-3 pt-2">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-xs font-bold text-foreground block">Archive Company</span>
                <span className="text-[11px] text-muted-foreground">
                  Hide this company from active dropdowns and company switcher
                </span>
              </div>
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-primary"
              />
            </label>
          </div>
        )}

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
