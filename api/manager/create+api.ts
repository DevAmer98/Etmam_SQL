import { Pool } from 'pg';

// Initialize PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Clerk API URL and Secret Key
const CLERK_API_URL = 'https://api.clerk.dev/v1/users';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

export async function POST(request: Request) {
    try {
        const { firstName, lastName, email, phone, role, clerkId } = await request.json();

        console.log('Received Payload:', { firstName, lastName, email, phone, role, clerkId });

        if (!firstName || !lastName || !email || !phone || !role || !clerkId) {
            console.error('Missing Fields:', { firstName, lastName, email, phone, role, clerkId });
            return new Response(
                JSON.stringify({ error: "Missing required fields" }),
                { status: 400 }
            );
        }

        // Check if user exists in the database
        const checkQuery = `SELECT id FROM managers WHERE clerk_id = $1`;
        const checkResult = await pool.query(checkQuery, [clerkId]);

        let userId;
        if (checkResult.rows.length > 0) {
            // Update existing user
            userId = checkResult.rows[0].id;
            const updateQuery = `
                UPDATE managers
                SET first_name = $1, last_name = $2, email = $3, phone = $4, role = $5
                WHERE clerk_id = $6
                RETURNING id;
            `;
            const updateResult = await pool.query(updateQuery, [firstName, lastName, email, phone, role, clerkId]);
            console.log('User Updated:', updateResult.rows);
        } else {
            // Create new user
            const insertQuery = `
                INSERT INTO managers (first_name, last_name, email, phone, role, clerk_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id;
            `;
            const insertResult = await pool.query(insertQuery, [firstName, lastName, email, phone, role, clerkId]);
            userId = insertResult.rows[0].id;
            console.log('User Created:', insertResult.rows);
        }

        // Update user profile in Clerk
        const updateResponse = await fetch(`${CLERK_API_URL}/${clerkId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
            },
            body: JSON.stringify({
                first_name: firstName,
                last_name: lastName,
                public_metadata: { role },
                phone_numbers: [{ phone_number: phone }],
            }),
        });

        const updateResult = await updateResponse.json();
        if (!updateResponse.ok) {
            console.error('Clerk API Update Error:', updateResult);
            throw new Error(updateResult.message || 'Failed to update Clerk user profile.');
        }

        console.log('Clerk User Profile Updated:', updateResult);

        return new Response(
            JSON.stringify({
                message: "Manager created/updated successfully",
                data: { id: userId },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("Error handling user:", error);
        return new Response(
            JSON.stringify({ error: error.message || "Internal Server Error" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
}
