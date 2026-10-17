'use strict';

const { validation } = require('../../errors');

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function recursiveSeedOrder(k) {
  if (k <= 2) return [1, 2];
  const prev = recursiveSeedOrder(k / 2);
  const out = [];
  for (const s of prev) {
    out.push(s, k + 1 - s);
  }
  return out;
}

function generateSingleElim(teams, params = {}) {
  const n = teams.length;
  if (n < 2 || n > 128) {
    throw validation(['teams'], 'single_elim requires between 2 and 128 teams.');
  }

  const B = nextPowerOfTwo(n);
  const totalRounds = Math.round(Math.log2(B));
  const seedList = recursiveSeedOrder(B);

  // Build bracket structure
  const matchesByRound = [];
  const allMatches = new Map();

  for (let r = 1; r <= totalRounds; r++) {
    const matchCount = B / Math.pow(2, r);
    const roundList = [];

    for (let i = 1; i <= matchCount; i++) {
      const matchId = `R${r}M${i}`;
      const nextMatchId = r < totalRounds ? `R${r + 1}M${Math.ceil(i / 2)}` : null;
      const nextSlot = i % 2 === 1 ? 'home' : 'away';

      const matchObj = {
        match_id: matchId,
        bracket: 'main',
        round: r,
        index: i,
        home: null,
        away: null,
        home_seed: null,
        away_seed: null,
        bye: false,
        winner: null,
        loser: null,
        winner_to: nextMatchId ? { match_id: nextMatchId, slot: nextSlot } : null,
        loser_to: null,
      };

      roundList.push(matchObj);
      allMatches.set(matchId, matchObj);
    }
    matchesByRound.push(roundList);
  }

  // Handle Third Place Match if requested
  let tpMatch = null;
  if (params.third_place_match && totalRounds >= 2) {
    tpMatch = {
      match_id: 'TP',
      bracket: 'third_place',
      round: totalRounds,
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
    allMatches.set('TP', tpMatch);

    // Semifinals are round totalRounds - 1, matches 1 and 2
    const semi1 = allMatches.get(`R${totalRounds - 1}M1`);
    const semi2 = allMatches.get(`R${totalRounds - 1}M2`);
    if (semi1) semi1.loser_to = { match_id: 'TP', slot: 'home' };
    if (semi2) semi2.loser_to = { match_id: 'TP', slot: 'away' };
  }

  // Populate Round 1 with seeds
  const r1Matches = matchesByRound[0];
  for (let i = 0; i < r1Matches.length; i++) {
    const s1 = seedList[2 * i];
    const s2 = seedList[2 * i + 1];

    const lowSeed = Math.min(s1, s2);
    const highSeed = Math.max(s1, s2);

    const m = r1Matches[i];
    m.home_seed = lowSeed;
    m.away_seed = highSeed <= n ? highSeed : null;

    m.home = teams[lowSeed - 1];
    m.away = highSeed <= n ? teams[highSeed - 1] : null;

    if (highSeed > n) {
      m.bye = true;
      m.winner = m.home;
      // Propagate bye winner immediately
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
      throw validation([`params.results[${idx}].winner`], 'Winner must be an active participant in the match.');
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
  }

  const outputRounds = matchesByRound.map((roundList, idx) => ({
    round: idx + 1,
    matches: roundList,
  }));

  if (tpMatch) {
    outputRounds[outputRounds.length - 1].matches.push(tpMatch);
  }

  return {
    format: 'single_elim',
    bracket_size: B,
    rounds: outputRounds,
  };
}

module.exports = {
  generateSingleElim,
  nextPowerOfTwo,
  recursiveSeedOrder,
};
