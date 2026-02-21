# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/ydb-platform/ydb-vscode-plugin/releases/tag/v0.1.0
