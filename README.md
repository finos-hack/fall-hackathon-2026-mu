# CALM Timelapse (`calm-timelapse`)

**Hackathon Track:** Track 3: Features

Reviewers and auditors regularly ask what an architecture—or an ecosystem of interacting architectures across repositories—looked like on a specific past date and why it changed. Answering that today means reading raw Git diffs by hand or manually pre-saving versioned JSON snapshots. In upstream `@finos/calm-cli`, `calm timeline -a` builds an implied timeline only from pre-saved versioned files on disk (such as `arch-1.0.0.json`, `arch-2.0.0.json`), and `calm diff --timeline` outputs text or Markdown tables. **CALM Timelapse** bridges **FINOS CALM** with **Git** directly: it walks `git log --follow` across one or multiple Git repositories and CALM files simultaneously, filters out pure JSON formatting and key-reordering noise, emits schema-validated `calm-timeline` (`1.2` and `1.3`, validated against `@finos/calm-schema` `1.3.0`) artifacts plus historical snapshot files, and renders a zero-dependency, single-viewport interactive HTML/SVG player—with zero runtime network calls.

> **Interactive Demo Gallery:** Open `docs/index.html` locally (or visit `https://finos-hack.github.io/fall-hackathon-2026-mu/` when GitHub Pages is enabled on `docs/`) to step through 9 pre-built single-repo and multi-repo architecture timelapses in your browser without building from source.

## Installation

OS X & Linux:

```sh
git clone https://github.com/finos-hack/fall-hackathon-2026-mu.git
cd fall-hackathon-2026-mu
npm install
npm run build
```

Windows (PowerShell):

```powershell
git clone https://github.com/finos-hack/fall-hackathon-2026-mu.git
Set-Location fall-hackathon-2026-mu
npm install
npm run build
```

## Usage example

### 1. Zero-AI Deterministic Git Extraction (Air-Gapped Ready)

Point `calm-timelapse` at any Git-tracked CALM architecture file to extract structural history, write point-in-time snapshot JSONs, validate the resulting `calm-timeline` document, and generate an offline HTML player that produces structured evidence to support architecture reviews and supervisory inquiries:

```sh
node dist/cli.js \
  --from-git path/to/architecture.calm.json \
  -o timeline/architecture.timeline.json \
  --snapshots-dir timeline/snapshots \
  --timelapse timeline/architecture.timelapse.html \
  --validate
```

In deterministic mode (no `--clusters` file), consecutive structural commits by the same author within a 14-day window are grouped into a single moment until a commit adds or removes a node, flow, control, or co-changed ADR (`docs/adr/*.md`).

### 2. Synchronized Multi-Repo & Multi-Architecture Playback (`--from-git <files...>` / `--resolve-details`)

Pass multiple CALM files across separate Git repositories (with optional `Label=path` display labels) or pass `--resolve-details` to automatically discover same-repo `details.detailed-architecture` sub-architectures:

```sh
node dist/cli.js \
  --from-git \
    "TraderX Platform=../traderx-platform/architecture/platform.calm.json" \
    "TraderX Execution=../traderx-execution/calm/execution-detail.calm.json" \
    "FINRA Surveillance=../finra-surveillance/calm/surveillance.calm.json" \
  -o timeline/federated.timeline.json \
  --snapshots-dir timeline/snapshots \
  --timelapse timeline/federated.timelapse.html \
  --validate \
  --validate-snapshots
```

- **Strict peer namespace isolation:** Unlinked architectures never merge nodes—even when two repositories declare the same `unique-id` (for example, `postgres-trades-db`). Nodes are namespaced per source (`<sourceId>--<unique-id>`) and rendered with color-coded repository badges and a **Project** filter in the SVG toolbar.
- **Canonical `detailed-architecture` composition:** Nodes merge **only** when a parent node explicitly references a child architecture through `node.details["detailed-architecture"]`. Shared boundary nodes (such as `kafka-event-bus` or `mongodb`) merge canonically (`⇄`), internal child services attach under the parent node via a synthesized CALM `composed-of` relationship, and both singular `interface` and plural `interfaces` endpoint references are remapped cleanly.

### 3. Diff Digest + Approved IDE Assistant (`--emit-digest` / `--clusters`)

