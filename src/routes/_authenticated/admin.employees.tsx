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
  type CountryCode,
  type Department,
  type Employee,
  type Punch,
} from "@/lib/types";
import { COUNTRY_TIMEZONES } from "@/lib/time";
import { getStateOptions, normalizeState } from "@/lib/states";
import {
  ATTENDANCE_TIMEZONES,
  DEFAULT_SHIFT_TIMEZONE,
  formatInTimezone,
  getShiftWindow,
  zonedDateKey,
} from "@/lib/attendance";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";

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

function formatShiftRange(start?: string, end?: string): string {
  const s = start || "09:00";
  const e = end || "17:00";

  const formatTimeStr = (tStr: string) => {
    const [h, m] = tStr.split(":").map(Number);
    const d = new Date();
    d.setHours(h || 9, m || 0, 0, 0);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  };

  return `${formatTimeStr(s)} - ${formatTimeStr(e)}`;
}

export const Route = createFileRoute("/_authenticated/admin/employees")({
  head: () => ({
    meta: [
      { title: "Employees — SavyTime Admin" },
      { name: "description", content: "Manage your team." },
      { property: "og:title", content: "Employees — SavyTime Admin" },
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
  const [todayPunches, setTodayPunches] = useState<Punch[]>([]);
  const [filterDept, setFilterDept] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [empToDelete, setEmpToDelete] = useState<Employee | null>(null);
  const [empToPromote, setEmpToPromote] = useState<Employee | null>(null);

  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading || !user) return;

    const un1 = onSnapshot(
      query(collection(db(), "employees")),
      (snap) => {
        setEmployees(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Employee));
      },
      (err) => console.error("Employees sub err:", err),
    );

    const un2 = onSnapshot(
      collection(db(), "departments"),
      (snap) => {
        setDepts(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Department));
      },
      (err) => console.error("Depts sub err:", err),
    );

    const todayStr = zonedDateKey(new Date(), DEFAULT_SHIFT_TIMEZONE);
    const un3 = onSnapshot(
      query(collection(db(), "punches"), where("date", "==", todayStr)),
      (snap) => {
        setTodayPunches(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Punch));
      },
      (err) => console.error("Punches sub err:", err),
    );

    return () => {
      un1();
      un2();
      un3();
    };
  }, [user, authLoading]);

  function getPunchStatus(empId: string): "in" | "out" {
    const userPunches = todayPunches.filter((p) => p.employeeId === empId);
    if (userPunches.length === 0) return "out";
    userPunches.sort((a, b) => {
      const tA = a.timestamp?.toMillis() || 0;
      const tB = b.timestamp?.toMillis() || 0;
      return tA - tB;
    });
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

  async function handleToggleStatus(emp: Employee) {
    const newStatus = emp.status === "active" ? "inactive" : "active";
    try {
      await updateDoc(doc(db(), "employees", emp.id), { status: newStatus });
      toast.success(`${emp.name} marked as ${newStatus}`);
    } catch (err) {
      toast.error("Failed to update status: " + (err as Error).message);
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

  // Deduplicate employees by email (prefer accepted over pending to hide temp invitation docs once accepted)
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
          className="btn-lift rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          + New Employee
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
                <th className="p-3">Country</th>
                <th className="p-3">Shift Hours</th>
                <th className="p-3">Status</th>
                <th className="p-3">Invite Link</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-muted-foreground">
                    No employees yet. Click "New Employee" to invite one.
                  </td>
                </tr>
              )}
              {filtered.map((e) => (
                <tr key={e.id} className="border-t hover:bg-sky-soft/40 transition-colors">
                  <td className="p-3 font-medium">
                    <Link
                      to="/admin/employees/$id"
                      params={{ id: e.id }}
                      className="text-primary hover:underline"
                    >
                      {e.name}
                    </Link>
                  </td>
                  <td className="p-3">{e.jobTitle}</td>
                  <td className="p-3">{depts.find((d) => d.id === e.deptId)?.name ?? "—"}</td>
                  <td className="p-3 text-xs">
                    <span
                      className="inline-flex items-center gap-1 font-semibold"
                      title={COUNTRY_TIMEZONES[e.country ?? "PH"]?.name || "Philippines"}
                    >
                      <span>{COUNTRY_TIMEZONES[e.country ?? "PH"]?.flag || "🇵🇭"}</span>
                      <span>{COUNTRY_TIMEZONES[e.country ?? "PH"]?.name || "Philippines"}</span>
                      <span className="text-muted-foreground">· {normalizeState(e.state)}</span>
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    ⏰ {formatShiftRange(e.shiftStartTime, e.shiftEndTime)}
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
                        title="Edit employee profile and shift"
                      >
                        Edit
                      </button>
                      <Link
                        to="/admin/employees/$id"
                        params={{ id: e.id }}
                        className="btn-lift text-xs px-2.5 py-1 rounded border border-primary/30 text-primary hover:bg-primary hover:text-primary-foreground font-semibold transition-colors flex items-center gap-1"
                      >
                        Report ↗
                      </Link>
                      <button
                        onClick={() => setEmpToDelete(e)}
                        className="btn-lift text-xs px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 transition-colors"
                        title="Remove Employee"
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
              Are you sure you want to permanently remove <strong>{empToDelete.name}</strong> (
              {empToDelete.email})?
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
        <PromoteModal emp={empToPromote} depts={depts} onClose={() => setEmpToPromote(null)} />
      )}

      {showForm && <NewEmployeeForm departments={depts} onClose={() => setShowForm(false)} />}
    </div>
  );
}

