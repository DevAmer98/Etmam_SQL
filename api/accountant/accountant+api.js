import { Router } from 'express';
import pg from 'pg';
import sgMail from '@sendgrid/mail';

const { Pool } = pg;
const router = Router();

// PostgreSQL pool setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Utility Functions ---

const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

const generateStrongPassword = (length = 10) => {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
  return Array.from({ length }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
};

const createClerkUser = async (email, password, name, role) => {
  const body = {
    email_address: [email],
    password,
    first_name: name,
    public_metadata: { role },
    skip_password_checks: true,
    skip_password_requirement: true,
  };

  const response = await fetch('https://api.clerk.com/v1/users', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'Clerk-Backend-API-Version': '2023-05-12',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Clerk API Error: ${JSON.stringify(errorData)}`);
  }

  return await response.json();
};

const sendWelcomeEmail = async (email, name, password, role) => {
  const appUrl = process.env.BASE_URL || 'http://localhost:3000';

  const msg = {
    to: email,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Welcome to New Product App',
    html: `
      <div style="direction: rtl; text-align: right;">
        <h2>مرحبًا ${name}!</h2>
        <p>لقد تم إنشاء حسابك كـ ${role} بنجاح.</p>
        <p>بيانات الدخول:</p>
        <p>البريد الإلكتروني: ${email}</p>
        <p>كلمة المرور المؤقتة: ${password}</p>
        <p>يرجى تغييرها بعد تسجيل الدخول.</p>
        <a href="${appUrl}/sign-in" style="background-color:#4CAF50;color:#fff;padding:10px 20px;text-decoration:none;border-radius:5px;">فتح التطبيق</a>
      </div>`,
  };

  await sgMail.send(msg);
};

// --- Routes ---

router.post('/accountants', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, phone, clerkId, role = 'accountant', fcmToken = null } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^\+?[\d\s-]{8,}$/;

    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone format' });
    }

    const existing = await executeWithRetry(() =>
      withTimeout(client.query('SELECT 1 FROM accountants WHERE email = $1', [email]), 10000)
    );

    if (existing.rowCount > 0) {
      return res.status(400).json({ success: false, message: 'Accountant already exists' });
    }

    let userId = clerkId;
    if (!clerkId) {
      const tempPassword = generateStrongPassword();
      const user = await createClerkUser(email, tempPassword, name, role);
      userId = user.id;
      // await sendWelcomeEmail(email, name, tempPassword, role);
    }

    const insertQuery = `
      INSERT INTO accountants (name, email, phone, clerk_id, role, created_at, fcm_token)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
      RETURNING id, name, email, phone, role
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(insertQuery, [name, email, phone, userId, role, fcmToken]), 10000)
    );

    return res.status(200).json({
      success: true,
      message: 'Accountant registered successfully',
      manager: result.rows[0],
    });
  } catch (err) {
    console.error('POST /accountants error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  } finally {
    client.release();
  }
});

router.get('/accountants', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10'), 50);
    const page = Math.max(parseInt(req.query.page || '1'), 1);
    const search = `%${req.query.query || ''}%`;

    const offset = (page - 1) * limit;

    const query = `
      SELECT *
      FROM accountants
      WHERE name ILIKE $3
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(query, [limit, offset, search]), 10000)
    );

    const accountants = result.rows;

    return res.status(200).json({
      accountants,
      totalCount: accountants.length,
      currentPage: page,
      totalPages: Math.ceil(accountants.length / limit),
    });
  } catch (err) {
    console.error('GET /accountants error:', err);
    return res.status(500).json({
      success: false,
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;
