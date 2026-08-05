import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { CheckCircle2, ChevronDown, ChevronUp, Eye, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import {
  DEFAULT_REPORTING_SETTINGS,
  DEFAULT_REPORT_QUESTIONS,
  isReportDeadlinePassed,
  reportDateForEmployee,
  reportDocumentId,
  reportTypeLabel,
  requiredReportTypes,
} from "@/lib/daily-reports";
import { getEmployeeTimezone } from "@/lib/attendance";
import type {
  DailyReport,
  DailyReportAnswer,
  DailyReportType,
  Employee,
  ReportQuestion,
  ReportingSettings,
} from "@/lib/types";

export const Route = createFileRoute("/_authenticated/app/sod-eod")({
  head: () => ({ meta: [{ title: "SOD & EOD Reports - Time Station" }] }),
  component: EmployeeSodEodPage,
});

function EmployeeSodEodPage() {
  const { user, employee } = useAuth();
  const [currentEmployee, setCurrentEmployee] = useState<Employee | null>(employee);
  const [questions, setQuestions] = useState<ReportQuestion[] | null>(null);
  const [settings, setSettings] = useState<ReportingSettings>(DEFAULT_REPORTING_SETTINGS);
  const [reports, setReports] = useState<DailyReport[] | null>(null);
  const [openType, setOpenType] = useState<DailyReportType | null>(null);
  const [answers, setAnswers] = useState<Record<DailyReportType, Record<string, string>>>({
    sod: {},
    eod: {},
  });
  const [submitting, setSubmitting] = useState<DailyReportType | null>(null);
  const [recentlySubmitted, setRecentlySubmitted] = useState<DailyReportType | null>(null);
  const [selectedReport, setSelectedReport] = useState<DailyReport | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const defaultQuestions = useMemo<ReportQuestion[]>(() => {
    return [
      ...DEFAULT_REPORT_QUESTIONS.sod.map((q, order) => ({
        id: q.id,
        reportType: "sod" as const,
        question: q.question,
        required: true,
        order,
      })),
      ...DEFAULT_REPORT_QUESTIONS.eod.map((q, order) => ({
        id: q.id,
        reportType: "eod" as const,
        question: q.question,
        required: true,
        order,
      })),
    ];
  }, []);

  const fallbackEmployee = useMemo<Employee | null>(() => {
    if (employee) return employee;
    if (!user) return null;
    return {
      id: user.uid,
      authUid: user.uid,
      name: user.displayName || user.email?.split("@")[0] || "User",
      email: user.email || "",
      reportingRequirement: "sod_eod",
      status: "active",
      inviteStatus: "accepted",
      timezone: "Asia/Kathmandu",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Employee;
  }, [employee, user]);

  useEffect(() => setCurrentEmployee(employee || fallbackEmployee), [employee, fallbackEmployee]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!user) return;
    const empId = employee?.id || user.uid;
    const unsubEmployee = onSnapshot(
      doc(db(), "employees", empId),
      (snapshot) => {
        if (snapshot.exists()) {
          setCurrentEmployee({ id: snapshot.id, ...(snapshot.data() as Omit<Employee, "id">) });
        }
      },
      (error) => {
        console.error("Employee listener error:", error);
      },
    );
    const unsubQuestions = onSnapshot(
      collection(db(), "reportQuestions"),
      (snapshot) => {
        const loaded = snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<ReportQuestion, "id">),
        }));
        setQuestions(loaded.length > 0 ? loaded : defaultQuestions);
      },
      (error) => {
        console.error("Report questions listener error:", error);
        setQuestions(defaultQuestions);
      },
    );
    const unsubSettings = onSnapshot(
      doc(db(), "reportingSettings", "default"),
      (snapshot) =>
        setSettings(
          snapshot.exists()
            ? { ...DEFAULT_REPORTING_SETTINGS, ...(snapshot.data() as ReportingSettings) }
            : DEFAULT_REPORTING_SETTINGS,
        ),
      (error) => {
        console.error("Reporting settings listener error:", error);
        setSettings(DEFAULT_REPORTING_SETTINGS);
      },
    );
    const reportQuery = query(collection(db(), "dailyReports"), where("userId", "==", user.uid));
    const unsubReports = onSnapshot(
      reportQuery,
      (snapshot) =>
        setReports(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<DailyReport, "id">),
          })),
        ),
      (error) => {
        console.error("Daily reports could not be loaded:", error);
        setReports([]);
      },
    );

    return () => {
      unsubEmployee();
      unsubQuestions();
      unsubSettings();
      unsubReports();
    };
  }, [defaultQuestions, employee, user]);

  const activeEmp = currentEmployee || fallbackEmployee;

  const requiredTypes = useMemo(
    () => requiredReportTypes(activeEmp?.reportingRequirement),
    [activeEmp?.reportingRequirement],
  );
  const reportDate = activeEmp ? reportDateForEmployee(activeEmp, new Date(clock)) : "";

  function questionsFor(type: DailyReportType) {
    const list = questions && questions.length > 0 ? questions : defaultQuestions;
    return list
      .filter((question) => question.reportType === type)
      .sort((a, b) => a.order - b.order);
  }

  function reportForToday(type: DailyReportType) {
    if (!user || !reportDate || !reports) return null;
    const id = reportDocumentId(user.uid, reportDate, type);
    return reports.find((report) => report.id === id) || null;
  }

  async function submitReport(type: DailyReportType) {
    if (!user || !activeEmp || !reportDate) return;
    const typeQuestions = questionsFor(type);
    const typeAnswers = answers[type];
    const missing = typeQuestions.find(
      (question) => question.required && !typeAnswers[question.id]?.trim(),
    );
    if (missing) {
      toast.error(`Please answer: ${missing.question}`);
      return;
    }

    const deadlinePassed = isReportDeadlinePassed(
      activeEmp,
      type,
      reportDate,
      settings,
      new Date(clock),
    );
    if (deadlinePassed && settings.lockAfterDeadline) {
      toast.error(`${reportTypeLabel(type)} submissions are locked after the deadline.`);
      return;
    }
    if (
      !window.confirm(
        "Are you sure you want to submit this report? You will not be able to edit it afterward.",
      )
    ) {
      return;
    }

    const reportAnswers: DailyReportAnswer[] = typeQuestions.map((question) => ({
      questionId: question.id,
      question: question.question,
      answer: typeAnswers[question.id]?.trim() || "",
    }));
    const reportId = reportDocumentId(user.uid, reportDate, type);
    setSubmitting(type);
    try {
      await runTransaction(db(), async (transaction) => {
        const reportRef = doc(db(), "dailyReports", reportId);
        const existing = await transaction.get(reportRef);
        if (existing.exists()) throw new Error("This report has already been submitted.");
        transaction.set(reportRef, {
          userId: user.uid,
          employeeId: activeEmp.id,
          userName: activeEmp.name,
          userEmail: activeEmp.email,
          reportType: type,
          reportDate,
          answers: reportAnswers,
          submittedAt: serverTimestamp(),
          status: "submitted",
          timezone: getEmployeeTimezone(activeEmp),
          submittedLate: deadlinePassed,
        });
      });
      setRecentlySubmitted(type);
      setOpenType(null);
      window.setTimeout(() => setRecentlySubmitted(null), 3500);
      toast.success(`Your ${reportTypeLabel(type)} report has been submitted successfully.`);
    } catch (error) {
      toast.error("Could not submit report: " + (error as Error).message);
    } finally {
      setSubmitting(null);
    }
  }

  const history = useMemo(
    () =>
      [...(reports || [])].sort((a, b) => {
        const dateOrder = b.reportDate.localeCompare(a.reportDate);
        if (dateOrder) return dateOrder;
        return (b.submittedAt?.toMillis?.() || 0) - (a.submittedAt?.toMillis?.() || 0);
      }),
    [reports],
  );

  if (!activeEmp) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Your employee profile is not active yet.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">SOD & EOD reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily reports for {reportDate} in {getEmployeeTimezone(activeEmp)}.
        </p>
      </div>

      {questions === null || reports === null ? (
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded bg-muted" />
        </div>
      ) : requiredTypes.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center">
          <h2 className="font-semibold">No reporting required</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You are not currently required to submit SOD or EOD reports.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {requiredTypes.map((type) => {
            const report = reportForToday(type);
            const deadlinePassed = isReportDeadlinePassed(
              activeEmp,
              type,
              reportDate,
              settings,
              new Date(clock),
            );
            const locked = deadlinePassed && settings.lockAfterDeadline && !report;
            const isOpen = openType === type;
            const typeQuestions = questionsFor(type);

            return (
              <section key={type} className="rounded-xl border bg-card p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{reportTypeLabel(type)}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Deadline {type === "sod" ? settings.sodDeadline : settings.eodDeadline}
                    </p>
                  </div>
                  <UserStatusBadge report={report} deadlinePassed={deadlinePassed} />
                </div>

                {recentlySubmitted === type && (
                  <div className="mt-4 flex animate-in items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-5 w-5" /> Submitted successfully
                  </div>
                )}

                {report ? (
                  <SubmittedReport report={report} />
                ) : locked ? (
                  <div className="mt-5 rounded-lg border p-4 text-sm text-muted-foreground">
                    The deadline has passed and late submissions are locked.
                  </div>
                ) : (
                  <div className="mt-5">
                    {deadlinePassed && (
                      <p className="mb-3 text-sm text-muted-foreground">
                        The deadline has passed. A late submission is still allowed.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => setOpenType(isOpen ? null : type)}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
                    >
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                      {isOpen ? "Close form" : `Complete ${type.toUpperCase()} report`}
                    </button>
                    {isOpen && (
                      <div className="mt-5 space-y-4 border-t pt-5">
                        {typeQuestions.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No questions have been configured yet.
                          </p>
                        ) : (
                          typeQuestions.map((question) => (
                            <label key={question.id} className="block text-sm font-medium">
                              {question.question}{" "}
                              {question.required && <span aria-label="required">*</span>}
                              <textarea
                                value={answers[type][question.id] || ""}
                                onChange={(event) =>
                                  setAnswers((current) => ({
                                    ...current,
                                    [type]: { ...current[type], [question.id]: event.target.value },
                                  }))
                                }
                                rows={3}
                                className="mt-1.5 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm"
                                placeholder={question.required ? "Required" : "Optional"}
                              />
                            </label>
                          ))
                        )}
                        <button
                          type="button"
                          disabled={submitting === type || typeQuestions.length === 0}
                          onClick={() => submitReport(type)}
                          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                        >
                          {submitting === type ? "Submitting..." : "Submit final report"}
                        </button>
                        <p className="text-center text-xs text-muted-foreground">
                          Submitted reports cannot be edited or deleted.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Report history</h2>
        <p className="mb-4 text-sm text-muted-foreground">Your submitted reports are read-only.</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No submitted reports yet.
                  </td>
                </tr>
              ) : (
                history.map((report) => (
                  <tr key={report.id}>
                    <td className="px-4 py-3">{report.reportDate}</td>
                    <td className="px-4 py-3">{reportTypeLabel(report.reportType)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatSubmissionTime(report)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                        Submitted
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedReport(report)}
                        className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 font-medium"
                      >
                        <Eye className="h-4 w-4" /> View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedReport && (
        <ReportViewModal report={selectedReport} onClose={() => setSelectedReport(null)} />
      )}
    </div>
  );
}

function UserStatusBadge({
  report,
  deadlinePassed,
}: {
  report: DailyReport | null;
  deadlinePassed: boolean;
}) {
  const label = report ? "Submitted" : deadlinePassed ? "Missed" : "Not submitted";
  const className = report
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : deadlinePassed
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

function SubmittedReport({ report }: { report: DailyReport }) {
  return (
    <div className="mt-5 space-y-3">
      <p className="text-sm text-muted-foreground">
        Submitted {formatSubmissionTime(report)}
        {report.submittedLate ? " (late)" : ""}
      </p>
      {report.answers.map((answer, index) => (
        <div key={`${answer.questionId}-${index}`} className="rounded-lg border p-3">
          <div className="text-sm font-medium">{answer.question}</div>
          <div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {answer.answer || "No answer provided"}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReportViewModal({ report, onClose }: { report: DailyReport; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-card p-5 shadow-xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">{reportTypeLabel(report.reportType)} report</h3>
            <p className="text-sm text-muted-foreground">
              {report.reportDate} - {formatSubmissionTime(report)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border p-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 space-y-4">
          {report.answers.map((answer, index) => (
            <div key={`${answer.questionId}-${index}`} className="rounded-lg border p-4">
              <div className="text-sm font-semibold">{answer.question}</div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {answer.answer || "No answer provided"}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSubmissionTime(report: DailyReport) {
  if (!report.submittedAt?.toDate) return "Processing...";
  return report.submittedAt.toDate().toLocaleString([], {
    timeZone: report.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}
