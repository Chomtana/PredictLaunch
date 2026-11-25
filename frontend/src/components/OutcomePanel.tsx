import type { LaunchSummary, UserLaunch } from '../lib/api.ts'
import { PHASE_LABEL, type Phase } from './LaunchCard.tsx'

/** Shown in place of live trading once the market has settled. */
export function OutcomePanel({ phase }: { l: LaunchSummary; phase: Phase; mine: UserLaunch | null; position: { up: bigint; down: bigint } | null }) {
  return <div className="panel state-panel">{PHASE_LABEL[phase]}</div>
}
