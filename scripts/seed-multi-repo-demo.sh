#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/docs/demos/multi-repo"
CLUSTERS_FILE="$OUT_DIR/multi-repo.clusters.json"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

rm -rf "$OUT_DIR/snapshots"
mkdir -p "$OUT_DIR"

REPO_PLATFORM="$TMP_ROOT/traderx-platform"
REPO_EXEC="$TMP_ROOT/traderx-execution"
REPO_SURV="$TMP_ROOT/finra-surveillance"

for repo in "$REPO_PLATFORM" "$REPO_EXEC" "$REPO_SURV"; do
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name "FINOS Architecture Guild"
  git -C "$repo" config user.email "architecture@finos.example"
done

TMP_ROOT="$TMP_ROOT" node <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.env.TMP_ROOT;
const repoPlatform = path.join(root, 'traderx-platform');
const repoExec = path.join(root, 'traderx-execution');
const repoSurv = path.join(root, 'finra-surveillance');

function makeNode(id, type, name, description, details) {
  const n = {
    'unique-id': id,
    'node-type': type,
    name,
    description,
  };
  if (details) n.details = details;
  return n;
}

function connects(id, description, src, dst, protocol) {
  const rel = {
    'unique-id': id,
    description,
    'relationship-type': {
      connects: {
        source: { node: src },
        destination: { node: dst },
      },
    },
  };
  if (protocol) rel.protocol = protocol;
  return rel;
}

function interacts(id, description, actor, nodes) {
  return {
    'unique-id': id,
    description,
    'relationship-type': {
      interacts: {
        actor,
        nodes,
      },
    },
  };
}

function makeControl(id, name, description, extra) {
  return {
    description,
    requirements: [
      {
        'requirement-url': 'https://calm.finos.org/release/1.3/meta/control-requirement.json',
        config: {
          'control-id': id,
          name,
          description,
          ...(extra || {}),
        },
      },
    ],
  };
}

function commitCalm(repoDir, relPath, doc, dateIso, subject, adrRelPath, adrContent, indent = 2) {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(doc, null, indent) + '\n');

  if (adrRelPath && adrContent) {
    const adrFull = path.join(repoDir, adrRelPath);
    fs.mkdirSync(path.dirname(adrFull), { recursive: true });
    fs.writeFileSync(adrFull, adrContent);
  }

  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', subject], {
    cwd: repoDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
    },
  });
}

// 1. 2026-01-12 — Platform Repo: Initial Edge Gateway & Monolithic Execution Core
const platV1 = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [
    makeNode('institutional-client', 'actor', 'Institutional Desk', 'Buy-side execution desk submitting FIX/HTTPS orders.'),
    makeNode('edge-gateway', 'service', 'TraderX Edge Gateway', 'North-south ingress gateway handling session auth.'),
    makeNode('execution-core', 'system', 'Execution Core Subsystem', 'Core equity order execution subsystem.'),
  ],
  relationships: [
    interacts('client-to-edge', 'Submits institutional equity orders.', 'institutional-client', ['edge-gateway']),
    connects('edge-to-exec', 'Forwards validated orders.', 'edge-gateway', 'execution-core', 'HTTPS'),
  ],
};
commitCalm(
  repoPlatform,
  'architecture/platform.calm.json',
  platV1,
  '2026-01-12T10:00:00Z',
  'feat(platform): bootstrap edge gateway and execution core subsystem',
  'docs/adr/0001-platform-boundary.md',
  '# ADR 0001: Platform Ingress Boundary\n',
);

// Noise commit in Platform repo (formatting only — should be filtered)
commitCalm(
  repoPlatform,
  'architecture/platform.calm.json',
  platV1,
  '2026-01-14T15:00:00Z',
  'style(platform): normalize 4-space JSON indentation',
  null,
  null,
  4,
);

// 2. 2026-02-03 — FINRA Surveillance Repo (Independent Peer): Bootstraps CAT Ingestor & Isolated Postgres Trades DB
const survV1 = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [
    makeNode('cat-ingestor', 'service', 'CAT Drop-Copy Ingestor', 'Ingests regulatory trade drop-copies over SFTP.'),
    makeNode('postgres-trades-db', 'database', 'Surveillance Trades DB', 'Independent compliance PostgreSQL warehouse (isolated from execution DB).'),
  ],
  relationships: [
    connects('ingestor-to-surv-db', 'Writes immutable trade audit rows.', 'cat-ingestor', 'postgres-trades-db', 'JDBC'),
  ],
};
commitCalm(
  repoSurv,
  'calm/surveillance.calm.json',
  survV1,
  '2026-02-03T11:30:00Z',
  'feat(surveillance): launch independent FINRA CAT drop-copy ingestor and compliance DB',
  'docs/adr/0001-regulatory-isolation.md',
  '# ADR 0001: Air-Gapped Regulatory Surveillance Warehouse\n',
);

