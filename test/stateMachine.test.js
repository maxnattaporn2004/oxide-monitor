import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COARSE, STATES, TERMINAL, TRANSITIONS, canTransition, deriveState } from '../src/orders/stateMachine.js';

test('เส้นทางปกติ: PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED', () => {
  assert.ok(canTransition('PENDING_PAYMENT', 'QUEUED'));
  assert.ok(canTransition('QUEUED', 'IN_PROGRESS'));
  assert.ok(canTransition('IN_PROGRESS', 'COMPLETED'));
});

test('ข้ามขั้นไม่ได้', () => {
  assert.equal(canTransition('PENDING_PAYMENT', 'IN_PROGRESS'), false);
  assert.equal(canTransition('PENDING_PAYMENT', 'COMPLETED'), false);
  assert.equal(canTransition('QUEUED', 'COMPLETED'), false);
});

test('state ปลายทางย้อนกลับไม่ได้', () => {
  for (const s of TERMINAL) {
    for (const to of STATES) assert.equal(canTransition(s, to), false, `${s} → ${to}`);
  }
});

test('บอทหลุด: IN_PROGRESS → DELAYED → (QUEUED | FAILED)', () => {
  assert.ok(canTransition('IN_PROGRESS', 'DELAYED'));
  assert.ok(canTransition('DELAYED', 'QUEUED'));
  assert.ok(canTransition('DELAYED', 'FAILED'));
});

test('ทุก state มีนิยามการเปลี่ยนและ coarse status ที่ตรงกับ CHECK ของ schema', () => {
  const allowed = new Set(['pending', 'processing', 'completed', 'failed', 'cancelled']);
  for (const s of STATES) {
    assert.ok(s in TRANSITIONS, `${s} ไม่มีใน TRANSITIONS`);
    assert.ok(allowed.has(COARSE[s]), `${s} → ${COARSE[s]} ไม่อยู่ใน CHECK`);
  }
});

test('deriveState: ใช้ event ล่าสุดเมื่อสอดคล้อง, ไม่งั้นใช้ค่าเริ่มต้นตาม coarse status (ข้อมูล seed)', () => {
  assert.equal(deriveState('pending', 'QUEUED'), 'QUEUED');
  assert.equal(deriveState('processing', 'DELAYED'), 'DELAYED');
  assert.equal(deriveState('pending', null), 'PENDING_PAYMENT');
  assert.equal(deriveState('processing', null), 'IN_PROGRESS');
  assert.equal(deriveState('completed', 'QUEUED'), 'COMPLETED'); // event ไม่สอดคล้อง → เชื่อ coarse status
});
