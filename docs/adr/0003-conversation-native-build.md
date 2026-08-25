# ADR 0003: Adopt a conversation-native BUILD

- Status: Accepted
- Date: 2026-08-25
- Detailed design: ../plans/conversation-native-build-v6.md

## Context

The Adaptive BUILD Alpha exposes requirement alignment, planning and implementation as separate UI states around a conversation. It also asks the Alignment Agent to append an Anvil-specific ANVIL_DECISION marker to Pocock Skill output.

This couples a third-party engineering method to Anvil orchestration, conflates “no questions remain” with “the user confirmed”, makes direct implementation appear to run inside alignment, and leaves skipped phases visually indistinguishable from pending work.

The project has not entered production, so preserving the Alpha protocol would add compatibility cost without user value.

## Decision

Anvil V6 will use a single Work Timeline as the product surface.

- User and assistant messages, phase transitions, Artifacts, task progress, verification and recovery are typed WorkEvents in one ordered stream.
- Work, Activity, Agent Session, Skill Run and worktree isolation remain separate engineering boundaries.
- Pocock Skills execute engineering methods but do not emit Anvil lifecycle markers.
- An independent Alignment Observer produces a structured AlignmentAssessment.
- Alignment completes only when no blocking decisions remain and a user_message confirms the latest shared understanding.
- Route Selection runs only after alignment confirmation.
- direct, spec and tickets remain adaptive routes; unneeded phases become skipped.
- Verification is a first-class Activity and is required before work completion.
- Plans, task lists, screenshots, verification reports and walkthroughs are versioned Artifacts rendered in the conversation.
- V6 replaces the Alpha API and protocol without a compatibility migration.

## Consequences

Positive:

- Users complete an end-to-end requirement through one conversation.
- Internal stages remain explicit, observable and recoverable.
- Skills can evolve independently of Anvil protocols.
- Decision history contains structured summaries instead of raw model responses.
- The UI can explain progress using task-level Artifacts instead of tool logs.

Costs:

- An additional structured Observer evaluation is required during alignment.
- An append-only Event Store and Artifact Store must be introduced.
- The current WorkView, decision Marker and v5 APIs will be replaced.
- State transition and event replay tests become mandatory.

## Safety constraints

- Only the BUILD Controller may commit phase transitions.
- Assistant text cannot advance the lifecycle.
- Alignment cannot write implementation files.
- Project configuration may narrow phase tool permissions but cannot widen them.
- High-risk, destructive, irreversible and external actions require an explicit Gate.
- Hidden model reasoning is never persisted as a WorkEvent or Artifact.