// 3. 2026-02-24 — Platform Repo + Execution Repo: Decompose Execution Core via details.detailed-architecture & Shared Kafka Backbone
const execV1 = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [
    makeNode('sor-router', 'service', 'Smart Order Router', 'Routes child slices across lit and dark venues.'),
    makeNode('matching-engine', 'service', 'Internal Crossing Engine', 'Low-latency internal midpoint matching engine.'),
    makeNode('postgres-trades-db', 'database', 'Execution Trades DB', 'Operational OLTP trade ledger inside Execution repo (same raw ID as Surveillance, kept isolated).'),
    makeNode('kafka-event-bus', 'queue', 'Shared Execution Event Bus', 'Shared boundary event bus resolved with TraderX Platform via detailed-architecture.'),
  ],
  relationships: [
    connects('sor-to-matcher', 'Sends internal crossing orders.', 'sor-router', 'matching-engine', 'TCP'),
    connects('matcher-to-exec-db', 'Persists execution fills.', 'matching-engine', 'postgres-trades-db', 'JDBC'),
    connects('matcher-to-kafka', 'Publishes execution fill events.', 'matching-engine', 'kafka-event-bus', 'AMQP'),
  ],
};
commitCalm(
  repoExec,
  'calm/execution-detail.calm.json',
  execV1,
  '2026-02-24T09:00:00Z',
  'feat(execution): publish execution-detail sub-architecture with SOR, matcher, and Kafka fills',
  'docs/adr/0002-execution-subarch.md',
  '# ADR 0002: Execution Sub-Architecture Contract\n',
);

const platV2 = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [
    ...platV1.nodes.slice(0, 2),
    makeNode('execution-core', 'system', 'Execution Core Subsystem', 'Core equity execution subsystem linked to traderx-execution repo.', {
      'detailed-architecture': 'execution-detail.calm.json',
    }),
    makeNode('kafka-event-bus', 'queue', 'Shared Execution Event Bus', 'Platform-wide execution fill backbone.'),
    makeNode('settlement-adapter', 'service', 'T+1 Settlement Adapter', 'Consumes execution fills for DTCC T+1 clearing.'),
  ],
  relationships: [
    ...platV1.relationships,
    connects('exec-to-kafka', 'Streams execution events to platform bus.', 'execution-core', 'kafka-event-bus', 'AMQP'),
    connects('settlement-from-kafka', 'Consumes fill stream for clearing.', 'settlement-adapter', 'kafka-event-bus', 'AMQP'),
  ],
};
commitCalm(
  repoPlatform,
  'architecture/platform.calm.json',
  platV2,
  '2026-02-24T14:00:00Z',
  'feat(platform): link execution-core via detailed-architecture and attach T+1 settlement adapter',
  'docs/adr/0002-federated-execution-link.md',
  '# ADR 0002: Link Execution Repo via CALM detailed-architecture\n',
);

// 4. 2026-03-18 — Execution Repo: Add Pre-Trade Risk Engine & mTLS Hardening
const execV2 = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [
    ...execV1.nodes,
    makeNode('pretrade-risk', 'service', 'SEC 15c3-5 Risk Gate', 'Enforces credit, fat-finger, and market-access limits prior to routing.'),
  ],
  relationships: [
    connects('sor-to-risk', 'Validates order limits synchronously.', 'sor-router', 'pretrade-risk', 'mTLS'),
    connects('sor-to-matcher', 'Sends risk-approved crossing orders over mTLS.', 'sor-router', 'matching-engine', 'mTLS'),
    connects('matcher-to-exec-db', 'Persists execution fills.', 'matching-engine', 'postgres-trades-db', 'JDBC'),
    connects('matcher-to-kafka', 'Publishes execution fill events.', 'matching-engine', 'kafka-event-bus', 'AMQP'),
  ],
  controls: {
    'sec-15c3-5-pretrade': makeControl(
      'sec-15c3-5-pretrade',
      'SEC Rule 15c3-5 Pre-Trade Risk Gate',
      'Blocks unapproved direct market access and enforces sub-millisecond credit checks.',
      { maxLatencyMicros: 350, mTlsEnforced: true },
    ),
  },
};
commitCalm(
  repoExec,
  'calm/execution-detail.calm.json',
  execV2,
  '2026-03-18T11:00:00Z',
  'feat(execution): enforce SEC 15c3-5 pre-trade risk gate and mTLS internal transport',
  'docs/adr/0003-sec-15c3-5-mtls.md',
  '# ADR 0003: Mandatory Pre-Trade Risk & Zero-Trust mTLS\n',
);

// Noise commit in Surveillance repo (whitespace/key-order noise — filtered)
commitCalm(
  repoSurv,
  'calm/surveillance.calm.json',
  { relationships: survV1.relationships, $schema: survV1.$schema, nodes: survV1.nodes },
  '2026-03-20T08:00:00Z',
  'chore(surveillance): sort top-level JSON keys',
);

