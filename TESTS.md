# VS Tool Test Prompts

## File Operations

| Tool | Test Prompt |
|------|-------------|
| `create_file` | Create a file called `hello.cs` that prints 'Hello World' to the console |
| `replace_string_in_file` | In `Program.cs`, change the string 'Hello' to 'Greetings' |
| `multi_replace_string_in_file` | Replace all instances of 'var' with 'explicit type' across `Program.cs` and `Services.cs` |
| `remove_file` | Delete the file `temp.log` |
| `get_file` | Show me lines 10-30 of `Startup.cs` |

## Search & Navigation

| Tool | Test Prompt |
|------|-------------|
| `grep_search` | Search for all uses of 'IDisposable' in C# files |
| `find_symbol` | Find all references to the `ConfigureServices` method |
| `code_search` | Semantically search for code related to authentication middleware |
| `file_search` | Find files named `*Controller.cs` |
| `detect_memories` | What do you remember about this project? |

## Project & Solution

| Tool | Test Prompt |
|------|-------------|
| `get_files_in_project` | List all files in the current project |
| `get_projects_in_solution` | What projects are in this solution? |

## Build & Test

| Tool | Test Prompt |
|------|-------------|
| `run_build` | Build the solution |
| `run_tests` | Run all unit tests |
| `get_tests` | Show me all available tests |
| `get_errors` | Show me the current build errors |
| `get_output_window_logs` | Show me the build output window logs |

## Terminal

| Tool | Test Prompt |
|------|-------------|
| `run_command_in_terminal` | Run `dotnet --version` in the terminal |
| `get_background_terminal_output` | Show output from the background terminal |

## NuGet

| Tool | Test Prompt |
|------|-------------|
| `nuget_get_latest_package_version` | What's the latest version of Newtonsoft.Json? |
| `nuget_get_package_context` | Show me details about the Serilog package we're using |
| `nuget_upgrade_packages_to_latest` | Upgrade all NuGet packages to their latest stable versions |
| `nuget_fix_vulnerable_packages` | Fix any vulnerable NuGet packages in the solution |

## Web / Documentation

| Tool | Test Prompt |
|------|-------------|
| `lookup_vs` | Look up the MSDN docs for `System.Text.Json.JsonSerializer` |
| `get_web_pages` | Fetch the contents of https://learn.microsoft.com/en-us/dotnet/core/ |

## Planning

| Tool | Test Prompt |
|------|-------------|
| `plan` | Create a plan to add JWT authentication to this project |
| `adapt_plan` | The database is SQLite not SQL Server, update the plan |
| `update_plan_progress` | Mark step 2 of the plan as completed |
| `record_observation` | Record that the project uses .NET 9 with minimal APIs |
| `signal_plan_ready` | I'm ready to execute the authentication plan |
| `finish_plan` | The plan is complete |
| `clarify_requirements` | Ask me questions to clarify the authentication requirements |

## Agent / Subagents

| Tool | Test Prompt |
|------|-------------|
| `run_subagent` | Use a subagent to analyze the `Services/` folder and summarize what each service does |
| `search_agent` | Search the web for best practices on EF Core performance tuning |
| `profiler_agent` | Profile the `GetOrders` method in `OrderService.cs` for performance issues |

## Azure

| Tool | Test Prompt |
|------|-------------|
| `query_azure_resource_graph` | List all resource groups in my Azure subscription |

## Modernization

| Tool | Test Prompt |
|------|-------------|
| `start_modernization` | Start modernizing this .NET Framework project to .NET 9 |
| `task_complete` | (used internally to signal task completion) |

---

## Notes

- **VS Insiders (18.7+)**: Supports `get_file`, `grep_search`, `find_symbol` with schemas that differ from standard Copilot
- **VS 2026**: Supports `lookup_vs` for MSDN/.NET API/NuGet doc lookups
- Schemas are auto-detected from the client at request time and logged once per session
