// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeStructuralDelta, summarizeCounts } from './calm-diff.js';
import { buildCommitHistoryDigest } from './cluster.js';
import { defaultGitRunner } from './git-history.js';
import type { FullGitTimelineResult } from './index.js';
import {
  assembleCalmTimeline,
  validateCalmArchitectureSnapshot,
  validateTimelineStructure,
} from './timeline-emitter.js';
import { buildTimelapsePayloadFromClusters, writeTimelapseHtml } from './timelapse-html.js';
import type {
  GitCommandRunner,
  GitCommitSnapshot,
  MomentCluster,
  StructuralCommitDelta,
} from './types.js';

export const CALM_13_SCHEMA = 'https://calm.finos.org/release/1.3/meta/calm.json';
export const CALM_13_CONTROL_REQ_SCHEMA =
  'https://calm.finos.org/release/1.3/meta/control-requirement.json';
const TRADERX_BLOB_BASE = 'https://github.com/finos/traderx/blob/main';

export interface TraderXCatalogState {
  id: string;
  title: string;
  status?: string;
  track?: string;
  isConvergence?: boolean;
  featurePack: string;
  previous?: string[];
  publish?: {
    branch?: string;
    tag?: string;
  };
}

export interface TraderXEntrypoint {
  name: string;
  url: string;
}

export interface TraderXArchitectureNode {
  id: string;
  label?: string;
  kind?: string;
  description?: string;
}

export interface TraderXArchitectureEdge {
  from: string;
  to: string;
  label?: string;
}

export interface TraderXArchitectureModel {
  stateId?: string;
  title?: string;
  description?: string;
  inheritsFrom?: string | null;
  flowDoc?: string;
  entrypoints?: TraderXEntrypoint[];
  nodes?: TraderXArchitectureNode[];
  edges?: TraderXArchitectureEdge[];
  notes?: string[];
}

export interface ParsedFdc3AppRecord {
  appId: string;
  name: string;
  url?: string;
  publisher?: string;
  raisesIntents: string[];
  contextTypes: string[];
  sourceRelPath: string;
}

export interface ParsedFdc3Spec {
  inboundIntents: string[];
  outboundIntents: string[];
  contextTypes: string[];
  requiredInstrumentFields: string[];
  optionalInstrumentFields: string[];
  accountFields: string[];
  apps: ParsedFdc3AppRecord[];
  contractRelPath: string;
}

export interface CalmControlDefinition {
  id: string;
  name: string;
  description: string;
  sourceSpecUrl: string;
  clauses: string[];
  targetNodeCandidates: string[];
}

export interface ConvertTraderXStateOptions {
  featurePackAbsDir?: string;
  featurePackRelPath?: string;
  inheritedControls?: CalmControlDefinition[];
  fdc3SpecOverride?: ParsedFdc3Spec;
}

export interface GenerateTraderXTimelineOptions {
  outputPath?: string;
  snapshotsDir?: string;
  timelapsePath?: string;
  defaultView?: 'stage' | 'feed';
  emitDigestPath?: string;
  validate?: boolean;
  validateSnapshots?: boolean;
  gitRunner?: GitCommandRunner;
  onDebug?: (message: string) => void;
}

const TRADERX_KIND_TO_CALM_NODE_TYPE: Record<string, string> = {
  actor: 'actor',
  frontend: 'webclient',
  database: 'database',
  boundary: 'network',
  platform: 'system',
  service: 'service',
  gateway: 'service',
  messaging: 'service',
  observability: 'service',
  tooling: 'service',
  component: 'service',
};

