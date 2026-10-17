'use strict';

const request = require('supertest');
const app = require('../src/app');
const { recursiveSeedOrder } = require('../src/domain/fixtures/single_elim');

describe('Fixtures Generation (§5.7)', () => {
  describe('Round Robin', () => {
    test('generates balanced 1-leg round robin with circle method', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'round_robin',
        teams: ['A', 'B', 'C', 'D'],
        params: { legs: 1 },
      });
      expect(res.status).toBe(200);
      expect(res.body.format).toBe('round_robin');
      expect(res.body.round_count).toBe(3);
      expect(res.body.summary.scheduled).toBe(6);
    });

    test('generates 2-leg round robin with global round numbering and reversed home/away', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'round_robin',
        teams: ['A', 'B', 'C'],
        params: { legs: 2 },
      });
      expect(res.status).toBe(200);
      expect(res.body.legs).toBe(2);
      expect(res.body.round_count).toBe(6);
      expect(res.body.rounds[5].round).toBe(6);
    });

    test('withdrawal policy: forfeit_remaining awards remaining games to opponents', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'round_robin',
        teams: ['A', 'B', 'C', 'D'],
        params: {
          legs: 1,
          withdrawals: [{ team_id: 'D', after_round: 1 }],
          withdrawal_policy: 'forfeit_remaining',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.summary.forfeit).toBe(2); // D's games in round 2 and 3 forfeited
    });
  });

  describe('Single Elimination', () => {
    test('seed order verification against recursive formula order(8) = [1,8,4,5,2,7,3,6]', () => {
      expect(recursiveSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    });

    test('generates bracket, handles byes, and third place match', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'single_elim',
        teams: ['T1', 'T2', 'T3', 'T4', 'T5'],
        params: {
          third_place_match: true,
          results: [
            { match_id: 'R1M2', winner: 'T4' },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.bracket_size).toBe(8);
      const lastRound = res.body.rounds[res.body.rounds.length - 1];
      const tp = lastRound.matches.find((m) => m.match_id === 'TP');
      expect(tp).toBeDefined();
    });
  });

  describe('Swiss', () => {
    test('Round 1 pairing is exact: pairs seed i with seed i+m and last seed gets bye for odd n', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'swiss',
        teams: ['A', 'B', 'C', 'D', 'E'],
        params: { round: 1 },
      });
      expect(res.status).toBe(200);
      expect(res.body.bye).toBe('E');
      expect(res.body.pairings).toEqual([
        { match_id: 'SW-R1M1', home: 'A', away: 'C' },
        { match_id: 'SW-R1M2', home: 'B', away: 'D' },
      ]);
    });

    test('Round 2 pairing avoids rematches and respects standings with Buchholz', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'swiss',
        teams: ['A', 'B', 'C', 'D'],
        params: {
          round: 2,
          history: [
            {
              round: 1,
              matches: [
                { home: 'A', away: 'C', result: 'home' },
                { home: 'B', away: 'D', result: 'away' },
              ],
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.pairings.length).toBe(2);
      // Rematch between A-C and B-D prohibited
      for (const p of res.body.pairings) {
        const pairStr = [p.home, p.away].sort().join('-');
        expect(pairStr).not.toBe('A-C');
        expect(pairStr).not.toBe('B-D');
      }
    });
  });

  describe('Double Elimination', () => {
    test('generates winners, losers, and conditional grand final with bracket reset', async () => {
      const res = await request(app).post('/audit/v1/fixtures').send({
        format: 'double_elim',
        teams: ['T1', 'T2', 'T3', 'T4'],
        params: {
          bracket_reset: true,
          results: [
            { match_id: 'WR1M1', winner: 'T1' },
            { match_id: 'WR1M2', winner: 'T2' },
            { match_id: 'LR1M1', winner: 'T4' },
            { match_id: 'WR2M1', winner: 'T1' },
            { match_id: 'LR2M1', winner: 'T2' },
            { match_id: 'GF1', winner: 'T2' }, // Losers bracket champion beats winners champion
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.bracket_size).toBe(4);
      expect(res.body.grand_final.length).toBe(2);
      const gf2 = res.body.grand_final[1];
      expect(gf2.conditional).toBe(true);
      expect(gf2.required).toBe(true); // GF1 won by away team -> reset required!
    });
  });
});
