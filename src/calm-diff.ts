// SPDX-License-Identifier: Apache-2.0

import type { DeltaChangeItem, DeltaCounts, StructuralDeltaResult } from './types.js';

export function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

export function canonicalKey(value: unknown): string {
    return value === undefined ? 'undefined' : JSON.stringify(canonicalize(value));
}

function asRecord(val: unknown): Record<string, unknown> | null {
    return val !== null && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
}

function readStringOrConst(val: unknown): string | undefined {
    if (typeof val === 'string') return val;
    const obj = asRecord(val);
    if (obj && typeof obj['const'] === 'string') return obj['const'];
    return undefined;
}

function unwrapSchemaProps(item: Record<string, unknown>): Record<string, unknown> {
    return asRecord(item['properties']) ?? item;
}

function extractItemsById(
    doc: Record<string, unknown>,
    field: 'nodes' | 'relationships',
): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    const direct = doc[field];
    const props = asRecord(doc['properties']);
    const patternProp = props ? asRecord(props[field]) : null;
    const list = Array.isArray(direct)
        ? direct
        : patternProp && Array.isArray(patternProp['prefixItems'])
          ? patternProp['prefixItems']
          : [];

    for (const raw of list) {
        const obj = asRecord(raw);
        if (!obj) continue;
        const unwrapped = unwrapSchemaProps(obj);
        const id = readStringOrConst(unwrapped['unique-id']);
        if (id) {
            map.set(id, unwrapped);
        }
    }
    return map;
}

function omitUniqueId(obj: Record<string, unknown>): Record<string, unknown> {
    const { 'unique-id': _omit, ...rest } = obj;
    void _omit;
    return rest;
}

function displayNodeLabel(node: Record<string, unknown>, id: string): string {
    const name = readStringOrConst(node['name'])?.trim();
    return name && name !== id ? `${name} (${id})` : id;
}

function describeNodeModification(orig: Record<string, unknown>, next: Record<string, unknown>, id: string): string {
    const changedFields: string[] = [];
    for (const field of [
        'node-type',
        'name',
        'description',
        'interfaces',
        'controls',
        'details',
        'data-classification',
    ]) {
        if (canonicalKey(orig[field]) !== canonicalKey(next[field])) {
            changedFields.push(field);
        }
    }
    const suffix = changedFields.length > 0 ? ` [${changedFields.join(', ')}]` : '';
    return `Modified node ${displayNodeLabel(next, id)}${suffix}`;
}

function collectInlineControls(items: Iterable<Record<string, unknown>>): Map<string, string> {
    const controls = new Map<string, string>();
    for (const obj of items) {
        const ownerId = readStringOrConst(obj['unique-id']) ?? 'element';
        const ctrlObj = asRecord(obj['controls']);
        if (!ctrlObj) continue;
        for (const [ctrlId, ctrlVal] of Object.entries(ctrlObj)) {
            controls.set(`${ownerId}:${ctrlId}`, canonicalKey(ctrlVal));
        }
    }
    return controls;
}

function collectFlows(doc: Record<string, unknown>): Map<string, { name: string; key: string }> {
    const flows = new Map<string, { name: string; key: string }>();
    if (!Array.isArray(doc['flows'])) return flows;
    for (const raw of doc['flows']) {
        const obj = asRecord(raw);
        if (!obj) continue;
        const id = readStringOrConst(obj['unique-id']);
        if (!id) continue;
        const name = readStringOrConst(obj['name'])?.trim() || id;
        flows.set(id, { name, key: canonicalKey(obj) });
    }
    return flows;
}

function collectAdrs(doc: Record<string, unknown>): Set<string> {
    const set = new Set<string>();
    if (!Array.isArray(doc['adrs'])) return set;
    for (const item of doc['adrs']) {
        if (typeof item === 'string' && item.trim()) {
            set.add(item.trim());
        }
    }
    return set;
}