function sanitizeCalmId(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function inferCalmProtocol(
  edgeLabel: string,
  targetNodeType: string,
): 'HTTPS' | 'HTTP' | 'SocketIO' | 'WebSocket' | 'JDBC' | undefined {
  if (/https/i.test(edgeLabel)) return 'HTTPS';
  if (/socket\.?io/i.test(edgeLabel)) return 'SocketIO';
  if (/websocket|nats-ws|\bws\b|fdc3|intent|context/i.test(edgeLabel)) return 'WebSocket';
  if (targetNodeType === 'database' || /jdbc|postgres|persist|h2\b/i.test(edgeLabel)) return 'JDBC';
  if (edgeLabel.startsWith('/') || /\bhttp\b|rest\b|app\/intents/i.test(edgeLabel)) return 'HTTP';
  return undefined;
}

function inferUrlProtocol(url: string): string {
  if (/^https:/i.test(url)) return 'HTTPS';
  if (/^wss?:/i.test(url)) return 'WebSocket';
  if (/^postgres:/i.test(url)) return 'JDBC';
  return 'HTTP';
}

function isPlaceholderScaffoldModel(model: TraderXArchitectureModel): boolean {
  const desc = (model.description ?? '').trim();
  return /^update this model with the authoritative architecture/i.test(desc);
}

function findFilesByPattern(rootDir: string, matcher: RegExp): string[] {
  const found: string[] = [];
  if (!existsSync(rootDir)) return found;
  const walk = (curr: string): void => {
    for (const entry of readdirSync(curr, { withFileTypes: true })) {
      const abs = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && matcher.test(entry.name)) {
        found.push(abs);
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

export function parseTraderXFdc3Spec(
  featurePackAbsDir: string,
  featurePackRelPath: string,
): ParsedFdc3Spec | undefined {
  const contractPath = path.join(featurePackAbsDir, 'contracts', 'contract-delta.md');
  const appdPaths = findFilesByPattern(featurePackAbsDir, /^appd.*\.json$/i);
  if (!existsSync(contractPath) && appdPaths.length === 0) {
    return undefined;
  }

  const contractText = existsSync(contractPath) ? readFileSync(contractPath, 'utf-8') : '';
  if (!/fdc3\./i.test(contractText) && appdPaths.length === 0) {
    return undefined;
  }

  const extractSectionCodeTokens = (headingPattern: RegExp): string[] => {
    const lines = contractText.split(/\r?\n/);
    const tokens: string[] = [];
    let inSection = false;
    for (const line of lines) {
      if (/^#{2,4}\s+/.test(line)) {
        if (headingPattern.test(line)) {
          inSection = true;
          continue;
        }
        if (inSection) break;
      }
      if (inSection && /^\s*-\s+/.test(line)) {
        const firstCode = line.match(/`([^`]+)`/);
        if (firstCode?.[1]) {
          tokens.push(firstCode[1].trim());
        }
      }
    }
    return [...new Set(tokens)];
  };

  const contextTypesSet = new Set<string>();
  for (const m of contractText.matchAll(/\bfdc3\.[a-zA-Z0-9_-]+/g)) {
    contextTypesSet.add(m[0]);
  }

  const inboundIntents = extractSectionCodeTokens(/Inbound Intents/i);
  const outboundIntents = extractSectionCodeTokens(/Outbound Intents/i);

  const requiredInstrumentFields = ['type', 'id.ticker'];
  const optionalInstrumentFields: string[] = [];
  for (const field of ['id.ISIN', 'id.FIGI', 'id.RIC']) {
    if (contractText.includes(field)) {
      optionalInstrumentFields.push(field);
    }
  }
  const accountFields = contextTypesSet.has('fdc3.account') ? ['type', 'id.accountId'] : [];

  const apps: ParsedFdc3AppRecord[] = [];
  for (const appdAbs of appdPaths) {
    try {
      const parsed = JSON.parse(readFileSync(appdAbs, 'utf-8')) as {
        applications?: Array<Record<string, unknown>>;
      };
      const relFromPack = path.relative(featurePackAbsDir, appdAbs).split(path.sep).join('/');
      const sourceRelPath = `${featurePackRelPath}/${relFromPack}`;
      for (const app of parsed.applications ?? []) {
        const appId = typeof app.appId === 'string' ? app.appId : '';
        if (!appId) continue;
        const name = typeof app.name === 'string' ? app.name : appId;
        const details = app.details as Record<string, unknown> | undefined;
        const url = typeof details?.url === 'string' ? details.url : undefined;
        const publisher = typeof app.publisher === 'string' ? app.publisher : undefined;
        const interop = app.interop as Record<string, unknown> | undefined;
        const intentsObj = interop?.intents as Record<string, unknown> | undefined;
        const raisesObj = intentsObj?.raises as Record<string, Record<string, unknown>> | undefined;
        const raisesIntents: string[] = [];
        const appContexts = new Set<string>();
        if (raisesObj && typeof raisesObj === 'object') {
          for (const [intentName, spec] of Object.entries(raisesObj)) {
            raisesIntents.push(intentName);
            const ctxs = Array.isArray(spec?.contexts) ? spec.contexts : [];
            for (const ctx of ctxs) {
              if (typeof ctx === 'string') {
                appContexts.add(ctx);
                contextTypesSet.add(ctx);
              }
            }
          }
        }
        apps.push({
          appId,
          name,
          url,
          publisher,
          raisesIntents,
          contextTypes: [...appContexts],
          sourceRelPath,
        });
      }
    } catch {
      // Ignore malformed optional appd fixtures
    }
  }

  return {
    inboundIntents:
      inboundIntents.length > 0
        ? inboundIntents
        : ['ViewOrders', 'TraderX.CreateTradeTicket', 'TraderX.CreateOrderTicket'],
    outboundIntents: outboundIntents.length > 0 ? outboundIntents : ['ViewChart', 'ViewQuote'],
    contextTypes: contextTypesSet.size > 0 ? [...contextTypesSet] : ['fdc3.instrument'],
    requiredInstrumentFields,
    optionalInstrumentFields,
    accountFields,
    apps,
    contractRelPath: `${featurePackRelPath}/contracts/contract-delta.md`,
  };
}

function parseMarkdownBulletSections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentHeading = 'General';
  for (const rawLine of markdown.split(/\r?\n/)) {
    const headingMatch = rawLine.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentHeading = headingMatch[1].trim();
      if (!sections.has(currentHeading)) {
        sections.set(currentHeading, []);
      }
      continue;
    }
    const bulletMatch = rawLine.match(/^\s*-\s+(.+)$/);
    if (bulletMatch) {
      const cleaned = bulletMatch[1].replace(/`/g, '').trim();
      if (!cleaned) continue;
      const list = sections.get(currentHeading) ?? [];
      list.push(cleaned);
      sections.set(currentHeading, list);
    }
  }
  return sections;
}

function isSubstantiveControlBullet(text: string): boolean {
  if (/^no\s+(?:new\s+|baseline\s+|additional\s+)?(?:auth|authn|tls|rbac|backend|performance|sql|table|migration|api)/i.test(text)) {
    return false;
  }
  if (/intended\s+for\s+local\s+learning|not\s+production\s+deployment/i.test(text)) {
    return false;
  }
  if (/^focus\s+is\s+local\s+developer/i.test(text)) {
    return false;
  }
  if (/:\s*$/.test(text)) {
    return false;
  }
  return text.length >= 24;
}

export function extractTraderXStateControls(
  featurePackAbsDir: string,
  featurePackRelPath: string,
  catalogState: TraderXCatalogState,
): CalmControlDefinition[] {
  const stateNumMatch = catalogState.id.match(/^(\d{3})/);
  const num = stateNumMatch ? stateNumMatch[1] : sanitizeCalmId(catalogState.id);
  const out: CalmControlDefinition[] = [];

  const nfrRel = `${featurePackRelPath}/requirements/nonfunctional-delta.md`;
  const nfrAbs = path.join(featurePackAbsDir, 'requirements', 'nonfunctional-delta.md');
  const sysReqRel = `${featurePackRelPath}/system/system-requirements.md`;
  const sysReqAbs = path.join(featurePackAbsDir, 'system', 'system-requirements.md');
  const specRel = `${featurePackRelPath}/spec.md`;
  const specAbs = path.join(featurePackAbsDir, 'spec.md');

  if (existsSync(sysReqAbs)) {
    const sections = parseMarkdownBulletSections(readFileSync(sysReqAbs, 'utf-8'));
    const frBullets = (sections.get('Functional Requirements') ?? []).filter(isSubstantiveControlBullet);
    const nfrBullets = (sections.get('Non-Functional Requirements') ?? []).filter(isSubstantiveControlBullet);

    const validationClauses = frBullets.filter((b) => /validate|health|readiness|All Accounts/i.test(b));
    if (validationClauses.length > 0) {
      out.push({
        id: `traderx-${num}-pre-trade-and-account-validation`,
        name: `State ${num} Pre-Publish Trade & Account Validation`,
        description: validationClauses.slice(0, 2).join(' '),
        sourceSpecUrl: `${TRADERX_BLOB_BASE}/${sysReqRel}`,
        clauses: validationClauses.slice(0, 4),
        targetNodeCandidates: ['tradeService', 'tradeApi', 'account'],
      });
    }

    const releaseGateClauses = nfrBullets.filter((b) => /SYS-NFR-009|SYS-NFR-010|SYS-NFR-004|SYS-NFR-005/i.test(b));
    if (releaseGateClauses.length > 0) {
      out.push({
        id: `traderx-${num}-spec-kit-release-and-readiness-gate`,
        name: `State ${num} Spec-Kit Dependency & Readiness Gate`,
        description: releaseGateClauses[0],
        sourceSpecUrl: `${TRADERX_BLOB_BASE}/${sysReqRel}`,
        clauses: releaseGateClauses.slice(0, 3),
        targetNodeCandidates: ['web', 'traderxUi', 'tradeProcessor'],
      });
    }
  }

  if (existsSync(nfrAbs)) {
    const sections = parseMarkdownBulletSections(readFileSync(nfrAbs, 'utf-8'));
    const secBullets = (sections.get('Security / Compliance') ?? []).filter(isSubstantiveControlBullet);
    const relBullets = [
      ...(sections.get('Reliability / Observability') ?? []),
      ...(sections.get('Reliability') ?? []),
      ...(sections.get('Precision / Data Quality') ?? []),
    ].filter(isSubstantiveControlBullet);
    const opsBullets = (sections.get('Runtime / Operations') ?? []).filter(isSubstantiveControlBullet);

    if (num === '014') {
      const dataMinClauses = secBullets.filter((b) => /symbol identifiers|canonical bare ticker|validate context shape/i.test(b));
      const cveAndSidecarClauses = [
        ...opsBullets.filter((b) => /outside TraderX ingress|8090/i.test(b)),
        ...secBullets.filter((b) => /GHSA-|uuid|override/i.test(b)),
      ];
      const degradedClauses = [
        ...opsBullets.filter((b) => /degraded|two modes/i.test(b)),
        ...relBullets.filter((b) => /degrade safely|Sidecar failures|structured interoperability/i.test(b)),
      ];

      if (dataMinClauses.length > 0) {
        out.push({
          id: 'traderx-014-fdc3-context-data-minimization',
          name: 'FDC3 2.2 Public-Symbol Minimization & Payload Validation',
          description: dataMinClauses.slice(0, 2).join(' '),
          sourceSpecUrl: `${TRADERX_BLOB_BASE}/${nfrRel}`,
          clauses: dataMinClauses,
          targetNodeCandidates: ['traderxUi'],
        });
      }
      if (cveAndSidecarClauses.length > 0) {
        out.push({
          id: 'traderx-014-sail-sidecar-isolation-and-supply-chain',
          name: 'Sail Sidecar Ingress Isolation & Dependency CVE Override',
          description: cveAndSidecarClauses.slice(0, 2).join(' '),
          sourceSpecUrl: `${TRADERX_BLOB_BASE}/${nfrRel}`,
          clauses: cveAndSidecarClauses,
          targetNodeCandidates: ['sailSidecar', 'traderxIngress'],
        });
      }
      if (degradedClauses.length > 0) {
        out.push({
          id: 'traderx-014-fdc3-degraded-mode-resilience',
          name: 'FDC3 DesktopAgent Degraded-Mode Continuity & Diagnostics',
          description: degradedClauses.slice(0, 2).join(' '),
          sourceSpecUrl: `${TRADERX_BLOB_BASE}/${nfrRel}`,
          clauses: degradedClauses,
          targetNodeCandidates: ['traderxUi', 'sailSidecar'],
        });
      }
      return out;
    }

    if (secBullets.length > 0) {
      out.push({
        id: `traderx-${num}-security-and-compliance`,
        name: `State ${num} Security & Provenance Control (${catalogState.title})`,
        description: secBullets.slice(0, 2).join(' '),
        sourceSpecUrl: `${TRADERX_BLOB_BASE}/${nfrRel}`,
        clauses: secBullets.slice(0, 4),
        targetNodeCandidates: [
          'edge',
          'ingress',
          'traderxIngress',
          'nats',
          'grafana',
          'order_matcher',
          'orderApi',
          'cluster',
          'radius',
          'tilt',
          'database',
        ],
      });
    }

    if (relBullets.length > 0) {
      out.push({
        id: `traderx-${num}-reliability-and-observability`,
        name: `State ${num} Reliability, Precision & Telemetry Control`,
        description: relBullets.slice(0, 2).join(' '),
        sourceSpecUrl: `${TRADERX_BLOB_BASE}/${nfrRel}`,
        clauses: relBullets.slice(0, 4),
        targetNodeCandidates: [
          'prometheus',
          'otel',
          'loki',
          'pricePublisher',
          'nats',
          'edge',
          'ingress',
          'database',
          'workloads',
        ],
      });
    } else if (opsBullets.length > 0 && secBullets.length === 0) {
      out.push({
        id: `traderx-${num}-runtime-health-sequencing`,
        name: `State ${num} Deterministic Runtime & Health Gate`,
        description: opsBullets.slice(0, 2).join(' '),
        sourceSpecUrl: `${TRADERX_BLOB_BASE}/${nfrRel}`,
        clauses: opsBullets.slice(0, 3),
        targetNodeCandidates: ['database', 'ingress', 'edge', 'cluster'],
      });
    }
  } else if (out.length === 0 && existsSync(specAbs)) {
    const sections = parseMarkdownBulletSections(readFileSync(specAbs, 'utf-8'));
    const frBullets = (sections.get('Functional Requirements') ?? []).filter(isSubstantiveControlBullet);
    if (frBullets.length > 0) {
      out.push({
        id: `traderx-${num}-ingress-contract-and-health-surface`,
        name: `State ${num} Ingress Routing & Service Health Telemetry`,
        description: frBullets.slice(0, 2).join(' '),
        sourceSpecUrl: `${TRADERX_BLOB_BASE}/${specRel}`,
        clauses: frBullets.slice(0, 4),
        targetNodeCandidates: ['edge', 'ingress', 'web'],
      });
    }
  }

  return out;
}

function resolveEntrypointOwnerNodeId(
  entrypointName: string,
  seenNodeIds: Set<string>,
): string | undefined {
  const lower = entrypointName.toLowerCase();
  const candidates: Array<[RegExp, string[]]> = [
    [/^sail/, ['sailSidecar']],
    [/traderx-ui|angular|web-front-end/, ['traderxUi', 'web', 'trade_ui']],
    [/edge|ingress/, ['traderxIngress', 'edge', 'ingress']],
    [/nats/, ['nats']],
    [/trade-feed/, ['tradeFeed']],
    [/postgres|db/, ['database']],
    [/price/, ['pricePublisher']],
    [/grafana/, ['grafana']],
    [/prometheus/, ['prometheus']],
    [/tilt/, ['tilt']],
  ];
  for (const [pattern, nodeIds] of candidates) {
    if (pattern.test(lower)) {
      const match = nodeIds.find((id) => seenNodeIds.has(id));
      if (match) return match;
    }
  }
  return undefined;
}

function toCalmControlRecord(def: CalmControlDefinition): Record<string, unknown> {
  return {
    description: def.description,
    requirements: [
      {
        'requirement-url': CALM_13_CONTROL_REQ_SCHEMA,
        config: {
          'control-id': def.id,
          name: def.name,
          description: def.description,
          'source-spec-url': def.sourceSpecUrl,
          clauses: def.clauses,
        },
      },
    ],
  };
}

function synthesizeTraderXFlows(
  stateId: string,
  calmRelationships: Array<Record<string, unknown>>,
  fdc3Spec?: ParsedFdc3Spec,
): Array<Record<string, unknown>> {
  const relByPair = new Map<string, string>();
  const existingRelIds = new Set<string>();

  for (const rel of calmRelationships) {
    const relId = typeof rel['unique-id'] === 'string' ? rel['unique-id'] : '';
    if (!relId) continue;
    existingRelIds.add(relId);
    const rt = rel['relationship-type'] as Record<string, unknown> | undefined;
    const connects = rt?.connects as Record<string, Record<string, unknown>> | undefined;
    if (connects?.source?.node && connects?.destination?.node) {
      const key = `${String(connects.source.node)}->${String(connects.destination.node)}`;
      if (!relByPair.has(key)) relByPair.set(key, relId);
    }
    const interacts = rt?.interacts as { actor?: string; nodes?: string[] } | undefined;
    if (interacts?.actor && Array.isArray(interacts.nodes)) {
      for (const dst of interacts.nodes) {
        const key = `${interacts.actor}->${dst}`;
        if (!relByPair.has(key)) relByPair.set(key, relId);
      }
    }
  }

  const buildFlowIfValid = (spec: {
    id: string;
    name: string;
    description: string;
    requirementUrl?: string;
    metadata?: Record<string, unknown>;
    steps: Array<{ pair: string; description: string; direction?: 'source-to-destination' | 'destination-to-source' }>;
  }): Record<string, unknown> | null => {
    const transitions: Array<Record<string, unknown>> = [];
    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      const relId = relByPair.get(step.pair);
      if (!relId || !existingRelIds.has(relId)) {
        return null;
      }
      transitions.push({
        'relationship-unique-id': relId,
        'sequence-number': i + 1,
        description: step.description,
        ...(step.direction ? { direction: step.direction } : {}),
      });
    }
    if (transitions.length === 0) return null;
    return {
      'unique-id': spec.id,
      name: spec.name,
      description: spec.description,
      ...(spec.requirementUrl ? { 'requirement-url': spec.requirementUrl } : {}),
      transitions,
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
    };
  };

  const flows: Array<Record<string, unknown>> = [];

  if (fdc3Spec) {
    const reqUrl = `${TRADERX_BLOB_BASE}/${fdc3Spec.contractRelPath}`;
    const outboundIntentsLabel = fdc3Spec.outboundIntents.join(' / ');
    const ticketIntents = fdc3Spec.inboundIntents.filter((i) => /Ticket/i.test(i));
    const ticketIntentsLabel =
      ticketIntents.length > 0 ? ticketIntents.join(' / ') : fdc3Spec.inboundIntents.join(' / ');

    const f1 = buildFlowIfValid({
      id: 'flow-fdc3-outbound-instrument-and-chart-intent',
      name: `FDC3 Outbound fdc3.instrument Broadcast & ${outboundIntentsLabel} Intent`,
      description:
        'Broadcasts normalized uppercase fdc3.instrument context from TraderX blotters and raises outbound chart/quote intents resolved through the Sail FDC3 2.0 App Directory.',
      requirementUrl: reqUrl,
      metadata: {
        'fdc3-version': '2.2',
        'fdc3-intents': fdc3Spec.outboundIntents,
        'fdc3-contexts': ['fdc3.instrument'],
      },
      steps: [
        {
          pair: 'trader->traderxUi',
          description: 'Trader selects blotter security row and invokes chart/quote interop action.',
        },
        {
          pair: 'traderxUi->sailSidecar',
          description: `TraderX UI broadcasts fdc3.instrument { id.ticker } and raises ${outboundIntentsLabel}.`,
        },
        {
          pair: 'sailDirectory->sailSidecar',
          description: 'Sail DesktopAgent resolves target widget metadata from FDC3 2.0 App Directory profile.',
        },
        {
          pair: 'sailSidecar->demoApps',
          description: 'Sail Sidecar delivers fdc3.instrument context and intent payload to Demo FDC3 Apps.',
        },
      ],
    });
    if (f1) flows.push(f1);

    const f2 = buildFlowIfValid({
      id: 'flow-fdc3-inbound-ticket-launch-to-execution',
      name: `FDC3 Inbound ${ticketIntentsLabel} Intent to Trade Execution`,
      description:
        'Raises TraderX ticket-launch intents from external FDC3 apps (TraderX Intent Launcher), validates fdc3.instrument shape in TraderX UI, and executes the prefilled ticket via NGINX Ingress.',
      requirementUrl: reqUrl,
      metadata: {
        'fdc3-version': '2.2',
        'fdc3-intents': ticketIntents.length > 0 ? ticketIntents : fdc3Spec.inboundIntents,
        'fdc3-contexts': ['fdc3.instrument'],
      },
      steps: [
        {
          pair: 'trader->sailSidecar',
          description: 'Trader triggers ticket launch from Sail workbench / TraderX Intent Launcher.',
        },
        {
          pair: 'demoApps->sailSidecar',
          description: `Demo FDC3 App raises ${ticketIntentsLabel} carrying fdc3.instrument.`,
        },
        {
          pair: 'sailSidecar->traderxUi',
          description: 'Sail Sidecar routes inbound ticket intent and fdc3.instrument context to TraderX UI listener.',
        },
        {
          pair: 'traderxUi->traderxIngress',
          description: 'TraderX UI validates ticker payload, prefills ticket, and submits request to TraderX Ingress.',
        },
        {
          pair: 'traderxIngress->tradeApi',
          description: 'TraderX Ingress routes trade creation request to Trade Service API.',
        },
      ],
    });
    if (f2) flows.push(f2);

    const viewIntent = fdc3Spec.inboundIntents.find((i) => /ViewOrders/i.test(i)) ?? 'ViewOrders';
    const f3 = buildFlowIfValid({
      id: 'flow-fdc3-view-orders-and-realtime-blotter',
      name: `FDC3 ${viewIntent} Intent & Realtime NATS Blotter Sync`,
      description:
        'Handles inbound ViewOrders intents with replayable fdc3.instrument selection while merging REST open-order snapshots with live nats-ws order lifecycle events.',
      requirementUrl: reqUrl,
      metadata: {
        'fdc3-version': '2.2',
        'fdc3-intents': [viewIntent],
        'fdc3-contexts': fdc3Spec.contextTypes,
      },
      steps: [
        {
          pair: 'demoApps->sailSidecar',
          description: `External FDC3 app raises ${viewIntent} intent with fdc3.instrument context.`,
        },
        {
          pair: 'sailSidecar->traderxUi',
          description: `Sail Sidecar delivers ${viewIntent} to TraderX UI without mutating local filterOnSelectedTicker state.`,
        },
        {
          pair: 'traderxUi->traderxIngress',
          description: 'TraderX UI queries open-order snapshot through TraderX Ingress.',
        },
        {
          pair: 'traderxIngress->orderApi',
          description: 'TraderX Ingress fetches current order state from Order Matcher API.',
        },
        {
          pair: 'traderxUi->nats',
          description: 'TraderX UI subscribes to realtime order and pricing updates over nats-ws.',
        },
      ],
    });
    if (f3) flows.push(f3);

    return flows;
  }

  const flowDocUrl = `${TRADERX_BLOB_BASE}/specs/001-baseline-uncontainerized-parity/system/end-to-end-flows.md`;
  const stateSlug = sanitizeCalmId(stateId.slice(0, 3) || 'state');

  const directTradeFlow =
    buildFlowIfValid({
      id: `flow-${stateSlug}-submit-and-process-trade`,
      name: 'F3/F4: Submit & Persist Trade Order',
      description:
        'Validates account and ticker in trade-service, publishes trade events over messaging transport, and persists trade and position updates.',
      requirementUrl: flowDocUrl,
      steps: [
        { pair: 'trader->web', description: 'Trader submits buy/sell ticket in Angular UI.' },
        { pair: 'web->tradeService', description: 'UI posts trade submission to Trade Service.' },
        { pair: 'tradeService->referenceData', description: 'Trade Service validates security ticker.' },
        { pair: 'tradeService->account', description: 'Trade Service validates account identifier.' },
        { pair: 'tradeService->tradeFeed', description: 'Trade Service publishes new trade event.' },
        {
          pair: 'tradeProcessor->tradeFeed',
          description: 'Trade Processor consumes queued trade event from Trade Feed.',
          direction: 'destination-to-source',
        },
        { pair: 'tradeProcessor->database', description: 'Trade Processor persists trade and upserts position.' },
      ],
    }) ??
    buildFlowIfValid({
      id: `flow-${stateSlug}-ingress-submit-and-process-trade`,
      name: 'F3/F4: Ingress-Routed Trade Submission & Persistence',
      description:
        'Routes browser trade tickets through the edge/ingress proxy, validates ticker and account, streams over messaging broker, and updates persistent holdings.',
      requirementUrl: flowDocUrl,
      steps: [
        {
          pair: relByPair.has('trader->ingress')
            ? 'trader->ingress'
            : relByPair.has('trader->edge')
              ? 'trader->edge'
              : 'developer->edge',
          description: 'User submits trade ticket through single browser-facing proxy.',
        },
        {
          pair: relByPair.has('ingress->tradeService') ? 'ingress->tradeService' : 'edge->tradeService',
          description: 'Proxy forwards trade request to Trade Service.',
        },
        { pair: 'tradeService->referenceData', description: 'Trade Service validates security ticker.' },
        { pair: 'tradeService->account', description: 'Trade Service validates account identifier.' },
        {
          pair: relByPair.has('tradeService->nats') ? 'tradeService->nats' : 'tradeService->tradeFeed',
          description: 'Trade Service publishes trade event to messaging broker.',
        },
        {
          pair: relByPair.has('tradeProcessor->nats') ? 'tradeProcessor->nats' : 'tradeProcessor->tradeFeed',
          description: 'Trade Processor consumes trade event from messaging broker.',
          direction: 'destination-to-source',
        },
        { pair: 'tradeProcessor->database', description: 'Trade Processor persists trade and upserts position.' },
      ],
    }) ??
    buildFlowIfValid({
      id: `flow-${stateSlug}-order-matching-execution`,
      name: 'Order Submission, Matching & Trade Execution',
      description:
        'Submits orders through ingress and Trade UI to Order API, matches contra orders in Order Matcher, and publishes fills over NATS to Trade Processor.',
      steps: [
        { pair: 'developer->ingress', description: 'Operator opens Trade UI via ingress.' },
        { pair: 'ingress->trade_ui', description: 'Ingress serves Trade UI order entry workflow.' },
        { pair: 'trade_ui->order_api', description: 'Trade UI submits order lifecycle request to Order API.' },
        { pair: 'order_api->order_matcher', description: 'Order API routes eligible order to Order Matcher.' },
        { pair: 'order_matcher->nats', description: 'Order Matcher publishes execution fills to NATS.' },
        { pair: 'nats->trade_processor', description: 'Trade Processor books matched execution fills.' },
      ],
    });

  if (directTradeFlow) {
    flows.push(directTradeFlow);
  }

  return flows;
}

export function convertTraderXStateToCalm(
  model: TraderXArchitectureModel,
  catalogState: TraderXCatalogState,
  adrs: string[] = [],
  options: ConvertTraderXStateOptions = {},
): Record<string, unknown> {
  const rawNodes = Array.isArray(model.nodes) ? model.nodes : [];
  const rawEdges = Array.isArray(model.edges) ? model.edges : [];
  const stateNumMatch = catalogState.id.match(/^(\d{3})/);
  const stateNum = stateNumMatch ? stateNumMatch[1] : sanitizeCalmId(catalogState.id);

  const nodeTypeById = new Map<string, string>();
  const calmNodeById = new Map<string, Record<string, unknown>>();
  const calmNodes: Array<Record<string, unknown>> = [];
  const seenNodeIds = new Set<string>();

  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode.id !== 'string' || !rawNode.id.trim()) continue;
    const id = rawNode.id.trim();
    if (seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);

    const rawKind = (rawNode.kind ?? 'service').trim().toLowerCase();
    const calmNodeType = TRADERX_KIND_TO_CALM_NODE_TYPE[rawKind] ?? 'service';
    nodeTypeById.set(id, calmNodeType);

    const name = rawNode.label?.trim() || id;
    const description =
      rawNode.description?.trim() || `${name} (${rawKind} component in TraderX ${catalogState.id}).`;

    const calmNode: Record<string, unknown> = {
      'unique-id': id,
      'node-type': calmNodeType,
      name,
      description,
    };
    if (rawKind && rawKind !== calmNodeType) {
      calmNode.metadata = { 'traderx-kind': rawKind };
    }
    calmNodes.push(calmNode);
    calmNodeById.set(id, calmNode);
  }

  const nodeInterfacesByNodeId = new Map<string, Array<Record<string, unknown>>>();
  const primaryEntryInterfaceByNodeId = new Map<string, string>();
  const usedInterfaceIds = new Set<string>();

  const addNodeInterface = (nodeId: string, iface: Record<string, unknown>, isPrimary = false): string => {
    const baseId = sanitizeCalmId(String(iface['unique-id'] || `iface-${nodeId}`));
    let ifaceId = baseId;
    let suffix = 2;
    while (usedInterfaceIds.has(ifaceId) || seenNodeIds.has(ifaceId)) {
      ifaceId = `${baseId}-${suffix++}`;
    }
    usedInterfaceIds.add(ifaceId);
    const normalized = { ...iface, 'unique-id': ifaceId };
    const list = nodeInterfacesByNodeId.get(nodeId) ?? [];
    list.push(normalized);
    nodeInterfacesByNodeId.set(nodeId, list);
    if (isPrimary || !primaryEntryInterfaceByNodeId.has(nodeId)) {
      primaryEntryInterfaceByNodeId.set(nodeId, ifaceId);
    }
    return ifaceId;
  };

  for (const ep of model.entrypoints ?? []) {
    if (!ep || typeof ep.name !== 'string' || typeof ep.url !== 'string') continue;
    const ownerNodeId = resolveEntrypointOwnerNodeId(ep.name, seenNodeIds);
    if (!ownerNodeId) continue;
    addNodeInterface(
      ownerNodeId,
      {
        'unique-id': `iface-${stateNum}-${sanitizeCalmId(ep.name)}`,
        name: ep.name,
        protocol: inferUrlProtocol(ep.url),
        url: ep.url,
      },
      true,
    );
  }

  const fdc3Spec =
    options.fdc3SpecOverride ??
    (options.featurePackAbsDir && options.featurePackRelPath
      ? parseTraderXFdc3Spec(options.featurePackAbsDir, options.featurePackRelPath)
      : undefined);

  const fdc3InterfaceIds: {
    traderxListener?: string;
    traderxBroadcaster?: string;
    sailAgent?: string;
    sailAppd?: string;
    demoLauncher?: string;
  } = {};

  if (fdc3Spec) {
    if (seenNodeIds.has('traderxUi')) {
      fdc3InterfaceIds.traderxListener = addNodeInterface('traderxUi', {
        'unique-id': `iface-${stateNum}-traderx-fdc3-intent-listener`,
        name: 'TraderX FDC3 Intent & Context Listener',
        protocol: 'FDC3 2.2',
        role: 'intent-and-context-listener',
        'listens-for': fdc3Spec.inboundIntents,
        'context-types': fdc3Spec.contextTypes,
        'required-instrument-fields': fdc3Spec.requiredInstrumentFields,
        ...(fdc3Spec.optionalInstrumentFields.length > 0
          ? { 'optional-instrument-fields': fdc3Spec.optionalInstrumentFields }
          : {}),
        ...(fdc3Spec.accountFields.length > 0
          ? { 'account-context-fields': fdc3Spec.accountFields }
          : {}),
      });
      fdc3InterfaceIds.traderxBroadcaster = addNodeInterface('traderxUi', {
        'unique-id': `iface-${stateNum}-traderx-fdc3-context-broadcaster`,
        name: 'TraderX FDC3 Outbound Context & Intent Emitter',
        protocol: 'FDC3 2.2',
        role: 'context-and-intent-emitter',
        raises: fdc3Spec.outboundIntents,
        'broadcasts-context': ['fdc3.instrument'],
      });
    }

    if (seenNodeIds.has('sailSidecar')) {
      fdc3InterfaceIds.sailAgent = addNodeInterface(
        'sailSidecar',
        {
          'unique-id': `iface-${stateNum}-sail-fdc3-desktop-agent`,
          name: 'Sail FDC3 2.2 DesktopAgent Bridge',
          protocol: 'FDC3 2.2 DesktopAgent',
          url: 'http://localhost:8090',
          capabilities: [
            'broadcast',
            'raiseIntent',
            'addIntentListener',
            'addContextListener',
            'getOrCreateChannel',
          ],
          'supported-intents': [
            ...new Set([...fdc3Spec.inboundIntents, ...fdc3Spec.outboundIntents]),
          ],
          'supported-contexts': fdc3Spec.contextTypes,
        },
        true,
      );
    }

    if (seenNodeIds.has('sailDirectory')) {
      const appIds = ['traderx-ui', ...fdc3Spec.apps.map((a) => a.appId)];
      fdc3InterfaceIds.sailAppd = addNodeInterface(
        'sailDirectory',
        {
          'unique-id': `iface-${stateNum}-sail-fdc3-appd-v2`,
          name: 'FINOS FDC3 2.0 App Directory Profile',
          protocol: 'FDC3 2.0 AppD',
          applications: [...new Set(appIds)],
          'registered-intents': [
            ...new Set([...fdc3Spec.inboundIntents, ...fdc3Spec.outboundIntents]),
          ],
          'context-types': fdc3Spec.contextTypes,
          ...(fdc3Spec.apps[0]?.publisher ? { publisher: fdc3Spec.apps[0].publisher } : {}),
        },
        true,
      );
    }

    if (seenNodeIds.has('demoApps')) {
      const primaryApp = fdc3Spec.apps[0];
      fdc3InterfaceIds.demoLauncher = addNodeInterface(
        'demoApps',
        {
          'unique-id': `iface-${stateNum}-demo-fdc3-intent-launcher`,
          name: primaryApp?.name ?? 'TraderX FDC3 Intent Launcher & Workbench Widgets',
          protocol: 'FDC3 2.2',
          ...(primaryApp?.appId ? { 'app-id': primaryApp.appId } : {}),
          ...(primaryApp?.url ? { url: primaryApp.url } : {}),
          raises:
            primaryApp && primaryApp.raisesIntents.length > 0
              ? primaryApp.raisesIntents
              : fdc3Spec.inboundIntents.filter((i) => /Ticket/i.test(i)),
          'listens-for': fdc3Spec.outboundIntents,
          'context-types': ['fdc3.instrument'],
        },
        true,
      );
    }
  }

  for (const [nodeId, interfaces] of nodeInterfacesByNodeId.entries()) {
    const node = calmNodeById.get(nodeId);
    if (node && interfaces.length > 0) {
      node.interfaces = interfaces;
    }
  }

  const hasInterfaceOnNode = (nodeId: string, ifaceId?: string): ifaceId is string => {
    if (!ifaceId) return false;
    return (nodeInterfacesByNodeId.get(nodeId) ?? []).some((i) => i['unique-id'] === ifaceId);
  };

  const calmRelationships: Array<Record<string, unknown>> = [];
  const usedRelIds = new Set<string>();
  const referencedNodes = new Set<string>();

  for (const rawEdge of rawEdges) {
    if (!rawEdge || typeof rawEdge.from !== 'string' || typeof rawEdge.to !== 'string') continue;
    const from = rawEdge.from.trim();
    const to = rawEdge.to.trim();
    if (!seenNodeIds.has(from) || !seenNodeIds.has(to)) continue;
    referencedNodes.add(from);
    referencedNodes.add(to);

    const baseRelId = `rel-${from}-${to}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
    let relId = baseRelId;
    let suffix = 2;
    while (usedRelIds.has(relId) || usedInterfaceIds.has(relId) || seenNodeIds.has(relId)) {
      relId = `${baseRelId}-${suffix++}`;
    }
    usedRelIds.add(relId);

    const label = rawEdge.label?.trim() ?? '';
    const description = label || `${from} communicates with ${to}.`;
    const fromNodeType = nodeTypeById.get(from) ?? 'service';
    const toNodeType = nodeTypeById.get(to) ?? 'service';

    if (fromNodeType === 'actor') {
      calmRelationships.push({
        'unique-id': relId,
        description,
        'relationship-type': {
          interacts: {
            actor: from,
            nodes: [to],
          },
        },
      });
    } else {
      let srcInterfaces: string[] | undefined;
      let dstInterfaces: string[] | undefined;

      if (from === 'traderxUi' && to === 'sailSidecar') {
        if (hasInterfaceOnNode('traderxUi', fdc3InterfaceIds.traderxBroadcaster)) {
          srcInterfaces = [fdc3InterfaceIds.traderxBroadcaster];
        }
        if (hasInterfaceOnNode('sailSidecar', fdc3InterfaceIds.sailAgent)) {
          dstInterfaces = [fdc3InterfaceIds.sailAgent];
        }
      } else if (from === 'sailSidecar' && to === 'traderxUi') {
        if (hasInterfaceOnNode('sailSidecar', fdc3InterfaceIds.sailAgent)) {
          srcInterfaces = [fdc3InterfaceIds.sailAgent];
        }
        if (hasInterfaceOnNode('traderxUi', fdc3InterfaceIds.traderxListener)) {
          dstInterfaces = [fdc3InterfaceIds.traderxListener];
        }
      } else if (from === 'sailDirectory' && to === 'sailSidecar') {
        if (hasInterfaceOnNode('sailDirectory', fdc3InterfaceIds.sailAppd)) {
          srcInterfaces = [fdc3InterfaceIds.sailAppd];
        }
        if (hasInterfaceOnNode('sailSidecar', fdc3InterfaceIds.sailAgent)) {
          dstInterfaces = [fdc3InterfaceIds.sailAgent];
        }
      } else if (from === 'sailSidecar' && to === 'demoApps') {
        if (hasInterfaceOnNode('sailSidecar', fdc3InterfaceIds.sailAgent)) {
          srcInterfaces = [fdc3InterfaceIds.sailAgent];
        }
        if (hasInterfaceOnNode('demoApps', fdc3InterfaceIds.demoLauncher)) {
          dstInterfaces = [fdc3InterfaceIds.demoLauncher];
        }
      } else if (from === 'demoApps' && to === 'sailSidecar') {
        if (hasInterfaceOnNode('demoApps', fdc3InterfaceIds.demoLauncher)) {
          srcInterfaces = [fdc3InterfaceIds.demoLauncher];
        }
        if (hasInterfaceOnNode('sailSidecar', fdc3InterfaceIds.sailAgent)) {
          dstInterfaces = [fdc3InterfaceIds.sailAgent];
        }
      } else {
        const dstPrimary = primaryEntryInterfaceByNodeId.get(to);
        if (hasInterfaceOnNode(to, dstPrimary)) {
          dstInterfaces = [dstPrimary];
        }
      }

      const protocol = inferCalmProtocol(label, toNodeType);
      calmRelationships.push({
        'unique-id': relId,
        description,
        ...(protocol ? { protocol } : {}),
        'relationship-type': {
          connects: {
            source: {
              node: from,
              ...(srcInterfaces ? { interfaces: srcInterfaces } : {}),
            },
            destination: {
              node: to,
              ...(dstInterfaces ? { interfaces: dstInterfaces } : {}),
            },
          },
        },
      });
    }
  }

  const OBS_NODE_PATTERN = /^(?:prometheus|blackbox|loki|promtail|tempo|otel|grafana)$/i;
  const unreferencedBoundaries = rawNodes
    .filter(
      (n) =>
        n &&
        typeof n.id === 'string' &&
        (n.kind ?? '').trim().toLowerCase() === 'boundary' &&
        !referencedNodes.has(n.id.trim()),
    )
    .map((n) => n.id.trim());

  if (unreferencedBoundaries.length > 0) {
    const deployableNodes = calmNodes
      .map((n) => String(n['unique-id']))
      .filter((id) => {
        const nt = nodeTypeById.get(id);
        return nt !== 'actor' && nt !== 'network';
      });
    const hasObsBoundary = unreferencedBoundaries.some((id) => /^obs/i.test(id));
    for (const boundaryId of unreferencedBoundaries) {
      const isObs = /^obs/i.test(boundaryId);
      const childIds = hasObsBoundary
        ? deployableNodes.filter((id) => (isObs ? OBS_NODE_PATTERN.test(id) : !OBS_NODE_PATTERN.test(id)))
        : deployableNodes;
      if (childIds.length > 0) {
        const depRelId = `rel-deployed-in-${boundaryId}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
        calmRelationships.push({
          'unique-id': depRelId,
          description: `Workloads deployed in ${boundaryId}.`,
          'relationship-type': {
            'deployed-in': {
              container: boundaryId,
              nodes: childIds,
            },
          },
        });
      }
    }
  }

  const ownControls =
    options.featurePackAbsDir && options.featurePackRelPath
      ? extractTraderXStateControls(options.featurePackAbsDir, options.featurePackRelPath, catalogState)
      : [];
  const mergedControlDefs = new Map<string, CalmControlDefinition>();
  for (const inherited of options.inheritedControls ?? []) {
    mergedControlDefs.set(inherited.id, inherited);
  }
  for (const own of ownControls) {
    mergedControlDefs.set(own.id, own);
  }

  const topLevelControls: Record<string, unknown> = {};
  for (const def of mergedControlDefs.values()) {
    topLevelControls[def.id] = toCalmControlRecord(def);
    const targetNodeId = def.targetNodeCandidates.find((cand) => calmNodeById.has(cand));
    if (targetNodeId) {
      const targetNode = calmNodeById.get(targetNodeId)!;
      const existingNodeControls = (targetNode.controls as Record<string, unknown> | undefined) ?? {};
      existingNodeControls[def.id] = toCalmControlRecord(def);
      targetNode.controls = existingNodeControls;
    }
  }

  const calmFlows = synthesizeTraderXFlows(catalogState.id, calmRelationships, fdc3Spec);

  const stateTitle = catalogState.title || model.title || catalogState.id;
  const stateDesc =
    model.description?.trim() || `FINOS TraderX architecture state ${catalogState.id}: ${stateTitle}.`;

  const metadata: Record<string, unknown> = {
    'source-project': 'finos/traderx',
    'state-id': catalogState.id,
  };
  if (catalogState.track) metadata.track = catalogState.track;
  if (catalogState.status) metadata.status = catalogState.status;
  if (model.inheritsFrom) metadata['inherits-from'] = model.inheritsFrom;
  if (fdc3Spec) {
    metadata['fdc3-version'] = '2.2';
    metadata['fdc3-inbound-intents'] = fdc3Spec.inboundIntents;
    metadata['fdc3-outbound-intents'] = fdc3Spec.outboundIntents;
    metadata['fdc3-context-types'] = fdc3Spec.contextTypes;
    if (fdc3Spec.apps.length > 0) {
      metadata['fdc3-appd-records'] = fdc3Spec.apps.map((a) => ({
        appId: a.appId,
        name: a.name,
        raises: a.raisesIntents,
      }));
    }
  }
  if (Array.isArray(model.notes) && model.notes.length > 0) {
    const nonEmptyNotes = model.notes.filter((n) => typeof n === 'string' && n.trim().length > 0);
    if (nonEmptyNotes.length > 0) {
      metadata.notes = nonEmptyNotes;
    }
  }

  const calmDoc: Record<string, unknown> = {
    $schema: CALM_13_SCHEMA,
    'unique-id': `traderx-${catalogState.id}`,
    name: `FINOS TraderX — ${stateTitle}`,
    description: stateDesc,
    nodes: calmNodes,
    relationships: calmRelationships,
    ...(calmFlows.length > 0 ? { flows: calmFlows } : {}),
    ...(Object.keys(topLevelControls).length > 0 ? { controls: topLevelControls } : {}),
    metadata,
  };

  const cleanAdrs = adrs.filter((a) => a.trim().length > 0);
  if (cleanAdrs.length > 0) {
    calmDoc.adrs = cleanAdrs;
  }

  return calmDoc;
}

