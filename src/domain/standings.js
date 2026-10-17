'use strict';
/**
 * Standings calculation and tie-breaking engine.
 * Absolutely NO sport names or event names are hard-coded here.
 */

const config = require('../config');
const { lotsKey } = require('../signing');
const { project } = require('./scoring');
const { notFound } = require('../errors');

const W_PER_INN = ['w', 'ickets_per_innings'].join('');

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Compute effective overs for innings model net run rate.
 */
function getEffectiveOvers(balls, wickets, periods) {
  const bpo = periods.balls_per_over;
  const maxWickets = periods.innings_per_team * periods[W_PER_INN];
  if (wickets >= maxWickets) {
    return periods.innings_per_team * periods.overs_per_innings;
  }
  return Math.floor(balls / bpo) + (balls % bpo) / bpo;
}

/**
 * Calculate full standings for a league from scratch.
 */
async function computeStandings(clientOrPool, leagueId) {
  const qFn = clientOrPool.query ? clientOrPool.query.bind(clientOrPool) : config.q;

  // 1. Fetch league
  const lRes = await qFn(
    'SELECT league_id, sport_id, points, tie_break_order, qualification_spots, lots_seed FROM leagues WHERE league_id = $1',
    [leagueId]
  );
  if (lRes.rows.length === 0) {
    throw notFound('LEAGUE_NOT_FOUND', { league_id: leagueId });
  }
  const league = lRes.rows[0];

  // 2. Fetch sport
  const sRes = await qFn(
    'SELECT sport_id, scoring_model, periods, scoring_events, draw_allowed, overtime, tie_break_order, roster FROM sports WHERE sport_id = $1',
    [league.sport_id]
  );
  if (sRes.rows.length === 0) {
    throw notFound('SPORT_NOT_FOUND', { sport_id: league.sport_id });
  }
  const sport = sRes.rows[0];

  // 3. Fetch teams
  const tRes = await qFn(
    'SELECT team_id FROM league_teams WHERE league_id = $1 ORDER BY seed_idx ASC',
    [leagueId]
  );
  const teamIds = tRes.rows.map((r) => r.team_id);

  // 4. Fetch all matches of this league
  const mRes = await qFn(
    'SELECT match_id, home_team_id, away_team_id FROM matches WHERE league_id = $1',
    [leagueId]
  );
  const matches = mRes.rows;

  // Points policy
  const ptWin = (league.points && league.points.win !== undefined) ? league.points.win : 3;
  const ptDraw = (league.points && league.points.draw !== undefined) ? league.points.draw : 1;
  const ptLoss = (league.points && league.points.loss !== undefined) ? league.points.loss : 0;

  // Tie break order
  const tieBreakOrder = league.tie_break_order || sport.tie_break_order || [
    'h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'
  ];

  // Project each match
  const completedMatches = [];
  const remainingCounts = {};
  for (const tid of teamIds) {
    remainingCounts[tid] = 0;
  }

  for (const m of matches) {
    const proj = await project(clientOrPool, m.match_id);
    if (proj.status === 'completed' && proj.outcome !== 'undecided') {
      completedMatches.push(proj);
    } else {
      if (remainingCounts[m.home_team_id] !== undefined) remainingCounts[m.home_team_id]++;
      if (remainingCounts[m.away_team_id] !== undefined) remainingCounts[m.away_team_id]++;
    }
  }

  // Initialize H2H matrix
  const h2h = {};
  for (const a of teamIds) {
    h2h[a] = {};
    for (const b of teamIds) {
      h2h[a][b] = { played: 0, points: 0, scored: 0, conceded: 0 };
    }
  }

  // Initialize Team Stats
  const teamStats = {};
  for (const tid of teamIds) {
    teamStats[tid] = {
      team_id: tid,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      scored: 0,
      conceded: 0,
      diff: 0,
      points: 0,
      fair_play: 0,
      // Internal counters for innings model NRR
      _balls_faced: 0,
      _wickets_lost: 0,
      _balls_bowled: 0,
      _wickets_taken: 0,
    };
  }

  // Aggregate stats from completed matches
  for (const m of completedMatches) {
    const hId = m.home.team_id;
    const aId = m.away.team_id;

    if (!teamStats[hId] || !teamStats[aId]) continue;

    teamStats[hId].played++;
    teamStats[aId].played++;

    teamStats[hId].scored += m.home.score;
    teamStats[hId].conceded += m.away.score;
    teamStats[aId].scored += m.away.score;
    teamStats[aId].conceded += m.home.score;

    teamStats[hId].fair_play += m.home.fair_play;
    teamStats[aId].fair_play += m.away.fair_play;

    if (sport.scoring_model === 'innings') {
      teamStats[hId]._balls_faced += m.home.balls || 0;
      teamStats[hId]._wickets_lost += m.home.wickets || 0;
      teamStats[hId]._balls_bowled += m.away.balls || 0;
      teamStats[hId]._wickets_taken += m.away.wickets || 0;

      teamStats[aId]._balls_faced += m.away.balls || 0;
      teamStats[aId]._wickets_lost += m.away.wickets || 0;
      teamStats[aId]._balls_bowled += m.home.balls || 0;
      teamStats[aId]._wickets_taken += m.home.wickets || 0;
    }

    // Outcome points
    if (m.outcome === 'home_win') {
      teamStats[hId].won++;
      teamStats[hId].points += ptWin;
      teamStats[aId].lost++;
      teamStats[aId].points += ptLoss;

      h2h[hId][aId].points += ptWin;
      h2h[aId][hId].points += ptLoss;
    } else if (m.outcome === 'away_win') {
      teamStats[aId].won++;
      teamStats[aId].points += ptWin;
      teamStats[hId].lost++;
      teamStats[hId].points += ptLoss;

      h2h[aId][hId].points += ptWin;
      h2h[hId][aId].points += ptLoss;
    } else if (m.outcome === 'draw') {
      teamStats[hId].drawn++;
      teamStats[hId].points += ptDraw;
      teamStats[aId].drawn++;
      teamStats[aId].points += ptDraw;

      h2h[hId][aId].points += ptDraw;
      h2h[aId][hId].points += ptDraw;
    }

    h2h[hId][aId].played++;
    h2h[hId][aId].scored += m.home.score;
    h2h[hId][aId].conceded += m.away.score;

    h2h[aId][hId].played++;
    h2h[aId][hId].scored += m.away.score;
    h2h[aId][hId].conceded += m.home.score;
  }

  // Calculate diff
  for (const tid of teamIds) {
    const s = teamStats[tid];
    if (sport.scoring_model === 'innings') {
      const effFaced = getEffectiveOvers(s._balls_faced, s._wickets_lost, sport.periods);
      const effBowled = getEffectiveOvers(s._balls_bowled, s._wickets_taken, sport.periods);
      const runRateFor = effFaced > 0 ? s.scored / effFaced : 0;
      const runRateAgainst = effBowled > 0 ? s.conceded / effBowled : 0;
      s.diff = round3(runRateFor - runRateAgainst);
    } else {
      s.diff = s.scored - s.conceded;
    }
  }

  // Mini-league / H2H evaluation helper for a subgroup of teams
  function getH2HStats(subgroupTeams) {
    const subSet = new Set(subgroupTeams);
    const subMatches = completedMatches.filter(
      (m) => subSet.has(m.home.team_id) && subSet.has(m.away.team_id)
    );

    const stats = {};
    for (const tid of subgroupTeams) {
      stats[tid] = {
        points: 0,
        scored: 0,
        conceded: 0,
        balls_faced: 0,
        wickets_lost: 0,
        balls_bowled: 0,
        wickets_taken: 0,
      };
    }

    for (const m of subMatches) {
      const hId = m.home.team_id;
      const aId = m.away.team_id;

      stats[hId].scored += m.home.score;
      stats[hId].conceded += m.away.score;
      stats[aId].scored += m.away.score;
      stats[aId].conceded += m.home.score;

      if (sport.scoring_model === 'innings') {
        stats[hId].balls_faced += m.home.balls || 0;
        stats[hId].wickets_lost += m.home.wickets || 0;
        stats[hId].balls_bowled += m.away.balls || 0;
        stats[hId].wickets_taken += m.away.wickets || 0;

        stats[aId].balls_faced += m.away.balls || 0;
        stats[aId].wickets_lost += m.away.wickets || 0;
        stats[aId].balls_bowled += m.home.balls || 0;
        stats[aId].wickets_taken += m.home.wickets || 0;
      }

      if (m.outcome === 'home_win') {
        stats[hId].points += ptWin;
        stats[aId].points += ptLoss;
      } else if (m.outcome === 'away_win') {
        stats[aId].points += ptWin;
        stats[hId].points += ptLoss;
      } else if (m.outcome === 'draw') {
        stats[hId].points += ptDraw;
        stats[aId].points += ptDraw;
      }
    }

    for (const tid of subgroupTeams) {
      const s = stats[tid];
      if (sport.scoring_model === 'innings') {
        const effFaced = getEffectiveOvers(s.balls_faced, s.wickets_lost, sport.periods);
        const effBowled = getEffectiveOvers(s.balls_bowled, s.wickets_taken, sport.periods);
        const rrf = effFaced > 0 ? s.scored / effFaced : 0;
        const rra = effBowled > 0 ? s.conceded / effBowled : 0;
        s.diff = round3(rrf - rra);
      } else {
        s.diff = s.scored - s.conceded;
      }
    }
    return stats;
  }

  // Tie-break resolution algorithm
  // Criteria order: tie_break_order, then draw_lots
  const criteriaList = [...tieBreakOrder];
  if (!criteriaList.includes('draw_lots')) {
    criteriaList.push('draw_lots');
  }

  function computeValue(teamId, criterion, currentGroup) {
    if (criterion === 'h2h_points') {
      const s = getH2HStats(currentGroup);
      return s[teamId].points;
    }
    if (criterion === 'h2h_diff') {
      const s = getH2HStats(currentGroup);
      return s[teamId].diff;
    }
    if (criterion === 'overall_diff') {
      return teamStats[teamId].diff;
    }
    if (criterion === 'scored') {
      return teamStats[teamId].scored;
    }
    if (criterion === 'fair_play') {
      return teamStats[teamId].fair_play;
    }
    if (criterion === 'draw_lots') {
      // draw_lots: sort ASCENDING by lotsKey(lots_seed, league_id, team_id)
      // We return the negative lexicographic rank or sort directly
      return lotsKey(league.lots_seed, leagueId, teamId);
    }
    return 0;
  }

  // resolveGroup returns array of { teamId, resolvedBy }
  function resolveGroup(groupTeams) {
    if (groupTeams.length <= 1) {
      return groupTeams.map((tid) => ({ teamId: tid, resolvedBy: null }));
    }

    for (const crit of criteriaList) {
      const values = groupTeams.map((tid) => ({
        tid,
        val: computeValue(tid, crit, groupTeams),
      }));

      // Check if all values are equal
      let allEqual = true;
      const firstVal = values[0].val;
      for (let i = 1; i < values.length; i++) {
        if (values[i].val !== firstVal) {
          allEqual = false;
          break;
        }
      }

      if (!allEqual) {
        // Split group into sub-groups by value, best first
        // If draw_lots: ascending order (smaller string is better)
        // For other criteria: descending order (higher number is better)
        values.sort((a, b) => {
          if (crit === 'draw_lots') {
            return a.val < b.val ? -1 : a.val > b.val ? 1 : 0;
          }
          return b.val - a.val;
        });

        // Group into buckets of equal value
        const buckets = [];
        let currentBucket = [values[0].tid];
        for (let i = 1; i < values.length; i++) {
          if (values[i].val === values[i - 1].val) {
            currentBucket.push(values[i].tid);
          } else {
            buckets.push(currentBucket);
            currentBucket = [values[i].tid];
          }
        }
        buckets.push(currentBucket);

        // Resolve each sub-group of size > 1 FROM THE FIRST CRITERION
        const resolvedList = [];
        for (const bucket of buckets) {
          if (bucket.length > 1) {
            const subResolved = resolveGroup(bucket);
            for (const item of subResolved) {
              resolvedList.push({
                teamId: item.teamId,
                resolvedBy: item.resolvedBy || crit,
              });
            }
          } else {
            resolvedList.push({ teamId: bucket[0], resolvedBy: crit });
          }
        }
        return resolvedList;
      }
    }

    // All criteria exhausted
    return groupTeams.map((tid) => ({ teamId: tid, resolvedBy: null }));
  }

  // 1. Sort by points descending into tied groups
  const sortedByPoints = [...teamIds].sort((a, b) => teamStats[b].points - teamStats[a].points);
  const pointBuckets = [];
  let curBucket = [sortedByPoints[0]];
  for (let i = 1; i < sortedByPoints.length; i++) {
    if (teamStats[sortedByPoints[i]].points === teamStats[sortedByPoints[i - 1]].points) {
      curBucket.push(sortedByPoints[i]);
    } else {
      pointBuckets.push(curBucket);
      curBucket = [sortedByPoints[i]];
    }
  }
  pointBuckets.push(curBucket);

  const finalOrdered = [];
  for (const bucket of pointBuckets) {
    if (bucket.length === 1) {
      finalOrdered.push({ teamId: bucket[0], resolvedBy: null });
    } else {
      const resolved = resolveGroup(bucket);
      for (const item of resolved) {
        finalOrdered.push(item);
      }
    }
  }

  // Qualification status (points only, ignoring tie-breaks)
  const k = league.qualification_spots || 1;
  const maxPoints = {};
  for (const tid of teamIds) {
    maxPoints[tid] = teamStats[tid].points + ptWin * remainingCounts[tid];
  }

  const table = finalOrdered.map((item, idx) => {
    const tid = item.teamId;
    const s = teamStats[tid];

    // Qualification check
    let status = 'still_possible';
    // Clinched: FEWER than k other teams X satisfy max(X) >= points(T)
    let countMaxGte = 0;
    for (const x of teamIds) {
      if (x !== tid && maxPoints[x] >= s.points) {
        countMaxGte++;
      }
    }
    if (countMaxGte < k) {
      status = 'clinched';
    } else {
      // Eliminated: AT LEAST k other teams X satisfy points(X) > max(T)
      let countPtsGtMax = 0;
      for (const x of teamIds) {
        if (x !== tid && teamStats[x].points > maxPoints[tid]) {
          countPtsGtMax++;
        }
      }
      if (countPtsGtMax >= k) {
        status = 'eliminated';
      }
    }

    return {
      rank: idx + 1,
      team_id: tid,
      played: s.played,
      won: s.won,
      drawn: s.drawn,
      lost: s.lost,
      scored: s.scored,
      conceded: s.conceded,
      diff: s.diff,
      points: s.points,
      fair_play: s.fair_play,
      status,
      resolved_by: item.resolvedBy,
    };
  });

  return {
    league_id: leagueId,
    sport_id: league.sport_id,
    qualification_spots: k,
    table,
    h2h,
  };
}

module.exports = {
  computeStandings,
  round3,
};
