import express from 'express';
import { neon } from '@neondatabase/serverless';

const router = express.Router();

// Utility: Retry DB operations with backoff
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

// Utility: Add timeout to DB queries
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

router.get('/clients', async (req, res) => {
  try {
    const sql = neon(process.env.DATABASE_URL);

    // Parse pagination & filters from query
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const searchQuery = req.query.search || '';
    const username = req.query.username?.trim();

    if (!username) {
      return res.status(400).json({ error: 'Missing username query parameter' });
    }

    const offset = (page - 1) * limit;

    // Fetch paginated clients for this username
    const clients = await executeWithRetry(() =>
      withTimeout(
        sql`
          SELECT * FROM clients
          WHERE LOWER(TRIM(clients.username)) = LOWER(TRIM(${username}))
          AND client_name ILIKE ${'%' + searchQuery + '%'}
          ORDER BY client_name
          LIMIT ${limit}
          OFFSET ${offset};
        `,
        10000
      )
    );

    // Fetch total count for pagination
    const totalClients = await executeWithRetry(() =>
      withTimeout(
        sql`
          SELECT COUNT(*) AS count FROM clients
          WHERE LOWER(TRIM(clients.username)) = LOWER(TRIM(${username}))
          AND client_name ILIKE ${'%' + searchQuery + '%'};
        `,
        10000
      )
    );

    const total = parseInt(totalClients[0]?.count || '0', 10);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      clients,
      total,
      page,
      totalPages,
      limit,
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

export default router;
