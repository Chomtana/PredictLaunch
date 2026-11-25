import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FailedPanel } from './FailedPanel.tsx'
import { GraduatedPanel } from './GraduatedPanel.tsx'

const E18 = 10n ** 18n
const TOKEN = '0xf235aBcDeF0123456789aBCdEf0123456789777' + '7'

describe('GraduatedPanel', () => {
  it('shows claimableTokens from /api/user on the claim button', () => {
    const onClaim = vi.fn()
    render(<GraduatedPanel token={TOKEN} symbol="MOON" raised={5n * E18} claimable={(12_345_678n * E18).toString()} loserShares={(3n * E18).toString()} onClaim={onClaim} />)
    const btn = screen.getByRole('button', { name: /Claim 12,345,678 MOON/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onClaim).toHaveBeenCalledTimes(1)
    expect(screen.getByText(TOKEN)).toBeTruthy()
    // pool price = raised / 500M = 5 / 5e8 = 1e-8 BNB
    expect(screen.getByText(/1\.00e-8 BNB/)).toBeTruthy()
  })

  it('claim is disabled at 0', () => {
    render(<GraduatedPanel token={TOKEN} symbol="MOON" raised={5n * E18} claimable="0" loserShares="0" onClaim={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /Claim/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('graduating shows Launching on Flap…', () => {
    render(<GraduatedPanel graduating token={null} symbol="MOON" raised={5n * E18} claimable="0" loserShares="0" onClaim={vi.fn()} />)
    expect(screen.getByText(/Launching on Flap…/)).toBeTruthy()
  })
})

describe('FailedPanel', () => {
  it('failed: winners were paid in full, no refund button', () => {
    render(<FailedPanel isVoid={false} outcome={0} raised={0n} target={3n * E18} />)
    expect(screen.getByText(/Target not reached: winners were paid in full\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /refund/i })).toBeNull()
  })

  it('void: everyone redeemed at 0.50', () => {
    render(<FailedPanel isVoid outcome={2} raised={0n} target={3n * E18} />)
    expect(screen.getByText(/No settlement price: everyone redeemed at 0\.50\./)).toBeTruthy()
  })
})
