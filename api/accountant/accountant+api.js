import { Router } from 'express';
import pg from 'pg';
import sgMail from '@sendgrid/mail';

const { Pool } = pg;

const router = Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Utility function to retry database operations
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

// Utility function to add timeout to database queries
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Helper function to generate a strong password
function generateStrongPassword() {
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

  const remainingLength = 8 - requiredChars.length;
  const allChars = lowercase + uppercase + numbers + special;
  const remainingChars = Array.from({ length: remainingLength }, () =>
    allChars[Math.floor(Math.random() * allChars.length)]
  );

  return [...requiredChars, ...remainingChars]
    .sort(() => Math.random() - 0.5)
    .join('');
}

// Clerk user creation function with role
async function createClerkUser(email, password, name, role) {
  try {
    const requestBody = {
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
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Clerk API error: ${JSON.stringify(errorData)}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Clerk user creation error:', error);
    throw error;
  }
}

// Function to send welcome email via SendGrid
async function sendWelcomeEmail(email, name, temporaryPassword, role) {
  try {
    const emailContent = `
  <div style="direction: rtl; text-align: right;">
    <h2>مرحبًا ${name}!</h2>
    <p>لقد تم إنشاء حسابك كـ ${role === 'manager' ? 'مدير' : role} بنجاح.</p>
    <p>إليك بيانات تسجيل الدخول الخاصة بك:</p>
    <p>البريد الإلكتروني: ${email}</p>
    <p>كلمة المرور المؤقتة: ${temporaryPassword}</p>
    <p>يرجى تغيير كلمة المرور الخاصة بك بعد تسجيل الدخول الأول.</p>
    <a href="${process.env.BASE_URL || 'http://localhost:3000'}/sign-in" style="
      background-color: #4CAF50;
      border: none;
      color: white;
      padding: 15px 32px;
      text-align: center;
      text-decoration: none;
      display: inline-block;
      font-size: 16px;
      margin: 4px 2px;
      cursor: pointer;
      border-radius: 4px;">
      فتح تطبيق المنتج الجديد
    </a>
  </div>
`;


    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Welcome to New Product App',
      html: emailContent,
    };

    await sgMail.send(msg);
    console.log('Welcome email sent successfully via SendGrid');
  } catch (error) {
    console.error('Error sending welcome email via SendGrid:', error.response ? error.response.body : error);
    throw new Error('Failed to send welcome email');
  }
}

router.post('/accountatns', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, phone, clerkId, role = 'accountant', fcmToken = null } = req.body;

    // Validate required fields
    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
      });
    }

    // Phone validation
    const phoneRegex = /^\+?[\d\s-]{8,}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format',
      });
    }

    // Check for existing supervisor
    const checkQuery = 'SELECT * FROM accountants WHERE email = $1';
    const checkResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(checkQuery, [email]), 10000); // 10-second timeout
    });

    if (checkResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Accountant with this email already exists',
      });
    }

    let userId = clerkId;

    // If no clerkId provided, create a new Clerk user
    if (!clerkId) {
      const temporaryPassword = generateStrongPassword();
      const clerkUser = await createClerkUser(email, temporaryPassword, name, role);
      userId = clerkUser.id;

      // Send welcome email with credentials
      //await sendWelcomeEmail(email, name, temporaryPassword, role);
    }

    // Insert supervisor into database
    const insertQuery = `
      INSERT INTO accountants (name, email, phone, clerk_id, role, created_at, fcm_token)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
      RETURNING id, name, email, phone, role
    `;

    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(insertQuery, [name, email, phone, userId, role, fcmToken]), 10000); // 10-second timeout
    });

    res.status(200).json({
      success: true,
      message: 'Accountant registered successfully',
      manager: result.rows[0],
    });
  } catch (error) {
    console.error('Error in POST handler:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error registering accountant',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});

router.get('/accountants', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const nameQuery = req.query.query || '';

    const offset = (page - 1) * limit;

    const baseQuery = `
      SELECT *
      FROM accountants
      WHERE name ILIKE $3
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const accountantsResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(baseQuery, [limit, offset, `%${nameQuery}%`]), 10000); // 10-second timeout
    });

    const accountants = accountantsResult.rows;
    const totalCount = accountants.length;

    res.status(200).json({
      accountants,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit), 
    });
  } catch (error) {
    console.error('Error fetching accountants:', error);
    res.status(500).json({
      error: error.message || 'Error fetching accountants',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});



export default router;