# Contributing to YDB for VS Code

Thank you for your interest in contributing! This document covers how to set up a development environment, run tests, and submit changes.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [npm](https://www.npmjs.com/) 9 or later
- [Visual Studio Code](https://code.visualstudio.com/) 1.75 or later
- Git

## Setting Up the Development Environment

```bash
git clone https://github.com/ydb-platform/ydb-vscode-plugin.git
cd ydb-vscode-plugin
npm install
npm run compile
```

## Running the Extension

Press `F5` in VS Code (or use **Run → Start Debugging**) to launch an Extension Development Host — a separate VS Code window with the extension loaded. Changes to source files require recompiling (`npm run compile`) and reloading the host window (`Ctrl+R` / `Cmd+R`).

For incremental builds during development:

```bash
npm run watch
```

## Running Tests

```bash
./run-tests.sh
```

This script runs `npm install`, compiles the TypeScript, and executes the full test suite via [Vitest](https://vitest.dev/).

To run tests directly (after compiling):

```bash
npx vitest run
```

**Tests are required for all functional changes.** Every new feature or bug fix must include corresponding test coverage.

## Project Structure

```
src/
├── commands/          # VS Code command handlers
├── models/            # Data models and TypeScript interfaces
├── services/          # Business logic (connection, query, MCP, RAG)
├── test/              # Test files (mirrors src/ structure)
│   ├── __mocks__/     # VS Code API mock
│   └── helpers/       # Test utilities
├── utils/             # Shared utilities (DDL, type formatting, etc.)
├── views/             # Webview panels and tree view providers
└── extension.ts       # Extension entry point
```

## Code Style

- TypeScript strict mode is enabled — all types must be explicit
- Run `npm run lint` before submitting a PR
- Follow the existing naming conventions and module structure
- Keep services stateless where possible; side effects belong in command handlers

## Submitting a Pull Request

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes, add tests, and ensure everything passes:
   ```bash
   npm run lint
   ./run-tests.sh
   ```

3. Write a clear commit message following the [Conventional Commits](https://www.conventionalcommits.org/) format:
   ```
   feat: add support for external tables in navigator
   fix: handle connection timeout gracefully
   ```

4. Push your branch and open a Pull Request against `main`.

5. Fill in the PR description: what changed, why, and how it was tested.

## Reporting Issues

Please use [GitHub Issues](https://github.com/ydb-platform/ydb-vscode-plugin/issues) to report bugs or suggest features. Include:

- VS Code version
- Extension version
- Steps to reproduce
- Expected vs. actual behavior
- Relevant logs (from **Output → YDB** channel)

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
