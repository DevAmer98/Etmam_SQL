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

router.use(express.json());

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

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

router.get('/quotations/supervisor', async (req, res) => {
    const client = await pool.connect();
    try {
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const query = `%${req.query.query || ''}%`;
      const status = req.query.status || 'all';
      const offset = (page - 1) * limit;
  
      const hasStatus = status !== 'all';
      const countParams = hasStatus ? [query, status] : [query];
      const countCondition = hasStatus
        ? `(quotations.status = $2 OR quotations.supervisoraccept = $2)`
        : 'TRUE';
  
      // COUNT query
      const countQuery = `
        SELECT COUNT(*) AS count
        FROM quotations
        JOIN clients ON quotations.client_id = clients.id
        WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
        AND ${countCondition}
      `;
  
      const countResult = await executeWithRetry(() =>
        client.query(countQuery, countParams)
      );
      const totalCount = parseInt(countResult.rows[0].count, 10);
  
      // Build pagination query
      const baseParams = hasStatus
        ? [limit, offset, query, status]
        : [limit, offset, query];
  
      const filterCondition = hasStatus
        ? `(quotations.status = $4 OR quotations.supervisoraccept = $4)`
        : 'TRUE';
  
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
          clients.region AS client_region
        FROM quotations
        JOIN clients ON quotations.client_id = clients.id
        WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
        AND ${filterCondition}
        ORDER BY quotations.created_at DESC
        LIMIT $1 OFFSET $2
      `;
  
      const quotationsResult = await executeWithRetry(() =>
        client.query(baseQuery, baseParams)
      );
  
      const orders = quotationsResult.rows;
  
      return res.status(200).json({
        orders,
        totalCount,
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
      });
    } catch (error) {
      console.error('Error fetching quotations:', error);
      return res.status(500).json({
        error: error.message || 'Error fetching quotations',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    } finally {
      client.release();
    }
  });


  export default router;