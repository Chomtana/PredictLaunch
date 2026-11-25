import { big, n, type LaunchSummary, type UserLaunch } from '../lib/api.ts'
import { useApp } from '../state.tsx'
import { FailedPanel } from './FailedPanel.tsx'
import { GraduatedPanel } from './GraduatedPanel.tsx'
import type { Phase } from './LaunchCard.tsx'
import { labelsFor } from '../lib/labels.ts'

/** Shown above the progress once the market has settled: graduated / launching / failed / void. */
export function OutcomePanel({ l, phase, mine }: { l: LaunchSummary; phase: Phase; mine: UserLaunch | null }) {
  const { claimTokens } = useApp()
  const id = n(l.id)
  if (phase === 'graduated' || phase === 'graduating') {
    const zero = /^0x0{40}$/i.test(l.token ?? '')
    return (
      <GraduatedPanel
        graduating={phase === 'graduating'}
        token={l.token && !zero ? l.token : null}
        symbol={l.symbol}
        raised={big(l.raised)}
        claimable={mine?.claimableTokens ?? '0'}
        loserShares={mine?.loserShares ?? '0'}
        onClaim={() => void claimTokens(id)}
      />
    )
  }
  if (phase === 'failed' || phase === 'void') {
    const projected = (big(l.pairs) * BigInt(n(l.cutBps))) / 10000n
    return <FailedPanel isVoid={phase === 'void'} outcome={n(l.outcome)} raised={projected} target={big(l.target)} labels={labelsFor(l)} />
  }
  return null
}
