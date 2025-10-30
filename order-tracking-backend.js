// ==========================================
// ORDER TRACKING BACKEND - Shopify Integration
// ==========================================
// This script handles:
// 1. Fetching real order data from Shopify
// 2. Storing payment slip uploads in order metafields
// 3. Updating order status

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const app = express();

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  shopifyDomain: process.env.SHOPIFY_DOMAIN || 'your-store.myshopify.com',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN || 'your-admin-api-access-token',
  port: process.env.PORT || 3001,
  
  // File upload settings (images only for payment slips)
  uploadPath: './uploads',
  maxFileSize: 10 * 1024 * 1024, // 10MB (increased for phone camera photos)
  allowedFileTypes: ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'],
};

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: CONFIG.maxFileSize },
  fileFilter: (req, file, cb) => {
    if (CONFIG.allowedFileTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم. يرجى تحميل صورة فقط (JPG, PNG, WEBP).'));
    }
  }
});

// ==========================================
// SHOPIFY API HELPERS
// ==========================================

function makeShopifyRequest(endpoint, method = 'GET', data = null) {
  const https = require('https');
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.shopifyDomain,
      port: 443,
      path: `/admin/api/2024-01/${endpoint}`,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': CONFIG.accessToken
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => {
        console.log(`API Response Status: ${res.statusCode}`);
        console.log(`API Response Body: ${responseBody.substring(0, 500)}`); // First 500 chars
        
        try {
          const jsonResponse = JSON.parse(responseBody);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(jsonResponse);
          } else {
            reject(new Error(`Shopify API Error: ${res.statusCode} - ${JSON.stringify(jsonResponse)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse JSON response. Status: ${res.statusCode}, Body: ${responseBody.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

function makeShopifyGraphQLRequest(query) {
  const https = require('https');
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    
    const options = {
      hostname: CONFIG.shopifyDomain,
      port: 443,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-Shopify-Access-Token': CONFIG.accessToken
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseBody);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(jsonResponse);
          } else {
            reject(new Error(`Shopify GraphQL Error: ${res.statusCode} - ${JSON.stringify(jsonResponse)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse GraphQL response: ${responseBody.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

// ==========================================
// ROUTES
// ==========================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Order Tracking Backend API',
    version: '1.0.0'
  });
});

// GET order details
app.get('/api/order/:orderNumber', async (req, res) => {
  console.log('\n--- Fetching Order ---');
  const { orderNumber } = req.params;
  
  try {
    // Fetch order from Shopify
    // Order number can be in format #1006 or just 1006
    const cleanOrderNumber = orderNumber.replace('#', '');
    
    // Search for order by name (order number)
    const ordersResponse = await makeShopifyRequest(
      `orders.json?name=${cleanOrderNumber}&status=any`
    );
    
    if (!ordersResponse.orders || ordersResponse.orders.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'لم يتم العثور على الطلب'
      });
    }
    
    const order = ordersResponse.orders[0];
    console.log('Order found:', order.name);
    
    // Get order metafields (for payment slip and fulfillment stage)
    const metafieldsResponse = await makeShopifyRequest(
      `orders/${order.id}/metafields.json`
    );
    
    // Find payment slip metafield
    const paymentSlipMetafield = metafieldsResponse.metafields?.find(
      mf => mf.namespace === 'custom' && mf.key === 'payment_slip'
    );
    
    // Find fulfillment stage metafield
    const fulfillmentStageMetafield = metafieldsResponse.metafields?.find(
      mf => mf.namespace === 'custom' && mf.key === 'fulfillment_stage'
    );
    
    // Transform order data to our format
    const orderData = {
      id: order.id,
      number: order.name,
      date: new Date(order.created_at).toLocaleDateString('ar-SA'),
      createdAt: order.created_at,
      status: mapOrderStatus(order, fulfillmentStageMetafield),
      email: order.email,
      phone: order.phone || order.customer?.phone,
      
      // Items
      items: order.line_items.map(item => ({
        id: item.id,
        name: item.name,
        variant: item.variant_title || '',
        quantity: item.quantity,
        price: `${parseFloat(item.price).toFixed(2)} ${order.currency}`,
        priceAmount: parseFloat(item.price),
        image: item.image_url || item.product_image || 'https://via.placeholder.com/80',
        sku: item.sku
      })),
      
      // Pricing
      subtotal: `${parseFloat(order.subtotal_price).toFixed(2)} ${order.currency}`,
      shipping: `${parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0).toFixed(2)} ${order.currency}`,
      tax: `${parseFloat(order.total_tax).toFixed(2)} ${order.currency}`,
      total: `${parseFloat(order.total_price).toFixed(2)} ${order.currency}`,
      currency: order.currency,
      
      // Amounts (for calculations)
      subtotalAmount: parseFloat(order.subtotal_price),
      shippingAmount: parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0),
      taxAmount: parseFloat(order.total_tax),
      totalAmount: parseFloat(order.total_price),
      
      // Status & fulfillment
      financialStatus: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      cancelled: order.cancelled_at !== null,
      cancelledAt: order.cancelled_at,
      
      // Payment slip (file_reference type - contains Shopify file ID)
      paymentSlip: paymentSlipMetafield ? {
        fileId: paymentSlipMetafield.value,
        uploaded: true
      } : null,
      
      // Calculate if can cancel (within 3 days)
      canCancel: canCancelOrder(order)
    };
    
    res.json({
      success: true,
      order: orderData
    });
    
  } catch (error) {
    console.error('❌ Error fetching order:', error.message);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء جلب بيانات الطلب'
    });
  }
});

