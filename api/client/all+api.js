import express from 'express';
import { neon } from '@neondatabase/serverless';

const router = express.Router();

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

// POST /api/clients
router.post('/clients', async (req, res) => {
  try {
    const sql = neon(`${process.env.DATABASE_URL}`);
    const {
      company_name,
      username,
      client_name,
      client_type,
      phone_number,
      tax_number,
      branch_number,
      location,
    } = req.body;

    // Validate required fields
    if (
      !company_name ||
      !client_name ||
      !client_type ||
      !phone_number ||
      !branch_number ||
      !location ||
      !location.latitude ||
      !location.longitude
    ) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Enforce tax_number validation based on client_type
    if (client_type !== 'One-time cash client' && !tax_number) {
      return res.status(400).json({ error: 'Missing required field: tax_number' });
    }

    // Use null for `tax_number` if it's optional
    const response = await executeWithRetry(async () => {
      return await withTimeout(
        sql`
          INSERT INTO clients (
            company_name,
            username, 
            client_name,
            client_type,
            phone_number, 
            tax_number,
            branch_number,
            latitude,  
            longitude,
            street,
            city,
            region
          ) 
          VALUES (
            ${company_name},
            ${username},
            ${client_name},
            ${client_type},
            ${phone_number},
            ${tax_number || null},  -- Allow null for optional tax_number
            ${branch_number},
            ${location.latitude},
            ${location.longitude},
            ${location.street || null},
            ${location.city || null},
            ${location.region || null}
          );
        `,
        10000 // 10-second timeout
      );
    });

    return res.status(201).json({ data: response });
  } catch (error) {
    console.error('Error creating clients:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// GET /api/clients
router.get('/clients', async (req, res) => {
  try {
    const sql = neon(`${process.env.DATABASE_URL}`);

    // Parse query parameters from the request URL
    const limit = parseInt(req.query.limit || '10', 10); // Default limit is 10
    const page = parseInt(req.query.page || '1', 10); // Default page is 1
    const searchQuery = req.query.search || ''; // Default to empty string for no search


    // Calculate the offset for pagination
    const offset = (page - 1) * limit;

    // Fetch filtered and paginated clients
    const clients = await executeWithRetry(async () => {
      return await withTimeout(
        sql`
          SELECT * FROM clients
          WHERE client_name ILIKE ${'%' + searchQuery + '%'}
          ORDER BY client_name
          LIMIT ${limit}
          OFFSET ${offset};
        `,
        10000 // 10-second timeout
      );
    });

    // Fetch the total count of clients for pagination metadata
    const totalClients = await executeWithRetry(async () => {
      return await withTimeout(
        sql`
          SELECT COUNT(*) AS count FROM clients
          WHERE client_name ILIKE ${'%' + searchQuery + '%'};
        `,
        10000 // 10-second timeout
      );
    });

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