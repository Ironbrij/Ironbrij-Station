# SavyTimes Admin MCP Server

The **Model Context Protocol (MCP)** server allows AI assistants (such as **Claude Desktop**, **ChatGPT**, or **Cursor**) to directly manage and edit **everything** in your SavyTimes system through conversational prompts.

---

## 🚀 Setup in Claude Desktop

Add this configuration to your Claude Desktop configuration file:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "savytimes-admin": {
      "command": "node",
      "args": ["d:\\time station\\time station\\mcp-server\\index.mjs"]
    }
  }
}
```

---

## 🛠 What Can the MCP Server Edit? (Full Capabilities)

| Area | Tools | What You Can Ask Claude / GPT to Do |
|------|-------|--------------------------------------|
| **Employees & V.A.s** | `add_employee`<br>`list_employees`<br>`update_employee`<br>`delete_employee` | • *"Add a new V.A. named Sarah Jenkins (sarah@example.com) to Ironbrij with a 9-5 shift."*<br>• *"Change John Doe's shift to multi-shift 4am-7am and 12pm-3pm."*<br>• *"Deactivate employee X."* |
| **Companies & Clients** | `list_companies`<br>`create_company`<br>`update_company` | • *"Create a new client company called Apex Digital with Sydney timezone."*<br>• *"List all registered client companies."* |
| **Punches & Attendance** | `list_punches`<br>`add_or_fix_punch` | • *"Fix John's missed punch-out on August 12 to 17:00."*<br>• *"Add a punch-in for Maria at 08:30 today."* |
| **Leaves** | `list_leaves`<br>`decide_leave` | • *"Approve Maria's sick leave request for Aug 15 as paid leave."*<br>• *"Show all pending leave requests."* |

---

## 💬 Example Prompt:
> *"Hey Claude, list all employees in Ironbrij, fix any missed punch-outs from yesterday, and add a new V.A. named Alex Lee."*
