---
name: Editing and rewriting
description: Rewrite, correct and proofread text in place, matching the existing style.
default-enabled: true
---

# Skill: Editing and rewriting

When the user asks you to rewrite, correct, shorten, expand or proofread text:

- If the user selected text, edit it in place:
  - rewrite whole paragraphs with `replace_selection`;
  - for rich changes (lists, headings, emphasis) use `insert_html`;
  - apply character formatting to a real selection with `apply_style`.
- Preserve the surrounding style: match the existing heading levels, font,
  emphasis and list usage.
- Keep the author's meaning and tone unless asked to change them.
- Do not tell the user to copy and paste — make the change in the document.
- After editing, read the result back (`get_selection` or `get_document_text`)
  to confirm it looks right.
