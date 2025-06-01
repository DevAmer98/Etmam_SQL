import express from 'express';
import moment from 'moment-timezone';
import admin from '../../firebase-init.js';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json());

// Utility function to retry database operations
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    console.error(`Database operation failed (${3 - retries + 1}/3):`, error.message);
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

// Function to generate custom ID
const generateCustomId = async (client) => {
  try {
    const year = new Date().getFullYear();
    
    // Use a more robust query that handles potential non-numeric suffixes
    const result = await client.query(
      `SELECT COALESCE(
        MAX(
          CASE 
            WHEN SUBSTRING(custom_id FROM 'NPO-[0-9]{4}-([0-9]+)')::text ~ '^[0-9]+$' 
            THEN SUBSTRING(custom_id FROM 'NPO-[0-9]{4}-([0-9]+)')::int
            ELSE 0
          END
        ), 0
      ) AS last_id 
      FROM orders 
      WHERE custom_id ~ $1`,
      [`^NPO-${year}-[0-9]+`]
    );
    
    const lastId = result.rows[0].last_id || 0;
    const newId = `NPO-${year}-${String(lastId + 1).padStart(5, '0')}`;
    return newId;
  } catch (error) {
    console.error('Error generating custom ID:', error);
    throw new Error('Failed to generate order ID');
  }
};
// Function to send notifications to supervisors
async function sendNotificationToManager(message, title = 'Notification') {
  let client;
  try {
    client = await pool.connect();
    
    // Fetch FCM tokens for supervisors
    const query = 'SELECT fcm_token FROM Managers WHERE role = $1 AND active = TRUE';
    const result = await client.query(query, ['manager']);
    const tokens = result.rows.map((row) => row.fcm_token).filter((token) => token != null);

    console.log(`Sending notifications to manager:`, tokens);

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
        role: 'manager',
      },
      token,
    }));

    // Send the notifications
    const response = await admin.messaging().sendEach(messages);
    console.log('Successfully sent messages:', response);
    return response;
  } catch (error) {
    console.error('Failed to send FCM messages:', error);
    // Don't throw here - notification failure shouldn't fail the whole order creation
  } finally {
    if (client) client.release();
  }
}