Regulated engineering environments typically prohibit CLI tools from sending architecture JSON to external LLM endpoints. Matching `calm init-ai`, `calm-timelapse` exports a compact local diff digest (`--emit-digest`)—for single-repo or multi-repo runs—and ships a reusable skill (`skills/calm-timelapse/SKILL.md`) so an approved IDE assistant can group commits into named phases (`clusters.json`):

```sh
# Step 1: Export a compact structural diff digest (zero network calls)
node dist/cli.js --from-git architecture.calm.json --emit-digest timeline/digest.json

# Step 2: Hand timeline/digest.json to your approved IDE assistant to produce clusters.json,
#         then build the validated timeline and interactive player:
node dist/cli.js \
  --from-git architecture.calm.json \
  --clusters timeline/clusters.json \
  -o timeline/architecture.timeline.json \
  --snapshots-dir timeline/snapshots \
  --timelapse timeline/architecture.timelapse.html \
  --validate \
  --validate-snapshots
```

Example `clusters.json` covering structural commit indices `0..2`:

```json
[
  {
    "startIndex": 0,
    "endIndex": 0,
    "uniqueId": "core-diff-foundation",
    "name": "Core Structural Diff Foundation",
    "description": "Establishes the initial Git blob extractor and structural CALM diff engine."
  },
  {
    "startIndex": 1,
    "endIndex": 2,
    "uniqueId": "zero-network-digest-and-timelapse-player",
    "name": "Zero-Network Digest and Timelapse Player",
    "description": "Adds digest export, contiguous cluster validation, and single-viewport SVG playback."
  }
]
```

**Safeguards if assistant output is malformed:** `validateClusterSpecs` enforces contiguous, non-overlapping coverage from `0` to `N - 1` (`startIndex = 0`, each next `startIndex = prev.endIndex + 1`, final `endIndex = N - 1`). Any gap, overlap, reversed range, or empty title/description aborts immediately with an explicit validation error, and every architecture snapshot is still written verbatim from Git blobs—never synthesized by an assistant.

### 4. Visual Player for Existing Hand-Curated Timelines (`--timeline <files...>`)

Render an interactive player directly from one or multiple existing `calm-timeline` (`1.2` or `1.3`) files:

```sh
node dist/cli.js \
  --timeline docs/demos/calm-manual/calm.timeline.json \
  --timelapse docs/demos/calm-manual/calm.timelapse.html \
  --validate
```

### Interactive Player & CLI Reference

| Capability | Details |
|---|---|
| **Project & Subsystem Filtering** | Filter multi-repo graphs by repository (`Project`) or node (`Subsystem`), with optional `1-hop only` blast-radius isolation |
| **As-Of Date & Baseline Diff** | Jump to the authoritative architecture effective on any `YYYY-MM-DD` date or diff any baseline moment against the current frame |
| **Governance & ADR Posture** | Inspect active CALM `1.3` `controls` requirements, cumulative co-changed ADRs, and `detailed-architecture` merge provenance per moment |
| **Offline Single-File HTML** | Self-contained SVG player with zoom/pan, keyboard transport (`Space`, `←`/`→`), and zero external CDN, font, or script requests |

| CLI Flag | Description |
|---|---|
| `--from-git <files...>` | Extract and synchronize one or more Git-tracked CALM files (supports `Label=path`) |
| `--resolve-details` | Auto-discover and synchronize same-repo `details.detailed-architecture` child files |
| `--timeline <files...>` | Validate or synchronize one or more existing `calm-timeline` JSON files |
| `--emit-digest <file>` / `--clusters <file>` | Export deterministic diff digests and apply validated `0..N-1` phase clusters |
| `--timelapse [html]` | Render standalone interactive HTML/SVG timelapse player |
| `--validate` / `--validate-snapshots` | Validate `calm-timeline` structure and every emitted CALM `1.3` snapshot |

### 5. Interactive Demo Gallery (`docs/demos/`)

