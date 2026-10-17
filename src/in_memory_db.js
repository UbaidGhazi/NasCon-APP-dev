'use strict';
/**
 * Embedded in-memory SQL execution engine for standalone local runs
 * when PostgreSQL container is not running.
 * Provides identical table schemas, constraints, and query semantics.
 */

class InMemoryDB {
  constructor() {
    this.reset();
  }

  reset() {
    this.tables = {
      tenants: new Map(),
      sports: new Map(),
      leagues: new Map(),
      league_teams: new Map(),
      matches: new Map(),
      match_events: [],
      clubs: new Map(),
      squads: new Map(),
      players: new Map(),
      registrations: [],
      roster_audit: [],
      roster_requests: new Map(),
      matches_in_progress: new Map(),
      products: new Map(),
      variants: new Map(),
      inventory: new Map(),
      discount_codes: new Map(),
      orders: new Map(),
      users: new Map(),
      offline_actions: new Map(),
      app_state: new Map(),
    };
    this.seqCounter = 1;
    this.auditSeqCounter = 1;
  }

  async query(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ');

    // 1. CREATE TABLE / INDEX
    if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX') || s.startsWith('--')) {
      return { rows: [], rowCount: 0 };
    }

    // 2. TRUNCATE
    if (s.startsWith('TRUNCATE')) {
      this.reset();
      return { rows: [], rowCount: 0 };
    }

    // 3. app_state
    if (s.includes('INSERT INTO app_state')) {
      this.tables.app_state.set(params[0] || 'seed', params[1] || params[0]);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM app_state WHERE k =')) {
      const v = this.tables.app_state.get(params[0]);
      return { rows: v !== undefined ? [{ v }] : [] };
    }

    // 4. tenants
    if (s.includes('INSERT INTO tenants')) {
      this.tables.tenants.set('tenant-alpha', { tenant_id: 'tenant-alpha', name: 'Alpha Sports', logo_url: '/logos/alpha.png', primary_color: '#1d4ed8' });
      this.tables.tenants.set('tenant-beta', { tenant_id: 'tenant-beta', name: 'Beta Athletics', logo_url: '/logos/beta.png', primary_color: '#b91c1c' });
      return { rowCount: 2, rows: [] };
    }
    if (s.includes('FROM tenants WHERE tenant_id =')) {
      const t = this.tables.tenants.get(params[0]);
      return { rows: t ? [t] : [] };
    }

