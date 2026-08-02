# LinearB — Condensed Docs Reference

Source: https://linearb.helpdocs.io/ (fetched 2026-07-29). Help center = 10 categories, ~180 articles.

## What it is

Engineering metrics + workflow automation platform. Connects Git providers, project trackers, CI/CD, incident tools and AI coding assistants to measure delivery, forecast timelines, benchmark against industry data, and automate PR workflow (gitStream) and notifications (WorkerB).

**Help center categories**: Getting Started (14) · gitStream (7) · Platform Capabilities (27) · Guides & Best Practices (59) · **Metrics Hub (90)** · Release Notes (8) · Integrations & Connectivity (36) · Troubleshooting (12) · Role-Based Playbooks (13) · WorkerB (8).

---

## Metrics glossary

### Delivery

| Metric | Definition |
|---|---|
| **Cycle Time** | End-to-end time from first commit to production |
| **Coding Time** | Time spent actively coding within the delivery cycle |
| **Pickup Time** | Time from PR creation to first review activity |
| **Review Time** | Time a PR spends in review before merge |
| **Time to Review** | Time from PR ready-for-review to first review action |
| **Time to Approve** | Time from pickup to final approval |
| **Time to Merge** | Time from approval to merge |
| **Deploy Time** | Time from merge to production deployment |
| **Time to Release** | Time from last configured deployment stage until deployment to the Release stage |

### Throughput

| Metric | Definition |
|---|---|
| **Code Changes** | Overall change rate across new code, refactor, and rework |
| **Commits** | Commit activity volume over time |
| **PRs Opened** | PRs created in the selected period |
| **Reviews** | Total review actions across PRs |
| **Merge Frequency** | Merged PR volume normalized to the time range |
| **Deploy Frequency** | How often code is released to production |
| **Active Days** | Unique days a contributor performed Git activity |
| **Done Branches** | Branches merged where a contributor was involved |

### Quality

| Metric | Definition |
|---|---|
| **New Code** | % of added lines relative to total code changes in merged PRs |
| **Refactor** | % of modified lines relative to total code changes in merged PRs |
| **Rework** | % of code changes modified *after* review activity in merged PRs |
| **PR Size** | Average lines added + modified + deleted per PR |
| **Review Depth** | Average review comments per merged PR |
| **PR Maturity** | Proportion of a PR that remained unchanged after submission |
| **PRs Merged Without Review** | Merged PRs with no recorded review activity, normalized per day |
| **Draft Pull Requests** | Separates WIP from ready-for-review |

### Reliability & DORA

| Metric | Definition |
|---|---|
| **Deploy Frequency** | How often code reaches production; LinearB identifies releases across repos |
| **CFR (Change Failure Rate)** | % of deployments associated with incidents; measures incidents worked on within a time window, mapped to deployments |
| **MTTR (Mean Time to Restore)** | Time an issue spends in "In Progress" state; depends on the configured issue start-time strategy |

DORA data quality depends on the **Deployment API** and **Incidents API** being fed.

### Balance & Activity
**Active Days**, **Active Branches**, **Done Branches**.

### AI metrics
**AI Adoption** (where AI contributes to commits, reviews, PRs — consistency, developer trust, whether AI is part of everyday flow) · **AI Tools Usage** (active users, acceptance rates, code contribution trends) · **AI Code Review Metrics** · **AI-attributed impact**. Detection comes from **integrations with the coding assistants themselves** (GitHub Copilot, Cursor, etc.), which emit usage signals — plus gitStream tagging of AI-influenced PRs.

---

## Cycle Time (the flagship metric)

**Formula**: production deployment timestamp − coding start timestamp. Only PRs that reach production are counted.

Four sequential phases:

1. **Coding Time** — first commit (or Jira *In Progress*, if configured) → PR created
2. **Pickup Time** — PR created → first review activity *(collaboration signal)*
3. **Review Time** — first review activity → PR merged
4. **Deploy Time** — merge → production *(depends on CI/CD + deployment detection config)*

Dashboard headline = average cycle time for PRs **completed** in the selected period (daily/weekly/monthly buckets); the chart shows average or percentile per bucket, **not** cumulative. Improvement levers: cut pickup delay, tighten review cycles, deploy more often, shrink batch size.

