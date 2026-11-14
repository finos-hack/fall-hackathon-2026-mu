#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  generateTimelineFromGit,
  renderTimelapseFromTimelineFile,
  validateCalmArchitectureSnapshot,
  validateTimelineStructure,
} from './index.js';
import type { GeneratedGitTimeline } from './types.js';

interface CliOptions {
  fromGit?: string;
  timeline?: string;
  output?: string;
  snapshotsDir?: string;
  timelapse?: string | boolean;
  emitDigest?: string;
  clusters?: string;
  maxCommits?: string;
  includeMetadataChanges?: boolean;
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
  return path.join(parsed.dir || '.', `${parsed.name}.timelapse.html`);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('calm-timelapse')
    .description(
      'Deterministically generate FINOS CALM timelines from Git history, emit structural diff digests for IDE AI assistants, and render interactive HTML architectural timelapses.',
    )
    .version('0.1.0')
    .option('--from-git <file>', 'Path to a CALM JSON file inside a Git repository')
    .option('--timeline <file>', 'Existing CALM timeline JSON file (to validate or render --timelapse)')
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
    .option('--max-commits <n>', 'Maximum number of Git commits to scan')
    .option(
      '--include-metadata-changes',
      'Retain commits that only modify metadata/descriptions',
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
    if (!opts.fromGit && !opts.timeline) {
      program.error('Specify either --from-git <file> or --timeline <file>.');
      return;
    }

    if (opts.fromGit && opts.timeline) {
      program.error('Use either --from-git or --timeline, not both.');
      return;
    }

    if (opts.fromGit) {
      const sourceParsed = path.parse(path.resolve(opts.fromGit));
      const defaultTimelinePath = path.join(
        sourceParsed.dir,
        `${sourceParsed.name}.timeline.json`,
      );
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

      const result = await generateTimelineFromGit(opts.fromGit, {
        outputPath,
        snapshotsDir: opts.snapshotsDir,
        timelapsePath,
        emitDigestPath: opts.emitDigest,
        clustersPath: opts.clusters,
        maxCommits,
        includeMetadataChanges: opts.includeMetadataChanges,
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
      console.log(
        `Scanned ${result.stats.totalCommitsScanned} commit(s), retained ${result.stats.structuralCommitsRetained} structural commit(s) (filtered ${result.stats.noiseCommitsFiltered} noise), emitted ${result.stats.momentsGenerated} moment(s) using ${result.stats.clusteringEngine}.`,
      );
      if (result.digestPath) {
        console.log(`Emitted commit diff digest: ${result.digestPath}`);
      }
      if (result.timelapsePath) {
        console.log(`Generated HTML timelapse: ${result.timelapsePath}`);
      }
      return;
    }

    if (opts.timeline) {
      const resolvedTimeline = path.resolve(opts.timeline);
      if (opts.validate || opts.validateSnapshots) {
        const parsed = JSON.parse(readFileSync(resolvedTimeline, 'utf-8')) as GeneratedGitTimeline;
        const errors: string[] = opts.validate
          ? validateTimelineStructure(parsed, { timelineFilePath: resolvedTimeline })
          : [];
        if (opts.validateSnapshots && Array.isArray(parsed.moments)) {
          const baseDir = path.dirname(resolvedTimeline);
          for (const m of parsed.moments) {
            const archRef = m.details?.['detailed-architecture']?.trim();
            if (!archRef || /^https?:\/\//i.test(archRef)) continue;
            const snapPath = path.resolve(baseDir, archRef);
            try {
              const snapDoc = JSON.parse(readFileSync(snapPath, 'utf-8')) as Record<string, unknown>;
              errors.push(...validateCalmArchitectureSnapshot(snapDoc, m['unique-id']));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(
                `Moment '${m['unique-id']}' failed to read snapshot '${archRef}': ${msg}`,
              );
            }
          }
        }
        if (errors.length > 0) {
          console.error('Timeline validation failed:');
          for (const err of errors) {
            console.error(`  - ${err}`);
          }
          process.exitCode = 1;
          return;
        }
        console.log(`Timeline valid: ${resolvedTimeline} (${parsed.moments.length} moment(s))`);
      }

      const timelapsePath = resolveTimelapseOutputPath(opts.timelapse, resolvedTimeline);
      if (timelapsePath) {
        const written = renderTimelapseFromTimelineFile(resolvedTimeline, timelapsePath);
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
