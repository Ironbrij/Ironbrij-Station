import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { Copy, HelpCircle, KeyRound, MessageSquare, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MentionTextarea } from "@/components/MentionTextarea";
import { FormattedAnswerText } from "@/components/FormattedAnswerText";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { sendMentionNotification, type MentionRecipient } from "@/lib/mention-notifications";
import { companyEmailBranding } from "@/lib/email-branding";
import {
  getUserCompanyIds,
  isDepartmentInCompany,
  isEmployeeInCompany,
  resolveMentionRecipients,
  sanitizeFirestoreObject,
} from "@/lib/mentions";
import type { PersonalAutomationProfile } from "@/lib/personal-automation";
import type { Department, Employee, MentionItem, Punch } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/app/automation")({
  head: () => ({
    meta: [
      { title: "Help & Feedback — SavyTimes" },
      {
        name: "description",
        content:
          "Get support, send team feedback with @mentions, and manage personal automation API.",
      },
    ],
  }),
  component: HelpFeedbackAutomationPage,
});

function generatePrivateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isItDepartmentName(name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = new Set(normalized.split(" "));

  return (
    normalized === "it" ||
    normalized.startsWith("it ") ||
    normalized.includes("information technology") ||
    normalized.includes("technical support") ||
    (words.has("it") && words.has("tech"))
  );
}

