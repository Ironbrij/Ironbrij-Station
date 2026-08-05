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
import { DEFAULT_LOCAL_TIMEZONE, zonedDateKey } from "@/lib/attendance";
import type {
  DailyReport,
  DailyReportType,
  Employee,
  ReportQuestion,
  ReportingRequirement,
  ReportingSettings,
} from "@/lib/types";

export const Route = createFileRoute("/_authenticated/admin/sod-eod")({
  head: () => ({
    meta: [{ title: "SOD & EOD Reports - Time Station Admin" }],
  }),
  component: AdminSodEodPage,
});

type ReportRowStatus = "submitted" | "missed" | "not_submitted";

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
  const [questions, setQuestions] = useState<ReportQuestion[] | null>(null);
  const [reports, setReports] = useState<DailyReport[] | null>(null);
  const [settings, setSettings] = useState<ReportingSettings>(DEFAULT_REPORTING_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [newQuestion, setNewQuestion] = useState<Record<DailyReportType, string>>({
    sod: "",
    eod: "",
  });
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | DailyReportType>("all");
  const [dateFilter, setDateFilter] = useState(() =>
    zonedDateKey(new Date(), DEFAULT_LOCAL_TIMEZONE),
  );
  const [selectedReport, setSelectedReport] = useState<DailyReport | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const seededDefaults = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubEmployees = onSnapshot(collection(db(), "employees"), (snapshot) =>
      setEmployees(
        snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Employee, "id">) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    );
    const unsubQuestions = onSnapshot(collection(db(), "reportQuestions"), (snapshot) =>
      setQuestions(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<ReportQuestion, "id">),
        })),
      ),
    );
    const unsubReports = onSnapshot(collection(db(), "dailyReports"), (snapshot) =>
      setReports(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<DailyReport, "id">),
        })),
      ),
    );
    const unsubSettings = onSnapshot(doc(db(), "reportingSettings", "default"), (snapshot) => {
      setSettings(
        snapshot.exists()
          ? { ...DEFAULT_REPORTING_SETTINGS, ...(snapshot.data() as ReportingSettings) }
          : DEFAULT_REPORTING_SETTINGS,
      );
      setSettingsLoaded(true);
    });

    return () => {
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
      !/^\d{2}:\d{2}$/.test(settings.sodDeadline) ||
      !/^\d{2}:\d{2}$/.test(settings.eodDeadline)
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
      .sort((a, b) => a.order - b.order);
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
    if (!clean || clean === question.question) return;
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
    if (!window.confirm(`Delete this question?\n\n${question.question}`)) return;
    await deleteDoc(doc(db(), "reportQuestions", question.id)).catch((error) =>
      toast.error("Could not delete question: " + error.message),
    );
  }

  async function moveQuestion(question: ReportQuestion, direction: -1 | 1) {
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

  const reportRows = useMemo(() => {
    if (!employees || !reports) return [];
    const reportMap = new Map(reports.map((report) => [report.id, report]));
    const rows: ReportRow[] = [];
    const now = new Date(clock);

    for (const report of reports) {
      if (dateFilter && report.reportDate !== dateFilter) continue;
      rows.push({
        id: report.id,
        userId: report.userId,
        userName: report.userName,
        userEmail: report.userEmail,
        reportType: report.reportType,
        reportDate: report.reportDate,
        status: "submitted",
        report,
      });
    }

    if (dateFilter) {
      for (const employee of employees) {
        const userId = employee.authUid || employee.id;
        for (const reportType of requiredReportTypes(employee.reportingRequirement)) {
          const id = reportDocumentId(userId, dateFilter, reportType);
          if (reportMap.has(id)) continue;
          const missed = isReportDeadlinePassed(employee, reportType, dateFilter, settings, now);
          rows.push({
            id,
            userId,
            userName: employee.name,
            userEmail: employee.email,
            reportType,
            reportDate: dateFilter,
            status: missed ? "missed" : "not_submitted",
          });
        }
      }
    }

    return rows
      .filter((row) => employeeFilter === "all" || row.userId === employeeFilter)
      .filter((row) => typeFilter === "all" || row.reportType === typeFilter)
      .sort(
        (a, b) =>
          b.reportDate.localeCompare(a.reportDate) ||
          a.userName.localeCompare(b.userName) ||
          a.reportType.localeCompare(b.reportType),
      );
  }, [clock, dateFilter, employeeFilter, employees, reports, settings, typeFilter]);

  const submittedCount = reportRows.filter((row) => row.status === "submitted").length;
  const missedCount = reportRows.filter((row) => row.status === "missed").length;
  const waitingCount = reportRows.filter((row) => row.status === "not_submitted").length;

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

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold">User requirements</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Choose which reports each employee must complete.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Requirement</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {employees === null ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    Loading employees...
                  </td>
                </tr>
              ) : employees.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    No employees found.
                  </td>
                </tr>
              ) : (
                employees.map((employee) => (
                  <tr key={employee.id}>
                    <td className="px-4 py-3 font-medium">{employee.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{employee.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={employee.reportingRequirement || "none"}
                        onChange={(event) =>
                          updateRequirement(employee, event.target.value as ReportingRequirement)
                        }
                        className="w-full max-w-xs rounded-lg border bg-background px-3 py-2"
                      >
                        {REQUIREMENT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Submitted and required reports</h2>
            <p className="text-sm text-muted-foreground">Reports are read-only after submission.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <select
              value={employeeFilter}
              onChange={(event) => setEmployeeFilter(event.target.value)}
              className="rounded-lg border bg-background px-3 py-2 text-sm"
            >
              <option value="all">All users</option>
              {(employees || []).map((employee) => (
                <option key={employee.id} value={employee.authUid || employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as "all" | DailyReportType)}
              className="rounded-lg border bg-background px-3 py-2 text-sm"
            >
              <option value="all">All report types</option>
              <option value="sod">SOD</option>
              <option value="eod">EOD</option>
            </select>
            <input
              type="date"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
              className="rounded-lg border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="my-4 grid grid-cols-3 gap-2 text-center text-sm">
          <Summary label="Submitted" value={submittedCount} />
          <Summary label="Missed" value={missedCount} />
          <Summary label="Awaiting" value={waitingCount} />
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {reports === null || employees === null ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading reports...
                  </td>
                </tr>
              ) : reportRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No reports match these filters.
                  </td>
                </tr>
              ) : (
                reportRows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3">{row.reportDate}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.userName}</div>
                      <div className="text-xs text-muted-foreground">{row.userEmail}</div>
                    </td>
                    <td className="px-4 py-3">{reportTypeLabel(row.reportType)}</td>
                    <td className="px-4 py-3">
                      <ReportStatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.report ? formatTimestamp(row.report.submittedAt) : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.report ? (
                        <button
                          type="button"
                          onClick={() => setSelectedReport(row.report!)}
                          className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 font-medium"
                        >
                          <Eye className="h-4 w-4" /> View
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">No submission</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

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
                defaultValue={question.question}
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

function formatTimestamp(value: DailyReport["submittedAt"]) {
  if (!value?.toDate) return "Processing...";
  return value.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
