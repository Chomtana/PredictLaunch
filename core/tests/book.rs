use alloy_primitives::{Address, B256};
use bilauncher_core::book::{Book, BookError, Level, RestingOrder};
use bilauncher_core::{FillKind, Outcome, Side, SHARE_UNIT};

const E18: u128 = 1_000_000_000_000_000_000;

fn ro(id: u8, outcome: Outcome, side: Side, price: u8, amount: u128) -> RestingOrder {
    RestingOrder {
        hash: B256::repeat_byte(id),
        owner: Address::repeat_byte(id),
        outcome,
        side,
        price,
        remaining: amount,
    }
}

use Outcome::{Down, Up};
use Side::{Buy, Sell};

#[test]
fn buy_up_crosses_buy_down_as_mint() {
    let mut b = Book::default();
    // Buy Down @40 rests as ask 60.
    let r = b.place(ro(1, Down, Buy, 40, E18)).unwrap();
    assert!(r.fills.is_empty());
    assert_eq!(r.resting, E18);
    // Buy Up @65 crosses (65 + 40 >= 100): mint at the maker's price.
    let r = b.place(ro(2, Up, Buy, 65, E18)).unwrap();
    assert_eq!(r.fills.len(), 1);
    let f = &r.fills[0];
    assert_eq!(f.kind, FillKind::Mint);
    assert_eq!(f.maker_price, 40);
    assert_eq!(f.taker, B256::repeat_byte(2));
    assert_eq!(f.maker, B256::repeat_byte(1));
    assert_eq!(f.amount, E18);
    assert_eq!(r.resting, 0);
    assert_eq!(b.levels(), (vec![], vec![]));
}

#[test]
fn sell_up_crosses_sell_down_as_merge() {
    let mut b = Book::default();
    // Sell Down @30 rests as bid 70.
    b.place(ro(1, Down, Sell, 30, E18)).unwrap();
    // Sell Up @70: 70 + 30 <= 100 → merge.
    let r = b.place(ro(2, Up, Sell, 70, E18)).unwrap();
    assert_eq!(r.fills.len(), 1);
    assert_eq!(r.fills[0].kind, FillKind::Merge);
    assert_eq!(r.fills[0].maker_price, 30);
    // Sell Up @71 would not cross a bid 70.
    let mut b = Book::default();
    b.place(ro(1, Down, Sell, 30, E18)).unwrap();
    let r = b.place(ro(2, Up, Sell, 71, E18)).unwrap();
    assert!(r.fills.is_empty());
}

#[test]
fn transfer_same_outcome() {
    let mut b = Book::default();
    b.place(ro(1, Up, Sell, 55, E18)).unwrap();
    let r = b.place(ro(2, Up, Buy, 60, E18)).unwrap();
    assert_eq!(r.fills[0].kind, FillKind::Transfer);
    assert_eq!(r.fills[0].maker_price, 55);
    // Down side: Buy Down @40 (ask 60) vs Sell Down @35 (bid 65) → transfer at 40.
    let mut b = Book::default();
    b.place(ro(1, Down, Buy, 40, E18)).unwrap();
    let r = b.place(ro(2, Down, Sell, 35, E18)).unwrap();
    assert_eq!(r.fills[0].kind, FillKind::Transfer);
    assert_eq!(r.fills[0].maker_price, 40);
}

#[test]
fn price_time_priority() {
    let mut b = Book::default();
    b.place(ro(1, Up, Sell, 60, E18)).unwrap();
    b.place(ro(2, Up, Sell, 58, E18)).unwrap();
    b.place(ro(3, Up, Sell, 58, E18)).unwrap();
    let r = b.place(ro(9, Up, Buy, 60, 3 * E18)).unwrap();
    let makers: Vec<u8> = r.fills.iter().map(|f| f.maker.0[0]).collect();
    assert_eq!(makers, vec![2, 3, 1]);
    let prices: Vec<u8> = r.fills.iter().map(|f| f.maker_price).collect();
    assert_eq!(prices, vec![58, 58, 60]);
}

#[test]
fn partial_fill_rests_remainder() {
    let mut b = Book::default();
    b.place(ro(1, Up, Sell, 50, E18)).unwrap();
    let r = b.place(ro(2, Up, Buy, 50, 3 * E18)).unwrap();
    assert_eq!(r.fills.len(), 1);
    assert_eq!(r.fills[0].amount, E18);
    assert_eq!(r.resting, 2 * E18);
    assert_eq!(
        b.levels(),
        (
            vec![Level {
                price: 50,
                amount: 2 * E18
            }],
            vec![]
        )
    );
    assert_eq!(b.get(&B256::repeat_byte(2)).unwrap().remaining, 2 * E18);
    // The maker was consumed and is gone.
    assert!(b.get(&B256::repeat_byte(1)).is_none());
    // Cancel returns the remainder.
    assert_eq!(b.cancel(&B256::repeat_byte(2)).unwrap().remaining, 2 * E18);
    assert_eq!(b.levels(), (vec![], vec![]));
}

#[test]
fn levels_in_up_terms() {
    let mut b = Book::default();
    b.place(ro(1, Down, Buy, 30, E18)).unwrap(); // ask 70
    b.place(ro(2, Up, Sell, 75, E18)).unwrap(); // ask 75
    b.place(ro(3, Up, Buy, 40, E18)).unwrap(); // bid 40
    b.place(ro(4, Down, Sell, 55, 2 * E18)).unwrap(); // bid 45
    let (bids, asks) = b.levels();
    assert_eq!(
        bids,
        vec![
            Level {
                price: 45,
                amount: 2 * E18
            },
            Level {
                price: 40,
                amount: E18
            }
        ]
    );
    assert_eq!(
        asks,
        vec![
            Level {
                price: 70,
                amount: E18
            },
            Level {
                price: 75,
                amount: E18
            }
        ]
    );
    assert_eq!(b.best_bid(), Some(45));
    assert_eq!(b.best_ask(), Some(70));
}

#[test]
fn rejects_dust_and_bad_price() {
    let mut b = Book::default();
    assert_eq!(
        b.place(ro(1, Up, Buy, 50, SHARE_UNIT + 1)).unwrap_err(),
        BookError::BadAmount
    );
    assert_eq!(
        b.place(ro(1, Up, Buy, 50, 0)).unwrap_err(),
        BookError::BadAmount
    );
    assert_eq!(
        b.place(ro(1, Up, Buy, 0, E18)).unwrap_err(),
        BookError::BadPrice
    );
    assert_eq!(
        b.place(ro(1, Up, Buy, 100, E18)).unwrap_err(),
        BookError::BadPrice
    );
    assert!(b.place(ro(1, Up, Buy, 1, SHARE_UNIT)).is_ok());
    assert!(b.place(ro(2, Up, Sell, 99, SHARE_UNIT)).is_ok());
    // A second place of a resting hash is refused.
    assert_eq!(
        b.place(ro(1, Up, Buy, 1, SHARE_UNIT)).unwrap_err(),
        BookError::Duplicate
    );
}
