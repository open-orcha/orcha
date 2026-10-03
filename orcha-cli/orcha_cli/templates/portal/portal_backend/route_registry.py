"""Import cohesive route modules whose decorators register the complete API."""

from portal_backend import (
    active_conversation_routes,
    agent_config_history_routes,
    agent_digest_routes,
    agent_event_routes,
    agent_model_routes,
    agent_notification_routes,
    agent_performance_routes,  # agent performance (evals-lite)
    agent_profile_routes,
    agent_reachability_routes,
    agent_registration_routes,
    agent_request_box_routes,
    agent_self_wake_routes,
    agent_spend_routes,
    agent_suggestion_routes,
    agent_task_claim_routes,
    agent_worktree_routes,  # agent worktree clean-up (mig 067)
    agent_wake_policy_routes,
    attachment_routes,
    budget_routes,
    code_github_edit_routes,
    code_space_routes,
    code_workingtree_routes,
    container_control_routes,
    container_event_routes,
    container_lifecycle,
    container_lifecycle_routes,
    container_metrics_routes,
    container_pairing_routes,
    container_request_list_routes,
    container_snapshot_routes,
    container_task_list_routes,
    container_token_usage_routes,
    conversation_read_routes,
    conversation_write_routes,
    dashboard_routes,
    deliverables_routes,  # non-code task deliverables (mig 061)
    decision_routes,
    device_token_routes,
    embodiment_token_routes,
    evidence_routes,  # proof-of-work evidence packs (mig 058)
    file_raw_routes,  # raw bytes for file previews (images, PDF, media)
    github_hub_routes,
    github_pat_routes,
    github_repo_browse_routes,
    github_routes,
    goal_ancestry_routes,  # goal ancestry: task goal chain + parent link
    identity_routes,
    llm_key_routes,
    member_routes,
    notification_pref_routes,  # mig 063: fine-grained notification preferences
    model_setting_routes,
    onboarding_routes,
    org_chart_routes,
    orphan_lease_routes,
    persona_protocol_routes,
    plan_routes,
    plan_usage_routes,  # desktop plan-usage snapshots for mobile (mig 069)
    project_export_library_routes,  # DoD presets + skills library (mig 059)
    project_export_routes,  # portable project templates (mig 059)
    provider_key_routes,
    push_routes,
    request_acceptance_routes,
    request_close_routes,
    request_conversion_routes,
    request_creation_routes,
    request_nudge_routes,
    request_rejection_routes,
    request_resolution_routes,
    request_response_routes,
    review_routing_routes,  # mig 057: manager review handoff
    roster_analysis_routes,
    roster_suggest_routes,
    routine_routes,  # routines (recurring scheduled work)
    run_changes_routes,
    slack_routes,
    task_assignment_routes,
    task_cancellation_routes,
    task_creation_routes,
    task_dispatch_routes,
    task_done_routes,
    task_impact_routes,
    task_message_routes,
    task_protocol_routes,
    task_reviewer_routes,
    task_verification_routes,
    templates_routes,  # project mode (Code | General) + industry templates
    terminal_config_routes,
    user_pref_routes,
    voice_routes,  # dictation: streaming STT proxy + clean-up
    verdikt_routes,  # Verdikt QA handoff (mig 058)
    wake_acknowledgement_routes,
    wake_backoff_routes,
    wake_lease_claim_routes,
    wake_lease_renewal_routes,
    wake_scan_routes,
    worker_run_finish_routes,
    worker_run_read_routes,
    worker_run_start_routes,
)

ROUTE_MODULES = (
    active_conversation_routes,
    agent_digest_routes,
    agent_event_routes,
    agent_model_routes,
    agent_notification_routes,
    agent_performance_routes,  # agent performance (evals-lite)
    agent_profile_routes,
    agent_reachability_routes,
    agent_registration_routes,
    agent_request_box_routes,
    agent_self_wake_routes,
    agent_spend_routes,
    agent_suggestion_routes,
    agent_task_claim_routes,
    agent_wake_policy_routes,
    attachment_routes,
    code_github_edit_routes,
    code_space_routes,
    code_workingtree_routes,
    container_control_routes,
    container_event_routes,
    container_lifecycle,
    container_lifecycle_routes,
    container_metrics_routes,
    container_pairing_routes,
    container_request_list_routes,
    container_snapshot_routes,
    container_task_list_routes,
    container_token_usage_routes,
    conversation_read_routes,
    conversation_write_routes,
    dashboard_routes,
    deliverables_routes,  # non-code task deliverables (mig 061)
    decision_routes,
    device_token_routes,
    embodiment_token_routes,
    evidence_routes,  # proof-of-work evidence packs (mig 058)
    file_raw_routes,  # raw bytes for file previews (images, PDF, media)
    github_hub_routes,
    github_pat_routes,
    github_repo_browse_routes,
    github_routes,
    goal_ancestry_routes,  # goal ancestry: task goal chain + parent link
    identity_routes,
    llm_key_routes,
    member_routes,
    notification_pref_routes,  # mig 063: fine-grained notification preferences
    model_setting_routes,
    onboarding_routes,
    orphan_lease_routes,
    persona_protocol_routes,
    plan_routes,
    plan_usage_routes,  # desktop plan-usage snapshots for mobile (mig 069)
    project_export_library_routes,  # DoD presets + skills library (mig 059)
    project_export_routes,  # portable project templates (mig 059)
    provider_key_routes,
    push_routes,
    request_acceptance_routes,
    request_close_routes,
    request_conversion_routes,
    request_creation_routes,
    request_nudge_routes,
    request_rejection_routes,
    request_resolution_routes,
    request_response_routes,
    review_routing_routes,  # mig 057: manager review handoff
    roster_analysis_routes,
    roster_suggest_routes,
    routine_routes,  # routines (recurring scheduled work)
    run_changes_routes,
    slack_routes,
    task_assignment_routes,
    task_cancellation_routes,
    task_creation_routes,
    task_dispatch_routes,
    task_done_routes,
    task_impact_routes,
    task_message_routes,
    task_protocol_routes,
    task_reviewer_routes,
    task_verification_routes,
    templates_routes,  # project mode (Code | General) + industry templates
    terminal_config_routes,
    user_pref_routes,
    verdikt_routes,  # Verdikt QA handoff (mig 058)
    wake_acknowledgement_routes,
    wake_backoff_routes,
    wake_lease_claim_routes,
    wake_lease_renewal_routes,
    wake_scan_routes,
    worker_run_finish_routes,
    worker_run_read_routes,
    worker_run_start_routes,
)


def compatibility_export(name):
    """Resolve a legacy ``main`` attribute from its responsibility module."""
    for module in ROUTE_MODULES:
        if hasattr(module, name):
            return getattr(module, name)
    raise AttributeError(name)


__all__ = [
    "agent_model_routes",
    "agent_registration_routes",
    "compatibility_export",
    "persona_protocol_routes",
    "request_acceptance_routes",
    "task_done_routes",
    "task_verification_routes",
]
