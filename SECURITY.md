# Security policy

skillmedic reads Agent Skills and plugins that you may not trust yet. It is built so that reading a hostile skill is safe.

## Reporting a vulnerability

Please report privately through [GitHub private vulnerability reporting](https://github.com/jmozez/skillmedic/security/advisories/new). Do not open a public issue. I aim to reply within a few days and will credit you in the advisory unless you would rather not be named.

Only the latest release is supported.

## Threat model

| Threat | What skillmedic does |
| --- | --- |
| A skill ships scripts, hooks or `` !`command` `` lines | Never runs them. `check` only reads files, `eval` only sends names and descriptions to the model you choose, and `fix` only edits the `description` line. Tests use marker files to prove nothing ran. |
| Links that point out of the folder | Never follows them. Links and FIFOs are skipped with `lstat`, and `fix --write` refuses anything that is not a regular file or that changed since it was read. |
| Huge files, deep folders or YAML alias bombs | Files over 1,000,000 bytes are not read, walks stop at a depth and file limit, and YAML aliases are capped. |
| Terminal escapes, bidi or zero-width characters | Shown as escapes in text output, and reported by the `hidden-characters` rule, including YAML `\u` escapes. |
| HTML, SARIF or Markdown injection in reports | HTML is escaped and served with a strict Content Security Policy, links must be https, and JSON and SARIF are built with `JSON.stringify`. The GitHub Action escapes Markdown in its summary. |
| Prompt injection aimed at the model in `eval` and `fix` | Skill text goes into a delimited data block, the model can only answer with a tool call naming a listed skill, and rewritten descriptions are rejected if they trip the safety rules. |
| Secrets in skills | Reported with a masked value. The secret itself never appears in any output. |
| API keys | Read from environment variables only. There is no option that takes a key, and redirects are refused so keys are not sent to another host. |

## Not a vulnerability

- A skill that skillmedic rates well but is still harmful. The rules find common problems; they are not a guarantee.
- What a model does with a skill after you install it.
- Findings from host rules that change when a host changes its own documentation.