function discoverTraderXAdrsByStateNum(repoDir: string): Map<string, string[]> {
  const adrDir = path.join(repoDir, 'docs', 'adr');
  const byStateNum = new Map<string, string[]>();
  if (!existsSync(adrDir)) return byStateNum;

  const files = readdirSync(adrDir)
    .filter((f) => /\.(?:md|mdx|adoc)$/i.test(f) && !/^index\./i.test(f))
    .sort();

  const pushAdr = (num: string, relPath: string): void => {
    const list = byStateNum.get(num) ?? [];
    if (!list.includes(relPath)) list.push(relPath);
    byStateNum.set(num, list);
  };

  for (const file of files) {
    const rel = `docs/adr/${file}`;
    const explicitStateMatch = file.match(/state-(\d{3})/i);
    if (explicitStateMatch) {
      pushAdr(explicitStateMatch[1], rel);
      continue;
    }
    if (/convergence/i.test(file)) {
      pushAdr('012', rel);
      continue;
    }
    const prefixMatch = file.match(/^(\d{3})-/);
    if (prefixMatch) {
      const prefixNum = Number.parseInt(prefixMatch[1], 10);
      if (prefixNum >= 1 && prefixNum <= 3) {
        pushAdr('001', rel);
      } else {
        pushAdr(prefixMatch[1], rel);
      }
    }
  }

  return byStateNum;
}

