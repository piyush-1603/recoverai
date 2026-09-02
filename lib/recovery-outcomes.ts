/**
 * The only source of truth for audit outcomes that represent a completed
 * monetary recovery. Keep presentation and reporting aligned with execution.
 */
export const SUCCESSFUL_RECOVERY_OUTCOMES = [
  'recovered',
  'retry_succeeded',
  'nudge_led_to_recovery',
  'approval_granted_recovered',
] as const;

export function isSuccessfulRecoveryOutcome(outcome: string): boolean {
  return (SUCCESSFUL_RECOVERY_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Outcomes produced when a live Razorpay call failed and the offline simulation
 * stood in for it. These are intentionally absent from the list above: the
 * simulation ran because there was no gateway response, so its verdict is not
 * evidence of a recovery. Do not add them.
 */
export const SIMULATED_FALLBACK_OUTCOMES = [
  'retry_simulated_fallback',
  'retry_simulated_fallback_no_recovery',
] as const;

export function isSimulatedFallbackOutcome(outcome: string): boolean {
  return outcome.includes('simulated_fallback');
}
