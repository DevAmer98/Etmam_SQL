import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import managerApi from './api/manager/manager+api.js';
import singleManagerApi from './api/manager/[id]+api.js';
import supervisorApi from './api/supervisor/supervisor+api.js';
import singleSupervisorApi from './api/supervisor/[id]+api.js';
import storekeeperApi from './api/storekeeper/storekeeper+api.js';
import singleStorekeeperApi from './api/storekeeper/[id]+api.js';
import salesApi from './api/salesRep/salesRep+api.js';
import singleSalesApi from './api/salesRep/[id]+api.js';
import driverApi from './api/driver/driver+api.js';
import singleDriverApi from './api/driver/[id]+api.js';
import clientApi from './api/client/create+api.js';
import singleClientApi from './api/client/[id]+api.js';
import orderApi from './api/order/create+api.js';
import quotationApi from './api/quotation/create+api.js';
import singleOrderApi from './api/order/[id]+api.js';
import salesQuotationApi from './api/quotation/salesRep+api.js';
import supervisorAcceptQuotationApi from './api/quotation/acceptedOrders+api.js';
import storekeeperAcceptQuotationApi from './api/quotation/acceptedStorekeeper+api.js';
import singleQuotationApi from './api/quotation/[id]+api.js';
import salesOrderApi from './api/order/salesRep+api.js'; 
import supervisorAcceptOrderApi from './api/order/acceptedOrders+api.js';
import storekeeperAcceptOrderApi from './api/order/acceptedStorekeeper+api.js';
import getFcmApi from './api/getFcmToken+api.js';
import acceptedSupervisorApi from './api/acceptSupervisor/[id]+api.js';
import acceptedStorekeeperApi from './api/acceptStorekeeper/[id]+api.js';
import acceptedManagerApi from './api/acceptManager/[id]+api.js';
import acceptedSupervisorQoutationApi from './api/acceptSupervisorQuotation/[id]+api.js';
import acceptedStorekeeperQoutationApi from './api/acceptStorekeeperQuotation/[id]+api.js';
import acceptedManagerQoutationApi from './api/acceptManagerQuotation/[id]+api.js';
import supervisorOrderApi from './api/order/create+api.js'
import deliverdApi from './api/delivered/[id]+api.js';
import { servePDF } from './api/quotation/pdf.js'; 
import quotationSupervisorApi from './api/quotation/supervisor+api.js'

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Mount the API routes under /api
app.use('/api', managerApi);
app.use('/api', supervisorApi);
app.use('/api', storekeeperApi);
app.use('/api', salesApi);
app.use('/api', driverApi);
app.use('/api', clientApi);
app.use('/api', orderApi);
app.use('/api', quotationApi);
app.use('/api/order', supervisorAcceptOrderApi); // Mount under /api/order
app.use('/api/order', storekeeperAcceptOrderApi);
app.use('/api/order', salesOrderApi);
app.use('/api/order/supervisor', supervisorOrderApi);
app.use('/api/quotation', salesQuotationApi);
app.use('/api', quotationSupervisorApi); // Use your new router
app.use('/api/quotation', supervisorAcceptQuotationApi); // Mount under /api/order
app.use('/api/quotation', storekeeperAcceptQuotationApi);
app.use('/api', getFcmApi);
app.use('/api', acceptedSupervisorApi);
app.use('/api', acceptedStorekeeperApi);
app.use('/api', acceptedManagerApi);
app.use('/api', acceptedSupervisorQoutationApi);
app.use('/api', acceptedStorekeeperQoutationApi);
app.use('/api', acceptedManagerQoutationApi);
app.use('/api', deliverdApi);
app.use('/api', singleQuotationApi);
app.use('/api', singleManagerApi);
app.use('/api', singleOrderApi);
app.use('/api', singleClientApi);
app.use('/api', singleDriverApi);
app.use('/api', singleSalesApi);
app.use('/api', singleStorekeeperApi);
app.use('/api', singleSupervisorApi);









// New endpoint to generate and serve PDFs
app.get('/api/quotation/pdf/:quotationId', async (req, res) => {
  const { quotationId } = req.params;
  await servePDF(quotationId, res);
});

// Error-handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});