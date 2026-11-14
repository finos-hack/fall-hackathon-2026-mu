// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeStructuralDelta, summarizeCounts } from './calm-diff.js';
import { synchronizeSavedTimelines } from './federation.js';
import type {
  DeltaChangeItem,
  FederatedNodeProvenance,
  FederatedSourceDescriptor,
  GeneratedGitTimeline,
  MomentCluster,
} from './types.js';

export interface ControlInfo {
  id: string;
  description: string;
  requirementCount: number;
}

export interface NodeInterfaceInfo {
  id: string;
  summary: string;
}

export interface FlowInfo {
  id: string;
  name: string;
  description: string;
  transitionCount: number;
  relationshipIds: string[];
  intents?: string[];
  contexts?: string[];
}

export interface GraphNode {
  id: string;
  name: string;
  nodeType: string;
  description?: string;
  controlCount?: number;
  interfaces?: NodeInterfaceInfo[];
  sourceId?: string;
  sourceLabel?: string;
  sourceIds?: string[];
  sourceLabels?: string[];
  mergedViaDetailedArch?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  relType: string;
}

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  layer: number;
}

export interface TimelapseStats {
  totalCommitsScanned?: number;
  noiseCommitsFiltered?: number;
  structuralCommitsRetained?: number;
  momentsGenerated?: number;
}

export interface TimelapseFrame {
  id: string;
  name: string;
  description: string;
  validFrom: string;
  commitCount: number;
  commits: string[];
  commitMessages: string[];
  adrs: string[];
  summary: string;
  changes: DeltaChangeItem[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  controls?: ControlInfo[];
  flows?: FlowInfo[];
  addedNodeIds: string[];
  modifiedNodeIds: string[];
  removedNodeIds: string[];
  addedEdgeIds: string[];
  modifiedEdgeIds?: string[];
  removedEdgeIds: string[];
}

export interface TimelapsePayload {
  title: string;
  generatedAt: string;
  sourceFile: string;
  sources?: FederatedSourceDescriptor[];
  defaultView?: 'stage' | 'feed';
  engine: string;
  canvasWidth: number;
  canvasHeight: number;
  positions: Record<string, PositionedNode>;
  frames: TimelapseFrame[];
  stats?: TimelapseStats;
}

function attachProvenanceToNodes(
  nodes: GraphNode[],
  provenance?: Record<string, FederatedNodeProvenance>,
): GraphNode[] {
  if (!provenance) return nodes;
  return nodes.map((node) => {
    const prov = provenance[node.id];
    if (!prov) return node;
    return {
      ...node,
      sourceId: prov.primarySourceId,
      sourceLabel: prov.primarySourceLabel,
      sourceIds: prov.sourceIds,
      sourceLabels: prov.sourceLabels,
      mergedViaDetailedArch: prov.mergedViaDetailedArch,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractNodeId(raw: Record<string, unknown>, fallbackIndex: number): string {
  const id = raw['unique-id'] ?? raw['id'];
  if (typeof id === 'string' && id.trim()) {
    return id.trim();
  }
  return `node-${fallbackIndex}`;
}

function readPatternSchemaTuple(prop: Record<string, unknown> | null): unknown[] {
  if (!prop) return [];
  if (Array.isArray(prop['prefixItems'])) return prop['prefixItems'];
  if (Array.isArray(prop['items'])) return prop['items'];
  const single = asRecord(prop['items']);
  return single ? [single] : [];
}

function extractNodesFromPatternSchema(doc: Record<string, unknown>): GraphNode[] {
  const props = asRecord(doc['properties']);
  const nodesProp = asRecord(props?.['nodes']);
  const tupleItems = readPatternSchemaTuple(nodesProp);
  if (tupleItems.length === 0) {
    return [];
  }

  const out: GraphNode[] = [];
  for (let i = 0; i < tupleItems.length; i++) {
    const item = asRecord(tupleItems[i]);
    const itemProps = asRecord(item?.['properties']);
    if (!itemProps) continue;

    const idProp = asRecord(itemProps['unique-id']) ?? asRecord(itemProps['uniqueId']);
    const nameProp = asRecord(itemProps['name']);
    const typeProp = asRecord(itemProps['node-type']) ?? asRecord(itemProps['type']);
    const descProp = asRecord(itemProps['description']);

    const id = typeof idProp?.['const'] === 'string' ? idProp['const'] : `pattern-node-${i}`;
    const name = typeof nameProp?.['const'] === 'string' ? nameProp['const'] : id;
    const nodeType = typeof typeProp?.['const'] === 'string' ? typeProp['const'] : 'service';
    const description = typeof descProp?.['const'] === 'string' ? descProp['const'] : undefined;

    out.push({ id, name, nodeType, description });
  }
  return out;
}

function readControlMapInto(
  rawControls: unknown,
  byId: Map<string, ControlInfo>,
): void {
  const ctrlObj = asRecord(rawControls);
  if (ctrlObj) {
    for (const [rawId, rawVal] of Object.entries(ctrlObj)) {
      const id = rawId.trim();
      if (!id) continue;
      const val = asRecord(rawVal);
      const description =
        typeof val?.['description'] === 'string' ? val['description'].trim() : '';
      const requirementCount = Array.isArray(val?.['requirements'])
        ? val['requirements'].length
        : 0;

      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, description, requirementCount });
      } else {
        byId.set(id, {
          id,
          description: existing.description || description,
          requirementCount: Math.max(existing.requirementCount, requirementCount),
        });
      }
    }
    return;
  }

  if (Array.isArray(rawControls)) {
    for (const item of rawControls) {
      if (typeof item === 'string' && item.trim()) {
        const id = item.trim();
        if (!byId.has(id)) {
          byId.set(id, { id, description: '', requirementCount: 0 });
        }
      } else {
        const rec = asRecord(item);
        const id =
          typeof rec?.['id'] === 'string'
            ? rec['id'].trim()
            : typeof rec?.['unique-id'] === 'string'
              ? rec['unique-id'].trim()
              : '';
        if (!id) continue;
        const description =
          typeof rec?.['description'] === 'string' ? rec['description'].trim() : '';
        const requirementCount = Array.isArray(rec?.['requirements'])
          ? rec['requirements'].length
          : 0;
        const existing = byId.get(id);
        if (!existing) {
          byId.set(id, { id, description, requirementCount });
        } else {
          byId.set(id, {
            id,
            description: existing.description || description,
            requirementCount: Math.max(existing.requirementCount, requirementCount),
          });
        }
      }
    }
  }
}

export function extractActiveControls(doc: Record<string, unknown>): ControlInfo[] {
  const byId = new Map<string, ControlInfo>();

  readControlMapInto(doc['controls'], byId);

  const rawNodes = doc['nodes'];
  if (Array.isArray(rawNodes)) {
    for (const rawNode of rawNodes) {
      const node = asRecord(rawNode);
      if (!node) continue;
      readControlMapInto(node['controls'], byId);
    }
  }

  return [...byId.values()];
}

function countNodeControls(rawControls: unknown): number {
  const rec = asRecord(rawControls);
  if (rec) return Object.keys(rec).length;
  if (Array.isArray(rawControls)) return rawControls.length;
  return 0;
}

function extractNodeInterfaces(rawInterfaces: unknown): NodeInterfaceInfo[] {
  if (!Array.isArray(rawInterfaces)) return [];
  const out: NodeInterfaceInfo[] = [];
  for (const raw of rawInterfaces) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const id = typeof rec['unique-id'] === 'string' ? rec['unique-id'].trim() : '';
    if (!id) continue;
    const parts: string[] = [];
    if (typeof rec['protocol'] === 'string' && rec['protocol'].trim()) {
      parts.push(rec['protocol'].trim());
    } else if (typeof rec['type'] === 'string' && rec['type'].trim()) {
      parts.push(rec['type'].trim());
    }
    const urlVal =
      typeof rec['url'] === 'string'
        ? rec['url'].trim()
        : typeof rec['value'] === 'string'
          ? rec['value'].trim()
          : '';
    if (urlVal) parts.push(urlVal);
    if (Array.isArray(rec['listens-for']) && rec['listens-for'].length > 0) {
      parts.push(`listensFor=[${rec['listens-for'].join(', ')}]`);
    }
    if (Array.isArray(rec['raises']) && rec['raises'].length > 0) {
      parts.push(`raises=[${rec['raises'].join(', ')}]`);
    }
    const ctxs = rec['context-types'] ?? rec['supported-contexts'] ?? rec['broadcasts-context'];
    if (Array.isArray(ctxs) && ctxs.length > 0) {
      parts.push(`contexts=[${ctxs.join(', ')}]`);
    }
    out.push({ id, summary: parts.join(' · ') || 'interface' });
  }
  return out;
}

export function extractActiveFlows(doc: Record<string, unknown>): FlowInfo[] {
  const rawFlows = doc['flows'];
  if (!Array.isArray(rawFlows)) return [];
  const out: FlowInfo[] = [];
  for (let i = 0; i < rawFlows.length; i++) {
    const item = rawFlows[i];
    if (typeof item === 'string' && item.trim()) {
      const ref = item.trim();
      out.push({
        id: ref,
        name: ref,
        description: 'External CALM flow reference.',
        transitionCount: 0,
        relationshipIds: [],
      });
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    const id =
      typeof rec['unique-id'] === 'string' && rec['unique-id'].trim()
        ? rec['unique-id'].trim()
        : `flow-${i + 1}`;
    const name =
      typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim() : id;
    const description =
      typeof rec['description'] === 'string' ? rec['description'].trim() : '';
    const rawTransitions = Array.isArray(rec['transitions']) ? rec['transitions'] : [];
    const relationshipIds: string[] = [];
    for (const tr of rawTransitions) {
      const trRec = asRecord(tr);
      const relId =
        typeof trRec?.['relationship-unique-id'] === 'string'
          ? trRec['relationship-unique-id'].trim()
          : '';
      if (relId) relationshipIds.push(relId);
    }
    const meta = asRecord(rec['metadata']);
    const intents = Array.isArray(meta?.['fdc3-intents'])
      ? meta['fdc3-intents'].filter((x): x is string => typeof x === 'string')
      : undefined;
    const contexts = Array.isArray(meta?.['fdc3-contexts'])
      ? meta['fdc3-contexts'].filter((x): x is string => typeof x === 'string')
      : undefined;
    out.push({
      id,
      name,
      description,
      transitionCount: rawTransitions.length,
      relationshipIds,
      ...(intents && intents.length > 0 ? { intents } : {}),
      ...(contexts && contexts.length > 0 ? { contexts } : {}),
    });
  }
  return out;
}

export function extractGraphNodes(doc: Record<string, unknown>): GraphNode[] {
  const rawNodes = doc['nodes'];
  if (!Array.isArray(rawNodes)) {
    return extractNodesFromPatternSchema(doc);
  }

  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (let i = 0; i < rawNodes.length; i++) {
    const node = asRecord(rawNodes[i]);
    if (!node) continue;
    const id = extractNodeId(node, i);
    if (seen.has(id)) continue;
    seen.add(id);

    const name = typeof node['name'] === 'string' && node['name'].trim() ? node['name'].trim() : id;
    const nodeType =
      typeof node['node-type'] === 'string' && node['node-type'].trim()
        ? node['node-type'].trim()
        : typeof node['type'] === 'string' && node['type'].trim()
          ? node['type'].trim()
          : 'service';
    const description =
      typeof node['description'] === 'string' ? node['description'] : undefined;
    const controlCount = countNodeControls(node['controls']);
    const interfaces = extractNodeInterfaces(node['interfaces']);

    const graphNode: GraphNode = { id, name, nodeType, description };
    if (controlCount > 0) {
      graphNode.controlCount = controlCount;
    }
    if (interfaces.length > 0) {
      graphNode.interfaces = interfaces;
    }
    out.push(graphNode);
  }
  return out;
}

function readPatternConnectsEndpoints(relTypeProp: Record<string, unknown> | null): {
  source: string;
  target: string;
  relType: string;
} {
  if (!relTypeProp) return { source: '', target: '', relType: 'connects' };

  const relProps = asRecord(relTypeProp['properties']);
  const connects = asRecord(relProps?.['connects']);
  const connectsProps = asRecord(connects?.['properties']);
  if (connectsProps) {
    const srcProp = asRecord(connectsProps['source']);
    const dstProp = asRecord(connectsProps['destination']);
    const srcNode = asRecord(asRecord(srcProp?.['properties'])?.['node']);
    const dstNode = asRecord(asRecord(dstProp?.['properties'])?.['node']);
    const source =
      typeof srcNode?.['const'] === 'string'
        ? srcNode['const']
        : typeof srcProp?.['const'] === 'string'
          ? srcProp['const']
          : '';
    const target =
      typeof dstNode?.['const'] === 'string'
        ? dstNode['const']
        : typeof dstProp?.['const'] === 'string'
          ? dstProp['const']
          : '';
    if (source && target) {
      return { source, target, relType: 'connects' };
    }
  }

  const constObj = asRecord(relTypeProp['const']);
  const constConnects = asRecord(constObj?.['connects']);
  if (constConnects) {
    const rawSrc = constConnects['source'];
    const rawDst = constConnects['destination'];
    const source =
      typeof rawSrc === 'string'
        ? rawSrc
        : typeof asRecord(rawSrc)?.['node'] === 'string'
          ? (asRecord(rawSrc)!['node'] as string)
          : '';
    const target =
      typeof rawDst === 'string'
        ? rawDst
        : typeof asRecord(rawDst)?.['node'] === 'string'
          ? (asRecord(rawDst)!['node'] as string)
          : '';
    if (source && target) {
      return { source, target, relType: 'connects' };
    }
  }

  return { source: '', target: '', relType: 'connects' };
}

function extractEdgesFromPatternSchema(doc: Record<string, unknown>): GraphEdge[] {
  const props = asRecord(doc['properties']);
  const relsProp = asRecord(props?.['relationships']);
  const tupleItems = readPatternSchemaTuple(relsProp);
  if (tupleItems.length === 0) {
    return [];
  }

  const out: GraphEdge[] = [];
  for (let i = 0; i < tupleItems.length; i++) {
    const item = asRecord(tupleItems[i]);
    const itemProps = asRecord(item?.['properties']);
    if (!itemProps) continue;

    const idProp = asRecord(itemProps['unique-id']) ?? asRecord(itemProps['uniqueId']);
    const descProp = asRecord(itemProps['description']);
    const protoProp = asRecord(itemProps['protocol']);
    const relTypeProp = asRecord(itemProps['relationship-type']);
    const { source, target, relType } = readPatternConnectsEndpoints(relTypeProp);
    if (!source || !target) continue;

    const id = typeof idProp?.['const'] === 'string' ? idProp['const'] : `pattern-rel-${i}`;
    const label =
      typeof descProp?.['const'] === 'string'
        ? descProp['const']
        : typeof protoProp?.['const'] === 'string'
          ? protoProp['const']
          : relType;
    out.push({ id, source, target, label, relType });
  }
  return out;
}

export function extractGraphEdges(doc: Record<string, unknown>): GraphEdge[] {
  const rawRels = doc['relationships'];
  if (!Array.isArray(rawRels)) {
    return extractEdgesFromPatternSchema(doc);
  }

  const out: GraphEdge[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawRels.length; i++) {
    const rel = asRecord(rawRels[i]);
    if (!rel) continue;

    const baseId =
      typeof rel['unique-id'] === 'string' && rel['unique-id'].trim()
        ? rel['unique-id'].trim()
        : typeof rel['id'] === 'string' && rel['id'].trim()
          ? rel['id'].trim()
          : `rel-${i}`;
    const label =
      typeof rel['protocol'] === 'string' && rel['protocol'].trim()
        ? rel['protocol'].trim()
        : typeof rel['description'] === 'string' && rel['description'].trim()
          ? rel['description'].trim().slice(0, 32)
          : '';

    const relTypeObj = asRecord(rel['relationship-type']);
    const pairs: Array<{ source: string; target: string; relType: string }> = [];

    if (relTypeObj) {
      const connects = asRecord(relTypeObj['connects']);
      if (connects) {
        const src = asRecord(connects['source'])?.['node'];
        const dst = asRecord(connects['destination'])?.['node'];
        if (typeof src === 'string' && typeof dst === 'string') {
          pairs.push({ source: src, target: dst, relType: 'connects' });
        }
      }

      const interacts = asRecord(relTypeObj['interacts']);
      if (interacts) {
        const actor = interacts['actor'];
        const nodes = interacts['nodes'];
        if (typeof actor === 'string' && Array.isArray(nodes)) {
          for (const target of nodes) {
            if (typeof target === 'string') {
              pairs.push({ source: actor, target, relType: 'interacts' });
            }
          }
        }
      }

      const deployedIn = asRecord(relTypeObj['deployed-in']);
      if (deployedIn) {
        const container = deployedIn['container'];
        const nodes = deployedIn['nodes'];
        if (typeof container === 'string' && Array.isArray(nodes)) {
          for (const child of nodes) {
            if (typeof child === 'string') {
              pairs.push({ source: container, target: child, relType: 'deployed-in' });
            }
          }
        }
      }

      const composedOf = asRecord(relTypeObj['composed-of']);
      if (composedOf) {
        const container = composedOf['container'];
        const nodes = composedOf['nodes'];
        if (typeof container === 'string' && Array.isArray(nodes)) {
          for (const child of nodes) {
            if (typeof child === 'string') {
              pairs.push({ source: container, target: child, relType: 'composed-of' });
            }
          }
        }
      }
    } else if (typeof rel['source'] === 'string' && typeof rel['destination'] === 'string') {
      pairs.push({
        source: rel['source'],
        target: rel['destination'],
        relType: 'connects',
      });
    }

    pairs.forEach((pair, pairIdx) => {
      const edgeId = pairs.length > 1 ? `${baseId}::${pairIdx}` : baseId;
      if (seen.has(edgeId)) return;
      seen.add(edgeId);
      out.push({
        id: edgeId,
        source: pair.source,
        target: pair.target,
        label: label || pair.relType,
        relType: pair.relType,
      });
    });
  }

  return out;
}

const NODE_TYPE_RANK: Record<string, number> = {
  actor: 0,
  'web-client': 1,
  webclient: 1,
  'mobile-client': 1,
  service: 2,
  system: 2,
  database: 3,
  storage: 3,
  'data-asset': 3,
  queue: 3,
  network: 4,
  infrastructure: 4,
};

export function computeSuperGraphLayout(
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
): {
  positions: Record<string, PositionedNode>;
  canvasWidth: number;
  canvasHeight: number;
} {
  if (allNodes.length === 0) {
    return {
      positions: {},
      canvasWidth: 960,
      canvasHeight: 540,
    };
  }

  const nodeMap = new Map<string, GraphNode>();
  for (const node of allNodes) {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
  }

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodeMap.keys()) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }

