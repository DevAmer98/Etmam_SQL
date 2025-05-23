import { ExpoRequest, ExpoResponse } from 'expo-router/server';
import { Client } from 'pg';
import { neon } from '@neondatabase/serverless';
import sgMail from '@sendgrid/mail';


// Initialize PostgreSQL client
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});


sgMail.setApiKey(process.env.SENDGRID_API_KEY);



// Function to send a welcome email
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
      from: process.env.SENDGRID_FROM_EMAIL, // Your verified sender email
      subject: 'Welcome to Our Driver App',
      html: emailContent,
    };

    await sgMail.send(msg);
    console.log('Welcome email sent successfully via SendGrid');
  } catch (error) {
    console.error('Error sending welcome email via SendGrid:', error);
    throw new Error('Failed to send welcome email');
  }
}

// Connect to the database
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

const BASE_URL = process.env.BASE_URL || 'http://192.168.1.104:8081';
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

  return [...requiredChars, ...remainingChars]
    .sort(() => Math.random() - 0.5)
    .join('');
}

// Clerk user creation function with role
async function createClerkUser(email: string, password: string, name: string, role: string) {
  try {
    const requestBody = {
      email_address: [email],
      password,
      first_name: name,
      public_metadata: { role }, // Add role to public metadata
      skip_password_checks: true,
      skip_password_requirement: true,
    };

    const response = await fetch('https://api.clerk.com/v1/users', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
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

export async function POST(request: ExpoRequest): Promise<ExpoResponse> {
  try {
    const { name, email, phone, clerkId, role = 'driver', fcmToken = null } = await request.json();

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

    // Validate role
    const validRoles = ['driver', 'admin', 'dispatcher']; // Add any other roles you need
    if (!validRoles.includes(role)) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Invalid role specified',
        }),
        { status: 400 }
      );
    }

    // Email and phone validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^\+?[\d\s-]{8,}$/;
    if (!emailRegex.test(email) || !phoneRegex.test(phone)) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Invalid email or phone number format',
        }),
        { status: 400 }
      );
    }

    await connectToDatabase();

    // Check for existing driver
    const checkQuery = 'SELECT * FROM drivers WHERE email = $1';
    const checkResult = await client.query(checkQuery, [email]);

    if (checkResult.rows.length > 0) {
      return new ExpoResponse(
        JSON.stringify({
          success: false,
          message: 'Driver with this email already exists',
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

      await sendWelcomeEmail(email, name, temporaryPassword, role);
    }

    // Insert driver into database with role
    const insertQuery = ` 
      INSERT INTO drivers (name, email, phone, clerk_id, role, created_at,fcm_token)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
      RETURNING id, name, email, phone, role
    `;

    const result = await client.query(insertQuery, [name, email, phone, userId, role,fcmToken]);
    console.log('Driver inserted into database');

    return new ExpoResponse(
      JSON.stringify({
        success: true,
        message: 'Driver registered successfully',
        driver: result.rows[0],
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error('Error in POST handler:', error);

    return new ExpoResponse(
      JSON.stringify({
        success: false,
        message: error.message || 'Error registering driver',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      }),
      { status: 500 }
    );
  }
}


export async function GET() {
  try {
    const sql = neon(`${process.env.DATABASE_URL}`);
    
    const drivers = await sql`
      SELECT * FROM drivers;
    `;

    return new Response(JSON.stringify(drivers), {
      status: 200,
    });
  } catch (error) {
    console.error("Error fetching drivers:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}