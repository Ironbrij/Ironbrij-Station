import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, updateDoc, writeBatch } from "firebase/firestore";
import {
  Building2,
  CheckCircle2,
  Clock,
  Clock3,
  Filter,
  Layers,
  RefreshCw,
  Sparkles,
  UserCheck,
  UserX,
  XCircle,
} from "lucide-react";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type Department,
  type Employee,
  type OvertimeRequest,
  type OvertimeStatus,
  type Punch,
} from "@/lib/types";
import { calculateAttendanceSession, formatWorkMinutes } from "@/lib/attendance-calculation";
import { getEmployeeShiftWindow, getShiftTimezone, zonedDateKey } from "@/lib/attendance";
import { getRequiredWorkMinutes } from "@/lib/company-context";
import { toDate, toMillis } from "@/lib/time";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin/overtime")({
  head: () => ({ meta: [{ title: "Overtime Approvals — SavyTimes Admin" }] }),
  component: AdminOvertimePage,
});

function AdminOvertimePage() {
  const [requests, setRequests] = useState<OvertimeRequest[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [statusFilter, setStatusFilter] = useState<OvertimeStatus | "all">("pending");
  const [filterCompany, setFilterCompany] = useState("all");
  const [filterDept, setFilterDept] = useState("");
  const [filterPeriod, setFilterPeriod] = useState<"today" | "week" | "month" | "all">("all");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    const unsubscribers = [
      onSnapshot(collection(db(), "overtimeRequests"), (snapshot) => {
        const list = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<OvertimeRequest, "id">),
        }));
        list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        setRequests(list);
      }),
      onSnapshot(collection(db(), "employees"), (snapshot) =>
        setEmployees(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Employee, "id">) })),
        ),
      ),
      onSnapshot(collection(db(), "departments"), (snapshot) =>
        setDepartments(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Department, "id">),
          })),
        ),
      ),
      onSnapshot(collection(db(), "companies"), (snapshot) =>
        setCompanies(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
        ),
      ),
      onSnapshot(collection(db(), "punches"), (snapshot) =>
        setAllPunches(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) })),
        ),
      ),
    ];
    return () => unsubscribers.forEach((u) => u());
  }, []);

  const empMap = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const e of employees) {
      map.set(e.id, e);
      if (e.authUid) map.set(e.authUid, e);
      if (e.email) map.set(e.email.toLowerCase().trim(), e);
    }
    return map;
  }, [employees]);

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const compMap = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);

  // Counts
  const counts = useMemo(() => {
    return {
      pending: requests.filter((r) => r.status === "pending").length,
      approved: requests.filter((r) => r.status === "approved").length,
      rejected: requests.filter((r) => r.status === "rejected").length,
      all: requests.length,
    };
  }, [requests]);

  // Filtered requests
  const filteredRequests = useMemo(() => {
    const now = new Date();
    const todayStr = format(now, "yyyy-MM-dd");

    return requests.filter((req) => {
      if (statusFilter !== "all" && req.status !== statusFilter) return false;

      const emp =
        empMap.get(req.employeeId) ||
        (req.employeeName ? employees.find((e) => e.name === req.employeeName) : undefined);

      if (filterCompany !== "all") {
        const matchesComp =
          req.companyId === filterCompany ||
          emp?.companyId === filterCompany ||
          emp?.companyIds?.includes(filterCompany);
        if (!matchesComp) return false;
      }

      if (filterDept && emp?.deptId !== filterDept) return false;

      if (filterPeriod === "today" && req.date !== todayStr) return false;
      if (filterPeriod === "week") {
        const reqDate = new Date(req.date);
        const diffDays = Math.floor((now.getTime() - reqDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 7 || diffDays < 0) return false;
      }
      if (filterPeriod === "month") {
        const reqDate = new Date(req.date);
        const diffDays = Math.floor((now.getTime() - reqDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 31 || diffDays < 0) return false;
      }

      return true;
    });
  }, [requests, statusFilter, filterCompany, filterDept, filterPeriod, empMap, employees]);

  async function handleDecision(requestId: string, status: "approved" | "rejected") {
    setProcessingId(requestId);
    try {
      await updateDoc(doc(db(), "overtimeRequests", requestId), {
        status,
        decidedBy: user?.email || "Admin",
        decidedAt: new Date().toISOString(),
      });
      toast.success(status === "approved" ? "Overtime approved!" : "Overtime rejected.");
    } catch (err) {
      toast.error("Failed to update decision: " + (err as Error).message);
    } finally {
      setProcessingId(null);
    }
  }

  async function handleApproveAllPending() {
    const pendingItems = filteredRequests.filter((r) => r.status === "pending");
    if (pendingItems.length === 0) {
      toast.info("No pending overtime requests to approve.");
      return;
    }

    setBulkProcessing(true);
    try {
      const batch = writeBatch(db());
      pendingItems.forEach((item) => {
        batch.update(doc(db(), "overtimeRequests", item.id), {
          status: "approved",
          decidedBy: user?.email || "Admin",
          decidedAt: new Date().toISOString(),
        });
      });
      await batch.commit();
      toast.success(`Approved ${pendingItems.length} overtime requests!`);
    } catch (err) {
      toast.error("Bulk approval failed: " + (err as Error).message);
    } finally {
      setBulkProcessing(false);
    }
  }

  async function handleSyncPastOvertime() {
    setSyncing(true);
    try {
      let createdCount = 0;
      const existingOutIds = new Set(requests.map((r) => r.punchOutId).filter(Boolean));
      const existingInIds = new Set(requests.map((r) => r.punchInId).filter(Boolean));

      // Group punches by employee
      const empPunchesMap = new Map<string, Punch[]>();
      for (const p of allPunches) {
        if (!p.employeeId) continue;
        if (!empPunchesMap.has(p.employeeId)) empPunchesMap.set(p.employeeId, []);
        empPunchesMap.get(p.employeeId)!.push(p);
      }

      for (const [empId, empPunchesList] of empPunchesMap) {
        const emp = empMap.get(empId);
        const sorted = [...empPunchesList].sort(
          (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
        );

        let lastIn: Punch | null = null;
        for (const p of sorted) {
          if (p.type === "in" || p.type === "extra_in") {
            lastIn = p;
            // Also check for early punch-in
            if (emp && p.timestamp && !existingInIds.has(p.id)) {
              const inTime = toDate(p.timestamp);
              if (inTime) {
                const shiftTimezone = getShiftTimezone(emp);
                const shift = getEmployeeShiftWindow(emp, inTime);
                if (inTime.getTime() < shift.start.getTime()) {
                  const earlyMins = Math.floor((shift.start.getTime() - inTime.getTime()) / 60_000);
                  if (earlyMins >= 5) {
                    const punchDate = p.attendanceDate || p.date || zonedDateKey(inTime, shiftTimezone);
                    await addDoc(collection(db(), "overtimeRequests"), {
                      employeeId: empId,
                      employeeName: p.employeeName || emp?.name || "Employee",
                      companyId: p.companyId || emp?.companyId || COMPANY_ID,
                      date: punchDate,
                      requestType: "early_clock_in",
                      punchInId: p.id,
                      overtimeMinutes: earlyMins,
                      normalWorkMinutes: 0,
                      isOffShiftDay: false,
                      reason: `Early clock-in: started work ${formatWorkMinutes(earlyMins)} before shift (synced)`,
                      status: "pending",
                      createdAt: new Date().toISOString(),
                    });
                    existingInIds.add(p.id);
                    createdCount++;
                  }
                }
              }
            }
          } else if ((p.type === "out" || p.type === "extra_out") && lastIn) {
            const punchDate = p.attendanceDate || p.date || lastIn.attendanceDate || lastIn.date;
            if (existingOutIds.has(p.id)) {
              lastIn = null;
              continue;
            }

            const inTime = toDate(lastIn.timestamp);
            const outTime = toDate(p.timestamp);
            if (!inTime || !outTime) {
              lastIn = null;
              continue;
            }

            const isExtra = p.type === "extra_out";
            const reqMinutes = emp
              ? getRequiredWorkMinutes(
                  emp,
                  companies.find((c) => c.id === p.companyId),
                )
              : 480;
            const isOff = Boolean(p.isOffShiftDay || lastIn.isOffShiftDay);

            let otMinutes = 0;
            if (typeof p.overtimeMinutes === "number" && p.overtimeMinutes > 0) {
              otMinutes = p.overtimeMinutes;
            } else if (isExtra) {
              otMinutes = Math.max(0, Math.floor((outTime.getTime() - inTime.getTime()) / 60_000));
            } else if (emp) {
              const calc = calculateAttendanceSession({
                employee: emp,
                company: companies.find((c) => c.id === p.companyId),
                punchIn: inTime,
                punchOut: outTime,
                requiredWorkMinutes: reqMinutes,
                isOffShiftDay: isOff,
              });
              otMinutes = calc.overtimeMinutes;
            } else {
              const elapsed = Math.max(
                0,
                Math.floor((outTime.getTime() - inTime.getTime()) / 60_000),
              );
              otMinutes = Math.max(0, elapsed - reqMinutes);
            }

            if (otMinutes > 0) {
              const isPostShiftWork = emp && inTime.getTime() >= getEmployeeShiftWindow(emp, inTime).end.getTime();
              const reason = isOff
                ? `Worked ${formatWorkMinutes(otMinutes)} on off-shift day (synced)`
                : isPostShiftWork
                  ? `Worked ${formatWorkMinutes(otMinutes)} post-shift overtime (synced)`
                  : `Worked ${formatWorkMinutes(otMinutes)} past shift hours (synced)`;

              await addDoc(collection(db(), "overtimeRequests"), {
                employeeId: empId,
                employeeName: p.employeeName || emp?.name || "Employee",
                companyId: p.companyId || emp?.companyId || COMPANY_ID,
                date:
                  punchDate ||
                  zonedDateKey(inTime, emp ? getShiftTimezone(emp) : "Asia/Kathmandu"),
                requestType: isOff ? "off_shift_work" : isExtra ? "extra_hours" : "overtime",
                punchOutId: p.id,
                punchInId: lastIn.id,
                overtimeMinutes: otMinutes,
                normalWorkMinutes: Math.max(
                  0,
                  Math.floor((outTime.getTime() - inTime.getTime()) / 60_000) - otMinutes,
                ),
                isOffShiftDay: isOff,
                reason,
                status: "pending",
                createdAt: new Date().toISOString(),
              });

              existingOutIds.add(p.id);
              createdCount++;
            }
            lastIn = null;
          }
        }
      }

      if (createdCount > 0) {
        toast.success(`Synced and recovered ${createdCount} past overtime requests!`);
      } else {
        toast.info("All past overtime records are already synced.");
      }
    } catch (err) {
      toast.error("Failed to sync past overtime: " + (err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Clock className="h-6 w-6 text-primary" /> Overtime Approvals
          </h1>
          <p className="text-sm font-medium text-muted-foreground mt-0.5">
            Review and approve overtime hours worked after shifts and on company off-days.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleSyncPastOvertime}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-xl border bg-background px-3 py-2 text-xs font-semibold text-foreground shadow-xs hover:bg-muted transition-all disabled:opacity-50"
            title="Scan and recover all past shift punches with overtime"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync Past Overtime"}
          </button>

          {counts.pending > 0 && (
            <button
              onClick={handleApproveAllPending}
              disabled={bulkProcessing}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {bulkProcessing ? "Approving..." : `Approve All Pending (${counts.pending})`}
            </button>
          )}
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-card p-3 rounded-xl border">
        {/* Status Tabs */}
        <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-lg text-xs font-semibold">
          <button
            onClick={() => setStatusFilter("pending")}
            className={`px-3 py-1.5 rounded-md transition-all ${
              statusFilter === "pending"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Pending ({counts.pending})
          </button>
          <button
            onClick={() => setStatusFilter("approved")}
            className={`px-3 py-1.5 rounded-md transition-all ${
              statusFilter === "approved"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Approved ({counts.approved})
          </button>
          <button
            onClick={() => setStatusFilter("rejected")}
            className={`px-3 py-1.5 rounded-md transition-all ${
              statusFilter === "rejected"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Rejected ({counts.rejected})
          </button>
          <button
            onClick={() => setStatusFilter("all")}
            className={`px-3 py-1.5 rounded-md transition-all ${
              statusFilter === "all"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            All ({counts.all})
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <select
            value={filterCompany}
            onChange={(e) => setFilterCompany(e.target.value)}
            className="rounded-lg border bg-background px-2.5 py-1.5 font-medium text-foreground outline-none"
          >
            <option value="all">All Companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <select
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
            className="rounded-lg border bg-background px-2.5 py-1.5 font-medium text-foreground outline-none"
          >
            <option value="">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>

          <select
            value={filterPeriod}
            onChange={(e) => setFilterPeriod(e.target.value as any)}
            className="rounded-lg border bg-background px-2.5 py-1.5 font-medium text-foreground outline-none"
          >
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="week">Past 7 Days</option>
            <option value="month">Past 30 Days</option>
          </select>
        </div>
      </div>

      {/* Requests Table */}
      <div className="rounded-2xl border bg-card overflow-hidden shadow-xs">
        {filteredRequests.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            <Clock3 className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-semibold text-sm">No overtime requests found.</p>
            <p className="text-xs text-muted-foreground mt-1">
              {statusFilter === "pending"
                ? "All overtime records have been reviewed."
                : "Try adjusting your filters above."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40 border-b text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Shift Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Normal (Auto)</th>
                  <th className="px-4 py-3 text-primary font-black">Overtime to Approve</th>
                  <th className="px-4 py-3">Reason / Shift Note</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredRequests.map((req) => {
                  const emp = empMap.get(req.employeeId);
                  const deptName = emp?.deptId ? deptMap.get(emp.deptId) : "General";
                  const compName = compMap.get(req.companyId) || "Company";

                  return (
                    <tr key={req.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3.5">
                        <Link
                          to="/admin/employees/$id"
                          params={{ id: emp?.id || req.employeeId }}
                          className="font-bold text-foreground hover:underline"
                        >
                          {req.employeeName || emp?.name || "Employee"}
                        </Link>
                        <div className="text-[11px] text-muted-foreground font-medium mt-0.5">
                          {deptName} · {compName}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 font-medium whitespace-nowrap">
                        {req.date}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        {req.requestType === "early_clock_in" ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            Early Clock-In
                          </span>
                        ) : req.isOffShiftDay || req.requestType === "off_shift_work" ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                            Off-Day / Holiday
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                            Post-Shift
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-muted-foreground font-semibold">
                        {formatWorkMinutes(req.normalWorkMinutes || 0)}
                        <span className="text-[10px] text-muted-foreground/80 block font-normal">
                          (auto-counted)
                        </span>
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span className="inline-flex items-center font-bold text-sm bg-primary/10 text-primary px-2.5 py-1 rounded-md border border-primary/20">
                          +{formatWorkMinutes(req.overtimeMinutes)}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 max-w-xs text-muted-foreground font-medium truncate">
                        {req.reason}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        {req.status === "approved" ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                            <CheckCircle2 className="h-3 w-3" /> Approved
                          </span>
                        ) : req.status === "rejected" ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                            <XCircle className="h-3 w-3" /> Rejected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            <Clock3 className="h-3 w-3" /> Pending Review
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {req.status === "pending" ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => handleDecision(req.id, "approved")}
                              disabled={processingId === req.id}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700 transition-all disabled:opacity-50"
                            >
                              <UserCheck className="h-3.5 w-3.5" /> Approve
                            </button>
                            <button
                              onClick={() => handleDecision(req.id, "rejected")}
                              disabled={processingId === req.id}
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-rose-700 transition-all disabled:opacity-50"
                            >
                              <UserX className="h-3.5 w-3.5" /> Reject
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() =>
                                handleDecision(
                                  req.id,
                                  req.status === "approved" ? "rejected" : "approved",
                                )
                              }
                              disabled={processingId === req.id}
                              className="text-xs text-muted-foreground hover:text-foreground font-semibold px-2 py-1 rounded-md border hover:bg-muted transition-colors"
                            >
                              {req.status === "approved" ? "Change to Reject" : "Change to Approve"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
