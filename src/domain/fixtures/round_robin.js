'use strict';

const { validation } = require('../../errors');

function generateRoundRobin(teams, params = {}) {
  const n = teams.length;
  if (n < 2 || n > 40) {
    throw validation(['teams'], 'round_robin requires between 2 and 40 teams.');
  }

  const legs = params.legs === 2 ? 2 : 1;
  const policy = params.withdrawal_policy === 'void_all' ? 'void_all' : 'forfeit_remaining';
  const withdrawals = params.withdrawals || [];

  const teamSet = new Set(teams);
  const roundsPerLeg = n % 2 === 0 ? n - 1 : n;
  const totalRounds = roundsPerLeg * legs;

  // Validate withdrawals
  for (let i = 0; i < withdrawals.length; i++) {
    const w = withdrawals[i];
    if (!w || !teamSet.has(w.team_id)) {
      throw validation([`params.withdrawals[${i}].team_id`], 'Unknown team in withdrawals.');
    }
    if (w.after_round === undefined || !Number.isInteger(w.after_round) || w.after_round < 0 || w.after_round > totalRounds) {
      throw validation([`params.withdrawals[${i}].after_round`], 'after_round outside 0..round_count.');
    }
  }

  const withdrawalMap = new Map();
  for (const w of withdrawals) {
    withdrawalMap.set(w.team_id, w.after_round);
  }

  // Circle method
  const circleList = [...teams];
  const hasDummy = n % 2 !== 0;
  if (hasDummy) {
    circleList.push(null); // dummy for bye
  }
  const N = circleList.length; // even number
  const half = N / 2;

  const leg1Rounds = [];

  for (let r = 0; r < roundsPerLeg; r++) {
    const roundMatches = [];
    const roundByes = [];

    for (let i = 0; i < half; i++) {
      const t1 = circleList[i];
      const t2 = circleList[N - 1 - i];

      if (t1 === null) {
        if (t2 !== null) roundByes.push(t2);
      } else if (t2 === null) {
        roundByes.push(t1);
      } else {
        // Balance home/away: alternate fixed team slot
        let home = t1;
        let away = t2;
        if (i === 0 && r % 2 === 1) {
          home = t2;
          away = t1;
        } else if (i > 0 && (i + r) % 2 === 1) {
          home = t2;
          away = t1;
        }
        roundMatches.push({ home, away });
      }
    }

    leg1Rounds.push({ matches: roundMatches, byes: roundByes });

    // Rotate circle elements (keep index 0 fixed)
    const fixed = circleList[0];
    const rest = circleList.slice(1);
    const last = rest.pop();
    rest.unshift(last);
    circleList[0] = fixed;
    for (let k = 0; k < rest.length; k++) {
      circleList[k + 1] = rest[k];
    }
  }

  const allRounds = [];
  let summaryTotal = 0;
  let summaryScheduled = 0;
  let summaryForfeit = 0;
  let summaryVoided = 0;

  for (let leg = 1; leg <= legs; leg++) {
    for (let rIdx = 0; rIdx < roundsPerLeg; rIdx++) {
      const globalRound = (leg - 1) * roundsPerLeg + (rIdx + 1);
      const baseRound = leg1Rounds[rIdx];

      const matchesOut = [];
      for (let mIdx = 0; mIdx < baseRound.matches.length; mIdx++) {
        const pair = baseRound.matches[mIdx];
        const home = leg === 1 ? pair.home : pair.away;
        const away = leg === 1 ? pair.away : pair.home;

        let status = 'scheduled';
        let awarded_to = null;

        const homeW = withdrawalMap.has(home) ? withdrawalMap.get(home) : null;
        const awayW = withdrawalMap.has(away) ? withdrawalMap.get(away) : null;

        if (policy === 'void_all') {
          if (homeW !== null || awayW !== null) {
            status = 'voided';
          }
        } else {
          // forfeit_remaining
          const homeWithdrawn = homeW !== null && globalRound > homeW;
          const awayWithdrawn = awayW !== null && globalRound > awayW;

          if (homeWithdrawn && awayWithdrawn) {
            status = 'voided';
          } else if (homeWithdrawn) {
            status = 'forfeit';
            awarded_to = away;
          } else if (awayWithdrawn) {
            status = 'forfeit';
            awarded_to = home;
          }
        }

        summaryTotal++;
        if (status === 'scheduled') summaryScheduled++;
        else if (status === 'forfeit') summaryForfeit++;
        else if (status === 'voided') summaryVoided++;

        matchesOut.push({
          match_id: `RR-L${leg}-R${globalRound}-M${mIdx + 1}`,
          leg,
          home,
          away,
          status,
          awarded_to,
        });
      }

      allRounds.push({
        round: globalRound,
        matches: matchesOut,
        byes: baseRound.byes,
      });
    }
  }

  return {
    format: 'round_robin',
    legs,
    team_count: n,
    round_count: totalRounds,
    rounds: allRounds,
    summary: {
      total: summaryTotal,
      scheduled: summaryScheduled,
      forfeit: summaryForfeit,
      voided: summaryVoided,
    },
  };
}

module.exports = { generateRoundRobin };
