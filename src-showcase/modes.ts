/**
 * EXCERPT from a private codebase (src/domain/modes.ts), shown in full apart from this header.
 */

/** Runtime modes, ordered from least to most permissive. REPLAY is not a runtime mode: it is a separate code path. */
export const RUNTIME_MODES = ['OFF', 'SHADOW', 'REVIEW', 'LIVE'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const PLATFORMS = ['facebook', 'instagram'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Effective permission is the intersection (least permissive) of all applicable modes. */
export function effectiveMode(...modes: RuntimeMode[]): RuntimeMode {
  let rank = RUNTIME_MODES.length - 1;
  for (const m of modes) rank = Math.min(rank, RUNTIME_MODES.indexOf(m));
  return RUNTIME_MODES[rank] ?? 'OFF';
}

export interface RuntimeControls {
  globalMode: RuntimeMode;
  paused: boolean;
}

/**
 * Resolves the mode a worker may act under. A pause always forces OFF for publishing-capable
 * modes; a lower-level setting never overrides a global pause.
 *
 * Showcase note: in effect, the returned `mode` still drives how events are decided (SHADOW keeps
 * producing evidence while paused), while `publishingBlockedBy` lists every reason nothing may be
 * sent automatically. Human-approved REVIEW sends are additionally gated by the dispatcher and by
 * database triggers.
 */
export function resolveRuntimeMode(input: {
  deploymentCeiling: RuntimeMode;
  controls: RuntimeControls;
  accountMode: RuntimeMode;
}): { mode: RuntimeMode; publishingBlockedBy: string[] } {
  const mode = effectiveMode(input.deploymentCeiling, input.controls.globalMode, input.accountMode);
  const blocked: string[] = [];
  if (input.controls.paused) blocked.push('GLOBAL_PAUSE');
  if (mode !== 'LIVE') blocked.push(`MODE_${mode}`);
  return { mode, publishingBlockedBy: blocked };
}
