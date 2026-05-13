# GitHub Copilot Chat Agent — Tool Reference (Visual Studio / VS Code / SQL Studio)

This document catalogs every tool available to the GitHub Copilot Agent across VS 2026/2022, VS Code, and SQL Studio.
All schemas are captured from live `body.tools` dumps and ARE authoritative.

> **VS schemas** differ wildly from AI conventions. Param names below are the exact VS-expected values.

---

## Table of Contents

- [Azure MCP Server Tools](#azure-mcp-server-tools)
- [NuGet Package Tools](#nuget-package-tools)
- [File & Code Operations](#file--code-operations)
- [Build & Test](#build--test)
- [Terminal Tools](#terminal-tools)
- [Planning Tools (Preview)](#planning-tools-preview)
- [Specialized Agents & Subagents](#specialized-agents--subagents)
- [Diagnostics, Logs & Web](#diagnostics-logs--web)
- [VS Code Copilot Chat — Tool Schemas](#vs-code-copilot-chat--tool-schemas)
- [SQL Studio (SSMS) Copilot — Tool Schemas](#sql-studio-ssms-copilot--tool-schemas)
- [References](#references)

---

## Azure MCP Server Tools

All tools prefixed `Azure_MCP_Server_` come from the **Azure MCP Server** extension
(install via **Extensions > MCP Registries...** in Visual Studio). Each maps to an Azure
service. These are MCP (Model Context Protocol) tools — their exact parameter schemas are
defined by the server at runtime and may vary by extension version.

### Common MCP request shape

Every `Azure_MCP_Server_*` tool is invoked as an MCP tool call. The general payload shape:

```json
{
  "name": "Azure_MCP_Server_<service>",
  "arguments": {
    "query": "<natural-language question or action>"
  }
}
```

Most Azure MCP tools accept a single **`query`** (string, required) — a natural-language prompt
or structured request specific to the Azure service.

### Tool listing

| Tool Name | Azure Service | Channel |
|-----------|---------------|---------|
| `Azure_MCP_Server_acr` | Azure Container Registry | arm |
| `Azure_MCP_Server_advisor` | Advisor recommendations | arm |
| `Azure_MCP_Server_aks` | Azure Kubernetes Service | arm |
| `Azure_MCP_Server_appconfig` | App Configuration | data-plane |
| `Azure_MCP_Server_applens` | Application Lens diagnostics | data-plane |
| `Azure_MCP_Server_applicationinsights` | Application Insights | data-plane |
| `Azure_MCP_Server_appservice` | App Service / Functions | arm |
| `Azure_MCP_Server_azd` | Azure Developer CLI (`azd`) | cli |
| `Azure_MCP_Server_azuremigrate` | Azure Migrate | arm |
| `Azure_MCP_Server_azureterraformbestpractices` | Terraform on Azure best practices | docs |
| `Azure_MCP_Server_bicepschema` | Bicep Schema reference | docs |
| `Azure_MCP_Server_cloudarchitect` | Cloud Architecture (WAF, landing zones) | docs |
| `Azure_MCP_Server_communication` | Communication Services | data-plane |
| `Azure_MCP_Server_compute` | Virtual Machines, VMSS | arm |
| `Azure_MCP_Server_confidentialledger` | Confidential Ledger | arm |
| `Azure_MCP_Server_cosmos` | Cosmos DB | arm / data-plane |
| `Azure_MCP_Server_datadog` | Datadog (partner integration) | arm |
| `Azure_MCP_Server_deploy` | ARM/Bicep Deployments | arm |
| `Azure_MCP_Server_documentation` | Azure Documentation lookup | docs |
| `Azure_MCP_Server_eventgrid` | Event Grid | data-plane |
| `Azure_MCP_Server_eventhubs` | Event Hubs | arm / data-plane |
| `Azure_MCP_Server_extension_azqr` | Azure Quick Review (azqr) | cli |
| `Azure_MCP_Server_extension_cli_generate` | Azure CLI command generator | cli |
| `Azure_MCP_Server_extension_cli_install` | Azure CLI extension install helper | cli |
| `Azure_MCP_Server_fileshares` | Azure Files (File Shares) | arm |
| `Azure_MCP_Server_foundry` | Azure AI Foundry (hub, projects) | data-plane |
| `Azure_MCP_Server_foundryextensions` | AI Foundry Extensions | data-plane |
| `Azure_MCP_Server_get_azure_bestpractices` | Azure Best Practices | docs |
| `Azure_MCP_Server_grafana` | Managed Grafana | arm |
| `Azure_MCP_Server_group_list` | Resource Group listing | arm |
| `Azure_MCP_Server_keyvault` | Key Vault | arm / data-plane |
| `Azure_MCP_Server_kusto` | Data Explorer (Kusto / KQL) | data-plane |
| `Azure_MCP_Server_loadtesting` | Load Testing | arm / data-plane |
| `Azure_MCP_Server_managedlustre` | Managed Lustre (HPC filesystem) | arm |
| `Azure_MCP_Server_marketplace` | Azure Marketplace | arm |
| `Azure_MCP_Server_monitor` | Azure Monitor (metrics, alerts) | arm / data-plane |
| `Azure_MCP_Server_mysql` | MySQL Flexible Server | arm |
| `Azure_MCP_Server_policy` | Azure Policy | arm |
| `Azure_MCP_Server_postgres` | PostgreSQL Flexible Server | arm |
| `Azure_MCP_Server_pricing` | Pricing Calculator | docs |
| `Azure_MCP_Server_quota` | Quota management | arm |
| `Azure_MCP_Server_redis` | Azure Cache for Redis | arm |
| `Azure_MCP_Server_resourcehealth` | Resource Health | arm |
| `Azure_MCP_Server_role` | RBAC (Role-Based Access Control) | arm |
| `Azure_MCP_Server_search` | AI Search (indexes, indexers) | data-plane |
| `Azure_MCP_Server_servicebus` | Service Bus | arm / data-plane |
| `Azure_MCP_Server_servicefabric` | Service Fabric | arm |
| `Azure_MCP_Server_signalr` | SignalR Service | arm |
| `Azure_MCP_Server_speech` | Speech Services | data-plane |
| `Azure_MCP_Server_sql` | SQL Database / Managed Instance | arm |
| `Azure_MCP_Server_storage` | Blob / Table / Queue Storage | arm |
| `Azure_MCP_Server_storagesync` | File Sync | arm |
| `Azure_MCP_Server_subscription_list` | Subscription listing | arm |
| `Azure_MCP_Server_virtualdesktop` | Azure Virtual Desktop | arm |
| `Azure_MCP_Server_wellarchitectedframework` | Well-Architected Framework | docs |
| `Azure_MCP_Server_workbooks` | Monitor Workbooks | arm |

### Example usage

```
Prompt: "List my AKS clusters and their node pool sizes"
→ Agent calls Azure_MCP_Server_aks with query about cluster/node-pool info

Prompt: "Generate a Bicep template for an App Service with Key Vault secrets"
→ Agent calls Azure_MCP_Server_bicepschema + Azure_MCP_Server_appservice + Azure_MCP_Server_keyvault
```

---

## NuGet Package Tools

### `nuget_fix_vulnerable_packages`

**Channel:** `nuget`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Target project (omit for whole solution) |

### Confirmed schemas (VS Insiders 18.7 — from live tool dumps)

| Tool | Required | Properties |
|------|:--------:|------------|
| `get_file` | `filename`,`startLine`,`endLine` | `filename`,`startLine`,`endLine`,`includeLineNumbers` |
| `grep_search` | `query`,`isRegexp`,`includePattern`,`maxResults` | `query`,`isRegexp`,`includePattern`,`maxResults` |
| `replace_string_in_file` | `filePath`,`oldString`,`newString` | `filePath`,`oldString`,`newString` |
| `multi_replace_string_in_file` | `replacements`,`explanation` | `replacements`,`explanation` |
| `create_file` | `filePath`,`content` | `filePath`,`content` |
| `remove_file` | `filePath` | `filePath` |
| `code_search` | `searchQueries` | `searchQueries` |
| `file_search` | `queries`,`maxResults` | `queries`,`maxResults` |
| `get_files_in_project` | `projectPath` | `projectPath` |
| `get_projects_in_solution` | *none* | *none* |
| `get_errors` | `filePaths` | `filePaths` |
| `find_symbol` | `navigationType`,`filepath`,`symbolName`,`lineText` | `navigationType`,`filepath`,`symbolName`,`lineText` |
| `run_build` | *none* | *none* |
| `run_tests` | `filterTypes`,`filterValues` | `filterTypes`,`filterValues` |
| `get_tests` | `filterTypes`,`filterValues` | `filterTypes`,`filterValues` |
| `run_command_in_terminal` | `command`,`summary`,`background` | `command`,`summary`,`background` |
| `get_background_terminal_output` | `terminal_id`,`headLines`,`tailLines`,`stop`,`waitMs` | `terminal_id`,`headLines`,`tailLines`,`stop`,`waitMs` |
| `get_output_window_logs` | `paneId` | `paneId` |
| `get_web_pages` | `urls` | `urls` |
| `run_subagent` | `prompt`,`description`,`agentName` | `prompt`,`description`,`agentName` |
| `search_agent` | `query`,`description`,`details` | `query`,`description`,`details` |
| `profiler_agent` | `reason` | `reason` |
| `start_modernization` | *none* | *none* |
| `query_azure_resource_graph` | `prompt` | `prompt` |
| `plan` | `planMarkdown` | `planMarkdown` |
| `adapt_plan` | `observation` | `observation` |
| `update_plan_progress` | `stepId`,`status`,`message`,`autoAdvance` | `stepId`,`status`,`message`,`autoAdvance` |
| `record_observation` | `observation` | `observation` |
| `finish_plan` | *none* | *none* |
| `signal_plan_ready` | `planTitle` | `planTitle` |
| `clarify_requirements` | `questions` | `questions` |
| `detect_memories` | `memory`,`confidence` | `memory`,`confidence` |
| `nuget_get_latest_package_version` | `solutionDirectory`,`packageName`,`includePrerelease` | `solutionDirectory`,`packageName`,`includePrerelease` |
| `nuget_get_package_context` | `solutionDirectory`,`packageName`,`packageVersion` | `solutionDirectory`,`packageName`,`packageVersion` |
| `nuget_upgrade_packages_to_latest` | `solutionDirectory`,`projectPaths`,`includeVulnerable`,`includePrerelease` | `solutionDirectory`,`projectPaths`,`includeVulnerable`,`includePrerelease` |
| `nuget_fix_vulnerable_packages` | `solutionDirectory`,`projectPaths`,`includePrerelease` | `solutionDirectory`,`projectPaths`,`includePrerelease` |
| `task_complete` | (pass-through) | (pass-through) |

### Azure MCP Server tools (confirmed)

Most: `required: ["intent"]`, `properties: ["intent","command","parameters","learn"]`  
`subscription_list`,`group_list`: `required: []`, properties: `tenant`,`auth-method`,`retry-*`, etc.  
`extension_azqr`: `required: []`, properties: `tenant`,`subscription`,`resource-group`, etc.  
`extension_cli_install`: `required: ["cli-type"]`, properties: `tenant`,`cli-type`, etc.  
`extension_cli_generate`: `required: ["intent","cli-type"]`

---

## File & Code Operations

### `code_search`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | **Yes** | Natural-language question about the codebase |
| `explanation` | string | ~ | Optional context for the search intent |

Semantic/vector search that understands meaning — "where is auth implemented?" vs text grep.

### `create_file`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `filePath` | string | **Yes** | Workspace-relative or absolute path for the new file |
| `content` | string | **Yes** | Full file content to write |

### `file_search`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | **Yes** | Filename or glob pattern |
| `searchPattern` | string | ~ | Additional file-type filter (glob) |
| `maxResults` | integer | ~ | Max results (default: 20) |

### `find_symbol`

**Channel:** `builtin` — VS 2026+ only. Supported: C++, C#, Razor, TypeScript, and any LSP-enabled language.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | **Yes** | Symbol name or partial name |
| `includeReferences` | boolean | ~ | Also return references (default: `true`) |

Returns type info, declarations, scope, and all references.

### `get_file`

**Channel:** `builtin` — Schema confirmed from VS tool-call traces.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `filename` | string | **Yes** | File path. VS uses `filename` (NOT `filePath`) |
| `startLine` | integer (1-based) | **Yes** | Starting line number |
| `endLine` | integer (1-based, inclusive) | **Yes** | Ending line number |
| `includeLineNumbers` | boolean | No | Include line numbers in output (default: `false`) |

**Schema:** `required: ["filename","startLine","endLine"]`, `additionalProperties: false`

### `get_files_in_project`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | **Yes** | Project name within the solution |
| `searchPattern` | string | ~ | Optional glob filter (e.g. `"**/*.cs"`) |

### `get_projects_in_solution`

**Channel:** `builtin`

No required parameters. Returns a flat list of all projects in the currently open solution.

### `grep_search`

**Channel:** `builtin` — Schema confirmed from VS tool-call traces.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | **Yes** | Search query. Case-insensitive. VS uses `query` (NOT `pattern`) |
| `isRegexp` | boolean | **Yes** | Whether `query` is a regex |
| `includePattern` | string \| null | **Yes** | Glob for files to include (VS uses `includePattern` NOT `fileTypes`). `null` = all files |
| `maxResults` | integer \| null | **Yes** | Max results, default 20, max 200. `null` = default |

**Schema:** `required: ["query","isRegexp","includePattern","maxResults"]`, `additionalProperties: false`

### `multi_replace_string_in_file`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `filePath` | string | **Yes** | Target file |
| `replacements` | array | **Yes** | Array of `{oldString, newString}` objects |

### `remove_file`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `filePath` | string | **Yes** | Path of file to delete |
| `explanation` | string | ~ | Reason for deletion (shown in UI) |

### `replace_string_in_file`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `filePath` | string | **Yes** | Target file |
| `oldString` | string | **Yes** | Exact text to replace |
| `newString` | string | **Yes** | Replacement text |

---

## Build & Test

### `get_errors`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Filter errors by project |
| `filePath` | string | ~ | Filter errors by file |

Returns structured error-list data (file, line, column, severity, message, error code).

### `get_tests`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Test project to scan |
| `filePath` | string | ~ | Specific test file to scan |

Discovers test methods with their full names, traits, and parameterized variants.

### `run_build`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Specific project to build (omit = entire solution) |
| `configuration` | string | ~ | Build configuration (e.g. `"Debug"`, `"Release"`) |

### `run_tests`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Test project to run |
| `testName` | string | ~ | Fully-qualified test name |
| `framework` | string | ~ | Test framework hint (xUnit / NUnit / MSTest) |

---

## Terminal Tools

### `get_background_terminal_output`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `terminalId` | string | ~ | Specific terminal handle (omit = all background terminals) |

### `run_command_in_terminal`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `command` | string | **Yes** | Shell command to execute |
| `cwd` | string | ~ | Working directory (default: solution root) |
| `timeout` | integer | ~ | Timeout in milliseconds |
| `runInBackground` | boolean | ~ | Keep running in background (default: `false`) |

**Security:** Runs with the same permissions as the VS process. Requires user approval by default.

---

## Planning Tools (Preview)

Available in VS 2022 17.14+. Enable via **Tools > Options > GitHub > Copilot > Enable Planning**.

Plan files land in `%TEMP%\VisualStudio\copilot-vs\` as `plan-{sessionId}.md` (human-readable) and `plan-{sessionId}.json` (LLM-readable).

### `adapt_plan`

**Channel:** `planning`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `changes` | string | **Yes** | Description of what needs to change in the plan |

Refines or reorders the plan based on new information or discovered issues.

### `clarify_requirements`

**Channel:** `planning`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `question` | string | **Yes** | Clarifying question to ask the user |

### `detect_memories`

**Channel:** `planning`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | ~ | Filter/context for memory retrieval |

Detects relevant user preferences from past conversations (Copilot Memories feature).

### `finish_plan`

**Channel:** `planning`

No parameters. Finalizes the plan — all steps are complete.

### `plan`

**Channel:** `planning`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `task` | string | **Yes** | High-level task description |
| `context` | object | ~ | Additional context (file list, constraints, etc.) |

Generates the initial structured plan with goals and ordered steps.

### `record_observation`

**Channel:** `planning`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `observation` | string | **Yes** | Runtime result, insight, or learning |

Captures information that may influence subsequent steps.

### `signal_plan_ready`

**Channel:** `planning`

No parameters. Signals to the user that the plan is ready for review before execution begins.

### `update_plan_progress`

**Channel:** `planning`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `stepId` | string | **Yes** | Step identifier being updated |
| `status` | string | **Yes** | One of: `pending`, `in_progress`, `completed`, `failed` |

Synchronizes the JSON and Markdown plan files.

---

## Specialized Agents & Subagents

### `profiler_agent`

**Channel:** `agent` — Wraps the `@profiler` built-in agent.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `prompt` | string | **Yes** | Performance profiling question or command |

Capabilities: CPU/memory tracing, BenchmarkDotNet generation, .NET Counters analysis, C++ unit-test-based profiling.

### `query_azure_resource_graph`

**Channel:** `agent`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | **Yes** | KQL query for Azure Resource Graph |

Cross-subscription resource queries. Example KQL: `resources | where type == "microsoft.compute/virtualmachines"`.

### `run_subagent`

**Channel:** `agent`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `agentName` | string | **Yes** | Name of the subagent (e.g. `"code-reviewer"`) |
| `prompt` | string | **Yes** | Task description for the subagent |
| `context` | object | ~ | Additional context (files, constraints) |

Launches a focused subagent to parallelize or delegate a sub-task.

### `search_agent`

**Channel:** `agent`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | string | **Yes** | What to search for |
| `source` | string | ~ | Search scope: `"code"`, `"docs"`, `"web"`, `"agents"` |

Discovers built-in agents, custom agents, agent skills, and MCP tools available in the environment.

### `start_modernization`

**Channel:** `agent` — Wraps the `@modernize` built-in agent for .NET/C++ upgrades.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `targetFramework` | string | **Yes** | Target framework (e.g. `"net9.0"`, `"net10.0"`) |
| `projectName` | string | ~ | Specific project to upgrade (omit = assess entire solution) |

Three-stage process: Assessment → Plan → Task Execution.

---

## Diagnostics, Logs & Web

### `get_errors`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Filter by project |
| `filePath` | string | ~ | Filter by file |

Returns structured compilation errors/warnings from the Error List window (file, line, column, severity, code, message).

### `get_output_window_logs`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `outputPane` | string | ~ | Pane name: `"Build"`, `"Debug"`, `"Diagnostics Hub"`, etc. |
| `maxLines` | integer | ~ | Max lines to return (default: all recent) |

### `get_web_pages`

**Channel:** `builtin`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `url` | string | **Yes** | URL to fetch (HTTPS) |
| `format` | string | ~ | Output format: `"text"`, `"markdown"`, `"html"` (default: `"markdown"`) |

Fetches and parses web content for documentation lookup or API reference.

### `task_complete`

**Channel:** `builtin`

No parameters. Signals to the user that all requested work is done.

---

## VS Code Copilot Chat — Tool Schemas

VS Code uses an entirely different tool set from Visual Studio. Schemas captured from live VS Code Copilot sessions.

### File / Workspace

| Tool | Required | Properties |
|------|:--------:|------------|
| `read_file` | `filePath`,`startLine`,`endLine` | `filePath`,`startLine`,`endLine` |
| `list_dir` | `path` | `path` |
| `create_directory` | `dirPath` | `dirPath` |
| `create_new_workspace` | `query` | `query` |

### Search

| Tool | Required | Properties |
|------|:--------:|------------|
| `semantic_search` | `query` | `query` |
| `github_text_search` | `scope`,`query` | `scope`,`query`,`maxResults` |
| `github_repo` | `repo`,`query` | `repo`,`query` |

### Edit / Notebook

| Tool | Required | Properties |
|------|:--------:|------------|
| `insert_edit_into_file` | `explanation`,`filePath`,`code` | `explanation`,`filePath`,`code` |
| `create_new_jupyter_notebook` | `query` | `query` |
| `edit_notebook_file` | `filePath`,`editType`,`cellId` | `filePath`,`cellId`,`newCode`,`language`,`editType` |
| `run_notebook_cell` | `filePath`,`cellId` | `filePath`,`reason`,`cellId`,`continueOnError` |
| `copilot_getNotebookSummary` | `filePath` | `filePath` |

### Terminal

| Tool | Required | Properties |
|------|:--------:|------------|
| `run_in_terminal` | `command`,`explanation`,`goal`,`mode` | `command`,`explanation`,`goal`,`mode`,`isBackground`,`timeout` |
| `send_to_terminal` | `id`,`command` | `id`,`command`,`waitForOutput` |
| `get_terminal_output` | `id` | `id` |
| `kill_terminal` | `id` | `id` |
| `terminal_last_command` | *none* | *none* |
| `terminal_selection` | *none* | *none* |

### Symbol / Code

| Tool | Required | Properties |
|------|:--------:|------------|
| `vscode_listCodeUsages` | `symbol`,`lineContent` | `symbol`,`uri`,`filePath`,`lineContent` |
| `vscode_renameSymbol` | `symbol`,`newName`,`lineContent` | `symbol`,`newName`,`uri`,`filePath`,`lineContent` |
| `get_vscode_api` | `query` | `query` |

### Browser / Playwright

| Tool | Required | Properties |
|------|:--------:|------------|
| `open_browser_page` | *none* | `url`,`forceNew` |
| `navigate_page` | `pageId` | `pageId`,`type`,`url` |
| `read_page` | `pageId` | `pageId` |
| `click_element` | `pageId`,`element` | `pageId`,`ref`,`selector`,`element`,`dblClick`,`button` |
| `type_in_page` | `pageId` | `pageId`,`text`,`key`,`ref`,`selector`,`element` |
| `hover_element` | `pageId`,`element` | `pageId`,`ref`,`selector`,`element` |
| `drag_element` | `pageId`,`fromElement`,`toElement` | `pageId`,`fromRef`,`fromSelector`,`fromElement`,`toRef`,`toSelector`,`toElement` |
| `handle_dialog` | `pageId` | `pageId`,`acceptModal`,`promptText`,`selectFiles` |
| `screenshot_page` | `pageId` | `pageId`,`ref`,`selector`,`element`,`scrollIntoViewIfNeeded` |
| `run_playwright_code` | `pageId` | `pageId`,`code`,`deferredResultId`,`timeoutMs` |

### Agents / Tasks

| Tool | Required | Properties |
|------|:--------:|------------|
| `runSubagent` | `prompt`,`description` | `prompt`,`description`,`agentName`,`model` |
| `manage_todo_list` | `todoList` | `todoList` |
| `create_and_run_task` | `task`,`workspaceFolder` | `workspaceFolder`,`task` |

### Memory / State

| Tool | Required | Properties |
|------|:--------:|------------|
| `memory` | `command` | `command`,`path`,`file_text`,`old_str`,`new_str`,`insert_line`,`insert_text`,`view_range`,`old_path`,`new_path` |
| `resolve_memory_file_uri` | `path` | `path` |
| `session_store_sql` | `description` | `action`,`query`,`force`,`description` |

### Extensions / Misc

| Tool | Required | Properties |
|------|:--------:|------------|
| `install_extension` | `id`,`name` | `id`,`name` |
| `vscode_searchExtensions_internal` | *none* | `category`,`keywords`,`ids` |
| `run_vscode_command` | `commandId`,`name` | `commandId`,`name`,`args`,`skipCheck` |
| `vscode_askQuestions` | `questions` | `questions` |
| `fetch_webpage` | `urls`,`query` | `urls`,`query` |
| `view_image` | `filePath` | `filePath` |
| `renderMermaidDiagram` | *none* | `markup`,`title` |

---

## SQL Studio (SSMS) Copilot — Tool Schemas

SQL Server Management Studio uses its own domain-specific tools. All have `required: [], properties: []` — no structured parameter schemas. The AI interacts via natural language.

### Database Introspection

| Tool | Description |
|------|-------------|
| `ReadDatabaseConstitution` | Read database configuration / constitution |
| `GetCopilotConfiguration` | Get current Copilot settings for the session |
| `SetCopilotConfiguration` | Set Copilot configuration options |
| `FindRelevantDatabaseObjects` | Find database objects matching a description |
| `GetDatabaseObjectInformation` | Get detailed metadata about a database object |
| `GetObjectText` | Get the T-SQL definition text of an object |
| `GetForeignKeysForSingleTable` | Get FK relationships for a specific table |
| `GetColumnInfoForListOfTables` | Get column metadata for a list of tables |
| `GetTableColumnNames` | Get column names for a table |

### Search / Discovery

| Tool | Description |
|------|-------------|
| `SearchSchemasForOnePartName` | Search schemas for an object name |
| `FindColumn` | Find a column by name across the database |
| `FindColumnReferences` | Find references to a column |
| `FindColumnsThat` | Find columns matching criteria |
| `FindForeignKeysThat` | Find foreign keys matching criteria |
| `FindDatabaseObjectsThat` | Find database objects matching criteria |
| `FindDatabaseObjectsWith` | Find database objects with specific properties |
| `GetTablesWith` | Get tables with specific characteristics |
| `GetTablesThat` | Get tables matching criteria |

### Query Execution / Results

| Tool | Description |
|------|-------------|
| `ReadFromDatabase` | Execute a read query against the database |
| `ValidateGeneratedTSQL` | Validate generated T-SQL for syntax errors |
| `ExecutePredefinedQuery` | Run a pre-defined query |
| `LoadPredefinedQuery` | Load a pre-defined query template |
| `LoadPredefinedReport` | Load a pre-defined report template |
| `LoadPredefinedKnowledge` | Load pre-defined knowledge base |
| `GetTextResults` | Get text-format query results (`startPosition`,`maxLength`) |
| `GetGridResults` | Get grid-format query results (`gridIndex`,`startColumn`,`columnCount`,`startRow`,`maxRows`,`maxCellTextLength`) |
| `GetMessagesContent` | Get messages/errors from last execution (`startPosition`,`maxLength`) |
| `GetQueryPlanXml` | Get XML execution plan (`startPosition`,`maxLength`) |
| `GetClientStatistics` | Get client-side execution statistics |

### Server / Utility

| Tool | Description |
|------|-------------|
| `GetCurrentDate` | Get current server date/time |
| `GetAllSqlServerProperties` | Get all SQL Server instance properties |
| `GetServerDefaultBackupDirectory` | Get default backup directory path |
| `GetServerDefaultDatabaseDataFilesDirectory` | Get default data file directory |
| `GetServerDefaultDatabaseLogFilesDirectory` | Get default log file directory |
| `ConvertSegmentedLSNToDecimal` | Convert segmented LSN to decimal |
| `RestoreVerifyBackupFile` | Verify a backup file for restore |
| `EscapeDatabaseObjectNameForStringLiteral` | Escape object name for string literals |
| `EscapeDatabaseObjectNameForIdentifier` | Escape object name for identifiers |
| `ListExtendedEventsGlobalStateFieldsForPredicates` | List XEvent global state fields |
| `ListExtendedEventsFieldsForAnEvent` | List XEvent fields for an event |

### Hints / Helpers

| Tool | Description |
|------|-------------|
| `HINT_HowToFindDisableConstraints` | Hint: how to find/disable constraints |
| `HINT_HowToFindLargeIndexKeys` | Hint: how to find large index keys |

---

## References

| Source | URL |
|--------|-----|
| Copilot Agent Mode | https://learn.microsoft.com/en-us/visualstudio/ide/copilot-agent-mode |
| MCP Servers in VS | https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers |
| Custom Agents | https://learn.microsoft.com/en-us/visualstudio/ide/copilot-specialized-agents |
| Agent Skills | https://learn.microsoft.com/en-us/visualstudio/ide/copilot-agent-skills |
| Debug with Copilot | https://learn.microsoft.com/en-us/visualstudio/debugger/debug-with-copilot |
| Profile with Copilot | https://learn.microsoft.com/en-us/visualstudio/profiling/profile-with-copilot-agent |
| Copilot Chat Context | https://learn.microsoft.com/en-us/visualstudio/ide/copilot-chat-context |
| Copilot Testing (.NET) | https://learn.microsoft.com/en-us/visualstudio/test/github-copilot-test-dotnet-overview |
| MCP Server Registry | https://github.com/modelcontextprotocol/servers |
| Awesome Copilot | https://github.com/github/awesome-copilot |
| MCP Specification | https://modelcontextprotocol.io/specification |
| Agent Skills Spec | https://agentskills.io/specification |