function ShiftPreview({
  shiftStartTime,
  shiftEndTime,
  shiftTimezone,
}: {
  shiftStartTime: string;
  shiftEndTime: string;
  shiftTimezone: string;
}) {
  const shiftDate = zonedDateKey(new Date(), shiftTimezone);
  const window = getShiftWindow(shiftDate, shiftStartTime, shiftEndTime, shiftTimezone);
  return (
    <div className="rounded-lg border bg-secondary/40 p-3 space-y-1.5">
      <p className="text-xs font-bold text-primary">Live timezone conversion</p>
      {ATTENDANCE_TIMEZONES.map((zone) => (
        <div key={zone.value} className="flex justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{zone.short}</span>
          <span className="font-mono font-semibold">
            {formatInTimezone(window.start, zone.value)} –{" "}
            {formatInTimezone(window.end, zone.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function PromoteModal({
  emp,
  depts,
  onClose,
}: {
  emp: Employee;
  depts: Department[];
  onClose: () => void;
}) {
  const [name, setName] = useState(emp.name ?? "");
  const [jobTitle, setJobTitle] = useState(emp.jobTitle ?? "");
  const [deptId, setDeptId] = useState(emp.deptId ?? "");
  const [country, setCountry] = useState<CountryCode>(emp.country ?? "NP");
  const [state, setState] = useState(
    normalizeState(emp.state ?? depts.find((department) => department.id === emp.deptId)?.state),
  );
  const [shiftTimezone, setShiftTimezone] = useState(emp.shiftTimezone || DEFAULT_SHIFT_TIMEZONE);
  const [shiftStartTime, setShiftStartTime] = useState(emp.shiftStartTime ?? "09:00");
  const [shiftEndTime, setShiftEndTime] = useState(emp.shiftEndTime ?? "17:00");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateDoc(doc(db(), "employees", emp.id), {
        name: name.trim() || emp.name,
        jobTitle: jobTitle.trim() || emp.jobTitle,
        deptId,
        country,
        state,
        timezone: COUNTRY_TIMEZONES[country].timezone,
        shiftTimezone,
        shiftStartTime: shiftStartTime || "09:00",
        shiftEndTime: shiftEndTime || "17:00",
      });
      toast.success(`Updated ${emp.name}`);
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
          <h3 className="text-lg font-bold text-primary">Edit Employee</h3>
          <p className="text-xs text-muted-foreground">
            Set the employee location and the timezone in which their shift is defined.
          </p>
        </div>
        <Field label="Full name" value={name} onChange={setName} />
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
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
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
        <div>
          <label className="text-sm font-medium">Shift reference timezone</label>
          <select
            value={shiftTimezone}
            onChange={(e) => setShiftTimezone(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
          >
            {ATTENDANCE_TIMEZONES.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Shift start"
            type="time"
            value={shiftStartTime}
            onChange={setShiftStartTime}
          />
          <Field label="Shift end" type="time" value={shiftEndTime} onChange={setShiftEndTime} />
        </div>
        <ShiftPreview
          shiftStartTime={shiftStartTime}
          shiftEndTime={shiftEndTime}
          shiftTimezone={shiftTimezone}
        />
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
  onClose,
}: {
  departments: Department[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [deptId, setDeptId] = useState(departments[0]?.id ?? "");
  const [country, setCountry] = useState<CountryCode>("PH");
  const [state, setState] = useState(
    normalizeState(departments.find((department) => department.id === departments[0]?.id)?.state),
  );
  const [shiftTimezone, setShiftTimezone] = useState(DEFAULT_SHIFT_TIMEZONE);
  const [shiftStartTime, setShiftStartTime] = useState("09:00");
  const [shiftEndTime, setShiftEndTime] = useState("17:00");
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
      await Promise.all([
        setDoc(empRef, {
          companyId: COMPANY_ID,
          deptId,
          name: cleanName,
          email: cleanEmail,
          jobTitle: jobTitle.trim(),
          shiftStartTime,
          shiftEndTime,
          shiftTimezone,
          country,
          state,
          timezone: COUNTRY_TIMEZONES[country].timezone,
          status: "active",
          inviteStatus: "pending",
          reportingRequirement: "sod_eod",
          createdAt: new Date().toISOString(),
        }),
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
              companyName: company?.name || "SavyTime",
              departmentName:
                departments.find((department) => department.id === deptId)?.name || "",
              jobTitle: jobTitle.trim(),
              country,
              state,
              shiftStartTime,
              shiftEndTime,
              shiftTimezone,
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
        <h3 className="text-lg font-semibold text-primary">New Employee</h3>
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
              className="mt-1 w-full rounded-md border px-3 py-2 bg-background"
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
          <div>
            <label className="text-sm font-medium">Shift reference timezone</label>
            <select
              value={shiftTimezone}
              onChange={(e) => setShiftTimezone(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
            >
              {ATTENDANCE_TIMEZONES.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Shift start"
              type="time"
              value={shiftStartTime}
              onChange={setShiftStartTime}
            />
            <Field label="Shift end" type="time" value={shiftEndTime} onChange={setShiftEndTime} />
          </div>
          <ShiftPreview
            shiftStartTime={shiftStartTime}
            shiftEndTime={shiftEndTime}
            shiftTimezone={shiftTimezone}
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {busy ? "Creating…" : "Create & Invite"}
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
