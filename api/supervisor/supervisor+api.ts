import { ExpoRequest, ExpoResponse } from 'expo-router/server';
import { Client, Pool } from 'pg';
import { neon } from '@neondatabase/serverless';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});



// Initialize PostgreSQL client
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

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
    const { name, email, phone, clerkId, role = 'supervisor' } = await request.json();

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
    const validRoles = ['driver', 'admin', 'dispatcher', 'sales representative', 'storekeeper','supervisor'];
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
    const checkQuery = 'SELECT * FROM supervisors WHERE email = $1';
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
    }

    // Insert driver into database with role
    const insertQuery = ` 
      INSERT INTO supervisors (name, email, phone, clerk_id, role, created_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING id, name, email, phone, role
    `;

    const result = await client.query(insertQuery, [name, email, phone, userId, role]);
    console.log('Supervisor inserted into database');

    return new ExpoResponse(
      JSON.stringify({
        success: true,
        message: 'Supervisor registered successfully',
        storekeeper: result.rows[0],
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
export async function GET() {
  try {
    const sql = neon(`${process.env.DATABASE_URL}`);
    
    const sales = await sql`
      SELECT * FROM supervisors;
    `;

    return new Response(JSON.stringify(sales), {
      status: 200,
    });
  } catch (error) {
    console.error("Error fetching supervisors:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}
*/


export async function GET(request: Request) {
  const client = await pool.connect();
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
    const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10), 1);
    const nameQuery = url.searchParams.get("query") || ""; // Parameter to search by name

    const offset = (page - 1) * limit;

    const baseQuery = `
      SELECT *
      FROM supervisors
      WHERE name ILIKE $3
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    console.log("Executing SQL Query:", baseQuery);
    console.log("With Parameters:", [limit, offset, `%${nameQuery}%`]);

    const supervisorsResult = await client.query(baseQuery, [limit, offset, `%${nameQuery}%`]);
    if (!supervisorsResult) {
      console.error("No result from the query.");
      throw new Error("No result from the query.");
    }

    const supervisors = supervisorsResult.rows;
    const totalCount = supervisors.length;

    return new Response(
      JSON.stringify({
        supervisors,
        totalCount,
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error fetching supervisors:", error);
    return new Response(
      JSON.stringify({
        error: error.message || "Error fetching supervisors",
        details: process.env.NODE_ENV === "development" ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  } finally {
    client.release();
  }
}
