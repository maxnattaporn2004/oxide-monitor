import pg from 'pg';

// NUMERIC (1700) และ BIGINT (20) ปกติ pg คืนเป็น string — แปลงเป็นตัวเลขให้ใช้งานง่าย
// (ขนาดข้อมูลของงานนี้อยู่ในช่วงที่ Number รองรับได้ปลอดภัย)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export function createDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  /** รันหลายคำสั่งในทรานแซกชันเดียว: สำเร็จพร้อมกัน หรือ rollback พร้อมกัน */
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, query: (text, params) => pool.query(text, params), tx, close: () => pool.end() };
}
