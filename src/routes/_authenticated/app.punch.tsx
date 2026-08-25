import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import {
  type CompanyNotice,
  type Department,
  type Employee,
  type LeaveRequest,
  type MentionItem,
  type Punch,
} from "@/lib/types";
import { MentionTextarea } from "@/components/MentionTextarea";
import { sendMentionNotification } from "@/lib/mention-notifications";
import { companyEmailBranding } from "@/lib/email-branding";
import { resolveMentionRecipients, sanitizeFirestoreObject } from "@/lib/mentions";
import { formatDurationHMS, toDate, toMillis } from "@/lib/time";
import {
  computeEmployeeLateness,
  computeRegularWorkedMsForDay,
  formatInTimezone,
  getActiveEmployeeLeave,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getLeaveLabel,
  getShiftConversions,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import {
  DEFAULT_REPORT_QUESTIONS,
  DEFAULT_REPORTING_SETTINGS,
  isReportDeadlinePassed,
  reportDateForEmployee,
  reportDocumentId,
} from "@/lib/daily-reports";
import { randomQuote } from "@/lib/quotes-seed";
import { toast } from "sonner";
import {
  Lock,
  Megaphone,
  X,
  Sun,
  Moon,
  FileText,
  Send,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { getNoticeDeliveryTime, isNoticePublished, noticeMatchesEmployee } from "@/lib/notices";
import { publishPersonalAttendanceEvent } from "@/lib/personal-automation";
import {
  getEmployeeCompanyIds,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "@/lib/company-context";
import { calculateAttendanceSession, formatWorkMinutes } from "@/lib/attendance-calculation";

export const Route = createFileRoute("/_authenticated/app/punch")({
  head: () => ({
    meta: [
      { title: "Web Punch — SavyTimes" },
      { name: "description", content: "Punch in and out for your shift." },
      { property: "og:title", content: "Web Punch — SavyTimes" },
      { property: "og:description", content: "Punch in and out for your shift." },
    ],
  }),
  component: PunchPage,
});

function PunchPage() {
  const { user, employee, company, activeCompanyId, isAdmin } = useAuth();
  const [depts, setDepts] = useState<Department[]>([]);
  const [notices, setNotices] = useState<CompanyNotice[]>([]);
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState(randomQuote());
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [confirmEarly, setConfirmEarly] = useState(false);
  const [showPunchOutModal, setShowPunchOutModal] = useState(false);
  const [dismissedNoticeIds, setDismissedNoticeIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("dismissed_notice_ids");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  function dismissNotice(id: string) {
    const next = [...dismissedNoticeIds, id];
    setDismissedNoticeIds(next);
    localStorage.setItem("dismissed_notice_ids", JSON.stringify(next));

    // Also mark as read for header bell sync
    try {
      const storedRead = localStorage.getItem("read_notice_ids");
      const readArr: string[] = storedRead ? JSON.parse(storedRead) : [];
      if (!readArr.includes(id)) {
        readArr.push(id);
        localStorage.setItem("read_notice_ids", JSON.stringify(readArr));
        window.dispatchEvent(new Event("notice_read_change"));
      }
    } catch {
      // Ignore malformed local notification state.
    }
    toast.success("Announcement dismissed from main screen.");
  }

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [allEmployees, setAllEmployees] = useState<Employee[]>([]);

  const companyPunches = useMemo(
    () => allPunches.filter((punch) => getPunchCompanyId(punch, employee) === activeCompanyId),
    [activeCompanyId, allPunches, employee],
  );

  const companyLeaves = useMemo(
    () =>
      leaves.filter(
        (leave) =>
          (leave.companyId || employee?.companyIds?.[0] || employee?.companyId) === activeCompanyId,
      ),
    [activeCompanyId, employee, leaves],
  );

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db(), "departments"), where("companyId", "==", activeCompanyId)),
      (s) =>
        setDepts(
          s.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) }))
            .filter((department) => (department.companyId || "default") === activeCompanyId),
        ),
    );
    const u2 = onSnapshot(collection(db(), "notices"), (s) =>
      setNotices(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CompanyNotice, "id">) }))),
    );
    const u3 = onSnapshot(
      query(collection(db(), "employees"), where("companyIds", "array-contains", activeCompanyId)),
      (s) =>
        setAllEmployees(
          s.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) }))
            .filter((item) => getEmployeeCompanyIds(item).includes(activeCompanyId)),
        ),
    );
    return () => {
      u1();
      u2();
      u3();
    };
  }, [activeCompanyId]);

  // Fetch all punches for this employee (Index-free, real-time sync)
  useEffect(() => {
    if (!employee) return;
    const q = query(collection(db(), "punches"), where("employeeId", "==", employee.id));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }));
        const sorted = list.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
        setAllPunches(sorted);
      },
      (err) => {
        console.error("Punch snapshot error:", err);
      },
    );
  }, [employee]);

  // Keep leave and scheduled break requests in sync.
  useEffect(() => {
    if (!employee) return;
    const q = query(collection(db(), "leaveRequests"), where("employeeId", "==", employee.id));
    return onSnapshot(
      q,
      (snap) => {
        setLeaves(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LeaveRequest, "id">) })));
      },
      (err) => {
        console.error("Leave snapshot error:", err);
      },
    );
  }, [employee]);

  const activeLeave = useMemo(
    () => (employee ? getActiveEmployeeLeave(employee, companyLeaves, new Date(now)) : null),
    [employee, companyLeaves, now],
  );
  const onLeaveToday = Boolean(activeLeave);
  const approvedLeaveToday = useMemo(
    () =>
      employee
        ? getEmployeeApprovedLeaveForDate(
            employee,
            companyLeaves,
            zonedDateKey(new Date(now), getShiftTimezone(employee)),
          )
        : null,
    [employee, companyLeaves, now],
  );

  // Resolve department name
  const deptName = useMemo(() => {
    if (!employee?.deptId) return "General";
    return depts.find((d) => d.id === employee.deptId)?.name || "General";
  }, [depts, employee]);

  // Determine punch status strictly based on the latest punch
  const isPunchedIn = useMemo(() => {
    if (companyPunches.length === 0) return false;
    const latest = companyPunches[companyPunches.length - 1];
    return latest?.type === "in" || latest?.type === "extra_in";
  }, [companyPunches]);

  const lastIn = useMemo(() => {
    if (!isPunchedIn) return null;
    const latest = companyPunches[companyPunches.length - 1];
    return toDate(latest?.timestamp);
  }, [companyPunches, isPunchedIn]);

  const attendanceStatus = useMemo(
    () =>
      employee
        ? getLiveAttendanceStatus(
            employee,
            companyPunches,
            new Date(now),
            company?.lateGraceMinutes ?? 5,
            company?.workingDays,
            getEmployeeHolidayDates(company, employee),
          )
        : null,
    [employee, companyPunches, now, company],
  );

  const shiftConversions = useMemo(
    () => (employee ? getShiftConversions(employee, new Date(now)) : []),
    [employee, now],
  );

  // Recent 10 activity logs sorted descending
  const recentPunchesList = useMemo(() => {
    return [...companyPunches].reverse().slice(0, 10);
  }, [companyPunches]);

  // Active 24h Notices hook (placed BEFORE early returns for React Rules of Hooks)
  const active24hNotices = useMemo(() => {
    const nowMs = Date.now();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    return notices.filter((n) => {
      if (dismissedNoticeIds.includes(n.id)) return false;
      if (!n.createdAt) return false;
      if (!isNoticePublished(n, new Date(now))) return false;
      const deliveredMs = getNoticeDeliveryTime(n).getTime();
      if (nowMs - deliveredMs > twentyFourHoursMs) return false;

      return noticeMatchesEmployee(n, employee, activeCompanyId);
    });
  }, [notices, employee, dismissedNoticeIds, now, activeCompanyId]);

  const totalWorkedMs = useMemo(() => {
    if (!employee) return 0;
    return computeRegularWorkedMsForDay(employee, companyPunches, new Date(now), new Date(now));
  }, [employee, companyPunches, now]);

  const currentSessionCalculation = useMemo(() => {
    if (!employee) return null;
    const latestRegularIn = [...companyPunches].reverse().find((punch) => punch.type === "in");
    const latestRegularOut = [...companyPunches].reverse().find((punch) => punch.type === "out");
    if (
      !latestRegularIn?.timestamp ||
      (latestRegularOut?.timestamp &&
        toMillis(latestRegularOut.timestamp) > toMillis(latestRegularIn.timestamp))
    ) {
      return null;
    }
    return calculateAttendanceSession({
      employee,
      company,
      punchIn: toDate(latestRegularIn.timestamp) ?? new Date(now),
      now: new Date(now),
      requiredWorkMinutes: getRequiredWorkMinutes(employee, company),
    });
  }, [company, companyPunches, employee, now]);

  async function doPunch(targetType: "in" | "out") {
    if (!employee || !user) return;

    // Strict Double-Punch Validation
    const latestPunch = companyPunches[companyPunches.length - 1];
    const latestType = latestPunch?.type;

    if (targetType === "in" && (latestType === "in" || latestType === "extra_in")) {
      toast.error("Action Blocked: You are already punched in!");
      return;
    }

    if (
      targetType === "out" &&
      (!latestType || latestType === "out" || latestType === "extra_out")
    ) {
      toast.error("Action Blocked: You are already punched out!");
      return;
    }

    setBusy(true);
    try {
      const punchType =
        latestType === "extra_in" && targetType === "out" ? "extra_out" : targetType;
      const punchTime = new Date();
      const punchDate = zonedDateKey(punchTime, getShiftTimezone(employee));
      const inPunchDate = latestPunch?.attendanceDate || latestPunch?.date || zonedDateKey(toDate(latestPunch?.timestamp) ?? punchTime, getShiftTimezone(employee));
      const targetAttendanceDate = targetType === "out" && latestPunch ? inPunchDate : punchDate;
      const requiredWorkMinutes = getRequiredWorkMinutes(employee, company);
      const shiftScheduleTime = targetType === "out" && latestPunch?.timestamp
        ? toDate(latestPunch.timestamp) ?? punchTime
        : punchTime;
      const schedule = getLiveAttendanceStatus(
        employee,
        companyPunches,
        shiftScheduleTime,
        company?.lateGraceMinutes ?? 5,
        company?.workingDays,
        getEmployeeHolidayDates(company, employee),
      );
      const isOffShiftDayToday = !schedule.isScheduledDay || Boolean(holiday);
      const isOffShiftDay =
        targetType === "out"
          ? Boolean(latestPunch?.isOffShiftDay || isOffShiftDayToday)
          : isOffShiftDayToday;

      const shiftWindow = schedule.shift;
      const calculation =
        punchType === "out" && latestPunch?.type === "in" && latestPunch.timestamp
          ? calculateAttendanceSession({
              employee,
              company,
              punchIn: toDate(latestPunch.timestamp) ?? punchTime,
              punchOut: punchTime,
              requiredWorkMinutes,
              isOffShiftDay,
            })
          : null;

      const extraOvertimeMinutes =
        punchType === "extra_out" && latestPunch?.type === "extra_in" && latestPunch.timestamp
          ? Math.max(
              0,
              Math.floor((punchTime.getTime() - toMillis(latestPunch.timestamp)) / 60_000),
            )
          : null;

      const recordedOvertimeMinutes =
        calculation?.overtimeMinutes ?? extraOvertimeMinutes ?? 0;

      const punchRef = await addDoc(collection(db(), "punches"), {
        employeeId: employee.id,
        employeeName: employee.name,
        companyId: activeCompanyId,
        companyName: company?.name || "Company",
        date: targetAttendanceDate,
        attendanceDate: targetAttendanceDate,
        type: punchType,
        timestamp: serverTimestamp(),
        source: "app",
        scheduledShiftStart: shiftWindow.start.toISOString(),
        scheduledShiftEnd: shiftWindow.end.toISOString(),
        shiftTimezone: shiftWindow.timezone,
        requiredWorkMinutes,
        isOffShiftDay,
        ...(calculation
          ? {
              normalWorkMinutes: calculation.normalWorkMinutes,
              overtimeMinutes: calculation.overtimeMinutes,
              totalEligibleMinutes: calculation.totalEligibleMinutes,
              attendanceStatus: calculation.status,
            }
          : extraOvertimeMinutes !== null
            ? {
                normalWorkMinutes: 0,
                overtimeMinutes: extraOvertimeMinutes,
                totalEligibleMinutes: extraOvertimeMinutes,
                attendanceStatus: "complete",
              }
            : { attendanceStatus: "in_progress" }),
      });

      // 1. If overtime was worked on punch-out, auto-create a pending OvertimeRequest for Admin
      if (targetType === "out" && recordedOvertimeMinutes > 0) {
        try {
          const reason = isOffShiftDay
            ? `Worked ${formatWorkMinutes(recordedOvertimeMinutes)} on ${holiday ? holiday.name : "off-shift day"}`
            : `Worked ${formatWorkMinutes(recordedOvertimeMinutes)} past shift hours`;

          const otDoc = await addDoc(collection(db(), "overtimeRequests"), {
            employeeId: employee.id,
            employeeName: employee.name,
            companyId: activeCompanyId,
            date: targetAttendanceDate,
            requestType: isOffShiftDay ? "off_shift_work" : "overtime",
            punchOutId: punchRef.id,
            punchInId: latestPunch?.id || "",
            overtimeMinutes: recordedOvertimeMinutes,
            normalWorkMinutes: calculation?.normalWorkMinutes || 0,
            isOffShiftDay,
            reason,
            status: "pending",
            createdAt: new Date().toISOString(),
          });

          await setDoc(doc(db(), "punches", punchRef.id), { overtimeRequestId: otDoc.id }, { merge: true });
        } catch (otErr) {
          console.warn("Could not save overtime request:", otErr);
        }
      }

      // 2. If punching in early before scheduled shift start on a work day:
      let isEarlyPunchIn = false;
      let earlyPunchMinutes = 0;
      if (targetType === "in" && shiftWindow.start && !isOffShiftDayToday) {
        earlyPunchMinutes = Math.floor(
          (shiftWindow.start.getTime() - punchTime.getTime()) / 60_000,
        );
        if (earlyPunchMinutes >= 5) {
          isEarlyPunchIn = true;
          try {
            const earlyReason = `Early clock-in: started work ${formatWorkMinutes(earlyPunchMinutes)} before scheduled shift at ${format(shiftWindow.start, "h:mm a")}`;
            const earlyOtDoc = await addDoc(collection(db(), "overtimeRequests"), {
              employeeId: employee.id,
              employeeName: employee.name,
              companyId: activeCompanyId,
              date: punchDate,
              requestType: "early_clock_in",
              punchInId: punchRef.id,
              overtimeMinutes: earlyPunchMinutes,
              normalWorkMinutes: 0,
              isOffShiftDay: false,
              reason: earlyReason,
              status: "pending",
              createdAt: new Date().toISOString(),
            });

            await setDoc(
              doc(db(), "punches", punchRef.id),
              { overtimeRequestId: earlyOtDoc.id, earlyPunchMinutes },
              { merge: true },
            );
          } catch (earlyErr) {
            console.warn("Could not save early clock-in request:", earlyErr);
          }
        }
      }

      try {
        await publishPersonalAttendanceEvent({
          ownerUid: user.uid,
          employee,
          punchId: punchRef.id,
          punchType,
          date: punchDate,
          occurredAt: punchTime,
        });
      } catch (automationError) {
        console.warn("Personal automation status could not be updated:", automationError);
      }

      setQuote(randomQuote());
      if (targetType === "in") {
        const lateness = computeEmployeeLateness(
          new Date(),
          employee,
          company?.lateGraceMinutes ?? 5,
        );
        if (isOffShiftDay) {
          toast.success("Punched in on off-shift day! Time will count as overtime.");
        } else if (approvedLeaveToday) {
          toast.success("Punched in on leave date!");
        } else if (isEarlyPunchIn) {
          toast.success(
            `Punched in early! Early clock-in request (${formatWorkMinutes(earlyPunchMinutes)}) submitted to Admin for approval.`,
          );
        } else if (lateness.isLate) {
          toast.warning(`Punched in ${lateness.minutes}m late.`);
        } else {
          toast.success("Punched in on time!");
        }

        // Auto-popup SOD Notepad after Punch In
        setShowNotepadModal("sod");
      } else {
        if (recordedOvertimeMinutes > 0) {
          toast.success(
            `Punched out! ${formatWorkMinutes(recordedOvertimeMinutes)} overtime submitted for admin approval.`,
          );
        } else {
          toast.success("Punched out successfully!");
        }

        // Auto-popup EOD Notepad after Punch Out
        setShowNotepadModal("eod");
      }
      setConfirmEarly(false);
      setShowPunchOutModal(false);
    } catch (e) {
      toast.error("Punch Action Failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [showNotepadModal, setShowNotepadModal] = useState<"sod" | "eod" | null>(null);
  const [sodAnswers, setSodAnswers] = useState<Record<string, string>>({});
  const [eodAnswers, setEodAnswers] = useState<Record<string, string>>({});
  const [sodMentions, setSodMentions] = useState<Record<string, MentionItem[]>>({});
  const [eodMentions, setEodMentions] = useState<Record<string, MentionItem[]>>({});
  const [savingNotepad, setSavingNotepad] = useState(false);

  async function submitNotepadReport(type: "sod" | "eod") {
    if (!employee || !user) return;
    setSavingNotepad(true);
    try {
      const answersMap = type === "sod" ? sodAnswers : eodAnswers;
      const mentionsMap = type === "sod" ? sodMentions : eodMentions;
      const questionsList = DEFAULT_REPORT_QUESTIONS[type];
      const reportAnswers = questionsList.map((q) => {
        const mList = mentionsMap[q.id] || [];
        return {
          questionId: q.id,
          question: q.question,
          answer: answersMap[q.id]?.trim() || "",
          ...(mList.length > 0 ? { mentions: mList } : {}),
        };
      });

      const allReportMentions = reportAnswers.flatMap((a) => a.mentions || []);

      const reportDate = reportDateForEmployee(employee, new Date());
      const reportId = reportDocumentId(user.uid, reportDate, type, activeCompanyId);
      const reportRef = doc(db(), "dailyReports", reportId);

      await setDoc(
        reportRef,
        sanitizeFirestoreObject({
          userId: user.uid,
          employeeId: employee.id,
          companyId: activeCompanyId,
          userName: employee.name || "",
          userEmail: employee.email || "",
          reportType: type,
          reportDate,
          answers: reportAnswers,
          ...(allReportMentions.length > 0 ? { mentions: allReportMentions } : {}),
          submittedAt: serverTimestamp(),
          status: "submitted",
          timezone: getEmployeeTimezone(employee),
          submittedLate: false,
        }),
        { merge: true },
      );

      let notificationFailed = false;
      if (allReportMentions.length > 0 && user) {
        const recipients = resolveMentionRecipients(
          allReportMentions,
          allEmployees,
          employee.email,
        );
        try {
          await sendMentionNotification(user, {
            company: companyEmailBranding(company, employee.companyId),
            reportId,
            reportType: type,
            reportDate,
            authorName: employee.name,
            authorEmail: employee.email,
            authorDeptName: depts.find((d) => d.id === employee.deptId)?.name,
            answers: reportAnswers,
            recipients,
          });
        } catch (notificationError) {
          notificationFailed = true;
          console.error("Notepad mention notification error:", notificationError);
        }
      }

      if (notificationFailed) {
        toast.warning(
          `Your ${type.toUpperCase()} report was saved, but mention emails could not be sent.`,
        );
      } else {
        toast.success(`Your ${type.toUpperCase()} report has been saved.`);
      }

      setShowNotepadModal(null);
      if (type === "sod") {
        setSodAnswers({});
        setSodMentions({});
      } else {
        setEodAnswers({});
        setEodMentions({});
      }
    } catch (err) {
      console.error("Notepad save error:", err);
      toast.error("Could not save report: " + (err as Error).message);
    } finally {
      setSavingNotepad(false);
    }
  }

  function handlePunchClick() {
    if (isPunchedIn) {
      doPunch("out");
    } else {
      doPunch("in");
    }
  }

  if (!employee) {
    if (isAdmin) {
      return (
        <div className="max-w-lg mx-auto py-16 px-4">
          <div className="rounded-2xl border bg-card p-8 text-center shadow-lift space-y-6">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary">
              <span className="text-3xl">🛡️</span>
            </div>

            <div>
              <h1 className="text-2xl font-bold text-primary">Admin Account</h1>
              <p className="mt-2 text-sm text-muted-foreground font-medium">
                You are logged in as an Administrator (<strong>{user?.email}</strong>). You do not have an assigned employee shift profile.
              </p>
            </div>

            <div>
              <Link
                to="/admin"
                className="btn-lift inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-xs font-bold text-primary-foreground shadow-md"
              >
                Go to Admin Dashboard &rarr;
              </Link>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-lg mx-auto py-16 px-4">
        <div className="rounded-2xl border bg-card p-8 text-center shadow-lift space-y-6">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary animate-pulse">
            <span className="text-3xl">⏳</span>
          </div>

          <div>
            <h1 className="text-2xl font-bold text-primary">Admin will contact you later</h1>
            <p className="mt-2 text-sm text-muted-foreground font-medium">
              Your account (<strong>{user?.email}</strong>) has been registered. Please stay tuned
              while your administrator assigns your department and shift profile.
            </p>
          </div>

          <div className="rounded-xl border bg-secondary/40 p-6 text-left relative shadow-sm">
            <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-2">
              ✨ Daily Motivation
            </span>
            <blockquote className="italic text-sm text-primary font-medium">
              "{quote.text}"
            </blockquote>
            <span className="text-xs text-muted-foreground block mt-2 font-semibold text-right">
              — {quote.author}
            </span>
          </div>

          <button
            onClick={() => setQuote(randomQuote())}
            className="btn-lift rounded-full border px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
          >
            🎲 Next Inspiration
          </button>
        </div>
      </div>
    );
  }

  const todayStr = zonedDateKey(new Date(), getEmployeeTimezone(employee));
  const holiday = getEmployeeHoliday(company, employee, todayStr);
  const isHoliday = Boolean(holiday);

  // Allow viewing page & activities even on holiday

  // Allow viewing page & activities even while on leave

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Top Welcome Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {(() => {
              const hour = new Date().getHours();
              const greeting =
                hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
              const firstName = employee.name?.split(" ")[0] || employee.name;
              return `${greeting}, ${firstName}`;
            })()}
          </h1>
          <p className="text-sm font-medium text-muted-foreground mt-0.5">
            {format(new Date(), "EEEE d MMMM")} — here's how the week is shaping up.
          </p>
        </div>
        <div className="w-fit rounded-lg border bg-card/60 px-3.5 py-1.5 text-xs font-semibold text-muted-foreground shadow-xs">
          {employee.jobTitle || "Team Member"} · {deptName || "General"}
        </div>
      </div>

      {/* Company holiday status */}
      {isHoliday && (
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Company holiday</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">
              {holiday?.name || "Holiday"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your regular shift is off today. Approved additional work can be recorded separately.
            </p>
          </div>
          <Link
            to="/app/extra"
            className="inline-flex shrink-0 items-center justify-center rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Log extra time
          </Link>
        </div>
      )}

      {/* Active leave or scheduled break banner */}
      {onLeaveToday && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-300 flex items-center gap-3 shadow-xs">
          <Lock className="h-5 w-5 text-amber-600 shrink-0" />
          <div>
            <span className="font-extrabold block text-sm text-amber-900 dark:text-amber-200">
              {getLeaveLabel(activeLeave)}
            </span>
            <p className="text-xs text-muted-foreground font-medium">
              Punching is disabled only during this approved period. You can still view your recent
              activity and punch history below.
            </p>
          </div>
        </div>
      )}

      {/* Active 24-Hour HR Announcements Banner */}
      {active24hNotices.length > 0 && (
        <div className="space-y-3">
          {active24hNotices.map((n) => {
            let touchStartX = 0;
            return (
              <div
                key={n.id}
                onTouchStart={(e) => {
                  touchStartX = e.touches[0].clientX;
                }}
                onTouchEnd={(e) => {
                  const touchEndX = e.changedTouches[0].clientX;
                  if (Math.abs(touchEndX - touchStartX) > 50) {
                    dismissNotice(n.id);
                  }
                }}
                className="p-4 rounded-xl border bg-amber-500/10 border-amber-500/20 text-amber-900 dark:text-amber-300 flex items-start justify-between gap-3 shadow-sm transition-all"
              >
                <div className="flex items-start gap-3">
                  <Megaphone className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-extrabold text-sm text-primary">{n.title}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 px-2 py-0.5 rounded text-amber-800 dark:text-amber-200">
                        {n.priority}
                      </span>
                    </div>
                    <p className="text-xs font-medium leading-relaxed">{n.message}</p>
                    <div className="text-[10px] text-muted-foreground pt-1">
                      Posted by {n.authorName} · {format(new Date(n.createdAt), "MMM d, h:mm a")}{" "}
                      (Swipe or click ✕ to dismiss)
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Link
                    to="/app/notices"
                    className="btn-lift text-xs font-bold text-primary hover:underline bg-background px-2.5 py-1.5 rounded-lg border shadow-xs"
                  >
                    View Notifications ↗
                  </Link>

                  <button
                    onClick={() => dismissNotice(n.id)}
                    className="btn-lift p-1.5 rounded-lg border bg-background hover:bg-rose-500/10 hover:text-rose-600 transition-colors text-muted-foreground"
                    title="Dismiss from main screen"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Shift shown as one real instant in every supported region */}
      <div className="order-last space-y-4 rounded-xl border bg-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="font-semibold text-foreground">Your shift across timezones</h2>
            <p className="text-xs text-muted-foreground">
              Shift configured in {getShiftTimezone(employee)}. Your local timezone is{" "}
              {getEmployeeTimezone(employee)}.
            </p>
          </div>
          {attendanceStatus?.isLate && !approvedLeaveToday && !isHoliday && (
            <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-xs font-bold text-rose-600">
              {attendanceStatus.isMissingLate ? "Not punched in" : "Late arrival"} ·{" "}
              {attendanceStatus.minutesLate} min
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {shiftConversions.map((zone) => (
            <div
              key={zone.value}
              className={`rounded-lg border p-3 ${zone.value === getEmployeeTimezone(employee) ? "border-primary bg-primary/5" : "bg-secondary/30"}`}
            >
              <div className="text-xs font-bold text-muted-foreground">{zone.short}</div>
              <div className="mt-1 font-mono text-sm font-bold">
                {zone.start} – {zone.end}
              </div>
              {zone.value === getEmployeeTimezone(employee) && (
                <div className="mt-1 text-[10px] font-bold uppercase text-primary">
                  Your local time
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {/* Main Side-by-Side Grid Layout */}
      <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-12">
        {/* Left Column: Recent Activity Card (7 cols) */}
        <div className="order-2 flex flex-col overflow-hidden rounded-xl border bg-card shadow-lift md:order-1 md:col-span-7">
          {/* Blue Header Bar */}
          <div className="bg-sky-600 text-white font-bold text-base px-5 py-3 flex items-center justify-between shadow-sm">
            <span>Recent Activity</span>
            <span className="text-xs font-medium opacity-90">Last 10 Logs</span>
          </div>

          <div className="p-4 flex-1 overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b text-foreground font-bold">
                  <th className="pb-3 pt-1 px-2 text-sm">Activity</th>
                  <th className="pb-3 pt-1 px-2 text-right text-sm">Department</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {recentPunchesList.map((p, idx) => {
                  const dateObj = toDate(p.timestamp) ?? new Date();
                  const isPunchIn = p.type === "in" || p.type === "extra_in";
                  const timeStr = formatInTimezone(dateObj, getEmployeeTimezone(employee));
                  const dateStr = format(dateObj, "dd/MM/yyyy");

                  return (
                    <tr key={p.id || idx} className="hover:bg-accent/40 transition-colors">
                      <td className="py-3 px-2 flex items-center gap-2">
                        {isPunchIn ? (
                          <span className="h-3 w-3 rounded-full bg-emerald-500 shrink-0 inline-block shadow-sm" />
                        ) : (
                          <span className="h-3 w-3 rounded-full bg-rose-500 shrink-0 inline-block shadow-sm" />
                        )}
                        <span className="text-slate-800 font-semibold text-xs">
                          {isPunchIn ? "In" : "Out"} at {timeStr} On {dateStr}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-right text-slate-700 font-semibold text-xs">
                        {deptName}
                      </td>
                    </tr>
                  );
                })}

                {recentPunchesList.length === 0 && (
                  <tr>
                    <td
                      colSpan={2}
                      className="py-8 text-center text-muted-foreground text-sm font-medium"
                    >
                      No recent activities logged yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Web Punch Card (5 cols) */}
        <div className="order-1 flex flex-col justify-between overflow-hidden rounded-xl border bg-card md:order-2 md:col-span-5">
          <div className="border-b bg-muted/40 px-5 py-3 text-base font-semibold text-foreground">
            Web Punch
          </div>

          <div className="p-6 space-y-6 flex-1 flex flex-col justify-center">
            {/* ----- Current Status ----- */}
            <div className="space-y-3 text-center">
              <div className="text-xs font-medium text-muted-foreground">Current status</div>

              {isHoliday ? (
                <div className="rounded-lg border bg-muted/40 p-5 text-foreground">
                  <div className="text-lg font-semibold">Holiday</div>
                  <div className="text-xs mt-1">{holiday?.name || "Company Holiday"}</div>
                </div>
              ) : isPunchedIn && lastIn ? (
                <div className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50/60 p-5 text-emerald-950">
                  <div className="text-lg font-semibold">
                    {currentSessionCalculation?.missingPunchOut
                      ? "Missing punch out"
                      : `Working since ${format(lastIn, "h:mm a")}`}
                  </div>
                  <div className="text-sm">On {format(lastIn, "dd/MM/yyyy")}</div>
                  <div className="mt-1 text-sm font-medium text-emerald-900">
                    {company?.name || "Company"} · {deptName}
                  </div>
                  {currentSessionCalculation?.missingPunchOut && (
                    <div className="mt-2 text-xs font-semibold text-rose-700">
                      Your scheduled shift ended without a punch-out. Stop work now to record the
                      actual time; no automatic time was added.
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-1 rounded-lg border bg-muted/40 p-5 text-foreground">
                  <div className="text-lg font-semibold">Not working</div>
                  <div className="text-sm text-muted-foreground">Ready to start shift</div>
                  <div className="mt-1 text-sm font-medium text-foreground">{deptName}</div>
                </div>
              )}
            </div>

            {/* ----- Punch Action Button ----- */}
            <div className="space-y-3">
              <div className="text-xs font-medium text-muted-foreground">
                {isPunchedIn ? "End the current shift" : "Begin today’s shift"}
              </div>

              <button
                disabled={busy || (!isPunchedIn && (onLeaveToday || isHoliday))}
                onClick={handlePunchClick}
                className={`w-full rounded-md px-5 py-3 text-base font-semibold text-white transition-colors ${
                  !isPunchedIn && (onLeaveToday || isHoliday)
                    ? "cursor-not-allowed bg-slate-400 opacity-70"
                    : isPunchedIn
                      ? "bg-rose-600 hover:bg-rose-700"
                      : "bg-primary hover:bg-primary/90"
                }`}
              >
                {isPunchedIn
                  ? "Stop Work"
                  : isHoliday
                    ? "Company Holiday (Shift Off)"
                    : onLeaveToday
                      ? `Start Work Disabled (${getLeaveLabel(activeLeave)})`
                      : "Start Work"}
              </button>

              {/* Ticker Below Button */}
              <div className="text-center pt-2">
                <div className="text-2xl font-mono font-semibold text-foreground tabular-nums">
                  {formatDurationHMS(totalWorkedMs)}
                </div>
                <div className="text-xs text-muted-foreground font-medium mt-0.5">
                  ({(totalWorkedMs / 3600000).toFixed(2)} hours today)
                </div>
                {currentSessionCalculation && (
                  <div className="mt-2 text-xs font-medium text-muted-foreground">
                    Normal {formatWorkMinutes(currentSessionCalculation.normalWorkMinutes)} ·
                    Overtime {formatWorkMinutes(currentSessionCalculation.overtimeMinutes)} ·
                    Required {formatWorkMinutes(currentSessionCalculation.requiredWorkMinutes)}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ----- SOD & EOD Notepad Modal on Punch In / Out ----- */}
      {showNotepadModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150 overflow-y-auto">
          <div className="w-full max-w-xl rounded-2xl border bg-card p-6 shadow-2xl space-y-5 my-8">
            {/* Header */}
            <div className="flex items-start justify-between border-b pb-4">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-xl font-bold shadow-xs ${
                    showNotepadModal === "sod"
                      ? "bg-amber-500/10 text-amber-600 border border-amber-500/20"
                      : "bg-indigo-500/10 text-indigo-600 border border-indigo-500/20"
                  }`}
                >
                  {showNotepadModal === "sod" ? (
                    <Sun className="h-6 w-6 animate-pulse text-amber-500" />
                  ) : (
                    <Moon className="h-6 w-6 animate-pulse text-indigo-500" />
                  )}
                </div>
                <div>
                  <h3 className="text-xl font-extrabold text-foreground flex items-center gap-2">
                    {showNotepadModal === "sod"
                      ? "☀️ Start of Day (SOD) Notepad"
                      : "🌙 End of Day (EOD) Notepad"}
                  </h3>
                  <p className="text-xs text-muted-foreground font-medium">
                    {showNotepadModal === "sod"
                      ? "Fill in your SOD report for today after starting work."
                      : "Fill in your EOD summary for today after stopping work."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNotepadModal(null)}
                className="rounded-lg border p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Info & Duration Badge */}
            <div className="flex items-center justify-between text-xs font-semibold bg-muted/40 p-3 rounded-lg border">
              <span className="flex items-center gap-1.5 text-primary">
                <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
                Report auto-syncs to <strong>SOD & EOD Tab</strong>
              </span>
              <span className="font-mono text-muted-foreground">
                {showNotepadModal === "eod" && totalWorkedMs > 0 ? (
                  <strong className="text-primary font-mono">
                    {formatDurationHMS(totalWorkedMs)} worked
                  </strong>
                ) : (
                  format(new Date(), "dd MMM yyyy")
                )}
              </span>
            </div>

            {/* Notepad Question Textareas */}
            <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
              {DEFAULT_REPORT_QUESTIONS[showNotepadModal].map((question, index) => {
                const currentAnswers = showNotepadModal === "sod" ? sodAnswers : eodAnswers;
                const setAnswersFunc = showNotepadModal === "sod" ? setSodAnswers : setEodAnswers;

                return (
                  <div
                    key={question.id}
                    className="space-y-1.5 rounded-xl border bg-background p-4 shadow-xs"
                  >
                    <label className="block text-xs font-bold text-foreground flex items-center justify-between">
                      <span>
                        <span className="text-primary mr-1">#{index + 1}</span> {question.question}
                      </span>
                      <span className="text-[10px] text-amber-600 font-semibold">Required</span>
                    </label>
                    <MentionTextarea
                      rows={3}
                      value={currentAnswers[question.id] || ""}
                      onChange={(val, mList) => {
                        setAnswersFunc((prev) => ({ ...prev, [question.id]: val }));
                        if (showNotepadModal === "sod") {
                          setSodMentions((prev) => ({ ...prev, [question.id]: mList }));
                        } else {
                          setEodMentions((prev) => ({ ...prev, [question.id]: mList }));
                        }
                      }}
                      currentEmployee={employee}
                      placeholder="Type your answer here... (Type @ to mention team/dept)"
                      className="w-full resize-y rounded-lg border bg-muted/30 px-3 py-2 text-xs font-medium text-foreground focus:bg-background focus:outline-none focus:ring-1 focus:ring-primary transition-all"
                    />
                  </div>
                );
              })}
            </div>

            {/* Action Buttons */}
            <div className="pt-3 space-y-2 border-t">
              <button
                type="button"
                disabled={busy || savingNotepad}
                onClick={() => submitNotepadReport(showNotepadModal)}
                className={`w-full py-3.5 rounded-xl font-bold text-sm text-white shadow-md flex items-center justify-center gap-2 transition-all btn-lift ${
                  showNotepadModal === "sod"
                    ? "bg-amber-600 hover:bg-amber-700"
                    : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                {savingNotepad ? (
                  "Saving Report..."
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Save {showNotepadModal.toUpperCase()} Report to SOD & EOD Tab
                  </>
                )}
              </button>

              <div className="flex items-center justify-between gap-2 text-xs pt-1">
                <Link
                  to="/app/sod-eod"
                  onClick={() => setShowNotepadModal(null)}
                  className="text-primary hover:underline font-bold text-xs inline-flex items-center gap-1"
                >
                  Go to SOD & EOD Tab →
                </Link>

                <button
                  type="button"
                  onClick={() => setShowNotepadModal(null)}
                  className="rounded-lg border px-3.5 py-1.5 font-semibold text-muted-foreground hover:bg-muted"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
