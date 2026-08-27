import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";
import {
  Key,
  Copy,
  Check,
  Bot,
  Sparkles,
  Shield,
  Trash2,
  ExternalLink,
  Code,
  Terminal,
  Play,
  RotateCcw,
  Zap,
  Lock,
  MessageSquare,
  Users,
  CheckCircle2,
  Calendar,
  Clock,
  FileText,
  HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

interface AdminApiToken {
  id: string;
  token: string;
  adminEmail: string;
  label?: string;
  active: boolean;
  createdAt: string;
}

export const Route = createFileRoute("/_authenticated/admin/mcp-connect")({
  head: () => ({ meta: [{ title: "AI & MCP Integration — SavyTimes Admin" }] }),
  component: McpConnectPage,
});

function generateSecureToken(): string {
  const chars = "abcdef0123456789";
  let token = "st_adm_";
  for (let i = 0; i < 48; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

const GPT_SYSTEM_INSTRUCTIONS = `You are the executive AI Admin Assistant for SavyTimes (https://station.savykids.com).
You have full real-time access via MCP / Actions to manage companies, departments, attendance, employees, punches, leaves, overtime approvals, SOD/EOD daily reports, and notices.

### 🏢 COMPANY & CLIENT MANAGEMENT
You can create and fully configure client companies using the \`create_company\` and \`update_company\` tools:
- **Parameters supported**:
  - \`name\`: Full company name (e.g. "Ironbrij", "SavyKids")
  - \`code\`: 3-4 letter uppercase identifier (e.g. "IRON", "SAVY")
  - \`timezone\`: Primary timezone (e.g. "Australia/Sydney", "Asia/Kathmandu", "Asia/Manila")
  - \`defaultShiftHours\`: Daily shift hours (default: 8)
  - \`workingDays\`: Days of the week (e.g. [1, 2, 3, 4, 5] for Mon-Fri; 0=Sun..6=Sat)
  - \`breakAllowanceMinutes\`: Break duration in minutes (e.g. 30, or 0 for N/A)
  - \`maxDailyBreaks\`: Allowed breaks per shift (e.g. 1, or 0 for N/A)
  - \`lateGraceMinutes\`: Allowed late grace before marking late (default: 5)
  - \`punchOutGraceMinutes\`: Grace minutes after shift end before auto punch-out (default: 30)
  - \`punchOutReminderMinutes\`: Minutes before shift end to send reminder email (default: 20)
  - \`departments\`: List of initial department names to automatically create under the company (e.g. ["Operations", "Accounts", "Engineering"])
  - \`clientEmail\`, \`ownerName\`, \`logoUrl\`, \`notes\`

### 👥 TEAM PERSONALIZATION & COMMUNICATION RULES
Always identify who is speaking with you and adapt your tone accordingly:
- **Bibek (IT / AI Specialist)**: Speak normally, direct, technical, crisp, and helpful. No fluff.
- **Rose (Accounts Department)**: Use warm, playful, and affectionate language. Use emojis and address as "darlings" or "dear".
- **Ann (Account Admin)**: Respectful, polite, quiet, decent introvert tone. Professional and gentle.
- **Louis (Owner / Founder of Ironbrij)**: Friendly, tech-forward, fun Australian humor and good vibes with high efficiency.
- **MV & Andrea (IT Gurus)**: Cool, tech-savvy, sharp, witty, and developer-friendly.
- **Janelle (Executive)**: High clarity, effortless summaries, proactive, making work friction-free and smooth.
- **Other Team Members**: Friendly, professional, and clear.

### 📊 DATA PRESENTATION & FORMATTING (STRICT RULES)
1. **Always use Markdown Tables**:
   - For Companies: | Company Name | Code | Timezone | Work Hours | Break Limit | Departments |
   - For Attendance: | Employee | Department | Status | Shift / Time | Details |
   - For Punches: | Date | Time | Type | Employee | Source |
   - For Leaves: | Employee | Dates | Reason | Status | Action |
   - For Overtime: | Employee | Date | Duration | Reason | Status |
2. **Be 100% Precise**: Never guess or invent employee IDs, shift times, or punch timestamps. Use tool outputs directly.
3. **Smart Lookups**: You can look up employees and companies by first name, full name, or email directly.
4. **Confirmation**: Always ask for confirmation before destructive actions (deleting employees, rejecting leaves/overtime).
5. **Proactive Insights**: When reporting attendance, highlight who is currently punched in, who is off-shift, and any missed punch-outs from previous days.`;

export function McpConnectPage() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<AdminApiToken[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chatgpt" | "claude" | "instructions" | "cheatsheet" | "console">("chatgpt");

  // Console test state
  const [selectedAction, setSelectedAction] = useState("get_company_summary");
  const [testPayload, setTestPayload] = useState('{}');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const currentAppUrl =
    typeof window !== "undefined" && !window.location.origin.includes("localhost")
      ? window.location.origin
      : "https://station.savykids.com";

  useEffect(() => {
    const unsub = onSnapshot(collection(db(), "adminApiTokens"), (snapshot) => {
      const list = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<AdminApiToken, "id">),
      }));
      setTokens(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
    return () => unsub();
  }, []);

  const activeToken = tokens.find((t) => t.active) || tokens[0];

  // Generate New Admin Token
  async function handleGenerateToken() {
    if (!user?.email) {
      return toast.error("Must be logged in as admin to generate access keys");
    }
    const rawToken = generateSecureToken();
    const tokenData: Omit<AdminApiToken, "id"> = {
      token: rawToken,
      adminEmail: user.email,
      label: `Admin Key (${user.email})`,
      active: true,
      createdAt: new Date().toISOString(),
    };

    try {
      await setDoc(doc(db(), "adminApiTokens", rawToken), tokenData);
      toast.success("Generated new Admin AI/MCP Token!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create token");
    }
  }

  // Revoke Token
  async function handleRevokeToken(tokenKey: string) {
    try {
      await deleteDoc(doc(db(), "adminApiTokens", tokenKey));
      toast.success("Revoked API Token.");
    } catch (err) {
      toast.error("Failed to revoke token");
    }
  }

  // Copy helper
  function copyToClipboard(text: string, label = "Copied to clipboard!") {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    toast.success(label);
    setTimeout(() => setCopiedKey(null), 2500);
  }

  // Test Tool Action from Console
  async function handleRunConsoleTest() {
    if (!activeToken) {
      return toast.error("Please generate an Admin Token first.");
    }
    setIsTesting(true);
    setTestResult(null);

    try {
      let parsedParams = {};
      if (testPayload.trim()) {
        parsedParams = JSON.parse(testPayload);
      }

      const res = await fetch("/api/mcp-action", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${activeToken.token}`,
        },
        body: JSON.stringify({
          action: selectedAction,
          params: parsedParams,
        }),
      });

      const data = await res.json();
      setTestResult(JSON.stringify(data, null, 2));
      if (data.ok) {
        toast.success("Action executed successfully!");
      } else {
        toast.error(data.error || "Action failed");
      }
    } catch (err) {
      setTestResult(
        JSON.stringify({ error: err instanceof Error ? err.message : "Test failed" }, null, 2),
      );
      toast.error("Invalid JSON or network error");
    } finally {
      setIsTesting(false);
    }
  }

  // Claude Remote MCP Desktop Config JSON
  const claudeDesktopJson = `{
  "mcpServers": {
    "savytimes": {
      "url": "${currentAppUrl}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${activeToken?.token || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc"}"
      }
    }
  }
}`;

  // Claude Code CLI command
  const claudeCodeCmd = `claude mcp add --transport http savytimes ${currentAppUrl}/api/mcp --header "Authorization: Bearer ${activeToken?.token || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc"}"`;

  // OpenAPI Schema for ChatGPT
  const openApiUrl = `${currentAppUrl}/api/mcp-action?openapi=true`;

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-foreground flex items-center gap-2.5">
            <Bot className="h-6 w-6 text-primary" /> AI & MCP Integration
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Connect ChatGPT, Claude, Cursor, and AI agents directly to your SavyTimes admin account.
          </p>
        </div>

        <button
          onClick={handleGenerateToken}
          className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2.5 text-xs font-bold flex items-center gap-2 shadow-xs transition self-start sm:self-auto"
        >
          <Sparkles className="h-4 w-4" /> Generate New Admin Key
        </button>
      </div>

      {/* Active Token Card */}
      <div className="rounded-2xl border bg-card p-5 shadow-xs space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2 border-b pb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-emerald-600" />
            <h2 className="font-bold text-sm text-foreground">
              Admin Access Token & Authentication
            </h2>
          </div>
          <span className="text-xs text-muted-foreground font-medium">
            Authenticated Admin: <strong className="text-foreground">{user?.email}</strong>
          </span>
        </div>

        {activeToken ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-muted-foreground mb-1">
                Active Admin Key (Use this in ChatGPT & Claude)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={activeToken.token}
                  className="w-full font-mono text-xs px-3 py-2.5 rounded-lg border bg-muted/40 text-foreground font-semibold"
                />
                <button
                  onClick={() => copyToClipboard(activeToken.token, "Admin API Token copied!")}
                  className="px-3.5 py-2.5 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground text-xs font-bold flex items-center gap-1.5 shrink-0 transition"
                >
                  {copiedKey === activeToken.token ? (
                    <>
                      <Check className="h-4 w-4 text-emerald-600" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" /> Copy Key
                    </>
                  )}
                </button>
                <button
                  onClick={() => handleRevokeToken(activeToken.token)}
                  className="p-2.5 rounded-lg border text-muted-foreground hover:text-rose-600 hover:bg-rose-50 transition"
                  title="Revoke this key"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground font-medium">
              🔒 This key grants full admin access to manage employees, shifts, punches, and leaves. Keep it secret and only share it with your personal AI assistant.
            </p>
          </div>
        ) : (
          <div className="text-center py-6 space-y-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto">
              <Key className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">No Admin Key Generated Yet</h3>
              <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                Generate an admin key to connect SavyTimes to ChatGPT or Claude.
              </p>
            </div>
            <button
              onClick={handleGenerateToken}
              className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-xs font-bold"
            >
              Generate Admin Key Now
            </button>
          </div>
        )}
      </div>

      {/* Integration Navigation Tabs */}
      <div className="rounded-2xl border bg-card overflow-hidden shadow-xs">
        {/* Tab Headers */}
        <div className="flex border-b bg-secondary/30 text-xs font-bold overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab("chatgpt")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === "chatgpt"
                ? "border-primary text-primary bg-background font-black"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Bot className="h-4 w-4" /> 1. Connect ChatGPT
          </button>
          <button
            onClick={() => setActiveTab("instructions")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === "instructions"
                ? "border-primary text-primary bg-background font-black"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sparkles className="h-4 w-4" /> 2. Master System Instructions
          </button>
          <button
            onClick={() => setActiveTab("cheatsheet")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === "cheatsheet"
                ? "border-primary text-primary bg-background font-black"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessageSquare className="h-4 w-4" /> 3. Command Cheatsheet
          </button>
          <button
            onClick={() => setActiveTab("claude")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === "claude"
                ? "border-primary text-primary bg-background font-black"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Zap className="h-4 w-4" /> Claude MCP Desktop
          </button>
          <button
            onClick={() => setActiveTab("console")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition whitespace-nowrap ${
              activeTab === "console"
                ? "border-primary text-primary bg-background font-black"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Terminal className="h-4 w-4" /> Live Action Console
          </button>
        </div>

        {/* Tab 1: ChatGPT Setup */}
        {activeTab === "chatgpt" && (
          <div className="p-6 space-y-5 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                How to Connect SavyTimes into ChatGPT (Custom GPT)
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                Set up your Custom GPT in under 2 minutes with full OpenAPI Action support.
              </p>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  Step 1: Open ChatGPT & Create a Custom GPT
                </div>
                <p className="text-xs text-foreground leading-relaxed">
                  Go to <strong>ChatGPT &gt; Explore GPTs &gt; Create a GPT &gt; Configure</strong>.<br />
                  Set Name: <strong>SavyTimes Admin Assistant</strong>.
                </p>
              </div>

              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  Step 2: Add Actions & Import OpenAPI Schema URL
                </div>
                <p className="text-xs text-foreground leading-relaxed">
                  Scroll down to <strong>Actions</strong> and click <strong>Create new action</strong>. Click <strong>Import from URL</strong> and paste:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={openApiUrl}
                    className="w-full font-mono text-xs px-3 py-2 rounded-lg border bg-muted/30 font-semibold"
                  />
                  <button
                    onClick={() => copyToClipboard(openApiUrl, "OpenAPI URL copied!")}
                    className="px-3 py-2 rounded-lg bg-secondary text-xs font-bold flex items-center gap-1 shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy URL
                  </button>
                </div>
              </div>

              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  Step 3: Set Authentication to Bearer
                </div>
                <p className="text-xs text-foreground leading-relaxed">
                  Under <strong>Authentication</strong>, select <strong>API Key</strong> &gt; <strong>Bearer</strong>, and paste your active Admin Token:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={activeToken?.token || "Generate a key above first"}
                    className="w-full font-mono text-xs px-3 py-2 rounded-lg border bg-muted/30 font-semibold"
                  />
                  <button
                    onClick={() => copyToClipboard(activeToken?.token || "", "Admin Token copied!")}
                    className="px-3 py-2 rounded-lg bg-secondary text-xs font-bold flex items-center gap-1 shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy Key
                  </button>
                </div>
              </div>

              <div className="p-4 rounded-xl border bg-emerald-500/10 border-emerald-500/20 text-emerald-900 dark:text-emerald-300 space-y-1">
                <div className="font-bold text-xs text-emerald-700 dark:text-emerald-300 uppercase tracking-wider flex items-center gap-1">
                  <Check className="h-4 w-4" /> Next Step: Add Instructions
                </div>
                <p className="text-xs leading-relaxed">
                  Click the <strong>&quot;Master System Instructions&quot;</strong> tab above and paste the full prompt into your GPT's Instructions field!
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Master Instructions */}
        {activeTab === "instructions" && (
          <div className="p-6 space-y-5 text-sm">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="text-base font-bold text-foreground">
                  Master GPT System Instructions
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                  Copy and paste this into ChatGPT's <strong>Instructions</strong> box for bulletproof accuracy and custom team personalities.
                </p>
              </div>

              <button
                onClick={() => copyToClipboard(GPT_SYSTEM_INSTRUCTIONS, "System instructions copied!")}
                className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-bold flex items-center gap-1.5 shadow-xs hover:bg-primary/90 transition-all"
              >
                <Copy className="h-4 w-4" /> Copy Full Instructions
              </button>
            </div>

            <div className="relative">
              <pre className="p-4 rounded-xl bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[480px] overflow-y-auto border border-border/40">
                {GPT_SYSTEM_INSTRUCTIONS}
              </pre>
            </div>
          </div>
        )}

        {/* Tab 3: Command Cheatsheet */}
        {activeTab === "cheatsheet" && (
          <div className="p-6 space-y-6 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                ChatGPT Live Commands & Examples
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                Click any prompt below to copy it directly and try it in your ChatGPT conversation.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Attendance Commands */}
              <div className="p-4 rounded-xl border bg-card space-y-3">
                <div className="flex items-center gap-2 font-bold text-xs text-foreground uppercase tracking-wider">
                  <Users className="h-4 w-4 text-primary" /> 1. Live Attendance & Team Status
                </div>
                <div className="space-y-2">
                  {[
                    "Who is currently working right now?",
                    "Show me today's live attendance in a clean markdown table",
                    "Did anyone miss their punch-out yesterday?",
                    "Give me a complete company summary overview",
                  ].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => copyToClipboard(cmd, `Copied: "${cmd}"`)}
                      className="w-full text-left p-2.5 rounded-lg border bg-muted/30 hover:bg-muted font-medium text-xs text-foreground flex items-center justify-between group transition"
                    >
                      <span>&quot;{cmd}&quot;</span>
                      <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Punch & Overtime Commands */}
              <div className="p-4 rounded-xl border bg-card space-y-3">
                <div className="flex items-center gap-2 font-bold text-xs text-foreground uppercase tracking-wider">
                  <Clock className="h-4 w-4 text-emerald-600" /> 2. Punches & Overtime Approvals
                </div>
                <div className="space-y-2">
                  {[
                    "Show all pending overtime requests",
                    "Approve Rose's overtime request",
                    "Fix missed punch out for MV on Monday at 5:00 PM",
                    "List all punches for Andrea this week",
                  ].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => copyToClipboard(cmd, `Copied: "${cmd}"`)}
                      className="w-full text-left p-2.5 rounded-lg border bg-muted/30 hover:bg-muted font-medium text-xs text-foreground flex items-center justify-between group transition"
                    >
                      <span>&quot;{cmd}&quot;</span>
                      <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Leaves & SOD/EOD Reports */}
              <div className="p-4 rounded-xl border bg-card space-y-3">
                <div className="flex items-center gap-2 font-bold text-xs text-foreground uppercase tracking-wider">
                  <Calendar className="h-4 w-4 text-purple-600" /> 3. Leaves & SOD/EOD Reports
                </div>
                <div className="space-y-2">
                  {[
                    "List all pending leave requests",
                    "Approve leave request for Ann as paid leave",
                    "Show today's SOD reports submitted by the team",
                    "Show today's EOD summary reports",
                  ].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => copyToClipboard(cmd, `Copied: "${cmd}"`)}
                      className="w-full text-left p-2.5 rounded-lg border bg-muted/30 hover:bg-muted font-medium text-xs text-foreground flex items-center justify-between group transition"
                    >
                      <span>&quot;{cmd}&quot;</span>
                      <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Employee Management */}
              <div className="p-4 rounded-xl border bg-card space-y-3">
                <div className="flex items-center gap-2 font-bold text-xs text-foreground uppercase tracking-wider">
                  <Sparkles className="h-4 w-4 text-amber-600" /> 4. Employee Management
                </div>
                <div className="space-y-2">
                  {[
                    "List all active employees with their shift times",
                    "Add new employee: Name: Sarah Smith, Email: sarah@ironbrij.com.au, Shift: 09:00 to 17:00, Timezone: Australia/Sydney",
                    "Send an invite email to Rose",
                    "Post a notice: Title: Team Meeting, Content: All-hands meeting on Friday at 3 PM",
                  ].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => copyToClipboard(cmd, `Copied: "${cmd}"`)}
                      className="w-full text-left p-2.5 rounded-lg border bg-muted/30 hover:bg-muted font-medium text-xs text-foreground flex items-center justify-between group transition"
                    >
                      <span>&quot;{cmd}&quot;</span>
                      <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Company & Client Management */}
              <div className="p-4 rounded-xl border bg-card space-y-3 md:col-span-2">
                <div className="flex items-center gap-2 font-bold text-xs text-foreground uppercase tracking-wider">
                  <Bot className="h-4 w-4 text-blue-600" /> 5. Company &amp; Client Setup with Full Details
                </div>
                <div className="grid md:grid-cols-2 gap-2">
                  {[
                    'Create company: "Ironbrij", Code: "IRON", Timezone: "Australia/Sydney", Work Hours: 8, Break: 30 min, Grace: 5 min, Departments: ["Operations", "Accounts", "IT"]',
                    'Create company: "SavyKids", Code: "SAVY", Timezone: "Asia/Kathmandu", Work Hours: 8, Working Days: Mon to Fri, Break: 30 min, Grace: 5 min',
                    'List all client companies',
                    'Update company "Ironbrij" timezone to Australia/Sydney and break to 30 min',
                  ].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => copyToClipboard(cmd, `Copied: "${cmd}"`)}
                      className="w-full text-left p-2.5 rounded-lg border bg-muted/30 hover:bg-muted font-medium text-xs text-foreground flex items-center justify-between group transition"
                    >
                      <span className="truncate">&quot;{cmd}&quot;</span>
                      <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Claude MCP */}
        {activeTab === "claude" && (
          <div className="p-6 space-y-5 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                How to Connect with Claude Desktop & Claude Code
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                Add the SavyTimes MCP Server config to Claude to let Claude auto-manage the workspace.
              </p>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" /> For Claude Code (1-Click Terminal Command)
                </div>
                <p className="text-xs text-muted-foreground font-medium">
                  Run this command in your terminal to add SavyTimes MCP to Claude Code:
                </p>
                <div className="relative">
                  <pre className="p-3 pr-24 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto">
                    {claudeCodeCmd}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(claudeCodeCmd, "Claude Code command copied!")}
                    className="absolute top-2 right-2 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy Command
                  </button>
                </div>
              </div>

              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  For Claude Desktop (`claude_desktop_config.json`)
                </div>
                <p className="text-xs text-muted-foreground font-medium">
                  Paste this Remote MCP config into <code className="text-primary font-mono">%APPDATA%\Claude\claude_desktop_config.json</code>:
                </p>
                <div className="relative">
                  <pre className="p-3 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto">
                    {claudeDesktopJson}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(claudeDesktopJson, "Claude config JSON copied!")}
                    className="absolute top-2 right-2 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy JSON
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 5: Live Console Test */}
        {activeTab === "console" && (
          <div className="p-6 space-y-4 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                Live AI Action Testing Console
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                Test any admin action directly with your current token to verify responses.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Select Admin Action
                </label>
                <select
                  value={selectedAction}
                  onChange={(e) => {
                    setSelectedAction(e.target.value);
                    if (e.target.value === "create_company") {
                      setTestPayload(
                        '{\n  "name": "Ironbrij",\n  "code": "IRON",\n  "timezone": "Australia/Sydney",\n  "defaultShiftHours": 8,\n  "workingDays": [1, 2, 3, 4, 5],\n  "lateGraceMinutes": 5,\n  "breakAllowanceMinutes": 30,\n  "maxDailyBreaks": 1,\n  "departments": ["Operations", "Accounts", "Engineering"]\n}',
                      );
                    } else if (e.target.value === "update_company") {
                      setTestPayload(
                        '{\n  "name": "Ironbrij",\n  "timezone": "Australia/Sydney",\n  "breakAllowanceMinutes": 30\n}',
                      );
                    } else if (e.target.value === "add_employee") {
                      setTestPayload(
                        '{\n  "name": "Alex Test",\n  "email": "alex.test@example.com",\n  "jobTitle": "Virtual Assistant",\n  "shiftStartTime": "09:00",\n  "shiftEndTime": "17:00"\n}',
                      );
                    } else if (e.target.value === "add_or_fix_punch") {
                      setTestPayload(
                        '{\n  "name": "Rose",\n  "type": "out",\n  "timestampISO": "' +
                          new Date().toISOString() +
                          '"\n}',
                      );
                    } else if (e.target.value === "list_overtime") {
                      setTestPayload('{\n  "status": "pending"\n}');
                    } else if (e.target.value === "list_daily_reports") {
                      setTestPayload('{\n  "reportType": "sod"\n}');
                    } else {
                      setTestPayload('{}');
                    }
                  }}
                  className="w-full px-3 py-2 rounded-lg border bg-background text-sm font-semibold"
                >
                  <option value="get_company_summary">get_company_summary (Overview)</option>
                  <option value="get_live_attendance">get_live_attendance (Real-time)</option>
                  <option value="create_company">create_company (Create with full details)</option>
                  <option value="update_company">update_company (Update rules / timezone)</option>
                  <option value="list_companies">list_companies</option>
                  <option value="list_departments">list_departments</option>
                  <option value="list_employees">list_employees</option>
                  <option value="add_employee">add_employee (Auto-add person)</option>
                  <option value="add_or_fix_punch">add_or_fix_punch (Fix missed clocks)</option>
                  <option value="list_punches">list_punches</option>
                  <option value="list_overtime">list_overtime (Pending/Approved)</option>
                  <option value="decide_overtime">decide_overtime</option>
                  <option value="list_leaves">list_leaves</option>
                  <option value="decide_leave">decide_leave</option>
                  <option value="list_daily_reports">list_daily_reports (SOD / EOD)</option>
                  <option value="list_notices">list_notices</option>
                </select>

                <label className="block text-xs font-bold text-foreground mt-3 mb-1">
                  Parameters JSON Payload
                </label>
                <textarea
                  rows={6}
                  value={testPayload}
                  onChange={(e) => setTestPayload(e.target.value)}
                  className="w-full font-mono text-xs p-3 rounded-lg border bg-background resize-none"
                />

                <button
                  onClick={handleRunConsoleTest}
                  disabled={isTesting}
                  className="mt-3 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center gap-1.5 shadow-xs hover:bg-primary/90 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isTesting ? (
                    <>Executing Action…</>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" /> Execute Action via AI API
                    </>
                  )}
                </button>
              </div>

              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Execution Output / Response
                </label>
                <pre className="p-3 rounded-lg bg-slate-950 text-emerald-400 font-mono text-xs h-[230px] overflow-y-auto border">
                  {testResult || "// Output will appear here after executing..."}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
