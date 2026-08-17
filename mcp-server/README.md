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

| Area                     | Tools                                                                        | What You Can Ask Claude / GPT to Do                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Employees & V.A.s**    | `add_employee`<br>`list_employees`<br>`update_employee`<br>`delete_employee` | • _"Add a new V.A. named Sarah Jenkins (sarah@example.com) to Ironbrij with a 9-5 shift."_<br>• _"Change John Doe's shift to multi-shift 4am-7am and 12pm-3pm."_<br>• _"Deactivate employee X."_ |
| **Companies & Clients**  | `list_companies`<br>`create_company`<br>`update_company`                     | • _"Create a new client company called Apex Digital with Sydney timezone."_<br>• _"List all registered client companies."_                                                                       |
| **Punches & Attendance** | `list_punches`<br>`add_or_fix_punch`                                         | • _"Fix John's missed punch-out on August 12 to 17:00."_<br>• _"Add a punch-in for Maria at 08:30 today."_                                                                                       |
| **Leaves**               | `list_leaves`<br>`decide_leave`                                              | • _"Approve Maria's sick leave request for Aug 15 as paid leave."_<br>• _"Show all pending leave requests."_                                                                                     |

---

## 💬 Example Prompt:

> _"Hey Claude, list all employees in Ironbrij, fix any missed punch-outs from yesterday, and add a new V.A. named Alex Lee."_
