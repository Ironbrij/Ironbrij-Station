import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { ArrowDown, ArrowUp, Eye, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import {
  DEFAULT_REPORTING_SETTINGS,
  DEFAULT_REPORT_QUESTIONS,
  isReportDeadlinePassed,
  reportDocumentId,
  reportTypeLabel,
  reportingRequirementLabel,
  requiredReportTypes,
} from "@/lib/daily-reports";
import { DEFAULT_LOCAL_TIMEZONE, getEmployeeTimezone, zonedDateKey } from "@/lib/attendance";
import { FormattedAnswerText } from "@/components/FormattedAnswerText";
import type {
  Company,
  DailyReport,
  DailyReportType,
  Employee,
  ReportQuestion,
  ReportingRequirement,
  ReportingSettings,
} from "@/lib/types";
import { COMPANY_ID } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/admin/sod-eod")({
  head: () => ({
    meta: [{ title: "SOD & EOD Reports - SavyTimes Admin" }],
  }),
  component: AdminSodEodPage,
});

type ReportRowStatus = "submitted" | "missed" | "not_submitted" | "not_required";

type ReportRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  reportType: DailyReportType;
  reportDate: string;
  status: ReportRowStatus;
  report?: DailyReport;
};

const REQUIREMENT_OPTIONS: Array<{ value: ReportingRequirement; label: string }> = [
  { value: "sod_only", label: "SOD only" },
  { value: "eod_only", label: "EOD only" },
  { value: "sod_eod", label: "SOD and EOD" },
  { value: "none", label: "No reporting required" },
];

