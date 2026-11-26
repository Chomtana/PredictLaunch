//! Exchange logs kept on disk, so a restart rebuilds its state without re-reading the whole history
//! from the RPC (with the public book, busy block ranges are megabytes of `OrderPosted` logs).
//!
//! File: append-only lines.
//! - `X <exchange> <start block>`: the deployment the file belongs to (another one discards it).
//! - `L <block> <tx hash|-> <timestamp> <topic,topic,...> <data hex>`: one Exchange log.
//! - `U <block> <block hash>`: every log up to and including `block` is above it, and the chain had
//!   `block hash` at `block` then.
//!
//! Only blocks at least `CONFIRMATIONS` deep are written; newer logs wait in memory until they are.
//! On load everything after the last `U` (a torn tail) is dropped. Before the cache is used, the
//! hash of its last mark is checked against the chain; on a mismatch (a reorg, a fresh dev fork) it
//! falls back to an earlier mark that still matches, or starts over.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

use alloy_primitives::{Address, Bytes, B256};
use anyhow::Context;

/// Blocks a log must be buried under before it is cached (BSC: ~15 s; the chain reorgs far less deep).
pub const CONFIRMATIONS: u64 = 20;
/// Write a new mark only when it moves coverage this far (one block-hash read per ~40 s of chain).
pub const MARK_EVERY: u64 = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawLog {
    pub block: u64,
    pub tx: Option<B256>,
    pub ts: u64,
    pub topics: Vec<B256>,
    pub data: Bytes,
}

impl RawLog {
    fn line(&self) -> String {
        let tx = self.tx.map_or_else(|| "-".to_string(), |t| t.to_string());
        let topics: Vec<String> = self.topics.iter().map(|t| t.to_string()).collect();
        let topics = if topics.is_empty() { "-".to_string() } else { topics.join(",") };
        format!("L {} {tx} {} {topics} {}", self.block, self.ts, self.data)
    }

