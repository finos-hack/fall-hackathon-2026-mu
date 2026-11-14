#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  generateTimelineFromGit,
  parseSourceTargetSpec,
  renderTimelapseFromTimelineFile,
  validateCalmArchitectureSnapshot,
  validateTimelineStructure,
} from './index.js';
import type { GeneratedGitTimeline } from './types.js';

interface CliOptions {
  fromGit?: string[];
  timeline?: string[];
  output?: string;
  snapshotsDir?: string;
  timelapse?: string | boolean;
  emitDigest?: string;
  clusters?: string;
  maxCommits?: string;
  includeMetadataChanges?: boolean;
  resolveDetails?: boolean;
  validate?: boolean;
  validateSnapshots?: boolean;
  verbose?: boolean;
}

function resolveTimelapseOutputPath(
  timelapseOpt: string | boolean | undefined,
  baseOutputPath: string,
): string | undefined {
  if (!timelapseOpt) return undefined;
  if (typeof timelapseOpt === 'string' && timelapseOpt.trim().length > 0) {
    return timelapseOpt.trim();
  }
  const parsed = path.parse(baseOutputPath);
  const stem = parsed.name.endsWith('.timeline')
    ? parsed.name.slice(0, -'.timeline'.length)
    : parsed.name;
  return path.join(parsed.dir || '.', `${stem}.timelapse.html`);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('calm-timelapse')
    .description(
      'Deterministically generate FINOS CALM timelines from one or multiple Git repositories/architectures, emit structural diff digests for IDE AI assistants, and render synchronized HTML architectural timelapses.',
    )
    .version('0.1.0')
    .option(
      '--from-git <files...>',
      'One or more CALM JSON files across one or more Git repositories (supports optional label=path)',
    )
    .option(
      '--timeline <files...>',
      'One or more existing CALM timeline JSON files (to validate or synchronize into --timelapse)',
    )
    .option('-o, --output <file>', 'Output path for generated CALM timeline JSON')
    .option('--snapshots-dir <dir>', 'Directory to write moment architecture snapshots')
    .option(
      '--timelapse [html]',
      'Generate an interactive standalone HTML timelapse player (optional output path)',
    )
    .option(
      '--emit-digest <file>',
      'Write a compact deterministic commit diff digest JSON for external AI assistants (Copilot, Claude, Kiro, Codex)',
    )
    .option(
      '--clusters <file>',
      'Apply pre-authored or AI-assistant-generated moment cluster definitions JSON (contiguous 0..N-1)',
    )
    .option('--max-commits <n>', 'Maximum number of Git commits to scan per architecture file')
    .option(
      '--include-metadata-changes',
      'Retain commits that only modify metadata/descriptions',
      false,
    )
    .option(
      '--resolve-details',
      'Automatically discover and synchronize same-repo details.detailed-architecture files',
      false,
    )
    .option('--validate', 'Validate generated or provided timeline structure', false)
    .option(
      '--validate-snapshots',
      'Validate every moment architecture snapshot against CALM 1.3 rules',
      false,
    )
    .option('-v, --verbose', 'Print detailed diagnostic logs', false);

  program.action(async (opts: CliOptions) => {
    const hasFromGit = Array.isArray(opts.fromGit) && opts.fromGit.length > 0;
    const hasTimeline = Array.isArray(opts.timeline) && opts.timeline.length > 0;

    if (!hasFromGit && !hasTimeline) {
      program.error('Specify either --from-git <files...> or --timeline <files...>.');
      return;
    }

    if (hasFromGit && hasTimeline) {
      program.error('Use either --from-git or --timeline, not both.');
      return;
    }

    if (hasFromGit && opts.fromGit) {
      const targets = opts.fromGit;
      let defaultTimelinePath: string;
      if (targets.length === 1 && !targets[0].includes('=')) {
        const sourceParsed = path.parse(path.resolve(targets[0]));
        defaultTimelinePath = path.join(sourceParsed.dir, `${sourceParsed.name}.timeline.json`);
      } else {
        const firstSpec = parseSourceTargetSpec(targets[0]);
        const stem = targets.length > 1 ? 'federated' : path.parse(firstSpec.filePath).name;
        defaultTimelinePath = path.resolve(process.cwd(), `${stem}.timeline.json`);
      }
      const outputPath = opts.output ?? defaultTimelinePath;
      const timelapsePath = resolveTimelapseOutputPath(opts.timelapse, outputPath);

      let maxCommits: number | undefined;
      if (opts.maxCommits !== undefined) {
        maxCommits = Number.parseInt(opts.maxCommits, 10);
        if (!Number.isFinite(maxCommits) || maxCommits <= 0) {
          program.error('--max-commits must be a positive integer.');
          return;
        }
      }

      const result = await generateTimelineFromGit(targets.length === 1 ? targets[0] : targets, {
        outputPath,
        snapshotsDir: opts.snapshotsDir,
        timelapsePath,
        emitDigestPath: opts.emitDigest,
        clustersPath: opts.clusters,
        maxCommits,
        includeMetadataChanges: opts.includeMetadataChanges,
        resolveDetails: opts.resolveDetails,
        validate: opts.validate,
        validateSnapshots: opts.validateSnapshots,
        onDebug: opts.verbose ? (msg) => console.error(`[debug] ${msg}`) : undefined,
      });

      if ((opts.validate || opts.validateSnapshots) && result.validationErrors.length > 0) {
        console.error('Timeline validation failed:');
        for (const err of result.validationErrors) {
          console.error(`  - ${err}`);
        }
        process.exitCode = 1;
        return;
      }

      console.log(`Generated timeline: ${path.resolve(outputPath)}`);
      const sourcePrefix =
        result.stats.sourcesTracked && result.stats.sourcesTracked > 1
          ? `Synchronized ${result.stats.sourcesTracked} architecture(s) across ${result.stats.repositoriesTracked ?? 1} repo(s); scanned `
          : 'Scanned ';
      console.log(
        `${sourcePrefix}${result.stats.totalCommitsScanned} commit(s), retained ${result.stats.structuralCommitsRetained} structural commit(s) (filtered ${result.stats.noiseCommitsFiltered} noise), emitted ${result.stats.momentsGenerated} moment(s) using ${result.stats.clusteringEngine}.`,
      );
      if (result.digestPath) {
        console.log(`Emitted commit diff digest: ${result.digestPath}`);
      }
      if (result.timelapsePath) {
        console.log(`Generated HTML timelapse: ${result.timelapsePath}`);
      }
      return;
    }

    if (hasTimeline && opts.timeline) {
      const resolvedTimelines = opts.timeline.map((t) => path.resolve(t));
      if (opts.validate || opts.validateSnapshots) {
        const allErrors: string[] = [];
        for (const resolvedTimeline of resolvedTimelines) {
          const parsed = JSON.parse(readFileSync(resolvedTimeline, 'utf-8')) as GeneratedGitTimeline;
          if (opts.validate) {
            allErrors.push(
              ...validateTimelineStructure(parsed, { timelineFilePath: resolvedTimeline }),
            );
          }
          if (opts.validateSnapshots && Array.isArray(parsed.moments)) {
            const baseDir = path.dirname(resolvedTimeline);
            for (const m of parsed.moments) {
              const archRef = m.details?.['detailed-architecture']?.trim();
              if (!archRef || /^https?:\/\//i.test(archRef)) continue;
              const snapPath = path.resolve(baseDir, archRef);
              try {
                const snapDoc = JSON.parse(readFileSync(snapPath, 'utf-8')) as Record<
                  string,
                  unknown
                >;
                allErrors.push(...validateCalmArchitectureSnapshot(snapDoc, m['unique-id']));
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                allErrors.push(
                  `Moment '${m['unique-id']}' failed to read snapshot '${archRef}': ${msg}`,
                );
              }
            }
          }
          if (allErrors.length === 0) {
            console.log(`Timeline valid: ${resolvedTimeline} (${parsed.moments.length} moment(s))`);
          }
        }
        if (allErrors.length > 0) {
          console.error('Timeline validation failed:');
          for (const err of allErrors) {
            console.error(`  - ${err}`);
          }
          process.exitCode = 1;
          return;
        }
      }

      const defaultBase =
        resolvedTimelines.length > 1
          ? path.resolve(process.cwd(), 'federated.timeline.json')
          : resolvedTimelines[0];
      const timelapsePath = resolveTimelapseOutputPath(opts.timelapse, defaultBase);
      if (timelapsePath) {
        const written = renderTimelapseFromTimelineFile(
          resolvedTimelines.length === 1 ? resolvedTimelines[0] : resolvedTimelines,
          timelapsePath,
        );
        console.log(`Generated HTML timelapse: ${written}`);
      } else if (!opts.validate && !opts.validateSnapshots) {
        program.error(
          'With --timeline, pass --timelapse [html], --validate, and/or --validate-snapshots.',
        );
      }
    }
  });

  return program;
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('/cli.js') ||
    process.argv[1].endsWith('/cli.ts') ||
    process.argv[1].endsWith('\\cli.js') ||
    process.argv[1].endsWith('\\cli.ts'));

if (isDirectExecution) {
  createProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    });
}
