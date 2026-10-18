# Oxide Monitor — Centralized Bot Monitoring & Order Tracking

Backend API + Dashboard สำหรับดูสถานะและสั่งงานบอทหลายเครื่อง พร้อม State Machine ติดตามออเดอร์
เขียนด้วย **Node.js 22 + Express + `ws` + PostgreSQL** (JavaScript ล้วน ไม่มีขั้นตอน build)

## ติดตั้งและรัน

ต้องมี Node.js 22+ และ Docker (หรือ PostgreSQL 16 เอง)

```bash
npm install
cp .env.example .env                      # ค่าเริ่มต้นใช้ได้เลยกับ docker-compose ที่ให้มา

docker compose up -d postgres             # PostgreSQL ที่ localhost:55432
npm run db:init                           # รัน db/schema.sql + db/seed.sql (หรือใช้ psql ตาม README เดิมก็ได้)

npm run simulator                         # เทอร์มินัล 1: Bot Simulator  → http://localhost:8788
npm start                                 # เทอร์มินัล 2: Backend + Dashboard → http://localhost:3000
```

เปิด <http://localhost:3000> เพื่อใช้ Dashboard, ใช้ `requests.http` (VS Code REST Client) ทดสอบ API

### ทดสอบอัตโนมัติ

```bash
npm test        # ต้องมี PostgreSQL ที่ DATABASE_URL ใน .env.example/.env เปิดอยู่
```

- test สร้างและใช้ฐานข้อมูลแยกชื่อ `oxide_monitor_test` เอง (ไม่แตะข้อมูลของ `oxide_monitor`) — ผู้ใช้ใน `DATABASE_URL` ต้องสร้างฐานข้อมูลได้ (user `oxide` ของ docker-compose ทำได้) หรือกำหนด `TEST_DATABASE_URL` เอง
- ชุดทดสอบ 50 ข้อ ใช้ PostgreSQL จริง (ไม่ mock) เพราะสิ่งที่ต้องพิสูจน์คือพฤติกรรมของ lock/transaction

## สถาปัตยกรรม

```
Dashboard ⇄ (REST + WebSocket /ws) ⇄ Express API ⇄ PostgreSQL
                                        │
                              BotGateway + Monitor loop
                                        │
                                Bot Simulator :8788 (REST)
```

| ส่วน | หน้าที่ |
|---|---|
| `src/services/orders.js` | สร้างออเดอร์, เปลี่ยนสถานะ, จ่ายงาน (หัวใจของเรื่อง concurrency/idempotency) |
| `src/orders/stateMachine.js` | กติกาการเปลี่ยนสถานะ (ฟังก์ชันล้วน ทดสอบง่าย) |
| `src/services/commands.js` | คิวคำสั่งควบคุมบอท + `Idempotency-Key` + กู้คืนคำสั่งค้าง |
| `src/services/monitor.js` | poll บอท, ตรวจ heartbeat timeout, ปรับสถานะออเดอร์, จ่ายงานอัตโนมัติ |
| `src/services/gateway.js` | adapter ติดต่อบอท (timeout + retry/backoff) สลับเป็น WebSocket/MQTT ได้ที่นี่จุดเดียว |
| `src/services/killSwitch.js` | สวิตช์เปิด/ปิดทั้งระบบ |
| `src/ws.js` | ส่ง snapshot ไป Dashboard เมื่อข้อมูลเปลี่ยน |

**ทำไม poll แทน WebSocket/MQTT ฝั่งบอท:** Simulator ที่ให้มาเป็น REST ล้วน บอทจึง "ส่ง heartbeat เอง" ไม่ได้ Backend จึง poll `GET /bots` ทุก `POLL_INTERVAL_MS` และถือว่าบอทที่ตอบกลับสถานะ `online` = ยังมีชีวิต ส่วนฝั่ง Dashboard ใช้ WebSocket ตามข้อเสนอแนะของโจทย์ (มี polling สำรองทุก 10 วินาที)

## State machine ของออเดอร์

