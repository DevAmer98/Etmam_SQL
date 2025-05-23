import express from 'express';
import pkg from 'pg'; // Import the default export
const { Pool } = pkg; // Destructure Pool from the default export

const router = express.Router();

// Initialize PostgreSQL connection pool
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

// Test database connection
async function testConnection() {
  try {
    const res = await executeWithRetry(async () => {
      return await withTimeout(pool.query('SELECT 1 AS test'), 5000); // 5-second timeout
    });
    console.log('Database connection successful:', res.rows);
  } catch (error) {
    console.error('Database connection error:', error);
  }
}

testConnection();

// GET /api/clients/:id
router.get('/clients/:id', async (req, res) => {
  const { id } = req.params;

  console.log('Extracted client ID:', id); // Debugging line

  if (!id) {
    return res.status(400).json({ error: 'Missing client ID' });
  }

  try {
    const clientQuery = 'SELECT * FROM clients WHERE id = $1';
    const clientResult = await executeWithRetry(async () => {
      return await withTimeout(pool.query(clientQuery, [id]), 10000); // 10-second timeout
    });

    console.log('SQL query result:', clientResult.rows);

    if (clientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found', id });
    }

    return res.status(200).json(clientResult.rows[0]);
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

// PUT /api/clients/:id
router.put('/clients/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Missing client ID' });
  }

  try {
    const updateQuery = `
      UPDATE clients 
      SET 
        company_name = $1,
        client_name = $2,
        phone_number = $3,
        tax_number = $4,
        branch_number = $5,
        latitude = $6,
        longitude = $7,
        street = $8,
        city = $9,
        region = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
    `;

    const values = [
      body.company_name,
      body.client_name,
      body.phone_number,
      body.tax_number,
      body.branch_number,
      body.latitude,
      body.longitude,
      body.street,
      body.city,
      body.region,
      id,
    ];

    const updateResult = await executeWithRetry(async () => {
      return await withTimeout(pool.query(updateQuery, values), 10000); // 10-second timeout
    });

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ error: 'Client not found or no changes made' });
    }

    return res.status(200).json({ message: 'Client updated successfully' });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

// DELETE /api/clients/:id
router.delete('/clients/:id', async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing client ID' });
  }

  try {
    const deleteQuery = 'DELETE FROM clients WHERE id = $1';
    const deleteResult = await executeWithRetry(async () => {
      return await withTimeout(pool.query(deleteQuery, [id]), 10000); // 10-second timeout
    });

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    return res.status(200).json({ message: 'Client deleted successfully' });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

export default router;