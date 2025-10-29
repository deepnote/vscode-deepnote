![Deepnote dragon](deepnote-dragon.png) <!--- This is just placeholder for deepnote + vscodde logo --->

[![CI](https://github.com/deepnote/vscode-deepnote/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/deepnote/vscode-deepnote/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/deepnote/vscode-deepnote/graph/badge.svg?token=NH066XG7JC)](https://codecov.io/gh/deepnote/vscode-deepnote)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=Deepnote.vscode-deepnote)

A powerful [Visual Studio Code](https://code.visualstudio.com/) extension that brings [Deepnote](https://deepnote.com/) notebook capabilities directly into your favorite editor. Work with sleek AI notebooks featuring SQL blocks, database integrations, and reactive blocks - all within VS Code.

---
![Deepnote Projects](./images/deepnote-projects.png)

---
# 🚀 Deepnote in VS Code - data notebook for AI era
Run Deepnote locally inside VS Code — not Jupyter — and unlock the next generation of data workflows:
- 🧠 **SQL in VS Code** — Run SQL queries out of the box, no extensions needed
- 🧩 **Rich block types** — Combine Python, Markdown, data visualizations, tables, and more — all in one place
- 🔐 **Native database connections** — Securely connect to Snowflake, BigQuery, Postgres, and 60+ other sources via VS Code’s encrypted SecretStorage API
- ⚙️ **Init notebooks** — Auto-run setup code (dependencies, env setup) before execution
- 📦 **Smart requirements** — Generate `requirements.txt` automatically for reproducible runs

🐍 **Jupyter kernel, upgraded**
- ⚡ **Deepnote kernel** — Fully `.ipynb-compatible`, tuned for modern data workflows
- 🔁 **Kernel control** — Restart, interrupt, and switch seamlessly

🌐 **Deepnote ecosystem integrations**
- 🔃 **Auto-refresh** — Instantly detects file and data changes
- 🧮 **Multi-notebook support** — Work across multiple notebooks in one unified project
- ☁ **Cloud collaboration** — Switch between local VS Code and Deepnote Cloud to collaborate live on the same file with your team

## 📋 Requirements

- **Visual Studio Code** 1.103.0 or higher
- **Python** 3.8 or higher (for running notebooks)
- **Node.js** 22.15.1 or higher (for development)

## 🎯 Getting started

1. Open VS Code
2. Press `Cmd+P` or `Ctrl+P` to open Quick Open
3. Type `ext install Deepnote.vscode-deepnote`
4. Press Enter

Or install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Deepnote.vscode-deepnote)

### Opening your first Deepnote notebook

1. Open a folder containing `.deepnote` project files
2. Look for the Deepnote icon in the Activity Bar (sidebar)
3. Click on a notebook in the Deepnote Explorer to open it
4. Select a Python kernel when prompted
5. Start coding!

## 📖 Usage

### Command palette

Open the Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`) and type `Deepnote` to see all available commands:

| Command                            | Description                                        |
| ---------------------------------- | -------------------------------------------------- |
| `Deepnote: Refresh Explorer`       | Refresh the Deepnote project explorer              |
| `Deepnote: Open Notebook`          | Open a specific notebook from a Deepnote project   |
| `Deepnote: Open File`              | Open the raw .deepnote project file                |
| `Deepnote: Reveal in Explorer`     | Show active notebook information in the explorer   |
| `Deepnote: Manage Integrations`    | Configure database connections and credentials     |
| `Deepnote: New Project`            | Create a new Deepnote project                      |
| `Deepnote: Import Notebook`        | Import an existing notebook into your project      |
| `Notebook: Select Notebook Kernel` | Select or switch kernels within your notebook      |
| `Notebook: Change Cell Language`   | Change the language of the cell currently in focus |

### Database integrations

Configure database connections for SQL blocks:

1. Open Command Palette
2. Run `Deepnote: Manage Integrations`
3. Add your database credentials (PostgreSQL, BigQuery, etc.)
4. Use SQL blocks in your notebooks with the configured integrations

Credentials are securely stored using VS Code's encrypted storage and never leave your machine.

### Working with SQL Blocks

SQL blocks allow you to query databases directly from your notebooks:

```sql
-- Query your PostgreSQL database
SELECT * FROM users WHERE created_at > '2024-01-01'
```

Results are displayed as interactive tables that you can explore and export.

## 🛠️ Quick start for developers

Want to contribute? Check out our [Contributing Guide](CONTRIBUTING.md) for detailed setup instructions.
- Setting up your development environment
- Running tests
- Building the extension
- Submitting pull requests

## 📚 Documentation

- **[Architecture](architecture.md)** - Technical architecture and design decisions
- **[Deepnote Kernel Implementation](DEEPNOTE_KERNEL_IMPLEMENTATION.md)** - Details on the custom Jupyter kernel
- **[Integrations & Credentials](INTEGRATIONS_CREDENTIALS.md)** - How database integrations work
- **[Contributing Guide](CONTRIBUTING.md)** - How to contribute to the project

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🐛 Issues & support

- **Bug reports**: [GitHub issues](https://github.com/deepnote/vscode-deepnote/issues)
- **Feature requests**: [GitHub discussions](https://github.com/deepnote/deepnote/discussions)
- **Questions**: [GitHub discussions](https://github.com/deepnote/deepnote/discussions)

## 🔗 Try Deepnote for free at:

- [Deepnote](https://deepnote.com/) - Collaborative data science notebook platform
- [VS Code Extension for Deepnote](https://marketplace.visualstudio.com/items?itemName=Deepnote.vscode-deepnote) - Python language support for VS Code
- [Cursor extesion for Deepnote](https://open-vsx.org/extension/Deepnote/vscode-deepnote)
- [Windsurf extension for Deepnote](https://open-vsx.org/extension/Deepnote/vscode-deepnote)
Made with 💙 by the Deepnote team
