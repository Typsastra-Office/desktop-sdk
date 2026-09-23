---
name: Multilingual documents
description: Use the correct font for non-Latin scripts (Khmer, Lao and others).
default-enabled: false
---

# Skill: Multilingual documents

When the document contains non-Latin scripts, use the correct font so the text
renders properly.

- Khmer -> `Khmer OS Siemreap`
- Lao -> `Phetsarath OT`
- Always follow a font rule set by the user if one exists.

Enforcement:

- After inserting or editing content that contains the script, call
  `enforce_font({ script: "khm", font: "Khmer OS Siemreap" })` (or the matching
  script) so the rule is applied across the whole document deterministically,
  not just suggested.
- Do not mix scripts in a single run of text; keep each script's font separate.