interface ParsedSimpleCommit {
  sha: string;
  shortSha: string;
  date: string;
  timestampIso?: string;
  author: string;
  subject: string;
}

function readStateGitCommits(
  repoDir: string,
  catalogState: TraderXCatalogState,
  runGit: GitCommandRunner,
): ParsedSimpleCommit[] {
  const commits: ParsedSimpleCommit[] = [];
  const seenShas = new Set<string>();

  const tryAddLogOutput = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [sha, shortSha, date, author, subject, timestampIso = ''] = trimmed.split('\x1f');
      if (!sha || !shortSha || seenShas.has(sha)) continue;
      seenShas.add(sha);
      commits.push({
        sha: sha.trim(),
        shortSha: shortSha.trim(),
        date: (date || '2026-05-21').trim(),
        timestampIso: timestampIso.trim() || undefined,
        author: (author || 'FINOS TraderX').trim(),
        subject: (subject || catalogState.title).trim(),
      });
    }
  };

  try {
    const specLog = runGit(
      [
        'log',
        '--reverse',
        '--format=%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1f%cI',
        '--',
        catalogState.featurePack,
      ],
      repoDir,
    );
    tryAddLogOutput(specLog);
  } catch {
    // Non-git directory or shallow clone fallback handled below
  }

  const candidateRefs: string[] = [];
  if (catalogState.publish?.branch) {
    candidateRefs.push(
      `refs/remotes/origin/${catalogState.publish.branch}`,
      `refs/heads/${catalogState.publish.branch}`,
    );
  }
  if (catalogState.publish?.tag) {
    candidateRefs.push(`refs/tags/${catalogState.publish.tag}`);
  }
  for (const ref of candidateRefs) {
    try {
      const branchTip = runGit(
        ['log', '-n', '1', '--format=%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1f%cI', ref],
        repoDir,
      );
      tryAddLogOutput(branchTip);
      break;
    } catch {
      // Optional published state branch ref not fetched locally
    }
  }

  return commits;
}

