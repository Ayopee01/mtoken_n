// ==========================================
// app.js (test2 + Register)
// ==========================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Serve Frontend
app.use('/test2', express.static(path.join(__dirname, 'public')));

// --- Token API validate ---
async function getGdxToken() {
  try {
    const res = await axios.get(process.env.GDX_AUTH_URL, {
      params: { ConsumerSecret: process.env.CONSUMER_SECRET, AgentID: process.env.AGENT_ID },
      headers: { 'Consumer-Key': process.env.CONSUMER_KEY, 'Content-Type': 'application/json' }
    });
    return res.data.Result;
  } catch (e) {
    console.error("❌ Failed to get GDX Token:", e.message);
    throw new Error("Cannot get GDX Token");
  }
}

const router = express.Router();

// --- ensure table + columns ---
async function ensureTable() {
  // 1) create table (เดิม)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_data (
      user_id VARCHAR(255) PRIMARY KEY,
      citizen_id VARCHAR(255) UNIQUE,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      date_of_birth VARCHAR(255),
      mobile VARCHAR(255),
      email VARCHAR(255),
      notification VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2) add register columns (สำคัญ: CREATE TABLE ไม่ alter ของเดิม)
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS is_registered BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS registered_at TIMESTAMP NULL;`);
}

// ------------------------------------------------------------------
// 1) LOGIN
// ------------------------------------------------------------------
router.post('/auth/login', async (req, res) => {
  const { appId, mToken } = req.body;
  let debugInfo = { step1: null, step2: null, step3: false };

  if (!appId || !mToken) return res.status(400).json({ status: 'error', message: 'Missing Data' });

  try {
    await ensureTable();

    console.log('🔹 Login Step 1: Requesting Token...');
    const token = await getGdxToken();
    debugInfo.step1 = token;

    console.log('🔹 Login Step 2: Requesting Profile...');
    const deprocRes = await axios.post(
      process.env.DEPROC_API_URL,
      { AppId: appId, MToken: mToken },
      { headers: { 'Consumer-Key': process.env.CONSUMER_KEY, 'Token': token, 'Content-Type': 'application/json' } }
    );
    debugInfo.step2 = deprocRes.data;

    const pData = deprocRes.data.result;
    if (!pData) throw new Error("Deproc returned NULL (Token Expired)");

    console.log('🔹 Login Step 3: Saving DB...');

    // upsert แบบเดิม แต่ใส่ is_registered default (ถ้ามีอยู่แล้วจะไม่ทับ)
    await pool.query(`
      INSERT INTO personal_data (user_id, citizen_id, first_name, last_name, date_of_birth, mobile, email, notification)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (citizen_id) DO UPDATE SET 
        first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        mobile     = EXCLUDED.mobile,
        email      = EXCLUDED.email,
        notification = EXCLUDED.notification;
    `, [
      pData.userId,
      pData.citizenId,
      pData.firstName,
      pData.lastName,
      pData.dateOfBirthString,
      pData.mobile,
      pData.email,
      pData.notification
    ]);

    debugInfo.step3 = true;

    // ✅ เช็คว่า register แล้วหรือยัง
    const check = await pool.query(
      `SELECT is_registered FROM personal_data WHERE user_id = $1 LIMIT 1;`,
      [pData.userId]
    );

    const isRegistered = !!check.rows?.[0]?.is_registered;
    const needsRegister = !isRegistered;

    return res.json({
      status: 'success',
      message: 'Login successful',
      needsRegister,
      debug: debugInfo,
      data: {
        firstName: pData.firstName,
        lastName: pData.lastName,
        userId: pData.userId,
        citizenId: pData.citizenId,
        appId: appId
      }
    });

  } catch (error) {
    console.error('❌ Login Error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message, debug: debugInfo });
  }
});

// ------------------------------------------------------------------
// 2) REGISTER (เพิ่มใหม่)
// ------------------------------------------------------------------
router.post('/auth/register', async (req, res) => {
  const { userId, password } = req.body || {};
  const PASS = process.env.REGISTER_PASS || 'Bz12345'; // ✅ ตามที่คุณให้มา

  if (!userId) return res.status(400).json({ status: 'error', message: 'Missing userId' });
  if (!password) return res.status(400).json({ status: 'error', message: 'Missing password' });
  if (password !== PASS) return res.status(401).json({ status: 'error', message: 'Invalid password' });

  try {
    await ensureTable();

    const found = await pool.query(`SELECT user_id, is_registered FROM personal_data WHERE user_id=$1 LIMIT 1;`, [userId]);
    if (found.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found in DB (login first)' });
    }

    await pool.query(
      `UPDATE personal_data SET is_registered=true, registered_at=NOW() WHERE user_id=$1;`,
      [userId]
    );

    return res.json({ status: 'success', message: 'Register successful', data: { userId } });
  } catch (e) {
    console.error('❌ Register Error:', e.message);
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

// ------------------------------------------------------------------
// 3) NOTIFICATION (เหมือนเดิม)
// ------------------------------------------------------------------
router.post('/notify/send', async (req, res) => {
  console.log("🚀 [START] /notify/send");

  const { appId, userId, message } = req.body;

  if (!appId || !userId) {
    return res.status(400).json({ success: false, message: "Missing appId or userId" });
  }

  try {
    const token = await getGdxToken();

    const headers = {
      "Consumer-Key": process.env.CONSUMER_KEY,
      "Content-Type": "application/json",
      "Token": token
    };

    const body = {
      appId: appId,
      data: [{ message: message || "ทดสอบแจ้งเตือนจาก test2", userId }],
      sendDateTime: null
    };

    const response = await axios.post(process.env.NOTIFICATION_API_URL, body, { headers });

    return res.json({
      success: true,
      message: "ส่ง Notification สำเร็จ",
      result: response.data
    });

  } catch (err) {
    console.error("💥 Notify Error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "เกิดข้อผิดพลาดในการส่ง Notification",
      error: err.response?.data || err.message
    });
  }
});

app.use('/test2', router);

app.listen(process.env.PORT || 3005, () => {
  console.log(`🚀 test2 running on port ${process.env.PORT || 3005}`);
});
