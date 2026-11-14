#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/docs/demos/traderx"
CLUSTERS_FILE="$OUT_DIR/traderx.clusters.json"
TMP_REPO="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_REPO"
}
trap cleanup EXIT

rm -rf "$OUT_DIR/snapshots"
mkdir -p "$OUT_DIR"

git -C "$TMP_REPO" init -q -b main
git -C "$TMP_REPO" config user.name "TraderX Architecture Guild"
git -C "$TMP_REPO" config user.email "architecture@traderx.example"

TMP_REPO="$TMP_REPO" node <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = process.env.TMP_REPO;
const archRel = 'architecture/traderx.calm.json';
const archAbs = path.join(repo, archRel);
fs.mkdirSync(path.dirname(archAbs), { recursive: true });
fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true });

function makeNode(id, type, name, description, interfaces) {
  const n = {
    'unique-id': id,
    'node-type': type,
    name,
    description,
  };
  if (interfaces && interfaces.length > 0) {
    n.interfaces = interfaces;
  }
  return n;
}

function connects(id, description, src, dst, protocol, dstInterfaces) {
  const destination = { node: dst };
  if (dstInterfaces && dstInterfaces.length > 0) {
    destination.interfaces = dstInterfaces;
  }
  const rel = {
    'unique-id': id,
    description,
    'relationship-type': {
      connects: {
        source: { node: src },
        destination,
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

function controlDef(id, name, description, extra) {
  return {
    description,
    requirements: [
      {
        'requirement-url': 'https://calm.finos.org/release/1.3/meta/control-requirement.json',
        config: {
          'control-id': id,
          name,
          description,
          ...extra,
        },
      },
    ],
  };
}

const doc = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [],
  relationships: [],
};

function upsertNode(node) {
  const idx = doc.nodes.findIndex((n) => n['unique-id'] === node['unique-id']);
  if (idx >= 0) doc.nodes[idx] = node;
  else doc.nodes.push(node);
}

function removeNode(id) {
  doc.nodes = doc.nodes.filter((n) => n['unique-id'] !== id);
}

function upsertRel(rel) {
  const idx = doc.relationships.findIndex((r) => r['unique-id'] === rel['unique-id']);
  if (idx >= 0) doc.relationships[idx] = rel;
  else doc.relationships.push(rel);
}

function removeRel(id) {
  doc.relationships = doc.relationships.filter((r) => r['unique-id'] !== id);
}

function upsertFlow(flow) {
  if (!doc.flows) doc.flows = [];
  const idx = doc.flows.findIndex((f) => f['unique-id'] === flow['unique-id']);
  if (idx >= 0) doc.flows[idx] = flow;
  else doc.flows.push(flow);
}

function setControl(id, ctrl) {
  if (!doc.controls) doc.controls = {};
  doc.controls[id] = ctrl;
}

function commitStep({ date, author, message, indent = 2, reverseTopKeys = false, adr }) {
  let payload = doc;
  if (reverseTopKeys) {
    payload = {};
    for (const k of Object.keys(doc).reverse()) {
      payload[k] = doc[k];
    }
  }
  fs.writeFileSync(archAbs, JSON.stringify(payload, null, indent) + '\n', 'utf8');
  if (adr) {
    const adrPath = path.join(repo, adr.path);
    fs.mkdirSync(path.dirname(adrPath), { recursive: true });
    fs.writeFileSync(adrPath, adr.content, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase().replace(/[^a-z]/g, '.')}@traderx.example`,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author.toLowerCase().replace(/[^a-z]/g, '.')}@traderx.example`,
      GIT_AUTHOR_DATE: `${date}T14:00:00Z`,
      GIT_COMMITTER_DATE: `${date}T14:00:00Z`,
    },
  });
}

// Commit 1 (idx 0): Baseline monolith
upsertNode(makeNode('trader-actor', 'actor', 'Institutional Equity Trader', 'Executes equity block and algorithmic orders through TraderX Workstation.'));
upsertNode(makeNode('traderx-web', 'webclient', 'TraderX Blotter Web UI', 'Browser order blotter for institutional equity trading desks.'));
upsertNode(makeNode('monolith-order-svc', 'service', 'Legacy Order Monolith', 'Java EE monolithic order capture, booking, and position engine.', [{ 'unique-id': 'monolith-http', host: 'monolith.internal', port: 8080 }]));
upsertNode(makeNode('oracle-trades-db', 'database', 'Legacy Oracle Trades DB', 'Single-region relational store holding orders, fills, and EOD blotters.'));
upsertRel(interacts('trader-uses-web', 'Trader submits and monitors orders via web blotter.', 'trader-actor', ['traderx-web']));
upsertRel(connects('web-to-monolith', 'Browser posts order tickets directly to legacy monolith over plain HTTP.', 'traderx-web', 'monolith-order-svc', 'HTTP', ['monolith-http']));
upsertRel(connects('monolith-to-oracle', 'Monolith persists orders and fills in Oracle.', 'monolith-order-svc', 'oracle-trades-db', 'JDBC'));
commitStep({ date: '2025-01-06', author: 'Elena Rostova', message: 'feat(arch): capture initial TraderX legacy order desk baseline' });

// Sprint 1: Zero-Trust API Gateway & OIDC (commits 2..6, structural 1..4 + 1 noise)
upsertNode(makeNode('edge-api-gateway', 'network', 'Zero-Trust Edge API Gateway', 'Envoy-based ingress gateway terminating TLS 1.3 and enforcing OIDC bearer tokens.', [{ 'unique-id': 'gateway-https', host: 'api.traderx.internal', port: 443 }]));
upsertNode(makeNode('ping-oidc-idp', 'system', 'Enterprise OIDC Identity Provider', 'Issues short-lived FAPI-compliant OAuth 2.1 / OIDC tokens for trading desks.'));
commitStep({
  date: '2025-01-14',
  author: 'Marcus Vance',
  message: 'feat(security): introduce edge API gateway and OIDC identity provider',
  adr: {
    path: 'docs/adr/ADR-001-zero-trust-api-gateway.md',
    content: '# ADR-001: Terminate Browser Traffic at Zero-Trust API Gateway\n\nAll TraderX blotter traffic must authenticate via OIDC and traverse `edge-api-gateway` over TLS/mTLS.\n',
  },
});

removeRel('web-to-monolith');
upsertRel(connects('web-to-gateway', 'Web blotter sends authenticated order requests over HTTPS.', 'traderx-web', 'edge-api-gateway', 'HTTPS', ['gateway-https']));
upsertRel(connects('gateway-to-monolith', 'Gateway forwards validated order requests to monolith.', 'edge-api-gateway', 'monolith-order-svc', 'HTTP', ['monolith-http']));
commitStep({ date: '2025-01-16', author: 'Marcus Vance', message: 'refactor(ingress): route traderx-web traffic exclusively through edge-api-gateway' });

// Noise commit 1 (commit 4)
commitStep({ date: '2025-01-17', author: 'CI Formatter Bot', message: 'style(calm): normalize indentation to 4 spaces', indent: 4, reverseTopKeys: true });

upsertRel(connects('web-to-oidc', 'Web blotter performs OAuth 2.1 PKCE login handshake.', 'traderx-web', 'ping-oidc-idp', 'HTTPS'));
upsertRel(connects('gateway-to-oidc', 'Gateway validates JWT signatures via OIDC JWKS endpoint.', 'edge-api-gateway', 'ping-oidc-idp', 'HTTPS'));
commitStep({ date: '2025-01-20', author: 'Marcus Vance', message: 'feat(auth): wire OIDC PKCE and JWKS validation links' });

upsertRel(connects('gateway-to-monolith', 'Gateway forwards validated order requests over mutual TLS.', 'edge-api-gateway', 'monolith-order-svc', 'mTLS', ['monolith-http']));
setControl('mtls-everywhere', controlDef('mtls-everywhere', 'East-West Mutual TLS Enforcement', 'Requires SPIFFE/SPIRE mTLS certificates across internal service-to-service trading hops.', { tlsVersion: '1.3', identityFramework: 'SPIFFE' }));
commitStep({ date: '2025-01-22', author: 'Elena Rostova', message: 'feat(controls): upgrade east-west gateway hop to mTLS and enforce mtls-everywhere' });

// Sprint 2: Order Router & Kafka Backbone (commits 7..11, structural 5..8 + 1 noise)
upsertNode(makeNode('kafka-event-bus', 'queue', 'Kafka Order Event Backbone', 'Partitioned low-latency event log carrying order commands, risk approvals, and execution fills.'));
commitStep({
  date: '2025-02-03',
  author: 'Priya Nair',
  message: 'feat(messaging): provision Kafka order event backbone',
  adr: {
    path: 'docs/adr/ADR-002-kafka-event-backbone.md',
    content: '# ADR-002: Event-Sourced Order Lifecycle on Apache Kafka\n\nDecouple stateless order ingress from booking and venue execution via `kafka-event-bus`.\n',
  },
});

upsertNode(makeNode('order-router-svc', 'service', 'Stateless Order Router', 'Validates FIX/REST order payloads, assigns clOrdId, and orchestrates routing.', [{ 'unique-id': 'router-grpc', host: 'order-router.internal', port: 9443 }]));
removeRel('gateway-to-monolith');
upsertRel(connects('gateway-to-router', 'Gateway dispatches validated client orders to stateless router over mTLS.', 'edge-api-gateway', 'order-router-svc', 'mTLS', ['router-grpc']));
commitStep({ date: '2025-02-06', author: 'Priya Nair', message: 'feat(routing): extract stateless order-router-svc behind API gateway' });

upsertRel(connects('router-to-kafka', 'Order router publishes normalized OrderSubmitted events.', 'order-router-svc', 'kafka-event-bus', 'AMQP'));
upsertRel(connects('kafka-to-monolith', 'Legacy monolith consumes order events during strangler migration.', 'kafka-event-bus', 'monolith-order-svc', 'AMQP'));
commitStep({ date: '2025-02-10', author: 'Priya Nair', message: 'feat(routing): stream router events through kafka-event-bus into monolith consumer' });

// Noise commit 2 (commit 10)
commitStep({ date: '2025-02-12', author: 'CI Formatter Bot', message: 'chore(lint): reorder top-level CALM keys without structural edits', indent: 2, reverseTopKeys: true });

upsertFlow({
  'unique-id': 'order-submission-flow',
  name: 'Client Order Submission Flow',
  description: 'End-to-end ingress path from trader workstation blotter into the Kafka order event log.',
  transitions: [
    { 'relationship-unique-id': 'trader-uses-web', 'sequence-number': 1, description: 'Trader stages equity order ticket in blotter.' },
    { 'relationship-unique-id': 'web-to-gateway', 'sequence-number': 2, description: 'Blotter submits bearer-authenticated HTTPS order.' },
    { 'relationship-unique-id': 'gateway-to-router', 'sequence-number': 3, description: 'Gateway forwards order over gRPC/mTLS to order router.' },
    { 'relationship-unique-id': 'router-to-kafka', 'sequence-number': 4, description: 'Router appends normalized event to Kafka.' },
  ],
});
commitStep({ date: '2025-02-14', author: 'Elena Rostova', message: 'feat(flows): codify order-submission-flow across ingress pipeline' });

// Sprint 3: Pre-Trade Risk Engine & Position Cache (commits 12..15, structural 9..12)
upsertNode(makeNode('pretrade-risk-svc', 'service', 'Pre-Trade Risk Engine', 'Evaluates SEC 15c3-5 market-access credit thresholds, fat-finger collars, and restricted lists.', [{ 'unique-id': 'risk-grpc', host: 'risk.internal', port: 9444 }]));
commitStep({
  date: '2025-03-03',
  author: 'Devon Brooks',
  message: 'feat(risk): add SEC 15c3-5 pretrade-risk-svc node',
  adr: {
    path: 'docs/adr/ADR-003-pretrade-risk-circuit-breaker.md',
    content: '# ADR-003: Synchronous Pre-Trade Risk Gate (SEC Rule 15c3-5)\n\nEvery order must pass `pretrade-risk-svc` sub-2ms checks backed by `redis-position-cache` prior to venue release.\n',
  },
});

upsertNode(makeNode('redis-position-cache', 'database', 'In-Memory Intraday Position Cache', 'Low-latency Redis Enterprise cluster tracking desk gross/net exposure in real time.'));
upsertRel(connects('risk-to-redis', 'Risk engine reads intraday net exposure counters over TLS.', 'pretrade-risk-svc', 'redis-position-cache', 'TLS'));
commitStep({ date: '2025-03-06', author: 'Devon Brooks', message: 'feat(risk): back pretrade-risk-svc with redis-position-cache' });

upsertRel(connects('router-to-risk', 'Order router invokes synchronous pre-trade limit check over mTLS.', 'order-router-svc', 'pretrade-risk-svc', 'mTLS', ['risk-grpc']));
commitStep({ date: '2025-03-10', author: 'Devon Brooks', message: 'feat(risk): wire synchronous gRPC/mTLS pre-trade risk gate from order-router-svc' });

upsertFlow({
  'unique-id': 'order-submission-flow',
  name: 'Risk-Gated Client Order Submission Flow',
  description: 'Client order ingress gated by synchronous SEC 15c3-5 pre-trade risk verification prior to Kafka publication.',
  transitions: [
    { 'relationship-unique-id': 'trader-uses-web', 'sequence-number': 1, description: 'Trader submits equity order ticket.' },
    { 'relationship-unique-id': 'web-to-gateway', 'sequence-number': 2, description: 'Blotter posts HTTPS order to edge gateway.' },
    { 'relationship-unique-id': 'gateway-to-router', 'sequence-number': 3, description: 'Gateway routes order to stateless order router.' },
    { 'relationship-unique-id': 'router-to-risk', 'sequence-number': 4, description: 'Order router executes synchronous SEC 15c3-5 risk check.' },
    { 'relationship-unique-id': 'risk-to-redis', 'sequence-number': 5, description: 'Risk engine verifies intraday exposure in Redis cache.' },
    { 'relationship-unique-id': 'router-to-kafka', 'sequence-number': 6, description: 'Approved order event commits to Kafka.' },
  ],
});
commitStep({ date: '2025-03-14', author: 'Devon Brooks', message: 'feat(flows): insert pre-trade risk verification steps into order-submission-flow' });

// Sprint 4: FIX Execution Gateway & Market Data (commits 16..21, structural 13..17 + 1 noise)
upsertNode(makeNode('fix-execution-gateway', 'service', 'FIX 4.4 Venue Execution Gateway', 'Manages persistent QuickFIX sessions, sequence recovery, and child-order routing to exchanges.'));
upsertNode(makeNode('external-liquidity-venue', 'system', 'External Equity Exchange Venue', 'Regulated matching engine accepting institutional FIX order flow and returning ExecutionReports.'));
commitStep({ date: '2025-03-31', author: 'Priya Nair', message: 'feat(execution): introduce fix-execution-gateway and external-liquidity-venue' });

upsertRel(connects('kafka-to-fix', 'FIX gateway consumes risk-approved orders from Kafka.', 'kafka-event-bus', 'fix-execution-gateway', 'mTLS'));
upsertRel(connects('fix-to-venue', 'FIX gateway transmits NewOrderSingle messages over leased TLS session.', 'fix-execution-gateway', 'external-liquidity-venue', 'TLS'));
commitStep({ date: '2025-04-03', author: 'Priya Nair', message: 'feat(execution): connect Kafka approved order topic through FIX gateway to venue' });

// Noise commit 3 (commit 18)
commitStep({ date: '2025-04-05', author: 'CI Formatter Bot', message: 'style(calm): format traderx architecture JSON with 4-space indent', indent: 4 });

upsertNode(makeNode('market-data-feed', 'service', 'Consolidated NBBO Market Data Ticker', 'Normalizes SIP/direct-feed NBBO quotes for fat-finger collar and mark-to-market valuation.'));
upsertRel(connects('marketdata-to-redis', 'Ticker streams live NBBO reference prices into Redis cache.', 'market-data-feed', 'redis-position-cache', 'TLS'));
upsertRel(connects('marketdata-to-risk', 'Ticker pushes volatility circuit-breaker halts to pre-trade risk.', 'market-data-feed', 'pretrade-risk-svc', 'mTLS', ['risk-grpc']));
commitStep({ date: '2025-04-08', author: 'Devon Brooks', message: 'feat(marketdata): wire live NBBO market-data-feed into risk and position cache' });

upsertRel(connects('fix-to-kafka', 'FIX gateway publishes ExecutionReport fills and busts back to Kafka.', 'fix-execution-gateway', 'kafka-event-bus', 'mTLS'));
upsertFlow({
  'unique-id': 'execution-fill-flow',
  name: 'Exchange Execution Fill Capture Flow',
  description: 'Streams exchange FIX ExecutionReport fills back onto the Kafka event backbone.',
  transitions: [
    { 'relationship-unique-id': 'kafka-to-fix', 'sequence-number': 1, description: 'FIX gateway reads risk-approved order command.' },
    { 'relationship-unique-id': 'fix-to-venue', 'sequence-number': 2, description: 'Gateway routes FIX 4.4 order to external exchange.' },
    { 'relationship-unique-id': 'fix-to-kafka', 'sequence-number': 3, description: 'Gateway publishes normalized fill event to Kafka.' },
  ],
});
commitStep({ date: '2025-04-10', author: 'Priya Nair', message: 'feat(execution): publish venue ExecutionReports to Kafka and add execution-fill-flow' });

upsertNode(makeNode('fix-execution-gateway', 'service', 'FIX 4.4 Venue Execution Gateway', 'Manages persistent QuickFIX sessions, drop-copy listeners, and child-order routing to exchanges.', [{ 'unique-id': 'fix-dropcopy-session', host: 'fix-gw.internal', port: 9876 }]));
commitStep({ date: '2025-04-14', author: 'Priya Nair', message: 'feat(execution): expose dedicated fix-dropcopy-session interface on FIX gateway' });

// Sprint 5: Monolith Retirement & Postgres Clearing Split (commits 22..25, structural 18..21)
upsertNode(makeNode('trade-ledger-svc', 'service', 'Canonical Trade Ledger Service', 'Idempotent double-entry trade booking service consuming execution fills.', [{ 'unique-id': 'ledger-grpc', host: 'ledger.internal', port: 9445 }]));
upsertNode(makeNode('postgres-trades-db', 'database', 'Cloud-Native PostgreSQL Trade Store', 'High-availability PostgreSQL cluster storing canonical trade bookings and allocations.'));
commitStep({ date: '2025-04-28', author: 'Elena Rostova', message: 'feat(ledger): deploy trade-ledger-svc and postgres-trades-db alongside legacy monolith' });

upsertRel(connects('kafka-to-ledger', 'Trade ledger consumes execution fills and lifecycle transitions from Kafka.', 'kafka-event-bus', 'trade-ledger-svc', 'mTLS'));
upsertRel(connects('ledger-to-postgres', 'Trade ledger writes ACID trade records over JDBC.', 'trade-ledger-svc', 'postgres-trades-db', 'JDBC'));
commitStep({ date: '2025-05-02', author: 'Elena Rostova', message: 'feat(ledger): wire Kafka fill consumer through trade-ledger-svc to PostgreSQL' });

upsertNode(makeNode('settlement-clearing-svc', 'service', 'DTCC Clearing & Settlement Adapter', 'Generates T+1 institutional trade affirmations and clearing instructions.'));
upsertRel(connects('kafka-to-clearing', 'Clearing adapter consumes booked trade events from Kafka.', 'kafka-event-bus', 'settlement-clearing-svc', 'mTLS'));
upsertRel(connects('clearing-to-postgres', 'Clearing adapter reconciles allocation state against PostgreSQL.', 'settlement-clearing-svc', 'postgres-trades-db', 'JDBC'));
commitStep({ date: '2025-05-06', author: 'Elena Rostova', message: 'feat(clearing): add T+1 settlement-clearing-svc backed by PostgreSQL trade store' });

removeRel('kafka-to-monolith');
removeRel('monolith-to-oracle');
removeNode('monolith-order-svc');
removeNode('oracle-trades-db');
commitStep({ date: '2025-05-09', author: 'Elena Rostova', message: 'refactor(decommission): retire legacy monolith-order-svc and oracle-trades-db' });

// Sprint 6: SEC 17a-4 Immutable WORM Audit Ledger (commits 26..30, structural 22..25 + 1 noise)
upsertNode(makeNode('worm-audit-archiver', 'service', 'Immutable Audit Archiver', 'Hashes order/fill event envelopes into Merkle batches and seals them into WORM storage.', [{ 'unique-id': 'audit-verify-api', host: 'audit.internal', port: 8443 }]));
upsertNode(makeNode('s3-object-lock-vault', 'database', 'SEC 17a-4 WORM Object-Lock Vault', 'Compliance-mode S3 Object Lock bucket preventing deletion or mutation for 7 years.'));
commitStep({
  date: '2025-05-26',
  author: 'Marcus Vance',
  message: 'feat(compliance): introduce worm-audit-archiver and s3-object-lock-vault',
  adr: {
    path: 'docs/adr/ADR-004-sec-17a4-worm-ledger.md',
    content: '# ADR-004: SEC Rule 17a-4 Write-Once-Read-Many (WORM) Audit Trail\n\nArchive all order, risk, and execution events into compliance-mode Object Lock storage via `worm-audit-archiver`.\n',
  },
});

// Noise commit 4 (commit 27)
commitStep({ date: '2025-05-28', author: 'CI Formatter Bot', message: 'style(calm): normalize key ordering in traderx.calm.json', reverseTopKeys: true });

upsertRel(connects('kafka-to-archiver', 'Archiver streams all order, risk, and fill topics from Kafka.', 'kafka-event-bus', 'worm-audit-archiver', 'mTLS'));
upsertRel(connects('archiver-to-worm', 'Archiver writes SHA-256 chained Parquet batches into WORM vault.', 'worm-audit-archiver', 's3-object-lock-vault', 'HTTPS'));
commitStep({ date: '2025-05-30', author: 'Marcus Vance', message: 'feat(compliance): stream Kafka lifecycle events into WORM Object-Lock vault' });

setControl('sec-17a4-worm', controlDef('sec-17a4-worm', 'SEC Rule 17a-4 Immutable Recordkeeping', 'Enforces compliance-mode Object Lock with 7-year retention and cryptographic hash verification on trade audit records.', { retentionYears: 7, lockMode: 'COMPLIANCE' }));
commitStep({ date: '2025-06-03', author: 'Marcus Vance', message: 'feat(controls): bind sec-17a4-worm 7-year compliance retention control' });

upsertNode(makeNode('compliance-officer', 'actor', 'Surveillance & Compliance Officer', 'Inspects trade reconstruction evidence and cryptographic WORM proofs during supervisory reviews.'));
upsertRel(interacts('compliance-queries-archiver', 'Compliance officer verifies immutable order-trail proofs.', 'compliance-officer', ['worm-audit-archiver']));
commitStep({ date: '2025-06-06', author: 'Marcus Vance', message: 'feat(compliance): model compliance-officer supervisory access to worm-audit-archiver' });

// Sprint 7: DORA Multi-Region Resilience & Telemetry (commits 31..34, structural 26..29)
upsertNode(makeNode('otel-observability-hub', 'system', 'OpenTelemetry Tracing & SLO Hub', 'Collects distributed trace spans, latency histograms, and breaker state across trading services.'));
upsertNode(makeNode('dr-standby-cluster', 'system', 'Warm-Standby Secondary Region Cluster', 'Cross-region failover environment maintaining synchronized trade state and Kafka offsets.'));
commitStep({
  date: '2025-06-23',
  author: 'Devon Brooks',
  message: 'feat(resilience): add otel-observability-hub and dr-standby-cluster',
  adr: {
    path: 'docs/adr/ADR-005-dora-multi-region-failover.md',
    content: '# ADR-005: EU DORA ICT Operational Resilience & Secondary Region Standby\n\nReplicate `postgres-trades-db` and `kafka-event-bus` continuously to `dr-standby-cluster` with OpenTelemetry SLO alerting.\n',
  },
});

upsertRel(connects('postgres-to-dr', 'PostgreSQL streams WAL replication over encrypted cross-region link.', 'postgres-trades-db', 'dr-standby-cluster', 'TLS'));
upsertRel(connects('kafka-to-dr', 'MirrorMaker 2 replicates order and fill topics to warm-standby region.', 'kafka-event-bus', 'dr-standby-cluster', 'mTLS'));
commitStep({ date: '2025-06-27', author: 'Devon Brooks', message: 'feat(resilience): enable cross-region WAL and Kafka replication to dr-standby-cluster' });

upsertRel(connects('router-to-otel', 'Order router exports OTLP trace spans and latency metrics.', 'order-router-svc', 'otel-observability-hub', 'HTTPS'));
upsertRel(connects('risk-to-otel', 'Pre-trade risk exports collar breach telemetry.', 'pretrade-risk-svc', 'otel-observability-hub', 'HTTPS'));
upsertRel(connects('fix-to-otel', 'FIX gateway exports venue heartbeat and drop-copy lag metrics.', 'fix-execution-gateway', 'otel-observability-hub', 'HTTPS'));
commitStep({ date: '2025-07-02', author: 'Devon Brooks', message: 'feat(observability): stream OTLP telemetry from router, risk, and FIX gateway' });

setControl('dora-ict-resilience', controlDef('dora-ict-resilience', 'DORA ICT Operational Resilience & Failover', 'Mandates continuous cross-region replication with RPO under 60 seconds and quarterly automated failover drills.', { targetRpoSeconds: 60, drillCadence: 'QUARTERLY' }));
commitStep({ date: '2025-07-07', author: 'Elena Rostova', message: 'feat(controls): add dora-ict-resilience control for multi-region failover readiness' });

// Sprint 8: FINRA CAT Regulatory Reporting Pipeline (commits 35..40, structural 30..34 + 1 noise)
upsertNode(makeNode('cat-regulatory-reporter', 'service', 'FINRA CAT Regulatory Reporter', 'Assembles clock-synchronized order, route, and fill events into daily Consolidated Audit Trail submissions.'));
upsertNode(makeNode('finra-cat-portal', 'system', 'FINRA CAT Central Repository', 'External regulatory intake system validating broker-dealer T+1 order lifecycle reports.'));
commitStep({ date: '2025-07-21', author: 'Marcus Vance', message: 'feat(cat): introduce cat-regulatory-reporter and external finra-cat-portal' });

// Noise commit 5 (commit 36)
commitStep({ date: '2025-07-24', author: 'CI Formatter Bot', message: 'chore(format): re-run JSON pretty-printer across architecture directory', indent: 4, reverseTopKeys: true });

upsertRel(connects('reporter-reads-worm', 'CAT reporter reads sealed audit event batches from WORM vault.', 'cat-regulatory-reporter', 's3-object-lock-vault', 'HTTPS'));
upsertRel(connects('reporter-reads-ledger', 'CAT reporter reconciles order allocations with canonical trade ledger.', 'cat-regulatory-reporter', 'trade-ledger-svc', 'mTLS', ['ledger-grpc']));
commitStep({ date: '2025-07-28', author: 'Marcus Vance', message: 'feat(cat): reconcile cat-regulatory-reporter against WORM vault and trade ledger' });

upsertRel(connects('reporter-to-finra', 'CAT reporter transmits encrypted T+1 submission files to FINRA CAT.', 'cat-regulatory-reporter', 'finra-cat-portal', 'SFTP'));
commitStep({ date: '2025-08-04', author: 'Marcus Vance', message: 'feat(cat): wire SFTP/mTLS submission channel to finra-cat-portal' });

upsertFlow({
  'unique-id': 'regulatory-cat-submission-flow',
  name: 'FINRA CAT T+1 Regulatory Submission Flow',
  description: 'Reconciles immutable WORM lifecycle events with booked trades and transmits validated CAT files.',
  transitions: [
    { 'relationship-unique-id': 'reporter-reads-worm', 'sequence-number': 1, description: 'Reporter loads sealed WORM lifecycle batches.' },
    { 'relationship-unique-id': 'reporter-reads-ledger', 'sequence-number': 2, description: 'Reporter cross-checks allocations against trade ledger.' },
    { 'relationship-unique-id': 'reporter-to-finra', 'sequence-number': 3, description: 'Reporter uploads signed CAT file over SFTP/mTLS.' },
  ],
});
commitStep({ date: '2025-08-14', author: 'Marcus Vance', message: 'feat(flows): define regulatory-cat-submission-flow across WORM, ledger, and FINRA CAT' });

setControl('finra-cat-sla', controlDef('finra-cat-sla', 'FINRA Rule 6800 CAT T+1 Reporting SLA', 'Requires NTP/PTP clock-synchronized lifecycle linkage and T+1 08:00 ET submission completeness.', { deadlineEt: '08:00', clockSyncToleranceMs: 50 }));
commitStep({ date: '2025-08-22', author: 'Elena Rostova', message: 'feat(controls): enforce finra-cat-sla T+1 08:00 ET reporting control' });
EOF

node "$ROOT_DIR/dist/cli.js" \
  --from-git "$TMP_REPO/architecture/traderx.calm.json" \
  --emit-digest "$OUT_DIR/traderx.digest.json" \
  --clusters "$CLUSTERS_FILE" \
  -o "$OUT_DIR/traderx.timeline.json" \
  --snapshots-dir "$OUT_DIR/snapshots" \
  --timelapse "$OUT_DIR/traderx.timelapse.html" \
  --validate \
  --validate-snapshots
