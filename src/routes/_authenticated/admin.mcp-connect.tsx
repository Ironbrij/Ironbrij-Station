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

function McpConnectPage() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<AdminApiToken[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chatgpt" | "claude" | "console">("chatgpt");

  // Console test state
  const [selectedAction, setSelectedAction] = useState("list_employees");
  const [testPayload, setTestPayload] = useState('{\n  "companyId": "default"\n}');
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
      setTestResult(JSON.stringify({ error: err instanceof Error ? err.message : "Test failed" }, null, 2));
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
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
          className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2.5 text-xs font-bold flex items-center gap-2 shadow-sm transition self-start sm:self-auto"
        >
          <Sparkles className="h-4 w-4" /> Generate New Admin Key
        </button>
      </div>

      {/* Active Token Card */}
      <div className="rounded-2xl border bg-card p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2 border-b pb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-emerald-600" />
            <h2 className="font-bold text-sm text-foreground">
              Admin Access Token & Authentication
            </h2>
          </div>
          <span className="text-xs text-muted-foreground">
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
            <p className="text-[11px] text-muted-foreground">
              🔒 This key gives full admin access to manage employees, shifts, punches, and leaves.
              Keep it secret and only share it with your personal AI assistant.
            </p>
          </div>
        ) : (
          <div className="text-center py-6 space-y-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto">
              <Key className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">No Admin Key Generated Yet</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
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

      {/* Integration Guides Tabs */}
      <div className="rounded-2xl border bg-card overflow-hidden shadow-sm">
        {/* Tab Headers */}
        <div className="flex border-b bg-secondary/30 text-xs font-bold">
          <button
            onClick={() => setActiveTab("chatgpt")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition ${
              activeTab === "chatgpt"
                ? "border-primary text-primary bg-background"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Bot className="h-4 w-4" /> Connect with ChatGPT (Custom GPT)
          </button>
          <button
            onClick={() => setActiveTab("claude")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition ${
              activeTab === "claude"
                ? "border-primary text-primary bg-background"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Zap className="h-4 w-4" /> Connect with Claude Desktop / Claude Code
          </button>
          <button
            onClick={() => setActiveTab("console")}
            className={`px-5 py-3.5 flex items-center gap-2 border-b-2 transition ${
              activeTab === "console"
                ? "border-primary text-primary bg-background"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Terminal className="h-4 w-4" /> Live AI Action Console
          </button>
        </div>

        {/* Tab 1: ChatGPT */}
        {activeTab === "chatgpt" && (
          <div className="p-6 space-y-5 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                How to Connect SavyTimes into ChatGPT
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                You can create a Custom GPT in ChatGPT that talks directly to your SavyTimes admin
                account via OpenAPI Actions.
              </p>
            </div>

            <div className="space-y-4">
              {/* Step 1 */}
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  Step 1: Open ChatGPT & Create a Custom GPT
                </div>
                <p className="text-xs text-foreground">
                  Go to <strong>ChatGPT &gt; Explore GPTs &gt; Create a GPT &gt; Configure</strong>.
                  Name it <em>&quot;SavyTimes Manager&quot;</em>.
                </p>
              </div>

              {/* Step 2 */}
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  Step 2: Add Actions & Import OpenAPI Schema
                </div>
                <p className="text-xs text-foreground">
                  Scroll down to <strong>Actions</strong> and click <strong>Create new action</strong>.
                  Click <strong>Import from URL</strong> and paste:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={openApiUrl}
                    className="w-full font-mono text-xs px-3 py-2 rounded-lg border bg-muted/30"
                  />
                  <button
                    onClick={() => copyToClipboard(openApiUrl, "OpenAPI URL copied!")}
                    className="px-3 py-2 rounded-lg bg-secondary text-xs font-bold flex items-center gap-1 shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy URL
                  </button>
                </div>
              </div>

              {/* Step 3 */}
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  Step 3: Set Authentication to Bearer
                </div>
                <p className="text-xs text-foreground">
                  Under <strong>Authentication</strong>, select <strong>API Key</strong> &gt;{" "}
                  <strong>Bearer</strong>, and paste your active Admin Token:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={activeToken?.token || "Generate a key above first"}
                    className="w-full font-mono text-xs px-3 py-2 rounded-lg border bg-muted/30"
                  />
                  <button
                    onClick={() =>
                      copyToClipboard(activeToken?.token || "", "Admin Token copied!")
                    }
                    className="px-3 py-2 rounded-lg bg-secondary text-xs font-bold flex items-center gap-1 shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy Key
                  </button>
                </div>
              </div>

              {/* Step 4 */}
              <div className="p-4 rounded-xl border bg-emerald-500/10 border-emerald-500/20 text-emerald-900 space-y-1">
                <div className="font-bold text-xs text-emerald-700 uppercase tracking-wider flex items-center gap-1">
                  <Check className="h-4 w-4" /> Ready to Chat!
                </div>
                <p className="text-xs">
                  You can now ask ChatGPT: <em>&quot;Add a new V.A. named Sarah with 9-5 shift in Sydney&quot;</em> or <em>&quot;Fix Maria&apos;s missed punch out on Monday&quot;</em>.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Claude */}
        {activeTab === "claude" && (
          <div className="p-6 space-y-5 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                How to Connect with Claude Desktop & Claude Code
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Add the SavyTimes MCP Server config to Claude to let Claude auto-add people and
                manage the app.
              </p>
            </div>

            <div className="space-y-4">
              {/* Option 1: Claude Code CLI */}
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" /> For Claude Code (1-Click Terminal Command)
                </div>
                <p className="text-xs text-muted-foreground">
                  Run this command in your terminal on any computer to add SavyTimes MCP to Claude Code:
                </p>
                <div className="relative">
                  <pre className="p-3 pr-24 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto">
                    {claudeCodeCmd}
                  </pre>
                  <button
                    onClick={() =>
                      copyToClipboard(claudeCodeCmd, "Claude Code command copied!")
                    }
                    className="absolute top-2 right-2 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy Command
                  </button>
                </div>
              </div>

              {/* Option 2: Claude Desktop */}
              <div className="p-4 rounded-xl border bg-background space-y-2">
                <div className="font-bold text-xs text-primary uppercase tracking-wider">
                  For Claude Desktop (`claude_desktop_config.json`)
                </div>
                <p className="text-xs text-muted-foreground">
                  Paste this Remote MCP config into `%APPDATA%\Claude\claude_desktop_config.json` (no local files needed):
                </p>
                <div className="relative">
                  <pre className="p-3 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto">
                    {claudeDesktopJson}
                  </pre>
                  <button
                    onClick={() =>
                      copyToClipboard(claudeDesktopJson, "Claude config JSON copied!")
                    }
                    className="absolute top-2 right-2 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy JSON
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Console Test */}
        {activeTab === "console" && (
          <div className="p-6 space-y-4 text-sm">
            <div>
              <h3 className="text-base font-bold text-foreground">
                Live AI Action Testing Console
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Test any admin action directly with your current token to verify it works.
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
                    if (e.target.value === "add_employee") {
                      setTestPayload(
                        '{\n  "name": "Alex Test",\n  "email": "alex.test@example.com",\n  "jobTitle": "Virtual Assistant",\n  "shiftStartTime": "09:00",\n  "shiftEndTime": "17:00"\n}',
                      );
                    } else if (e.target.value === "add_or_fix_punch") {
                      setTestPayload(
                        '{\n  "employeeId": "emp_123",\n  "type": "out",\n  "timestampISO": "' +
                          new Date().toISOString() +
                          '"\n}',
                      );
                    } else {
                      setTestPayload('{\n  "companyId": "default"\n}');
                    }
                  }}
                  className="w-full px-3 py-2 rounded-lg border bg-background text-sm font-semibold"
                >
                  <option value="list_employees">list_employees</option>
                  <option value="add_employee">add_employee (Auto-add person)</option>
                  <option value="list_companies">list_companies</option>
                  <option value="add_or_fix_punch">add_or_fix_punch</option>
                  <option value="list_leaves">list_leaves</option>
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
                  className="mt-3 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm"
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
