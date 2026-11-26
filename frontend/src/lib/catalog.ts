// Meme names, logos and Cournot questions for demo launches: the seed bots (scripts/seed.ts) and the
// Create page's Quick tab both pick from here at random.
//
// Price launches use the asset's coin icon; question launches a photo of what the question is about.
// Both are served by the frontend from public/seed/ (sources and licences: public/seed/CREDITS.md), so
// imageURI is a site-relative path. Question launches search Cournot with `search`, take the best
// match and use its exact title as the onchain question (the sequencer re-finds the market by title,
// since Cournot ids change on every call).
//
// Contract limits: name <= 32 bytes, symbol <= 10 bytes.

export type Asset = 'BTC' | 'BNB' | 'ETH'

export interface Meme {
  name: string
  symbol: string
}

const img = (slug: string) => `/seed/${slug}.jpg`

export const ICONS: Record<Asset, string> = { BTC: '/seed/btc.svg', BNB: '/seed/bnb.svg', ETH: '/seed/eth.svg' }

/** Price display step for a human-looking strike ("BTC ≥ $97,250", not "$97,233.18"). */
export const STRIKE_STEP: Record<Asset, number> = { BTC: 50, BNB: 1, ETH: 5 }

export const PRICE_MEMES: Record<Asset, Meme[]> = {
  BTC: [
    { name: 'Laser Eyes Forever', symbol: 'LASER' },
    { name: 'Number Go Up', symbol: 'NGU' },
    { name: 'Orange Pill', symbol: 'OPILL' },
    { name: 'Satoshi Was Right', symbol: 'SATRIGHT' },
    { name: 'Stack Sats Bro', symbol: 'SATS' },
    { name: 'Hyperbitcoinization', symbol: 'HYPER' },
    { name: 'Wen Lambo', symbol: 'LAMBO' },
    { name: 'Bitcoin Believer', symbol: 'BELIEVE' },
    { name: 'Diamond Hands Club', symbol: 'DHANDS' },
    { name: 'Halving Hangover', symbol: 'HALVED' },
    { name: 'Mempool Maxi', symbol: 'MEMPOOL' },
    { name: 'Rekt Then Rich', symbol: 'REKT2RICH' },
    { name: 'Cold Wallet Grandpa', symbol: 'GRANDPA' },
    { name: 'Bart Pattern', symbol: 'BART' },
  ],
  BNB: [
    { name: 'Funds Are SAFU', symbol: 'SAFU' },
    { name: 'BNB Moon Mission', symbol: 'BMOON' },
    { name: 'Yellow Candle Szn', symbol: 'YCANDLE' },
    { name: 'Build N Build', symbol: 'BUIDL' },
    { name: 'Four Digits Soon', symbol: '4DIGITS' },
    { name: 'Chain Goes Brrr', symbol: 'BRRR' },
    { name: 'Gas Is Cheap Tho', symbol: 'CHEAPGAS' },
    { name: 'Burn Baby Burn', symbol: 'BURN' },
    { name: 'Pancake Stack', symbol: 'STACK' },
    { name: 'Yellow Gang', symbol: 'YGANG' },
    { name: 'Launchpad Degen', symbol: 'LPDEGEN' },
    { name: 'Golden Coin Gaze', symbol: 'GAZE' },
  ],
  ETH: [
    { name: 'Ultrasound Money', symbol: 'USOUND' },
    { name: 'The Flippening', symbol: 'FLIPPEN' },
    { name: 'Gwei Too Much', symbol: 'GWEI' },
    { name: 'Blob Season', symbol: 'BLOB' },
    { name: 'Merge Mommy', symbol: 'MERGE' },
    { name: 'Staked And Jaded', symbol: 'JADED' },
    { name: 'Rollup Rodeo', symbol: 'RODEO' },
    { name: 'Triple Halving', symbol: '3HALV' },
    { name: 'Unicorn Tears', symbol: 'TEARS' },
    { name: 'Gas Guzzler', symbol: 'GUZZLE' },
    { name: 'World Computer', symbol: 'WRLDPC' },
  ],
}

export interface QuestionTheme {
  /** Sent to Cournot `resolve`; the first market's title becomes the question. */
  search: string
  memes: Meme[]
  images: string[]
}

/** Real-world events only: no asset-price questions (those are what price launches are for).
 *  `{tomorrow}` is replaced with tomorrowLabel() ("Nov 27, 2026"). */
