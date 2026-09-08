import { STRUCTURAL_SIGNALS } from './structural.js';
import { BEHAVIOURAL_SIGNALS } from './behavioural.js';
import type { Signal } from './types.js';

/**
 * The full set, in the order they render.
 *
 * Structural first because they answer "what can this contract do", then
 * behavioural because they answer "what has it actually done". A verdict reads
 * top to bottom as that argument.
 */
export const ALL_SIGNALS: Signal[] = [...STRUCTURAL_SIGNALS, ...BEHAVIOURAL_SIGNALS];
