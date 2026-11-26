// Where a launch's coin graduates: Flap (Portal + our Launcher Factory) or Four.meme (our OpenFour preset via FourRail).
import type { Address } from 'viem'
import type { Config } from './api.ts'

export type Venue = 'flap' | 'four'

export const VENUE_NAME: Record<Venue, string> = { flap: 'Flap', four: 'Four.meme' }

const isZero = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a)

/** True when the sequencer runs with an OpenFour rail (`--four-rail`). */
export const fourEnabled = (config: Pick<Config, 'fourRail'> | null | undefined): boolean => !isZero(config?.fourRail)

/** A launch is on Four when its rail is the configured FourRail; every other rail is a Flap Launcher. */
export function venueOf(rail: Address | string | null | undefined, config: Pick<Config, 'fourRail'> | null | undefined): Venue {
  return fourEnabled(config) && !!rail && rail.toLowerCase() === config!.fourRail!.toLowerCase() ? 'four' : 'flap'
}
