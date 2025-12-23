const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const pool = require('./db');
const app = express();
app.use(express.json());
app.use(cors());
require('dotenv').config();

// Serve Frontend
app.use('/test2', express.static(path.join(__dirname, 'public')));

// --- function GDX Authen ---
async function getGdxToken() {
  try {
    //  GET API GDX_AUTH_URL=https://api.egov.go.th/ws/auth/validate
    const res = await axios.get(process.env.GDX_AUTH_URL, {
      // CONSUMER_SECRET, CONSUMER_KEY, AGENT_ID จาก .env เพื่อรับค่า Access Token
      params: { ConsumerSecret: process.env.CONSUMER_SECRET, AgentID: process.env.AGENT_ID },
      headers: { 'Consumer-Key': process.env.CONSUMER_KEY, 'Content-Type': 'application/json' },
    });
    // คืนค่า Result ซึ่งเป็น Access Token
    return res.data.Result;
  } catch (e) {
    console.error('❌ Failed to get GDX Token:', e.message);
    throw new Error('Cannot get GDX Token');
  }
}

// สร้าง Router แล้วทำ API 2 เส้น
const router = express.Router();

// --- Function สร้างตาราง DB (ถ้ายังไม่มี) ---
async function initDb() {
  // สร้างตาราง SQL
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

  // ✅ [เพิ่มใหม่] เพิ่มคอลัมน์ที่อยู่ (ถ้ายังไม่มี)
  // ใช้ ADD COLUMN IF NOT EXISTS เพื่อรองรับกรณีตารางเคยถูกสร้างไปแล้ว
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);`);
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);`);
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS subdistrict VARCHAR(255);`);
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS district VARCHAR(255);`);
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS province VARCHAR(255);`);
  await pool.query(`ALTER TABLE personal_data ADD COLUMN IF NOT EXISTS postcode VARCHAR(20);`);

  console.log('✅ DB schema ready (personal_data + address columns)');
}

// --- Function สร้าง URL สำหรับ Redirect ไปยัง eService ---
function buildEserviceRedirectUrl(appId, userId, citizenId) {
  const base = process.env.ESERVICE_URL || '/test2/eservice.html';
  const q = new URLSearchParams({
    appId: appId || '',
    userId: userId || '',
    citizenId: citizenId || '',
  });
  return `${base}?${q.toString()}`;
}

// --- POST /test2/auth/login เรียกฟังชัน Login ---
router.post('/auth/login', async (req, res) => {
  // รับค่าจาก Frontend
  const { appId, mToken } = req.body;
  // debugInfo เก็บสถานะของแต่ละขั้นตอนหากมีข้อผิดพลาด
  let debugInfo = { step1: null, step2: null, step3: false };
  if (!appId || !mToken) return res.status(400).json({ error: 'Missing Data' });

  try {
    // ขั้นตอนที่ 1: ขอ Access Token ใหม่
    console.log('🔹 Login Step 1: Requesting Token...');
    // เรียก Function getGdxToken ขอ Access Token
    const token = await getGdxToken();
    debugInfo.step1 = token;

    console.log('🔹 Login Step 2: Requesting Profile...');
    // Deproc API URL
    const deprocRes = await axios.post(
      process.env.DEPROC_API_URL,
      // ส่ง AppId กับ MToken
      { AppId: appId, MToken: mToken },
      // เตรียม Header ส่ง Consumer-Key กับ Access Token ที่ได้มา
      { headers: { 'Consumer-Key': process.env.CONSUMER_KEY, Token: token, 'Content-Type': 'application/json' } }
    );
    debugInfo.step2 = deprocRes.data;

    // ตรวจสอบผลลัพธ์จาก Step 1 และ Step 2
    const pData = deprocRes.data.result;
    if (!pData) throw new Error('Deproc returned NULL (Token Expired)');

    // ตรวจเช็ค citizen_id ใน DB ก่อนบันทึก
    console.log('🔹 Login Step 3: Checking DB (citizen_id) before save...');

    // Query ตรวจสอบ citizen_id ในตาราง personal_data
    const chk = await pool.query(
      `SELECT citizen_id, user_id FROM personal_data WHERE citizen_id = $1 LIMIT 1`,
      [pData.citizenId]
    );

    // Step 3 สำเร็จ (ความหมายใหม่: เช็ค DB สำเร็จ)
    debugInfo.step3 = true;

    // ✅ [เพิ่มใหม่] ถ้าพบ citizen_id แล้ว -> ไปหน้า eService ต่อ
    if (chk.rowCount > 0) {
      const redirectUrl = buildEserviceRedirectUrl(appId, pData.userId, pData.citizenId);

      // ส่งผลลัพธ์กลับไปยัง Frontend
      return res.json({
        status: 'exists', // ✅ [เพิ่มใหม่]
        message: 'Citizen already exists, redirecting to eService',
        debug: debugInfo,
        redirectUrl,
      });
    }

    // ถ้าไม่พบ -> ให้ไปหน้า "ลงทะเบียน"
    // โดยส่งข้อมูลที่มีจาก User ให้ prefill และให้ frontend "ล็อคช่องที่มีข้อมูลแล้ว"
    return res.json({
      status: 'need_register',
      message: 'Citizen not found, registration required',
      debug: debugInfo,
      data: {
        prefill: {
          firstName: pData.firstName,
          lastName: pData.lastName,
          userId: pData.userId, // ส่ง userId กลับไป เพื่อใช้ยิง Notify หรือใช้ต่อใน register
          appId: appId,
          citizenId: pData.citizenId,
          dateOfBirth: pData.dateOfBirthString,
          mobile: pData.mobile,
          email: pData.email,
          notification: pData.notification,
        },
      },
    });

  } catch (error) {
    console.error('❌ Login Error:', error.message);
    res.status(500).json({ status: 'error', message: error.message, debug: debugInfo });
  }
});

//--- POST /test2/register เพื่อบันทึกข้อมูลลง DB ---
router.post('/register', async (req, res) => {
  const {
    appId,
    userId,
    citizenId,
    firstName,
    lastName,
    dateOfBirth,
    mobile,
    email,
    notification,
    // Address
    addressLine1,
    addressLine2,
    subdistrict,
    district,
    province,
    postcode,
  } = req.body;

  // ตรวจสอบข้อมูลที่รับมา validate
  if (!citizenId || !firstName || !lastName) {
    // หากไม่มี citizenId, firstName, lastName ให้แจ้ง Missing required fields
    return res.status(400).json({ status: 'error', message: 'Missing required personal fields' });
  }
  // ตรวจสอบข้อมูลที่อยู่
  if (!addressLine1 || !subdistrict || !district || !province || !postcode) {
    // หากไม่มีข้อมูลที่อยู่ที่จำเป็น ให้แจ้ง Missing required address fields
    return res.status(400).json({ status: 'error', message: 'Missing required address fields' });
  }

  try {
    // ✅ [เพิ่มใหม่] บันทึกข้อมูล (ถ้ามี citizen_id ซ้ำให้อัพเดทข้อมูล + ที่อยู่)
    // บันทึกข้อมูลลงตาราง personal_data
    await pool.query(
      `
      INSERT INTO personal_data
        (user_id, citizen_id, first_name, last_name, date_of_birth, mobile, email, notification,
         address_line1, address_line2, subdistrict, district, province, postcode)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (citizen_id) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        mobile     = EXCLUDED.mobile,
        email      = EXCLUDED.email,
        notification = EXCLUDED.notification,
        address_line1 = EXCLUDED.address_line1,
        address_line2 = EXCLUDED.address_line2,
        subdistrict = EXCLUDED.subdistrict,
        district    = EXCLUDED.district,
        province    = EXCLUDED.province,
        postcode    = EXCLUDED.postcode;
      `,
      [
        userId || null,
        citizenId,
        firstName,
        lastName,
        dateOfBirth || null,
        mobile || null,
        email || null,
        notification || null,
        addressLine1,
        addressLine2 || null,
        subdistrict,
        district,
        province,
        postcode,
      ]
    );

    // สร้าง URL สำหรับ Redirect ไปยัง eService
    const redirectUrl = buildEserviceRedirectUrl(appId, userId, citizenId);

    // ส่งผลลัพธ์กลับไปยัง Frontend
    return res.json({
      status: 'success',
      message: 'Register successful',
      redirectUrl,
    });
  } catch (error) {
    console.error('❌ Register Error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Notification API
//--- POST /test2/notify/send เพื่อเรียก Function ส่ง Notification ---
router.post('/notify/send', async (req, res) => {
  console.log('🚀 [START] /notify/send');

  // รับค่าจาก Frontend
  const { appId, userId, message } = req.body;

  // ตรวจสอบข้อมูลที่รับมา
  if (!appId || !userId) {
    return res.status(400).json({ success: false, message: 'Missing appId or userId' });
  }

  try {
    // 1. ขอ Token ใหม่ (ไม่ต้องรอรับจาก frontend)
    const token = await getGdxToken();

    // 2. เตรียม Header ส่งไปกับ Notification API
    const headers = {
      'Consumer-Key': process.env.CONSUMER_KEY,
      'Content-Type': 'application/json',
      Token: token,
    };

    // 3. เตรียม Body สำหรับส่ง Notification API
    const body = {
      appId: appId,
      data: [
        {
          message: message || 'ทดสอบแจ้งเตือน Notification',
          userId: userId,
        },
      ],
      sendDateTime: null,
    };

    console.log('🌐 Calling DGA Notify API...');
    console.log('📦 Body:', JSON.stringify(body));

    // 4. GET Notification API_URL=https://api.egov.go.th/ws/dga/czp/uat/v1/core/notification/push
    const response = await axios.post(process.env.NOTIFICATION_API_URL, body, { headers });

    console.log('✅ DGA Response:', response.data);

    // 5. ส่งผลลัพธ์กลับไปยัง Frontend เป็น JSON
    res.json({
      success: true,
      message: 'ส่ง Notification สำเร็จ',
      result: response.data,
    });
  } catch (err) {
    console.error('💥 Notify Error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการส่ง Notification',
      error: err.response?.data || err.message,
    });
  }
});

app.use('/test2', router);

// --- GET /test2/eservice/profile เพื่อดึงข้อมูลโปรไฟล์ ---
router.get('/eservice/profile', async (req, res) => {
  try {
    const { citizenId, userId } = req.query;

    // ตรวจสอบว่ามี citizenId หรือ userId อย่างน้อยหนึ่งค่า
    if (!citizenId && !userId) {
      return res.status(400).json({ status: 'error', message: 'Missing citizenId or userId' });
    }

    // เตรียม Query และ Parameters
    let q = null;
    let params = null;

    // ถ้ามี citizenId ให้ค้นหาด้วย citizenId ก่อน
    if (citizenId) {
      q = `SELECT * FROM personal_data WHERE citizen_id = $1 LIMIT 1`;
      params = [citizenId];
    } else {
    // ถ้าไม่มี citizenId แต่มี userId ให้ค้นหาด้วย userId
      q = `SELECT * FROM personal_data WHERE user_id = $1 LIMIT 1`;
      params = [userId];
    }

    // ดึงข้อมูลจากฐานข้อมูล
    const r = await pool.query(q, params);

    if (r.rowCount === 0) {
      return res.status(404).json({ status: 'not_found', message: 'No record found' });
    }

    return res.json({ status: 'success', data: r.rows[0] });
  } catch (e) {
    console.error('❌ eService profile error:', e.message);
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 v13.0 Final Reference Running...`));
  })
  .catch((e) => {
    console.error('❌ DB init failed:', e.message);
    process.exit(1);
  });
