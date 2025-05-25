import express from 'express';
import pkg from 'pg'; // Import the default export
const { Pool } = pkg; // Destructure Pool from the default export
import sgMail from '@sendgrid/mail';

const router = express.Router();

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

// Utility function to retry database operations
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
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
      public_metadata: { role }, // Add role to public metadata
      skip_password_checks: true,
      skip_password_requirement: true,
    };

    const response = await executeWithRetry(async () => {
      return await withTimeout(
        fetch('https://api.clerk.com/v1/users', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
            'Clerk-Backend-API-Version': '2023-05-12',
          },
          body: JSON.stringify(requestBody),
        }),
        10000 // 10-second timeout
      );
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

// Function to send a welcome email via SendGrid
async function sendWelcomeEmail(email, name, temporaryPassword, role) {
  try {
    const emailContent = `
    <div style="direction: rtl; text-align: right;">
      <h2>مرحبًا ${name}!</h2>
      <p>لقد تم إنشاء حسابك كـ ${role === 'salesRep' ? 'مندوب المبيعات' : role} بنجاح.</p>
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

    await executeWithRetry(async () => {
      return await withTimeout(sgMail.send(msg), 10000); // 10-second timeout
    });
    console.log('Welcome email sent successfully via SendGrid');
  } catch (error) {
    console.error('Error sending welcome email via SendGrid:', error.response ? error.response.body : error);
    throw new Error('Failed to send welcome email');
  }
}

// POST /api/salesreps
router.post('/salesreps', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, phone, clerkId, role = 'salesRep' } = req.body;

    // Validate required fields
    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Validate role
    const validRoles = ['driver', 'salesRep'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role specified',
      });
    }

    // Email and phone validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^\+?[\d\s-]{8,}$/;
    if (!emailRegex.test(email) || !phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email or phone number format',
      });
    }

    // Check for existing salesRep
    const checkQuery = 'SELECT * FROM salesreps WHERE email = $1';
    const checkResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(checkQuery, [email]), 10000); // 10-second timeout
    });

    if (checkResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'SalesRep with this email already exists',
      });
    }

    let userId = clerkId;

    // If no clerkId provided, create a new Clerk user
    if (!clerkId) {
      const temporaryPassword = generateStrongPassword();
      const clerkUser = await createClerkUser(email, temporaryPassword, name, role);
      userId = clerkUser.id;

      // Send welcome email with credentials
     // await sendWelcomeEmail(email, name, temporaryPassword, role);
    }

    // Insert salesRep into database with role
    const insertQuery = `
      INSERT INTO salesreps (name, email, phone, clerk_id, role, created_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING id, name, email, phone, role
    `;

    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(insertQuery, [name, email, phone, userId, role]), 10000); // 10-second timeout
    });
    console.log('SalesRep inserted into database');

    return res.status(200).json({
      success: true,
      message: 'SalesRep registered successfully',
      salesRep: result.rows[0],
    });
  } catch (error) {
    console.error('Error in POST handler:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error registering salesRep',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});

// GET /api/salesreps
router.get('/salesreps', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const nameQuery = req.query.query || ''; // Parameter to search by name

    const offset = (page - 1) * limit;

    const baseQuery = `
      SELECT *
      FROM salesreps
      WHERE name ILIKE $3
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    console.log('Executing SQL Query:', baseQuery);
    console.log('With Parameters:', [limit, offset, `%${nameQuery}%`]);

    const salesResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(baseQuery, [limit, offset, `%${nameQuery}%`]), 10000); // 10-second timeout
    });

    if (!salesResult) {
      console.error('No result from the query.');
      throw new Error('No result from the query.');
    }

    const sales = salesResult.rows;
    const totalCount = sales.length;

    return res.status(200).json({
      sales,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching sales:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching sales',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});




// GET /salesreps/emails (new endpoint)
router.get('/salesreps/emails', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email } = req.query; // Get the email from query parameters

    // Validate email format (optional)
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or missing email',
      });
    }

    const query = 'SELECT * FROM salesreps WHERE email = $1';
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(query, [email]), 10000); // 10-second timeout
    });

    if (!result) {
      console.error('No result from the query.');
      throw new Error('No result from the query.');
    }

    const sales = result.rows;

    if (sales.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales representative not found',
      });
    }

    return res.status(200).json({
      success: true,
      salesRep: sales[0], // Return the first matching sales rep
    });
  } catch (error) {
    console.error('Error fetching sales representative:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch sales representative',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});


export default router;