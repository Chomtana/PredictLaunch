import { useState } from 'react'
import { n } from '../lib/api.ts'
import { useApp } from '../state.tsx'
import { LaunchCard, phaseOf, type Phase } from './LaunchCard.tsx'
import { Spinner, useNow } from './ui.tsx'
import { venueLead } from '../lib/venue.ts'

const FILTERS: [string, (p: Phase) => boolean][] = [
  ['All', () => true],
  ['Live', (p) => p === 'live' || p === 'settling'],
  ['Graduated', (p) => p === 'graduated' || p === 'graduating'],
  ['Failed', (p) => p === 'failed' || p === 'void'],
]

export function Home() {
  const { launches, config, configError } = useApp()
  const now = useNow(1000)
  const [filter, setFilter] = useState(0)
  const sorted = (launches ?? [])
    .filter((l) => FILTERS[filter][1](phaseOf(l, now)))
    .sort((a, b) => {
      const pa = phaseOf(a, now) === 'live' ? 0 : 1
      const pb = phaseOf(b, now) === 'live' ? 0 : 1
      return pa - pb || n(b.id) - n(a.id)
    })
  // First row: 2 Flap launches, then 2 Four.meme launches.
  const list = venueLead(sorted, config)

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>
            Launch a meme on a <span className="grad">prediction</span>
          </h1>
          <p className="muted">
            Every launch is an Up/Down bet on a real price. Winners are paid, the cut fills the coin's pool, and if it hits the target at settlement the
            coin launches on Flap or Four.meme. Losers get the tokens.
          </p>
        </div>
        <a className="btn primary big" href="#/create">
          + Create launch
        </a>
      </section>

      <div className="toolbar">
        <div className="tabs">
          {FILTERS.map(([label], i) => (
            <button key={label} className={i === filter ? 'on' : ''} onClick={() => setFilter(i)}>
              {label}
            </button>
          ))}
        </div>
        <span className="muted small">{launches ? `${launches.length} launch${launches.length === 1 ? '' : 'es'}` : ''}</span>
      </div>

      {!config ? (
        <div className="panel empty">
          <Spinner /> {configError ? 'Sequencer offline: waiting for it to come up…' : 'Loading…'}
        </div>
      ) : launches == null ? (
        <div className="panel empty">
          <Spinner /> Loading launches…
        </div>
      ) : list.length === 0 ? (
        <div className="panel empty">
          <div>No launches here yet.</div>
          <a className="btn primary" href="#/create">
            Create the first one
          </a>
        </div>
      ) : (
        <div className="card-grid">
          {list.map((l) => (
            <LaunchCard key={String(l.id)} l={l} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
