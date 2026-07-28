import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { CompanyNotice, Employee, LeaveRequest } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { getLeaveLabel } from "@/lib/attendance";

export const Route = createFileRoute("/_authenticated/admin/leaves")({
  head: () => ({
    meta: [
      { title: "Leaves — Time Station Admin" },
      { name: "description", content: "Approve or reject leave requests." },
      { property: "og:title", content: "Leaves — Time Station Admin" },
      { property: "og:description", content: "Approve or reject leave requests." },
    ],
  }),
  component: LeavesPage,
});

function LeavesPage() {
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const { user } = useAuth();

  useEffect(() => {
    const unsubscribeLeaves = onSnapshot(collection(db(), "leaveRequests"), (snapshot) =>
      setLeaves(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<LeaveRequest, "id">),
        })),
      ),
    );
    const unsubscribeEmployees = onSnapshot(collection(db(), "employees"), (snapshot) =>
      setEmployees(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Employee, "id">),
        })),
      ),
    );
    return () => {
      unsubscribeLeaves();
      unsubscribeEmployees();
    };
  }, []);

  async function setStatus(id: string, status: "approved" | "rejected") {
    try {
      const leave = leaves.find((item) => item.id === id);
      if (!leave || leave.status !== "pending") return;
      const employee = employees.find(
        (item) => item.id === leave.employeeId || item.authUid === leave.employeeId,
      );
      const batch = writeBatch(db());
      batch.update(doc(db(), "leaveRequests", id), {
        status,
        decidedAt: new Date().toISOString(),
        decidedBy: user?.email || "Admin",
      });

      if (employee) {
        const noticeRef = doc(collection(db(), "notices"));
        const approved = status === "approved";
        const dateRange =
          leave.dateFrom === leave.dateTo ? leave.dateFrom : `${leave.dateFrom} to ${leave.dateTo}`;
        const leaveLabel = getLeaveLabel(leave);
        const notice: Omit<CompanyNotice, "id"> = {
          title: approved ? "Leave request approved" : "Leave request rejected",
          message: approved
            ? `Your ${leaveLabel.toLowerCase()} request for ${dateRange} has been approved.`
            : `Your ${leaveLabel.toLowerCase()} request for ${dateRange} has been rejected. Your submitted reason was: ${leave.reason}`,
          priority: approved ? "info" : "warning",
          targetType: "employee",
          targetEmployeeId: employee.id,
          targetEmployeeIds: [employee.id],
          createdAt: new Date().toISOString(),
          authorName: user?.displayName || user?.email || "Leave administration",
        };
        batch.set(noticeRef, notice);
      }

      await batch.commit();
      toast.success(
        status === "approved"
          ? "Leave approved and in-app notification sent"
          : "Leave rejected and in-app notification sent",
      );

      if (!employee || !user) {
        toast.warning("Decision saved, but the employee email could not be prepared.");
        return;
      }
      try {
        const idToken = await user.getIdToken();
        const emailResponse = await fetch("/api/leave-decision-notification", {
          method: "POST",
          headers: {
            authorization: `Bearer ${idToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            leaveRequestId: leave.id,
            employeeId: employee.id,
            employeeName: employee.name,
            employeeEmail: employee.email,
            dateFrom: leave.dateFrom,
            dateTo: leave.dateTo,
            leaveType: leave.leaveType || "full_day",
            halfDayPeriod: leave.halfDayPeriod,
            startTime: leave.startTime,
            endTime: leave.endTime,
            reason: leave.reason,
            status,
          }),
        });
        if (emailResponse.ok) {
          toast.success("Decision email sent to the employee");
        } else {
          toast.warning("Decision saved, but the employee email automation is not configured.");
        }
      } catch {
        toast.warning("Decision saved, but the employee email could not be sent.");
      }
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  const employeeName = (id: string) =>
    employees.find((employee) => employee.id === id || employee.authUid === id)?.name ?? id;
  const statusOrder: Record<LeaveRequest["status"], number> = {
    pending: 0,
    approved: 1,
    rejected: 2,
  };
  const sorted = [...leaves].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-primary">Leave Requests</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        New requests email the manager through n8n. Decisions notify the employee inside Time
        Station.
      </p>
      <ul className="mt-6 divide-y rounded-xl border bg-card">
        {sorted.length === 0 && (
          <li className="p-4 text-sm text-muted-foreground">No leave requests.</li>
        )}
        {sorted.map((leave) => (
          <li key={leave.id} className="flex items-start justify-between gap-4 p-4">
            <div>
              <div className="font-medium">{employeeName(leave.employeeId)}</div>
              <div className="text-sm text-muted-foreground">
                {leave.dateFrom}
                {leave.dateFrom !== leave.dateTo ? ` → ${leave.dateTo}` : ""} · {leave.reason}
              </div>
              <div className="mt-1 text-xs font-semibold text-primary">{getLeaveLabel(leave)}</div>
              <div className="mt-1 text-xs capitalize text-muted-foreground">
                Status: {leave.status}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              {leave.status === "pending" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setStatus(leave.id, "approved")}
                    className="btn-lift rounded-md px-3 py-1.5 text-sm text-primary-foreground"
                    style={{ background: "var(--status-in)" }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatus(leave.id, "rejected")}
                    className="btn-lift rounded-md border px-3 py-1.5 text-sm"
                  >
                    Reject
                  </button>
                </>
              ) : (
                <span
                  className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                    leave.status === "approved"
                      ? "bg-emerald-500/10 text-emerald-700"
                      : "bg-rose-500/10 text-rose-700"
                  }`}
                >
                  {leave.status === "approved" ? "Approved" : "Rejected"}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