// POST endpoint to create an order
router.post('/orders/supervisor', async (req, res) => {
  let client;
  
  try {
    // Validate request body first
    const { client_id, username, delivery_date, delivery_type, products, notes, deliveryLocations = [],total_vat, total_subtotal,status = 'not Delivered' } = req.body;

    // Input validation
    if (!client_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: {
          client_id: !client_id ? 'Required' : 'Valid',
          delivery_date: !delivery_date ? 'Required' : 'Valid',
          delivery_type: !delivery_type ? 'Required' : 'Valid',
          products: !products || products.length === 0 ? 'Required and must not be empty' : 'Valid'
        }
      });
    } 



    await executeWithRetry(async () => {
      client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Format date
        let formattedDate;
        try {
          formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
        } catch (dateError) {
          throw new Error('Invalid delivery date format');
        }

        // Generate custom ID
        const customId = await generateCustomId(client);

        // Insert order
        const orderResult = await withTimeout(
          client.query(
            `INSERT INTO orders (client_id, username, delivery_date, delivery_type, notes, total_vat, total_subtotal, status, custom_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7,$8, $9) RETURNING id`,
            [client_id, username, formattedDate, delivery_type, notes || null, total_vat, total_subtotal, status, customId]
          ),
          10000
        );

        if (!orderResult.rows || orderResult.rows.length === 0) {
          throw new Error('Failed to create order - no ID returned');
        }

        const orderId = orderResult.rows[0].id;
        let totalPrice = 0;

        // Insert products
        for (const product of products) {
          totalPrice += parseFloat(product.price) * parseFloat(product.quantity || 1);
          await withTimeout(
            client.query(
              `INSERT INTO order_products (order_id, description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, product.description, product.quantity,parseFloat(product.price),parseFloat(product.vat),parseFloat(product.subtotal)]
      ),
            5000
          );
        }

        
    for (const location of deliveryLocations) {
  if (location.name && location.url) {
    await client.query(
      `INSERT INTO order_locations (order_id, name, url)
       VALUES ($1, $2, $3)`,
      [orderId, location.name, location.url]
    );
  }
}

        // Update total price
        await withTimeout(
          client.query(`UPDATE orders SET total_price = $1 WHERE id = $2`, [totalPrice, orderId]),
          5000
        );

        await client.query('COMMIT');

        // Send notifications (don't let this fail the whole operation)
        try {
          await sendNotificationToManager(`تم إنشاء طلب جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار طلب جديد');
        } catch (notificationError) {
          console.error('Notification failed but order was created successfully:', notificationError);
        }

        return res.status(201).json({ 
          orderId, 
          customId, 
          status: 'success', 
          totalPrice,
          message: 'Order created successfully'
        });

      } catch (transactionError) {
        console.error('Transaction error:', transactionError);
        await client.query('ROLLBACK');
        throw transactionError;
      }
    });

  } catch (error) {
    console.error('Error creating order:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Error creating order';
    let statusCode = 500;
    
    if (error.message.includes('Invalid delivery date')) {
      errorMessage = 'Invalid delivery date format';
      statusCode = 400;
    } else if (error.message.includes('Failed to generate order ID')) {
      errorMessage = 'Failed to generate order ID';
      statusCode = 500;
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Database operation timed out';
      statusCode = 503;
    } else if (error.message.includes('Missing required fields')) {
      errorMessage = error.message;
      statusCode = 400;
    }

    return res.status(statusCode).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});



// Fixed GET endpoint to fetch orders for supervisor
router.get('/supervisor', async (req, res) => {
  let client;
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const query = req.query.query || '';

    const offset = (page - 1) * limit;

    const baseQuery = `
      SELECT 
        orders.id,
        orders.client_id,
        orders.delivery_date,
        orders.delivery_type,
        orders.notes,
        orders.created_at,
        orders.updated_at,
        orders.deleted_at,
        orders.status,
        orders.actual_delivery_date,
        orders.storekeeper_notes,
        orders.total_price,
        orders.username AS sales_rep_username,  -- Renamed for clarity
        orders.supervisoraccept,
        orders.storekeeperaccept,
        orders.manageraccept,
        orders.custom_id,
        orders.driver_notes,
        orders.supervisor_id,
        orders.total_vat,
        orders.total_subtotal,
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
        clients.username AS client_user_identifier

      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      ORDER BY orders.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
    `;

    const baseQueryParams = [limit, offset, `%${query}%`];
    const countQueryParams = [`%${query}%`];

    const [ordersResult, countResult] = await executeWithRetry(async () => {
      client = await pool.connect();
      return await Promise.all([
        withTimeout(client.query(baseQuery, baseQueryParams), 10000),
        withTimeout(client.query(countQuery, countQueryParams), 10000)
      ]);
    });

    const orders = ordersResult.rows;
    const totalCount = parseInt(countResult.rows[0]?.total || 0, 10);
    const hasMore = page * limit < totalCount;

    

    return res.status(200).json({
      orders,
      hasMore,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching orders',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});




// Fixed GET endpoint to fetch orders for supervisor
router.get('/orders/supervisor/:id', async (req, res) => {
  let client;
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const query = req.query.query || '';

    const offset = (page - 1) * limit;

    const baseQuery = `
      SELECT 
        orders.id,
        orders.client_id,
        orders.delivery_date,
        orders.delivery_type,
        orders.notes,
        orders.created_at,
        orders.updated_at,
        orders.deleted_at,
        orders.status,
        orders.actual_delivery_date,
        orders.storekeeper_notes,
        orders.total_price,
        orders.username AS sales_rep_username,  -- Renamed for clarity
        orders.supervisoraccept,
        orders.storekeeperaccept,
        orders.manageraccept,
        orders.custom_id,
        orders.driver_notes,
        orders.supervisor_id,
        orders.total_vat,
        orders.total_subtotal,
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
        clients.username AS client_user_identifier

      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      ORDER BY orders.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
    `;

    const baseQueryParams = [limit, offset, `%${query}%`];
    const countQueryParams = [`%${query}%`];

    const [ordersResult, countResult] = await executeWithRetry(async () => {
      client = await pool.connect();
      return await Promise.all([
        withTimeout(client.query(baseQuery, baseQueryParams), 10000),
        withTimeout(client.query(countQuery, countQueryParams), 10000)
      ]);
    });

    const orders = ordersResult.rows;
    const totalCount = parseInt(countResult.rows[0]?.total || 0, 10);
    const hasMore = page * limit < totalCount;

    

    return res.status(200).json({
      orders,
      hasMore,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching orders',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});
router.get('/orders/test/:id', async (req, res) => {
  let client;
  try {
    const orderId = req.params.id;
    const testQuery = `
      SELECT 
        orders.id,
        orders.username AS sales_rep_username,
        clients.username AS client_user_identifier,
        clients.client_name,
        clients.company_name AS client_company
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE orders.id = $1
    `;
    
    client = await pool.connect();
    const result = await client.query(testQuery, [orderId]);
    
    console.log('Test query result:', result.rows[0]);
    
    return res.status(200).json({
      message: 'Test query success',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Test query error:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

export default router;