# Data model (ER)

Solid = observed table. Dashed note = `[inferred]`. See [../data-model.md](../data-model.md) for
evidence per entity.

```mermaid
erDiagram
    PROFILE {
        string slug
        string email
        string about_me
        bool meme_spice_up
        string github_handle
    }
    WORKSPACE {
        string slug
        string name
        string description
        json data_controls
    }
    TEAM {
        string slug
        string name
        string timezone
        string slack_channel
    }
    WORKSPACE_MEMBERSHIP {
        enum role "Member | Owner"
    }
    TEAM_MEMBERSHIP {
        enum role "Lead | member"
    }
    CHAT_SESSION {
        timestamp started_at
        string editor
        string model
    }
    CHAT_ANALYSIS_SUMMARY {
        string task_type
        string phase
        string urgency
        string intent "plan | impl"
        int quality_score
        json tools_skills_agents
    }
    GITHUB_EVENT {
        string type "PR | issue"
        string author_user_id
        timestamp opened_at
        timestamp merged_at
    }
    SKILL {
        string name
        enum type "ai_standup | ai_team_standup | cheatcode | ask_zest"
        text content
        bool is_default
        bool enabled
        int position
    }
    REPORT {
        string name
        string slug
        enum scope "company | team"
        json destinations
        json trigger
        bool active
    }
    REPORT_RUN {
        timestamp ran_at
        enum status
        json delivery_results
    }
    TIMELINE_EVENT {
        string type "zest/standup | github | ask_zest"
        json payload
    }
    TEAM_TARGET {
        int ai_tasks
        int ten_x_time
        int ai_practices
        int ai_time
        int agents_ran
        int prs_open
        int prs_merged
    }

    PROFILE ||--o{ WORKSPACE_MEMBERSHIP : ""
    WORKSPACE ||--o{ WORKSPACE_MEMBERSHIP : ""
    WORKSPACE ||--o{ WORKSPACE_INVITATION : ""
    WORKSPACE ||--o{ TEAM : ""
    TEAM ||--o{ TEAM_MEMBERSHIP : ""
    PROFILE ||--o{ TEAM_MEMBERSHIP : ""
    TEAM ||--|| TEAM_TARGET : ""
    PROFILE ||--o{ CHAT_SESSION : ""
    CHAT_SESSION ||--|| CHAT_ANALYSIS_SUMMARY : ""
    WORKSPACE ||--o{ GITHUB_INSTALLATION : ""
    GITHUB_INSTALLATION ||--o{ GITHUB_REPOSITORY : ""
    GITHUB_REPOSITORY ||--o{ GITHUB_EVENT : ""
    WORKSPACE ||--o{ SKILL : ""
    SKILL ||--o{ SKILL_VERSION : ""
    SKILL ||--o{ REPORT : "report type"
    PROFILE ||--o{ REPORT : owns
    REPORT ||--o{ REPORT_RUN : ""
    REPORT_RUN ||--o{ TIMELINE_EVENT : ""
    CHAT_ANALYSIS_SUMMARY ||--o{ TIMELINE_EVENT : ""
    GITHUB_EVENT ||--o{ TIMELINE_EVENT : ""
    PROFILE ||--o{ PERSONAL_ACCESS_TOKEN : ""
    WORKSPACE ||--o| SLACK_INSTALLATION : ""
    WORKSPACE ||--|| SUBSCRIPTION : ""
```

Attribute lists on `CHAT_ANALYSIS_SUMMARY`, `SKILL`, `REPORT`, `TIMELINE_EVENT` and `TEAM_TARGET`
are `[inferred]` from UI columns, RPC names and skill prompt text — they are a reasonable starting
schema, not a transcription.
