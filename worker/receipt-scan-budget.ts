import { DurableObject } from 'cloudflare:workers';

export interface ReceiptScanBudgetEnv {
  RECEIPT_SCAN_DAILY_LIMIT?: string;
}

/** One fixed object owns the whole application's UTC-day inference budget. */
export class ReceiptScanBudget extends DurableObject<ReceiptScanBudgetEnv> {
  constructor(ctx: DurableObjectState, env: ReceiptScanBudgetEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS receipt_scan_budget (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        day TEXT NOT NULL,
        used INTEGER NOT NULL CHECK (used >= 0)
      )
    `);
  }

  async consume(): Promise<boolean> {
    const configured = this.env.RECEIPT_SCAN_DAILY_LIMIT ?? '200';
    if (!/^(0|[1-9]\d*)$/.test(configured)) return false;
    const limit = Number(configured);
    if (!Number.isSafeInteger(limit) || limit === 0) return false;
    return this.ctx.storage.transactionSync(() => {
      const day = new Date().toISOString().slice(0, 10);
      const row = this.ctx.storage.sql
        .exec<{ day: string; used: number }>(
          'SELECT day, used FROM receipt_scan_budget WHERE singleton = 1',
        )
        .toArray()[0];
      const used = row?.day === day ? row.used : 0;
      if (used >= limit) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO receipt_scan_budget (singleton, day, used) VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET day = excluded.day, used = excluded.used`,
        day,
        used + 1,
      );
      return true;
    });
  }
}
