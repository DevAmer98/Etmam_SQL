import express from 'express';
import pkg from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const { Pool } = pkg;
const router = express.Router();

// === PostgreSQL pool setup ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// === Utility Functions ===
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

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

const connectToDatabase = async () => {
  try {
    const client = await executeWithRetry(() => withTimeout(pool.connect(), 5000));
    console.log('Database connected');
    return client;
  } catch (err) {
    console.error('Failed to connect to database:', err);
    throw new Error('Database connection failed');
  }
};

const deleteClerkUser = async clerkId => {
  const response = await executeWithRetry(() =>
    withTimeout(
      fetch(`https://api.clerk.dev/v1/users/${clerkId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
          'Clerk-Backend-API-Version': '2023-05-12',
        },
      }),
      10000
    )
  );

  if (!response.ok) {
    throw new Error('Failed to delete user from Clerk.');
  }
};

// === Routes ===

// GET /operations/:id
router.get(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'Operation ID is required' });

    const client = await connectToDatabase();
    try {
      const query = 'SELECT * FROM operations WHERE id = $1';
      const result = await executeWithRetry(() =>
        withTimeout(client.query(query, [id]), 10000)
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Operation not found' });
      }

      res.status(200).json({ success: true, operation: result.rows[0] });
    } finally {
      client.release();
    }
  })
);

// DELETE /operations/:id
router.delete(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'Operation ID is required' });

    const client = await connectToDatabase();
    try {
      const query = 'SELECT clerk_id FROM operations WHERE id = $1';
      const result = await executeWithRetry(() =>
        withTimeout(client.query(query, [id]), 10000)
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Operation not found' });
      }

      const { clerk_id } = result.rows[0];

      await executeWithRetry(() =>
        withTimeout(client.query('DELETE FROM operations WHERE id = $1', [id]), 10000)
      );

      await deleteClerkUser(clerk_id);

      res.status(200).json({ success: true, message: 'Operation deleted successfully' });
    } finally {
      client.release();
    }
  })
);

// PUT /operations/:id
router.put(
  '/operations/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, email, phone, role } = req.body;

    if (!id) return res.status(400).json({ success: false, message: 'Operation ID is required' });
    if (!name || !email || !phone || !role) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const client = await connectToDatabase();
    try {
      const clerkIdQuery = 'SELECT clerk_id FROM operations WHERE id = $1';
      const fetchResult = await executeWithRetry(() =>
        withTimeout(client.query(clerkIdQuery, [id]), 10000)
      );

      if (fetchResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Operation not found' });
      }

      const { clerk_id } = fetchResult.rows[0];

      const clerkUpdate = await executeWithRetry(() =>
        withTimeout(
          fetch(`https://api.clerk.dev/v1/users/${clerk_id}`, {
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
          }),
          10000
        )
      );

      if (!clerkUpdate.ok) {
        const errorData = await clerkUpdate.json();
        throw new Error(`Failed to update Clerk user: ${JSON.stringify(errorData)}`);
      }

      const updateQuery = `
        UPDATE operations
        SET name = $1, email = $2, phone = $3, role = $4
        WHERE id = $5
        RETURNING id, name, email, phone, role
      `;

      const result = await executeWithRetry(() =>
        withTimeout(client.query(updateQuery, [name, email, phone, role, id]), 10000)
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Operation not found' });
      }

      res.status(200).json({
        success: true,
        message: 'Operation updated successfully in both Clerk and database',
        operation: result.rows[0],
      });
    } finally {
      client.release();
    }
  })
);

export default router;
