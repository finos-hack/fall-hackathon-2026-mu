---
name: calm-timelapse
description: Curate executive FINOS CALM architectural moments from a deterministic Git commit diff digest (`--emit-digest` -> `--clusters`). Compatible with GitHub Copilot, Claude Code, AWS Kiro, Codex, IBM Bob, and OpenCode alongside `calm init-ai`.
---

# CALM Timelapse — AI Assistant Clustering Guide

`calm-timelapse` follows the FINOS `calm-ai` (`calm init-ai`) pattern for regulated financial enterprises: **the CLI itself makes zero network or LLM calls**. Instead, `calm-timelapse` deterministically extracts structural CALM diffs from Git into a compact `<arch>.digest.json` file, and any organization-approved IDE AI assistant can group those commits into `<arch>.clusters.json`.

Even when AI assistants are unavailable (e.g., in air-gapped CI/CD), `calm-timelapse --from-git <arch.json> --timelapse` works standalone using deterministic heuristics.

---

## 3-Step Workflow

### Step 1 — Emit the Structural Commit Diff Digest (Deterministic)

Run `calm-timelapse` on a Git-tracked CALM architecture file with `--emit-digest`:

```bash
npx calm-timelapse \
  --from-git architecture/system.calm.json \
  --emit-digest architecture/system.digest.json \
  -o architecture/system.timeline.json \
  --timelapse architecture/system.timelapse.html \
  --validate
```

This immediately produces a working deterministic timeline + HTML player **and** writes `system.digest.json` containing:
- `stats`: total commits scanned, noise commits filtered, and `structuralCommitsRetained` (`N`).
- `commits`: indexed `0` through `N - 1`, each with `sha`, `shortSha`, `date`, `subject`, `summaryLine`, concrete structural `changes`, and `coChangedAdrs`.

---

### Step 2 — Group Commits into `<arch>.clusters.json` (AI Assistant or Architect)

Read `<arch>.digest.json` and write `<arch>.clusters.json` as a JSON array of moment cluster objects:

```json
[
  {
    "startIndex": 0,
    "endIndex": 3,
    "uniqueId": "foundational-trading-core",
    "name": "Foundational Trading Core",
    "description": "Initializes the TraderX Web UI and Core Monolith backed by the PostgreSQL Trade Ledger DB and FIX Drop-Copy Relay. Establishes baseline synchronous order routing and end-of-day batch clearing."
  },
  {
    "startIndex": 4,
    "endIndex": 8,
    "uniqueId": "enterprise-perimeter-hardening",
    "name": "Enterprise Security and Perimeter Hardening",
    "description": "Introduces Okta OIDC SSO, Corporate LDAP entitlements, and an Envoy API Gateway behind an Edge WAF Perimeter. Centralizes JWT validation at the ingress boundary per ADR-001."
  }
]
```

#### Clustering & Narrative Rules

1. **Contiguous `0..N-1` Coverage (Mandatory):**
   - First object MUST have `"startIndex": 0`.
   - Every subsequent object MUST have `"startIndex"` equal to the previous `"endIndex" + 1`.
   - Final object MUST have `"endIndex": N - 1` (`stats.structuralCommitsRetained - 1`).
   - `calm-timelapse` deterministically rejects any gaps, overlaps, or out-of-bounds indices.
2. **Cohesive Phase Sizing:**
   - Group multi-commit sprints, node-addition + relationship-wiring sequences, protocol upgrades (`HTTP` -> `HTTPS`/`mTLS`), and coupled `controls`/ADR rollouts into unified phases.
   - Keep genuinely pivotal milestones (initial baseline, monolith retirement, major regulatory control frameworks) as distinct moments.
   - Aim for ~6–12 moments on a 30–40 commit history, or ~3–6 moments on a 5–15 commit history.
3. **Executive Naming (`name`):**
   - Use 3–7 words describing the architectural capability or transition.
   - Do **not** include leading step numbers (`01`, `Phase 2:`) or conventional-commit prefixes (`feat:`, `chore:`, `fix:`).
4. **Architectural Narrative (`description`):**
   - Write 2–3 concise sentences explaining **what** changed structurally, **how** connectivity or trust boundaries shifted, and **why** (referencing concrete node IDs, protocols, CALM `controls`, or `coChangedAdrs`).
   - Do **not** write mechanical diff counts such as `+2 node(s)` or `~1 rel(s)`.

---

### Step 3 — Apply `--clusters` & Validate Deterministically

Feed `<arch>.clusters.json` back to `calm-timelapse`:

```bash
npx calm-timelapse \
  --from-git architecture/system.calm.json \
  --clusters architecture/system.clusters.json \
  -o architecture/system.timeline.json \
  --snapshots-dir architecture/snapshots \
  --timelapse architecture/system.timelapse.html \
  --validate \
  --validate-snapshots
```

What `calm-timelapse` guarantees deterministically:
- Every architecture snapshot JSON is extracted **verbatim from Git** at the cluster's `endIndex` commit SHA — an AI assistant can never hallucinate nodes, relationships, or controls.
- Co-changed ADRs and commit provenance (`metadata.commits`, `metadata.commit-messages`, `metadata.commit-count`) are attached automatically from Git.
- Commit `<arch>.clusters.json` alongside `<arch>.timeline.json` in Git so CI/CD reproduces the exact enriched timeline offline in milliseconds.