function HelpFeedbackAutomationPage() {
  const { user, employee, company } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [adminContacts, setAdminContacts] = useState<
    Array<{ id: string; email?: string; name: string }>
  >([]);

  // Form State: Help & Support
  const [helpSubject, setHelpSubject] = useState("");
  const [helpMessage, setHelpMessage] = useState("");
  const [helpMentions, setHelpMentions] = useState<MentionItem[]>([]);
  const [submittingHelp, setSubmittingHelp] = useState(false);

  // Form State: Feedback
  const [feedbackCategory, setFeedbackCategory] = useState("General Feedback");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackMentions, setFeedbackMentions] = useState<MentionItem[]>([]);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  // Personal Automation State
  const [profile, setProfile] = useState<PersonalAutomationProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [busyApi, setBusyApi] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => setOrigin(window.location.origin), []);

  // Subscribe to employees & departments for mention resolution
  useEffect(() => {
    const unsubEmp = onSnapshot(collection(db(), "employees"), (snapshot) => {
      setEmployees(
        snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Employee, "id">) })),
      );
    });
    const unsubDept = onSnapshot(collection(db(), "departments"), (snapshot) => {
      setDepartments(
        snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Department, "id">) })),
      );
    });
    const unsubAdmins = onSnapshot(collection(db(), "admins"), (snapshot) => {
      setAdminContacts(
        snapshot.docs.map((item) => {
          const data = item.data() as { email?: string; name?: string };
          return {
            id: item.id,
            email: data.email?.trim().toLowerCase(),
            name: data.name?.trim() || "Support Admin",
          };
        }),
      );
    });
    return () => {
      unsubEmp();
      unsubDept();
      unsubAdmins();
    };
  }, []);

  // Subscribe to personal automation API profile
  useEffect(() => {
    if (!user) {
      setProfile(null);
      setLoadingProfile(false);
      return;
    }

    const profileQuery = query(
      collection(db(), "automationProfiles"),
      where("ownerUid", "==", user.uid),
    );
    return onSnapshot(
      profileQuery,
      (snapshot) => {
        const current = snapshot.docs[0];
        if (current) {
          const profileData = {
            id: current.id,
            ...(current.data() as Omit<PersonalAutomationProfile, "id">),
          };
          setProfile(profileData);
        } else {
          setProfile(null);
        }
        setLoadingProfile(false);
      },
      (error) => {
        console.warn("Personal API profile query warning:", error);
        setLoadingProfile(false);
      },
    );
  }, [user]);

  const personalUrl = useMemo(
    () =>
      profile && origin
        ? `${origin}/api/automation-status?token=${encodeURIComponent(profile.id)}`
        : "",
    [origin, profile],
  );

  // Helper to trigger email notifications using the n8n webhook API
  async function triggerMentionEmails(
    title: string,
    messageText: string,
    mentionsList: MentionItem[],
  ) {
    if (!user || !employee) return;

    // 1. Resolve @mentions recipients if any exist
    const mentionRecipients = resolveMentionRecipients(mentionsList, employees, employee.email);

    // 2. Silently route every Help/Feedback submission to the user's company IT team.
    // This only changes email recipients; it does not add a visible @IT tag to the message.
    const userCompanyIds = getUserCompanyIds(employee);
    const itDepartments = departments.filter(
      (department) =>
        isDepartmentInCompany(department, userCompanyIds) && isItDepartmentName(department.name),
    );
    const itDepartmentIds = new Set(itDepartments.map((department) => department.id));
    const itDepartmentNames = new Map(
      itDepartments.map((department) => [department.id, department.name]),
    );
    const senderEmail = employee.email.trim().toLowerCase();
    const itRecipients: MentionRecipient[] = employees.flatMap((candidate) => {
      const email = candidate.email?.trim().toLowerCase();
      if (
        candidate.status === "inactive" ||
        !candidate.deptId ||
        !itDepartmentIds.has(candidate.deptId) ||
        !isEmployeeInCompany(candidate, userCompanyIds) ||
        !email ||
        email === senderEmail
      ) {
        return [];
      }

      return [
        {
          email,
          name: candidate.name,
          targetName: itDepartmentNames.get(candidate.deptId) || "IT Department",
          targetType: "department" as const,
        },
      ];
    });

    // 3. Always notify every admin as well as the hidden IT team recipients.
    const adminRecipients: MentionRecipient[] = [];
    const adminEmails = new Set<string>();

    adminContacts.forEach((admin) => {
      const adminEmployee = employees.find(
        (candidate) =>
          candidate.id === admin.id ||
          candidate.authUid === admin.id ||
          Boolean(admin.email && candidate.email?.trim().toLowerCase() === admin.email),
      );
      const adminEmail = admin.email || adminEmployee?.email?.trim().toLowerCase();
      if (!adminEmail || adminEmails.has(adminEmail)) return;

      adminEmails.add(adminEmail);
      adminRecipients.push({
        email: adminEmail,
        name: adminEmployee?.name || admin.name,
        targetName: "Administrators",
        targetType: "person",
      });
    });

    const defaultAdmins = [
      "pabibek9@gmail.com",
      "bibekparajuli05@gmail.com",
      "louis@ironbrij.com.au",
    ];
    for (const adminEmail of defaultAdmins) {
      if (!adminEmails.has(adminEmail)) {
        adminEmails.add(adminEmail);
        adminRecipients.push({
          email: adminEmail,
          name: "Support Admin",
          targetName: "Administrators",
          targetType: "person",
        });
      }
    }

    // Combine hidden IT routing, every admin, and any manual mentions without duplicates.
    const allRecipientsMap = new Map<string, MentionRecipient>();
    [...itRecipients, ...mentionRecipients, ...adminRecipients].forEach((rec) => {
      if (!allRecipientsMap.has(rec.email.toLowerCase())) {
        allRecipientsMap.set(rec.email.toLowerCase(), rec);
      }
    });

    const finalRecipients = Array.from(allRecipientsMap.values());
    if (finalRecipients.length === 0) return;

    await sendMentionNotification(user, {
      company: companyEmailBranding(company, employee.companyId),
      reportId: `help_feedback_${Date.now()}`,
      reportType: "sod",
      reportDate: new Date().toLocaleDateString(),
      authorName: employee.name,
      authorEmail: employee.email,
      authorDeptName: departments.find((d) => d.id === employee.deptId)?.name,
      answers: [
        {
          questionId: "feedback_question",
          question: title,
          answer: messageText,
          mentions: mentionsList,
        },
      ],
      recipients: finalRecipients,
    });
  }

  // Handle Help Request Submission
  async function submitHelp(e: React.FormEvent) {
    e.preventDefault();
    if (!helpSubject.trim() || !helpMessage.trim() || !user || !employee) return;

    setSubmittingHelp(true);
    try {
      await addDoc(
        collection(db(), "helpRequests"),
        sanitizeFirestoreObject({
          userId: user.uid,
          employeeId: employee.id,
          employeeName: employee.name || "",
          employeeEmail: employee.email || "",
          subject: helpSubject.trim(),
          message: helpMessage.trim(),
          ...(helpMentions.length > 0 ? { mentions: helpMentions } : {}),
          createdAt: new Date().toISOString(),
          status: "open",
        }),
      );

      let notificationFailed = false;
      try {
        await triggerMentionEmails(
          `Help Request: ${helpSubject.trim()}`,
          helpMessage.trim(),
          helpMentions,
        );
      } catch (notificationError) {
        notificationFailed = true;
        console.error("Help request notification error:", notificationError);
      }

      setHelpSubject("");
      setHelpMessage("");
      setHelpMentions([]);
      if (notificationFailed) {
        toast.warning("Help request saved, but its email notification could not be sent.");
      } else {
        toast.success("Help request submitted and emailed successfully.");
      }
    } catch (err) {
      toast.error("Could not submit help request: " + (err as Error).message);
    } finally {
      setSubmittingHelp(false);
    }
  }

  // Handle Feedback Submission
  async function submitFeedback(e: React.FormEvent) {
    e.preventDefault();
    if (!feedbackMessage.trim() || !user || !employee) return;

    setSubmittingFeedback(true);
    try {
      await addDoc(
        collection(db(), "feedback"),
        sanitizeFirestoreObject({
          userId: user.uid,
          employeeId: employee.id,
          employeeName: employee.name || "",
          employeeEmail: employee.email || "",
          category: feedbackCategory,
          message: feedbackMessage.trim(),
          ...(feedbackMentions.length > 0 ? { mentions: feedbackMentions } : {}),
          createdAt: new Date().toISOString(),
        }),
      );

      let notificationFailed = false;
      try {
        await triggerMentionEmails(
          `Feedback (${feedbackCategory})`,
          feedbackMessage.trim(),
          feedbackMentions,
        );
      } catch (notificationError) {
        notificationFailed = true;
        console.error("Feedback notification error:", notificationError);
      }

      setFeedbackMessage("");
      setFeedbackMentions([]);
      if (notificationFailed) {
        toast.warning("Feedback saved, but its email notification could not be sent.");
      } else {
        toast.success("Feedback submitted and emailed successfully.");
      }
    } catch (err) {
      toast.error("Could not submit feedback: " + (err as Error).message);
    } finally {
      setSubmittingFeedback(false);
    }
  }

  // Personal Automation Actions
  async function createPersonalApi(replaceExisting = false) {
    if (!user || !employee) return;
    if (
      replaceExisting &&
      !window.confirm("Regenerate this URL? The current URL will stop working immediately.")
    ) {
      return;
    }

    setBusyApi(true);
    try {
      let punches: Punch[] = [];
      try {
        const punchesSnapshot = await getDocs(
          query(collection(db(), "punches"), where("employeeId", "==", employee.id)),
        );
        punches = punchesSnapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) }))
          .sort((a, b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0));
      } catch (err) {
        console.warn("Could not fetch punches for personal API:", err);
      }

      const latestPunch = punches[punches.length - 1];
      const isPunchedIn = latestPunch?.type === "in" || latestPunch?.type === "extra_in";
      const now = new Date().toISOString();
      const token = generatePrivateToken();
      const batch = writeBatch(db());

      if (profile?.id) {
        try {
          batch.delete(doc(db(), "automationProfiles", profile.id));
        } catch {
          // Ignore delete error if non-existent
        }
      } else {
        try {
          const existingProfiles = await getDocs(
            query(collection(db(), "automationProfiles"), where("ownerUid", "==", user.uid)),
          );
          existingProfiles.docs.forEach((existing) => batch.delete(existing.ref));
        } catch {
          // Ignore list permission errors
        }
      }

      const newProfileData: Omit<PersonalAutomationProfile, "id"> = {
        ownerUid: user.uid,
        employeeId: employee.id,
        employeeName: employee.name,
        enabled: true,
        status: isPunchedIn ? "punched_in" : "punched_out",
        isPunchedIn,
        event: "snapshot",
        eventId: latestPunch ? `snapshot:${latestPunch.id}` : `snapshot:${token.slice(0, 16)}`,
        punchId: latestPunch?.id || "",
        punchType: latestPunch?.type || "",
        date: latestPunch?.date || "",
        occurredAt: latestPunch?.timestamp?.toDate().toISOString() || now,
        createdAt: now,
        updatedAt: now,
      };

      batch.set(doc(db(), "automationProfiles", token), newProfileData);
      await batch.commit();

      setProfile({ id: token, ...newProfileData });
      toast.success(replaceExisting ? "Personal API URL regenerated" : "Personal API URL created");
    } catch (error) {
      console.error("Error creating personal API:", error);
      toast.error("Could not create personal API: " + (error as Error).message);
    } finally {
      setBusyApi(false);
    }
  }

  async function copyUrl() {
    if (!personalUrl) return;
    await navigator.clipboard.writeText(personalUrl);
    toast.success("Personal API URL copied");
  }

  async function revokeUrl() {
    if (!profile || !window.confirm("Revoke this URL? Any workflow using it will stop working.")) {
      return;
    }

    setBusyApi(true);
    try {
      const batch = writeBatch(db());
      batch.delete(doc(db(), "automationProfiles", profile.id));
      await batch.commit();
      toast.success("Personal API URL revoked");
    } catch (error) {
      toast.error("Could not revoke personal API: " + (error as Error).message);
    } finally {
      setBusyApi(false);
    }
  }

  if (!employee) {
    return (
      <div className="py-12 text-center text-sm">Your employee profile is not active yet.</div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-12">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Help & Feedback</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Submit support questions, share team feedback with @mentions, or access your automation
          API.
        </p>
      </div>

      {/* Section 1: Help & Support Form */}
      <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-4 shadow-xs">
        <div className="flex items-center gap-2 text-primary font-bold">
          <HelpCircle className="h-5 w-5" />
          <h2 className="text-lg">Get Help & Support</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Need assistance or have a question? Submit your query below. Type <strong>@Name</strong>{" "}
          or <strong>@Department</strong> to notify specific team members.
        </p>

        <form onSubmit={submitHelp} className="space-y-4">
          <label className="block text-xs font-bold text-muted-foreground">
            Subject *
            <input
              required
              placeholder="What do you need help with?"
              value={helpSubject}
              onChange={(e) => setHelpSubject(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          <label className="block text-xs font-bold text-muted-foreground">
            Details / Message *
            <MentionTextarea
              value={helpMessage}
              onChange={(val, mList) => {
                setHelpMessage(val);
                setHelpMentions(mList);
              }}
              currentEmployee={employee}
              rows={4}
              placeholder="Describe your question or issue in detail... Type @ to mention colleagues or departments."
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          {helpMessage.trim() && (
            <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
              <span className="text-[11px] font-bold text-muted-foreground uppercase">Preview</span>
              <FormattedAnswerText text={helpMessage} mentions={helpMentions} />
            </div>
          )}

          <button
            type="submit"
            disabled={submittingHelp}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {submittingHelp ? "Submitting..." : "Submit Help Request"}
          </button>
        </form>
      </section>

      {/* Section 2: Send Feedback Form */}
      <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-4 shadow-xs">
        <div className="flex items-center gap-2 text-primary font-bold">
          <MessageSquare className="h-5 w-5" />
          <h2 className="text-lg">Send Feedback</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Share your ideas, bug reports, or team feedback. Tag colleagues using{" "}
          <strong>@Name</strong> or <strong>@Department</strong> to include them in email
          notifications.
        </p>

        <form onSubmit={submitFeedback} className="space-y-4">
          <label className="block text-xs font-bold text-muted-foreground">
            Feedback Category
            <select
              value={feedbackCategory}
              onChange={(e) => setFeedbackCategory(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground font-semibold"
            >
              <option value="General Feedback">General Feedback</option>
              <option value="Feature Request">Feature Request</option>
              <option value="Bug Report">Bug Report</option>
              <option value="Team Improvement">Team Improvement</option>
            </select>
          </label>

          <label className="block text-xs font-bold text-muted-foreground">
            Feedback Message *
            <MentionTextarea
              value={feedbackMessage}
              onChange={(val, mList) => {
                setFeedbackMessage(val);
                setFeedbackMentions(mList);
              }}
              currentEmployee={employee}
              rows={4}
              placeholder="Write your feedback here... Type @ to tag people or departments."
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          {feedbackMessage.trim() && (
            <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
              <span className="text-[11px] font-bold text-muted-foreground uppercase">Preview</span>
              <FormattedAnswerText text={feedbackMessage} mentions={feedbackMentions} />
            </div>
          )}

          <button
            type="submit"
            disabled={submittingFeedback}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {submittingFeedback ? "Submitting..." : "Send Feedback"}
          </button>
        </form>
      </section>

      {/* Section 3: Personal Automation API at the Last */}
      <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-5 shadow-xs pt-6 border-t-2">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" /> Personal Automation API
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Create a private URL that reports your latest attendance punch status to n8n or personal
            workflows.
          </p>
        </div>

        {loadingProfile ? (
          <p className="text-sm text-muted-foreground">Loading personal API profile...</p>
        ) : profile ? (
          <div className="space-y-4">
            <div className="rounded-lg border px-4 py-3 bg-muted/20">
              <div className="text-xs font-bold text-muted-foreground">Current API Status</div>
              <div className="mt-1 font-semibold text-sm">
                {profile.isPunchedIn ? "Punched in" : "Punched out"}
              </div>
            </div>

            <input
              readOnly
              aria-label="Personal automation API URL"
              value={personalUrl}
              className="w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-xs text-foreground focus:outline-none"
              onFocus={(event) => event.currentTarget.select()}
            />

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
              >
                <Copy className="h-3.5 w-3.5" /> Copy URL
              </button>
              <button
                type="button"
                disabled={busyApi}
                onClick={() => createPersonalApi(true)}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-xs font-bold disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Regenerate
              </button>
              <button
                type="button"
                disabled={busyApi}
                onClick={revokeUrl}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-xs font-bold text-rose-600 border-rose-200 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Revoke
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busyApi}
            onClick={() => createPersonalApi(false)}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
          >
            {busyApi ? "Creating…" : "Create Personal API URL"}
          </button>
        )}

        <div className="rounded-lg border bg-muted/30 p-4 text-xs space-y-2">
          <h3 className="font-bold text-foreground">How to use in n8n</h3>
          <ol className="list-decimal space-y-1 pl-4 text-muted-foreground leading-relaxed">
            <li>Add a Schedule Trigger (e.g. once every 1 minute).</li>
            <li>Add an HTTP Request node using GET and paste your private API URL.</li>
            <li>
              Filter execution based on <code>attendance.eventId</code> to detect when{" "}
              <code>attendance.event</code> changes to <code>punch_in</code> or{" "}
              <code>punch_out</code>.
            </li>
          </ol>
        </div>
      </section>
    </div>
  );
}
