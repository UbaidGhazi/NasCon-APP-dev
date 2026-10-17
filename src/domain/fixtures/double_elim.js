'use strict';

const { validation } = require('../../errors');
const { nextPowerOfTwo, recursiveSeedOrder } = require('./single_elim');

function generateDoubleElim(teams, params = {}) {
  const n = teams.length;
  if (n < 3 || n > 128) {
    throw validation(['teams'], 'double_elim requires between 3 and 128 teams.');
  }

  const bracket_reset = Boolean(params.bracket_reset);
  const B = nextPowerOfTwo(n);
  const k = Math.round(Math.log2(B));
  const seedList = recursiveSeedOrder(B);

  const allMatches = new Map();

  // 1. Winners Bracket WR{r}M{i}
  const winnersRounds = [];
  for (let r = 1; r <= k; r++) {
    const matchCount = B / Math.pow(2, r);
    const roundList = [];
    for (let i = 1; i <= matchCount; i++) {
      const matchId = `WR${r}M${i}`;
      const nextMatchId = r < k ? `WR${r + 1}M${Math.ceil(i / 2)}` : 'GF1';
      const nextSlot = r < k ? (i % 2 === 1 ? 'home' : 'away') : 'home';

      const matchObj = {
        match_id: matchId,
        bracket: 'winners',
        round: r,
        index: i,
        home: null,
        away: null,
        home_seed: null,
        away_seed: null,
        bye: false,
        winner: null,
        loser: null,
        winner_to: { match_id: nextMatchId, slot: nextSlot },
        loser_to: null,
      };
      roundList.push(matchObj);
      allMatches.set(matchId, matchObj);
    }
    winnersRounds.push(roundList);
  }

  // 2. Losers Bracket LR{r}M{i}
  const losersRounds = [];
  const totalLosersRounds = 2 * (k - 1);
  for (let r = 1; r <= totalLosersRounds; r++) {
    const j = Math.ceil(r / 2);
    const matchCount = B / Math.pow(2, j + 1);
    const roundList = [];
    for (let i = 1; i <= matchCount; i++) {
      const matchId = `LR${r}M${i}`;
      let nextMatchId = null;
      let nextSlot = null;

      if (r < totalLosersRounds) {
        if (r % 2 === 1) {
          // Odd round -> same round count in r+1
          nextMatchId = `LR${r + 1}M${i}`;
          nextSlot = 'home';
        } else {
          // Even round -> halves in r+1
          nextMatchId = `LR${r + 1}M${Math.ceil(i / 2)}`;
          nextSlot = i % 2 === 1 ? 'home' : 'away';
        }
      } else {
        // Last losers round goes to GF1 away
        nextMatchId = 'GF1';
        nextSlot = 'away';
      }

      const matchObj = {
        match_id: matchId,
        bracket: 'losers',
        round: r,
        index: i,
        home: null,
        away: null,
        home_seed: null,
        away_seed: null,
        bye: false,
        winner: null,
        loser: null,
        winner_to: { match_id: nextMatchId, slot: nextSlot },
        loser_to: null,
      };
      roundList.push(matchObj);
      allMatches.set(matchId, matchObj);
    }
    losersRounds.push(roundList);
  }

  // Map WR loser_to routing:
  // WR1 losers meet in LR1
  const wr1 = winnersRounds[0];
  for (let i = 1; i <= wr1.length; i++) {
    const m = allMatches.get(`WR1M${i}`);
    m.loser_to = {
      match_id: `LR1M${Math.ceil(i / 2)}`,
      slot: i % 2 === 1 ? 'home' : 'away',
    };
  }
  // WRr (r >= 2) losers drop into LR(2r-2) slot away
  for (let r = 2; r <= k; r++) {
    const lrRoundNum = 2 * r - 2;
    const wrList = winnersRounds[r - 1];
    for (let i = 1; i <= wrList.length; i++) {
      const m = allMatches.get(`WR${r}M${i}`);
      m.loser_to = {
        match_id: `LR${lrRoundNum}M${i}`,
        slot: 'away',
      };
    }
  }

  // 3. Grand Final GF1 & GF2
  const gf1 = {
    match_id: 'GF1',
    bracket: 'grand_final',
    round: 1,
    index: 1,
    home: null,
    away: null,
    home_seed: null,
    away_seed: null,
    bye: false,
    winner: null,
    loser: null,
    winner_to: null,
    loser_to: null,
  };
  allMatches.set('GF1', gf1);

  let gf2 = null;
  if (bracket_reset) {
    gf2 = {
      match_id: 'GF2',
      bracket: 'grand_final',
      round: 2,
      index: 1,
      home: null,
      away: null,
      home_seed: null,
      away_seed: null,
      bye: false,
      winner: null,
      loser: null,
      winner_to: null,
      loser_to: null,
      conditional: true,
      required: null,
    };
    allMatches.set('GF2', gf2);
  }

  // Populate WR1 seeds
  for (let i = 0; i < wr1.length; i++) {
    const s1 = seedList[2 * i];
    const s2 = seedList[2 * i + 1];
    const lowSeed = Math.min(s1, s2);
    const highSeed = Math.max(s1, s2);

    const m = wr1[i];
    m.home_seed = lowSeed;
    m.away_seed = highSeed <= n ? highSeed : null;

    m.home = teams[lowSeed - 1];
    m.away = highSeed <= n ? teams[highSeed - 1] : null;

    if (highSeed > n) {
      m.bye = true;
      m.winner = m.home;
      if (m.winner_to) {
        const nextM = allMatches.get(m.winner_to.match_id);
        if (nextM) {
          nextM[m.winner_to.slot] = m.winner;
          nextM[`${m.winner_to.slot}_seed`] = m.home_seed;
        }
      }
    }
  }

  // Apply Results if provided
  const results = params.results || [];
  for (let idx = 0; idx < results.length; idx++) {
    const res = results[idx];
    const m = allMatches.get(res.match_id);
    if (!m) {
      throw validation([`params.results[${idx}].match_id`], 'Unknown match_id in results.');
    }
    if (res.winner !== m.home && res.winner !== m.away) {
      throw validation([`params.results[${idx}].winner`], 'Winner must be an active participant.');
    }

    m.winner = res.winner;
    m.loser = res.winner === m.home ? m.away : m.home;

    if (m.winner_to) {
      const target = allMatches.get(m.winner_to.match_id);
      if (target) {
        target[m.winner_to.slot] = m.winner;
        const winSeed = m.winner === m.home ? m.home_seed : m.away_seed;
        target[`${m.winner_to.slot}_seed`] = winSeed;
      }
    }
    if (m.loser_to) {
      const target = allMatches.get(m.loser_to.match_id);
      if (target) {
        target[m.loser_to.slot] = m.loser;
        const loseSeed = m.loser === m.home ? m.home_seed : m.away_seed;
        target[`${m.loser_to.slot}_seed`] = loseSeed;
      }
    }

    if (m.match_id === 'GF1' && gf2) {
      gf2.home = gf1.home;
      gf2.away = gf1.away;
      gf2.home_seed = gf1.home_seed;
      gf2.away_seed = gf1.away_seed;
      // GF2 required is true iff GF1 winner is GF1.away (losers champion reset)
      gf2.required = gf1.winner === gf1.away;
    }
  }

  const grand_final = [gf1];
  if (gf2) grand_final.push(gf2);

  return {
    format: 'double_elim',
    bracket_size: B,
    bracket_reset,
    winners: winnersRounds.map((list, idx) => ({ round: idx + 1, matches: list })),
    losers: losersRounds.map((list, idx) => ({ round: idx + 1, matches: list })),
    grand_final,
  };
}

module.exports = { generateDoubleElim };
