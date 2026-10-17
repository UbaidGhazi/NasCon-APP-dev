'use strict';

const { validation, conflict } = require('../../errors');

function generateSwiss(teams, params = {}) {
  const n = teams.length;
  if (n < 2 || n > 64) {
    throw validation(['teams'], 'swiss requires between 2 and 64 teams.');
  }

  const defaultTotal = Math.ceil(Math.log2(n));
  const total_rounds = params.total_rounds !== undefined ? params.total_rounds : defaultTotal;
  const current_round = params.round !== undefined ? params.round : 1;

  if (!Number.isInteger(total_rounds) || total_rounds < 1 || total_rounds > n - 1) {
    throw validation(['params.total_rounds']);
  }
  if (!Number.isInteger(current_round) || current_round < 1 || current_round > total_rounds) {
    throw validation(['params.round']);
  }

  const history = params.history || [];
  // history must contain exactly rounds 1 .. current_round - 1
  if (history.length !== current_round - 1) {
    throw validation(['params.history'], 'history must contain exactly rounds 1..round-1.');
  }
  for (let r = 1; r < current_round; r++) {
    const found = history.find((h) => h.round === r);
    if (!found) {
      throw validation(['params.history'], `history missing round ${r}.`);
    }
  }

  // Calculate scores and played opponents from history
  const scores = {};
  const hadBye = new Set();
  const metPairs = new Set();
  const opponentsMap = {};

  for (let i = 0; i < n; i++) {
    const tid = teams[i];
    scores[tid] = 0;
    opponentsMap[tid] = [];
  }

  for (const h of history) {
    if (h.bye) {
      scores[h.bye] = (scores[h.bye] || 0) + 1;
      hadBye.add(h.bye);
    }
    for (const m of h.matches || []) {
      const uKey = [m.home, m.away].sort().join('::');
      metPairs.add(uKey);
      opponentsMap[m.home].push(m.away);
      opponentsMap[m.away].push(m.home);

      if (m.result === 'home') {
        scores[m.home] += 1;
      } else if (m.result === 'away') {
        scores[m.away] += 1;
      } else if (m.result === 'draw') {
        scores[m.home] += 0.5;
        scores[m.away] += 0.5;
      }
    }
  }

  // Calculate Buchholz
  const buchholz = {};
  for (let i = 0; i < n; i++) {
    const tid = teams[i];
    let sum = 0;
    for (const opp of opponentsMap[tid]) {
      sum += scores[opp];
    }
    buchholz[tid] = sum;
  }

  // Sort standings: score desc, buchholz desc, seed asc (lower index first)
  const seedIndex = new Map();
  teams.forEach((t, idx) => seedIndex.set(t, idx));

  const standingsList = [...teams].sort((a, b) => {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    if (buchholz[b] !== buchholz[a]) return buchholz[b] - buchholz[a];
    return seedIndex.get(a) - seedIndex.get(b);
  });

  const standings = standingsList.map((tid, idx) => ({
    rank: idx + 1,
    team_id: tid,
    score: scores[tid],
    buchholz: buchholz[tid],
  }));

  // ROUND 1: Exact Pairing
  if (current_round === 1) {
    const m = Math.floor(n / 2);
    let bye = null;
    let playingTeams = teams;
    if (n % 2 !== 0) {
      bye = teams[n - 1]; // last seed gets bye
      playingTeams = teams.slice(0, n - 1);
    }

    const pairings = [];
    for (let i = 0; i < m; i++) {
      const home = playingTeams[i];
      const away = playingTeams[i + m];
      pairings.push({
        match_id: `SW-R1M${i + 1}`,
        home,
        away,
      });
    }

    return {
      format: 'swiss',
      round: 1,
      total_rounds,
      pairings,
      bye,
      standings,
    };
  }

  // ROUNDS >= 2: Backtracking with minimum weight matching
  const isOdd = n % 2 !== 0;

  // Candidates for bye: lowest-scoring team that has not had a bye; tie -> largest index
  let byeCandidates = [];
  if (isOdd) {
    const eligible = teams.filter((t) => !hadBye.has(t));
    if (eligible.length === 0) {
      throw conflict('NO_VALID_PAIRING', 'No eligible bye candidates.', { round: current_round });
    }
    // Sort ascending by score, tie -> largest index (seed desc)
    eligible.sort((a, b) => {
      if (scores[a] !== scores[b]) return scores[a] - scores[b];
      return seedIndex.get(b) - seedIndex.get(a);
    });
    byeCandidates = eligible;
  } else {
    byeCandidates = [null];
  }

  let bestPairings = null;
  let bestWeight = Infinity;
  let selectedBye = null;

  function findMinWeightPairings(availableTeams) {
    let localBestWeight = Infinity;
    let localBestPairs = null;

    function backtrack(remaining, currentPairs, currentWeight) {
      if (currentWeight >= localBestWeight) return; // prune
      if (remaining.length === 0) {
        if (currentWeight < localBestWeight) {
          localBestWeight = currentWeight;
          localBestPairs = [...currentPairs];
        }
        return;
      }

      const t1 = remaining[0];
      for (let j = 1; j < remaining.length; j++) {
        const t2 = remaining[j];
        const pairKey = [t1, t2].sort().join('::');
        if (!metPairs.has(pairKey)) {
          const cost = Math.abs(scores[t1] - scores[t2]);
          const nextRemaining = remaining.slice(1, j).concat(remaining.slice(j + 1));
          currentPairs.push([t1, t2]);
          backtrack(nextRemaining, currentPairs, currentWeight + cost);
          currentPairs.pop();
        }
      }
    }

    backtrack(availableTeams, [], 0);
    return { pairs: localBestPairs, weight: localBestWeight };
  }

  for (const cand of byeCandidates) {
    const pool = cand ? teams.filter((t) => t !== cand) : [...teams];
    const { pairs, weight } = findMinWeightPairings(pool);
    if (pairs && weight < bestWeight) {
      bestWeight = weight;
      bestPairings = pairs;
      selectedBye = cand;
      // Since candidates are sorted by preference, if weight 0 found, break
      if (bestWeight === 0) break;
    }
  }

  if (!bestPairings) {
    throw conflict('NO_VALID_PAIRING', 'No valid rematch-free pairing found.', {
      round: current_round,
    });
  }

  const pairingsOut = bestPairings.map((p, idx) => ({
    match_id: `SW-R${current_round}M${idx + 1}`,
    home: p[0],
    away: p[1],
  }));

  return {
    format: 'swiss',
    round: current_round,
    total_rounds,
    pairings: pairingsOut,
    bye: selectedBye,
    standings,
  };
}

module.exports = { generateSwiss };