// 5. 2026-04-09 — FINRA Surveillance Repo: Add Spoofing Alert Engine & WORM SEC 17a-4 Archive
const survV2 = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [
    ...survV1.nodes,
    makeNode('finra-alert-engine', 'service', 'Spoofing & Layering Detector', 'Evaluates cross-venue order-to-trade ratios for market abuse.'),
    makeNode('worm-audit-vault', 'database', 'SEC 17a-4 WORM Archive', 'Immutable 7-year regulatory evidence store.'),
  ],
  relationships: [
    ...survV1.relationships,
    connects('alert-reads-surv-db', 'Queries reconstructed order book.', 'finra-alert-engine', 'postgres-trades-db', 'JDBC'),
    connects('alert-writes-worm', 'Archives signed surveillance alerts.', 'finra-alert-engine', 'worm-audit-vault', 'HTTPS'),
  ],
  controls: {
    'sec-17a-4-worm-retention': makeControl(
      'sec-17a-4-worm-retention',
      'SEC Rule 17a-4 WORM Retention',
      'Retains surveillance alerts and CAT audit trails in non-rewriteable WORM storage for 7 years.',
      { retentionYears: 7, immutableLock: true },
    ),
  },
};
commitCalm(
  repoSurv,
  'calm/surveillance.calm.json',
  survV2,
  '2026-04-09T16:15:00Z',
  'feat(surveillance): deploy spoofing detector and SEC 17a-4 WORM archive',
  'docs/adr/0002-worm-surveillance-retention.md',
  '# ADR 0002: SEC 17a-4 WORM Retention for Surveillance Alerts\n',
);
EOF

echo "[1/2] Emitting synchronized 3-repo commit diff digest..."
node "$ROOT_DIR/dist/cli.js" \
  --from-git \
    "TraderX Platform=$REPO_PLATFORM/architecture/platform.calm.json" \
    "TraderX Execution=$REPO_EXEC/calm/execution-detail.calm.json" \
    "FINRA Surveillance=$REPO_SURV/calm/surveillance.calm.json" \
  -o "$OUT_DIR/multi-repo.timeline.json" \
  --snapshots-dir "$OUT_DIR/snapshots" \
  --emit-digest "$OUT_DIR/multi-repo.digest.json"

cat > "$CLUSTERS_FILE" <<'EOF'
[
  {
    "startIndex": 0,
    "endIndex": 0,
    "uniqueId": "moment-01-platform-edge-bootstrap",
    "name": "TraderX Platform Ingress & Execution Boundary",
    "description": "The TraderX Platform repository establishes the initial north-south Institutional Desk ingress through Edge Gateway into the high-level Execution Core subsystem over HTTPS (ADR-0001)."
  },
  {
    "startIndex": 1,
    "endIndex": 1,
    "uniqueId": "moment-02-isolated-finra-surveillance",
    "name": "Independent FINRA CAT Surveillance Launch",
    "description": "The independent FINRA Surveillance repository launches CAT Drop-Copy Ingestor and its own PostgreSQL warehouse (postgres-trades-db). Because Surveillance is an unlinked peer repository, its nodes remain strictly isolated in their own namespace."
  },
  {
    "startIndex": 2,
    "endIndex": 3,
    "uniqueId": "moment-03-federated-execution-composition",
    "name": "Federated Execution Sub-Architecture & Shared Kafka",
    "description": "TraderX Platform links Execution Core to the TraderX Execution repository via details.detailed-architecture. Shared boundary node kafka-event-bus merges canonically across both repos while Execution's postgres-trades-db stays strictly separate from Surveillance's postgres-trades-db."
  },
  {
    "startIndex": 4,
    "endIndex": 4,
    "uniqueId": "moment-04-execution-pretrade-risk-mtls",
    "name": "SEC 15c3-5 Pre-Trade Risk & Zero-Trust mTLS",
    "description": "Inside the TraderX Execution repository, Smart Order Router introduces synchronous SEC 15c3-5 Pre-Trade Risk checks and upgrades internal matching links from plain TCP to mutual TLS (ADR-0003)."
  },
  {
    "startIndex": 5,
    "endIndex": 5,
    "uniqueId": "moment-05-surveillance-spoofing-worm-vault",
    "name": "FINRA Spoofing Analytics & SEC 17a-4 WORM Vault",
    "description": "The FINRA Surveillance repository deploys Spoofing & Layering Detector and a 7-year immutable SEC 17a-4 WORM Archive (ADR-0002), completing cross-program compliance visibility on a single synchronized timeline."
  }
]
EOF

echo "[2/2] Applying curated multi-repo clusters and rendering synchronized HTML timelapse..."
rm -rf "$OUT_DIR/snapshots"
node "$ROOT_DIR/dist/cli.js" \
  --from-git \
    "TraderX Platform=$REPO_PLATFORM/architecture/platform.calm.json" \
    "TraderX Execution=$REPO_EXEC/calm/execution-detail.calm.json" \
    "FINRA Surveillance=$REPO_SURV/calm/surveillance.calm.json" \
  --clusters "$CLUSTERS_FILE" \
  -o "$OUT_DIR/multi-repo.timeline.json" \
  --snapshots-dir "$OUT_DIR/snapshots" \
  --timelapse "$OUT_DIR/multi-repo.timelapse.html" \
  --validate \
  --validate-snapshots

echo "Done! Multi-repo artifacts written to $OUT_DIR"
