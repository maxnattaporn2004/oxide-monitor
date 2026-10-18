/**
 * State machine ของออเดอร์
 *
 * ตาราง orders ที่โจทย์ให้มา มี status เพียง 5 ค่า (pending/processing/completed/failed/cancelled)
 * และห้ามทำ migration เพิ่ม จึงแยกเป็น 2 ระดับ:
 *   - "coarse status" เก็บใน orders.status (ค่าที่ CHECK constraint อนุญาต)
 *   - "state" ละเอียดตามสเปก (PENDING_PAYMENT, QUEUED, IN_PROGRESS, DELAYED, ...)
 *     เก็บเป็นเหตุการณ์ STATE_CHANGED ล่าสุดใน order_events (payload.to)
 */
export const STATES = ['PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'DELAYED', 'COMPLETED', 'FAILED', 'CANCELLED'];

export const COARSE = {
  PENDING_PAYMENT: 'pending',
  QUEUED: 'pending',
  IN_PROGRESS: 'processing',
  DELAYED: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

export const TRANSITIONS = {
  PENDING_PAYMENT: ['QUEUED', 'CANCELLED'],
  QUEUED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'DELAYED', 'CANCELLED'],
  // DELAYED: บอทหลุด — กลับเข้าคิว (retry) / ล้มเหลว / บอทเดิมกลับมารายงานผลช้า / ยกเลิก
  DELAYED: ['QUEUED', 'FAILED', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
};

export const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** state ที่ต้องจำ botId ต่อไปเมื่อเปลี่ยนสถานะ (ใช้ตรวจว่าบอทที่รายงานผลเป็นบอทที่ได้รับงานจริง) */
export const CARRY_BOT = new Set(['DELAYED', 'COMPLETED', 'FAILED']);

export const isState = (s) => STATES.includes(s);
export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

const DEFAULT_BY_COARSE = {
  pending: 'PENDING_PAYMENT',
  processing: 'IN_PROGRESS',
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED'
};

/**
 * หา state ละเอียดของออเดอร์ จาก coarse status + state ล่าสุดในตาราง events
 * ถ้า event ไม่สอดคล้องกับ coarse status (เช่น ข้อมูล seed ที่ไม่มี event) ให้ถือ coarse status เป็นหลัก
 */
export function deriveState(coarseStatus, lastEventState) {
  if (lastEventState && COARSE[lastEventState] === coarseStatus) return lastEventState;
  return DEFAULT_BY_COARSE[coarseStatus];
}
