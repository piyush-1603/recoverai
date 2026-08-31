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
