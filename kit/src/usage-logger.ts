import Database from "better-sqlite3";
import type { UsageEvent } from "./types.js";

export class UsageLogger {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        route TEXT NOT NULL,
        method TEXT NOT NULL,
        payer TEXT,
        amount_usd TEXT NOT NULL,
        network TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('paid','rejected','free')),
        reason TEXT,
        tx_hash TEXT,
        response_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_route ON usage_events(route);
      CREATE INDEX IF NOT EXISTS idx_usage_payer ON usage_events(payer);
      CREATE INDEX IF NOT EXISTS idx_usage_status ON usage_events(status);
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO usage_events
        (timestamp, route, method, payer, amount_usd, network, status, reason, tx_hash, response_ms)
      VALUES
        (@timestamp, @route, @method, @payer, @amountUsd, @network, @status, @reason, @txHash, @responseMs)
    `);
  }

  log(event: UsageEvent): void {
    this.insertStmt.run(event);
  }

  getSummary(sinceMs: number = 0): {
    totalRequests: number;
    paidRequests: number;
    rejectedRequests: number;
    totalRevenueUsd: string;
    uniquePayers: number;
    routes: Array<{
      route: string;
      method: string;
      count: number;
      revenueUsd: string;
    }>;
  } {
    const totals = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN status='paid' THEN 1 END) AS paid,
          COUNT(CASE WHEN status='rejected' THEN 1 END) AS rejected,
          COALESCE(SUM(CASE WHEN status='paid' THEN CAST(amount_usd AS REAL) ELSE 0 END), 0) AS revenue,
          COUNT(DISTINCT CASE WHEN status='paid' THEN payer END) AS unique_payers
         FROM usage_events
         WHERE timestamp >= ?`,
      )
      .get(sinceMs) as {
      total: number;
      paid: number;
      rejected: number;
      revenue: number;
      unique_payers: number;
    };

    const routes = this.db
      .prepare(
        `SELECT
          route,
          method,
          COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN status='paid' THEN CAST(amount_usd AS REAL) ELSE 0 END), 0) AS revenue
         FROM usage_events
         WHERE timestamp >= ?
         GROUP BY route, method
         ORDER BY revenue DESC`,
      )
      .all(sinceMs) as Array<{
      route: string;
      method: string;
      count: number;
      revenue: number;
    }>;

    return {
      totalRequests: totals.total,
      paidRequests: totals.paid,
      rejectedRequests: totals.rejected,
      totalRevenueUsd: totals.revenue.toFixed(6),
      uniquePayers: totals.unique_payers,
      routes: routes.map((r) => ({
        route: r.route,
        method: r.method,
        count: r.count,
        revenueUsd: r.revenue.toFixed(6),
      })),
    };
  }

  recentEvents(limit: number = 50): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT timestamp, route, method, payer, amount_usd AS amountUsd,
                network, status, reason, tx_hash AS txHash, response_ms AS responseMs
         FROM usage_events
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(limit) as UsageEvent[];
    return rows;
  }

  close(): void {
    this.db.close();
  }
}
