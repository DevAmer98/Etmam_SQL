import express from 'express';
import { Pool } from 'pg';

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

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
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database query timed out')), timeout)
    ),
  ]);
};

const connectToDatabase = async () => {
  try {
    const client = await executeWithRetry(() => withTimeout(pool.connect(), 5000));
    console.log('✅ Database connected');
    return client;
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    throw new Error('Database connection failed');
  }
};

const deleteClerkUser = async (clerkId) => {
  try {
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
      throw new Error('Failed to delete Clerk user');
    }
  } catch (err) {
    console.error('Error deleting Clerk user:', err);
    throw err;
  }
};

// GET Accountant by ID
router.get('/accountants/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, message: 'Missing accountant ID' });

  const client = await connectToDatabase();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(client.query('SELECT * FROM accountants WHERE id = $1', [id]), 10000)
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accountant not found' });
    }

    return res.status(200).json({ success: true, accountant: result.rows[0] });
  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// DELETE Accountant
router.delete('/accountants/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, message: 'Missing accountant ID' });

  const client = await connectToDatabase();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(client.query('SELECT clerk_id FROM accountants WHERE id = $1', [id]), 10000)
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accountant not found' });
    }

    const { clerk_id } = result.rows[0];

    await executeWithRetry(() =>
      withTimeout(client.query('DELETE FROM accountants WHERE id = $1', [id]), 10000)
    );

    await deleteClerkUser(clerk_id);

    return res.status(200).json({ success: true, message: 'Accountant deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// UPDATE Accountant
router.put('/accountants/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role } = req.body;

  if (!id || !name || !email || !phone || !role) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  const client = await connectToDatabase();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(client.query('SELECT clerk_id FROM accountants WHERE id = $1', [id]), 10000)
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accountant not found' });
    }

    const { clerk_id } = result.rows[0];

    // Update Clerk user
    const clerkResponse = await executeWithRetry(() =>
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

    if (!clerkResponse.ok) {
      const errorData = await clerkResponse.json();
      console.error('Clerk update error:', errorData);
      throw new Error('Failed to update Clerk user');
    }

    // Update DB
    const updateResult = await executeWithRetry(() =>
      withTimeout(
        client.query(
          `UPDATE accountants SET name = $1, email = $2, phone = $3, role = $4 WHERE id = $5 RETURNING id, name, email, phone, role`,
          [name, email, phone, role, id]
        ),
        10000
      )
    );

    return res.status(200).json({
      success: true,
      message: 'Accountant updated successfully in both Clerk and database',
      accountant: updateResult.rows[0],
    });
  } catch (err) {
    console.error('Update error:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

export default router;
