import express from 'express';
import pkg from 'pg'; // New
const { Pool } = pkg; // Destructure Pool

const router = express.Router();

// Create a connection pool instead of new client for each request
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

router.use(express.json());

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

router.get('/quotations/storekeeperaccept', async (req, res) => {
  const client = await pool.connect();
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const query = url.searchParams.get('query') || '';
    const status = url.searchParams.get('status') || 'all';
    const offset = (page - 1) * limit;

    let filterCondition = "quotations.storekeeperaccept = 'accepted'";
    const baseQueryParams = [limit, offset, `%${query}%`];

    if (status !== 'all') {
      filterCondition += ` AND quotations.status = $4`;
      baseQueryParams.push(status); // Ensure status is included if not 'all'
    }

    const baseQuery = `
      SELECT 
        quotations.*, 
        clients.client_name AS client_name,
        clients.phone_number AS client_phone,
        clients.company_name AS client_company,
        clients.branch_number AS client_branch,
        clients.tax_number AS client_tax,
        clients.latitude AS client_latitude,
        clients.longitude AS client_longitude,
        clients.street AS client_street,
        clients.city AS client_city,
        clients.region AS client_region,
        quotations.status,
        quotations.storekeeperaccept,
        quotations.supervisorAccept,
        quotations.actual_delivery_date,
        quotations.total_price 
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND ${filterCondition}
      ORDER BY quotations.delivery_date DESC
      LIMIT $1 OFFSET $2
    `;

    console.log('Executing SQL Query:', baseQuery);
    console.log('With Parameters:', baseQueryParams);

    const quotationsResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(baseQuery, baseQueryParams), 10000); // 10-second timeout
    });

    const totalCount = quotationsResult.rowCount;
    const hasMore = page * limit < totalCount;

    res.status(200).json({
      orders: quotationsResult.rows,
      hasMore,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching quotations:', error);
    res.status(500).json({
      error: error.message || 'Error fetching quotations',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;