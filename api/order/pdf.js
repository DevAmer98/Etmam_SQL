import { fileURLToPath } from 'url'; // Add this import
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import pg from 'pg'; // Import the entire pg module
const { Pool } = pg; // Destructure Pool from the pg module
import libre from 'libreoffice-convert'; // For .docx to PDF conversion


// Derive __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


function fixBidirectionalText(text) {
  const LRM = '\u200E'; // Left-to-right mark
  const RLM = '\u200F'; // Right-to-left mark

  // Wrap Latin words and digits with LRM
  return text.replace(/([A-Za-z0-9\-]+)/g, `${LRM}$1${LRM}`);
}


// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generates a PDF from order data using PDFKit.
 * @param {Object} orderData - The order data to populate the template.
 * @param {string} filePath - The path to save the PDF (optional).
 * @returns {Promise<Buffer>} - Returns the PDF buffer for streaming.
 */


/**
 * Generates a PDF from a .docx template using docxtemplater and libreoffice-convert.
 * @param {Object} orderData - The order data to populate the template.
 * @param {string} templatePath - The path to the .docx template file.
 * @param {string} filePath - The path to save the PDF (optional).
 * @returns {Promise<Buffer>} - Returns the PDF buffer for streaming.
 */export async function generatePDF(orderData, templatePath, filePath = null) {
  try {
    console.log('Loading template from:', templatePath);

    // Load the .docx template
    const templateContent = fs.readFileSync(templatePath, 'binary');
    const zip = new PizZip(templateContent);

    // Initialize Docxtemplater
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    // Populate the template with data
    doc.setData(orderData);

    // Render the document
    try {
      doc.render();
    } catch (error) {
      console.error('Error rendering template:', error);
      throw new Error(`Failed to render template: ${error.message}`);
    }

    // Generate the .docx buffer
    const docxBuffer = doc.getZip().generate({ type: 'nodebuffer' });

    // Convert the .docx buffer to a PDF
    const pdfBuffer = await convertDocxToPDF(docxBuffer);

    // Save the PDF file if filePath is provided
    if (filePath) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, pdfBuffer);
    }

    // Return the PDF buffer
    return pdfBuffer;
  } catch (error) {
    console.error('Error generating PDF:', error);
    throw new Error(`Failed to generate PDF: ${error.message}`);
  }
}
/**
 * Converts a .docx buffer to a PDF buffer using libreoffice-convert.
 * @param {Buffer} docxBuffer - The .docx file as a buffer.
 * @returns {Promise<Buffer>} - The PDF file as a buffer.
 */
async function convertDocxToPDF(docxBuffer) {
  return new Promise((resolve, reject) => {
    libre.convert(docxBuffer, '.pdf', undefined, (err, pdfBuffer) => {
      if (err) {
        reject(err);
      } else {
        resolve(pdfBuffer);
      }
    });
  });
}
/**
 * Fetches order data from the database.
 * @param {string} orderId - The ID of the order.
 * @returns {Promise<Object>} - The order data.
 */
async function fetchOrderDataFromDatabase(orderId) {
  try {
    console.log(`Fetching data for order ID: ${orderId}`); // Log the order ID

    // Fetch order details
    const orderQuery = `
      SELECT o.*, c.company_name, c.client_name, c.phone_number, 
             c.tax_number, c.branch_number, c.latitude, c.longitude, 
             c.street, c.city, c.region, o.storekeeper_notes,
             s.name AS supervisor_name -- Include supervisor's name
      FROM orders o
      JOIN clients c ON o.client_id = c.id
      LEFT JOIN supervisors s ON o.supervisor_id = s.id -- Join with supervisors table
      WHERE o.id = $1
    `;
    const orderResult = await pool.query(orderQuery, [orderId]);
    console.log('Order Query Result:', orderResult.rows); // Log the query result

    if (orderResult.rows.length === 0) {
      throw new Error('Order not found');
    }

    // Fetch products
    const productsQuery = `
      SELECT * FROM order_products
      WHERE order_id = $1
    `;
    const productsResult = await pool.query(productsQuery, [orderId]);
    console.log('Products Query Result:', productsResult.rows); // Log the query result

    // Add product numbers dynamically (no need to recalculate VAT and subtotal)
    const productsWithNumbers = productsResult.rows.map((product, index) => ({
      ...product,
      productNumber: String(index + 1).padStart(3, '0'), // Format as 001, 002, etc.
        name: fixBidirectionalText(product.name), // Fix the bidirectional issue here

    }));

    // Fetch sales representative
    const salesRepQuery = `
      SELECT name, email, phone FROM salesreps
      WHERE id = $1
    `;
    const salesRepResult = await pool.query(salesRepQuery, [orderResult.rows[0].sales_rep_id]);
    console.log('Sales Rep Query Result:', salesRepResult.rows); // Log the query result

    // Format the created_at field to only include the date
    const formattedCreatedAt = new Date(orderResult.rows[0].created_at).toISOString().split('T')[0];

    // Flatten salesRep fields into the root of the orderData object
    const orderData = {
      ...orderResult.rows[0],
      created_at: formattedCreatedAt, // Use the formatted date
      products: productsWithNumbers, // Use products with dynamically generated numbers
      name: salesRepResult.rows[0]?.name || 'N/A', // Default value if missing
      email: salesRepResult.rows[0]?.email || 'N/A', // Default value if missing
      phone: salesRepResult.rows[0]?.phone || 'N/A', // Default value if missing
      supervisor_name: orderResult.rows[0]?.supervisor_name || 'No Supervisor Assigned', // Include supervisor's name
    };

    console.log('Final Order Data:', orderData); // Log the final orderData object

    return orderData;
  } catch (error) {
    console.error('Error fetching order data:', error);
    throw new Error('Failed to fetch order data');
  }
} 
/**
 * Serves the PDF for a given order ID.
 * @param {string} orderId - The ID of the order.
 * @param {Object} res - The Express response object.
 */
export async function serveOrderPDF(orderId, res) {
  try {
    // Fetch order data from the database
    const orderData = await fetchOrderDataFromDatabase(orderId);
    console.log('Order Data:', orderData); // Log the orderData object


    // Generate the PDF
    const templatePath = path.resolve(__dirname, '../../templates/Order.docx');
    const pdfBuffer = await generatePDF(orderData, templatePath);


      // Use custom_id for the filename
      const customId = orderData.custom_id || `order_${orderId}`; // Fallback to quotationId if custom_id is missing
      const fileName = `order_${customId}.pdf`;

    // Set headers for mobile compatibility
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send the PDF as a response
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error serving PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF. Please try again later.' });
  }
}