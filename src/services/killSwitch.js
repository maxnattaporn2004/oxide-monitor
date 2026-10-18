/**
 * Global kill-switch
 *
 * schema ที่ให้มาไม่มีตารางเก็บค่าตั้งระบบ และห้ามทำ migration เพิ่ม
 * จึงใช้ audit_logs เป็น "log แบบ append-only" โดยค่าปัจจุบัน = แถวล่าสุดของ action 'kill_switch.set'
 * ข้อดี: ได้ประวัติว่าใครสลับสวิตช์เมื่อไหร่ฟรี และทุก instance ของ backend เห็นค่าตรงกันเสมอ
 * (ไม่ cache ในหน่วยความจำ) ค่าเริ่มต้นเมื่อยังไม่เคยตั้ง = เปิดระบบ
 */
export function createKillSwitch({ db, hub }) {
  async function read(client = db) {
    const { rows } = await client.query(
      `SELECT actor, created_at, (metadata->>'enabled')::boolean AS enabled
         FROM audit_logs WHERE action = 'kill_switch.set' ORDER BY id DESC LIMIT 1`
    );
    if (!rows.length) return { enabled: true, changedAt: null, changedBy: null };
    return { enabled: rows[0].enabled, changedAt: rows[0].created_at, changedBy: rows[0].actor };
  }

  const isEnabled = async (client = db) => (await read(client)).enabled;

  /** idempotent: ตั้งค่าเดิมซ้ำจะไม่เขียน log ใหม่ และ lock กันสองคนกดพร้อมกัน */
  async function set(enabled, actor) {
    const result = await db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('kill_switch'))`);
      const current = await read(c);
      if (current.enabled === enabled && current.changedAt) return { changed: false, state: current };
      await c.query(
        `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata)
         VALUES ($1, 'kill_switch.set', 'system', 'global', $2)`,
        [actor, JSON.stringify({ enabled })]
      );
      return { changed: true, state: await read(c) };
    });
    if (result.changed) hub.notify();
    return result;
  }

  return { read, isEnabled, set };
}
