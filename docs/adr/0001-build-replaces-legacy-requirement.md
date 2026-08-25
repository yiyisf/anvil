---
status: superseded by ADR-0002
---

# BUILD replaces the Legacy Requirement lifecycle

BUILD is the canonical product lifecycle. During migration, v4 Requirement behavior remains compatible while capabilities with a concrete BUILD use and no Requirement-specific semantics move into shared modules; BUILD and shared modules never depend on Legacy, so obsolete Legacy behavior can later be deleted without another system-wide disentangling effort.