---

## Benchmarks (2026 study)

Basis: **8.1M+ pull requests, 4,813 teams, 163,820 active contributors, 42 countries**. Aggregation is **p75** (less outlier-sensitive: 75% of values fall below the threshold). Tiers: **Elite** = top 10%, **Good** = top 30%, **Fair** = top 60%, **Needs Focus** = bottom 40%.

| Metric | Elite | Good | Fair | Needs Focus |
|---|---|---|---|---|
| Coding Time | < 54 min | 54 min – 4 h | 5 – 23 h | > 23 h |
| Pickup Time | < 1 h | 1 – 4 h | 5 – 16 h | > 16 h |
| Review Time | < 3 h | 3 – 14 h | 15 – 24 h | > 24 h |
| Approve Time | < 10 h | 10 – 22 h | 23 – 42 h | > 42 h |
| Merge Time | < 1 h | 1 – 3 h | 4 – 16 h | > 16 h |
| Deploy Time | < 16 h | 16 – 106 h | 107 – 277 h | > 277 h |
| **Cycle Time** | **< 25 h** | **25 – 72 h** | **73 – 161 h** | **> 161 h** |
| Merge Frequency | > 2.0 | 2.0 – 1.2 | 1.2 – 0.66 | < 0.66 |
| Deploy Frequency | > 1.2 | 1.2 – 0.5 | 0.5 – 0.2 | < 0.2 |
| PR Size | < 100 | 100 – 155 | 156 – 228 | > 228 |
| PR Maturity | > 89% | 89 – 83% | 82 – 77% | < 77% |
| Change Failure Rate | < 1% | 1 – 4% | 5 – 17% | > 17% |
| Refactor Rate | < 11% | 11 – 16% | 17 – 22% | > 22% |
| Rework Rate | < 3% | 3 – 5% | 6 – 8% | > 8% |

(Merge/Deploy Frequency units = per contributor per day.) Article: https://linearb.helpdocs.io/article/d2v8kqzxzd-metrics-community-benchmarks

---

## Platform capabilities

Planning · Forecasting · Coaching · AI Insights · Workflow Optimization. Deep-dive areas: **LinearB AI** (27 articles), **Git glossary & advanced config** (repo monitoring, contributor management, webhooks), **User Management**, **Delivery Tracker** (project trackers, scope from Jira/Azure DevOps), **Teams**. Plus Dashboards & Reporting (17 articles), Metric Mechanics (6), Role-Based Playbooks (13).

**LinearB AI**: AI Review (AI-assisted review workflow and findings), AI Assistant (natural-language querying of metrics and trends — "Explore" mode), AI Iteration Summary for Teams (AI-generated performance overview of a completed iteration in Pulse), AI Playground, AI tool integrations.

---

## gitStream (PR automation engine)

Automates PR policies (size, ownership, risk, approvals) and routes reviews by expertise/files/teams. Works on **GitHub (cloud + server), GitLab (cloud + self-managed), Bitbucket**. AI code review powered by **Claude Sonnet 4.5**. **Managed Mode** available on the Essentials plan for simplified setup. Rules are read-only over repo metadata.

Config lives in the repo's **`.cm/` directory on the default branch** (a central "cm repo" can hold org-wide rules):

```yaml
manifest:
  version: 1.0
  automations:
    automation_name:
      on: [trigger_events]        # pr_created, commit, pr_ready_for_review
      if: [conditions]            # optional filters
      run:
        - action: action_name@v1  # code-review@v1, describe-changes@v1, add-comment@v1
          args:
            parameter: value
```

Starter automations: **AI Code Review** (`code-review@v1` — correctness, security, performance), **AI Description** (`describe-changes@v1`), **Summary Comment** (`add-comment@v1`). Also reviewer assignment, labels, naming-convention enforcement.

**AI-driven development measurement** (relevant for AI-SDLC KPIs): gitStream **tags PRs influenced by AI tools** and measures how AI-influenced PRs move through the funnel **Open → Merge → Release → No Rollback** — i.e. whether AI-assisted code ships faster, holds quality, and avoids incidents.

