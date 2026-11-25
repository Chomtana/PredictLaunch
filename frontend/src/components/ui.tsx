import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { hue } from '../lib/format.ts'
import { useApp } from '../state.tsx'

/** Coin image with a generated gradient fallback (initials) when there is no / a broken URL. */
export function CoinAvatar({ name, image, size = 40, rounded = 12 }: { name: string; image?: string | null; size?: number; rounded?: number }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [image])
  const h = hue(name || '?')
  if (image && !broken) {
    return <img className="coin-avatar" src={image} alt="" width={size} height={size} style={{ borderRadius: rounded }} onError={() => setBroken(true)} />
  }
  const initials = (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span
      className="coin-avatar gen"
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: rounded,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${h} 85% 60%), hsl(${(h + 50) % 360} 80% 45%))`,
      }}
    >
      {initials}
    </span>
  )
}

const FEED_COLORS: Record<string, string> = { BTC: '#f7931a', BNB: '#f0b90b', ANKR: '#2e6bf6', CAKE: '#d1884f', USDT: '#26a17b' }

export function AssetBadge({ asset, size = 18 }: { asset: string; size?: number }) {
  const bg = FEED_COLORS[asset] ?? `hsl(${hue(asset)} 60% 50%)`
  return (
    <span className="asset-badge" style={{ width: size, height: size, background: bg, fontSize: size * 0.5 }} aria-hidden>
      {asset === 'BTC' ? '₿' : asset.slice(0, 1)}
    </span>
  )
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function Toasts() {
  const { toasts, dismiss } = useApp()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-ico">{t.kind === 'pending' ? <Spinner /> : t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : 'i'}</span>
          <div>
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="bl-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#ffd23f" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#bl-g)" />
      <path d="M16 6l6 8h-4v6h-4v-6h-4z" fill="#0b0e13" />
      <rect x="9" y="22" width="14" height="3.2" rx="1.6" fill="#0b0e13" />
    </svg>
  )
}

/** Re-renders every `ms` and returns the current unix seconds. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function ProgressBar({ value, glow }: { value: number; glow?: boolean }) {
  return (
    <div className={`progress ${glow ? 'glow' : ''}`}>
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}
