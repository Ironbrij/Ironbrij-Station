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
import { formatDurationHMS } from "@/lib/time";
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
  PartyPopper,
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
import { getNoticeDeliveryTime, isNoticePublished } from "@/lib/notices";
import { publishPersonalAttendanceEvent } from "@/lib/personal-automation";

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

const HOLIDAY_GIFS = [
  "https://media.giphy.com/media/l2JIdnF6aJzAEYdLW/giphy.gif", // Party Confetti
  "https://media.giphy.com/media/26tOZ42Mg6pbTUPHW/giphy.gif", // Chill Vacation
  "https://media.giphy.com/media/xT0xezQGU5xCDJuCPe/giphy.gif", // Dance Party
  "https://media.giphy.com/media/l41YkxvUlBwhg785q/giphy.gif", // Fireworks
];

function PunchPage() {
  const { user, employee, company } = useAuth();
  const [depts, setDepts] = useState<Department[]>([]);
  const [notices, setNotices] = useState<CompanyNotice[]>([]);
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState(randomQuote());
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [confirmEarly, setConfirmEarly] = useState(false);
  const [showPunchOutModal, setShowPunchOutModal] = useState(false);
  const [gifIndex, setGifIndex] = useState(0);
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

  useEffect(() => {
    const u1 = onSnapshot(collection(db(), "departments"), (s) =>
      setDepts(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) }))),
    );
    const u2 = onSnapshot(collection(db(), "notices"), (s) =>
      setNotices(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CompanyNotice, "id">) }))),
    );
    const u3 = onSnapshot(collection(db(), "employees"), (s) =>
      setAllEmployees(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) }))),
    );
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);

  // Fetch all punches for this employee (Index-free, real-time sync)
  useEffect(() => {
    if (!employee) return;
    const q = query(collection(db(), "punches"), where("employeeId", "==", employee.id));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }));
        const sorted = list.sort(
          (a, b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0),
        );
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
    () => (employee ? getActiveEmployeeLeave(employee, leaves, new Date(now)) : null),
    [employee, leaves, now],
  );
  const onLeaveToday = Boolean(activeLeave);
  const approvedLeaveToday = useMemo(
    () =>
      employee
        ? getEmployeeApprovedLeaveForDate(
            employee,
            leaves,
            zonedDateKey(new Date(now), getShiftTimezone(employee)),
          )
        : null,
    [employee, leaves, now],
  );

  // Resolve department name
  const deptName = useMemo(() => {
    if (!employee?.deptId) return "General";
    return depts.find((d) => d.id === employee.deptId)?.name || "General";
  }, [depts, employee]);

  // Determine punch status strictly based on the latest punch
  const isPunchedIn = useMemo(() => {
    if (allPunches.length === 0) return false;
    const latest = allPunches[allPunches.length - 1];
    return latest?.type === "in" || latest?.type === "extra_in";
  }, [allPunches]);

  const lastIn = useMemo(() => {
    if (!isPunchedIn) return null;
    const latest = allPunches[allPunches.length - 1];
    return latest?.timestamp?.toDate() ?? null;
  }, [allPunches, isPunchedIn]);

  const attendanceStatus = useMemo(
    () =>
      employee
        ? getLiveAttendanceStatus(
            employee,
            allPunches,
            new Date(now),
            company?.lateGraceMinutes ?? 5,
            company?.workingDays,
            getEmployeeHolidayDates(company, employee),
          )
        : null,
    [employee, allPunches, now, company],
  );

  const shiftConversions = useMemo(
    () => (employee ? getShiftConversions(employee, new Date(now)) : []),
    [employee, now],
  );

  // Recent 10 activity logs sorted descending
  const recentPunchesList = useMemo(() => {
    return [...allPunches].reverse().slice(0, 10);
  }, [allPunches]);

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

      if (!n.targetType || n.targetType === "all") return true;
      if (
        n.targetType === "dept" &&
        employee?.deptId &&
        (n.targetDeptId === employee.deptId || n.targetDeptIds?.includes(employee.deptId))
      )
        return true;
      if (
        n.targetType === "states" &&
        employee &&
        n.targetStateCodes?.includes(employee.state?.trim() || "N/A")
      )
        return true;
      if (
        n.targetType === "employee" &&
        employee &&
        (n.targetEmployeeId === employee.id ||
          n.targetEmployeeId === employee.authUid ||
          n.targetEmployeeIds?.some((id) => id === employee.id || id === employee.authUid))
      )
        return true;
      return false;
    });
  }, [notices, employee, dismissedNoticeIds, now]);

  // Auto punch-out reconciliation if employee is on leave/holiday while punched in
  useEffect(() => {
    if (!employee || !isPunchedIn) return;
    const todayStr = zonedDateKey(new Date(), getEmployeeTimezone(employee));
    const isHolidayStr = Boolean(getEmployeeHoliday(company, employee, todayStr));

    if (isHolidayStr || onLeaveToday) {
      addDoc(collection(db(), "punches"), {
        employeeId: employee.id,
        employeeName: employee.name,
        date: todayStr,
        type: "out",
        timestamp: serverTimestamp(),
        source: "auto",
        isAuto: true,
        autoReason: isHolidayStr ? "company_holiday" : "approved_leave",
      }).catch((e) => console.error("Auto punch-out on leave failed:", e));
    }
  }, [employee, isPunchedIn, onLeaveToday, company]);

  const totalWorkedMs = useMemo(() => {
    if (!employee) return 0;
    return computeRegularWorkedMsForDay(employee, allPunches, new Date(now), new Date(now));
  }, [employee, allPunches, now]);

  async function doPunch(targetType: "in" | "out") {
    if (!employee || !user) return;

    // Strict Double-Punch Validation
    const latestType = allPunches[allPunches.length - 1]?.type;

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
      const punchRef = await addDoc(collection(db(), "punches"), {
        employeeId: employee.id,
        employeeName: employee.name,
        date: punchDate,
        type: punchType,
        timestamp: serverTimestamp(),
        source: "app",
      });

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
        const schedule = getLiveAttendanceStatus(
          employee,
          allPunches,
          new Date(),
          company?.lateGraceMinutes ?? 5,
          company?.workingDays,
          getEmployeeHolidayDates(company, employee),
        );
        const lateness = computeEmployeeLateness(
          new Date(),
          employee,
          company?.lateGraceMinutes ?? 5,
        );
        if (!schedule.isScheduledDay) toast.success("Punched in! Fill out your SOD report below.");
        else if (approvedLeaveToday) toast.success("Punched in on leave date!");
        else if (lateness.isLate) toast.warning(`Punched in ${lateness.minutes}m late.`);
        else toast.success("Punched in on time!");

        // Auto-popup SOD Notepad after Punch In
        setShowNotepadModal("sod");
      } else {
        toast.success("Punched out successfully!");

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
      const reportId = reportDocumentId(user.uid, reportDate, type);
      const reportRef = doc(db(), "dailyReports", reportId);

      await setDoc(
        reportRef,
        sanitizeFirestoreObject({
          userId: user.uid,
          employeeId: employee.id,
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
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Top Welcome Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div className="flex items-center gap-3">
          <img
            src={
              company?.logoUrl ||
              "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg"
            }
            alt={company?.name || "ironbrij"}
            className="h-12 w-12 object-contain rounded-xl border bg-background shadow-sm shrink-0"
          />
          <div>
            <h1 className="text-2xl font-bold text-primary">Hello, {employee.name}</h1>
            <p className="text-sm text-muted-foreground font-medium">
              {company?.name || "ironbrij"} · {employee.jobTitle} ·{" "}
              <span className="text-primary font-semibold">{deptName}</span>
            </p>
          </div>
        </div>
        <div className="text-xs text-muted-foreground font-mono bg-secondary px-3.5 py-2 rounded-lg border w-fit">
          Today: {format(new Date(), "dd/MM/yyyy")}
        </div>
      </div>

      {/* Company Holiday Today Celebration Card with GIFs */}
      {isHoliday && (
        <div className="rounded-2xl border border-purple-500/30 bg-gradient-to-r from-purple-500/10 via-pink-500/10 to-amber-500/10 p-6 shadow-lift space-y-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="space-y-2 text-center md:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/20 text-purple-800 dark:text-purple-200 text-xs font-black uppercase tracking-wider border border-purple-500/30">
                <PartyPopper className="h-4 w-4 text-purple-600 animate-bounce" /> Company Holiday
                Active! 🥳
              </div>
              <h2 className="text-2xl font-black text-primary tracking-tight">
                {holiday?.name || "Happy Holidays"}, {employee.name}! 🎉
              </h2>
              <p className="text-sm text-muted-foreground font-medium max-w-lg leading-relaxed">
                Regular shift is off today! Enjoy your well-deserved day off to relax, unwind, and
                celebrate. If you decide to log overtime today, use the{" "}
                <Link to="/app/extra" className="text-primary underline font-extrabold">
                  Extra Time Tab ↗
                </Link>
                .
              </p>

              <div className="pt-2 flex items-center justify-center md:justify-start gap-3">
                <button
                  onClick={() => setGifIndex((prev) => (prev + 1) % HOLIDAY_GIFS.length)}
                  className="btn-lift rounded-lg bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 text-xs font-extrabold flex items-center gap-1.5 shadow-sm"
                >
                  🎲 Shuffle Holiday GIF
                </button>
                <Link
                  to="/app/extra"
                  className="btn-lift rounded-lg bg-background border px-4 py-2 text-xs font-bold text-primary hover:bg-muted"
                >
                  Log Extra Hours ↗
                </Link>
              </div>
            </div>

            {/* Animated Holiday GIF */}
            <div className="relative group shrink-0">
              <img
                src={HOLIDAY_GIFS[gifIndex]}
                alt="Holiday Celebration Fun"
                className="h-44 w-72 object-cover rounded-xl border-2 border-purple-500/30 shadow-lg group-hover:scale-105 transition-transform duration-300"
              />
              <span className="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] font-mono px-2 py-0.5 rounded backdrop-blur-xs">
                Holiday Mood #{gifIndex + 1}
              </span>
            </div>
          </div>
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
      <div className="rounded-xl border bg-card p-5 shadow-lift space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="font-bold text-primary">Your shift across timezones</h2>
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
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Recent Activity Card (7 cols) */}
        <div className="lg:col-span-7 rounded-xl border bg-card shadow-lift overflow-hidden flex flex-col">
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
                  const dateObj = p.timestamp ? p.timestamp.toDate() : new Date();
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
        <div className="lg:col-span-5 rounded-xl border bg-card shadow-lift overflow-hidden flex flex-col justify-between">
          {/* Blue Header Bar */}
          <div className="bg-sky-600 text-white font-bold text-base px-5 py-3 shadow-sm">
            Web Punch
          </div>

          <div className="p-6 space-y-6 flex-1 flex flex-col justify-center">
            {/* ----- Current Status ----- */}
            <div className="space-y-3 text-center">
              <div className="text-xs font-bold text-muted-foreground flex items-center justify-center gap-2 uppercase tracking-wider">
                <span className="h-px bg-border flex-1" />
                <span>Current Status</span>
                <span className="h-px bg-border flex-1" />
              </div>

              {isHoliday ? (
                <div className="rounded-xl bg-purple-500/10 text-purple-800 dark:text-purple-200 font-bold p-5 border border-purple-500/30 shadow-sm">
                  <div className="text-2xl font-black">Holiday</div>
                  <div className="text-xs mt-1">{holiday?.name || "Company Holiday"}</div>
                </div>
              ) : isPunchedIn && lastIn ? (
                <div className="rounded-xl bg-lime-400 text-slate-900 font-bold p-5 border border-lime-500 shadow-sm space-y-1">
                  <div className="text-2xl font-black">
                    Working since {format(lastIn, "h:mm a")}
                  </div>
                  <div className="text-base font-bold">On {format(lastIn, "dd/MM/yyyy")}</div>
                  <div className="text-sm font-black text-slate-800 mt-1 uppercase tracking-wide">
                    {deptName}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-slate-200 text-slate-800 font-bold p-5 border border-slate-300 shadow-sm space-y-1">
                  <div className="text-2xl font-black">Not Working</div>
                  <div className="text-base font-bold text-slate-600">Ready to start shift</div>
                  <div className="text-sm font-black text-slate-700 mt-1 uppercase tracking-wide">
                    {deptName}
                  </div>
                </div>
              )}
            </div>

            {/* ----- Punch Action Button ----- */}
            <div className="space-y-3">
              <div className="text-xs font-bold text-muted-foreground flex items-center justify-center gap-2 uppercase tracking-wider">
                <span className="h-px bg-border flex-1" />
                <span>{isPunchedIn ? "Stop Work" : "Start Work"}</span>
                <span className="h-px bg-border flex-1" />
              </div>

              <button
                disabled={busy || onLeaveToday || isHoliday}
                onClick={handlePunchClick}
                className={`w-full py-4 rounded-lg font-black text-xl text-white shadow-md transition-all transform active:scale-98 ${
                  onLeaveToday || isHoliday
                    ? "bg-slate-400 cursor-not-allowed border border-slate-500 opacity-70"
                    : isPunchedIn
                      ? "bg-red-600 hover:bg-red-700 border border-red-700"
                      : "bg-emerald-600 hover:bg-emerald-700 border border-emerald-700"
                }`}
              >
                {isHoliday
                  ? "Company Holiday (Shift Off)"
                  : onLeaveToday
                    ? `Start Work Disabled (${getLeaveLabel(activeLeave)})`
                    : isPunchedIn
                      ? "Stop Work"
                      : "Start Work"}
              </button>

              {/* Ticker Below Button */}
              <div className="text-center pt-2">
                <div className="text-2xl font-mono font-bold text-primary tabular-nums">
                  {formatDurationHMS(totalWorkedMs)}
                </div>
                <div className="text-xs text-muted-foreground font-medium mt-0.5">
                  ({(totalWorkedMs / 3600000).toFixed(2)} hours today)
                </div>
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
