// Real-Postgres test helper. Set TEST_DATABASE_URL to run the DB tests;
// without it they are skipped. Each caller gets its own schema, dropped
// afterwards, so test files can run in parallel against one database.

import pg from 'pg';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function freshSchema(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
  return {
    pool,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`drop schema ${schema} cascade`);
      await c.end();
    },
  };
}
