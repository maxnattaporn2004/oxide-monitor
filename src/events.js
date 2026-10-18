import { EventEmitter } from 'node:events';

/**
 * Hub แจ้งเตือน "ข้อมูลเปลี่ยน" ไปยัง WebSocket
 * รวม (debounce) การแจ้งหลายครั้งที่เกิดติดกันให้เหลือครั้งเดียว เพื่อไม่ให้ยิง snapshot ถี่เกินไป
 */
export function createHub(debounceMs = 60) {
  const emitter = new EventEmitter();
  let timer = null;
  return {
    notify() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        emitter.emit('change');
      }, debounceMs);
      timer.unref?.();
    },
    onChange(fn) {
      emitter.on('change', fn);
      return () => emitter.off('change', fn);
    }
  };
}
