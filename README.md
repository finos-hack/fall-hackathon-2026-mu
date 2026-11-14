# CALM Timelapse (`calm-timelapse`)

**What it is:** Converts Git history across one or multiple repositories into `@finos/calm-cli`-validated CALM timelines (`1.2` / `1.3`), SHA-256-verified snapshots, and an offline HTML player with **Timelapse Stage**, **Architecture Feed**, and **Multi-Hop Blast Radius**.  
**Why it matters:** Reviewers and auditors can see what an architecture looked like on any past date, why it changed, and what breaks if a node fails—without pre-saving versioned JSON snapshots or reading raw Git diffs (`Track 3: Features`).  
**Try it live (zero install):** [**Demo Gallery**](https://finos-hack.github.io/fall-hackathon-2026-mu/) · [**FINOS TraderX + FDC3 Stage**](https://finos-hack.github.io/fall-hackathon-2026-mu/demos/finos-traderx/finos-traderx.timelapse.html) · [**3-Repo Federated Stage**](https://finos-hack.github.io/fall-hackathon-2026-mu/demos/multi-repo/multi-repo.timelapse.html) · [**Architecture Feed (`#feed`)**](https://finos-hack.github.io/fall-hackathon-2026-mu/demos/finos-traderx/finos-traderx.timelapse.html#feed) · [**72s Video (`.mp4`)**](https://finos-hack.github.io/fall-hackathon-2026-mu/assets/calm-timelapse-demo.mp4)

[![CALM Timelapse 72-Second Interactive Walkthrough](docs/assets/calm-timelapse-demo.gif)](https://finos-hack.github.io/fall-hackathon-2026-mu/)

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

### 1. Deterministic Git Extraction (Zero AI, Zero Network)

```sh
node dist/cli.js \
  --from-git path/to/architecture.calm.json \
  -o timeline/architecture.timeline.json \
  --snapshots-dir timeline/snapshots \
  --timelapse timeline/architecture.timelapse.html \
  --validate
```

- Walks `git log --follow -M30%`, filters pure JSON formatting/key-reordering commits (retaining referenced flow URLs and `items` to `prefixItems` / `uniqueId` to `unique-id` pattern migrations), and emits `*.architecture.json` or `*.pattern.json` snapshots.
- Groups same-author commits within a 14-day window until a node, flow, control, or co-changed ADR (`docs/adr/*.md`, up to 250 files/commit) is added or removed, and qualifies generic root filenames as `<repo>/<file>` without leaking host paths.

### 2. Multi-Repo Federation (`--from-git <files...>` / `--resolve-details`)

```sh
node dist/cli.js \
  --from-git \
    "TraderX Platform=../traderx-platform/architecture/platform.calm.json" \
    "TraderX Execution=../traderx-execution/calm/execution-detail.calm.json" \
    "FINRA Surveillance=../finra-surveillance/calm/surveillance.calm.json" \
  -o timeline/federated.timeline.json \
  --snapshots-dir timeline/snapshots \
  --timelapse timeline/federated.timelapse.html \
  --validate --validate-snapshots
```

- **Peer namespace isolation:** Unlinked repositories never merge nodes, even on colliding IDs (`postgres-trades-db`). Nodes stay namespaced (`<sourceId>--<unique-id>`) with a toolbar **Project** filter.
- **Canonical boundary composition:** Nodes merge (`⇄`) **only** when linked via `node.details["detailed-architecture"]` (or auto-discovered via `--resolve-details`), attaching internal child nodes through CALM `composed-of`.

### 3. Diff Digest + Approved IDE Assistant (`--emit-digest` / `--clusters`)

Matching `calm init-ai`, the CLI makes zero LLM API calls. Instead, export a compact diff digest and let an approved workspace assistant ([`skills/calm-timelapse/SKILL.md`](./skills/calm-timelapse/SKILL.md)) group commits into `clusters.json`:

```sh
node dist/cli.js --from-git architecture.calm.json --emit-digest timeline/digest.json
node dist/cli.js --from-git architecture.calm.json --clusters timeline/clusters.json \
  -o timeline/architecture.timeline.json --snapshots-dir timeline/snapshots \
  --timelapse timeline/architecture.timelapse.html --validate --validate-snapshots
```

`validateClusterSpecs` enforces contiguous, non-overlapping coverage across `0..N-1`, and every snapshot is written verbatim from Git blobs with its `SHA-256` hash recorded in `digest.commits[].snapshotSha256` and `moment.metadata["snapshot-sha256"]`.

#### AI Workflow Evidence (`calm/architecture/calm-3.json` in [`docs/demos/calm-self/`](./docs/demos/calm-self/))

1. **Sample Digest ([`calm-self.digest.json`](./docs/demos/calm-self/calm-self.digest.json), commits `0..1` of `0..4`):**

```json
{
  "schemaVersion": "1.0",
  "sourceFile": "calm-3.json",
  "stats": { "totalCommitsScanned": 8, "validSnapshotsParsed": 7, "noiseCommitsFiltered": 2, "structuralCommitsRetained": 5 },
  "commits": [
    {
      "index": 0,
      "shortSha": "f1486acb",
      "date": "2025-12-23",
      "subject": "docs(calm): Define CALM in CALM",
      "snapshotSha256": "296c44d1450f024d446d9d7c211288fa254232123b80784f8f8033d25d297ee0",
      "changes": ["Added node CALM CLI (calm-cli)", "Added node CALM Hub API (calm-hub)", "..."]
    },
    {
      "index": 1,
      "shortSha": "784858e7",
      "date": "2025-12-23",
      "subject": "docs(calm): remove unwanted hallucinations",
      "snapshotSha256": "540708fe3de3780bb03c8f778f24d5af95f1f8747786438122694b9687929cc3",
      "changes": ["Modified node CALM CLI (calm-cli) [interfaces]", "Modified relationship cli-to-hub", "..."]
    }
  ]
}
```

2. **Assistant Prompt:**

```text
Read docs/demos/calm-self/calm-self.digest.json and follow skills/calm-timelapse/SKILL.md to write
docs/demos/calm-self/calm-self.clusters.json covering commit indices 0..4 contiguously with 3-7 word phase names.
```

3. **Accepted [`calm-self.clusters.json`](./docs/demos/calm-self/calm-self.clusters.json):**

```json
[
  { "startIndex": 0, "endIndex": 1, "uniqueId": "core-cli-hub-and-vscode-baseline", "name": "Core CLI, Hub, and VSCode Baseline", "description": "Models FINOS CALM in CALM with calm-cli, calm-vscode, calm-hub, calm-hub-ui, and mongodb, then refines interface bindings." },
  { "startIndex": 2, "endIndex": 3, "uniqueId": "operational-publish-and-ide-flows", "name": "Operational Publish and IDE Flows", "description": "Adds behavioral flows for Publish Architecture, Browse Architectures, and Validate Architecture in IDE." },
  { "startIndex": 4, "endIndex": 4, "uniqueId": "calm-studio-and-validation-server", "name": "CalmStudio and Validation Server Expansion", "description": "Adds calm-studio and standalone calm-server, and links calm-hub to its detailed architecture." }
]
```

4. **Rejected Malformed Output (skipping index `2`):**

```text
$ node dist/cli.js --from-git ../finos/calm/architecture/calm-3.json --clusters calm-self.bad.clusters.json
Error: Invalid cluster definitions (expected a non-empty JSON array covering commit indices 0..4 contiguously without gaps or overlaps): clusters[1].startIndex is 3, expected 2 (gap skipping commit index 2).
```

### 4. Upstream FINOS TraderX Import (`--from-traderx`) — Translates FDC3 Contracts into Validated CALM

```sh
node dist/cli.js \
  --from-traderx ../traderx \
  -o docs/demos/finos-traderx/finos-traderx.timeline.json \
  --snapshots-dir docs/demos/finos-traderx/snapshots \
  --timelapse docs/demos/finos-traderx/finos-traderx.timelapse.html \
  --validate --validate-snapshots
```

- **Translates FDC3 contracts into validated CALM:** Converts `specs/014-fdc3-intent-interoperability/contracts/contract-delta.md` and `appd.v2.json` into CALM `1.3` `interfaces` (`ViewOrders`, `TraderX.CreateTradeTicket`, `TraderX.CreateOrderTicket`, `ViewChart`, `ViewQuote` on `fdc3.instrument` / `fdc3.account`) and 3 Spectral-clean CALM `flows`.
- **Spec-Kit governance to CALM `controls`:** Converts `system-requirements.md` and `nonfunctional-delta.md` across States `001`–`014` into 22 progressive architecture- and node-level CALM `1.3` `controls` alongside 8 ADRs and 135 commit references.

### 5. Multi-Hop CALM Blast Radius & Monorepo Scale

Click any node in **Timelapse Stage** (or call `computeBlastRadius` from `dist/index.js`) to inspect impact propagation at the selected commit:

- **CALM relationship traversal:** Switch between `All Impacted` (undirected coupling), `Dependents / Failure Cascade` (reverses `connects`/`interacts` to callers, propagates `deployed-in` host-to-workload and `composed-of`), and `Downstream Flow` (`source -> destination`).
- **Flows, controls & temporal delta:** Highlights `⚡ ORIGIN`, `1-HOP`, and `2-HOP+` nodes; lists affected CALM `flows` and at-risk node/relationship `controls` (scoping colliding inline keys as `<ownerId>:<controlId>`); supports `Isolate` zoom (`Esc` clears); and shows `±Δ vs prev` blast-radius change across moments.
- **Large-graph layout:** Dynamically scales column height and packs sparse layers on `>24`-node architectures (tested on 162-node / 289-relationship graphs) to maintain a readable `~1.7:1` aspect ratio.

### Interactive Player & CLI Reference

| View / Control | Behavior |
|---|---|
| **Timelapse Stage & Architecture Feed** | Toggle between single-viewport **Stage** playback and reverse-chronological **Feed** (`--feed` or `#feed`, `N -> 1` cards with `Save SVG` and `Inspect in Stage`) |
| **Blast Radius, As-Of Date & Diff** | Click any node for multi-hop blast radius, query effective architecture by `YYYY-MM-DD`, or diff any two moments |
| **Offline Single-File HTML** | Pan/zoom (`0.04x`–`3.5x`), `Space` play/pause, `←`/`→` step, `Esc` clear selection; zero CDN, font, or script requests |

| CLI Flag | Description |
|---|---|
| `--from-git <files...>` | Extract and synchronize one or more Git-tracked CALM files (`Label=path` supported) |
| `--from-traderx <repoDir>` | Convert upstream [`finos/traderx`](https://github.com/finos/traderx) states, Spec-Kit controls, ADRs, and FDC3 contracts into CALM `1.3` |
| `--resolve-details` | Auto-discover same-repo `details.detailed-architecture` child files |
| `--max-commits <n>` / `--first-parent` | Optional commit cap (unlimited by default) and first-parent mainline walk |
| `--timeline <files...>` | Render or synchronize existing `calm-timeline` (`1.2` / `1.3`) JSON files |
| `--emit-digest <file>` / `--clusters <file>` | Export deterministic diff digest and apply validated `0..N-1` phase clusters |
| `--timelapse [html]` / `--feed` | Render standalone HTML player (`--feed` opens Architecture Feed by default) |
| `--validate` / `--validate-snapshots` | Verify `calm-timeline` structure, `snapshot-sha256` integrity, and emitted snapshots |

### Demo Gallery (`docs/demos/`)

| Demo | Source | Key Evidence |
|---|---|---|
| [`finos-traderx`](./docs/demos/finos-traderx/) | Upstream `finos/traderx` | 13 states (`001`–`014`), 22 Spec-Kit `controls`, 8 ADRs, FDC3 translated into CALM `interfaces` + 3 `flows` |
| [`multi-repo`](./docs/demos/multi-repo/) | `npm run demo:multi-repo` | 3 Git repos, `detailed-architecture` boundary merge + peer `postgres-trades-db` isolation |
| [`finos-federated`](./docs/demos/finos-federated/) | `finos/architecture-as-code` + this repo | 19 commits to 8 moments (`--resolve-details` on `calm-hub-detail.architecture.json`) |
| [`api-gateway`](./docs/demos/api-gateway/) | `finos/architecture-as-code` | 23 pattern commits to 4 moments (`*.pattern.json`, `items` to `prefixItems` migration) |
| [`calm-manual`](./docs/demos/calm-manual/) & [`calm-self`](./docs/demos/calm-self/) | `finos/architecture-as-code` | Hand-curated `calm.timeline.json` vs. Git-derived `calm-3.json` (8 commits to 3 moments) |
| [`osff-signup`](./docs/demos/osff-signup/), [`fluxnova`](./docs/demos/fluxnova/), [`self-dogfood`](./docs/demos/self-dogfood/) | Real Git histories | Zero-AI clustering (13 to 5 moments), CALM `1.2` controls, and this repo's own `architecture.calm.json` |
| [`traderx`](./docs/demos/traderx/) | `npm run demo:traderx` | Synthetic 40-commit compliance stress test (9 moments, 5 noise filtered, 5 ADRs) |

### Known Limitations

- **Heavy file rewrites + renames:** `git log --follow -M30%` stops rename tracking if a move + rewrite drops below 30% similarity.
- **Branch merges:** Walks full file commit history by default; pass `--first-parent` for mainline-only summaries.
- **Remote `detailed-architecture` URLs:** `https://` sub-architecture URLs are not fetched to preserve offline execution.
- **Invalid historical JSON:** Commits that fail `JSON.parse` are skipped and counted in digest `stats`.

## How AI Coding Tools Accelerated This Build

- **Upstream Schema & Spectral Parity:** Agents inspected `@finos/calm-schema` (`1.2`/`1.3`), `@finos/calm-shared` Spectral rules, and `finos/traderx` Spec-Kit files in parallel—reaching `0` errors and `0` warnings across all 24 `@finos/calm-cli@1.72.0` CI checks.
- **Automated Multi-Repo & Visual Testing:** Agents built 44 unit/e2e tests across 8 suites (covering blast radius, 160-node layout packing, scoped controls, rename tracking, pattern migrations, and FDC3 flows) and verified SVG rendering in a headless browser.
- **Deterministic AI Guardrails:** `calm-timelapse` enforces `zero-network-execution` and `contiguous-cluster-coverage` ([`architecture.calm.json`](./architecture.calm.json)): `--emit-digest` exports diffs locally and `validateClusterSpecs(0..N-1)` rejects gaps, overlaps, or hallucinated snapshots.

## Development setup

Requires **Node.js >= 22** (verified on **Node `26.3.1`**) and **Git**.

```sh
npm install && npm run typecheck && npm run build && npm test
npm run demo:traderx      # regenerate synthetic 40-commit benchmark
npm run demo:multi-repo   # regenerate 3-repo federated demo
```

## Roadmap

1. **Signed-commit verification:** Extend `snapshot-sha256` provenance with offline Git GPG/SSH/Sigstore (`git verify-commit`) signer attestation.
2. Contribute `--from-git` timeline extraction upstream to `@finos/calm-cli` (`calm timeline`).
3. Contribute the diff-digest skill (`skills/calm-timelapse/SKILL.md`) to `@finos/calm-ai`.
4. Embed the SVG scrubber and Blast Radius inspector as a `calm-plugins/vscode` webview.
5. Add as-of date playback and moment diffing to `calm-hub` and `calm-hub-ui`.
6. Resolve remote CALM Hub `detailed-architecture` URIs via an optional local cache directory.

## Contributing

Follow [AGENTS.md](./AGENTS.md) and [CONTRIBUTING.md](./CONTRIBUTING.md). **All commits** require a DCO sign-off (`git commit -s`):

```
Signed-off-by: John Doe <john.doe@example.com>
```

## License

Copyright 2026 FINOS. Distributed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0). SPDX-License-Identifier: [Apache-2.0](https://spdx.org/licenses/Apache-2.0)
