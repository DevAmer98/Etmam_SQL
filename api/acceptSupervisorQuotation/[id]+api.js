import pkg from 'pg'; // New
const { Pool } = pkg; // Destructure Pool
import express from 'express';
import admin from '../../firebase-init.js';
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

// Function to send notifications to storekeepers
async function sendNotificationToSalesRep(message, title = 'Notification') {
  const client = await pool.connect();
  try {
    const query = 'SELECT fcm_token FROM Salesreps WHERE role = $1 AND active = TRUE';
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(query, ['salesRep']), 10000); // 10-second timeout
    });
    const tokens = result.rows.map((row) => row.fcm_token).filter((token) => token != null);

    console.log(`Sending notifications to sales:`, tokens);

    // Check if tokens array is empty
    if (tokens.length === 0) {
      console.warn('No FCM tokens found for sales. Skipping notification.');
      return;
    }

    // Prepare the messages for Firebase
    const messages = tokens.map((token) => ({
      notification: {
        title: title,
        body: message,
      },
      data: {
        role: 'salesRep', // Add role information to the payload
      },
      token,
    }));

    // Send the notifications
    const response = await admin.messaging().sendEach(messages);
    console.log('Successfully sent messages:', response);
    return response;
  } catch (error) {
    console.error('Failed to send FCM messages:', error);
    throw error;
  } finally {
    client.release();
  }
}


// Function to send notifications to storekeepers
async function sendNotificationToManager(message, title = 'Notification') {
  const client = await pool.connect();
  try {
    // Fetch FCM tokens for storekeepers
    const query = 'SELECT fcm_token FROM Managers WHERE role = $1 AND active = TRUE';
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(query, ['manager']), 10000); // 10-second timeout
    });
    const tokens = result.rows.map((row) => row.fcm_token).filter((token) => token != null);

    console.log(`Sending notifications to managers:`, tokens);

    // Check if tokens array is empty
    if (tokens.length === 0) {
      console.warn('No FCM tokens found for managers. Skipping notification.');
      return;
    }

    // Prepare the messages for Firebase
    const messages = tokens.map((token) => ({
      notification: {
        title: title,
        body: message,
      },
      data: {
        role: 'manager', // Add role information to the payload
      },
      token,
    }));

    // Send the notifications
    const response = await admin.messaging().sendEach(messages);
    console.log('Successfully sent messages:', response);
    return response;
  } catch (error) {
    console.error('Failed to send FCM messages:', error);
    throw error;
  } finally {
    client.release();
  }
}




// PUT /api/orders/:id/accept-supervisor
router.put('/acceptSupervisorQuotation/:id', async (req, res) => {
  const { id } = req.params;
  //const { supervisor_id } = req.body; // Supervisor ID passed in the request body

  if (!id) {
    return res.status(400).json({ error: 'Missing quotation ID' });
  }

  const client = await pool.connect();
  try {
    // Step 1: Verify that the supervisor exists
    /*const getSupervisorQuery = 'SELECT id FROM supervisors WHERE id = $1';
    const supervisorResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(getSupervisorQuery, [supervisor_id]), 10000); // 10-second timeout
    });

    if (supervisorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Supervisor not found' });
    }
*/
    // Step 2: Update the quotation with the supervisor's ID
    const updateOrderQuery = `
      UPDATE quotations 
      SET supervisoraccept = 'accepted',
                supervisoraccept_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    await executeWithRetry(async () => {
      return await withTimeout(client.query(updateOrderQuery, [id]), 10000); // 10-second timeout
    });

  
    await sendNotificationToManager(
      `تم قبول عرض السعر رقم ${id} من قبل المشرف.`,
      'المشرف قبل عرض السعر'
    );


    await sendNotificationToSalesRep(
      `تم قبول عرض السعر رقم ${id} من قبل المشرف.`,
      'المشرف قبل عرض السعر'
    );

    return res.status(200).json({ message: 'Quotation accepted successfully' });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

export default router;