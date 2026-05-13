# Visual Studio Copilot Chat Agent — Tool Reference

This document catalogs every tool available to the GitHub Copilot Agent in Visual Studio 2026 / 2022 17.14+.  
Tools are used in **Agent Mode**; enable/disable individual tools via the **Tools** icon in the chat window.

> **Note:** GitHub Copilot for VS is closed-source. Confirmed schemas come from tool-call inspection and the AGENTS.md proxy normalization code. Inferred schemas are marked with a `~` in the Required column.

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

### `nuget_get_latest_package_version`

**Channel:** `nuget`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `packageName` | string | Yes | NuGet package ID (e.g. `"Newtonsoft.Json"`) |
| `projectName` | string | ~ | Project name for target-framework resolution |

### `nuget_get_package_context`

**Channel:** `nuget`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `packageName` | string | Yes | NuGet package ID |
| `projectName` | string | ~ | Project context for version/dependency resolution |

### `nuget_upgrade_packages_to_latest`

**Channel:** `nuget`

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `projectName` | string | ~ | Target project (omit for whole solution) |

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