    fn parse(rest: &[&str]) -> Option<RawLog> {
        let [block, tx, ts, topics, data] = rest else {
            return None;
        };
        let topics = if *topics == "-" {
            Vec::new()
        } else {
            topics.split(',').map(|t| t.parse().ok()).collect::<Option<Vec<B256>>>()?
        };
        Some(RawLog {
            block: block.parse().ok()?,
            tx: if *tx == "-" { None } else { Some(tx.parse().ok()?) },
            ts: ts.parse().ok()?,
            topics,
            data: data.parse().ok()?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub block: u64,
    pub hash: B256,
    /// `logs.len()` when the mark was written.
    len: usize,
}

struct Inner {
    logs: Vec<RawLog>,
    marks: Vec<Mark>,
    /// Fetched, not yet `CONFIRMATIONS` deep.
    pending: Vec<RawLog>,
    /// First block not covered by `logs` + `pending`: a fetch must start here to extend the cache.
    next: u64,
    verified: bool,
}

pub struct LogCache {
    path: PathBuf,
    exchange: Address,
    start: u64,
    inner: Mutex<Inner>,
}

impl LogCache {
    pub fn load(path: PathBuf, exchange: Address, start: u64) -> anyhow::Result<Self> {
        let mut logs = Vec::new();
        let mut marks: Vec<Mark> = Vec::new();
        let mut ours = false;
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                for (i, line) in text.lines().enumerate() {
                    let parts: Vec<&str> = line.split(' ').collect();
                    match parts.split_first() {
                        Some((&"X", [x, s])) if i == 0 => {
                            ours = x.parse::<Address>().ok() == Some(exchange) && s.parse() == Ok(start);
                            if !ours {
                                break;
                            }
                        }
                        Some((&"L", rest)) if ours => match RawLog::parse(rest) {
                            Some(l) => logs.push(l),
                            None => break, // torn line: everything after it is refetched
                        },
                        Some((&"U", [b, h])) if ours => match (b.parse(), h.parse()) {
                            (Ok(block), Ok(hash)) => marks.push(Mark { block, hash, len: logs.len() }),
                            _ => break,
                        },
                        _ => break,
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        }
        logs.truncate(marks.last().map_or(0, |m| m.len));
        let c = LogCache {
            path,
            exchange,
            start,
            inner: Mutex::new(Inner {
                logs,
                marks,
                pending: Vec::new(),
                next: start,
                verified: false,
            }),
        };
        if !ours {
            c.rewrite(&c.inner.lock().unwrap())?;
        }
        Ok(c)
    }

    /// The last mark, if any (what `verify` checks against the chain).
    pub fn marks(&self) -> Vec<Mark> {
        self.inner.lock().unwrap().marks.clone()
    }

    pub fn is_verified(&self) -> bool {
        self.inner.lock().unwrap().verified
    }

    /// Keep everything up to the newest mark whose block hash the chain still has (`matches`), drop
    /// the rest. Call once before `cached`.
    pub fn verify(&self, matching: Option<usize>) -> anyhow::Result<()> {
        let mut g = self.inner.lock().unwrap();
        let keep = matching.map_or(0, |i| i + 1);
        let changed = keep != g.marks.len();
        g.marks.truncate(keep);
        let len = g.marks.last().map_or(0, |m| m.len);
        g.logs.truncate(len);
        g.next = g.marks.last().map_or(self.start, |m| m.block + 1);
        g.verified = true;
        if changed {
            self.rewrite(&g)?;
        }
        Ok(())
    }

    /// Cached logs from block `from` on, and the first block the cache does not cover. Only once
    /// verified and when `from` is inside the coverage; otherwise nothing, and `from` itself.
    pub fn cached(&self, from: u64) -> (Vec<RawLog>, u64) {
        let g = self.inner.lock().unwrap();
        match g.marks.last() {
            Some(m) if g.verified && from >= self.start && from <= m.block => {
                let logs = g.logs.iter().filter(|l| l.block >= from).cloned().collect();
                (logs, m.block + 1)
            }
            _ => (Vec::new(), from),
        }
    }

    /// Logs fetched for blocks `[from, to]`. Kept only when they continue the cache (`from` is its
    /// next block): a racing poll's duplicate range or a gap is ignored. Then everything at or below
    /// `confirmed` (with that block's `hash`) is written, when it moves coverage by `MARK_EVERY`.
    pub fn record(&self, from: u64, to: u64, logs: Vec<RawLog>, confirmed: Option<(u64, B256)>) {
        let mut g = self.inner.lock().unwrap();
        if !g.verified || from != g.next || to < from {
            return;
        }
        g.pending.extend(logs);
        g.next = to + 1;
        let Some((upto, hash)) = confirmed else {
            return;
        };
        let last = g.marks.last().map_or(self.start.saturating_sub(1), |m| m.block);
        if upto < last + MARK_EVERY || upto > to {
            return;
        }
        let (done, rest): (Vec<RawLog>, Vec<RawLog>) = std::mem::take(&mut g.pending)
            .into_iter()
            .partition(|l| l.block <= upto);
        g.pending = rest;
        let mut text = String::new();
        for l in &done {
            text.push_str(&l.line());
            text.push('\n');
        }
        text.push_str(&format!("U {upto} {hash}\n"));
        let res = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| f.write_all(text.as_bytes()));
        if let Err(e) = res {
            tracing::warn!("log cache {}: {e}", self.path.display());
            return;
        }
        g.logs.extend(done);
        let len = g.logs.len();
        g.marks.push(Mark { block: upto, hash, len });
    }

    /// The block the cache wants a hash for when `head` is the chain head (or `None`: no mark due).
    pub fn mark_due(&self, head: u64) -> Option<u64> {
        let g = self.inner.lock().unwrap();
        let upto = head.checked_sub(CONFIRMATIONS)?;
        let last = g.marks.last().map_or(self.start.saturating_sub(1), |m| m.block);
        (g.verified && upto >= last + MARK_EVERY && upto >= self.start).then_some(upto)
    }

    pub fn len(&self) -> (usize, Option<u64>) {
        let g = self.inner.lock().unwrap();
        (g.logs.len(), g.marks.last().map(|m| m.block))
    }

    fn rewrite(&self, g: &Inner) -> anyhow::Result<()> {
        let mut text = format!("X {} {}\n", self.exchange, self.start);
        let mut at = 0;
        for m in &g.marks {
            for l in &g.logs[at..m.len] {
                text.push_str(&l.line());
                text.push('\n');
            }
            at = m.len;
            text.push_str(&format!("U {} {}\n", m.block, m.hash));
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).with_context(|| format!("writing {}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(block: u64, n: u8) -> RawLog {
        RawLog {
            block,
            tx: Some(B256::repeat_byte(n)),
            ts: 1_000 + block,
            topics: vec![B256::repeat_byte(0xAA), B256::repeat_byte(n)],
            data: Bytes::from(vec![n; 40]),
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("pl-logcache-{name}-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    const EX: Address = Address::repeat_byte(0xE8);

    #[test]
    fn round_trip_and_resume() {
        let p = tmp("rt");
        let c = LogCache::load(p.clone(), EX, 100).unwrap();
        c.verify(None).unwrap();
        // 100..=199 fetched; only up to 179 (head 199 - 20) is written.
        c.record(100, 199, vec![log(105, 1), log(150, 2), log(190, 3)], Some((179, B256::repeat_byte(9))));
        assert_eq!(c.len(), (2, Some(179)));
        // A racing duplicate of the same range is ignored; the next range continues it.
        c.record(100, 199, vec![log(105, 1)], None);
        c.record(200, 260, vec![log(240, 4)], Some((240, B256::repeat_byte(8))));
        assert_eq!(c.len(), (4, Some(240)));

        let c2 = LogCache::load(p.clone(), EX, 100).unwrap();
        assert_eq!(c2.marks().len(), 2);
        assert!(c2.cached(100).0.is_empty(), "nothing served before verify");
        c2.verify(Some(1)).unwrap();
        let (logs, next) = c2.cached(100);
        assert_eq!(logs, vec![log(105, 1), log(150, 2), log(190, 3), log(240, 4)]);
        assert_eq!(next, 241);
        assert_eq!(c2.cached(150).0.len(), 3);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn reorg_falls_back_to_an_older_mark_and_other_deployments_start_over() {
        let p = tmp("reorg");
        let c = LogCache::load(p.clone(), EX, 100).unwrap();
        c.verify(None).unwrap();
        c.record(100, 199, vec![log(105, 1), log(170, 2)], Some((160, B256::repeat_byte(9))));
        c.record(200, 299, vec![log(250, 3)], Some((279, B256::repeat_byte(8))));
        // The newest mark's block hash no longer matches: keep only the first mark.
        let c2 = LogCache::load(p.clone(), EX, 100).unwrap();
        c2.verify(Some(0)).unwrap();
        assert_eq!(c2.cached(100), (vec![log(105, 1)], 161));
        // ...and that survives a reload (the file was rewritten).
        let c3 = LogCache::load(p.clone(), EX, 100).unwrap();
        assert_eq!(c3.marks().len(), 1);
        // Another Exchange (a redeploy) discards the file.
        let other = LogCache::load(p.clone(), Address::repeat_byte(1), 100).unwrap();
        assert!(other.marks().is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn torn_tail_is_dropped() {
        let p = tmp("torn");
        let c = LogCache::load(p.clone(), EX, 100).unwrap();
        c.verify(None).unwrap();
        c.record(100, 199, vec![log(105, 1)], Some((160, B256::repeat_byte(9))));
        // A crash mid-write: half a log line and no mark after it.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "L 170 0x12").unwrap();
        let c2 = LogCache::load(p.clone(), EX, 100).unwrap();
        c2.verify(Some(0)).unwrap();
        assert_eq!(c2.cached(100), (vec![log(105, 1)], 161));
        let _ = std::fs::remove_file(&p);
    }
}