// POST upload payment slip
app.post('/api/order/:orderNumber/upload-payment', upload.single('paymentSlip'), async (req, res) => {
  console.log('\n--- Upload Payment Slip ---');
  const { orderNumber } = req.params;
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'لم يتم تحميل أي ملف'
      });
    }
    
    // Get order
    const cleanOrderNumber = orderNumber.replace('#', '');
    const ordersResponse = await makeShopifyRequest(
      `orders.json?name=${cleanOrderNumber}&status=any`
    );
    
    if (!ordersResponse.orders || ordersResponse.orders.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'لم يتم العثور على الطلب'
      });
    }
    
    const order = ordersResponse.orders[0];
    
    console.log('Uploading file to Shopify Files...');
    
    // Step 1: Stage the file upload
    const stagedUploadResponse = await makeShopifyGraphQLRequest(`
      mutation generateStagedUploads {
        stagedUploadsCreate(input: {
          resource: FILE
          filename: "${req.file.originalname}"
          mimeType: "${req.file.mimetype}"
          httpMethod: POST
        }) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `);
    
    if (stagedUploadResponse.data?.stagedUploadsCreate?.userErrors?.length > 0) {
      throw new Error(`Staged upload error: ${JSON.stringify(stagedUploadResponse.data.stagedUploadsCreate.userErrors)}`);
    }
    
    const stagedTarget = stagedUploadResponse.data.stagedUploadsCreate.stagedTargets[0];
    console.log('Staged upload URL:', stagedTarget.url);
    
    // Step 2: Upload the actual file to the staged URL
    const FormData = require('form-data');
    const form = new FormData();
    
    // Add all parameters from staged upload
    stagedTarget.parameters.forEach(param => {
      form.append(param.name, param.value);
    });
    
    // Add the file
    form.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    
    // Upload to S3/GCS
    const https = require('https');
    const uploadUrl = new URL(stagedTarget.url);
    
    await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: uploadUrl.hostname,
        path: uploadUrl.pathname + uploadUrl.search,
        method: 'POST',
        headers: form.getHeaders()
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            console.log('File uploaded successfully to storage');
            resolve();
          } else {
            reject(new Error(`Upload failed: ${response.statusCode} - ${data}`));
          }
        });
      });
      
      request.on('error', reject);
      form.pipe(request);
    });
    
    // Step 3: Create the file in Shopify
    const fileCreateResponse = await makeShopifyGraphQLRequest(`
      mutation fileCreate {
        fileCreate(files: {
          alt: "Payment slip for order ${order.name}"
          contentType: IMAGE
          originalSource: "${stagedTarget.resourceUrl}"
        }) {
          files {
            id
            alt
            createdAt
            ... on MediaImage {
              image {
                url
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `);
    
    if (fileCreateResponse.data?.fileCreate?.userErrors?.length > 0) {
      throw new Error(`File create error: ${JSON.stringify(fileCreateResponse.data.fileCreate.userErrors)}`);
    }
    
    const uploadedFile = fileCreateResponse.data.fileCreate.files[0];
    console.log('File created in Shopify:', uploadedFile.id);
    
    // Step 4: Create or update metafield with file reference
    const metafieldData = {
      metafield: {
        namespace: 'custom',
        key: 'payment_slip',
        value: uploadedFile.id,
        type: 'file_reference'
      }
    };
    
    // Check if metafield exists
    const metafieldsResponse = await makeShopifyRequest(
      `orders/${order.id}/metafields.json`
    );
    
    const existingMetafield = metafieldsResponse.metafields?.find(
      mf => mf.namespace === 'custom' && mf.key === 'payment_slip'
    );
    
    if (existingMetafield) {
      // Update existing metafield
      await makeShopifyRequest(
        `orders/${order.id}/metafields/${existingMetafield.id}.json`,
        'PUT',
        metafieldData
      );
    } else {
      // Create new metafield
      await makeShopifyRequest(
        `orders/${order.id}/metafields.json`,
        'POST',
        metafieldData
      );
    }
    
    // Add note to order
    const noteData = {
      note: {
        note: `تم رفع إيصال الدفع من قبل العميل`,
        created_at: new Date().toISOString()
      }
    };
    
    // You might want to add a note or tag to the order
    console.log('✅ Payment slip uploaded successfully');
    
    res.json({
      success: true,
      message: 'تم رفع إيصال الدفع بنجاح',
      file: {
        name: req.file.originalname,
        size: req.file.size,
        uploadedAt: fileData.uploadedAt
      }
    });
    
  } catch (error) {
    console.error('❌ Error uploading payment slip:', error.message);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء رفع الملف'
    });
  }
});

