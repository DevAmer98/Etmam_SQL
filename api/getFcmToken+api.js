import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

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

// POST /api/fcm-token
router.post('/fcm-token', async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('Starting transaction...');
    await executeWithRetry(async () => {
      return await withTimeout(client.query('BEGIN'), 5000); // 5-second timeout for BEGIN
    });

    // Parse the request body
    const { email, role, fcmToken } = req.body;
    console.log('Request body:', { email, role, fcmToken });

    if (!email || !role || !fcmToken) {
      console.error('Missing required fields');
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Update the FCM token in the database based on the role
    let query;
    switch (role) {
      case 'manager':
        query = 'UPDATE Managers SET fcm_token = $1 WHERE email = $2';
        break;
      case 'supervisor':
        query = 'UPDATE Supervisors SET fcm_token = $1 WHERE email = $2';
        break;
      case 'driver':
        query = 'UPDATE Drivers SET fcm_token = $1 WHERE email = $2';
        break;
      case 'storekeeper':
        query = 'UPDATE Storekeepers SET fcm_token = $1 WHERE email = $2';
        break;
         case 'accountant':
        query = 'UPDATE Accountants SET fcm_token = $1 WHERE email = $2';
        break;
        case 'salesRep':
        query = 'UPDATE Salesreps SET fcm_token = $1 WHERE email = $2';
        break;
      default:
        console.error('Invalid role:', role);
        return res.status(400).json({ success: false, error: `Invalid role: ${role}` });
    }

    console.log('Executing query:', query);
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(query, [fcmToken, email]), 10000); // 10-second timeout for query
    });
    console.log('Query result:', result);

    await executeWithRetry(async () => {
      return await withTimeout(client.query('COMMIT'), 5000); // 5-second timeout for COMMIT
    });
    console.log('Transaction committed');

    return res.status(200).json({ success: true, message: 'FCM token registered successfully' });
  } catch (error) {
    console.error('Error during transaction:', error);
    await executeWithRetry(async () => {
      return await withTimeout(client.query('ROLLBACK'), 5000); // 5-second timeout for ROLLBACK
    });
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  } finally {
    client.release(); // Release the client back to the pool
    console.log('Client released');
  }
});

export default router;