export function computeStructuralDelta(
    prevDoc: Record<string, unknown> | null,
    currDoc: Record<string, unknown>,
): StructuralDeltaResult {
    const baseline: Record<string, unknown> = prevDoc ?? { nodes: [], relationships: [] };
    const changeItems: DeltaChangeItem[] = [];

    const nodesA = extractItemsById(baseline, 'nodes');
    const nodesB = extractItemsById(currDoc, 'nodes');
    const nodesRemovedList = [...nodesA.entries()].filter(([id]) => !nodesB.has(id));
    const nodesAddedList = [...nodesB.entries()].filter(([id]) => !nodesA.has(id));

    const matchedRemovedNodes = new Set<string>();
    const matchedAddedNodes = new Set<string>();
    let nodesRenamedCount = 0;

    for (const [oldId, oldNode] of nodesRemovedList) {
        for (const [newId, newNode] of nodesAddedList) {
            if (matchedAddedNodes.has(newId)) continue;
            if (canonicalKey(omitUniqueId(oldNode)) === canonicalKey(omitUniqueId(newNode))) {
                matchedRemovedNodes.add(oldId);
                matchedAddedNodes.add(newId);
                nodesRenamedCount++;
                changeItems.push({
                    kind: 'mod',
                    category: 'node',
                    id: newId,
                    text: `Renamed node ${oldId} → ${newId}`,
                });
                break;
            }
        }
    }

    let nodesAdded = 0;
    let nodesRemoved = 0;
    let nodesModified = nodesRenamedCount;

    for (const [id, node] of nodesAddedList) {
        if (matchedAddedNodes.has(id)) continue;
        nodesAdded++;
        changeItems.push({ kind: 'add', category: 'node', id, text: `Added node ${displayNodeLabel(node, id)}` });
    }
    for (const [id, node] of nodesRemovedList) {
        if (matchedRemovedNodes.has(id)) continue;
        nodesRemoved++;
        changeItems.push({ kind: 'del', category: 'node', id, text: `Removed node ${displayNodeLabel(node, id)}` });
    }
    for (const [id, nodeA] of nodesA) {
        const nodeB = nodesB.get(id);
        if (!nodeB) continue;
        if (canonicalKey(nodeA) !== canonicalKey(nodeB)) {
            nodesModified++;
            changeItems.push({
                kind: 'mod',
                category: 'node',
                id,
                text: describeNodeModification(nodeA, nodeB, id),
            });
        }
    }

    const edgesA = extractItemsById(baseline, 'relationships');
    const edgesB = extractItemsById(currDoc, 'relationships');
    const edgesRemovedList = [...edgesA.entries()].filter(([id]) => !edgesB.has(id));
    const edgesAddedList = [...edgesB.entries()].filter(([id]) => !edgesA.has(id));

    const matchedRemovedEdges = new Set<string>();
    const matchedAddedEdges = new Set<string>();
    let edgesRenamedCount = 0;

    for (const [oldId, oldEdge] of edgesRemovedList) {
        for (const [newId, newEdge] of edgesAddedList) {
            if (matchedAddedEdges.has(newId)) continue;
            if (canonicalKey(omitUniqueId(oldEdge)) === canonicalKey(omitUniqueId(newEdge))) {
                matchedRemovedEdges.add(oldId);
                matchedAddedEdges.add(newId);
                edgesRenamedCount++;
                changeItems.push({
                    kind: 'mod',
                    category: 'relationship',
                    id: newId,
                    text: `Renamed relationship ${oldId} → ${newId}`,
                });
                break;
            }
        }
    }

    let relationshipsAdded = 0;
    let relationshipsRemoved = 0;
    let relationshipsModified = edgesRenamedCount;

    for (const [id] of edgesAddedList) {
        if (matchedAddedEdges.has(id)) continue;
        relationshipsAdded++;
        changeItems.push({ kind: 'add', category: 'relationship', id, text: `Added relationship ${id}` });
    }
    for (const [id] of edgesRemovedList) {
        if (matchedRemovedEdges.has(id)) continue;
        relationshipsRemoved++;
        changeItems.push({ kind: 'del', category: 'relationship', id, text: `Removed relationship ${id}` });
    }
    for (const [id, edgeA] of edgesA) {
        const edgeB = edgesB.get(id);
        if (!edgeB) continue;
        if (canonicalKey(edgeA) !== canonicalKey(edgeB)) {
            relationshipsModified++;
            changeItems.push({ kind: 'mod', category: 'relationship', id, text: `Modified relationship ${id}` });
        }
    }

    let controlsAdded = 0;
    let controlsRemoved = 0;
    let controlsModified = 0;

    const archCtrlsA = asRecord(baseline['controls']) ?? {};
    const archCtrlsB = asRecord(currDoc['controls']) ?? {};
    for (const ctrlId of Object.keys(archCtrlsB)) {
        if (!(ctrlId in archCtrlsA)) {
            controlsAdded++;
            changeItems.push({
                kind: 'add',
                category: 'control',
                id: ctrlId,
                text: `Added architecture control ${ctrlId}`,
            });
        } else if (canonicalKey(archCtrlsA[ctrlId]) !== canonicalKey(archCtrlsB[ctrlId])) {
            controlsModified++;
            changeItems.push({
                kind: 'mod',
                category: 'control',
                id: ctrlId,
                text: `Updated architecture control ${ctrlId}`,
            });
        }
    }
    for (const ctrlId of Object.keys(archCtrlsA)) {
        if (!(ctrlId in archCtrlsB)) {
            controlsRemoved++;
            changeItems.push({
                kind: 'del',
                category: 'control',
                id: ctrlId,
                text: `Removed architecture control ${ctrlId}`,
            });
        }
    }

    const inlineCtrlsA = collectInlineControls([...nodesA.values(), ...edgesA.values()]);
    const inlineCtrlsB = collectInlineControls([...nodesB.values(), ...edgesB.values()]);
    for (const [key, val] of inlineCtrlsB) {
        if (!inlineCtrlsA.has(key)) {
            controlsAdded++;
            changeItems.push({ kind: 'add', category: 'control', id: key, text: `Added control ${key}` });
        } else if (inlineCtrlsA.get(key) !== val) {
            controlsModified++;
            changeItems.push({ kind: 'mod', category: 'control', id: key, text: `Updated control ${key}` });
        }
    }
    for (const key of inlineCtrlsA.keys()) {
        if (!inlineCtrlsB.has(key)) {
            controlsRemoved++;
            changeItems.push({ kind: 'del', category: 'control', id: key, text: `Removed control ${key}` });
        }
    }

    const flowsA = collectFlows(baseline);
    const flowsB = collectFlows(currDoc);
    let flowsAdded = 0;
    let flowsRemoved = 0;
    let flowsModified = 0;
    for (const [flowId, flow] of flowsB) {
        if (!flowsA.has(flowId)) {
            flowsAdded++;
            changeItems.push({ kind: 'add', category: 'flow', id: flowId, text: `Added flow ${flow.name}` });
        } else if (flowsA.get(flowId)!.key !== flow.key) {
            flowsModified++;
            changeItems.push({ kind: 'mod', category: 'flow', id: flowId, text: `Modified flow ${flow.name}` });
        }
    }
    for (const [flowId, flow] of flowsA) {
        if (!flowsB.has(flowId)) {
            flowsRemoved++;
            changeItems.push({ kind: 'del', category: 'flow', id: flowId, text: `Removed flow ${flow.name}` });
        }
    }

    const adrsA = collectAdrs(baseline);
    const adrsB = collectAdrs(currDoc);
    let adrsAdded = 0;
    let adrsRemoved = 0;
    for (const adr of adrsB) {
        if (!adrsA.has(adr)) {
            adrsAdded++;
            changeItems.push({ kind: 'add', category: 'adr', id: adr, text: `Linked ADR ${adr}` });
        }
    }
    for (const adr of adrsA) {
        if (!adrsB.has(adr)) {
            adrsRemoved++;
            changeItems.push({ kind: 'del', category: 'adr', id: adr, text: `Removed ADR ${adr}` });
        }
    }

    const metaChanged = canonicalKey(baseline['metadata'] ?? {}) !== canonicalKey(currDoc['metadata'] ?? {}) ? 1 : 0;
    if (metaChanged > 0) {
        changeItems.push({ kind: 'mod', category: 'metadata', id: 'metadata', text: 'Updated metadata' });
    }

    const counts: DeltaCounts = {
        nodesAdded,
        nodesRemoved,
        nodesModified,
        relationshipsAdded,
        relationshipsRemoved,
        relationshipsModified,
        controlsAdded,
        controlsRemoved,
        controlsModified,
        flowsAdded,
        flowsRemoved,
        flowsModified,
        adrsAdded,
        adrsRemoved,
        metadataChanged: metaChanged,
    };

    const hasStructuralChange =
        nodesAdded +
            nodesRemoved +
            nodesModified +
            relationshipsAdded +
            relationshipsRemoved +
            relationshipsModified +
            controlsAdded +
            controlsRemoved +
            controlsModified +
            flowsAdded +
            flowsRemoved +
            flowsModified +
            adrsAdded +
            adrsRemoved >
        0;

    return {
        changeItems,
        counts,
        hasStructuralChange,
        hasMetadataChange: metaChanged > 0,
    };
}