```
PENDING_PAYMENT ─► QUEUED ─► IN_PROGRESS ─► COMPLETED
       │              │          │  ▲
       │              │          ▼  │ (บอทเดิมกลับมารายงานผลช้า)
       │              │        DELAYED ─► QUEUED (retry, ถ้ายังมีโควตา)
       │              │          │
       ▼              ▼          ▼
   CANCELLED      CANCELLED    FAILED   (IN_PROGRESS → FAILED / CANCELLED ได้ด้วย)
```

COMPLETED / FAILED / CANCELLED เป็นสถานะปลายทาง ย้อนกลับไม่ได้ ทุกการเปลี่ยนสถานะบันทึกเป็นเหตุการณ์ใน `order_events` (นี่คือ Timeline)

### การตัดสินใจเรื่อง schema (สำคัญ — โปรดอ่าน)

โจทย์ใช้ชื่อสถานะ 7 ค่า แต่ `orders.status` ใน `schema.sql` มี CHECK แค่ 5 ค่า (`pending/processing/completed/failed/cancelled`) และ README ของชุดโจทย์ห้ามทำ migration เพิ่ม จึงออกแบบเป็น 2 ระดับ:

| state (ตามสเปก) | `orders.status` |
|---|---|
| PENDING_PAYMENT, QUEUED | `pending` |
| IN_PROGRESS, DELAYED | `processing` |
| COMPLETED / FAILED / CANCELLED | `completed` / `failed` / `cancelled` |

state ละเอียดเก็บเป็น event `STATE_CHANGED` ล่าสุดใน `order_events` (`payload.to`) พร้อม `botId`, `reason`, `attempt` — ถ้า event ไม่สอดคล้องกับ `status` (เช่น ข้อมูล seed ที่ไม่มี event) ระบบเชื่อ `status` เป็นหลักและใช้ค่าเริ่มต้น (`pending → PENDING_PAYMENT`, `processing → IN_PROGRESS`)

**ข้อดี:** ไม่แก้ schema ตามกติกา, ประวัติครบ, ตรวจย้อนหลังได้ **ข้อเสีย:** การหา state ต้อง join ล่าสุดของ events (ใช้ `LEFT JOIN LATERAL` + index `idx_order_events_order` ที่มีอยู่แล้ว ไม่หนักในระดับนี้) ถ้าทำ migration ได้ ผมจะเพิ่มคอลัมน์ `state` ตรงๆ

ในทำนองเดียวกัน (ไม่มีตารางสำหรับสิ่งเหล่านี้ใน schema):
- **Kill-switch** → แถวล่าสุดของ `audit_logs` (`action='kill_switch.set'`) ได้ประวัติว่าใครสลับเมื่อไหร่ฟรี และทุก instance เห็นค่าตรงกัน (ไม่ cache ในหน่วยความจำ)
- **ออเดอร์นี้อยู่กับบอทตัวไหน** → `payload.botId` ของ event

## เคสปัญหา 5 ข้อ และวิธีแก้

> หมายเหตุ: เอกสารโจทย์ระบุว่ามี "เคสปัญหา 5 ข้อ (concurrency, idempotency, retry)" แต่ไม่ได้แจกแจงรายข้อ ผมจึงตีความเป็น 5 สถานการณ์ด้านล่าง ถ้าโจทย์จริงต่างจากนี้ โครงสร้างที่ทำไว้รองรับการเพิ่มเคสได้ และ test แต่ละข้อชี้ไปที่ไฟล์ที่เกี่ยวข้อง

