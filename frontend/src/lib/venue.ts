// Where a launch's coin graduates: Flap (Portal + our Launcher Factory) or Four.meme (our OpenFour preset via FourRail).
import type { Address } from 'viem'
import type { Config } from './api.ts'
import { kindOf } from './labels.ts'

export type Venue = 'flap' | 'four'

export const VENUE_NAME: Record<Venue, string> = { flap: 'Flap', four: 'Four.meme' }

const isZero = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a)

/** True when the sequencer runs with an OpenFour rail (`--four-rail`). */
export const fourEnabled = (config: Pick<Config, 'fourRail'> | null | undefined): boolean => !isZero(config?.fourRail)

/** A launch is on Four when its rail is the configured FourRail; every other rail is a Flap Launcher. */
export function venueOf(rail: Address | string | null | undefined, config: Pick<Config, 'fourRail'> | null | undefined): Venue {
  return fourEnabled(config) && !!rail && rail.toLowerCase() === config!.fourRail!.toLowerCase() ? 'four' : 'flap'
}

/** Lead an already-sorted list with 2 Flap launches, then 2 Four launches. Each pair is one price launch then one
 *  question (real-world event) launch when the venue has both; otherwise its next launches fill in. The rest keep their order. */
export function venueLead<T extends { rail: Address | string; kind?: string | null; feed?: string | null }>(
  list: T[],
  config: Pick<Config, 'fourRail'> | null | undefined,
): T[] {
  if (!fourEnabled(config)) return list
  const pairOf = (v: Venue) => {
    const on = list.filter((l) => venueOf(l.rail, config) === v)
    const pick = [on.find((l) => kindOf(l) === 'price'), on.find((l) => kindOf(l) === 'question')].filter((l): l is T => !!l)
    for (const l of on) if (pick.length < 2 && !pick.includes(l)) pick.push(l)
    return pick
  }
  const lead = [...pairOf('flap'), ...pairOf('four')]
  return [...lead, ...list.filter((l) => !lead.includes(l))]
}