export function summarizeCounts(counts: DeltaCounts, isInitial: boolean): string {
    if (isInitial) {
        const parts = [`${counts.nodesAdded} node(s)`, `${counts.relationshipsAdded} relationship(s)`];
        if (counts.controlsAdded > 0) parts.push(`${counts.controlsAdded} control(s)`);
        if (counts.flowsAdded > 0) parts.push(`${counts.flowsAdded} flow(s)`);
        return `Initial baseline with ${parts.join(', ')}`;
    }
    const tokens: string[] = [];
    if (counts.nodesAdded) tokens.push(`+${counts.nodesAdded} node(s)`);
    if (counts.nodesModified) tokens.push(`~${counts.nodesModified} node(s)`);
    if (counts.nodesRemoved) tokens.push(`-${counts.nodesRemoved} node(s)`);
    if (counts.relationshipsAdded) tokens.push(`+${counts.relationshipsAdded} rel(s)`);
    if (counts.relationshipsModified) tokens.push(`~${counts.relationshipsModified} rel(s)`);
    if (counts.relationshipsRemoved) tokens.push(`-${counts.relationshipsRemoved} rel(s)`);
    if (counts.controlsAdded + counts.controlsModified + counts.controlsRemoved > 0) {
        tokens.push(`controls(+${counts.controlsAdded}/~${counts.controlsModified}/-${counts.controlsRemoved})`);
    }
    if (counts.flowsAdded + counts.flowsModified + counts.flowsRemoved > 0) {
        tokens.push(`flows(+${counts.flowsAdded}/~${counts.flowsModified}/-${counts.flowsRemoved})`);
    }
    if (counts.adrsAdded + counts.adrsRemoved > 0) {
        tokens.push(`adrs(+${counts.adrsAdded}/-${counts.adrsRemoved})`);
    }
    if (tokens.length === 0 && counts.metadataChanged > 0) {
        tokens.push('~metadata');
    }
    return tokens.join(', ') || 'No structural changes';
}
