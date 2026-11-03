# Changelog

All notable changes to skillmedic are listed here. The format follows Keep a Changelog, and versions follow Semantic Versioning.

## [Unreleased]

## [0.1.0]

The first version. Not yet published.

### Added

- `check`: finds every SKILL.md and plugin manifest under a folder and checks frontmatter, name and description quality, size and token limits, links and helper files, scripts, secrets, prompt injection and hidden characters.
- Host rules for Claude Code, the Claude API, OpenAI Codex, Cursor and Gemini CLI in `hosts/hosts.yaml`, each with the official page, a quote and the date it was checked. `skillmedic hosts` lists them, and `--host` and `--no-hosts` choose them.
- Plugin manifest checks for Claude Code, Codex and Cursor plugins, Gemini CLI extensions and Agent Plugins.
- Text, `--json`, `--html`, `--sarif` and `--badge` output, with exit codes 0, 1 and 2.
- A GitHub Action with a job summary, score output and optional SARIF and badge files.
- `eval`: measures how often a model picks the right skill for each prompt, with accuracy, flaky cases and mix-ups. Works with OpenAI, Anthropic, OpenRouter, Ollama, any OpenAI-compatible API and a mock model. Keys come only from environment variables.
- `fix`: rewrites weak descriptions and keeps a rewrite only when accuracy goes up. Files change only with `--write`.

### Security

- Skill scripts and dynamic commands are never run, links and special files are never followed or opened, and files are read through one handle so they cannot be swapped between the check and the read.
- Control, bidi and zero-width characters are shown as escapes in every output, and HTML reports use a strict Content Security Policy.
- Offensive tests with hostile skills, SECURITY.md, CodeQL, Dependabot, and workflow actions pinned to commit SHAs with `persist-credentials: false`.