  for (const edge of allEdges) {
    if (edge.source === edge.target) continue;
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    outgoing.get(edge.source)!.add(edge.target);
    incoming.get(edge.target)!.add(edge.source);
  }

  const dagOut = new Map<string, Set<string>>();
  const dagIn = new Map<string, Set<string>>();
  for (const id of nodeMap.keys()) {
    dagOut.set(id, new Set());
    dagIn.set(id, new Set());
  }

  const dfsState = new Map<string, number>();
  const orderedIds = [...nodeMap.keys()].sort((a, b) => {
    const rankDiff =
      (NODE_TYPE_RANK[nodeMap.get(a)!.nodeType] ?? 2) -
      (NODE_TYPE_RANK[nodeMap.get(b)!.nodeType] ?? 2);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });

  const dfsVisit = (u: string): void => {
    dfsState.set(u, 1);
    const nextIds = [...(outgoing.get(u) ?? [])].sort();
    for (const v of nextIds) {
      const state = dfsState.get(v) ?? 0;
      if (state === 1) {
        continue;
      }
      dagOut.get(u)!.add(v);
      dagIn.get(v)!.add(u);
      if (state === 0) {
        dfsVisit(v);
      }
    }
    dfsState.set(u, 2);
  };

  for (const id of orderedIds) {
    if ((dfsState.get(id) ?? 0) === 0) {
      dfsVisit(id);
    }
  }

  const layerMap = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const [id, preds] of dagIn.entries()) {
    inDegree.set(id, preds.size);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
      layerMap.set(id, NODE_TYPE_RANK[nodeMap.get(id)!.nodeType] ?? 0);
    }
  }
  queue.sort();

  const visited = new Set<string>();
  while (queue.length > 0) {
    const curr = queue.shift()!;
    visited.add(curr);
    const currLayer = layerMap.get(curr) ?? 0;
    for (const next of dagOut.get(curr) ?? []) {
      const nextLayer = Math.max(layerMap.get(next) ?? 0, currLayer + 1);
      layerMap.set(next, nextLayer);
      const remaining = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, remaining);
      if (remaining <= 0 && !visited.has(next)) {
        queue.push(next);
      }
    }
  }

  for (const id of nodeMap.keys()) {
    if (!layerMap.has(id)) {
      layerMap.set(id, NODE_TYPE_RANK[nodeMap.get(id)!.nodeType] ?? 2);
    }
  }

  const uniqueLayers = [...new Set(layerMap.values())].sort((a, b) => a - b);
  const layerIndexLookup = new Map<number, number>();
  uniqueLayers.forEach((val, idx) => layerIndexLookup.set(val, idx));

  const buckets = new Map<number, GraphNode[]>();
  for (const [id, node] of nodeMap.entries()) {
    const compressed = layerIndexLookup.get(layerMap.get(id) ?? 0) ?? 0;
    const list = buckets.get(compressed) ?? [];
    list.push(node);
    buckets.set(compressed, list);
  }

  const sortedLayerNums = [...buckets.keys()].sort((a, b) => a - b);
  for (const layerNum of sortedLayerNums) {
    buckets
      .get(layerNum)!
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  const layerOfNode = new Map<string, number>();
  const rowIndex = new Map<string, number>();
  for (const layerNum of sortedLayerNums) {
    const list = buckets.get(layerNum)!;
    list.forEach((node, idx) => {
      layerOfNode.set(node.id, layerNum);
      rowIndex.set(node.id, idx);
    });
  }

  const sortLayerByBarycenter = (
    layerNum: number,
    neighborMap: Map<string, Set<string>>,
    direction: 'in' | 'out',
  ): void => {
    const list = buckets.get(layerNum)!;
    if (list.length <= 1) return;

    const scores = new Map<string, number>();
    for (const node of list) {
      const neighbors = neighborMap.get(node.id);
      let sum = 0;
      let count = 0;
      if (neighbors) {
        for (const nbId of neighbors) {
          const nbLayer = layerOfNode.get(nbId);
          if (nbLayer === undefined) continue;
          if (direction === 'in' ? nbLayer < layerNum : nbLayer > layerNum) {
            const nbLen = Math.max(1, buckets.get(nbLayer)?.length ?? 1);
            sum += ((rowIndex.get(nbId) ?? 0) + 0.5) / nbLen;
            count++;
          }
        }
      }
      const fallback = ((rowIndex.get(node.id) ?? 0) + 0.5) / Math.max(1, list.length);
      scores.set(node.id, count > 0 ? sum / count : fallback);
    }

    list.sort((a, b) => {
      const diff = (scores.get(a.id) ?? 0) - (scores.get(b.id) ?? 0);
      if (Math.abs(diff) > 1e-9) return diff;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });

    list.forEach((node, idx) => {
      rowIndex.set(node.id, idx);
    });
  };

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < sortedLayerNums.length; i++) {
      sortLayerByBarycenter(sortedLayerNums[i], incoming, 'in');
    }
    for (let i = sortedLayerNums.length - 2; i >= 0; i--) {
      sortLayerByBarycenter(sortedLayerNums[i], outgoing, 'out');
    }
  }

  const maxRowsPerCol = 6;
  const finalColumns: GraphNode[][] = [];
  for (const layerNum of sortedLayerNums) {
    const list = buckets.get(layerNum)!;
    if (list.length <= maxRowsPerCol) {
      finalColumns.push(list);
    } else {
      const subColCount = Math.ceil(list.length / maxRowsPerCol);
      const chunkSize = Math.ceil(list.length / subColCount);
      for (let c = 0; c < list.length; c += chunkSize) {
        finalColumns.push(list.slice(c, c + chunkSize));
      }
    }
  }

  const colSpacing = 290;
  const rowSpacing = 132;
  const padX = 115;
  const padY = 64;

  const maxRowsInAnyLayer = Math.max(1, ...finalColumns.map((col) => col.length));
  const canvasWidth = Math.max(520, padX * 2 + Math.max(0, finalColumns.length - 1) * colSpacing);
  const canvasHeight = Math.max(260, padY * 2 + Math.max(0, maxRowsInAnyLayer - 1) * rowSpacing);

  const positions: Record<string, PositionedNode> = {};
  finalColumns.forEach((list, colIdx) => {
    const totalLayerHeight = (list.length - 1) * rowSpacing;
    const startY = canvasHeight / 2 - totalLayerHeight / 2;
    const x = finalColumns.length === 1 ? canvasWidth / 2 : padX + colIdx * colSpacing;

    list.forEach((node, rowIdx) => {
      positions[node.id] = {
        ...node,
        x: Math.round(x),
        y: Math.round(startY + rowIdx * rowSpacing),
        layer: colIdx,
      };
    });
  });

  return { positions, canvasWidth, canvasHeight };
}

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function buildTimelapsePayloadFromClusters(
  clusters: MomentCluster[],
  options: {
    title?: string;
    sourceFile: string;
    sources?: FederatedSourceDescriptor[];
    defaultView?: 'stage' | 'feed';
    engine: string;
    stats?: TimelapseStats;
  },
): TimelapsePayload {
  const unionNodes = new Map<string, GraphNode>();
  const unionEdges = new Map<string, GraphEdge>();

  const frames: TimelapseFrame[] = [];
  let prevNodeMap = new Map<string, GraphNode>();
  let prevEdgeIds = new Set<string>();

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const doc = cluster.snapshotDocument;
    const nodes = attachProvenanceToNodes(extractGraphNodes(doc), cluster.nodeProvenance);
    const edges = extractGraphEdges(doc);
    const controls = extractActiveControls(doc);
    const flows = extractActiveFlows(doc);

    for (const node of nodes) {
      unionNodes.set(node.id, node);
    }
    for (const edge of edges) {
      if (!unionEdges.has(edge.id)) {
        unionEdges.set(edge.id, edge);
      }
    }

    const currNodeMap = new Map(nodes.map((n) => [n.id, n]));
    const currEdgeIds = new Set(edges.map((e) => e.id));

    const addedNodeIds = nodes
      .filter((n) => !prevNodeMap.has(n.id))
      .map((n) => n.id);
    const removedNodeIds = [...prevNodeMap.keys()].filter((id) => !currNodeMap.has(id));
    const modifiedNodeIds = cluster.mergedChangeItems
      .filter((c) => c.category === 'node' && c.kind === 'mod' && currNodeMap.has(c.id))
      .map((c) => c.id);

    const addedEdgeIds = edges
      .filter((e) => !prevEdgeIds.has(e.id))
      .map((e) => e.id);
    const modifiedEdgeIds = cluster.mergedChangeItems
      .filter((c) => c.category === 'relationship' && c.kind === 'mod' && currEdgeIds.has(c.id))
      .map((c) => c.id);
    const removedEdgeIds = [...prevEdgeIds].filter((id) => !currEdgeIds.has(id));

    const lastCommit = cluster.commits[cluster.commits.length - 1];
    const summary = lastCommit?.summaryLine ?? cluster.description;

    frames.push({
      id: cluster.uniqueId || `moment-${String(i + 1).padStart(2, '0')}`,
      name: cluster.name,
      description: cluster.description,
      validFrom: cluster.validFrom,
      commitCount: cluster.commits.length,
      commits: cluster.commits.map((d) => d.commit.shortSha),
      commitMessages: cluster.commits.map((d) => d.commit.subject),
      adrs: cluster.adrs,
      summary,
      changes: cluster.mergedChangeItems,
      nodes,
      edges,
      controls,
      ...(flows.length > 0 ? { flows } : {}),
      addedNodeIds,
      modifiedNodeIds: [...new Set(modifiedNodeIds)],
      removedNodeIds,
      addedEdgeIds,
      modifiedEdgeIds: [...new Set(modifiedEdgeIds)],
      removedEdgeIds,
    });

    prevNodeMap = currNodeMap;
    prevEdgeIds = currEdgeIds;
  }

  const layout = computeSuperGraphLayout([...unionNodes.values()], [...unionEdges.values()]);

  const stats: TimelapseStats | undefined = options.stats
    ? {
        ...options.stats,
        momentsGenerated: options.stats.momentsGenerated ?? frames.length,
      }
    : undefined;

  const isMultiSource = Boolean(options.sources && options.sources.length > 1);
  const sourceBase = isMultiSource
    ? options.sources!.map((s) => s.sourceLabel).join(' + ')
    : path.basename(options.sourceFile);
  return {
    title: options.title ?? `CALM Architecture Timelapse — ${sourceBase}`,
    generatedAt: new Date().toISOString(),
    sourceFile: sourceBase,
    ...(isMultiSource ? { sources: options.sources } : {}),
    ...(options.defaultView ? { defaultView: options.defaultView } : {}),
    engine: options.engine,
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
    positions: layout.positions,
    frames,
    ...(stats ? { stats } : {}),
  };
}