Articles: gitStream Start Here (`7pg8hsnne3-gs-hub`) · Supported Languages in AI Code Review (`uyzvby9nu1`) · GitHub Cloud install (`k1w3xzc8ps`) · GitHub Server custom app (`ft1k39t12u`) · GitLab install (`e3a8o2mcg9`) · Bitbucket install (`8o47mfx0sk`) · Managed Mode (`avlf1zkg6v`).

---

## WorkerB (Slack / MS Teams)

Brings notifications, alerts, review workflows and developer commands into Slack and Teams. Teams has **V1** (fully featured, deeper automation) and **V2** (lighter, limited permissions).

Alerts: personal + team-level, PR assignment, unassigned-PR detection and sharing, review requests (incl. GitHub team notifications), small-PR previews (< 5 LOC changed). Developers can **approve PRs inline in chat** and run commands without leaving the messenger.

---

## Integrations & connectivity

Categories: **Authentication & SSO** (SSO providers, SCIM provisioning — Okta only) · **Git** (multi-provider, multi-org) · **Project Management** (Jira, Azure Boards, others — powers delivery metrics, planning visibility, end-to-end tracking) · **API** · **MCP Server**. Elsewhere documented: CI/CD (via Deployment API), incident tools (via Incidents API), AI coding assistants (Copilot, Cursor…), Slack/Teams.

### API (`/category/c33bdxypqc-api-hub`)

| API | Purpose |
|---|---|
| **Deployment API** | Report deployments from CI/CD; tracks merged branches in releases |
| **Incidents API** | Submit incident data → powers CFR and MTTR |
| **External Metrics API** | Push third-party metrics (code coverage, security scanners, CI) and attach them to deployments |
| **Measurements v2 API** | **Export pre-computed metrics derived from Git data** for custom dashboards/analytics |
| **Services API** | Define services + their repos so DORA/deployment/incident metrics attribute correctly |
| **Teams v2 API** | Programmatic team creation/management |
| **Users API** | Provisioning and identity sync from external IdPs |

> For pulling LinearB data into an external warehouse/dashboard, **Measurements v2** is the endpoint that matters; **Services** is the prerequisite for correct attribution.

### MCP Server (`/category/jxp2zatd7p-mcp-server`)

OAuth-connected MCP server exposing engineering data to **Claude, Cursor, VS Code, Codex** and other clients. Query metrics and PR data in natural language, build custom reports, benchmark teams — without the dashboard. Kubernetes deployment supported with tokens injected via Kubernetes Secrets (no hardcoded credentials).

---

## Useful URLs

- Help center: https://linearb.helpdocs.io/
- Cycle Time: https://linearb.helpdocs.io/article/v9pckvmkbj-cycle-time
- Coding Time: https://linearb.helpdocs.io/article/8r4q5ipyzn-coding-time-metric
- Deploy Frequency: https://linearb.helpdocs.io/article/gm1zmtps8p-velocity-metric
- Metrics glossary: https://linearb.helpdocs.io/article/sth7bn9zrd-metrics-glossary-html
- Metrics Hub: https://linearb.helpdocs.io/category/8icx91ii3s-metrics-hub
- Delivery metrics: `/category/zuxjtdypj4-delivery-metrics` · Throughput: `/category/gt425x6wfe-throughput-metrics` · Quality: `/category/hhc8s9rrd7-quality-metrics` · DORA: `/category/502chdkltx-reliability-dora-metrics` · Balance: `/category/bf7phz5mrt-balance-activity-metrics` · AI: `/category/ohg3q0csen-ai-metrics` · AI Review: `/category/kkr2miylri-ai-review-metrics` · Dashboards: `/category/ylbapn01jf-dashboards-reporting` · Benchmarks: `/category/jwvtsm9slj-benchmarks`
- Benchmarks article: https://linearb.helpdocs.io/article/d2v8kqzxzd-metrics-community-benchmarks
- API hub: https://linearb.helpdocs.io/category/c33bdxypqc-api-hub
- MCP server: https://linearb.helpdocs.io/category/jxp2zatd7p-mcp-server
- gitStream: https://linearb.helpdocs.io/category/y52ropp0hk-gs-hub
- WorkerB: https://linearb.helpdocs.io/category/f6fe1wledz-worker-b