function AdminSodEodPage() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [questions, setQuestions] = useState<ReportQuestion[] | null>(null);
  const [reports, setReports] = useState<DailyReport[] | null>(null);
  const [settings, setSettings] = useState<ReportingSettings>(DEFAULT_REPORTING_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [newQuestion, setNewQuestion] = useState<Record<DailyReportType, string>>({
    sod: "",
    eod: "",
  });
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedEmployeeForHistory, setSelectedEmployeeForHistory] = useState<Employee | null>(
    null,
  );
  const [selectedReport, setSelectedReport] = useState<DailyReport | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const seededDefaults = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubCompanies = onSnapshot(collection(db(), "companies"), (snapshot) =>
      setCompanies(
        snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
      ),
    );
    const unsubEmployees = onSnapshot(
      collection(db(), "employees"),
      (snapshot) =>
        setEmployees(
          snapshot.docs
            .map((item) => ({ id: item.id, ...(item.data() as Omit<Employee, "id">) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      (error) => {
        console.error("Employees listener error:", error);
        setEmployees([]);
      },
    );
    const unsubQuestions = onSnapshot(
      collection(db(), "reportQuestions"),
      (snapshot) =>
        setQuestions(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<ReportQuestion, "id">),
          })),
        ),
      (error) => {
        console.error("Report questions listener error:", error);
        setQuestions([]);
      },
    );
    const unsubReports = onSnapshot(
      collection(db(), "dailyReports"),
      (snapshot) =>
        setReports(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<DailyReport, "id">),
          })),
        ),
      (error) => {
        console.error("Daily reports listener error:", error);
        setReports([]);
      },
    );
    const unsubSettings = onSnapshot(
      doc(db(), "reportingSettings", "default"),
      (snapshot) => {
        setSettings(
          snapshot.exists()
            ? { ...DEFAULT_REPORTING_SETTINGS, ...(snapshot.data() as ReportingSettings) }
            : DEFAULT_REPORTING_SETTINGS,
        );
        setSettingsLoaded(true);
      },
      (error) => {
        console.error("Reporting settings listener error:", error);
        setSettings(DEFAULT_REPORTING_SETTINGS);
        setSettingsLoaded(true);
      },
    );

    return () => {
      unsubCompanies();
      unsubEmployees();
      unsubQuestions();
      unsubReports();
      unsubSettings();
    };
  }, []);

  useEffect(() => {
    if (questions === null || questions.length > 0 || seededDefaults.current) return;
    seededDefaults.current = true;
    const batch = writeBatch(db());
    const now = new Date().toISOString();
    (["sod", "eod"] as DailyReportType[]).forEach((reportType) => {
      DEFAULT_REPORT_QUESTIONS[reportType].forEach((question, order) => {
        batch.set(doc(db(), "reportQuestions", question.id), {
          reportType,
          question: question.question,
          required: true,
          order,
          createdAt: now,
          updatedAt: now,
        });
      });
    });
    batch.commit().catch((error) => {
      seededDefaults.current = false;
      console.error("Default report questions could not be created:", error);
    });
  }, [questions]);

  async function updateRequirement(employee: Employee, value: ReportingRequirement) {
    try {
      await updateDoc(doc(db(), "employees", employee.id), { reportingRequirement: value });
      toast.success(`${employee.name}: ${reportingRequirementLabel(value)}`);
    } catch (error) {
      toast.error("Could not update reporting requirement: " + (error as Error).message);
    }
  }

  async function saveSettings() {
    if (
      !/^\d{2}:\d{2}$/.test(settings.sodDeadline || "") ||
      !/^\d{2}:\d{2}$/.test(settings.eodDeadline || "")
    ) {
      toast.error("Enter valid SOD and EOD deadlines.");
      return;
    }
    setSavingSettings(true);
    try {
      await setDoc(
        doc(db(), "reportingSettings", "default"),
        { ...settings, updatedAt: new Date().toISOString(), updatedBy: user?.email || "admin" },
        { merge: true },
      );
      toast.success("Reporting deadlines saved");
    } catch (error) {
      toast.error("Could not save settings: " + (error as Error).message);
    } finally {
      setSavingSettings(false);
    }
  }

  function questionsFor(type: DailyReportType) {
    return (questions || [])
      .filter((question) => question.reportType === type)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async function addQuestion(type: DailyReportType) {
    const text = newQuestion[type].trim();
    if (!text) return;
    const list = questionsFor(type);
    const ref = doc(collection(db(), "reportQuestions"));
    const now = new Date().toISOString();
    try {
      await setDoc(ref, {
        reportType: type,
        question: text,
        required: true,
        order: list.length,
        createdAt: now,
        updatedAt: now,
      });
      setNewQuestion((current) => ({ ...current, [type]: "" }));
    } catch (error) {
      toast.error("Could not add question: " + (error as Error).message);
    }
  }

  async function editQuestion(question: ReportQuestion, text: string) {
    const clean = text.trim();
    if (!clean || clean === (question.question || question.text)) return;
    await updateDoc(doc(db(), "reportQuestions", question.id), {
      question: clean,
      updatedAt: new Date().toISOString(),
    }).catch((error) => toast.error("Could not edit question: " + error.message));
  }

  async function toggleQuestionRequired(question: ReportQuestion) {
    await updateDoc(doc(db(), "reportQuestions", question.id), {
      required: !question.required,
      updatedAt: new Date().toISOString(),
    }).catch((error) => toast.error("Could not update question: " + error.message));
  }

  async function deleteQuestion(question: ReportQuestion) {
    const qText = question.question || question.text || "";
    if (!window.confirm(`Delete this question?\n\n${qText}`)) return;
    await deleteDoc(doc(db(), "reportQuestions", question.id)).catch((error) =>
      toast.error("Could not delete question: " + error.message),
    );
  }

  async function moveQuestion(question: ReportQuestion, direction: -1 | 1) {
    if (!question.reportType) return;
    const list = questionsFor(question.reportType);
    const currentIndex = list.findIndex((item) => item.id === question.id);
    const target = list[currentIndex + direction];
    if (!target) return;
    const batch = writeBatch(db());
    batch.update(doc(db(), "reportQuestions", question.id), {
      order: target.order,
      updatedAt: new Date().toISOString(),
    });
    batch.update(doc(db(), "reportQuestions", target.id), {
      order: question.order,
      updatedAt: new Date().toISOString(),
    });
    await batch
      .commit()
      .catch((error) => toast.error("Could not reorder questions: " + error.message));
  }

  const todayStats = useMemo(() => {
    if (!employees || !reports) return { submitted: 0, missed: 0, waiting: 0 };
    let submitted = 0;
    let missed = 0;
    let waiting = 0;
    const today = new Date(clock);

    for (const employee of employees.filter((item) => item.status === "active")) {
      const tz = getEmployeeTimezone(employee);
      const todayKey = zonedDateKey(today, tz);
      const req = employee.reportingRequirement || "none";
      const requiredTypes = requiredReportTypes(req);

      for (const reportType of requiredTypes) {
        const userId = employee.authUid || employee.id;
        const reportId = reportDocumentId(userId, todayKey, reportType);
        const found = reports.some((r) => r.id === reportId);
        if (found) {
          submitted++;
        } else {
          const isMissed = isReportDeadlinePassed(employee, reportType, todayKey, settings, today);
          if (isMissed) {
            missed++;
          } else {
            waiting++;
          }
        }
      }
    }
    return { submitted, missed, waiting };
  }, [employees, reports, clock, settings]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">SOD & EOD settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign reporting requirements, manage questions, and review immutable daily reports.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Submission settings</h2>
            <p className="text-sm text-muted-foreground">
              Deadlines are interpreted in each employee's configured timezone.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:w-[620px]">
            <label className="text-sm font-medium">
              SOD deadline
              <input
                type="time"
                value={settings.sodDeadline}
                disabled={!settingsLoaded}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, sodDeadline: event.target.value }))
                }
                className="mt-1 w-full rounded-lg border bg-background px-3 py-2"
              />
            </label>
            <label className="text-sm font-medium">
              EOD deadline
              <input
                type="time"
                value={settings.eodDeadline}
                disabled={!settingsLoaded}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, eodDeadline: event.target.value }))
                }
                className="mt-1 w-full rounded-lg border bg-background px-3 py-2"
              />
            </label>
            <label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium sm:mt-6">
              <input
                type="checkbox"
                checked={settings.lockAfterDeadline}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    lockAfterDeadline: event.target.checked,
                  }))
                }
              />
              Lock after deadline
            </label>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={savingSettings}
            onClick={saveSettings}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {savingSettings ? "Saving..." : "Save settings"}
          </button>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Report questions</h2>
          <p className="text-sm text-muted-foreground">
            Editing questions affects future forms only. Historical reports keep their original
            wording.
          </p>
        </div>
        <div className="grid gap-5 xl:grid-cols-2">
          {(["sod", "eod"] as DailyReportType[]).map((type) => (
            <QuestionEditor
              key={type}
              type={type}
              questions={questionsFor(type)}
              loading={questions === null}
              newQuestion={newQuestion[type]}
              onNewQuestionChange={(value) =>
                setNewQuestion((current) => ({ ...current, [type]: value }))
              }
              onAdd={() => addQuestion(type)}
              onEdit={editQuestion}
              onToggleRequired={toggleQuestionRequired}
              onDelete={deleteQuestion}
              onMove={moveQuestion}
            />
          ))}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b pb-4">
          <div>
            <h2 className="text-lg font-semibold">Employee Daily Reports & Requirements</h2>
            <p className="text-sm text-muted-foreground">
              Monitor today's SOD/EOD submissions and configure requirements per employee.
            </p>
          </div>
          <div className="w-full sm:w-auto flex items-center gap-2">
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              className="rounded-lg border bg-background px-3 py-2 text-sm font-semibold"
            >
              <option value="all">All companies ({companies.length})</option>
              {companies.map((c) => (
                <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                  {c.name} {c.isMain ? "(Main)" : ""}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search employee..."
              value={employeeSearch}
              onChange={(e) => setEmployeeSearch(e.target.value)}
              className="w-full sm:w-64 rounded-lg border bg-background px-3 py-2 text-sm font-semibold"
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-sm bg-secondary/20 p-2.5 rounded-lg">
          <Summary label="Submitted Today" value={todayStats.submitted} />
          <Summary label="Missed Today" value={todayStats.missed} />
          <Summary label="Awaiting Today" value={todayStats.waiting} />
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Today's SOD</th>
                <th className="px-4 py-3">Today's EOD</th>
                <th className="px-4 py-3">Reporting Requirement</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {employees === null || reports === null ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    Loading employees and reports...
                  </td>
                </tr>
              ) : (
                (() => {
                  const filteredEmployees = employees.filter((emp) => {
                    if (emp.status !== "active") return false;
                    if (companyFilter !== "all") {
                      const matchComp =
                        emp.companyId === companyFilter ||
                        emp.companyIds?.includes(companyFilter) ||
                        (!emp.companyId && companyFilter === COMPANY_ID);
                      if (!matchComp) return false;
                    }
                    if (employeeSearch) {
                      const query = employeeSearch.toLowerCase().trim();
                      return (
                        emp.name.toLowerCase().includes(query) ||
                        emp.email.toLowerCase().includes(query)
                      );
                    }
                    return true;
                  });

                  if (filteredEmployees.length === 0) {
                    return (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                          No employees found matching the search.
                        </td>
                      </tr>
                    );
                  }

                  return filteredEmployees.map((employee) => {
                    const getTodayReportStatus = (emp: Employee, type: "sod" | "eod") => {
                      const req = emp.reportingRequirement || "none";
                      const isRequired =
                        req === "sod_eod" ||
                        (type === "sod" && req === "sod_only") ||
                        (type === "eod" && req === "eod_only");

                      if (!isRequired) return "not_required";

                      const tz = getEmployeeTimezone(emp);
                      const todayKey = zonedDateKey(new Date(clock), tz);
                      const reportId = reportDocumentId(emp.authUid || emp.id, todayKey, type);
                      const found = reports.some((r) => r.id === reportId);

                      if (found) return "submitted";

                      const missed = isReportDeadlinePassed(
                        emp,
                        type,
                        todayKey,
                        settings,
                        new Date(clock),
                      );
                      return missed ? "missed" : "not_submitted";
                    };

                    const sodStatus = getTodayReportStatus(employee, "sod");
                    const eodStatus = getTodayReportStatus(employee, "eod");

                    return (
                      <tr key={employee.id} className="hover:bg-secondary/25">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => setSelectedEmployeeForHistory(employee)}
                            className="font-bold text-primary hover:underline text-left block"
                          >
                            {employee.name}
                          </button>
                          <div className="text-xs text-muted-foreground">{employee.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          <ReportStatusBadge status={sodStatus} />
                        </td>
                        <td className="px-4 py-3">
                          <ReportStatusBadge status={eodStatus} />
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={employee.reportingRequirement || "none"}
                            onChange={(event) =>
                              updateRequirement(
                                employee,
                                event.target.value as ReportingRequirement,
                              )
                            }
                            className="rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold"
                          >
                            {REQUIREMENT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedEmployeeForHistory(employee)}
                            className="inline-flex items-center gap-1 rounded-lg border bg-secondary/80 hover:bg-secondary px-3 py-1.5 text-xs font-bold"
                          >
                            <Eye className="h-3.5 w-3.5" /> View History
                          </button>
                        </td>
                      </tr>
                    );
                  });
                })()
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedEmployeeForHistory && (
        <ReportHistoryModal
          employee={selectedEmployeeForHistory}
          reports={reports || []}
          onViewReport={(report) => setSelectedReport(report)}
          onClose={() => setSelectedEmployeeForHistory(null)}
        />
      )}

      {selectedReport && (
        <ReportModal report={selectedReport} onClose={() => setSelectedReport(null)} />
      )}
    </div>
  );
}

function QuestionEditor(props: {
  type: DailyReportType;
  questions: ReportQuestion[];
  loading: boolean;
  newQuestion: string;
  onNewQuestionChange: (value: string) => void;
  onAdd: () => void;
  onEdit: (question: ReportQuestion, text: string) => void;
  onToggleRequired: (question: ReportQuestion) => void;
  onDelete: (question: ReportQuestion) => void;
  onMove: (question: ReportQuestion, direction: -1 | 1) => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <h3 className="font-semibold">{reportTypeLabel(props.type)} questions</h3>
      <div className="mt-4 space-y-3">
        {props.loading ? (
          <p className="text-sm text-muted-foreground">Loading questions...</p>
        ) : props.questions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No questions yet.</p>
        ) : (
          props.questions.map((question, index) => (
            <div key={question.id} className="rounded-lg border p-3">
              <textarea
                defaultValue={question.question || question.text || ""}
                onBlur={(event) => props.onEdit(question, event.target.value)}
                className="min-h-16 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={question.required}
                    onChange={() => props.onToggleRequired(question)}
                  />
                  Required
                </label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => props.onMove(question, -1)}
                    className="rounded-md border p-1.5 disabled:opacity-30"
                    title="Move up"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={index === props.questions.length - 1}
                    onClick={() => props.onMove(question, 1)}
                    className="rounded-md border p-1.5 disabled:opacity-30"
                    title="Move down"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onDelete(question)}
                    className="rounded-md border p-1.5"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <input
          value={props.newQuestion}
          onChange={(event) => props.onNewQuestionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onAdd();
            }
          }}
          placeholder="Add a question"
          className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={props.onAdd}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border px-3 py-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ReportStatusBadge({ status }: { status: ReportRowStatus }) {
  const label =
    status === "submitted" ? "Submitted" : status === "missed" ? "Missed" : "Not submitted";
  const className =
    status === "submitted"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "missed"
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

function ReportModal({ report, onClose }: { report: DailyReport; onClose: () => void }) {
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
              {report.userName} - {report.reportDate}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border p-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="mt-5 grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Email</dt>
            <dd className="font-medium">{report.userEmail}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Submitted</dt>
            <dd className="font-medium">{formatTimestamp(report.submittedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Timezone</dt>
            <dd className="font-medium">{report.timezone}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Timing</dt>
            <dd className="font-medium">{report.submittedLate ? "Submitted late" : "On time"}</dd>
          </div>
        </dl>
        <div className="mt-5 space-y-4">
          {report.answers.map((answer, index) => (
            <div key={`${answer.questionId}-${index}`} className="rounded-lg border p-4">
              <div className="text-sm font-semibold">{answer.question}</div>
              <FormattedAnswerText
                text={answer.answer}
                mentions={answer.mentions}
                className="mt-2 text-sm text-muted-foreground"
              />
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

function formatTimestamp(value: DailyReport["submittedAt"]) {
  if (!value?.toDate) return "Processing...";
  return value.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function ReportHistoryModal({
  employee,
  reports,
  onViewReport,
  onClose,
}: {
  employee: Employee;
  reports: DailyReport[];
  onViewReport: (report: DailyReport) => void;
  onClose: () => void;
}) {
  const empReports = useMemo(() => {
    const userId = employee.authUid || employee.id;
    return reports
      .filter((r) => r.userId === userId || r.employeeId === employee.id)
      .sort(
        (a, b) =>
          b.reportDate.localeCompare(a.reportDate) || a.reportType.localeCompare(b.reportType),
      );
  }, [employee, reports]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-3xl rounded-xl bg-card p-6 shadow-2xl space-y-4">
        <div className="flex items-start justify-between border-b pb-3">
          <div>
            <h3 className="text-lg font-bold text-foreground">Report History: {employee.name}</h3>
            <p className="text-xs text-muted-foreground">{employee.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border p-1.5 hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary text-xs uppercase font-semibold text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Timing</th>
                <th className="px-4 py-2.5">Submitted At</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y text-xs">
              {empReports.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No reports submitted yet.
                  </td>
                </tr>
              ) : (
                empReports.map((report) => (
                  <tr key={report.id} className="hover:bg-secondary/35">
                    <td className="px-4 py-3 font-semibold">{report.reportDate}</td>
                    <td className="px-4 py-3 font-extrabold capitalize">
                      {reportTypeLabel(report.reportType)}
                    </td>
                    <td className="px-4 py-3">
                      {report.submittedLate ? (
                        <span className="text-rose-600 font-semibold">Late</span>
                      ) : (
                        <span className="text-emerald-600 font-semibold">On time</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatTimestamp(report.submittedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onViewReport(report)}
                        className="inline-flex items-center gap-1 rounded-md border bg-primary/5 px-2 py-1 font-bold text-primary hover:bg-primary/10"
                      >
                        <Eye className="h-3 w-3" /> View Answers
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end pt-2 border-t">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border bg-secondary px-4 py-2 text-xs font-bold text-foreground hover:bg-muted"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