export function buildTimelapsePayloadFromTimelineFile(
  timelineFilePath: string,
): TimelapsePayload {
  const resolved = path.resolve(timelineFilePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Timeline file does not exist: "${timelineFilePath}"`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as GeneratedGitTimeline;
  const timelineDir = path.dirname(resolved);
  const entries = Array.isArray(raw.moments) ? raw.moments : [];

  const unionNodes = new Map<string, GraphNode>();
  const unionEdges = new Map<string, GraphEdge>();
  const frames: TimelapseFrame[] = [];

  let prevDoc: Record<string, unknown> | null = null;
  let prevNodeIds = new Set<string>();
  let prevEdgeIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const snapshotRel = entry.details?.['detailed-architecture'] ?? entry.details?.['required-pattern'];
    if (!snapshotRel) {
      throw new Error(
        `Moment '${entry['unique-id']}' in '${resolved}' is missing details.detailed-architecture or details.required-pattern.`,
      );
    }
    const snapshotPath = path.resolve(timelineDir, snapshotRel);
    const doc = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    const delta = computeStructuralDelta(prevDoc, doc);

    const entryMeta = asRecord((entry as unknown as Record<string, unknown>)['metadata']);
    const rawProvenance = asRecord(entryMeta?.['node-provenance']) as
      | Record<string, FederatedNodeProvenance>
      | null;
    const nodes = attachProvenanceToNodes(extractGraphNodes(doc), rawProvenance ?? undefined);
    const edges = extractGraphEdges(doc);
    const controls = extractActiveControls(doc);
    const flows = extractActiveFlows(doc);

    for (const node of nodes) {
      unionNodes.set(node.id, node);
    }
    for (const edge of edges) {
      if (!unionEdges.has(edge.id)) {
        unionEdges.set(edge.id, edge);
      }
    }

    const currNodeIds = new Set(nodes.map((n) => n.id));
    const currEdgeIds = new Set(edges.map((e) => e.id));

    const addedNodeIds = nodes.filter((n) => !prevNodeIds.has(n.id)).map((n) => n.id);
    const removedNodeIds = [...prevNodeIds].filter((id) => !currNodeIds.has(id));
    const modifiedNodeIds = delta.changeItems
      .filter((c) => c.category === 'node' && c.kind === 'mod' && currNodeIds.has(c.id))
      .map((c) => c.id);
    const addedEdgeIds = edges.filter((e) => !prevEdgeIds.has(e.id)).map((e) => e.id);
    const modifiedEdgeIds = delta.changeItems
      .filter((c) => c.category === 'relationship' && c.kind === 'mod' && currEdgeIds.has(c.id))
      .map((c) => c.id);
    const removedEdgeIds = [...prevEdgeIds].filter((id) => !currEdgeIds.has(id));

    const entryMetaForCommits = asRecord((entry as unknown as Record<string, unknown>)['metadata']);
    const commits = Array.isArray(entryMetaForCommits?.['commits'])
      ? entryMetaForCommits['commits'].filter((c): c is string => typeof c === 'string')
      : [];
    const rawMsgs = entryMetaForCommits?.['commit-messages'] ?? entryMetaForCommits?.['commitMessages'];
    const commitMessages = Array.isArray(rawMsgs)
      ? rawMsgs.filter((m): m is string => typeof m === 'string')
      : [];
    const parsedCount = parseOptionalInt(
      entryMetaForCommits?.['commit-count'] ?? entryMetaForCommits?.['commitCount'],
    );
    const commitCount = parsedCount ?? commits.length;

    frames.push({
      id: entry['unique-id'],
      name: entry.name,
      description: entry.description,
      validFrom: entry['valid-from'] ?? '',
      commitCount,
      commits,
      commitMessages,
      adrs: entry.adrs ?? [],
      summary: summarizeCounts(delta.counts, i === 0),
      changes: delta.changeItems,
      nodes,
      edges,
      controls,
      ...(flows.length > 0 ? { flows } : {}),
      addedNodeIds,
      modifiedNodeIds: [...new Set(modifiedNodeIds)],
      removedNodeIds,
      addedEdgeIds,
      modifiedEdgeIds: [...new Set(modifiedEdgeIds)],
      removedEdgeIds,
    });

    prevDoc = doc;
    prevNodeIds = currNodeIds;
    prevEdgeIds = currEdgeIds;
  }

  const layout = computeSuperGraphLayout([...unionNodes.values()], [...unionEdges.values()]);

  const rawMeta = asRecord(raw.metadata);
  const totalCommitsScanned = parseOptionalInt(
    rawMeta?.['total-commits-scanned'] ?? rawMeta?.['totalCommitsScanned'],
  );
  const noiseCommitsFiltered = parseOptionalInt(
    rawMeta?.['noise-commits-filtered'] ?? rawMeta?.['noiseCommitsFiltered'],
  );
  const structuralCommitsRetained = parseOptionalInt(
    rawMeta?.['structural-commits-retained'] ?? rawMeta?.['structuralCommitsRetained'],
  );
  const momentsGenerated =
    parseOptionalInt(rawMeta?.['moments-generated'] ?? rawMeta?.['momentsGenerated']) ??
    frames.length;

  const stats: TimelapseStats | undefined =
    totalCommitsScanned !== undefined ||
    noiseCommitsFiltered !== undefined ||
    structuralCommitsRetained !== undefined
      ? {
          totalCommitsScanned,
          noiseCommitsFiltered,
          structuralCommitsRetained,
          momentsGenerated,
        }
      : undefined;

  const rawSources = Array.isArray(rawMeta?.['sources'])
    ? (rawMeta['sources'] as FederatedSourceDescriptor[])
    : undefined;
  const engineStr =
    typeof rawMeta?.['clustering-engine'] === 'string'
      ? rawMeta['clustering-engine']
      : 'manual-timeline';

  const sourceBase =
    rawSources && rawSources.length > 1
      ? rawSources.map((s) => s.sourceLabel).join(' + ')
      : typeof rawMeta?.['source-file'] === 'string' && rawMeta['source-file'].trim()
        ? path.basename(rawMeta['source-file'].trim())
        : path.basename(resolved);
  return {
    title: `CALM Architecture Timelapse — ${sourceBase}`,
    generatedAt: new Date().toISOString(),
    sourceFile: sourceBase,
    ...(rawSources && rawSources.length > 1 ? { sources: rawSources } : {}),
    engine: engineStr,
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
    positions: layout.positions,
    frames,
    ...(stats ? { stats } : {}),
  };
}

export function buildTimelapsePayloadFromTimelineFiles(
  timelinePaths: string[],
): TimelapsePayload {
  if (timelinePaths.length === 1) {
    return buildTimelapsePayloadFromTimelineFile(timelinePaths[0]);
  }

  const { sources, frames: syncFrames } = synchronizeSavedTimelines(timelinePaths);
  const unionNodes = new Map<string, GraphNode>();
  const unionEdges = new Map<string, GraphEdge>();
  const frames: TimelapseFrame[] = [];

  let prevDoc: Record<string, unknown> | null = null;
  let prevNodeIds = new Set<string>();
  let prevEdgeIds = new Set<string>();

  for (let i = 0; i < syncFrames.length; i++) {
    const sf = syncFrames[i];
    const delta = computeStructuralDelta(prevDoc, sf.document);
    const nodes = attachProvenanceToNodes(extractGraphNodes(sf.document), sf.nodeProvenance);
    const edges = extractGraphEdges(sf.document);
    const controls = extractActiveControls(sf.document);

    for (const node of nodes) unionNodes.set(node.id, node);
    for (const edge of edges) {
      if (!unionEdges.has(edge.id)) unionEdges.set(edge.id, edge);
    }

    const currNodeIds = new Set(nodes.map((n) => n.id));
    const currEdgeIds = new Set(edges.map((e) => e.id));

    frames.push({
      id: sf.uniqueId,
      name: sf.name,
      description: sf.description,
      validFrom: sf.validFrom,
      commitCount: sf.commitCount,
      commits: sf.commits,
      commitMessages: sf.commitMessages,
      adrs: sf.adrs,
      summary: summarizeCounts(delta.counts, i === 0),
      changes: delta.changeItems,
      nodes,
      edges,
      controls,
      addedNodeIds: nodes.filter((n) => !prevNodeIds.has(n.id)).map((n) => n.id),
      modifiedNodeIds: [
        ...new Set(
          delta.changeItems
            .filter((c) => c.category === 'node' && c.kind === 'mod' && currNodeIds.has(c.id))
            .map((c) => c.id),
        ),
      ],
      removedNodeIds: [...prevNodeIds].filter((id) => !currNodeIds.has(id)),
      addedEdgeIds: edges.filter((e) => !prevEdgeIds.has(e.id)).map((e) => e.id),
      modifiedEdgeIds: [
        ...new Set(
          delta.changeItems
            .filter((c) => c.category === 'relationship' && c.kind === 'mod' && currEdgeIds.has(c.id))
            .map((c) => c.id),
        ),
      ],
      removedEdgeIds: [...prevEdgeIds].filter((id) => !currEdgeIds.has(id)),
    });

    prevDoc = sf.document;
    prevNodeIds = currNodeIds;
    prevEdgeIds = currEdgeIds;
  }

  const layout = computeSuperGraphLayout([...unionNodes.values()], [...unionEdges.values()]);
  const sourceDisplay = sources.map((s) => s.sourceLabel).join(' + ');

  return {
    title: `CALM Architecture Timelapse — ${sourceDisplay}`,
    generatedAt: new Date().toISOString(),
    sourceFile: sourceDisplay,
    sources,
    engine: 'synchronized-timelines',
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
    positions: layout.positions,
    frames,
  };
}

function escapeJsonForHtmlScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderTimelapseHtml(payload: TimelapsePayload): string {
  const serializedPayload = escapeJsonForHtmlScript(JSON.stringify(payload));
  const safeTitle = escapeHtml(payload.title);
  const totalCommitSum = payload.frames.reduce((acc, f) => acc + (f.commitCount || 0), 0);
  let funnelText = '';
  if (payload.stats?.totalCommitsScanned !== undefined) {
    const scanned = payload.stats.totalCommitsScanned;
    const noise = payload.stats.noiseCommitsFiltered ?? 0;
    const moments = payload.stats.momentsGenerated ?? payload.frames.length;
    funnelText = `${scanned} commits -> ${noise} noise filtered -> ${moments} moments`;
  } else if (totalCommitSum > payload.frames.length) {
    funnelText = `${totalCommitSum} commits -> ${payload.frames.length} moments`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #11192e;
      --panel-alt: #16223f;
      --border: #253459;
      --text: #e6edf7;
      --muted: #93a4c7;
      --accent: #38bdf8;
      --added: #22c55e;
      --modified: #f59e0b;
      --removed: #ef4444;
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      margin: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
    }
    header {
      padding: 9px 16px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    header h1 {
      margin: 0;
      font-size: 15.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      font-size: 11.5px;
      color: var(--muted);
    }
    .badge {
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      white-space: nowrap;
    }
    .badge-funnel {
      color: #bae6fd;
      border-color: #0284c7;
      background: rgba(2, 132, 199, 0.16);
    }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 390px;
      flex: 1 1 0%;
      min-height: 0;
      overflow: hidden;
    }
    .stage {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      min-width: 0;
      padding: 10px 12px;
      gap: 8px;
      overflow: hidden;
    }
    .stage-toolbar {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 12px;
      flex-shrink: 0;
    }
    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .toolbar-sep {
      width: 1px;
      height: 20px;
      background: var(--border);
      margin: 0 2px;
      flex-shrink: 0;
    }
    .stage-toolbar label {
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .stage-toolbar select {
      max-width: 195px;
    }
    .canvas-wrap {
      flex: 1 1 0%;
      min-height: 0;
      background: radial-gradient(circle at top left, #15213e 0%, #0b1020 70%);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      position: relative;
      cursor: grab;
      user-select: none;
    }
    .canvas-wrap.panning { cursor: grabbing; }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .canvas-overlay-top {
      position: absolute;
      left: 10px;
      top: 10px;
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 5;
      background: rgba(17, 25, 46, 0.84);
      padding: 5px 11px;
      border-radius: 999px;
      border: 1px solid var(--border);
      backdrop-filter: blur(4px);
      pointer-events: none;
    }
    .canvas-hint {
      font-size: 11px;
      color: var(--muted);
      border-left: 1px solid var(--border);
      padding-left: 10px;
    }
    .zoom-controls {
      position: absolute;
      right: 10px;
      bottom: 10px;
      display: flex;
      gap: 5px;
      z-index: 5;
      background: rgba(17, 25, 46, 0.88);
      padding: 5px;
      border-radius: 9px;
      border: 1px solid var(--border);
      backdrop-filter: blur(4px);
    }
    .zoom-controls button {
      padding: 3px 9px;
      font-size: 12px;
      font-weight: 600;
    }
    .controls {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: nowrap;
      flex-shrink: 0;
    }
    .transport-btns {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .scrubber-wrap {
      flex: 1 1 auto;
      min-width: 120px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .scrubber-label {
      font-size: 12px;
      color: #bae6fd;
      font-weight: 500;
      max-width: 220px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    button, select, input[type="date"] {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12.5px;
      cursor: pointer;
    }
    input[type="date"] { cursor: text; color-scheme: dark; padding: 4px 8px; }
    button:hover, select:hover { border-color: var(--accent); }
    button.primary {
      background: #0284c7;
      border-color: #38bdf8;
      font-weight: 600;
      min-width: 78px;
    }
    input[type="range"] {
      flex: 1;
      min-width: 100px;
      accent-color: var(--accent);
      cursor: pointer;
      margin: 0;
    }
    .legend {
      display: flex;
      gap: 11px;
      font-size: 11.5px;
      color: var(--muted);
      align-items: center;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }
    aside {
      background: var(--panel);
      border-left: 1px solid var(--border);
      padding: 0 16px 16px 16px;
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      display: flex;
      flex-direction: column;
      gap: 11px;
    }
    .moment-header {
      position: sticky;
      top: 0;
      z-index: 4;
      background: var(--panel);
      padding: 14px 0 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .moment-header h2 {
      margin: 0 0 3px 0;
      font-size: 15.5px;
      color: var(--accent);
    }
    .moment-date {
      font-size: 12px;
      color: var(--muted);
    }
    .card {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 11px 12px;
      flex-shrink: 0;
    }
    .card h3 {
      margin: 0 0 7px 0;
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .change-list, .commit-list, .governance-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12.5px;
    }
    .tag {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      margin-right: 6px;
    }
    .tag-added { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .tag-modified { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .tag-removed { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .tag-info { background: rgba(56, 189, 248, 0.2); color: #7dd3fc; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: #bae6fd;
    }
    .node-group { transition: opacity 280ms ease, transform 280ms ease; cursor: pointer; }
    .edge-group { transition: opacity 280ms ease; }
    #viewport-layer.smooth-cam { transition: transform 240ms ease-out; }
    .audit-banner {
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #bae6fd;
      border-radius: 8px;
      padding: 6px 11px;
      font-size: 12px;
      flex-shrink: 0;
    }
    .audit-banner.warn {
      background: rgba(245, 158, 11, 0.14);
      border-color: rgba(245, 158, 11, 0.45);
      color: #fde68a;
    }
    .compare-banner {
      padding: 6px 8px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.14);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #bae6fd;
      font-size: 12px;
      font-weight: 600;
    }
    .gov-section { margin-top: 8px; }
    .gov-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    @media (max-width: 1180px) {
      main {
        grid-template-columns: minmax(0, 1fr) 310px;
      }
    }
    @media (max-width: 900px) {
      body {
        height: auto;
        min-height: 100vh;
        overflow: auto;
      }
      header {
        padding: 7px 12px;
        gap: 8px;
      }
      #badge-keys, #badge-engine {
        display: none !important;
      }
      main {
        grid-template-columns: 1fr;
        overflow: visible;
      }
      .stage {
        height: auto;
        padding: 8px;
        gap: 6px;
        overflow: visible;
      }
      .stage-toolbar {
        padding: 5px 8px;
        gap: 6px;
      }
      .toolbar-sep {
        display: none !important;
      }
      .canvas-wrap {
        height: clamp(340px, 62dvh, 540px);
        min-height: 320px;
        flex: none;
      }
      .controls {
        flex-wrap: wrap;
        padding: 6px 10px;
      }
      .canvas-hint, .scrubber-label {
        display: none;
      }
      aside {
        height: auto;
        overflow: visible;
        border-left: none;
        border-top: 1px solid var(--border);
      }
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .mode-switch {
      display: inline-flex;
      background: #0b1020;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px;
      gap: 2px;
      flex-shrink: 0;
    }
    .mode-btn {
      border: none;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      padding: 4px 11px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .mode-btn:hover {
      color: var(--text);
    }
    .mode-btn.active {
      background: var(--accent);
      color: #06202b;
    }
    #feed-view {
      flex: 1 1 0%;
      min-height: 0;
      overflow-y: auto;
      display: none;
      flex-direction: column;
      background: radial-gradient(circle at 50% 0%, #131e3a 0%, var(--bg) 55%);
    }
    .feed-toolbar {
      position: sticky;
      top: 0;
      z-index: 15;
      background: rgba(17, 25, 46, 0.92);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 9px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 12.5px;
    }
    .feed-toolbar-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .feed-pill-btn {
      background: var(--panel-alt);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .feed-pill-btn.active {
      background: rgba(56, 189, 248, 0.18);
      color: #bae6fd;
      border-color: #0284c7;
    }
    #feed-search {
      background: #0b1020;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12.5px;
      min-width: 220px;
    }
    .feed-stream {
      width: 100%;
      max-width: 940px;
      margin: 0 auto;
      padding: 24px 20px 64px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .feed-post {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px 22px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
    }
    .feed-post-meta {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .feed-author-block {
      display: flex;
      align-items: center;
      gap: 11px;
    }
    .feed-avatar {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.24), rgba(167, 139, 250, 0.22));
      border: 1px solid rgba(56, 189, 248, 0.45);
      color: #e0f2fe;
      font-weight: 700;
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .feed-meta-title {
      font-size: 12.5px;
      font-weight: 600;
      color: #cbd5e1;
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
    }
    .feed-meta-sub {
      font-size: 11.5px;
      color: var(--muted);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .feed-source-pill {
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 8px;
      border-radius: 999px;
      background: #0b1020;
      border: 1px solid #38bdf8;
      color: #bae6fd;
    }
    .feed-actions {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .feed-action-btn {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .feed-action-btn.primary {
      background: rgba(56, 189, 248, 0.16);
      border-color: #0284c7;
      color: #bae6fd;
    }
    .feed-post-title {
      margin: 0;
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #f8fafc;
    }
    .feed-post-summary {
      margin: 0;
      font-size: 14px;
      line-height: 1.58;
      color: #cbd5e1;
    }
    .feed-figure {
      margin: 2px 0 0;
      background: radial-gradient(circle at top left, #15213e 0%, #0b1020 75%);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .feed-svg-wrap {
      width: 100%;
      height: clamp(220px, 42vw, 310px);
      position: relative;
      cursor: pointer;
    }
    .feed-svg-wrap svg {
      position: static;
      width: 100%;
      height: 100%;
      display: block;
    }
    .feed-figure-caption {
      padding: 8px 14px;
      background: rgba(11, 16, 32, 0.85);
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 11.5px;
      color: var(--muted);
    }
    .feed-delta-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      font-weight: 600;
    }
    .feed-highlights {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding-top: 2px;
    }
    .feed-chip {
      font-size: 11.5px;
      padding: 3px 9px;
      border-radius: 7px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      color: #cbd5e1;
    }
    .feed-chip.add { border-color: rgba(34, 197, 94, 0.45); color: #86efac; background: rgba(34, 197, 94, 0.1); }
    .feed-chip.mod { border-color: rgba(245, 158, 11, 0.45); color: #fde68a; background: rgba(245, 158, 11, 0.1); }
    .feed-chip.del { border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; background: rgba(239, 68, 68, 0.1); }
    .feed-chip.adr { border-color: rgba(56, 189, 248, 0.45); color: #bae6fd; background: rgba(56, 189, 248, 0.12); }
    .feed-empty {
      text-align: center;
      padding: 48px 20px;
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 14px;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <h1>${safeTitle}</h1>
      <div class="mode-switch" role="tablist" aria-label="View mode">
        <button id="btn-mode-stage" type="button" class="mode-btn active" role="tab" aria-selected="true">▶ Timelapse Stage</button>
        <button id="btn-mode-feed" type="button" class="mode-btn" role="tab" aria-selected="false">☰ Architecture Feed</button>
      </div>
    </div>
    <div class="meta-badges">
      <span class="badge" id="badge-moments">0 moments</span>
      <span class="badge" id="badge-sources" style="display:none;"></span>
      <span class="badge badge-funnel" id="badge-funnel"${funnelText ? '' : ' style="display:none;"'}>${escapeHtml(funnelText)}</span>
      <span class="badge" id="badge-engine">engine: ${escapeHtml(payload.engine)}</span>
      <span class="badge" id="badge-keys">Keys: Space Play/Pause · ←/→ Step</span>
    </div>
  </header>

  <main id="stage-view">
    <section class="stage">
      <div class="stage-toolbar">
        <div class="toolbar-group" id="project-filter-group" style="display:none;">
          <label for="project-select">Project:</label>
          <select id="project-select" title="Filter by source repository or architecture">
            <option value="">All Projects (Synchronized)</option>
          </select>
        </div>
        <div class="toolbar-sep" id="project-filter-sep" style="display:none;"></div>
        <div class="toolbar-group">
          <label for="focus-select">Subsystem:</label>
          <select id="focus-select" title="Focus on a node and its 1-hop subsystem">
            <option value="">All Subsystems (Full View)</option>
          </select>
          <label style="cursor:pointer;">
            <input id="focus-isolate" type="checkbox" /> 1-hop only
          </label>
          <button id="btn-reset-focus" type="button">Reset</button>
        </div>
        <div class="toolbar-sep"></div>
        <div class="toolbar-group">
          <label for="as-of-date">As-Of Date:</label>
          <input id="as-of-date" type="date" title="Query authoritative architecture in effect on a specific date" />
          <label for="compare-select">Compare:</label>
          <select id="compare-select" title="Compute live structural diff from a baseline moment">
            <option value="">Previous Moment (Step Delta)</option>
          </select>
          <button id="btn-reset-compare" type="button">Reset Diff</button>
        </div>
      </div>
      <div id="as-of-banner" class="audit-banner" style="display:none;"></div>

      <div class="canvas-wrap" id="canvas-wrap">
        <div class="canvas-overlay-top">
          <div class="legend">
            <span><i class="dot" style="background:var(--added)"></i>Added</span>
            <span><i class="dot" style="background:var(--modified)"></i>Modified</span>
            <span><i class="dot" style="background:var(--removed)"></i>Removed</span>
          </div>
          <span class="canvas-hint">Click node to inspect · Wheel/Drag to zoom &amp; pan</span>
        </div>
        <svg id="graph" viewBox="0 0 ${payload.canvasWidth} ${payload.canvasHeight}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-normal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
            </marker>
            <marker id="arrow-added" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#22c55e" />
            </marker>
            <marker id="arrow-modified" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#f59e0b" />
            </marker>
            <marker id="arrow-removed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#ef4444" />
            </marker>
          </defs>
          <g id="viewport-layer">
            <g id="edges-layer"></g>
            <g id="nodes-layer"></g>
          </g>
        </svg>
        <div class="zoom-controls">
          <button id="btn-zoom-in" type="button" title="Zoom In">+</button>
          <button id="btn-zoom-out" type="button" title="Zoom Out">-</button>
          <button id="btn-zoom-fit" type="button" title="Fit Graph">Fit</button>
        </div>
      </div>

      <div class="controls" id="playback-bar">
        <div class="transport-btns">
          <button id="btn-prev" title="Previous Moment (←)">← Prev</button>
          <button id="btn-play" class="primary" title="Play / Pause (Space)">▶ Play</button>
          <button id="btn-next" title="Next Moment (→)">Next →</button>
        </div>
        <div class="scrubber-wrap">
          <input id="scrubber" type="range" min="0" max="0" value="0" />
          <span class="scrubber-label" id="scrubber-label"></span>
        </div>
        <span id="frame-counter" style="font-size:12.5px;min-width:52px;text-align:right;font-variant-numeric:tabular-nums;">0 / 0</span>
        <select id="speed-select" title="Playback speed">
          <option value="2200">0.7x</option>
          <option value="1500" selected>1x</option>
          <option value="900">1.5x</option>
          <option value="500">3x</option>
        </select>
      </div>
    </section>

    <aside>
      <div class="moment-header">
        <h2 id="moment-title">Loading...</h2>
        <div class="moment-date" id="moment-date"></div>
      </div>

      <div class="card" id="node-inspector" style="display:none;">
        <h3>Subsystem Inspector</h3>
        <div id="node-inspector-body" style="font-size:13px;line-height:1.45;"></div>
      </div>

      <div class="card" id="governance-card">
        <h3>Governance &amp; Compliance Posture</h3>
        <div id="governance-body" style="font-size:13px;line-height:1.45;"></div>
      </div>

      <div class="card">
        <h3>Architectural Summary</h3>
        <div id="moment-desc" style="font-size:13px;line-height:1.45;"></div>
      </div>

      <div class="card">
        <h3>What Changed &amp; Why</h3>
        <ul class="change-list" id="change-list"></ul>
      </div>

      <div class="card">
        <h3>Git Commits &amp; ADRs</h3>
        <ul class="commit-list" id="commit-list"></ul>
      </div>
    </aside>
  </main>

  <section id="feed-view" aria-label="Architecture Evolution Feed">
    <div class="feed-toolbar">
      <div class="feed-toolbar-group">
        <strong id="feed-count" style="color:#f1f5f9;">0 posts</strong>
        <span style="color:var(--border);">|</span>
        <button id="btn-feed-latest" type="button" class="feed-pill-btn active">Latest First (N → 1)</button>
        <button id="btn-feed-story" type="button" class="feed-pill-btn">Story Order (1 → N)</button>
      </div>
      <div class="feed-toolbar-group">
        <label id="feed-project-wrap" style="display:none;color:var(--muted);align-items:center;gap:6px;">
          Project:
          <select id="feed-project-select" title="Filter feed posts by project">
            <option value="">All Projects</option>
          </select>
        </label>
        <input id="feed-search" type="search" placeholder="Filter posts by node, ADR, control, commit..." />
      </div>
    </div>
    <div class="feed-stream" id="feed-stream"></div>
  </section>

  <script id="timelapse-data" type="application/json">${serializedPayload}</script>
  <script>
    (function () {
      const payload = JSON.parse(document.getElementById('timelapse-data').textContent);
      const frames = payload.frames || [];
      const positions = payload.positions || {};
      const sources = payload.sources || [];
      const isMultiSource = sources.length > 1;
      const sourcePalette = ['#38bdf8', '#a78bfa', '#2dd4bf', '#fb7185', '#818cf8', '#22d3ee'];
      const sourceColorMap = new Map();
      sources.forEach((src, idx) => {
        sourceColorMap.set(src.sourceId, sourcePalette[idx % sourcePalette.length]);
      });
      const canvasWidth = payload.canvasWidth || 960;
      const canvasHeight = payload.canvasHeight || 540;

      const canvasWrap = document.getElementById('canvas-wrap');
      const svgGraph = document.getElementById('graph');
      const viewportLayer = document.getElementById('viewport-layer');
      const svgEdges = document.getElementById('edges-layer');
      const svgNodes = document.getElementById('nodes-layer');
      const scrubber = document.getElementById('scrubber');
      const scrubberLabel = document.getElementById('scrubber-label');
      const counter = document.getElementById('frame-counter');
      const btnPlay = document.getElementById('btn-play');
      const btnPrev = document.getElementById('btn-prev');
      const btnNext = document.getElementById('btn-next');
      const speedSelect = document.getElementById('speed-select');
      const badgeMoments = document.getElementById('badge-moments');
      const badgeSources = document.getElementById('badge-sources');
      const badgeFunnel = document.getElementById('badge-funnel');
      const badgeKeys = document.getElementById('badge-keys');

      const stageView = document.getElementById('stage-view');
      const feedView = document.getElementById('feed-view');
      const btnModeStage = document.getElementById('btn-mode-stage');
      const btnModeFeed = document.getElementById('btn-mode-feed');
      const feedCount = document.getElementById('feed-count');
      const btnFeedStory = document.getElementById('btn-feed-story');
      const btnFeedLatest = document.getElementById('btn-feed-latest');
      const feedProjectWrap = document.getElementById('feed-project-wrap');
      const feedProjectSelect = document.getElementById('feed-project-select');
      const feedSearch = document.getElementById('feed-search');
      const feedStream = document.getElementById('feed-stream');

      const btnZoomIn = document.getElementById('btn-zoom-in');
      const btnZoomOut = document.getElementById('btn-zoom-out');
      const btnZoomFit = document.getElementById('btn-zoom-fit');

      const momentTitle = document.getElementById('moment-title');
      const momentDate = document.getElementById('moment-date');
      const momentDesc = document.getElementById('moment-desc');
      const changeList = document.getElementById('change-list');
      const commitList = document.getElementById('commit-list');
      const projectFilterGroup = document.getElementById('project-filter-group');
      const projectFilterSep = document.getElementById('project-filter-sep');
      const projectSelect = document.getElementById('project-select');
      const focusSelect = document.getElementById('focus-select');
      const focusIsolate = document.getElementById('focus-isolate');
      const btnResetFocus = document.getElementById('btn-reset-focus');
      const nodeInspector = document.getElementById('node-inspector');
      const nodeInspectorBody = document.getElementById('node-inspector-body');
      const governanceBody = document.getElementById('governance-body');
      const asOfDateInput = document.getElementById('as-of-date');
      const asOfBanner = document.getElementById('as-of-banner');
      const compareSelect = document.getElementById('compare-select');
      const btnResetCompare = document.getElementById('btn-reset-compare');

      badgeMoments.textContent = frames.length + ' moment' + (frames.length === 1 ? '' : 's');
      scrubber.max = String(Math.max(0, frames.length - 1));

      if (isMultiSource) {
        const repoSet = new Set(sources.map((s) => s.repoName).filter(Boolean));
        if (badgeSources) {
          badgeSources.textContent =
            sources.length +
            ' architectures' +
            (repoSet.size > 1 ? ' · ' + repoSet.size + ' repos' : '');
          badgeSources.style.display = 'inline-block';
        }
        if (projectFilterGroup) projectFilterGroup.style.display = 'flex';
        if (projectFilterSep) projectFilterSep.style.display = 'block';
        if (projectSelect) {
          sources.forEach((src) => {
            const opt = document.createElement('option');
            opt.value = src.sourceId;
            opt.textContent = src.sourceLabel;
            projectSelect.appendChild(opt);
          });
        }
        if (feedProjectWrap) feedProjectWrap.style.display = 'inline-flex';
        if (feedProjectSelect) {
          sources.forEach((src) => {
            const opt = document.createElement('option');
            opt.value = src.sourceId;
            opt.textContent = src.sourceLabel;
            feedProjectSelect.appendChild(opt);
          });
        }
      }

      if (badgeFunnel && !badgeFunnel.textContent) {
        const totalSum = frames.reduce((acc, f) => acc + (f.commitCount || 0), 0);
        if (payload.stats && payload.stats.totalCommitsScanned !== undefined) {
          const scanned = payload.stats.totalCommitsScanned;
          const noise = payload.stats.noiseCommitsFiltered || 0;
          const moments = payload.stats.momentsGenerated || frames.length;
          badgeFunnel.textContent = scanned + ' commits -> ' + noise + ' noise filtered -> ' + moments + ' moments';
          badgeFunnel.style.display = 'inline-block';
        } else if (totalSum > frames.length) {
          badgeFunnel.textContent = totalSum + ' commits -> ' + frames.length + ' moments';
          badgeFunnel.style.display = 'inline-block';
        }
      }

      let currentIndex = 0;
      let timer = null;
      let focusedNodeId = '';
      let selectedProjectId = '';
      let viewW = canvasWidth;
      let viewH = canvasHeight;
      let zoomScale = 1;
      let panX = 0;
      let panY = 0;
      let autoFit = true;
      let hasInitialFit = false;
      let isPanning = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let panStartX = 0;
      let panStartY = 0;
      let auditPrecedesFirst = false;

      function nodeMatchesProject(nodeOrPos) {
        if (!selectedProjectId) return true;
        if (!nodeOrPos) return false;
        if (Array.isArray(nodeOrPos.sourceIds) && nodeOrPos.sourceIds.includes(selectedProjectId)) {
          return true;
        }
        return nodeOrPos.sourceId === selectedProjectId;
      }

      function syncSvgViewBox() {
        if (!canvasWrap || typeof canvasWrap.getBoundingClientRect !== 'function') return;
        const rect = canvasWrap.getBoundingClientRect();
        if (rect && rect.width >= 120 && rect.height >= 120) {
          viewW = Math.round(rect.width);
          viewH = Math.round(rect.height);
          svgGraph.setAttribute('viewBox', '0 0 ' + viewW + ' ' + viewH);
        }
      }

      function applyTransform(animate) {
        if (viewportLayer && viewportLayer.classList) {
          viewportLayer.classList.toggle('smooth-cam', Boolean(animate));
        }
        viewportLayer.setAttribute(
          'transform',
          'translate(' + panX.toFixed(2) + ',' + panY.toFixed(2) + ') scale(' + zoomScale.toFixed(4) + ')',
        );
      }

      function computeActiveFrameBounds() {
        const frame = frames[currentIndex];
        const isolateMode = Boolean(focusIsolate && focusIsolate.checked);
        const ids = [];
        if (frame) {
          const neighborhood = new Set();
          if (focusedNodeId) {
            neighborhood.add(focusedNodeId);
            for (const edge of frame.edges || []) {
              if (edge.source === focusedNodeId) neighborhood.add(edge.target);
              if (edge.target === focusedNodeId) neighborhood.add(edge.source);
            }
          }
          const candidateIds = new Set([
            ...(frame.nodes || []).map((n) => n.id),
            ...(frame.removedNodeIds || []),
          ]);
          for (const id of candidateIds) {
            const p = positions[id];
            if (!p) continue;
            if (focusedNodeId && isolateMode && !neighborhood.has(id)) continue;
            if (selectedProjectId && !nodeMatchesProject(p)) continue;
            ids.push(id);
          }
        }
        const useIds = ids.length > 0 ? ids : Object.keys(positions);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const id of useIds) {
          const p = positions[id];
          if (!p) continue;
          if (p.x - 94 < minX) minX = p.x - 94;
          if (p.y - 46 < minY) minY = p.y - 46;
          if (p.x + 94 > maxX) maxX = p.x + 94;
          if (p.y + 40 > maxY) maxY = p.y + 40;
        }
        if (!Number.isFinite(minX)) {
          return { minX: 0, minY: 0, maxX: canvasWidth, maxY: canvasHeight };
        }
        return { minX, minY, maxX, maxY };
      }

      function fitCurrentFrame(animate) {
        syncSvgViewBox();
        const bounds = computeActiveFrameBounds();
        const padX = Math.min(28, Math.round(viewW * 0.045));
        const padTop = Math.min(48, Math.max(36, Math.round(viewH * 0.09)));
        const padBottom = Math.min(44, Math.max(24, Math.round(viewH * 0.07)));
        const availW = Math.max(100, viewW - padX * 2);
        const availH = Math.max(100, viewH - padTop - padBottom);
        const bw = Math.max(200, bounds.maxX - bounds.minX);
        const bh = Math.max(96, bounds.maxY - bounds.minY);
        const scale = Math.max(0.12, Math.min(availW / bw, availH / bh, 1.32));
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        zoomScale = scale;
        panX = viewW / 2 - cx * scale;
        panY = padTop + availH / 2 - cy * scale;
        applyTransform(animate && hasInitialFit);
        hasInitialFit = true;
      }

      function setZoom(nextScale, anchorX, anchorY) {
        autoFit = false;
        syncSvgViewBox();
        const clamped = Math.max(0.10, Math.min(3.2, nextScale));
        const ax = anchorX !== undefined ? anchorX : viewW / 2;
        const ay = anchorY !== undefined ? anchorY : viewH / 2;
        const ratio = clamped / zoomScale;
        panX = ax - (ax - panX) * ratio;
        panY = ay - (ay - panY) * ratio;
        zoomScale = clamped;
        applyTransform(false);
      }

      function resetZoom() {
        autoFit = true;
        fitCurrentFrame(true);
      }

      Object.values(positions)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((pos) => {
          const opt = document.createElement('option');
          opt.value = pos.id;
          const srcPrefix = isMultiSource && pos.sourceLabel ? ' [' + pos.sourceLabel + ']' : '';
          opt.textContent = pos.name + srcPrefix + ' (' + pos.nodeType + ')';
          focusSelect.appendChild(opt);
        });

      frames.forEach((f, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        const dateStr = String(f.validFrom || '').slice(0, 10);
        opt.textContent = 'Moment ' + (idx + 1) + ': ' + f.name + (dateStr ? ' (' + dateStr + ')' : '');
        compareSelect.appendChild(opt);
      });

      function setFocusNode(nodeId) {
        focusedNodeId = nodeId || '';
        focusSelect.value = focusedNodeId;
        renderFrame(currentIndex);
      }

      function createSvgEl(tag, attrs) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) {
          el.setAttribute(k, String(v));
        }
        return el;
      }

      function computeMomentDiff(baseFrame, currFrame) {
        const baseNodes = new Map((baseFrame.nodes || []).map((n) => [n.id, n]));
        const currNodes = new Map((currFrame.nodes || []).map((n) => [n.id, n]));
        const baseEdges = new Map((baseFrame.edges || []).map((e) => [e.id, e]));
        const currEdges = new Map((currFrame.edges || []).map((e) => [e.id, e]));
        const baseCtrls = new Map((baseFrame.controls || []).map((c) => [c.id, c]));
        const currCtrls = new Map((currFrame.controls || []).map((c) => [c.id, c]));

        const addedNodeIds = [];
        const modifiedNodeIds = [];
        const removedNodeIds = [];
        const addedEdgeIds = [];
        const modifiedEdgeIds = [];
        const removedEdgeIds = [];
        const items = [];

        for (const [id, node] of currNodes.entries()) {
          const prev = baseNodes.get(id);
          if (!prev) {
            addedNodeIds.push(id);
            items.push({ kind: 'add', text: 'Added node ' + node.name + ' (' + id + ')' });
          } else if (
            prev.name !== node.name ||
            prev.nodeType !== node.nodeType ||
            (prev.description || '') !== (node.description || '') ||
            (prev.controlCount || 0) !== (node.controlCount || 0)
          ) {
            modifiedNodeIds.push(id);
            items.push({ kind: 'mod', text: 'Modified node ' + node.name + ' (' + id + ')' });
          }
        }
        for (const [id, node] of baseNodes.entries()) {
          if (!currNodes.has(id)) {
            removedNodeIds.push(id);
            items.push({ kind: 'del', text: 'Removed node ' + node.name + ' (' + id + ')' });
          }
        }

        for (const [id, edge] of currEdges.entries()) {
          const prev = baseEdges.get(id);
          if (!prev) {
            addedEdgeIds.push(id);
            items.push({ kind: 'add', text: 'Added relationship ' + id + ' (' + edge.source + ' -> ' + edge.target + ')' });
          } else if (
            prev.source !== edge.source ||
            prev.target !== edge.target ||
            prev.label !== edge.label ||
            prev.relType !== edge.relType
          ) {
            modifiedEdgeIds.push(id);
            items.push({ kind: 'mod', text: 'Modified relationship ' + id });
          }
        }
        for (const [id, edge] of baseEdges.entries()) {
          if (!currEdges.has(id)) {
            removedEdgeIds.push(id);
            items.push({ kind: 'del', text: 'Removed relationship ' + id + ' (' + edge.source + ' -> ' + edge.target + ')' });
          }
        }

        for (const [id, ctrl] of currCtrls.entries()) {
          const prev = baseCtrls.get(id);
          if (!prev) {
            items.push({ kind: 'add', text: 'Added control ' + id + (ctrl.description ? ' — ' + ctrl.description : '') });
          } else if (
            prev.description !== ctrl.description ||
            prev.requirementCount !== ctrl.requirementCount
          ) {
            items.push({ kind: 'mod', text: 'Modified control ' + id });
          }
        }
        for (const [id] of baseCtrls.entries()) {
          if (!currCtrls.has(id)) {
            items.push({ kind: 'del', text: 'Removed control ' + id });
          }
        }

        return {
          addedNodeIds,
          modifiedNodeIds,
          removedNodeIds,
          addedEdgeIds,
          modifiedEdgeIds,
          removedEdgeIds,
          items,
          baseNodes,
        };
      }

      function renderGovernancePosture(index, frame) {
        governanceBody.innerHTML = '';

        const validDiv = document.createElement('div');
        const validLabel = document.createElement('strong');
        validLabel.textContent = 'Effective Valid-From: ';
        const validVal = document.createElement('code');
        validVal.textContent = frame.validFrom
          ? String(frame.validFrom)
          : 'unspecified (omitted in manual timeline)';
        validDiv.appendChild(validLabel);
        validDiv.appendChild(validVal);
        governanceBody.appendChild(validDiv);

        if (auditPrecedesFirst) {
          const warnDiv = document.createElement('div');
          warnDiv.style.color = '#fde68a';
          warnDiv.style.fontSize = '12px';
          warnDiv.style.marginTop = '4px';
          warnDiv.textContent = frames[0] && !frames[0].validFrom
            ? 'Moment 1 omits valid-from in this manual timeline; effective start date cannot be verified.'
            : 'Queried audit date precedes Moment 1; showing earliest recorded posture.';
          governanceBody.appendChild(warnDiv);
        }

        const ctrlSec = document.createElement('div');
        ctrlSec.className = 'gov-section';
        const ctrls = frame.controls || [];
        const ctrlHeader = document.createElement('div');
        ctrlHeader.className = 'gov-label';
        ctrlHeader.textContent = 'Active CALM Controls (' + ctrls.length + ')';
        ctrlSec.appendChild(ctrlHeader);

        if (ctrls.length === 0) {
          const emptyCtrl = document.createElement('div');
          emptyCtrl.style.color = '#93a4c7';
          emptyCtrl.style.fontSize = '12px';
          emptyCtrl.textContent = 'No active CALM controls in this moment.';
          ctrlSec.appendChild(emptyCtrl);
        } else {
          const ul = document.createElement('ul');
          ul.className = 'governance-list';
          for (const ctrl of ctrls) {
            const li = document.createElement('li');
            const code = document.createElement('code');
            code.textContent = ctrl.id;
            li.appendChild(code);
            if (ctrl.requirementCount > 0) {
              const reqTag = document.createElement('span');
              reqTag.className = 'tag tag-info';
              reqTag.style.marginLeft = '6px';
              reqTag.textContent = ctrl.requirementCount + ' req';
              li.appendChild(reqTag);
            }
            if (ctrl.description) {
              const descSpan = document.createElement('div');
              descSpan.style.color = '#cbd5e1';
              descSpan.style.fontSize = '12px';
              descSpan.textContent = ctrl.description;
              li.appendChild(descSpan);
            }
            ul.appendChild(li);
          }
          ctrlSec.appendChild(ul);
        }
        governanceBody.appendChild(ctrlSec);

        const adrSet = new Set();
        for (let k = 0; k <= index; k++) {
          for (const adr of frames[k].adrs || []) {
            if (adr) adrSet.add(adr);
          }
        }
        const adrSec = document.createElement('div');
        adrSec.className = 'gov-section';
        const adrHeader = document.createElement('div');
        adrHeader.className = 'gov-label';
        adrHeader.textContent = 'Cumulative ADRs in Effect (' + adrSet.size + ')';
        adrSec.appendChild(adrHeader);

        if (adrSet.size === 0) {
          const emptyAdr = document.createElement('div');
          emptyAdr.style.color = '#93a4c7';
          emptyAdr.style.fontSize = '12px';
          emptyAdr.textContent = 'No ADRs recorded up to this moment.';
          adrSec.appendChild(emptyAdr);
        } else {
          const ul = document.createElement('ul');
          ul.className = 'governance-list';
          for (const adr of adrSet) {
            const li = document.createElement('li');
            const tag = document.createElement('span');
            tag.className = 'tag tag-added';
            tag.textContent = 'ADR';
            li.appendChild(tag);
            li.appendChild(document.createTextNode(adr));
            ul.appendChild(li);
          }
          adrSec.appendChild(ul);
        }
        governanceBody.appendChild(adrSec);

        const activeFlows = frame.flows || [];
        if (activeFlows.length > 0) {
          const flowSec = document.createElement('div');
          flowSec.className = 'gov-section';
          const flowHeader = document.createElement('div');
          flowHeader.className = 'gov-label';
          flowHeader.textContent = 'Active CALM Flows (' + activeFlows.length + ')';
          flowSec.appendChild(flowHeader);

          const ul = document.createElement('ul');
          ul.className = 'governance-list';
          for (const fl of activeFlows) {
            const li = document.createElement('li');
            const titleStrong = document.createElement('strong');
            titleStrong.style.color = '#e2e8f0';
            titleStrong.textContent = fl.name;
            li.appendChild(titleStrong);
            if (fl.transitionCount > 0) {
              const stepTag = document.createElement('span');
              stepTag.className = 'tag tag-info';
              stepTag.style.marginLeft = '6px';
              stepTag.textContent = fl.transitionCount + ' steps';
              li.appendChild(stepTag);
            }
            if (Array.isArray(fl.intents) && fl.intents.length > 0) {
              const intentLine = document.createElement('div');
              intentLine.style.color = '#5eead4';
              intentLine.style.fontSize = '11.5px';
              intentLine.textContent =
                'FDC3 Intents: ' +
                fl.intents.join(', ') +
                (Array.isArray(fl.contexts) && fl.contexts.length > 0
                  ? ' · Contexts: ' + fl.contexts.join(', ')
                  : '');
              li.appendChild(intentLine);
            }
            if (fl.description) {
              const descDiv = document.createElement('div');
              descDiv.style.color = '#cbd5e1';
              descDiv.style.fontSize = '12px';
              descDiv.textContent = fl.description;
              li.appendChild(descDiv);
            }
            ul.appendChild(li);
          }
          flowSec.appendChild(ul);
          governanceBody.appendChild(flowSec);
        }
      }

      function renderFrame(index) {
        if (frames.length === 0) return;
        currentIndex = Math.max(0, Math.min(index, frames.length - 1));
        const frame = frames[currentIndex];
        scrubber.value = String(currentIndex);
        counter.textContent = (currentIndex + 1) + ' / ' + frames.length;

        momentTitle.textContent = frame.name;
        const shortIsoDate = String(frame.validFrom || '').slice(0, 10);
        if (scrubberLabel) {
          scrubberLabel.textContent = (shortIsoDate ? shortIsoDate + ' · ' : '') + frame.name;
          scrubberLabel.title = frame.name;
        }
        const parsedDate = Date.parse(frame.validFrom);
        const dateDisplay = Number.isFinite(parsedDate)
          ? new Date(parsedDate).toUTCString()
          : (frame.validFrom ? String(frame.validFrom) : 'No valid-from date');
        const provenanceSuffix = frame.commitCount > 0
          ? frame.commitCount + ' commit(s)'
          : 'manual snapshot';
        momentDate.textContent = dateDisplay + ' · ' + provenanceSuffix;
        momentDesc.textContent = frame.description || frame.summary;

        svgEdges.innerHTML = '';
        svgNodes.innerHTML = '';

        const compareIdxRaw = compareSelect.value;
        const isCompareMode = compareIdxRaw !== '' && frames[Number(compareIdxRaw)] !== undefined;
        const compareBase = isCompareMode ? frames[Number(compareIdxRaw)] : null;
        const liveDiff = compareBase ? computeMomentDiff(compareBase, frame) : null;

        const addedNodes = new Set(liveDiff ? liveDiff.addedNodeIds : (frame.addedNodeIds || []));
        const modifiedNodes = new Set(liveDiff ? liveDiff.modifiedNodeIds : (frame.modifiedNodeIds || []));
        const removedNodes = new Set(liveDiff ? liveDiff.removedNodeIds : (frame.removedNodeIds || []));
        const addedEdges = new Set(liveDiff ? liveDiff.addedEdgeIds : (frame.addedEdgeIds || []));
        const modifiedEdges = new Set(liveDiff ? liveDiff.modifiedEdgeIds : (frame.modifiedEdgeIds || []));

        const isolateMode = Boolean(focusIsolate && focusIsolate.checked);
        const neighborhood = new Set();
        const incomingEdges = [];
        const outgoingEdges = [];
        if (focusedNodeId) {
          neighborhood.add(focusedNodeId);
          for (const edge of frame.edges || []) {
            if (edge.source === focusedNodeId) {
              neighborhood.add(edge.target);
              outgoingEdges.push(edge);
            }
            if (edge.target === focusedNodeId) {
              neighborhood.add(edge.source);
              incomingEdges.push(edge);
            }
          }
        }

        if (focusedNodeId && positions[focusedNodeId]) {
          const fNode = (frame.nodes || []).find((n) => n.id === focusedNodeId) || positions[focusedNodeId];
          const inList = incomingEdges.map((e) => (positions[e.source]?.name || e.source) + ' (' + e.label + ')').join(', ') || 'none';
          const outList = outgoingEdges.map((e) => (positions[e.target]?.name || e.target) + ' (' + e.label + ')').join(', ') || 'none';
          nodeInspector.style.display = 'block';
          nodeInspectorBody.innerHTML = '';
          const p1 = document.createElement('div');
          const strong = document.createElement('strong');
          strong.textContent = fNode.name + ' ';
          const code = document.createElement('code');
          code.textContent = fNode.id;
          p1.appendChild(strong);
          p1.appendChild(code);
          nodeInspectorBody.appendChild(p1);
          if (fNode.sourceLabel || positions[focusedNodeId].sourceLabel) {
            const labels = fNode.sourceLabels || positions[focusedNodeId].sourceLabels || [fNode.sourceLabel || positions[focusedNodeId].sourceLabel];
            const isMerged = Boolean(fNode.mergedViaDetailedArch || positions[focusedNodeId].mergedViaDetailedArch);
            const pSrc = document.createElement('div');
            pSrc.style.color = '#38bdf8';
            pSrc.style.margin = '4px 0 2px';
            pSrc.textContent =
              'Source: ' +
              labels.join(' + ') +
              (isMerged ? ' (merged via detailed-architecture)' : '');
            nodeInspectorBody.appendChild(pSrc);
          }
          const p2 = document.createElement('div');
          p2.style.color = '#93a4c7';
          p2.style.margin = '4px 0';
          p2.textContent = 'Type: ' + fNode.nodeType + (fNode.description ? ' — ' + fNode.description : '');
          const p3 = document.createElement('div');
          p3.textContent = 'Upstream: ' + inList;
          const p4 = document.createElement('div');
          p4.textContent = 'Downstream: ' + outList;
          nodeInspectorBody.appendChild(p2);
          nodeInspectorBody.appendChild(p3);
          nodeInspectorBody.appendChild(p4);
          if (Array.isArray(fNode.interfaces) && fNode.interfaces.length > 0) {
            const pIfaces = document.createElement('div');
            pIfaces.style.marginTop = '6px';
            pIfaces.style.color = '#5eead4';
            pIfaces.textContent =
              'CALM Interfaces (' +
              fNode.interfaces.length +
              '): ' +
              fNode.interfaces.map((it) => it.id + ' (' + it.summary + ')').join(' | ');
            nodeInspectorBody.appendChild(pIfaces);
          }
        } else {
          nodeInspector.style.display = 'none';
        }

        renderGovernancePosture(currentIndex, frame);

        drawGraphScene({
          edgesContainer: svgEdges,
          nodesContainer: svgNodes,
          frame,
          addedNodes,
          modifiedNodes,
          removedNodes,
          addedEdges,
          modifiedEdges,
          fallbackBaseNodes: liveDiff ? liveDiff.baseNodes : null,
          focusedId: focusedNodeId,
          neighborhoodSet: neighborhood,
          projectFilterId: selectedProjectId,
          isolate: isolateMode,
          markerPrefix: '',
          onNodeClick: (clickedId) => {
            setFocusNode(focusedNodeId === clickedId ? '' : clickedId);
          },
        });

        if (autoFit) {
          fitCurrentFrame(true);
        }

        changeList.innerHTML = '';
        if (liveDiff && compareBase) {
          const bannerLi = document.createElement('li');
          bannerLi.className = 'compare-banner';
          bannerLi.textContent = 'Comparing: ' + compareBase.name + ' -> ' + frame.name;
          changeList.appendChild(bannerLi);

          if (liveDiff.items.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No structural differences between selected moments.';
            changeList.appendChild(li);
          } else {
            const kindLabelMap = { add: 'added', mod: 'modified', del: 'removed' };
            for (const ch of liveDiff.items) {
              const kindLabel = kindLabelMap[ch.kind] || 'modified';
              const li = document.createElement('li');
              const tag = document.createElement('span');
              tag.className = 'tag tag-' + kindLabel;
              tag.textContent = kindLabel;
              li.appendChild(tag);
              li.appendChild(document.createTextNode(ch.text));
              changeList.appendChild(li);
            }
          }
        } else {
          const changes = frame.changes || [];
          if (changes.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No structural diff recorded.';
            changeList.appendChild(li);
          } else {
            const kindLabelMap = { add: 'added', mod: 'modified', del: 'removed' };
            for (const ch of changes) {
              const kindLabel = kindLabelMap[ch.kind] || 'modified';
              const li = document.createElement('li');
              const tag = document.createElement('span');
              tag.className = 'tag tag-' + kindLabel;
              tag.textContent = kindLabel;
              li.appendChild(tag);
              li.appendChild(document.createTextNode(ch.text));
              changeList.appendChild(li);
            }
          }
        }

        commitList.innerHTML = '';
        const msgs = frame.commitMessages || [];
        const commitHashes = frame.commits || [];
        const frameAdrs = frame.adrs || [];
        commitHashes.forEach((hash, idx) => {
          const li = document.createElement('li');
          const code = document.createElement('code');
          code.textContent = hash;
          li.appendChild(code);
          li.appendChild(document.createTextNode(' ' + (msgs[idx] || '')));
          commitList.appendChild(li);
        });
        for (const adr of frameAdrs) {
          const li = document.createElement('li');
          const tag = document.createElement('span');
          tag.className = 'tag tag-added';
          tag.textContent = 'ADR';
          li.appendChild(tag);
          li.appendChild(document.createTextNode(adr));
          commitList.appendChild(li);
        }
        if (commitHashes.length === 0 && frameAdrs.length === 0) {
          const li = document.createElement('li');
          li.style.color = '#93a4c7';
          li.textContent = 'No Git commit SHAs or ADRs linked (manual timeline moment).';
          commitList.appendChild(li);
        }
      }

      function stopPlayback() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        btnPlay.textContent = '▶ Play';
      }

      function startPlayback() {
        stopPlayback();
        if (frames.length <= 1) return;
        if (currentIndex >= frames.length - 1) {
          renderFrame(0);
        }
        btnPlay.textContent = '⏸ Pause';
        const intervalMs = Number(speedSelect.value) || 1500;
        timer = setInterval(() => {
          if (currentIndex >= frames.length - 1) {
            stopPlayback();
          } else {
            renderFrame(currentIndex + 1);
          }
        }, intervalMs);
      }

      function clientToSvgPoint(clientX, clientY) {
        if (svgGraph.createSVGPoint && svgGraph.getScreenCTM) {
          const ctm = svgGraph.getScreenCTM();
          if (ctm) {
            const pt = svgGraph.createSVGPoint();
            pt.x = clientX;
            pt.y = clientY;
            const mapped = pt.matrixTransform(ctm.inverse());
            return { x: mapped.x, y: mapped.y, scaleX: 1 / (ctm.a || 1), scaleY: 1 / (ctm.d || 1) };
          }
        }
        const rect = svgGraph.getBoundingClientRect();
        const scaleX = viewW / (rect.width || 1);
        const scaleY = viewH / (rect.height || 1);
        return {
          x: (clientX - rect.left) * scaleX,
          y: (clientY - rect.top) * scaleY,
          scaleX,
          scaleY,
        };
      }

      svgGraph.addEventListener('wheel', (e) => {
        e.preventDefault();
        const pt = clientToSvgPoint(e.clientX, e.clientY);
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setZoom(zoomScale * factor, pt.x, pt.y);
      }, { passive: false });

      svgGraph.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('.node-group')) {
          return;
        }
        isPanning = true;
        autoFit = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = panX;
        panStartY = panY;
        canvasWrap.classList.add('panning');
      });

      window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        const pt = clientToSvgPoint(e.clientX, e.clientY);
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        panX = panStartX + dx * pt.scaleX;
        panY = panStartY + dy * pt.scaleY;
        applyTransform(false);
      });

      window.addEventListener('mouseup', () => {
        if (!isPanning) return;
        isPanning = false;
        canvasWrap.classList.remove('panning');
      });

      btnZoomIn.addEventListener('click', () => {
        syncSvgViewBox();
        setZoom(zoomScale * 1.2, viewW / 2, viewH / 2);
      });
      btnZoomOut.addEventListener('click', () => {
        syncSvgViewBox();
        setZoom(zoomScale / 1.2, viewW / 2, viewH / 2);
      });
      btnZoomFit.addEventListener('click', () => {
        resetZoom();
      });

      asOfDateInput.addEventListener('change', () => {
        const targetDate = (asOfDateInput.value || '').trim();
        if (!targetDate) {
          auditPrecedesFirst = false;
          asOfBanner.style.display = 'none';
          renderFrame(currentIndex);
          return;
        }
        stopPlayback();
        let matchIdx = -1;
        for (let i = 0; i < frames.length; i++) {
          const fDate = String(frames[i].validFrom || '').slice(0, 10);
          if (fDate && fDate <= targetDate) {
            matchIdx = i;
          }
        }
        if (matchIdx === -1) {
          auditPrecedesFirst = true;
          const firstDate = String(frames[0]?.validFrom || '').slice(0, 10);
          asOfBanner.className = 'audit-banner warn';
          asOfBanner.textContent = firstDate
            ? 'Audit Alert: ' + targetDate + ' precedes Moment 1 (' + firstDate + '). No architecture was effective on that date.'
            : 'Audit Alert: Moment 1 omits valid-from in this manual timeline, so effective posture on ' + targetDate + ' cannot be verified.';
          asOfBanner.style.display = 'block';
          renderFrame(0);
        } else {
          auditPrecedesFirst = false;
          asOfBanner.className = 'audit-banner';
          asOfBanner.textContent =
            'Authoritative Architecture as of ' + targetDate + ': Moment ' + (matchIdx + 1) + ' — ' + frames[matchIdx].name;
          asOfBanner.style.display = 'block';
          renderFrame(matchIdx);
        }
      });

      compareSelect.addEventListener('change', () => {
        renderFrame(currentIndex);
      });
      btnResetCompare.addEventListener('click', () => {
        compareSelect.value = '';
        renderFrame(currentIndex);
      });

      btnPlay.addEventListener('click', () => {
        if (timer) stopPlayback();
        else startPlayback();
      });
      btnPrev.addEventListener('click', () => {
        stopPlayback();
        renderFrame(currentIndex - 1);
      });
      btnNext.addEventListener('click', () => {
        stopPlayback();
        renderFrame(currentIndex + 1);
      });
      scrubber.addEventListener('input', (e) => {
        stopPlayback();
        renderFrame(Number(e.target.value));
      });
      speedSelect.addEventListener('change', () => {
        if (timer) startPlayback();
      });
      if (projectSelect) {
        projectSelect.addEventListener('change', (e) => {
          selectedProjectId = e.target.value || '';
          renderFrame(currentIndex);
        });
      }
      focusSelect.addEventListener('change', (e) => {
        setFocusNode(e.target.value);
      });
      focusIsolate.addEventListener('change', () => {
        renderFrame(currentIndex);
      });
      btnResetFocus.addEventListener('click', () => {
        selectedProjectId = '';
        if (projectSelect) projectSelect.value = '';
        setFocusNode('');
      });
      function nodeMatchesSpecificProject(nodeOrPos, projId) {
        if (!projId) return true;
        if (!nodeOrPos) return false;
        if (Array.isArray(nodeOrPos.sourceIds) && nodeOrPos.sourceIds.includes(projId)) {
          return true;
        }
        return nodeOrPos.sourceId === projId;
      }

      function drawGraphScene(opts) {
        const {
          edgesContainer,
          nodesContainer,
          frame,
          addedNodes,
          modifiedNodes,
          removedNodes,
          addedEdges,
          modifiedEdges,
          fallbackBaseNodes,
          focusedId,
          neighborhoodSet,
          projectFilterId,
          isolate,
          markerPrefix,
          onNodeClick,
        } = opts;

        const nodeHalfW = 88;
        const nodeHalfH = 32;
        const activeEdges = frame.edges || [];
        const totalEdgeCount = activeEdges.length;
        const pairCounts = new Map();
        for (const e of activeEdges) {
          const key = e.source < e.target ? e.source + '::' + e.target : e.target + '::' + e.source;
          pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }
        const pairSeen = new Map();
        const mkNorm = 'url(#' + markerPrefix + 'arrow-normal)';
        const mkAdd = 'url(#' + markerPrefix + 'arrow-added)';
        const mkMod = 'url(#' + markerPrefix + 'arrow-modified)';

        for (const edge of activeEdges) {
          const src = positions[edge.source];
          const dst = positions[edge.target];
          if (!src || !dst) continue;

          const inFocus = !focusedId || edge.source === focusedId || edge.target === focusedId;
          const srcInProj = nodeMatchesSpecificProject(src, projectFilterId);
          const dstInProj = nodeMatchesSpecificProject(dst, projectFilterId);
          const inProject = !projectFilterId || (srcInProj && dstInProj);
          if (focusedId && isolate && !inFocus) continue;
          if (projectFilterId && isolate && !inProject) continue;

          const pairKey = edge.source < edge.target ? edge.source + '::' + edge.target : edge.target + '::' + edge.source;
          const pairTotal = pairCounts.get(pairKey) || 1;
          const pairIdx = pairSeen.get(pairKey) || 0;
          pairSeen.set(pairKey, pairIdx + 1);
          const curveOffset = pairTotal > 1 ? (pairIdx - (pairTotal - 1) / 2) * 34 : 0;

          const isAdded = addedEdges.has(edge.id);
          const isModified = modifiedEdges.has(edge.id);
          const stroke = isAdded ? '#22c55e' : (isModified ? '#f59e0b' : '#64748b');
          const marker = isAdded ? mkAdd : (isModified ? mkMod : mkNorm);

          const dx = dst.x - src.x;
          const dy = dst.y - src.y;
          let x1, y1, x2, y2, cx1, cy1, cx2, cy2;

          if (dx > 20) {
            x1 = src.x + nodeHalfW;
            y1 = src.y;
            x2 = dst.x - nodeHalfW;
            y2 = dst.y;
            const span = Math.max(48, (x2 - x1) * 0.48);
            cx1 = x1 + span;
            cy1 = y1 + curveOffset;
            cx2 = x2 - span;
            cy2 = y2 + curveOffset;
          } else if (dx < -20) {
            x1 = src.x - nodeHalfW;
            y1 = src.y;
            x2 = dst.x + nodeHalfW;
            y2 = dst.y;
            const arch = (Math.abs(dy) < 25 ? -72 : 0) + curveOffset;
            const span = Math.max(54, Math.abs(x1 - x2) * 0.42);
            cx1 = x1 - span;
            cy1 = y1 + arch;
            cx2 = x2 + span;
            cy2 = y2 + arch;
          } else {
            const signY = dy >= 0 ? 1 : -1;
            x1 = src.x;
            y1 = src.y + signY * nodeHalfH;
            x2 = dst.x;
            y2 = dst.y - signY * nodeHalfH;
            const bulge = 58 + curveOffset;
            cx1 = x1 + bulge;
            cy1 = y1 + signY * 18;
            cx2 = x2 + bulge;
            cy2 = y2 - signY * 18;
          }

          const edgeActive = inFocus && (!projectFilterId || srcInProj || dstInProj);
          const g = createSvgEl('g', {
            class: 'edge-group',
            opacity: edgeActive ? (inProject ? 1 : 0.45) : 0.12,
          });
          g.appendChild(createSvgEl('path', {
            d: 'M ' + x1 + ' ' + y1 + ' C ' + cx1 + ' ' + cy1 + ', ' + cx2 + ' ' + cy2 + ', ' + x2 + ' ' + y2,
            fill: 'none',
            stroke,
            'stroke-width': isAdded || isModified || (focusedId && inFocus) ? 2.5 : 1.75,
            'marker-end': marker,
            opacity: isAdded || isModified ? 1 : 0.78,
          }));

          const showLabel = Boolean(edge.label) && (
            totalEdgeCount <= 12 ||
            Boolean(focusedId && inFocus) ||
            isAdded ||
            isModified
          );
          if (showLabel) {
            const mx = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2;
            const my = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2;
            const labelStr = edge.label.length > 18 ? edge.label.slice(0, 17) + '…' : edge.label;
            const pillW = Math.max(32, Math.round(labelStr.length * 6.4 + 14));
            const pillH = 18;

            g.appendChild(createSvgEl('rect', {
              x: mx - pillW / 2,
              y: my - pillH / 2,
              width: pillW,
              height: pillH,
              rx: 9,
              fill: '#0b1020',
              'fill-opacity': 0.92,
              stroke: isAdded ? '#22c55e' : (isModified ? '#f59e0b' : '#334155'),
              'stroke-width': 1,
            }));

            const label = createSvgEl('text', {
              x: mx,
              y: my + 3.5,
              fill: isAdded ? '#86efac' : (isModified ? '#fde68a' : '#cbd5e1'),
              'font-size': 10.5,
              'text-anchor': 'middle',
            });
            label.textContent = labelStr;
            g.appendChild(label);
          }
          edgesContainer.appendChild(g);
        }

        const renderNodes = [...(frame.nodes || [])];
        for (const remId of removedNodes) {
          const fallbackNode = fallbackBaseNodes ? fallbackBaseNodes.get(remId) : null;
          if (positions[remId]) {
            renderNodes.push({
              id: remId,
              name: fallbackNode?.name || positions[remId].name,
              nodeType: fallbackNode?.nodeType || positions[remId].nodeType,
              controlCount: fallbackNode?.controlCount || positions[remId].controlCount,
              sourceId: fallbackNode?.sourceId || positions[remId].sourceId,
              sourceLabel: fallbackNode?.sourceLabel || positions[remId].sourceLabel,
              sourceIds: fallbackNode?.sourceIds || positions[remId].sourceIds,
              sourceLabels: fallbackNode?.sourceLabels || positions[remId].sourceLabels,
              mergedViaDetailedArch:
                fallbackNode?.mergedViaDetailedArch || positions[remId].mergedViaDetailedArch,
            });
          }
        }

        for (const node of renderNodes) {
          const pos = positions[node.id];
          if (!pos) continue;

          const inFocus = !focusedId || (neighborhoodSet && neighborhoodSet.has(node.id));
          const inProject = nodeMatchesSpecificProject(node.sourceId || node.sourceIds ? node : pos, projectFilterId);
          if (focusedId && isolate && !inFocus) continue;
          if (projectFilterId && isolate && !inProject) continue;
          const visibleActive = inFocus && inProject;

          const isFocusedTarget = focusedId === node.id;
          const isAdded = addedNodes.has(node.id);
          const isModified = modifiedNodes.has(node.id);
          const isRemoved = removedNodes.has(node.id);

          let stroke = '#3b82f6';
          let fill = '#13203d';
          if (isAdded) { stroke = '#22c55e'; fill = '#0f291e'; }
          else if (isModified) { stroke = '#f59e0b'; fill = '#2b200c'; }
          else if (isRemoved) { stroke = '#ef4444'; fill = '#2c1215'; }
          if (isFocusedTarget) { stroke = '#38bdf8'; }

          const g = createSvgEl('g', {
            class: 'node-group',
            opacity: isRemoved ? (visibleActive ? 0.45 : 0.12) : (visibleActive ? 1 : 0.16),
          });
          if (onNodeClick) {
            g.addEventListener('click', (ev) => {
              ev.stopPropagation();
              onNodeClick(node.id);
            });
          }

          const w = 176;
          const h = 64;
          g.appendChild(createSvgEl('rect', {
            x: pos.x - w / 2,
            y: pos.y - h / 2,
            width: w,
            height: h,
            rx: 10,
            fill,
            stroke,
            'stroke-width': isAdded || isModified || isRemoved ? 2.4 : 1.5,
            'stroke-dasharray': isRemoved ? '5 4' : 'none',
          }));

          const effSourceId = node.sourceId || pos.sourceId;
          const effSourceLabel = node.sourceLabel || pos.sourceLabel;
          const effSourceLabels = node.sourceLabels || pos.sourceLabels;
          const effMerged = Boolean(node.mergedViaDetailedArch || pos.mergedViaDetailedArch);
          if (isMultiSource && effSourceLabel) {
            const rawBadge = effMerged && Array.isArray(effSourceLabels) && effSourceLabels.length > 1
              ? '⇄ ' + effSourceLabels.join('+')
              : effSourceLabel;
            const badgeStr = rawBadge.length > 22 ? rawBadge.slice(0, 21) + '…' : rawBadge;
            const badgeW = Math.min(w - 12, Math.max(44, Math.round(badgeStr.length * 5.8 + 14)));
            const badgeH = 15;
            const badgeColor = sourceColorMap.get(effSourceId) || '#38bdf8';
            g.appendChild(createSvgEl('rect', {
              x: pos.x - badgeW / 2,
              y: pos.y - h / 2 - 8,
              width: badgeW,
              height: badgeH,
              rx: 7.5,
              fill: '#0b1020',
              stroke: badgeColor,
              'stroke-width': 1.1,
            }));
            const badgeText = createSvgEl('text', {
              x: pos.x,
              y: pos.y - h / 2 + 2.5,
              fill: badgeColor,
              'font-size': 9.5,
              'font-weight': 600,
              'text-anchor': 'middle',
            });
            badgeText.textContent = badgeStr;
            g.appendChild(badgeText);
          }

          const titleText = createSvgEl('text', {
            x: pos.x,
            y: pos.y - 5,
            fill: '#f1f5f9',
            'font-size': 12.5,
            'font-weight': 600,
            'text-anchor': 'middle',
          });
          titleText.textContent = node.name.length > 22 ? node.name.slice(0, 21) + '…' : node.name;
          g.appendChild(titleText);

          const ctrlSuffix = node.controlCount ? ' · ' + node.controlCount + ' ctrl' : '';
          const typeText = createSvgEl('text', {
            x: pos.x,
            y: pos.y + 15,
            fill: '#93a4c7',
            'font-size': 10.5,
            'text-anchor': 'middle',
          });
          typeText.textContent = node.nodeType + ctrlSuffix + (isRemoved ? ' (removed)' : '');
          g.appendChild(typeText);

          nodesContainer.appendChild(g);
        }
      }

      let currentViewMode = 'stage';
      let feedNewestFirst = true;
      let feedProjectFilter = '';
      let feedQuery = '';

      function createFeedPostSvg(frame, frameIdx, projFilter) {
        const activeIds = [
          ...(frame.nodes || []).map((n) => n.id),
          ...(frame.removedNodeIds || []),
        ];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const id of activeIds) {
          const p = positions[id];
          if (!p) continue;
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        if (!Number.isFinite(minX)) {
          minX = 0; minY = 0; maxX = canvasWidth; maxY = canvasHeight;
        }
        const padX = 108;
        const padY = 52;
        const rawW = (maxX - minX) + padX * 2;
        const rawH = (maxY - minY) + padY * 2;
        const vbW = Math.max(380, rawW);
        const vbH = Math.max(175, rawH);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const vbX = Math.round(cx - vbW / 2);
        const vbY = Math.round(cy - vbH / 2);

        const markerPrefix = 'feed-' + frameIdx + '-';
        const svg = createSvgEl('svg', {
          viewBox: vbX + ' ' + vbY + ' ' + Math.round(vbW) + ' ' + Math.round(vbH),
          preserveAspectRatio: 'xMidYMid meet',
          xmlns: 'http://www.w3.org/2000/svg',
        });

        const defs = createSvgEl('defs', {});
        const markerSpecs = [
          ['arrow-normal', '#64748b'],
          ['arrow-added', '#22c55e'],
          ['arrow-modified', '#f59e0b'],
        ];
        for (const [mName, color] of markerSpecs) {
          const m = createSvgEl('marker', {
            id: markerPrefix + mName,
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: 'auto-start-reverse',
          });
          m.appendChild(createSvgEl('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: color }));
          defs.appendChild(m);
        }
        svg.appendChild(defs);

        const edgesG = createSvgEl('g', {});
        const nodesG = createSvgEl('g', {});
        svg.appendChild(edgesG);
        svg.appendChild(nodesG);

        const prevFrame = frameIdx > 0 ? frames[frameIdx - 1] : null;
        const fallbackBaseNodes = prevFrame
          ? new Map((prevFrame.nodes || []).map((n) => [n.id, n]))
          : null;

        drawGraphScene({
          edgesContainer: edgesG,
          nodesContainer: nodesG,
          frame,
          addedNodes: new Set(frame.addedNodeIds || []),
          modifiedNodes: new Set(frame.modifiedNodeIds || []),
          removedNodes: new Set(frame.removedNodeIds || []),
          addedEdges: new Set(frame.addedEdgeIds || []),
          modifiedEdges: new Set(frame.modifiedEdgeIds || []),
          fallbackBaseNodes,
          focusedId: '',
          neighborhoodSet: null,
          projectFilterId: projFilter,
          isolate: false,
          markerPrefix,
          onNodeClick: (clickedNodeId) => {
            setViewMode('stage');
            renderFrame(frameIdx);
            setFocusNode(clickedNodeId);
          },
        });

        return { svg, vbX, vbY, vbW: Math.round(vbW), vbH: Math.round(vbH) };
      }

      function downloadPostSvg(svgEl, vbX, vbY, vbW, vbH, filename) {
        const clone = svgEl.cloneNode(true);
        clone.setAttribute('width', String(vbW));
        clone.setAttribute('height', String(vbH));
        clone.setAttribute('style', 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;');
        const bgRect = createSvgEl('rect', {
          x: vbX,
          y: vbY,
          width: vbW,
          height: vbH,
          fill: '#0b1020',
        });
        clone.insertBefore(bgRect, clone.firstChild);
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(clone);
        const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      function frameTouchesProject(frame, projId) {
        if (!projId) return true;
        const srcObj = sources.find((s) => s.sourceId === projId);
        const labelNeedle = srcObj ? '[' + srcObj.sourceLabel + ']' : '';
        if (labelNeedle) {
          if ((frame.commitMessages || []).some((m) => String(m).includes(labelNeedle))) return true;
          if ((frame.changes || []).some((c) => String(c.text || '').includes(labelNeedle))) return true;
        }
        const changedIds = [
          ...(frame.addedNodeIds || []),
          ...(frame.modifiedNodeIds || []),
          ...(frame.removedNodeIds || []),
        ];
        for (const id of changedIds) {
          const p = positions[id];
          if (nodeMatchesSpecificProject(p, projId)) return true;
        }
        return false;
      }

      function collectMomentSourceLabels(frame) {
        if (!isMultiSource) return [];
        const touched = [];
        for (const src of sources) {
          if (frameTouchesProject(frame, src.sourceId)) {
            touched.push(src);
          }
        }
        return touched;
      }

      function renderFeed() {
        if (!feedStream) return;
        feedStream.innerHTML = '';

        const indices = frames.map((_, idx) => idx);
        indices.sort((a, b) => {
          const da = String(frames[a].validFrom || '');
          const db = String(frames[b].validFrom || '');
          if (da && db && da !== db) {
            return feedNewestFirst ? db.localeCompare(da) : da.localeCompare(db);
          }
          return feedNewestFirst ? b - a : a - b;
        });

        const needle = feedQuery.trim().toLowerCase();
        const matched = indices.filter((idx) => {
          const f = frames[idx];
          if (!frameTouchesProject(f, feedProjectFilter)) return false;
          if (!needle) return true;
          const hay = [
            f.name,
            f.description,
            f.validFrom,
            ...(f.commits || []),
            ...(f.commitMessages || []),
            ...(f.adrs || []),
            ...(f.changes || []).map((c) => c.text),
            ...(f.nodes || []).map((n) => n.name + ' ' + n.id),
            ...(f.controls || []).map((c) => c.id + ' ' + c.description),
            ...(f.flows || []).map(
              (fl) =>
                fl.name +
                ' ' +
                fl.description +
                ' ' +
                (fl.intents || []).join(' ') +
                ' ' +
                (fl.contexts || []).join(' '),
            ),
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(needle);
        });

        if (feedCount) {
          feedCount.textContent =
            matched.length + ' architectural post' + (matched.length === 1 ? '' : 's');
        }

        if (matched.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'feed-empty';
          empty.textContent = 'No architectural moments match the current project or search filter.';
          feedStream.appendChild(empty);
          return;
        }

        for (const idx of matched) {
          const f = frames[idx];
          const article = document.createElement('article');
          article.className = 'feed-post';
          article.setAttribute('data-moment-index', String(idx));

          const metaRow = document.createElement('div');
          metaRow.className = 'feed-post-meta';

          const authorBlock = document.createElement('div');
          authorBlock.className = 'feed-author-block';

          const avatar = document.createElement('div');
          avatar.className = 'feed-avatar';
          avatar.textContent = 'M' + (idx + 1);
          authorBlock.appendChild(avatar);

          const metaTextWrap = document.createElement('div');
          const metaTitle = document.createElement('div');
          metaTitle.className = 'feed-meta-title';
          const dateLabel = f.validFrom ? String(f.validFrom).slice(0, 10) : 'Manual Moment';
          metaTitle.appendChild(
            document.createTextNode('Moment ' + (idx + 1) + ' of ' + frames.length + ' · ' + dateLabel),
          );

          for (const src of collectMomentSourceLabels(f)) {
            const sp = document.createElement('span');
            sp.className = 'feed-source-pill';
            const c = sourceColorMap.get(src.sourceId) || '#38bdf8';
            sp.style.borderColor = c;
            sp.style.color = c;
            sp.textContent = src.sourceLabel;
            metaTitle.appendChild(sp);
          }

          const metaSub = document.createElement('div');
          metaSub.className = 'feed-meta-sub';
          const commitInfo = (f.commits && f.commits.length > 0)
            ? f.commitCount + ' commit' + (f.commitCount === 1 ? '' : 's') + ' (' + f.commits[0] + (f.commits.length > 1 ? '..' + f.commits[f.commits.length - 1] : '') + ')'
            : 'Curated snapshot';
          metaSub.textContent =
            commitInfo +
            ((f.adrs && f.adrs.length) ? ' · ' + f.adrs.length + ' ADR(s)' : '') +
            ((f.controls && f.controls.length) ? ' · ' + f.controls.length + ' active control(s)' : '') +
            ((f.flows && f.flows.length) ? ' · ' + f.flows.length + ' CALM flow(s)' : '');

          metaTextWrap.appendChild(metaTitle);
          metaTextWrap.appendChild(metaSub);
          authorBlock.appendChild(metaTextWrap);
          metaRow.appendChild(authorBlock);

          const actions = document.createElement('div');
          actions.className = 'feed-actions';

          const { svg, vbX, vbY, vbW, vbH } = createFeedPostSvg(f, idx, feedProjectFilter);

          const btnSaveSvg = document.createElement('button');
          btnSaveSvg.type = 'button';
          btnSaveSvg.className = 'feed-action-btn';
          btnSaveSvg.textContent = '⬇ Save SVG';
          btnSaveSvg.title = 'Download standalone SVG snapshot for this post';
          btnSaveSvg.addEventListener('click', () => {
            const slug = String(f.id || ('moment-' + (idx + 1))).replace(/[^a-zA-Z0-9_-]+/g, '-');
            downloadPostSvg(svg, vbX, vbY, vbW, vbH, slug + '.svg');
          });

          const btnOpenStage = document.createElement('button');
          btnOpenStage.type = 'button';
          btnOpenStage.className = 'feed-action-btn primary';
          btnOpenStage.textContent = 'Inspect in Stage →';
          btnOpenStage.addEventListener('click', () => {
            setViewMode('stage');
            renderFrame(idx);
          });

          actions.appendChild(btnSaveSvg);
          actions.appendChild(btnOpenStage);
          metaRow.appendChild(actions);
          article.appendChild(metaRow);

          const h3 = document.createElement('h3');
          h3.className = 'feed-post-title';
          h3.textContent = f.name;
          article.appendChild(h3);

          const summaryP = document.createElement('p');
          summaryP.className = 'feed-post-summary';
          summaryP.textContent = f.description || f.summary || '';
          article.appendChild(summaryP);

          const figure = document.createElement('div');
          figure.className = 'feed-figure';
          const svgWrap = document.createElement('div');
          svgWrap.className = 'feed-svg-wrap';
          svgWrap.title = 'Click diagram or any node to inspect in interactive Timelapse Stage';
          svgWrap.appendChild(svg);
          svgWrap.addEventListener('click', () => {
            setViewMode('stage');
            renderFrame(idx);
          });
          figure.appendChild(svgWrap);

          const caption = document.createElement('div');
          caption.className = 'feed-figure-caption';
          const deltaPills = document.createElement('div');
          deltaPills.className = 'feed-delta-pills';
          const addCnt = (f.addedNodeIds || []).length + (f.addedEdgeIds || []).length;
          const modCnt = (f.modifiedNodeIds || []).length + (f.modifiedEdgeIds || []).length;
          const delCnt = (f.removedNodeIds || []).length + (f.removedEdgeIds || []).length;

          const sAdd = document.createElement('span');
          sAdd.style.color = '#86efac';
          sAdd.textContent = '+' + addCnt + ' added';
          deltaPills.appendChild(sAdd);

          if (modCnt > 0) {
            const sMod = document.createElement('span');
            sMod.style.color = '#fde68a';
            sMod.textContent = '~' + modCnt + ' modified';
            deltaPills.appendChild(sMod);
          }
          if (delCnt > 0) {
            const sDel = document.createElement('span');
            sDel.style.color = '#fca5a5';
            sDel.textContent = '-' + delCnt + ' removed';
            deltaPills.appendChild(sDel);
          }

          const stateTotals = document.createElement('span');
          stateTotals.textContent =
            (f.nodes || []).length +
            ' nodes · ' +
            (f.edges || []).length +
            ' relationships' +
            ((f.controls && f.controls.length) ? ' · ' + f.controls.length + ' controls' : '');

          caption.appendChild(deltaPills);
          caption.appendChild(stateTotals);
          figure.appendChild(caption);
          article.appendChild(figure);

          const highlights = document.createElement('div');
          highlights.className = 'feed-highlights';
          const allChanges = f.changes || [];
          const maxInline = 6;
          const renderChips = (limit) => {
            highlights.innerHTML = '';
            const shown = allChanges.slice(0, limit);
            for (const ch of shown) {
              const chip = document.createElement('span');
              chip.className = 'feed-chip ' + (ch.kind || 'mod');
              const prefix = ch.kind === 'add' ? '+ ' : (ch.kind === 'del' ? '- ' : '~ ');
              chip.textContent = prefix + ch.text;
              highlights.appendChild(chip);
            }
            if (allChanges.length > limit) {
              const moreBtn = document.createElement('button');
              moreBtn.type = 'button';
              moreBtn.className = 'feed-action-btn';
              moreBtn.style.fontSize = '11px';
              moreBtn.style.padding = '3px 9px';
              moreBtn.textContent = '+' + (allChanges.length - limit) + ' more changes';
              moreBtn.addEventListener('click', () => renderChips(allChanges.length));
              highlights.appendChild(moreBtn);
            }
            for (const adr of f.adrs || []) {
              const adrChip = document.createElement('span');
              adrChip.className = 'feed-chip adr';
              adrChip.textContent = 'ADR: ' + adr;
              highlights.appendChild(adrChip);
            }
          };
          if (allChanges.length > 0 || (f.adrs && f.adrs.length > 0)) {
            renderChips(maxInline);
            article.appendChild(highlights);
          }

          feedStream.appendChild(article);
        }
      }

      function setViewMode(mode, updateHash = true) {
        currentViewMode = mode === 'feed' ? 'feed' : 'stage';
        const isFeed = currentViewMode === 'feed';
        if (isFeed) stopPlayback();

        if (stageView) stageView.style.display = isFeed ? 'none' : 'grid';
        if (feedView) feedView.style.display = isFeed ? 'flex' : 'none';
        if (badgeKeys) badgeKeys.style.display = isFeed ? 'none' : 'inline-block';

        if (btnModeStage) {
          btnModeStage.classList.toggle('active', !isFeed);
          btnModeStage.setAttribute('aria-selected', String(!isFeed));
        }
        if (btnModeFeed) {
          btnModeFeed.classList.toggle('active', isFeed);
          btnModeFeed.setAttribute('aria-selected', String(isFeed));
        }

        if (isFeed) {
          renderFeed();
        } else if (autoFit) {
          fitCurrentFrame(false);
        }
        if (updateHash && window.history && window.history.replaceState) {
          const base = window.location.pathname + window.location.search;
          window.history.replaceState(null, '', isFeed ? base + '#feed' : base);
        }
      }

      if (btnModeStage) {
        btnModeStage.addEventListener('click', () => setViewMode('stage'));
      }
      if (btnModeFeed) {
        btnModeFeed.addEventListener('click', () => setViewMode('feed'));
      }
      if (btnFeedStory) {
        btnFeedStory.addEventListener('click', () => {
          feedNewestFirst = false;
          btnFeedStory.classList.add('active');
          if (btnFeedLatest) btnFeedLatest.classList.remove('active');
          renderFeed();
        });
      }
      if (btnFeedLatest) {
        btnFeedLatest.addEventListener('click', () => {
          feedNewestFirst = true;
          btnFeedLatest.classList.add('active');
          if (btnFeedStory) btnFeedStory.classList.remove('active');
          renderFeed();
        });
      }
      if (feedProjectSelect) {
        feedProjectSelect.addEventListener('change', (e) => {
          feedProjectFilter = e.target.value || '';
          renderFeed();
        });
      }
      if (feedSearch) {
        feedSearch.addEventListener('input', (e) => {
          feedQuery = e.target.value || '';
          renderFeed();
        });
      }

      window.addEventListener('keydown', (e) => {
        if (currentViewMode === 'feed') return;
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.code === 'Space') {
          e.preventDefault();
          if (timer) stopPlayback();
          else startPlayback();
        } else if (e.code === 'ArrowLeft') {
          stopPlayback();
          renderFrame(currentIndex - 1);
        } else if (e.code === 'ArrowRight') {
          stopPlayback();
          renderFrame(currentIndex + 1);
        }
      });

      const handleViewportResize = () => {
        if (currentViewMode !== 'stage') return;
        syncSvgViewBox();
        if (autoFit) {
          fitCurrentFrame(false);
        } else {
          applyTransform(false);
        }
      };
      window.addEventListener('resize', handleViewportResize);
      if (typeof ResizeObserver === 'function' && canvasWrap) {
        const ro = new ResizeObserver(() => handleViewportResize());
        ro.observe(canvasWrap);
      }

      renderFrame(0);
      const urlWantsFeed =
        window.location.hash === '#feed' ||
        new URLSearchParams(window.location.search).get('view') === 'feed' ||
        payload.defaultView === 'feed';
      if (urlWantsFeed) {
        setViewMode('feed', false);
      }
    })();
  </script>
</body>
</html>`;
}

export function writeTimelapseHtml(outputPath: string, payload: TimelapsePayload): string {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, renderTimelapseHtml(payload), 'utf8');
  return resolved;
}
