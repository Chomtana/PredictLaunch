//! Question launches (SPEC "Question launches (Cournot)"): the mirror's question data and proposal state.

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::{SolCall, SolEvent, SolValue};
use predictlaunch_core::abi::{self, IExchange};
use predictlaunch_core::state::{ChainEvent, Config, Proposal, State};
use predictlaunch_core::{Domain, DEFAULT_CHALLENGE_WINDOW, QUESTION_DEADLINE};

const T0: u64 = 1_800_000_000;

fn question_launch(id: u64) -> ChainEvent {
    ChainEvent::LaunchCreated {
        launch_id: id,
        creator: Address::repeat_byte(0xC0),
        rail: Address::repeat_byte(0xAA),
        token: Address::repeat_byte(0x77),
        feed: Address::ZERO,
        strike: U256::ZERO,
        settle_time: T0 + 600,
        cut_bps: 1000,
        target: U256::from(3u64),
        name: "Rain".into(),
        symbol: "RAIN".into(),
        image_uri: String::new(),
        created_at: T0,
    }
}

fn state() -> State {
    State::new(Config {
        domain: Domain {
            chain_id: 97,
            exchange: Address::repeat_byte(0xE8),
        },
        batch_ms: 2000,
    })
}

#[test]
fn constants() {
    assert_eq!(QUESTION_DEADLINE, 7 * 86_400);
    assert_eq!(DEFAULT_CHALLENGE_WINDOW, 3600);
    assert_eq!(state().challenge_window, DEFAULT_CHALLENGE_WINDOW);
}

#[test]
fn question_set_and_proposal_are_mirrored() {
    let mut s = state();
    s.apply_events(
        vec![
            question_launch(0),
            ChainEvent::QuestionSet {
                launch_id: 0,
                question: "Will it rain in Boston tomorrow?".into(),
                market_id: 2849008,
            },
        ],
        T0 * 1000,
    );
    let l = &s.launches[&0];
    assert!(l.is_question());
    assert_eq!(l.question.as_deref(), Some("Will it rain in Boston tomorrow?"));
    assert_eq!(l.market_id, 2849008);
    assert_eq!(l.proposal, None);

    let h = B256::repeat_byte(0xAB);
    s.apply_events(
        vec![ChainEvent::OutcomeProposed {
            launch_id: 0,
            outcome: 0,
            evidence_hash: h,
            by: Address::repeat_byte(9),
            final_: false,
            proposed_at: T0 + 700,
        }],
        (T0 + 700) * 1000,
    );
    assert_eq!(
        s.launches[&0].proposal,
        Some(Proposal {
            outcome: 0,
            proposed_at: T0 + 700,
            evidence_hash: h,
            final_: false,
        })
    );
    // An owner override replaces the proposal and is final.
    s.apply_events(
        vec![ChainEvent::OutcomeProposed {
            launch_id: 0,
            outcome: 2,
            evidence_hash: B256::ZERO,
            by: Address::repeat_byte(1),
            final_: true,
            proposed_at: T0 + 800,
        }],
        (T0 + 800) * 1000,
    );
    let p = s.launches[&0].proposal.clone().unwrap();
    assert_eq!((p.outcome, p.final_), (2, true));

    s.apply_events(vec![ChainEvent::ChallengeWindowSet { seconds: 120 }], 0);
    assert_eq!(s.challenge_window, 120);
}

#[test]
fn price_launch_is_not_a_question() {
    let mut s = state();
    let mut e = question_launch(3);
    if let ChainEvent::LaunchCreated { feed, .. } = &mut e {
        *feed = Address::repeat_byte(0xFE);
    }
    s.apply_events(vec![e], T0 * 1000);
    assert!(!s.launches[&3].is_question());
    assert_eq!(s.launches[&3].question, None);
}

#[test]
fn abi_bindings_match_spec() {
    // LaunchConfig ends with question, marketId.
    let c = abi::LaunchConfig {
        name: "Rain".into(),
        symbol: "RAIN".into(),
        imageURI: String::new(),
        feed: Address::ZERO,
        strike: U256::ZERO,
        settleTime: 1,
        cutBps: 1000,
        target: U256::from(1u64),
        salt: B256::ZERO,
        question: "Q?".into(),
        marketId: U256::from(7u64),
    };
    let back = abi::LaunchConfig::abi_decode(&c.abi_encode()).unwrap();
    assert_eq!(back, c);
    assert_eq!(
        IExchange::QuestionSet::SIGNATURE,
        "QuestionSet(uint256,string,uint256)"
    );
    assert_eq!(
        IExchange::OutcomeProposed::SIGNATURE,
        "OutcomeProposed(uint256,uint8,bytes32,address,bool)"
    );
    assert_eq!(IExchange::ChallengeWindowSet::SIGNATURE, "ChallengeWindowSet(uint64)");
    assert_eq!(
        IExchange::proposeOutcomeCall::SIGNATURE,
        "proposeOutcome(uint256,uint8,bytes32)"
    );
    assert_eq!(
        IExchange::overrideOutcomeCall::SIGNATURE,
        "overrideOutcome(uint256,uint8,bytes32)"
    );
    assert_eq!(IExchange::getQuestionCall::SIGNATURE, "getQuestion(uint256)");
    assert_eq!(IExchange::isQuestionCall::SIGNATURE, "isQuestion(uint256)");
    assert_eq!(IExchange::challengeWindowCall::SIGNATURE, "challengeWindow()");
    assert_eq!(IExchange::resolverCall::SIGNATURE, "resolver()");
    let q = abi::QuestionView {
        question: "Q?".into(),
        marketId: U256::from(7u64),
        proposed: true,
        proposedOutcome: 1,
        proposedAt: 5,
        evidenceHash: B256::repeat_byte(1),
        final_: false,
    };
    let enc = IExchange::getQuestionCall::abi_encode_returns(&q);
    assert_eq!(IExchange::getQuestionCall::abi_decode_returns(&enc).unwrap(), q);
}
