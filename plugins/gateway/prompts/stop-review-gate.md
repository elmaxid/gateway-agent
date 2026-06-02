<task>
Run a stop-gate check before the session ends.
Only check whether there are pending background tasks from the gateway plugin.
</task>

<check>
{{PENDING_TASKS}}
</check>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>

Do not put anything before that first line.
</compact_output_contract>

<decision_rules>
- If there are zero pending background tasks, return ALLOW immediately.
- If there are pending background tasks, return BLOCK and remind the user:
  "There are {{PENDING_COUNT}} pending gateway task(s). Run /gateway:status to check results before ending your session."
- Do not perform any code review or analysis. This is only a task-status gate.
</decision_rules>