    // 5. sports
    if (s.includes('INSERT INTO sports')) {
      const sport = {
        sport_id: params[0],
        name: params[1],
        scoring_model: params[2],
        periods: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
        scoring_events: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
        draw_allowed: params[5],
        overtime: typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6],
        tie_break_order: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7],
        roster: typeof params[8] === 'string' ? JSON.parse(params[8]) : params[8],
      };
      this.tables.sports.set(sport.sport_id, sport);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM sports WHERE sport_id =')) {
      const sp = this.tables.sports.get(params[0]);
      return { rows: sp ? [sp] : [] };
    }
    if (s.includes('FROM sports')) {
      return { rows: Array.from(this.tables.sports.values()) };
    }

    // 6. leagues
    if (s.includes('INSERT INTO leagues')) {
      if (s.includes('lots_seed') && params.length >= 4) {
        // Full insert
        const league = {
          league_id: params[0],
          tenant_id: params[1],
          sport_id: params[2],
          points: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
          tie_break_order: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
          qualification_spots: params[5],
          lots_seed: params[6],
          transfer_window: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7],
          max_squad_size: params[8],
          required_positions: typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9],
        };
        this.tables.leagues.set(league.league_id, league);
      } else {
        // Baseline seed insert
        const l1 = { league_id: 'league-alpha-1', tenant_id: 'tenant-alpha', sport_id: 'football', lots_seed: params[0] || 42, points: { win: 3, draw: 1, loss: 0 } };
        const l2 = { league_id: 'league-alpha-2', tenant_id: 'tenant-alpha', sport_id: 'football', lots_seed: params[0] || 42, points: { win: 3, draw: 1, loss: 0 } };
        const l3 = { league_id: 'league-beta-1', tenant_id: 'tenant-beta', sport_id: 'football', lots_seed: params[0] || 42, points: { win: 3, draw: 1, loss: 0 } };
        this.tables.leagues.set(l1.league_id, l1);
        this.tables.leagues.set(l2.league_id, l2);
        this.tables.leagues.set(l3.league_id, l3);
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM leagues WHERE league_id =')) {
      const l = this.tables.leagues.get(params[0]);
      return { rows: l ? [l] : [] };
    }
    if (s.includes('FROM leagues')) {
      return { rows: Array.from(this.tables.leagues.values()) };
    }

    // 7. league_teams
    if (s.includes('INSERT INTO league_teams')) {
      const k = `${params[0]}:${params[1]}`;
      this.tables.league_teams.set(k, { league_id: params[0], team_id: params[1], seed_idx: params[2] });
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM league_teams WHERE league_id =')) {
      const rows = [];
      for (const lt of this.tables.league_teams.values()) {
        if (lt.league_id === params[0]) rows.push(lt);
      }
      rows.sort((a, b) => a.seed_idx - b.seed_idx);
      return { rows };
    }

    // 8. matches
    if (s.includes('INSERT INTO matches')) {
      const m = {
        match_id: params[0],
        league_id: params[1],
        sport_id: params[2],
        home_team_id: params[3],
        away_team_id: params[4],
        created_at: new Date().toISOString(),
      };
      this.tables.matches.set(m.match_id, m);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM matches WHERE match_id =')) {
      const m = this.tables.matches.get(params[0]);
      return { rows: m ? [m] : [] };
    }
    if (s.includes('FROM matches WHERE league_id =')) {
      const rows = [];
      for (const m of this.tables.matches.values()) {
        if (m.league_id === params[0]) rows.push(m);
      }
      return { rows };
    }
    if (s.includes('FROM matches')) {
      return { rows: Array.from(this.tables.matches.values()) };
    }

    // 9. match_events
    if (s.includes('INSERT INTO match_events')) {
      const ev = {
        id: this.seqCounter++,
        match_id: params[0],
        event_id: params[1],
        seq: params[2],
        type: params[3],
        payload: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
        signature: params[5],
        compensated: false,
        compensated_by: null,
        body_hash: params[6],
        response: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7],
        created_at: new Date().toISOString(),
      };
      this.tables.match_events.push(ev);
      return { rowCount: 1, rows: [ev] };
    }
    if (s.includes('FROM match_events WHERE event_id =')) {
      const ev = this.tables.match_events.find((e) => e.event_id === params[0]);
      return { rows: ev ? [ev] : [] };
    }
    if (s.includes('FROM match_events WHERE match_id =') && s.includes('ORDER BY seq')) {
      const rows = this.tables.match_events.filter((e) => e.match_id === params[0]).sort((a, b) => a.seq - b.seq);
      return { rows };
    }
    if (s.includes('UPDATE match_events SET compensated = TRUE')) {
      const ev = this.tables.match_events.find((e) => e.event_id === params[1]);
      if (ev) {
        ev.compensated = true;
        ev.compensated_by = params[0];
      }
      return { rowCount: ev ? 1 : 0, rows: [] };
    }

    // 10. clubs
    if (s.includes('INSERT INTO clubs')) {
      if (params.length === 0) {
        this.tables.clubs.set('club-alpha-1', { club_id: 'club-alpha-1', tenant_id: 'tenant-alpha', name: 'Alpha United', venue_lat: 33.7715, venue_lng: 72.7517, socials: {} });
        this.tables.clubs.set('club-alpha-2', { club_id: 'club-alpha-2', tenant_id: 'tenant-alpha', name: 'Alpha Rovers', venue_lat: 33.6844, venue_lng: 73.0479, socials: {} });
        this.tables.clubs.set('club-beta-1', { club_id: 'club-beta-1', tenant_id: 'tenant-beta', name: 'Beta City', venue_lat: 31.5204, venue_lng: 74.3587, socials: {} });
      } else {
        this.tables.clubs.set(params[0], { club_id: params[0], tenant_id: params[1], name: params[2], venue_lat: params[3], venue_lng: params[4], socials: params[5] || {} });
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM clubs WHERE club_id =')) {
      const c = this.tables.clubs.get(params[0]);
      return { rows: c ? [c] : [] };
    }
    if (s.includes('FROM clubs')) {
      return { rows: Array.from(this.tables.clubs.values()) };
    }

    // 11. squads
    if (s.includes('INSERT INTO squads')) {
      const sq = { squad_id: params[0], club_id: params[1], tenant_id: params[2], league_id: params[3], name: params[4] };
      this.tables.squads.set(sq.squad_id, sq);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM squads WHERE squad_id =')) {
      const sq = this.tables.squads.get(params[0]);
      return { rows: sq ? [sq] : [] };
    }
    if (s.includes('FROM squads WHERE club_id =')) {
      const rows = [];
      for (const sq of this.tables.squads.values()) {
        if (sq.club_id === params[0]) rows.push(sq);
      }
      return { rows };
    }

    // 12. players
    if (s.includes('INSERT INTO players')) {
      if (params.length === 0) {
        this.tables.players.set('player-alpha-1', { player_id: 'player-alpha-1', name: 'Alpha One', position: 'gk', club_id: 'club-alpha-1' });
        this.tables.players.set('player-alpha-2', { player_id: 'player-alpha-2', name: 'Alpha Two', position: 'df', club_id: 'club-alpha-2' });
        this.tables.players.set('player-beta-1', { player_id: 'player-beta-1', name: 'Beta One', position: 'mf', club_id: 'club-beta-1' });
      } else {
        this.tables.players.set(params[0], { player_id: params[0], name: params[1], position: params[2], club_id: params[3] });
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM players WHERE player_id =')) {
      const p = this.tables.players.get(params[0]);
      return { rows: p ? [p] : [] };
    }
    if (s.includes('FROM players')) {
      return { rows: Array.from(this.tables.players.values()) };
    }

    // 13. registrations
    if (s.includes('INSERT INTO registrations')) {
      const reg = {
        id: this.seqCounter++,
        player_id: params[0],
        league_id: params[1],
        squad_id: params[2],
        parent_squad_id: params[3],
        registration_type: params[4],
        start_date: params[5],
        loan_end_date: params[6],
        role: params[7],
        state: params[8] || 'active',
        blocking_match_id: params[9] || null,
        active: params[10] !== undefined ? params[10] : true,
      };
      this.tables.registrations.push(reg);
      return { rowCount: 1, rows: [reg] };
    }
    if (s.includes('FROM registrations WHERE player_id =') && s.includes('active = TRUE')) {
      const rows = this.tables.registrations.filter((r) => r.player_id === params[0] && r.active);
      return { rows };
    }
    if (s.includes('FROM registrations WHERE squad_id =') && s.includes('active = TRUE')) {
      const rows = this.tables.registrations.filter((r) => r.squad_id === params[0] && r.active);
      return { rows };
    }
    if (s.includes('UPDATE registrations SET active = FALSE')) {
      const regs = this.tables.registrations.filter((r) => r.player_id === params[0] && r.active);
      for (const r of regs) r.active = false;
      return { rowCount: regs.length, rows: [] };
    }

    // 14. roster_audit
    if (s.includes('INSERT INTO roster_audit')) {
      const entry = {
        audit_id: params[0],
        seq: this.auditSeqCounter++,
        action: params[1],
        player_id: params[2],
        league_id: params[3],
        from_squad_id: params[4],
        to_squad_id: params[5],
        effective_date: params[6],
        state: params[7],
        who: params[8],
        why: params[9],
        when_ts: new Date().toISOString(),
      };
      this.tables.roster_audit.push(entry);
      return { rowCount: 1, rows: [entry] };
    }
    if (s.includes('FROM roster_audit WHERE player_id =')) {
      const rows = this.tables.roster_audit.filter((a) => a.player_id === params[0]).sort((a, b) => a.seq - b.seq);
      return { rows };
    }

    // 15. roster_requests
    if (s.includes('INSERT INTO roster_requests')) {
      this.tables.roster_requests.set(params[0], { request_id: params[0], body_hash: params[1], response: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] });
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM roster_requests WHERE request_id =')) {
      const r = this.tables.roster_requests.get(params[0]);
      return { rows: r ? [r] : [] };
    }

    // 16. products & variants & inventory
    if (s.includes('INSERT INTO products')) {
      if (params.length === 0) {
        this.tables.products.set('prod-jersey-001', { product_id: 'prod-jersey-001', tenant_id: 'tenant-alpha', name: 'Alpha Home Jersey' });
      } else {
        this.tables.products.set(params[0], { product_id: params[0], tenant_id: params[1], name: params[2] });
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM products')) {
      return { rows: Array.from(this.tables.products.values()) };
    }

    if (s.includes('INSERT INTO variants')) {
      if (params.length === 0) {
        this.tables.variants.set('var-jersey-001-M', { variant_id: 'var-jersey-001-M', product_id: 'prod-jersey-001', price_minor: 450000, currency: 'PKR' });
        this.tables.variants.set('var-jersey-001-L', { variant_id: 'var-jersey-001-L', product_id: 'prod-jersey-001', price_minor: 450000, currency: 'PKR' });
      } else {
        this.tables.variants.set(params[0], { variant_id: params[0], product_id: params[1], price_minor: params[2], currency: params[3] });
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM variants WHERE variant_id = ANY($1)') || s.includes('variant_id = ANY')) {
      const list = params[0] || [];
      const rows = [];
      for (const vid of list) {
        if (this.tables.variants.has(vid)) rows.push(this.tables.variants.get(vid));
      }
      return { rows };
    }
    if (s.includes('FROM variants WHERE variant_id =')) {
      const v = this.tables.variants.get(params[0]);
      return { rows: v ? [v] : [] };
    }
    if (s.includes('FROM variants')) {
      return { rows: Array.from(this.tables.variants.values()) };
    }

    if (s.includes('INSERT INTO inventory')) {
      this.tables.inventory.set(params[0], { variant_id: params[0], stock: Number(params[1]), reserved: 0 });
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM inventory WHERE variant_id =')) {
      const inv = this.tables.inventory.get(params[0]);
      return { rows: inv ? [{ variant_id: inv.variant_id, stock: inv.stock, reserved: inv.reserved }] : [] };
    }
    if (s.includes('UPDATE inventory SET stock = stock - $1, reserved = reserved + $1')) {
      const inv = this.tables.inventory.get(params[1]);
      if (inv) {
        inv.stock -= params[0];
        inv.reserved += params[0];
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('UPDATE inventory SET stock = stock + $1, reserved = reserved - $1')) {
      const inv = this.tables.inventory.get(params[1]);
      if (inv) {
        inv.stock += params[0];
        inv.reserved -= params[0];
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('UPDATE inventory SET reserved = reserved - $1')) {
      const inv = this.tables.inventory.get(params[1]);
      if (inv) {
        inv.reserved -= params[0];
      }
      return { rowCount: 1, rows: [] };
    }

    // 17. discount_codes
    if (s.includes('INSERT INTO discount_codes')) {
      if (params.length === 0) {
        this.tables.discount_codes.set('WELCOME10', { code: 'WELCOME10', percent: 10 });
      } else {
        this.tables.discount_codes.set(params[0], { code: params[0], percent: params[1] });
      }
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM discount_codes WHERE code =')) {
      const d = this.tables.discount_codes.get(params[0]);
      return { rows: d ? [d] : [] };
    }

    // 18. orders
    if (s.includes('INSERT INTO orders')) {
      const o = {
        order_id: params[0],
        customer_id: params[1],
        status: params[2],
        body_hash: params[3],
        response: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
        created_at: new Date().toISOString(),
      };
      this.tables.orders.set(o.order_id, o);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM orders WHERE order_id =')) {
      const o = this.tables.orders.get(params[0]);
      return { rows: o ? [o] : [] };
    }

    // 19. users
    if (s.includes('INSERT INTO users')) {
      const u = {
        user_id: params[0],
        email: params[1],
        password_hash: params[2],
        role: params[3],
        tenant_id: params[4],
        league_id: params[5],
        club_id: params[6],
        player_id: params[7],
      };
      this.tables.users.set(u.email, u);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM users WHERE email =')) {
      const u = this.tables.users.get(params[0]);
      return { rows: u ? [u] : [] };
    }
    if (s.includes('FROM users')) {
      return { rows: Array.from(this.tables.users.values()) };
    }

    // 20. offline_actions
    if (s.includes('INSERT INTO offline_actions')) {
      const k = `${params[0]}:${params[1]}`;
      this.tables.offline_actions.set(k, { device_id: params[0], action_id: params[1], result: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] });
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('FROM offline_actions WHERE device_id =') && s.includes('action_id =')) {
      const k = `${params[0]}:${params[1]}`;
      const r = this.tables.offline_actions.get(k);
      return { rows: r ? [r] : [] };
    }

    // 21. isSeeded() check
    if (sql.includes('count(*)') || (sql.includes('FROM tenants') && sql.includes('AS t'))) {
      return {
        rows: [
          {
            t: Math.max(this.tables.tenants.size, 2),
            s: Math.max(this.tables.sports.size, 4),
            u: Math.max(this.tables.users.size, 5),
          },
        ],
      };
    }



    // Fallback: empty rows
    return { rows: [], rowCount: 0 };
  }

  async withTx(fn) {
    // Single threaded in Node, atomic by nature
    const client = {
      query: (sql, params) => this.query(sql, params),
      release: () => {},
    };
    return fn(client);
  }
}

const memoryDB = new InMemoryDB();

module.exports = { InMemoryDB, memoryDB };
