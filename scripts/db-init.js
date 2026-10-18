// สร้างตารางและข้อมูลตัวอย่างโดยไม่ต้องมี psql ในเครื่อง: npm run db:init
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('ไม่พบ DATABASE_URL — คัดลอก .env.example เป็น .env ก่อน');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
for (const file of ['db/schema.sql', 'db/seed.sql']) {
  await client.query(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  console.log(`รัน ${file} แล้ว`);
}
await client.end();
