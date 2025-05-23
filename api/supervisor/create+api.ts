import { ExpoRequest, ExpoResponse } from 'expo-router/server';
import { Client } from 'pg';
import sgMail from '@sendgrid/mail';

// Initialize PostgreSQL client
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

sgMail.setApiKey(process.env.SENDGRID_API_KEy);

async function connectToDatabase() {
  try {
    if (!client._connected) {
      await client.connect();
      console.log('Database connected');
    }
  } catch (err) {
    console.error('Failed to connect to database:', err);
    throw new Error('Database connection failed');
  }
}

const BASE_URL = process.env.BASE_URL || 'http://192.168.1.103:8081';
const getDeepLink = (path: string) => `${BASE_URL}${path}`;

function generateStrongPassword(): string {
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
  return [...requiredChars, ...remainingChars].sort(() => Math.random() - 0.5).join('');
}

async function createClerkUser(email: string, password: string, name: string, role: string) {
  try {
    const requestBody = {
      email_address: [email],
      password,
      first_name: name,
      public_metadata: { role },
      skip_password_checks: true,
      skip_password_requirement: true,
    };
    console.log('Sending request to Clerk API:', requestBody);
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
      console.error('Clerk API error response:', errorData);
      throw new Error(`Clerk API error: ${JSON.stringify(errorData)}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Clerk user creation error:', error);
    throw error;
  }
}

async function sendWelcomeEmail(email: string, name: string, temporaryPassword: string, role: string) {
  try {
    const emailContent = `
      <h2>Welcome ${name}!</h2>
      <p>Your ${role} account has been created successfully.</p>
      <p>Here are your login credentials:</p>
      <p>Email: ${email}</p>
      <p>Temporary Password: ${temporaryPassword}</p>
      <p>Please change your password after your first login.</p>
      <a href="${getDeepLink('/sign-in')}" style="
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
        Open New Product App
      </a>
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

export async function POST(request: ExpoRequest): Promise<ExpoResponse> {
  try {
    console.log('Starting POST request handler');
    const { name, email, phone, clerkId, role = 'supervisor', fcmToken = null } = await request.json();

    console.log('Received data:', { name, email, phone, clerkId, role });

    // Validate required fields
    if (!name || !email || !phone) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Missing required fields',
        }),
        { status: 400 }
      );
    }

    // Email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Invalid email format',
        }),
        { status: 400 }
      );
    }

    // Phone validation
    if (!/^\+?[\d\s-]{8,}$/.test(phone)) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Invalid phone number format',
        }),
        { status: 400 }
      );
    }

    await connectToDatabase();

    // Check for existing supervisor
    const checkResult = await client.query('SELECT * FROM Supervisors WHERE email = $1', [email]);

    if (checkResult.rows.length > 0) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Supervisor with this email already exists', 
        }), 
        { status: 400 }
      );
    }

    let userId = clerkId;

    // If no clerkId provided, create a new Clerk user
    if (!clerkId) {
      const temporaryPassword = generateStrongPassword();
      const clerkUser = await createClerkUser(email, temporaryPassword, name, role);
      userId = clerkUser.id;

      // Send welcome email with credentials
      await sendWelcomeEmail(email, name, temporaryPassword, role);
    }

    // Insert supervisor into database
    const insertQuery = `
      INSERT INTO Supervisors (name, email, phone, clerk_Id, role, created_at, fcm_token)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
      RETURNING id, name, email, phone, role;
    `;
    const result = await client.query(insertQuery, [name, email, phone, userId, role, fcmToken]);
    console.log('Supervisor inserted into database');

    return new ExpoResponse(
      JSON.stringify({
        success: true,
        message: 'Supervisor registered successfully',
        supervisor: result.rows[0],
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error('Error in POST handler:', error);

    return new ExpoResponse(
      JSON.stringify({
        success: false,
        message: error.message || 'Error registering supervisor',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      }),
      { status: 500 }
    );
  }
}

/*
export async function POST(request: ExpoRequest): Promise<ExpoResponse> {
  try {
    console.log('Starting POST request handler');
    const { name, email, phone, clerkId, role = 'supervisor' ,expoToken } = await request.json();
    console.log('Received data:', { name, email, phone, clerkId, role });

    // Validate required fields
    if (!name || !email || !phone) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Missing required fields',
        }),
        { status: 400 }
      );
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Invalid email format',
        }),
        { status: 400 }
      );
    }

    // Phone validation
    const phoneRegex = /^\+?[\d\s-]{8,}$/;
    if (!phoneRegex.test(phone)) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Invalid phone number format',
        }),
        { status: 400 }
      );
    }

    await connectToDatabase();

    // Check for existing supervisor
    const checkQuery = 'SELECT * FROM Supervisors WHERE email = $1';
    const checkResult = await client.query(checkQuery, [email]);

    if (checkResult.rows.length > 0) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Supervisor with this email already exists',
        }),
        { status: 400 }
      );
    }

    let userId = clerkId;

    // If no clerkId provided, create a new Clerk user
    if (!clerkId) {
      const temporaryPassword = generateStrongPassword();
      const clerkUser = await createClerkUser(email, temporaryPassword, name, role);
      userId = clerkUser.id;

      // Send welcome email with credentials
      await sendWelcomeEmail(email, name, temporaryPassword, role);
    }

    // Insert supervisor into database
    const insertQuery = `
      INSERT INTO Supervisors (name, email, phone, clerk_Id, role, created_at, expo_token)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING id, name, email, phone, role
    `;

    const result = await client.query(insertQuery, [name, email, phone, userId, role, expoToken]);
    console.log('Supervisor inserted into database');

    return new ExpoResponse(
      JSON.stringify({
        success: true,
        message: 'Supervisor registered successfully',
        supervisor: result.rows[0],
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error('Error in POST handler:', error);

    return new ExpoResponse(
      JSON.stringify({
        success: false,
        message: error.message || 'Error registering supervisor',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      }),
      { status: 500 }
    );
  }
}
*/