// POST confirm payment
app.post('/api/order/:orderNumber/confirm-payment', async (req, res) => {
  console.log('\n--- Confirm Payment ---');
  const { orderNumber } = req.params;
  
  try {
    const cleanOrderNumber = orderNumber.replace('#', '');
    const ordersResponse = await makeShopifyRequest(
      `orders.json?name=${cleanOrderNumber}&status=any`
    );
    
    if (!ordersResponse.orders || ordersResponse.orders.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'لم يتم العثور على الطلب'
      });
    }
    
    const order = ordersResponse.orders[0];
    
    // Add tag to order
    const tags = order.tags ? order.tags.split(', ') : [];
    if (!tags.includes('payment-confirmed')) {
      tags.push('payment-confirmed');
    }
    
    await makeShopifyRequest(
      `orders/${order.id}.json`,
      'PUT',
      {
        order: {
          id: order.id,
          tags: tags.join(', ')
        }
      }
    );
    
    console.log('✅ Payment confirmed');
    
    res.json({
      success: true,
      message: 'تم تأكيد الدفع بنجاح'
    });
    
  } catch (error) {
    console.error('❌ Error confirming payment:', error.message);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء تأكيد الدفع'
    });
  }
});

// POST cancel order
app.post('/api/order/:orderNumber/cancel', async (req, res) => {
  console.log('\n--- Cancel Order ---');
  const { orderNumber } = req.params;
  const { reason } = req.body;
  
  try {
    const cleanOrderNumber = orderNumber.replace('#', '');
    const ordersResponse = await makeShopifyRequest(
      `orders.json?name=${cleanOrderNumber}&status=any`
    );
    
    if (!ordersResponse.orders || ordersResponse.orders.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'لم يتم العثور على الطلب'
      });
    }
    
    const order = ordersResponse.orders[0];
    
    // Check if can cancel
    if (!canCancelOrder(order)) {
      return res.status(400).json({
        success: false,
        error: 'لا يمكن إلغاء الطلب بعد مرور 3 أيام'
      });
    }
    
    // Cancel order
    await makeShopifyRequest(
      `orders/${order.id}/cancel.json`,
      'POST',
      {
        reason: reason || 'customer',
        email: true
      }
    );
    
    console.log('✅ Order cancelled');
    
    res.json({
      success: true,
      message: 'تم إلغاء الطلب بنجاح'
    });
    
  } catch (error) {
    console.error('❌ Error cancelling order:', error.message);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء إلغاء الطلب'
    });
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function mapOrderStatus(order, fulfillmentStageMetafield) {
  // Priority 1: Check if order is cancelled (by admin or customer)
  if (order.cancelled_at) {
    return 'cancelled';
  }
  
  // Priority 2: Check custom fulfillment_stage metafield
  // This gives admin full control over processing, shipped, delivered stages
  if (fulfillmentStageMetafield && fulfillmentStageMetafield.value) {
    const stage = fulfillmentStageMetafield.value.toLowerCase();
    // Valid values: 'processing', 'shipped', 'delivered'
    if (['processing', 'shipped', 'delivered'].includes(stage)) {
      return stage;
    }
  }
  
  // Priority 3: Check if admin marked order as paid in Shopify
  // When financial_status = 'paid', order is confirmed
  if (order.financial_status === 'paid') {
    return 'confirmed';
  }
  
  // Priority 4: Check if payment is pending
  // financial_status can be: 'pending', 'authorized', 'partially_paid', 'partially_refunded', 'voided', 'refunded'
  if (order.financial_status === 'pending' || 
      order.financial_status === 'authorized' || 
      order.financial_status === 'partially_paid') {
    return 'pending_payment';
  }
  
  // Default: pending payment
  return 'pending_payment';
}

function canCancelOrder(order) {
  if (order.cancelled_at) {
    return false;
  }
  
  if (order.fulfillment_status === 'fulfilled' || order.fulfillment_status === 'shipped') {
    return false;
  }
  
  // Check if within 3 days
  const createdAt = new Date(order.created_at);
  const now = new Date();
  const daysDiff = (now - createdAt) / (1000 * 60 * 60 * 24);
  
  return daysDiff <= 3;
}

// ==========================================
// START SERVER
// ==========================================

app.listen(CONFIG.port, () => {
  console.log(`🚀 Order Tracking Backend running on port ${CONFIG.port}`);
  console.log(`Shop: ${CONFIG.shopifyDomain}`);
  console.log(`API Endpoints:`);
  console.log(`  - GET  /api/order/:orderNumber`);
  console.log(`  - POST /api/order/:orderNumber/upload-payment`);
  console.log(`  - POST /api/order/:orderNumber/confirm-payment`);
  console.log(`  - POST /api/order/:orderNumber/cancel`);
  console.log('\nReady to handle order tracking requests!');
});

