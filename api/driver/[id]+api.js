import express from 'express';
import pkg from 'pg';
import { asyncHandler } from '../../utils/asyncHandler'; // Adjust path if needed
const { Pool } = pkg;

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry wrapper
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

// Timeout wrapper
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// DB Connection helper
async function connectToDatabase() {
  return await executeWithRetry(() => withTimeout(pool.connect(), 5000));
}

// Clerk deletion helper
async function deleteClerkUser(clerkId) {
  const response = await executeWithRetry(() =>
    withTimeout(fetch(`https://api.clerk.dev/v1/users/${clerkId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
        'Clerk-Backend-API-Version': '2023-05-12',
      },
    }), 10000)
  );

  if (!response.ok) throw new Error('Failed to delete user from Clerk');
}

// GET /drivers/:id
router.get('/drivers/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, message: 'Driver ID is required' });

  const client = await connectToDatabase();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(client.query('SELECT * FROM drivers WHERE id = $1', [id]), 10000)
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    res.status(200).json({ success: true, driver: result.rows[0] });
  } finally {
    client.release();
  }
}));

// DELETE /drivers/:id
router.delete('/drivers/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, message: 'Driver ID is required' });

  const client = await connectToDatabase();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(client.query('SELECT clerk_id FROM drivers WHERE id = $1', [id]), 10000)
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    const { clerk_id } = result.rows[0];

    await executeWithRetry(() =>
      withTimeout(client.query('DELETE FROM drivers WHERE id = $1', [id]), 10000)
    );

    await deleteClerkUser(clerk_id);

    res.status(200).json({ success: true, message: 'Driver deleted successfully' });
  } finally {
    client.release();
  }
}));

// PUT /drivers/:id
router.put('/drivers/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role } = req.body;

  if (!id || !name || !email || !phone || !role) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  const client = await connectToDatabase();
  try {
    const fetchResult = await executeWithRetry(() =>
      withTimeout(client.query('SELECT clerk_id FROM drivers WHERE id = $1', [id]), 10000)
    );

    if (fetchResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    const { clerk_id } = fetchResult.rows[0];

    const clerkUpdateResponse = await executeWithRetry(() =>
      withTimeout(fetch(`https://api.clerk.dev/v1/users/${clerk_id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
          'Content-Type': 'application/json',
          'Clerk-Backend-API-Version': '2023-05-12',
        },
        body: JSON.stringify({
          first_name: name,
          email_addresses: [{ email_address: email }],
          public_metadata: { phone, role },
        }),
      }), 10000)
    );

    if (!clerkUpdateResponse.ok) {
      const errorData = await clerkUpdateResponse.json();
      console.error('Clerk update error:', errorData);
      throw new Error('Failed to update driver in Clerk');
    }

    const updateQuery = `
      UPDATE drivers
      SET name = $1, email = $2, phone = $3, role = $4
      WHERE id = $5
      RETURNING id, name, email, phone, role
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(updateQuery, [name, email, phone, role, id]), 10000)
    );

    res.status(200).json({
      success: true,
      message: 'Driver updated successfully in both Clerk and database',
      driver: result.rows[0],
    });
  } finally {
    client.release();
  }
}));

export default router;
