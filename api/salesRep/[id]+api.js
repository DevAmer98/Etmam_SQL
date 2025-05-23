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

// Connect to the database
async function connectToDatabase() {
  try {
    const client = await executeWithRetry(async () => {
      return await withTimeout(pool.connect(), 5000); // 5-second timeout
    });
    console.log('Database connected');
    return client;
  } catch (err) {
    console.error('Failed to connect to database:', err);
    throw new Error('Database connection failed');
  }
}

// Function to delete a Clerk user
async function deleteClerkUser(clerkId) {
  try {
    const response = await executeWithRetry(async () => {
      return await withTimeout(
        fetch(`https://api.clerk.dev/v1/users/${clerkId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
            'Clerk-Backend-API-Version': '2023-05-12',
          },
        }),
        10000 // 10-second timeout
      );
    });

    if (!response.ok) {
      throw new Error('Failed to delete user from Clerk.');
    }
  } catch (error) {
    console.error('Error deleting Clerk user:', error);
    throw error;
  }
}

// GET /api/salesreps/:id
router.get('/salesreps/:id', async (req, res) => {
  const client = await connectToDatabase();
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: 'SalesRep ID is required' });
    }

    // Query the salesRep by ID
    const query = 'SELECT * FROM salesreps WHERE id = $1';
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(query, [id]), 10000); // 10-second timeout
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'SalesRep not found' });
    }

    return res.status(200).json({ success: true, salesRep: result.rows[0] });
  } catch (error) {
    console.error('Error fetching SalesRep:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error fetching salesRep details',
    });
  } finally {
    client.release();
  }
});

// DELETE /api/salesreps/:id
router.delete('/salesreps/:id', async (req, res) => {
  const client = await connectToDatabase();
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: 'SalesRep ID is required' });
    }

    // Fetch the Clerk ID before deletion
    const salesRepQuery = 'SELECT clerk_id FROM salesreps WHERE id = $1';
    const salesRepResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(salesRepQuery, [id]), 10000); // 10-second timeout
    });

    if (salesRepResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'SalesRep not found' });
    }

    const { clerk_id } = salesRepResult.rows[0];

    // Delete the salesRep from the database
    const deleteQuery = 'DELETE FROM salesreps WHERE id = $1';
    await executeWithRetry(async () => {
      return await withTimeout(client.query(deleteQuery, [id]), 10000); // 10-second timeout
    });

    // Delete the salesRep from Clerk
    await deleteClerkUser(clerk_id);

    return res.status(200).json({ success: true, message: 'SalesRep deleted successfully' });
  } catch (error) {
    console.error('Error deleting SalesRep:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/salesreps/:id
router.put('/salesreps/:id', async (req, res) => {
  const client = await connectToDatabase();
  try {
    const { id } = req.params;
    const { name, email, phone, role } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: 'SalesRep ID is required' });
    }

    if (!name || !email || !phone || !role) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Fetch the Clerk ID from the database
    const fetchClerkIdQuery = 'SELECT clerk_id FROM salesreps WHERE id = $1';
    const fetchResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(fetchClerkIdQuery, [id]), 10000); // 10-second timeout
    });

    if (fetchResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'SalesRep not found' });
    }

    const { clerk_id } = fetchResult.rows[0];

    // Update Clerk user
    const clerkUpdateResponse = await executeWithRetry(async () => {
      return await withTimeout(
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
        10000 // 10-second timeout
      );
    });

    if (!clerkUpdateResponse.ok) {
      const errorData = await clerkUpdateResponse.json();
      console.error('Error updating Clerk user:', errorData);
      throw new Error('Failed to update salesRep in Clerk');
    }

    // Update salesRep in the database
    const updateQuery = `
      UPDATE salesreps
      SET name = $1, email = $2, phone = $3, role = $4
      WHERE id = $5
      RETURNING id, name, email, phone, role
    `;
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(updateQuery, [name, email, phone, role, id]), 10000); // 10-second timeout
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'SalesRep not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'SalesRep updated successfully in both Clerk and database',
      salesRep: result.rows[0],
    });
  } catch (error) {
    console.error('Error updating SalesRep:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

export default router;