export function generateTimelineFromTraderXRepo(
  traderxRepoDir: string,
  options: GenerateTraderXTimelineOptions = {},
): FullGitTimelineResult {
  const resolvedRepo = path.resolve(traderxRepoDir);
  if (!existsSync(resolvedRepo)) {
    throw new Error(`TraderX repository path does not exist: "${traderxRepoDir}"`);
  }

  const catalogPath = path.join(resolvedRepo, 'catalog', 'state-catalog.json');
  if (!existsSync(catalogPath)) {
    throw new Error(
      `TraderX state catalog not found at "${catalogPath}" (expected a clone of https://github.com/finos/traderx).`,
    );
  }

  const rawCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
    states?: TraderXCatalogState[];
  };
  const states = Array.isArray(rawCatalog.states) ? rawCatalog.states : [];
  if (states.length === 0) {
    throw new Error(`No states found in TraderX catalog "${catalogPath}".`);
  }

  const runGit = options.gitRunner ?? defaultGitRunner;
  const adrsByStateNum = discoverTraderXAdrsByStateNum(resolvedRepo);
  const cumulativeControlsByStateId = new Map<string, CalmControlDefinition[]>();

  const clusters: MomentCluster[] = [];
  const allDeltas: StructuralCommitDelta[] = [];
  let prevCalmDoc: Record<string, unknown> | null = null;
  let skippedTemplateStates = 0;
  let totalCommitRefsScanned = 0;

  for (const catalogState of states) {
    const featurePackRelPath = catalogState.featurePack.replace(/\\/g, '/');
    const featurePackAbsDir = path.join(resolvedRepo, ...featurePackRelPath.split('/'));
    const modelRelPath = path.posix.join(featurePackRelPath, 'system', 'architecture.model.json');
    const modelAbsPath = path.join(resolvedRepo, ...modelRelPath.split('/'));
    if (!existsSync(modelAbsPath)) {
      options.onDebug?.(`Skipping ${catalogState.id}: missing ${modelRelPath}`);
      skippedTemplateStates++;
      continue;
    }

    const model = JSON.parse(readFileSync(modelAbsPath, 'utf-8')) as TraderXArchitectureModel;
    if (isPlaceholderScaffoldModel(model)) {
      options.onDebug?.(`Skipping placeholder scaffold model in ${catalogState.id}.`);
      skippedTemplateStates++;
      continue;
    }

    const parentStateId = model.inheritsFrom || catalogState.previous?.[0];
    const inheritedControls = parentStateId
      ? (cumulativeControlsByStateId.get(parentStateId) ?? [])
      : [];
    const ownControls = extractTraderXStateControls(
      featurePackAbsDir,
      featurePackRelPath,
      catalogState,
    );
    const mergedForState = new Map<string, CalmControlDefinition>();
    for (const c of inheritedControls) mergedForState.set(c.id, c);
    for (const c of ownControls) mergedForState.set(c.id, c);
    cumulativeControlsByStateId.set(catalogState.id, [...mergedForState.values()]);

    const stateNumMatch = catalogState.id.match(/^(\d{3})/);
    const stateNum = stateNumMatch ? stateNumMatch[1] : '';
    const stateAdrs = stateNum ? (adrsByStateNum.get(stateNum) ?? []) : [];

    const calmDoc = convertTraderXStateToCalm(model, catalogState, stateAdrs, {
      featurePackAbsDir,
      featurePackRelPath,
      inheritedControls,
    });
    const gitCommits = readStateGitCommits(resolvedRepo, catalogState, runGit);
    totalCommitRefsScanned += Math.max(1, gitCommits.length);

    const delta = computeStructuralDelta(prevCalmDoc, calmDoc);
    const isInitial = prevCalmDoc === null;
    const summaryLine = summarizeCounts(delta.counts, isInitial);

    const effectiveCommits: ParsedSimpleCommit[] =
      gitCommits.length > 0
        ? gitCommits
        : [
            {
              sha: catalogState.id,
              shortSha: stateNum ? `state${stateNum}` : catalogState.id.slice(0, 7),
              date: '2026-05-21',
              author: 'FINOS TraderX',
              subject: `${catalogState.id}: ${catalogState.title}`,
            },
          ];

    const stateCommitDeltas: StructuralCommitDelta[] = effectiveCommits.map((c, idx) => {
      const isLastInState = idx === effectiveCommits.length - 1;
      const snap: GitCommitSnapshot = {
        sha: c.sha,
        shortSha: c.shortSha,
        date: c.date,
        ...(c.timestampIso ? { timestampIso: c.timestampIso } : {}),
        author: c.author,
        subject: c.subject,
        body: '',
        historicalPath: modelRelPath,
        coChangedAdrs: isLastInState ? stateAdrs : [],
        document: calmDoc,
      };
      return {
        commit: snap,
        isInitial: isInitial && idx === 0,
        changeItems: isLastInState ? delta.changeItems : [],
        counts: isLastInState
          ? delta.counts
          : {
              nodesAdded: 0,
              nodesModified: 0,
              nodesRemoved: 0,
              relationshipsAdded: 0,
              relationshipsModified: 0,
              relationshipsRemoved: 0,
              flowsAdded: 0,
              flowsModified: 0,
              flowsRemoved: 0,
              controlsAdded: 0,
              controlsModified: 0,
              controlsRemoved: 0,
              adrsAdded: 0,
              adrsRemoved: 0,
              metadataChanged: 0,
            },
        summaryLine: isLastInState ? summaryLine : c.subject,
      };
    });

    const leadCommit = effectiveCommits[effectiveCommits.length - 1];
    const displayNum = stateNum || String(clusters.length + 1).padStart(3, '0');
    const clusterIdxStart = allDeltas.length;
    allDeltas.push(...stateCommitDeltas);
    const clusterIdxEnd = allDeltas.length - 1;

    clusters.push({
      startIndex: clusterIdxStart,
      endIndex: clusterIdxEnd,
      uniqueId: `state-${catalogState.id}`,
      name: `State ${displayNum}: ${catalogState.title}`,
      description:
        model.description?.trim() || `${catalogState.title} (${summaryLine})`,
      validFrom: leadCommit.date,
      adrs: stateAdrs,
      commits: stateCommitDeltas,
      mergedChangeItems: delta.changeItems,
      snapshotDocument: calmDoc,
    });

    prevCalmDoc = calmDoc;
  }

  if (clusters.length === 0) {
    throw new Error(`No authoritative architecture states found in "${resolvedRepo}".`);
  }

  const digest = buildCommitHistoryDigest(allDeltas, {
    sourceFile: 'finos/traderx (state-catalog.json)',
    totalCommitsScanned: totalCommitRefsScanned + skippedTemplateStates,
    validSnapshotsParsed: clusters.length,
    noiseCommitsFiltered: skippedTemplateStates,
  });

  let writtenDigestPath: string | undefined;
  if (options.emitDigestPath) {
    writtenDigestPath = path.resolve(options.emitDigestPath);
    mkdirSync(path.dirname(writtenDigestPath), { recursive: true });
    writeFileSync(writtenDigestPath, JSON.stringify(digest, null, 2) + '\n', 'utf-8');
  }

  const engine = 'traderx-state-catalog';
  const { timeline, snapshotPaths } = assembleCalmTimeline(clusters, {
    sourceFilePath: 'finos-traderx',
    outputPath: options.outputPath,
    snapshotsDir: options.snapshotsDir,
  });

  timeline.metadata = {
    ...(timeline.metadata ?? {}),
    title: 'Git Architecture Timeline — FINOS TraderX (v2.0 Progressive States + FDC3)',
    description:
      'Extracted directly from upstream finos/traderx catalog/state-catalog.json, specs/*/system/architecture.model.json, nonfunctional-delta.md controls, docs/adr/*.md, and Git history, and translates FDC3 contracts (contract-delta.md + appd.v2.json) into validated CALM.',
    'source-repository': 'https://github.com/finos/traderx',
    'clustering-engine': engine,
    'total-commits-scanned': String(totalCommitRefsScanned + skippedTemplateStates),
    'noise-commits-filtered': String(skippedTemplateStates),
    'structural-commits-retained': String(clusters.length),
  };

  if (options.outputPath) {
    const resolvedOutput = path.resolve(options.outputPath);
    mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    writeFileSync(resolvedOutput, JSON.stringify(timeline, null, 2) + '\n', 'utf-8');
  }

  const validationErrors: string[] = options.validate
    ? validateTimelineStructure(timeline, { timelineFilePath: options.outputPath })
    : [];

  if (options.validateSnapshots) {
    for (const cluster of clusters) {
      validationErrors.push(
        ...validateCalmArchitectureSnapshot(cluster.snapshotDocument, cluster.uniqueId),
      );
    }
  }

  let writtenTimelapsePath: string | undefined;
  if (options.timelapsePath) {
    const payload = buildTimelapsePayloadFromClusters(clusters, {
      title: 'CALM Architecture Timelapse — FINOS TraderX (States 001–014 + FDC3)',
      sourceFile: 'finos/traderx',
      defaultView: options.defaultView,
      engine,
      stats: {
        totalCommitsScanned: totalCommitRefsScanned + skippedTemplateStates,
        noiseCommitsFiltered: skippedTemplateStates,
        structuralCommitsRetained: clusters.length,
        momentsGenerated: timeline.moments.length,
      },
    });
    writtenTimelapsePath = writeTimelapseHtml(options.timelapsePath, payload);
  }

  return {
    timeline,
    snapshotPaths,
    clusters,
    digest,
    digestPath: writtenDigestPath,
    timelapsePath: writtenTimelapsePath,
    validationErrors,
    stats: {
      totalCommitsScanned: totalCommitRefsScanned + skippedTemplateStates,
      validSnapshotsParsed: clusters.length,
      noiseCommitsFiltered: skippedTemplateStates,
      structuralCommitsRetained: clusters.length,
      momentsGenerated: timeline.moments.length,
      clusteringEngine: engine,
    },
  };
}
