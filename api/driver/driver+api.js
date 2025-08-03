import express from 'express';
import pkg from 'pg';
import sgMail from '@sendgrid/mail';
import { asyncHandler } from '../../utils/asyncHandler.js'; 

const { Pool } = pkg;
const router = express.Router();

// === PostgreSQL pool ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// === SendGrid init ===
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// === Utils ===
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

const generateStrongPassword = () => {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '!@#$%^&*';
  const requiredChars = [
    lowercase[Math.floor(Math.random() * lowercase.length)],
    uppercase[Math.floor(Math.random() * uppercase.length)],
    numbers[Math.floor(Math.random() * numbers.length)],
    special[Math.floor(Math.random() * special.length)],
  ];
  const allChars = lowercase + uppercase + numbers + special;
  const remaining = Array.from({ length: 8 - requiredChars.length }, () =>
    allChars[Math.floor(Math.random() * allChars.length)]
  );
  return [...requiredChars, ...remaining].sort(() => Math.random() - 0.5).join('');
};

const createClerkUser = async (email, password, name, role) => {
  const res = await executeWithRetry(() =>
    withTimeout(
      fetch('https://api.clerk.com/v1/users', {
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
      }),
      10000
    )
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Clerk API error: ${JSON.stringify(err)}`);
  }

  return await res.json();
};

const sendWelcomeEmail = async (email, name, password, role) => {
  const html = `
    <div style="direction: rtl; text-align: right;">
      <h2>مرحبًا ${name}!</h2>
      <p>لقد تم إنشاء حسابك كـ ${role === 'driver' ? 'سائق' : role} بنجاح.</p>
      <p>البريد الإلكتروني: ${email}</p>
      <p>كلمة المرور المؤقتة: ${password}</p>
      <p>يرجى تغيير كلمة المرور الخاصة بك بعد تسجيل الدخول الأول.</p>
      <a href="${process.env.BASE_URL || 'http://localhost:3000'}/sign-in" style="
        background-color: #4CAF50;
        color: white;
        padding: 15px 32px;
        text-decoration: none;
        display: inline-block;
        border-radius: 4px;">
        فتح تطبيق المنتج الجديد
      </a>
    </div>
  `;

  const msg = {
    to: email,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Welcome to New Product App',
    html,
  };

  await executeWithRetry(() => withTimeout(sgMail.send(msg), 10000));
};

// === Routes ===

// POST /api/drivers
router.post(
  '/drivers',
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const { name, email, phone, clerkId, role = 'driver' } = req.body;

      if (!name || !email || !phone) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      const validRoles = ['driver', 'admin', 'dispatcher'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ success: false, message: 'Invalid role specified' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const phoneRegex = /^\+?[\d\s-]{8,}$/;
      if (!emailRegex.test(email) || !phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: 'Invalid email or phone' });
      }

      const checkQuery = 'SELECT * FROM drivers WHERE email = $1';
      const existing = await executeWithRetry(() =>
        withTimeout(client.query(checkQuery, [email]), 10000)
      );

      if (existing.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Driver already exists' });
      }

      let userId = clerkId;
      let tempPassword;

      if (!clerkId) {
        tempPassword = generateStrongPassword();
        const clerkUser = await createClerkUser(email, tempPassword, name, role);
        userId = clerkUser.id;

        // Optional: enable to send welcome email
        // await sendWelcomeEmail(email, name, tempPassword, role);
      }

      const insertQuery = `
        INSERT INTO drivers (name, email, phone, clerk_id, role, created_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        RETURNING id, name, email, phone, role
      `;

      const result = await executeWithRetry(() =>
        withTimeout(client.query(insertQuery, [name, email, phone, userId, role]), 10000)
      );

      return res.status(200).json({
        success: true,
        message: 'Driver registered successfully',
        driver: result.rows[0],
      });
    } finally {
      client.release();
    }
  })
);

// GET /api/drivers
router.get(
  '/drivers',
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const nameQuery = req.query.query || '';
      const offset = (page - 1) * limit;

      const sql = `
        SELECT * FROM drivers
        WHERE name ILIKE $3
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `;

      const result = await executeWithRetry(() =>
        withTimeout(client.query(sql, [limit, offset, `%${nameQuery}%`]), 10000)
      );

      const totalCount = result.rowCount;

      return res.status(200).json({
        drivers: result.rows,
        totalCount,
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
      });
    } finally {
      client.release();
    }
  })
);

export default router;
