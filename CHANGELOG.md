# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-05-03

### Added

- **Monitoring authentication** — `MonitoringAuthClient` with OAuth token and login/password support, session caching with 1-hour TTL, and automatic re-login on 401
- **Dashboard: Running queries** — new "Running queries" counter fetched from `.sys/query_sessions`
- **Dashboard: Network throughput** — "Network" metric showing MB/s traffic
- **Streaming query error detection** — error/failed/suspended status highlighted with red icon and rich tooltip (status, retry count, suspension info, issues with severity)
- **Path-aware autocomplete** — context-sensitive completions inside backtick strings: relative paths shown without backtick wrapping, absolute insertions outside backticks
- **Type decoder** — decodes base64-encoded `STRING` and `YSON` column values in query results; supports nested `Optional`, `List`, `Dict`, `Struct`, `Tuple`
- **Auto-computed Monitoring URL** — connection form derives the monitoring URL from host/secure fields; manual override unlocks the field
- **SVG icons** — new `activitybar-icon.svg` (monochrome, uses `currentColor`) and `icon.svg` (256×256, colored) for activity bar and Marketplace

## [0.1.0] - 2026-03-04

### Added

- **Connection management** — create, edit, delete, and switch between YDB connections
- **Authentication methods** — anonymous, login/password, token, service account (key file), and metadata
- **Custom TLS CA certificate** support via `ydb.tlsCaCertFile` setting
- **Schema navigator** — browse tables, column tables, topics, views, external data sources, external tables, data transfers, and streaming queries
- **YQL editor** — syntax highlighting for `.yql` files, keyword autocompletion
- **Query Workspace** — Monaco-based editor with persistent state across VS Code restarts
- **Query execution** — run YQL queries with `Ctrl+Enter` / `Cmd+Enter`, paginated results
- **Result visualization** — table view, JSON view, and bar charts
- **Query explain** — visual query execution plan
- **DDL generation** — generate CREATE statements for any database object
- **Session management** — view and manage active YDB sessions
- **Permissions viewer** — inspect ACL for database objects
- **Database load dashboard** — monitor database performance metrics
- **Streaming query support** — preview topic data in real time
- **MCP server** — embedded HTTP SSE server (default port 3333) exposing YDB to AI assistants
  - Tools: `ydb_list_connections`, `ydb_query`, `ydb_describe_table`, `ydb_list_directory`, `ydb_list_all`, `ydb_yql_help`
- **YQL RAG** — download and search YQL documentation index for AI-assisted query writing
  - Keyword search (no dependencies)
  - Semantic vector search via Ollama (`nomic-embed-text`)
  - Auto-detection of YDB server version and matching documentation index
- **SQL dialect converter** — convert SQL dialects to YQL (panel view)
- **Connection import/export** — share connection profiles as JSON

[0.1.2]: https://github.com/ydb-platform/ydb-vscode-plugin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ydb-platform/ydb-vscode-plugin/releases/tag/v0.1.1
[0.1.0]: https://github.com/ydb-platform/ydb-vscode-plugin/releases/tag/v0.1.0
