import { badRequest } from '../errors.js';

/**
 * Code Deployment & Update Management (จำลอง)
 *
 * Bot Simulator ไม่มีคำสั่ง "update" และตาราง oxide_bot_commands อนุญาตแค่ start/stop/restart/status
 * (และห้ามทำ migration เพิ่ม) จึงจำลองการอัปเดตดังนี้:
 *   - เลือกบอทเป้าหมาย: ทั้งหมด (botIds ว่าง/ไม่ส่ง) หรือรายเครื่อง
 *   - บอทที่ online: บันทึก audit log แล้วสั่ง restart (ขั้นตอนที่บอทจริงทำหลังเปลี่ยนโค้ด) ผ่านระบบคำสั่งปกติ
 *   - บอทที่ไม่ online: ข้าม (skipped) — ไม่สั่ง restart เพราะจะทำให้บอทที่ตั้งใจปิดไว้เปิดขึ้นมาเอง
 * การอัปโหลดไฟล์ zip จริงไม่ได้ทำ (ไม่มีที่เก็บไฟล์ใน schema) รับเพียงชื่อ/เวอร์ชันของแพ็กเกจ
 */
export function createDeploymentService({ db, commands }) {
  async function deploy({ packageName, botIds, actor = 'dashboard' }) {
    if (typeof packageName !== 'string' || !packageName.trim() || packageName.length > 200) {
      throw badRequest('packageName ต้องเป็นข้อความ 1–200 ตัวอักษร');
    }
    if (botIds !== undefined && (!Array.isArray(botIds) || botIds.some((b) => typeof b !== 'string'))) {
      throw badRequest('botIds ต้องเป็น array ของ id บอท (หรือไม่ส่งเพื่อเลือกทุกเครื่อง)');
    }
    const { rows: all } = await db.query('SELECT id, status FROM oxide_bot_agents ORDER BY id');
    const targets = botIds?.length ? botIds : all.map((b) => b.id);
    const known = new Map(all.map((b) => [b.id, b.status]));
    const unknown = targets.filter((id) => !known.has(id));
    if (unknown.length) throw badRequest(`ไม่พบบอท: ${unknown.join(', ')}`, 'bot_not_found');

    const results = [];
    for (const id of targets) {
      if (known.get(id) !== 'online') {
        results.push({ botId: id, outcome: 'skipped', reason: `บอท ${known.get(id)}` });
        continue;
      }
      await db.query(
        `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata)
         VALUES ($1, 'deployment.requested', 'bot', $2, $3)`,
        [actor, id, JSON.stringify({ packageName: packageName.trim(), simulated: true })]
      );
      const { command } = await commands.request(id, 'restart', { actor });
      results.push({ botId: id, outcome: command.status === 'success' ? 'updated' : 'failed', commandId: command.id });
    }
    return { packageName: packageName.trim(), simulated: true, results };
  }

  return { deploy };
}