export const QUESTIONS: QuestionTheme[] = [
  {
    search: 'Will it rain in Boston on {tomorrow}?',
    memes: [
      { name: 'Boston Drip', symbol: 'DRIP' },
      { name: 'Umbrella Gang', symbol: 'UMBRELLA' },
      { name: 'Wicked Wet', symbol: 'WICKED' },
    ],
    images: [img('boston'), img('umbrellas')],
  },
  {
    search: 'Will it rain in Seattle tomorrow?',
    memes: [
      { name: 'Seattle Always Rains', symbol: 'ALWAYS' },
      { name: 'Grunge Drizzle', symbol: 'DRIZZLE' },
    ],
    images: [img('seattle'), img('umbrella')],
  },
  {
    search: 'Will it rain in Chicago tomorrow?',
    memes: [
      { name: 'Windy City Wetness', symbol: 'WINDY' },
      { name: 'Deep Dish Downpour', symbol: 'DEEPDISH' },
    ],
    images: [img('chicago')],
  },
  {
    search: 'Will it rain in New York City tomorrow?',
    memes: [
      { name: 'Big Apple Puddle', symbol: 'PUDDLE' },
      { name: 'Bodega Cat Gets Wet', symbol: 'WETCAT' },
    ],
    images: [img('nyc')],
  },
  {
    search: 'Will it snow in Denver on Thanksgiving?',
    memes: [
      { name: 'Turkey Blizzard', symbol: 'BLIZZARD' },
      { name: 'Mile High Snowflake', symbol: 'FLAKE' },
    ],
    images: [img('denver-snow'), img('denver-plaza')],
  },
  {
    search: 'Will the Federal Reserve cut rates by 25bps at their December 2026 meeting?',
    memes: [
      { name: 'Rate Cut Szn', symbol: 'CUTSZN' },
      { name: 'Money Printer Go Brrr', symbol: 'PRINTER' },
      { name: 'Pivot Or Perish', symbol: 'PIVOT' },
    ],
    images: [img('fed')],
  },
  {
    search: 'Will the US government be shut down on Dec 12, 2026?',
    memes: [
      { name: 'Shutdown Speedrun', symbol: 'SHUTDOWN' },
      { name: 'Gridlock Gang', symbol: 'GRIDLOCK' },
    ],
    images: [img('capitol')],
  },
  {
    search: 'Will SpaceX launch another Starship before Dec 15, 2026?',
    memes: [
      { name: 'Rapid Unscheduled Pump', symbol: 'RUP' },
      { name: 'Chopsticks Catch', symbol: 'CHOPSTIX' },
      { name: 'Mars Or Bust', symbol: 'MARS' },
    ],
    images: [img('starship'), img('starship-sn8')],
  },
  {
    search: 'Will Elon Musk post 1400+ tweets in December 2026?',
    memes: [
      { name: 'Terminally Online', symbol: 'ONLINE' },
      { name: 'Post Maxi', symbol: 'POSTMAXI' },
    ],
    images: [img('social')],
  },
  {
    search: 'Will OpenAI release GPT-7 before Mar 1, 2027?',
    memes: [
      { name: 'AGI Next Week', symbol: 'AGI' },
      { name: 'Seven Is The Number', symbol: 'GPT7' },
    ],
    images: [img('datacenter')],
  },
  {
    search: 'Will Manchester City win the English Premier League?',
    memes: [
      { name: 'Sky Blue Supremacy', symbol: 'SKYBLUE' },
      { name: 'Treble Trouble', symbol: 'TREBLE' },
    ],
    images: [img('etihad')],
  },
  {
    search: 'Will Manchester United win the English Premier League?',
    memes: [
      { name: 'Glory Glory Copium', symbol: 'COPIUM' },
      { name: 'Red Devil Revival', symbol: 'REDDEVIL' },
    ],
    images: [img('old-trafford')],
  },
  {
    search: 'Will Chelsea win the English Premier League?',
    memes: [{ name: 'Blue Is The Colour', symbol: 'BLUE' }],
    images: [img('stamford-bridge')],
  },
  {
    search: 'Will Inter win the Champions League?',
    memes: [
      { name: 'Nerazzurri Moon', symbol: 'NERAZZ' },
      { name: 'Big Ears Trophy', symbol: 'BIGEARS' },
    ],
    images: [img('san-siro')],
  },
  {
    search: 'Buffalo wins',
    memes: [
      { name: 'Table Smash Mafia', symbol: 'SMASH' },
      { name: 'Wings And Wins', symbol: 'WINGS' },
    ],
    images: [img('highmark')],
  },
  {
    search: 'Green Bay wins',
    memes: [
      { name: 'Cheesehead Coin', symbol: 'CHEESE' },
      { name: 'Frozen Tundra', symbol: 'TUNDRA' },
    ],
    images: [img('lambeau')],
  },
]

/**
 * True for a Cournot market about an asset's price (crypto, metals, stocks, indices, FX): question
 * launches are for real-world events only, so the seed skips these even when resolve ranks one first.
 */
export function isPriceMarket(title: string): boolean {
  const t = title.toLowerCase()
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|doge|dogecoin|crypto)\b/.test(t)) return true
  if (/\b(gold|silver|oil|wti|brent|xau|xag|s&p|nasdaq|dow|spx|ndx|eur\/usd|usd\/jpy)\b/.test(t)) return true
  if (/\([A-Z]{1,5}\)/.test(title) && /\b(close|finish|price|above|below|stock|shares?)\b/.test(t)) return true // "Apple (AAPL) close above"
  return /\bprice\b|market cap/.test(t)
}

export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]

export function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** "Nov 27, 2026": tomorrow's date as Cournot's daily US-city rain markets name it (US Eastern). */
export function tomorrowLabel(now = Date.now()): string {
  return new Date(now + 86400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
}

/** A theme's search text for today (`{tomorrow}` filled in). */
export const searchText = (q: QuestionTheme, now = Date.now()) => q.search.replace('{tomorrow}', tomorrowLabel(now))

/** `price` (18-dec) moved by `offBps` basis points, rounded to the nearest multiple of `step` (18-dec, > 0). */
export function niceStrike(price: bigint, offBps: number, step: bigint): bigint {
  const moved = (price * BigInt(10_000 + offBps)) / 10_000n
  const k = (moved + step / 2n) / step
  return (k > 0n ? k : 1n) * step
}

/** Every image path in the catalog (lib.test.ts checks each file exists under public/). */
export function allImages(): string[] {
  return [...Object.values(ICONS), ...QUESTIONS.flatMap((q) => q.images)]
}
