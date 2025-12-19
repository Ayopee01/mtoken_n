// ==========================================
// app.js (v13.0 Final Reference)
// รวม Login (Auto-Table) + Notification (Based on test2)
// ==========================================
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Serve Frontend
app.use('/test2', express.static(path.join(__dirname, 'public')));

// --- Helper: ขอ GDX Token ใหม่ (ใช้ได้ทั้ง Login และ Notify) ---
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

// ------------------------------------------------------------------
// 1️⃣ API LOGIN (Logic เดิมที่เสถียรแล้ว)
// ------------------------------------------------------------------
router.post('/auth/login', async (req, res) => {
    const { appId, mToken } = req.body;
    let debugInfo = { step1: null, step2: null, step3: false };

    if (!appId || !mToken) return res.status(400).json({ error: 'Missing Data' });

    try {
        console.log('🔹 Login Step 1: Requesting Token...');
        const token = await getGdxToken();
        debugInfo.step1 = token;

        console.log('🔹 Login Step 2: Requesting Profile...');
        const deprocRes = await axios.post(process.env.DEPROC_API_URL, 
            { AppId: appId, MToken: mToken },
            { headers: { 'Consumer-Key': process.env.CONSUMER_KEY, 'Token': token, 'Content-Type': 'application/json' } }
        );
        debugInfo.step2 = deprocRes.data;
        
        const pData = deprocRes.data.result;
        if (!pData) throw new Error("Deproc returned NULL (Token Expired)");

        console.log('🔹 Login Step 3: Saving DB...');
        // Auto-Create Table Logic
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

        await pool.query(`
            INSERT INTO personal_data (user_id, citizen_id, first_name, last_name, date_of_birth, mobile, email, notification)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (citizen_id) DO UPDATE SET 
            first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, mobile = EXCLUDED.mobile;
        `, [pData.userId, pData.citizenId, pData.firstName, pData.lastName, pData.dateOfBirthString, pData.mobile, pData.email, pData.notification]);
        
        debugInfo.step3 = true;

        res.json({
            status: 'success',
            message: 'Login successful',
            debug: debugInfo,
            data: { 
                firstName: pData.firstName, 
                lastName: pData.lastName,
                userId: pData.userId, // ส่ง userId กลับไป เพื่อใช้ยิง Notify
                appId: appId
            }
        });

    } catch (error) {
        console.error('❌ Login Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message, debug: debugInfo });
    }
});

// ------------------------------------------------------------------
// 2️⃣ API NOTIFICATION (อ้างอิงจากโค้ด test2)
// ------------------------------------------------------------------
router.post('/notify/send', async (req, res) => {
    console.log("🚀 [START] /notify/send");
    
    // รับค่าจากหน้าบ้าน
    const { appId, userId, message } = req.body;

    if (!appId || !userId) {
        return res.status(400).json({ success: false, message: "Missing appId or userId" });
    }

    try {
        // 1. ขอ Token ใหม่สดๆ (ไม่ต้องรอรับจาก frontend)
        const token = await getGdxToken();

        // 2. เตรียม Header
        const headers = {
            "Consumer-Key": process.env.CONSUMER_KEY,
            "Content-Type": "application/json",
            "Token": token
        };

        // 3. เตรียม Body (ตามแบบฉบับ test2)
        const body = {
            appId: appId,
            data: [
                {
                    message: message || "ทดสอบแจ้งเตือนจาก test2",
                    userId: userId
                }
            ],
            sendDateTime: null
        };

        console.log("🌐 Calling DGA Notify API...");
        console.log("📦 Body:", JSON.stringify(body));

        // 4. ยิง API
        const response = await axios.post(process.env.NOTIFICATION_API_URL, body, { headers });

        console.log("✅ DGA Response:", response.data);

        res.json({
            success: true,
            message: "ส่ง Notification สำเร็จ",
            result: response.data
        });

    } catch (err) {
        console.error("💥 Notify Error:", err.response?.data || err.message);
        res.status(500).json({
            success: false,
            message: "เกิดข้อผิดพลาดในการส่ง Notification",
            error: err.response?.data || err.message
        });
    }
});

app.use('/test2', router);
app.listen(process.env.PORT || 3000, () => console.log(`🚀 v13.0 Final Reference Running...`));