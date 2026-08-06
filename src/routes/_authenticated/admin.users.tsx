import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COMPANY_ID, type CountryCode, type Department, type Employee } from "@/lib/types";
import { COUNTRY_TIMEZONES } from "@/lib/time";
import { ATTENDANCE_TIMEZONES, DEFAULT_SHIFT_TIMEZONE } from "@/lib/attendance";
import { toast } from "sonner";
import { format } from "date-fns";
import { useAuth } from "@/lib/auth-context";
import { ShieldCheck, UserCheck } from "lucide-react";
import { getStateOptions, normalizeState } from "@/lib/states";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { resolveProfilePhoto } from "@/lib/profile-photo";

export const Route = createFileRoute("/_authenticated/admin/users")({
  head: () => ({
    meta: [
      { title: "Registered Users — Time Station Admin" },
      {
        name: "description",
        content: "View all registered users, grant owner status, and assign employee roles.",
      },
      { property: "og:title", content: "Registered Users — Time Station Admin" },
      {
        property: "og:description",
        content: "View all registered users, grant owner status, and assign employee roles.",
      },
    ],
  }),
  component: UsersPage,
});

interface RegisteredUser {
  uid: string;
  name?: string;
  email: string;
  photoUrl?: string;
  photoURL?: string;
  picture?: string;
  lastLogin?: string;
}

