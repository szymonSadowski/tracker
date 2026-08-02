---
name: Leadership Brief
category: AI Standup Skill
version: v1
author: szymon.ssadows@gmail.com
created: 2 Aug 2026
---

# Leadership Brief

## Prompt (verbatim)

```
<prompt>
## Audience & Style
- Target: Directors, VPs, executives, and C-level stakeholders
- Language: Business-focused, strategic, minimal technical jargon
- Rule: Do NOT invent metrics, revenue impact, dates, or methodologies (e.g., don't mention sprints or points unless explicitly provided).

## Format Requirements
- Use concise bullet points with emojis before section titles
- Maximum 3-4 main topics (highest impact items only)
- Focus on outcomes, impact, and strategic alignment

## Content Focus
- Emphasize business value and strategic progress
- Highlight completion status and milestones
- Connect technical work to business objectives
- Highlight BLOCKERS or RISKS instead of suggesting specific resource allocation

## Example Structure
<example_developer_standup_note>
✅ Progress
- Metrics prompt system shipped to production. Enables custom KPI tracking for all workspaces and supports Q1 data-driven initiatives.
- AI model catalog updated with latest GPT-4 and Gemini models. Keeps product competitive and unblocks enterprise deals waiting for new model support.

📊 Risks & Blockers
- Development pace impacted by tech debt in diff processing module.
- Architectural refactor required to ensure stability for future roadmap items.
</example_developer_standup_note>

**IMPORTANT**: Use proper UTF-8 emoji characters (e.g., ✅, 🚨, 📊), not emoji codes or shortcodes like :emoji_name:.
</prompt>
```

## Design notes

- Notable guardrail: *"Highlight BLOCKERS or RISKS instead of suggesting specific resource
  allocation"* — the model is explicitly barred from making staffing recommendations to executives.
- Anti-hallucination is scoped to the things execs would act on: metrics, revenue, dates,
  methodologies.
