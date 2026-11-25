import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App, parseHash } from './App.tsx'
import { AppProvider } from './state.tsx'

afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('routes', () => {
    expect(parseHash('#/')).toEqual({ name: 'home' })
    expect(parseHash('#/create')).toEqual({ name: 'create' })
    expect(parseHash('#/launch/7')).toEqual({ name: 'launch', id: 7 })
    expect(parseHash('#/launch/x')).toEqual({ name: 'home' })
  })

  it('renders gracefully when the sequencer is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    )
    expect(screen.getAllByText('bilauncher').length).toBeGreaterThan(0)
    expect(await screen.findByText(/Can't reach the bilauncher sequencer/)).toBeTruthy()
    expect(screen.getByText(/Sequencer offline: waiting/)).toBeTruthy()
  })
})
