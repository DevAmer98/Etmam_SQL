import { Router } from 'express';
import pg from 'pg';
import sgMail from '@sendgrid/mail';
import { asyncHandler } from '../..//utils/asyncHandler.js';

const { Pool } = pg;
const router = Router();

// PostgreSQL Pool Setup
/*const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

*/


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,  // ✅ Disable SSL
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => console.error('Unexpected error on idle client', err));

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// === Utility Functions ===
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise((res) => setTimeout(res, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

const generateStrongPassword = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const createClerkUser = async (email, password, name, role) => {
  const response = await fetch('https://api.clerk.com/v1/users', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'Clerk-Backend-API-Version': '2023-05-12',
    },
    body: JSON.stringify({
      email_address: [email],
      password,
      first_name: name,
      public_metadata: { role },
      skip_password_checks: true,
      skip_password_requirement: true,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Clerk API error: ${JSON.stringify(errorData)}`);
  }
  return response.json();
};

const sendWelcomeEmail = async (email, name, password, role) => {
  const content = `
    <div style="direction: rtl; text-align: right;">
      <h2>مرحبًا ${name}!</h2>
      <p>تم إنشاء حسابك كـ ${role === 'manager' ? 'مدير' : role}.</p>
      <p>بيانات الدخول:</p>
      <p>الإيميل: ${email}</p>
      <p>كلمة المرور: ${password}</p>
      <p>يرجى تغييرها بعد تسجيل الدخول الأول.</p>
      <a href="${process.env.BASE_URL || 'http://localhost:3000'}/sign-in" style="
        background-color: #4CAF50; padding: 12px 24px; color: white; text-decoration: none;
        border-radius: 5px;">فتح التطبيق</a>
    </div>
  `;

  const msg = {
    to: email,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'مرحبًا بك في تطبيق المنتج',
    html: content,
  };

  await sgMail.send(msg);
  console.log(`Welcome email sent to ${email}`);
};

// === ROUTES ===

// POST /managers
router.post(
  '/managers',
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const { name, email, phone, clerkId, role = 'manager', fcmToken = null } = req.body;

      if (!name || !email || !phone)
        return res.status(400).json({ success: false, message: 'Missing required fields' });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const phoneRegex = /^\+?[\d\s-]{8,}$/;

      if (!emailRegex.test(email))
        return res.status(400).json({ success: false, message: 'Invalid email format' });

      if (!phoneRegex.test(phone))
        return res.status(400).json({ success: false, message: 'Invalid phone number format' });

      const existing = await executeWithRetry(() =>
        withTimeout(client.query('SELECT * FROM managers WHERE email = $1', [email]), 10000)
      );

      if (existing.rows.length > 0)
        return res.status(400).json({ success: false, message: 'Manager already exists' });

      let userId = clerkId;
      if (!clerkId) {
        const tempPass = generateStrongPassword();
        const clerkUser = await createClerkUser(email, tempPass, name, role);
        userId = clerkUser.id;
        // await sendWelcomeEmail(email, name, tempPass, role); // Optional
      }

      const insert = `
        INSERT INTO managers (name, email, phone, clerk_id, role, created_at, fcm_token)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
        RETURNING id, name, email, phone, role
      `;

      const result = await executeWithRetry(() =>
        withTimeout(client.query(insert, [name, email, phone, userId, role, fcmToken]), 10000)
      );

      res.status(201).json({
        success: true,
        message: 'Manager created successfully',
        manager: result.rows[0],
      });
    } finally {
      client.release();
    }
  })
);

// GET /managers
router.get(
  '/managers',
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const nameQuery = req.query.query || '';
      const offset = (page - 1) * limit;

      const query = `
        SELECT * FROM managers
        WHERE name ILIKE $3
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `;

      const result = await executeWithRetry(() =>
        withTimeout(client.query(query, [limit, offset, `%${nameQuery}%`]), 10000)
      );

      res.status(200).json({
        success: true,
        managers: result.rows,
        currentPage: page,
        totalPages: Math.ceil(result.rows.length / limit),
      });
    } finally {
      client.release();
    }
  })
);

// GET /managers/emails
router.get(
  '/managers/emails',
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const { email } = req.query;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Invalid or missing email' });
      }

      const result = await executeWithRetry(() =>
        withTimeout(client.query('SELECT * FROM managers WHERE email = $1', [email]), 10000)
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Manager not found' });
      }

      res.status(200).json({ success: true, manager: result.rows[0] });
    } finally {
      client.release();
    }
  })
);

export default router;