| # | สถานการณ์ | วิธีแก้ | Test |
|---|---|---|---|
| 1 | **สร้างออเดอร์ซ้ำ / ส่ง webhook ซ้ำ** | `external_order_id` เป็น UNIQUE + `INSERT … ON CONFLICT DO NOTHING` คำขอที่ซ้ำได้ออเดอร์เดิม (HTTP 200) ไม่เกิดแถว/event ซ้ำ ถ้า id เดิมแต่ยอดเงินต่าง → 409 `idempotency_mismatch` (ไม่เงียบ เพราะแปลว่าเป็นข้อมูลคนละชุด) | `orders.test.js` (20 คำขอพร้อมกัน → 1 ออเดอร์) |
| 2 | **จ่ายงาน/เปลี่ยนสถานะพร้อมกัน (race)** | ทุกการเปลี่ยนสถานะอยู่ในทรานแซกชันที่ `SELECT … FOR UPDATE` แถวออเดอร์ก่อน จึงเรียงทีละคำขอ ตัวที่มาทีหลังเห็นสถานะใหม่ → no-op (กดซ้ำ) หรือ 409 (ขัดกัน เช่น COMPLETED vs CANCELLED) จ่ายงานล็อกแถวบอท `FOR UPDATE` ก่อนนับภาระงาน → บอทไม่รับเกิน `BOT_CAPACITY` ตัวจ่ายอัตโนมัติใช้ `SKIP LOCKED` ไม่ชนกับตัวอื่น | `orders.test.js` (10 dispatch พร้อมกัน → จ่ายครั้งเดียว, 5 ออเดอร์/2 บอท → จ่าย 2) |
| 3 | **บอทหลุดกลางงาน** | monitor ตั้งบอทที่ heartbeat เงียบเกิน `HEARTBEAT_TIMEOUT_MS` เป็น `error` แล้วปรับออเดอร์ IN_PROGRESS ของบอทนั้นเป็น **DELAYED** ถ้าเกิน `DELAYED_GRACE_MS` → กลับ QUEUED จ่ายให้บอทอื่น (retry) จนครบ `MAX_DISPATCH_ATTEMPTS` แล้วจึง **FAILED** ทุกขั้น idempotent จึงรันซ้อนได้ ถ้าบอทเดิมกลับมารายงานผลระหว่าง DELAYED ยังรับได้ แต่บอทที่ไม่ใช่เจ้าของงานรายงานไม่ได้ (409 `wrong_bot`) กันบอทเก่าทับผลของบอทที่รับช่วง | `monitor.test.js` |
| 4 | **ปลายทางล้มเหลวชั่วคราว / ผู้ใช้กดซ้ำ** | คำสั่งผ่านคิว `queued → running → success/failed` (claim ด้วย `UPDATE … WHERE status='queued'` ได้คนเดียว) เรียกบอทด้วย timeout + exponential backoff + jitter retry เฉพาะ network/timeout/5xx/429 (4xx ไม่ retry) `Idempotency-Key` ทำให้กดซ้ำ/client retry ไม่ยิงคำสั่งซ้ำ (lock ด้วย advisory lock ตาม key) คำสั่งที่ค้างเพราะ process ตายถูกกู้คืนโดย sweep | `commands.test.js` |
| 5 | **Kill-switch ปิดขณะมีงาน** | ตรวจสวิตช์ **ภายในทรานแซกชันจ่ายงาน** ทั้งแบบมือและอัตโนมัติ ปิดแล้วออเดอร์ใหม่ค้างที่ QUEUED (423 `system_disabled`) งานที่กำลังทำอยู่ไม่ถูกตัดทิ้ง (ปิดเฉพาะการรับงานใหม่ ตามนิยามโจทย์) เปิดคืนแล้วจ่ายต่อได้ สลับค่าเดิมซ้ำ/พร้อมกันเขียน log ครั้งเดียว | `orders.test.js`, `api.test.js` |

## API

| Method | Path | หน้าที่ |
|---|---|---|
| GET | `/health` | ตรวจระบบ + DB |
| GET | `/overview`, `/summary` | บอท + ตัวเลขสรุป + kill-switch (+ ออเดอร์ล่าสุดใน `/overview`) |
| GET | `/bots`, `/bots/:id`, `/bots/:id/commands` | สถานะ, metrics, ประวัติคำสั่ง |
| POST | `/bots/:id/commands` | `{command: start\|stop\|restart\|status}` รองรับ header `Idempotency-Key` |
| GET / PUT | `/system/kill-switch` | `{enabled: boolean}` |
| POST | `/orders` | `{externalOrderId, amount, currency?}` idempotent |
| GET | `/orders`, `/orders/:ref`, `/orders/:ref/timeline` | `:ref` = id ตัวเลข หรือ external id |
| POST | `/orders/:ref/pay` · `/dispatch` · `/cancel` · `/transition` | `transition`: `{to, botId?, reason?, expectedFrom?}` |
| POST | `/deployments` | `{packageName, botIds?}` (จำลอง) |
| GET | `/audit-logs` | log การกระทำ |
| WS | `/ws` | ส่ง `{type:'snapshot', data}` เมื่อข้อมูลเปลี่ยน |

