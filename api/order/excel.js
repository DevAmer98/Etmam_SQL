import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import ExcelJS from 'exceljs';
import pg from 'pg';
const { Pool } = pg;

// Derive __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generates an Excel file from order data.
 * @param {Object} orderData - The order data including products.
 * @returns {Promise<Buffer>} - Returns the Excel buffer.
 */

/*
async function generateExcel(orderData) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Order');

  // Header Information
  sheet.addRow(['Order ID', orderData.custom_id || orderData.id]);
  sheet.addRow(['Client Name', orderData.client_name]);
  sheet.addRow(['Company Name', orderData.company_name]);
  sheet.addRow(['Order Date', orderData.created_at]);
  sheet.addRow([]);

  // Product Table Headers
  sheet.columns = [
  { header: 'Product #', key: 'productNumber', width: 10 },
  { header: 'Description', key: 'description', width: 30 },
  { header: 'Quantity', key: 'quantity', width: 10 },
  { header: 'Unit Price', key: 'price', width: 15 },
  { header: 'VAT', key: 'vat', width: 10 },
  { header: 'Subtotal', key: 'subtotal', width: 15 },
];

  // Add Product Rows
  orderData.products.forEach(product => {
   sheet.addRow({
    productNumber: product.productNumber,
    description: product.description,
    quantity: product.quantity,
    price: product.price,
    vat: product.vat,
    subtotal: product.subtotal,
  });
  });

  // Buffer output
  return await workbook.xlsx.writeBuffer();
}

*/

async function generateExcel(orderData) {
  const workbook = new ExcelJS.Workbook();
  const templatePath = path.resolve(__dirname, '../../templates/Order.xlsx');


  await workbook.xlsx.readFile(templatePath);

  const sheet = workbook.getWorksheet(1); // Assuming first sheet

  // Replace placeholders in known cells
  const replacements = {
    '{{client_name}}': orderData.client_name,
    '{{company_name}}': orderData.company_name,
    '{{created_at}}': orderData.created_at,
  };

  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === 'string' && replacements[cell.value]) {
        cell.value = replacements[cell.value];
      }
    });
  });

  // Find the row with '{{rows}}'
  let insertRowIndex;
  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      if (cell.value === '{{rows}}') {
        insertRowIndex = rowNumber;
      }
    });
  });

  if (insertRowIndex) {
    sheet.spliceRows(insertRowIndex, 1); // remove the placeholder row

    // Insert products
    orderData.products.forEach((product, i) => {
      sheet.insertRow(insertRowIndex + i, [
        product.productNumber,
        product.description,
        product.quantity,
        product.price,
      ]);
    });
  }

  // Return buffer
  return await workbook.xlsx.writeBuffer();
}

/**
 * Fetches order data from the database.
 * @param {string} orderId - The ID of the order.
 * @returns {Promise<Object>} - The order data.
 */
async function fetchOrderDataFromDatabase(orderId) {
  try {
    console.log(`Fetching data for order ID: ${orderId}`);

    const orderQuery = `
      SELECT q.*, c.company_name, c.client_name, c.phone_number, 
             c.tax_number, c.branch_number, c.latitude, c.longitude, 
             c.street, c.city, c.region, q.storekeeper_notes,
             s.name AS supervisor_name
      FROM orders q
      JOIN clients c ON q.client_id = c.id
      LEFT JOIN supervisors s ON q.supervisor_id = s.id
      WHERE q.id = $1
    `;
    const orderResult = await pool.query(orderQuery, [orderId]);

    if (orderResult.rows.length === 0) {
      throw new Error('Quotation not found');
    }

    const productsQuery = `
      SELECT * FROM order_products
      WHERE order_id = $1
    `;
    const productsResult = await pool.query(productsQuery, [orderId]);

    const productsWithNumbers = productsResult.rows.map((product, index) => ({
      ...product,
      productNumber: String(index + 1).padStart(3, '0'),
    }));

    
    const formattedCreatedAt = new Date(orderResult.rows[0].created_at).toISOString().split('T')[0];

    const orderData = {
      ...orderResult.rows[0],
      created_at: formattedCreatedAt,
      products: productsWithNumbers,
    };

    return orderData;
  } catch (error) {
    console.error('Error fetching order data:', error);
    throw new Error('Failed to fetch order data');
  }
}
/**
 * Serves the Excel file for a given order ID.
 * @param {string} orderId - The ID of the order.
 * @param {Object} res - The Express response object.
 */
export async function serveXLXS(orderId, res) {
  try {
    // Fetch order data from the database
    const orderData = await fetchOrderDataFromDatabase(orderId);

    // Generate Excel file as buffer
    const buffer = await generateExcel(orderData);

    // Optional: use custom_id if available
    const customId = orderData.custom_id || `order_${orderId}`;
    const fileName = `order_${customId}.xlsx`;

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-Length', buffer.length);

    // Send buffer directly
    res.send(buffer);

  } catch (error) {
    console.error('Error generating Excel:', error);
    res.status(500).json({ error: 'Failed to generate Excel file. Please try again later.' });
  }
}
