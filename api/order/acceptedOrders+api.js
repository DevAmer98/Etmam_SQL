import express from 'express';
import pkg from 'pg'; // New
const { Pool } = pkg; // Destructure Pool

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

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





// GET /api/orders/supervisorAccept
router.get('/orders/supervisorAccept', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const query = `%${req.query.query || ''}%`;
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;
 
    const hasStatus = status !== 'all';

    // Filter condition shared across both queries
    let filterCondition = `orders.supervisoraccept = 'accepted'`;
    if (hasStatus) {
      filterCondition += ` AND orders.storekeeperaccept = $2`;
    }

    // Count query
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
      AND ${filterCondition}
    `;
    const countParams = hasStatus ? [query, status] : [query];
    const countResult = await executeWithRetry(() =>
      client.query(countQuery, countParams)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    // Paginated query
    const paginatedFilterCondition = hasStatus
      ? `orders.supervisoraccept = 'accepted' AND orders.storekeeperaccept = $4`
      : `orders.supervisoraccept = 'accepted'`;

    const baseQuery = `
      SELECT 
        orders.*,  
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
        orders.status,
        orders.storekeeperaccept,
        orders.supervisorAccept,
        orders.actual_delivery_date,
        orders.total_price 
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND ${paginatedFilterCondition}
      ORDER BY orders.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const baseParams = hasStatus
      ? [limit, offset, query, status]
      : [limit, offset, query];

    const ordersResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = ordersResult.rows;

    return res.status(200).json({
      orders,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching orders',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;