function UsersPage() {
  const [users, setUsers] = useState<RegisteredUser[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [adminUids, setAdminUids] = useState<Set<string>>(new Set());
  const [selectedUser, setSelectedUser] = useState<RegisteredUser | null>(null);
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading || !user) return;

    const un0 = onSnapshot(collection(db(), "companies"), (s) =>
      setCompanies(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Company, "id">) }))),
    );

    const un1 = onSnapshot(
      collection(db(), "users"),
      (s) => {
        setUsers(s.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<RegisteredUser, "uid">) })));
      },
      (err) => console.error("Failed to load users:", err),
    );

    const un2 = onSnapshot(
      collection(db(), "employees"),
      (s) => {
        setEmployees(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) })));
      },
      (err) => console.error("Failed to load employees:", err),
    );

    const un3 = onSnapshot(
      collection(db(), "departments"),
      (s) => {
        setDepartments(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) })));
      },
      (err) => console.error("Failed to load departments:", err),
    );

    const un4 = onSnapshot(
      collection(db(), "admins"),
      (s) => {
        setAdminUids(new Set(s.docs.map((d) => d.id)));
      },
      (err) => console.error("Failed to load admins:", err),
    );

    return () => {
      un0();
      un1();
      un2();
      un3();
      un4();
    };
  }, [user, authLoading]);

  const empByEmail = new Map(employees.map((e) => [(e.email || "").toLowerCase(), e]));

  const filteredUsers = (users ?? []).filter((u) => {
    if (companyFilter === "all") return true;
    const emp = empByEmail.get((u.email || "").toLowerCase());
    if (!emp) return companyFilter === COMPANY_ID;
    return (
      emp.companyId === companyFilter ||
      emp.companyIds?.includes(companyFilter) ||
      (!emp.companyId && companyFilter === COMPANY_ID)
    );
  });

  async function toggleAdmin(u: RegisteredUser) {
    const isAlreadyAdmin = adminUids.has(u.uid);
    try {
      if (isAlreadyAdmin) {
        await deleteDoc(doc(db(), "admins", u.uid));
        toast.success(`Removed admin privileges for ${u.name || u.email}`);
      } else {
        await setDoc(doc(db(), "admins", u.uid), {
          role: "owner",
          email: u.email,
          addedAt: new Date().toISOString(),
        });
        toast.success(`Granted Owner/Admin status to ${u.name || u.email}!`);
      }
    } catch (e) {
      toast.error("Failed to update admin role: " + (e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            👥 Registered Users & Owners
          </h1>
          <p className="text-sm text-muted-foreground">
            View signed-in users, manage Owner/Admin permissions, and assign employee profiles.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="rounded-lg border px-3 py-2 text-xs font-semibold bg-background text-foreground"
          >
            <option value="all">All Companies ({companies.length})</option>
            {companies.map((c) => (
              <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                {c.name} {c.isMain ? "(Main)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Registered Users Table */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-lift">
        {users === null ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 skeleton-shimmer" />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-secondary text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3.5">User</th>
                <th className="p-3.5">Email</th>
                <th className="p-3.5">Role / Owner Status</th>
                <th className="p-3.5">Employee Link</th>
                <th className="p-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-muted-foreground font-medium">
                    No registered users found for this filter.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const existingEmp = empByEmail.get((u.email || "").toLowerCase());
                  const isOwner =
                    adminUids.has(u.uid) ||
                    [
                      "pabibek9@gmail.com",
                      "bibekparajuli05@gmail.com",
                      "louis@ironbrij.com.au",
                    ].includes((u.email || "").toLowerCase());

                  return (
                    <tr key={u.uid} className="hover:bg-accent/40 transition-colors">
                      <td className="p-3.5 font-medium flex items-center gap-3">
                        <ProfileAvatar
                          name={u.name || u.email || "User"}
                          photoUrl={resolveProfilePhoto(u.uid === user?.uid ? user : undefined, u)}
                          className="h-8 w-8 text-xs"
                        />
                        <div>
                          {existingEmp ? (
                            <Link
                              to="/admin/employees/$id"
                              params={{ id: existingEmp.id }}
                              className="font-semibold text-primary hover:underline flex items-center gap-1"
                            >
                              {u.name || "User"} ↗
                            </Link>
                          ) : (
                            <div className="font-semibold text-primary">{u.name || "User"}</div>
                          )}
                          <div className="text-xs text-muted-foreground font-mono">
                            UID: {u.uid.slice(0, 10)}...
                          </div>
                        </div>
                      </td>
                      <td className="p-3.5 font-mono text-xs">{u.email}</td>
                      <td className="p-3.5">
                        {isOwner ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                            Owner / Admin
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-500/10 text-slate-500 border border-slate-500/20">
                            Member User
                          </span>
                        )}
                      </td>
                      <td className="p-3.5">
                        {existingEmp ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                            <UserCheck className="h-3 w-3" /> Official Employee
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/10 text-slate-500 border border-slate-500/20">
                            Registered User Only
                          </span>
                        )}
                      </td>
                      <td className="p-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => toggleAdmin(u)}
                            className={`btn-lift text-xs px-2.5 py-1.5 rounded-md font-bold transition-colors ${
                              isOwner
                                ? "border border-slate-300 text-slate-600 hover:bg-slate-100"
                                : "bg-amber-500 text-white hover:bg-amber-600"
                            }`}
                          >
                            {isOwner ? "Revoke Admin" : "Make Owner"}
                          </button>

                          {existingEmp ? (
                            <Link
                              to="/admin/employees/$id"
                              params={{ id: existingEmp.id }}
                              className="btn-lift text-xs px-2.5 py-1.5 rounded-md border border-primary text-primary hover:bg-primary/10 font-bold inline-block"
                            >
                              View Profile ↗
                            </Link>
                          ) : (
                            <button
                              onClick={() => setSelectedUser(u)}
                              className="btn-lift text-xs px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground font-bold"
                            >
                              + Make Employee
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      {selectedUser && (
        <MakeEmployeeModal
          user={selectedUser}
          departments={departments}
          onClose={() => setSelectedUser(null)}
        />
      )}
    </div>
  );
}

function MakeEmployeeModal({
  user,
  departments,
  onClose,
}: {
  user: RegisteredUser;
  departments: Department[];
  onClose: () => void;
}) {
  const [jobTitle, setJobTitle] = useState("Team Member");
  const [deptId, setDeptId] = useState(departments[0]?.id ?? "");
  const [country, setCountry] = useState<CountryCode>("NP");
  const [state, setState] = useState(
    normalizeState(departments.find((department) => department.id === departments[0]?.id)?.state),
  );
  const [shiftTimezone, setShiftTimezone] = useState(DEFAULT_SHIFT_TIMEZONE);
  const [shiftStartTime, setShiftStartTime] = useState("09:00");
  const [shiftEndTime, setShiftEndTime] = useState("17:00");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!deptId) {
      toast.error("Please select a department first!");
      return;
    }
    setSaving(true);

    try {
      const cleanEmail = (user.email || "").toLowerCase().trim();
      const empRef = doc(db(), "employees", user.uid);
      await setDoc(empRef, {
        companyId: COMPANY_ID,
        deptId,
        name: user.name || cleanEmail.split("@")[0] || "Employee",
        email: cleanEmail,
        jobTitle: jobTitle.trim(),
        shiftStartTime: shiftStartTime || "09:00",
        shiftEndTime: shiftEndTime || "17:00",
        country,
        state,
        timezone: COUNTRY_TIMEZONES[country].timezone,
        shiftTimezone,
        status: "active",
        inviteStatus: "accepted",
        reportingRequirement: "sod_eod",
        authUid: user.uid,
        photoUrl: user.photoUrl || user.photoURL || user.picture || "",
        createdAt: new Date().toISOString(),
      });

      toast.success(`Created employee profile for ${user.name || cleanEmail}!`);
      onClose();
    } catch (err) {
      toast.error("Failed to create profile: " + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-card p-6 shadow-lift space-y-4 text-left"
      >
        <h3 className="text-lg font-bold text-primary">
          Make {user.name || user.email} an Employee
        </h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              Job Title
            </label>
            <input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background font-medium outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              Department
            </label>
            <select
              value={deptId}
              onChange={(e) => {
                setDeptId(e.target.value);
                setState(
                  normalizeState(
                    departments.find((department) => department.id === e.target.value)?.state,
                  ),
                );
              }}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">Select Department...</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              Country & Timezone
            </label>
            <select
              value={country}
              onChange={(e) => {
                setCountry(e.target.value as CountryCode);
                setState("N/A");
              }}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="NP">🇳🇵 Nepal (NPT, UTC+5:45)</option>
              <option value="AU">🇦🇺 Australia (AEST, UTC+10:00)</option>
              <option value="PH">🇵🇭 Philippines (PST, UTC+8:00)</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              State / Province / Region
            </label>
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
            >
              {getStateOptions(country).map((option) => (
                <option key={option} value={option}>
                  {option === "N/A" ? "N/A — no state" : option}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">
                Shift Start
              </label>
              <input
                type="time"
                value={shiftStartTime}
                onChange={(e) => setShiftStartTime(e.target.value)}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">
                Shift End
              </label>
              <input
                type="time"
                value={shiftEndTime}
                onChange={(e) => setShiftEndTime(e.target.value)}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-lift rounded-md border px-4 py-2 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            className="btn-lift rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-bold"
          >
            {saving ? "Creating..." : "Save Employee"}
          </button>
        </div>
      </form>
    </div>
  );
}