รหัสผิดพลาด: `400` input ผิด · `404` ไม่พบ · `409` ขัดกับสถานะปัจจุบัน (`invalid_transition`, `state_conflict`, `wrong_bot`, `no_bot_available`, `idempotency_mismatch`, …) · `423` ระบบถูกปิดด้วย kill-switch · `502` สั่งบอทแล้วปลายทางล้มเหลว

### นิยามตัวเลขบน Summary Bar
- **Online**: บอทที่ `status = online`
- **Active**: บอท online ที่ระบบเปิดรับงานอยู่ (Kill-switch ปิด → 0)
- **Standby**: Active ที่ยังไม่มีงานในมือ
- **In Progress**: จำนวนออเดอร์ที่อยู่ IN_PROGRESS

ภาพตัวอย่างในโจทย์ไม่ได้ให้นิยามของ Active/Standby ไว้ นี่คือการตีความของผม ปรับได้ที่ `src/services/bots.js`

## ข้อจำกัดที่ทราบ (บอกตรงๆ)

- **อัปเดตโค้ด (Deployment) เป็นการจำลอง** Simulator ไม่มีคำสั่ง update และ `oxide_bot_commands` อนุญาตแค่ start/stop/restart/status ระบบจึงบันทึก audit log แล้วสั่ง `restart` กับบอทที่ online (ข้ามบอทที่ปิดอยู่) ไม่มีการอัปโหลด/เก็บไฟล์ zip จริง
- **ไม่มีระบบ login/สิทธิ์** ผู้กระทำอ่านจาก header `X-Actor` (ค่าเริ่มต้น `dashboard`) ใช้ได้เฉพาะ local ตามขอบเขตโจทย์ ก่อนขึ้น production ต้องเพิ่ม authentication
- `Idempotency-Key` ค้นจาก `audit_logs.metadata` (ไม่มี index เพราะห้ามแก้ schema) พอเมื่อข้อมูลระดับหลักหมื่นแถว ถ้าโตกว่านั้นควรเพิ่มคอลัมน์/ตารางเฉพาะ
- "บอทปฏิเสธรับงานทันที" เมื่อปิด kill-switch ทำได้ฝั่ง Backend (ไม่จ่ายงานใหม่) เพราะ Simulator ไม่มีช่องทางให้ push สถานะ switch ไปยังบอท
- Live Demo ที่โจทย์ขอ ต้อง deploy เอง (ในที่นี้ทดสอบบน localhost เท่านั้น)

## การใช้ AI ในงานนี้

งานนี้พัฒนาโดยใช้ AI (Claude) ช่วยออกแบบและเขียนโค้ด สิ่งที่ตรวจสอบจริงไม่ได้เชื่อตามที่ AI เขียน:
- รัน test 50 ข้อกับ PostgreSQL 16 จริงหลายรอบ (รวมเคส race ที่ยิงคำขอพร้อมกัน)
- รันระบบจริงคู่กับ Simulator: จ่ายงาน → หยุดบอทที่ถืองาน → DELAYED → retry ไปบอทอื่น และฆ่า Simulator เพื่อดู heartbeat timeout ทำงานจริง
- จุดที่ AI ตัดสินใจแทนผู้ใช้ (เช่น นิยาม Active/Standby, การตีความ "เคส 5 ข้อ", การเก็บ state ละเอียดใน events) ถูกระบุไว้ในเอกสารนี้เพื่อให้โต้แย้งได้

ส่วนที่ **ยังไม่ได้ทดสอบ**: หน้า Dashboard บนเบราว์เซอร์จริง (ตรวจแค่ว่าสคริปต์ผ่าน syntax, ไฟล์ถูกเสิร์ฟ และ WebSocket ส่ง snapshot ถูกต้อง) ควรเปิดดูด้วยตา
