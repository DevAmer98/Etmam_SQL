/*
import express from 'express';
import pkg from 'pg'; // Import the default export
const { Pool } = pkg; // Destructure Pool from the default export

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, 
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
/*
// GET /api/orders/:id
router.get('/orders/:id', async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  try {
    const orderQuery = `
      SELECT o.*, c.company_name, c.client_name, c.phone_number, 
             c.tax_number, c.branch_number, c.latitude, c.longitude, 
             c.street, c.city, c.region, o.storekeeper_notes
      FROM orders o
      JOIN clients c ON o.client_id = c.id
      WHERE o.id = $1
    `;


     const [orderResult, productsResult, locationsResult] = await Promise.all([
      executeWithRetry(() => withTimeout(pool.query(orderQuery, [id]), 10000)),
      executeWithRetry(() => withTimeout(pool.query(`
        SELECT * FROM order_products WHERE order_id = $1
      `, [id]), 10000)),
      executeWithRetry(() => withTimeout(pool.query(`
        SELECT name, url FROM order_locations WHERE order_id = $1
      `, [id]), 10000)),
    ]);

    //const orderResult = await executeWithRetry(async () => {
      //return await withTimeout(pool.query(orderQuery, [id]), 10000); // 10-second timeout
    //});
/*
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    /*const productsQuery = `
      SELECT * FROM order_products
      WHERE order_id = $1
    `;
    */
    ///const productsResult = await executeWithRetry(async () => {
      ///return await withTimeout(pool.query(productsQuery, [id]), 10000); // 10-second timeout
    ///});

    
/*
    const orderData = {
      ...orderResult.rows[0],
      products: productsResult.rows,
      deliveryLocations: locationsResult.rows, 
    };

    return res.status(200).json(orderData);
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});
/*
// PUT /api/orders/:id
router.put('/orders/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }
const client = await pool.connect();

  try {
    const {
      client_id,
      delivery_date,
      delivery_type,
      notes,
      products,
      status = 'not Delivered',
    } = body;
  await client.query('BEGIN');

    // Fetch the current quotation to get the custom_id
      const getOrderQuery = `SELECT custom_id FROM orders WHERE id = $1`;
      const orderResult = await executeWithRetry(async () => {
        return await withTimeout(client.query(getOrderQuery, [id]), 10000); // 10-second timeout
      });

      if (orderResult.rows.length === 0) {
        await client.query('ROLLBACK'); // Rollback if quotation not found
        return res.status(404).json({ error: 'Order not found' });
      }

      const currentCustomId = orderResult.rows[0].custom_id;
      let newCustomId;

      // Determine the next revision number
      const revisionMatch = currentCustomId.match(/Rev(\d+)$/);
      if (revisionMatch) {
        const currentRevision = parseInt(revisionMatch[1], 10);
        newCustomId = currentCustomId.replace(/Rev\d+$/, `Rev${currentRevision + 1}`);
      } else {
        newCustomId = `${currentCustomId} Rev1`;
      }

    // Set `actual_delivery_date` if the status is "delivered"
    const actualDeliveryDate = status === 'delivered' ? new Date().toISOString() : null;



         // Calculate totals based on products
      let totalPrice = 0;
      let totalVat = 0;
      let totalSubtotal = 0; 

      if (products && products.length > 0) {
        for (const product of products) {
          const { price, quantity } = product;
          const numericPrice = parseFloat(price) || 0;
          const numericQuantity = parseFloat(quantity) || 0;

          const totalPriceForProduct = numericPrice * numericQuantity; // Total price for the quantity
          const vat = totalPriceForProduct * 0.15; // VAT is 15% of the total price for the quantity
          const subtotal = totalPriceForProduct + vat; // Subtotal is total price + VAT

          totalPrice += totalPriceForProduct;
          totalVat += vat;
          totalSubtotal += subtotal;
        }
      }

    const updateOrderQuery = `
      UPDATE orders 
      SET client_id = $1,
          delivery_date = $2,
          delivery_type = $3,
          notes = $4,
          status = $5,
          storekeeperaccept = 'pending',
          supervisoraccept = 'pending',
          manageraccept = 'pending',
          manageraccept_at = NULL,
          supervisoraccept_at = NULL,
          storekeeperaccept_at = NULL,
          updated_at = CURRENT_TIMESTAMP,
          actual_delivery_date = COALESCE($6, actual_delivery_date),
          storekeeper_notes = $7,
          total_price = $8,
          total_vat = $9,
          total_subtotal = $10,
          custom_id = $11
      WHERE id = $12
    `;

    await executeWithRetry(async () => {
      return await withTimeout(
        client.query(updateOrderQuery, [
          client_id,
          delivery_date,
          delivery_type,
          notes || null,
          status,
          actualDeliveryDate,
          body.storekeeper_notes || null,
          totalPrice,
          totalVat,
          totalSubtotal,
          newCustomId, // Updated custom_id with revision number
          id,
        ]),
        10000 // 10-second timeout
      );
    });

    if (products && products.length > 0) {
      const deleteProductsQuery = `DELETE FROM order_products WHERE order_id = $1`;
      await executeWithRetry(async () => {
        return await withTimeout(client.query(deleteProductsQuery, [id]), 10000); // 10-second timeout
      });

      for (const product of products) {
        const { section, type, quantity, description,price } = product;

          // Calculate VAT and subtotal for each product
          const numericPrice = parseFloat(price) || 0;
          const numericQuantity = parseFloat(quantity) || 0;

          const totalPriceForProduct = numericPrice * numericQuantity; // Total price for the quantity
          const vat = totalPriceForProduct * 0.15; // VAT is 15% of the total price for the quantity
          const subtotal = totalPriceForProduct + vat; // Subtotal is total price + VAT


        await executeWithRetry(async () => {
          return await withTimeout(
            client.query(
              `INSERT INTO order_products (order_id, description, quantity,price, vat, subtotal) 
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [id,description, quantity, price,vat, subtotal]
            ),
            10000 // 10-second timeout
          );
        });
      }
    }

    if (body.deliveryLocations && Array.isArray(body.deliveryLocations)) {
  // Delete existing locations
  await executeWithRetry(async () => {
    return await withTimeout(
      client.query(`DELETE FROM order_locations WHERE order_id = $1`, [id]),
      10000
    );
  });

  // Re-insert updated delivery locations
  for (const loc of body.deliveryLocations) {
    const { name, url } = loc;
    if (name && url) {
      await executeWithRetry(async () => {
        return await withTimeout(
          client.query(
            `INSERT INTO order_locations (order_id, name, url) VALUES ($1, $2, $3)`,
            [id, name, url]
          ),
          10000
        );
      });
    }
  }
}
  await client.query('COMMIT');
    return res.status(200).json({ message: 'Order and products updated successfully' });
  } catch (error) {
      await client.query('ROLLBACK');

    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
  client.release();
}
});

// DELETE /api/orders/:id
router.delete('/orders/:id', async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  try {
    const deleteProductsQuery = `DELETE FROM order_products WHERE order_id = $1`;
    await executeWithRetry(async () => {
      return await withTimeout(pool.query(deleteProductsQuery, [id]), 10000); // 10-second timeout
    });

    const deleteOrderQuery = `DELETE FROM orders WHERE id = $1`;
    const deleteOrderResult = await executeWithRetry(async () => {
      return await withTimeout(pool.query(deleteOrderQuery, [id]), 10000); // 10-second timeout
    });

    if (deleteOrderResult.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.status(200).json({ message: 'Order and associated products deleted successfully' });
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

export default router;

*/



