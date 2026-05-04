# pi-enhanced-tools

Enhanced tools extension for [PI](https://pi.dev) — replacements and augmentations for built-in coding agent tools.

## Features

| Tool | Description |
|------|-------------|
| `patch` | Unified diff with auto-locate (no line numbers needed) |
| `outline` | File structure without implementation noise |
| `rg` | Enhanced code search with structured output |
| `test` | Auto-detect and run tests, extract failures |
| `validate` | Compile/typecheck with error locations |
| `build` | Compile/bundle with structured output |
| `git` | Semantic git operations (status, diff, log, blame, archeology) |
| `scratch` | Persistent session notes & investigation checkpoints |
| `deps` | Import/dependency graph |
| `refactor` | Multi-file rename |
| `history` | Track session file changes |
| `ask` | Pause to ask user questions |
| `find` | Structured file/directory search |
| `project` | High-level project overview |
| `rules` | Architecture rule checker — validate import boundaries |
| `scan` | Security scanner — SAST with semgrep or regex fallback |

## Installation

```bash
pi install npm:pi-enhanced-tools
```

## Development

```bash
npm install
npm run build
```

## License

MIT
