---
name: Daily Standup Summary (3x2)
category: AI Standup Skill
version: v1
default: true
author: szymon.ssadows@gmail.com
created: 2 Aug 2026
---

# Daily Standup Summary (3x2)

Category description in the UI: *"Create a custom format for daily summary updates and standup notes"*

## Prompt (verbatim)

```
<prompt>
## Audience & Style
- Target: Semi-technical product owners and managers
- Language: Simple, direct, minimal jargon and buzzwords
- Clarity: Explain each point as if to someone with zero context

## Format Requirements
- Use bullet points with relevant emojis
- Maximum 3 main points
- Each main point must have 1-2 sub-points
- Sub-points should explain HOW the main point was achieved

## Content Focus
- Accurately reflect work status — distinguish completed/shipped work from in-progress work
- Use "completed" or "shipped" only for work with clear evidence of shipping (e.g., merged PR, confirmed deployment)
- Use "progressed on", "worked on", or "advanced" for work still in progress
- Highlight product value and stakeholder benefits
- Keep descriptions concise (one sentence per point maximum)
- When project areas are identified (e.g., specific apps, packages, or services), reference them by name instead of generalizing to "the codebase"

## Example Structure
<example_developer_standup_note>
- Shipped metrics prompt versioning fix (PR merged)
    - Implemented database-level constraint for metrics prompts — prevents race conditions and ensures only one active prompt per workspace
    - Added PostgreSQL trigger to auto-disable conflicting prompts — cleaner data integrity without client-side validation
- Progressed on AI model catalog update (PR open, pending review)
    - Built initial implementation for latest GPT, Claude, and Gemini models — keeps users on cutting-edge AI options
    - Designed UI for unreleased models (disabled state) — balances future-proofing with current availability
- Worked on extension startup reliability improvements
    - Enhanced error handling for chat diff processing failures
    - Restored path traversal validation in diff processing — prevents security issues with file paths
</example_developer_standup_note>

**IMPORTANT**: Use proper UTF-8 emoji characters (e.g., 🎯, 😤, 💡), not emoji codes or shortcodes like :emoji_name:.
</prompt>
```

## Design notes

- The "3x2" in the name is the output shape: **3 main points × 2 sub-points**.
- Anti-hallucination rule is expressed as an evidence rule ("merged PR, confirmed deployment"), not
  a generic "don't make things up".
- The prompt ships with a full worked example inside `<example_developer_standup_note>` tags — the
  example is the spec.
