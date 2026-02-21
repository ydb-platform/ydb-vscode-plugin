# YDB for VS Code

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.75.0-007ACC.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](https://github.com/ydb-platform/ydb-vscode-plugin/releases)

A Visual Studio Code extension for working with [YDB](https://ydb.tech/) databases.

## Features

- **Connection management** — login/password, service account, anonymous, token, and metadata authentication
- **Schema navigation** — browse tables, column tables, topics, views, external data sources, and other objects
- **YQL editor** — syntax highlighting, autocompletion, and keyword suggestions
- **Query execution** — run YQL queries and visualize results as tables, JSON, or charts
- **Explain** — view query execution plans
- **Session management** — monitor and manage active sessions
- **Permissions viewer** — inspect ACL for database objects
- **DDL generation** — generate CREATE statements for any database object
- **Database load monitoring** — built-in dashboard for performance metrics
- **MCP server** — expose your YDB connections to AI assistants (Claude Code and others)
- **YQL RAG** — semantic and keyword search over YQL documentation for AI-assisted query writing
- **SQL dialect converter** — convert SQL dialects to YQL

## Installation

### From GitHub Releases

Download the latest `.vsix` file from the [Releases page](https://github.com/ydb-platform/ydb-vscode-plugin/releases) and install it:

```bash
code --install-extension ydb-vscode-plugin-0.1.0.vsix
```

Or via the VS Code UI:

1. Open VS Code
2. Go to the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Click `...` (three dots) in the top-right corner
4. Select **Install from VSIX...**
5. Choose the downloaded `.vsix` file

### From Yandex Cloud Storage

```bash
curl -O https://storage.yandexcloud.net/ydb-dbeaver/vscode/ydb-vscode-plugin-latest.vsix
code --install-extension ydb-vscode-plugin-latest.vsix
```

After installation, reload VS Code to activate the extension.

## Getting Started

1. After installation, click the **YDB** icon in the Activity Bar on the left
2. Click **Add Connection** to create a new connection
3. Fill in the connection parameters: endpoint, database path, and authentication method
4. Once connected, the Navigator panel shows your database schema
5. Open the Query Workspace with `Cmd+Shift+Q` / `Ctrl+Shift+Q`
6. Write YQL queries and run them with `Cmd+Enter` / `Ctrl+Enter`

## Updating

Download the new `.vsix` from the Releases page and re-run the install command. VS Code will replace the previous version automatically.

## MCP Integration (AI Assistants)

The extension runs a built-in [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, which allows AI assistants such as Claude Code to query your YDB databases directly.

### Port configuration

The server runs on port **3333** (localhost only) by default. Change it in VS Code settings:

```json
{
  "ydb.mcpPort": 3333
}
```

If the port is already in use, the extension will show a warning and continue without MCP.

### Connecting Claude Code

1. Make sure the YDB extension is running in VS Code and at least one connection is added in the **Connections** panel.

2. Register the MCP server in Claude Code:

```bash
claude mcp add --transport sse ydb http://localhost:3333/sse
```

3. Verify the connection:

```bash
claude mcp list
```

### Available MCP Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `ydb_list_connections` | — | List all connections configured in the plugin |
| `ydb_query` | `connection`, `sql` | Execute a YQL query |
| `ydb_describe_table` | `connection`, `path` | Get table schema (columns, primary key) |
| `ydb_list_directory` | `connection`, `path?` | List directory contents |
| `ydb_list_all` | `connection`, `path?`, `limit?`, `offset?` | Recursively list all objects |
| `ydb_yql_help` | `query`, `connection?` | Search YQL documentation (requires RAG to be enabled) |

The `connection` parameter is the connection name as shown in the Connections panel. System objects (names starting with `.`) are excluded from results.

## YQL Documentation Search (RAG)

The extension can download a YQL documentation index and use it for AI-assisted query writing. When RAG is active, the `ydb_yql_help` MCP tool lets Claude Code look up the correct YQL syntax during a conversation.

### Enabling RAG

1. Open connection settings (click the pencil icon next to a connection in the Connections panel).
2. Check **Use RAG** — the plugin will automatically detect the YDB server version, find the matching documentation index in the cloud, and download it.
3. Status is shown next to the checkbox: **● Running** — RAG is active, **○ Not running** — disabled or index not loaded.

If something goes wrong, use the **Detect & Download RAG** button (auto-detects version) or **Download RAG** (force re-download).

### Semantic Search via Ollama (optional)

By default RAG uses **keyword search**, which works without any additional dependencies.

For **semantic (vector) search**, you need [Ollama](https://ollama.com/) with an embedding model:

```bash
# Install Ollama from https://ollama.com/
ollama pull nomic-embed-text
```

Then set the URL in VS Code settings:

```json
{
  "ydb.ragOllamaUrl": "http://localhost:11434",
  "ydb.ragOllamaModel": "nomic-embed-text"
}
```

The Ollama status is shown directly in the connection settings form, with a **Check** button to verify availability. If Ollama is unavailable, the search automatically falls back to keyword mode.

### How RAG Works in Claude Code

Once RAG is enabled, Claude Code automatically calls `ydb_yql_help` before writing YQL queries. You can also ask for help directly:

```
Show me the syntax for WINDOW functions in YQL
```

```
How do I write an UPSERT in YDB?
```

Every response from the tool indicates which search method was used:
- `[Search method: Ollama vector search (nomic-embed-text)]` — semantic search
- `[Search method: keyword search]` — keyword search

### Connection Switching

When you switch between connections, RAG is automatically unloaded from memory and re-enabled only for connections that have **Use RAG** checked.

## Usage with dbt

Claude Code connected via MCP can automatically explore the database schema when working on dbt projects. A typical workflow:

1. AI calls `ydb_list_connections` to discover available connections
2. Calls `ydb_list_all(connection="prod")` to get the full list of tables
3. Calls `ydb_describe_table` for specific tables as needed
4. Generates or validates dbt models and tests

## Development

```bash
npm install        # Install dependencies
npm run compile    # Compile TypeScript
npm test           # Run tests
```

Press `F5` in VS Code to launch an Extension Development Host for debugging.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on setting up a development environment and submitting pull requests.

## License

[Apache 2.0](LICENSE) — Copyright 2024 Yandex LLC