import express from 'express';
import pkg from 'pg'; // Import the default export
const { Pool } = pkg; // Destructure Pool from the default export

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
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

// GET /api/orders/:id
router.get('/orders/:id', async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  try {
    const orderQuery = `
      SELECT o.*, c.company_name, c.client_name, c.phone_number, 
             c.tax_number, c.branch_number, c.latitude, c.longitude, 
             c.street, c.city, c.region, o.storekeeper_notes
      FROM orders o
      JOIN clients c ON o.client_id = c.id
      WHERE o.id = $1
    `;

    const [orderResult, productsResult, locationsResult] = await Promise.all([
      executeWithRetry(() => withTimeout(pool.query(orderQuery, [id]), 10000)),
      executeWithRetry(() => withTimeout(pool.query(`
        SELECT * FROM order_products WHERE order_id = $1
      `, [id]), 10000)),
      executeWithRetry(() => withTimeout(pool.query(`
        SELECT name, url FROM order_locations WHERE order_id = $1
      `, [id]), 10000)),
    ]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = {
      ...orderResult.rows[0],
      products: productsResult.rows,
      deliveryLocations: locationsResult.rows,
    };

    return res.status(200).json(orderData);
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

// PUT /api/orders/:id
router.put('/orders/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  const client = await pool.connect();

  try {
    const {
      client_id,
      delivery_date,
      delivery_type,
      notes,
      products,
      status = 'not Delivered',
    } = body;

    await client.query('BEGIN');

    // Lock the row and fetch current status + custom_id to prevent races
    const getOrderQuery = `
      SELECT custom_id, status
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `;
    const orderResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(getOrderQuery, [id]), 10000);
    });

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Prevent update if already delivered
    const currentStatus = (orderResult.rows[0].status || '').toLowerCase();
    if (currentStatus === 'delivered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot update an order that is already delivered' });
    }

    // Build new custom_id revision
    const currentCustomId = orderResult.rows[0].custom_id;
    let newCustomId;
    const revisionMatch = currentCustomId?.match(/Rev(\d+)$/);
    if (revisionMatch) {
      const currentRevision = parseInt(revisionMatch[1], 10);
      newCustomId = currentCustomId.replace(/Rev\d+$/, `Rev${currentRevision + 1}`);
    } else {
      newCustomId = `${currentCustomId} Rev1`;
    }

    // Set `actual_delivery_date` if the incoming status is "delivered"
    const actualDeliveryDate = (status || '').toLowerCase() === 'delivered' ? new Date().toISOString() : null;

    // Calculate totals based on products
    let totalPrice = 0;
    let totalVat = 0;
    let totalSubtotal = 0;

    if (products && products.length > 0) {
      for (const product of products) {
        const { price, quantity } = product;
        const numericPrice = parseFloat(price) || 0;
        const numericQuantity = parseFloat(quantity) || 0;

        const totalPriceForProduct = numericPrice * numericQuantity;
        const vat = totalPriceForProduct * 0.15;
        const subtotal = totalPriceForProduct + vat;

        totalPrice += totalPriceForProduct;
        totalVat += vat;
        totalSubtotal += subtotal;
      }
    }

    const updateOrderQuery = `
      UPDATE orders
      SET client_id = $1,
          delivery_date = $2,
          delivery_type = $3,
          notes = $4,
          status = $5,
          storekeeperaccept = 'pending',
          supervisoraccept = 'pending',
          manageraccept = 'pending',
          manageraccept_at = NULL,
          supervisoraccept_at = NULL,
          storekeeperaccept_at = NULL,
          updated_at = CURRENT_TIMESTAMP,
          actual_delivery_date = COALESCE($6, actual_delivery_date),
          storekeeper_notes = $7,
          total_price = $8,
          total_vat = $9,
          total_subtotal = $10,
          custom_id = $11
      WHERE id = $12
        AND LOWER(status) <> 'delivered'  -- defensive guard
    `;

    const updateResult = await executeWithRetry(async () => {
      return await withTimeout(
        client.query(updateOrderQuery, [
          client_id,
          delivery_date,
          delivery_type,
          notes || null,
          status,
          actualDeliveryDate,
          body.storekeeper_notes || null,
          totalPrice,
          totalVat,
          totalSubtotal,
          newCustomId,
          id,
        ]),
        10000
      );
    });

    if (updateResult.rowCount === 0) {
      // Either not found (shouldn't happen due to earlier check) or status turned delivered in a race
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot update this order (possibly already delivered).' });
    }

    if (products && products.length > 0) {
      const deleteProductsQuery = `DELETE FROM order_products WHERE order_id = $1`;
      await executeWithRetry(async () => {
        return await withTimeout(client.query(deleteProductsQuery, [id]), 10000);
      });

      for (const product of products) {
        const { quantity, description, price } = product;

        const numericPrice = parseFloat(price) || 0;
        const numericQuantity = parseFloat(quantity) || 0;

        const totalPriceForProduct = numericPrice * numericQuantity;
        const vat = totalPriceForProduct * 0.15;
        const subtotal = totalPriceForProduct + vat;

        await executeWithRetry(async () => {
          return await withTimeout(
            client.query(
              `INSERT INTO order_products (order_id, description, quantity, price, vat, subtotal) 
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [id, description, numericQuantity, numericPrice, vat, subtotal]
            ),
            10000
          );
        });
      }
    }

    if (body.deliveryLocations && Array.isArray(body.deliveryLocations)) {
      // Delete existing locations
      await executeWithRetry(async () => {
        return await withTimeout(
          client.query(`DELETE FROM order_locations WHERE order_id = $1`, [id]),
          10000
        );
      });

      // Re-insert updated delivery locations
      for (const loc of body.deliveryLocations) {
        const { name, url } = loc;
        if (name && url) {
          await executeWithRetry(async () => {
            return await withTimeout(
              client.query(
                `INSERT INTO order_locations (order_id, name, url) VALUES ($1, $2, $3)`,
                [id, name, url]
              ),
              10000
            );
          });
        }
      }
    }

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Order and products updated successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// DELETE /api/orders/:id
router.delete('/orders/:id', async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock and check status first to prevent deleting delivered orders
    const checkQuery = `
      SELECT status
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `;
    const checkResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(checkQuery, [id]), 10000);
    });

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentStatus = (checkResult.rows[0].status || '').toLowerCase();
    if (currentStatus === 'delivered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot delete an order that is already delivered' });
    }

    const deleteProductsQuery = `DELETE FROM order_products WHERE order_id = $1`;
    await executeWithRetry(async () => {
      return await withTimeout(client.query(deleteProductsQuery, [id]), 10000);
    });

    const deleteOrderQuery = `DELETE FROM orders WHERE id = $1`;
    const deleteOrderResult = await executeWithRetry(async () => {
      return await withTimeout(client.query(deleteOrderQuery, [id]), 10000);
    });

    if (deleteOrderResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Order and associated products deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
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