- **Multi-Repo Trading & FINRA Surveillance (`docs/demos/multi-repo/`):** Reproducible via `npm run demo:multi-repo`—synchronizes **3 independent Git repositories** (`traderx-platform`, `traderx-execution`, `finra-surveillance`) across 5 moments, demonstrating `details.detailed-architecture` boundary merging alongside strict peer isolation.
- **Federated FINOS CALM Core + CALM Timelapse (`docs/demos/finos-federated/`):** Synchronizes `calm-3.json` + auto-discovered `calm-hub-detail.architecture.json` (`--resolve-details`) from `finos/architecture-as-code` with this repository's own `architecture.calm.json`.
- **TraderX Institutional Equities Simulation (`docs/demos/traderx/`):** Reproducible via `npm run demo:traderx`—**40 Git commits collapse to 9 moments** (5 formatting-only commits filtered, 5 co-changed ADRs, and 4 CALM 1.3 controls).
- **FINOS API Gateway Pattern (`docs/demos/api-gateway/`):** Extracted from `finos/architecture-as-code`—**23 commits collapse to 4 moments** (9 formatting commits filtered).
- **Official Hand-Curated vs. Git-Derived CALM Self-Architecture (`docs/demos/calm-manual/` & `docs/demos/calm-self/`):** Compares the upstream hand-curated `calm.timeline.json` against Git history extracted directly from `calm/architecture/calm-3.json` (FINOS CALM's own self-architecture model in `finos/architecture-as-code`, where 8 commits collapse to 3 moments).
- **OSFF London Workshop (`docs/demos/osff-signup/`), FluxNova (`docs/demos/fluxnova/`), & Self-Dogfooding (`docs/demos/self-dogfood/`):** Demonstrates zero-AI deterministic clustering, CALM 1.2 control tracking, and this repository's own `architecture.calm.json` evolution.

### Known Limitations

- **File renames with heavy rewrites:** Uses `git log --first-parent --follow -M30%`; simple moves are tracked across paths, but a file move combined with a rewrite that leaves under 30% similarity stops rename tracking at that commit.
- **Mainline merge traversal:** `--first-parent` walks mainline history chronologically and summarizes merged feature branches at their merge commit rather than expanding side-branch commits individually.
- **Remote HTTP `detailed-architecture` URLs:** Local relative paths and co-supplied `--from-git` files are resolved offline; remote `https://` `detailed-architecture` URLs are intentionally not fetched to preserve the zero-network guarantee.
- **Invalid historical JSON commits:** Commits where the CALM file failed `JSON.parse` are skipped safely and tallied in digest `stats` rather than halting extraction.

## Development setup

Requires **Node.js >= 22** (verified against **Node `26.3.1`**, matching `.nvmrc` in `finos/architecture-as-code`) and **Git**.

```sh
npm install
npm run typecheck
npm run build
npm test
npm run test:coverage

# Regenerate the 40-commit TraderX simulation and 3-repo federated simulation from scratch
npm run demo:traderx
npm run demo:multi-repo
```

This repository models its own zero-network architecture in `architecture.calm.json` (validated cleanly with `@finos/calm-cli validate` and `@finos/calm-schema` `1.3.0`) and dogfoods itself in `docs/demos/self-dogfood/`.

## Roadmap

This project was built during a time-boxed FINOS hackathon.

1. Contribute `--from-git` single-repo and multi-repo history extraction upstream to `@finos/calm-cli` (`calm timeline`).
2. Contribute the zero-network diff digest and cluster skill (`skills/calm-timelapse/SKILL.md`) to `@finos/calm-ai`.
3. Embed the single-viewport SVG timelapse scrubber and Project filter as a webview panel inside `calm-plugins/vscode`.
4. Add historical moment comparison and as-of date playback to `calm-hub` and `calm-hub-ui`.
5. Resolve remote CALM Hub `detailed-architecture` URIs via an optional local cache directory while preserving offline execution.

## Contributing

Coding agents should follow [AGENTS.md](./AGENTS.md), which requires a Developer Certificate of Origin sign-off on every commit.

**All commits** must be signed with a DCO signature to avoid being flagged by the DCO Bot. This means that your commit log message must contain a line that looks like the following one, with your actual name and email address:

```
Signed-off-by: John Doe <john.doe@example.com>
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more information.

## License

Copyright 2026 FINOS

Distributed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).

SPDX-License-Identifier: [Apache-2.0](https://spdx.org/licenses/Apache-2.0)
