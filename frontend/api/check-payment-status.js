// Vercel Serverless Function for PhonePe Order Status API
import crypto from 'crypto';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Extract merchant order ID from URL path
    const merchantOrderId = req.query.merchantOrderId;

    if (!merchantOrderId) {
      return res.status(400).json({
        success: false,
        error: 'Missing merchantOrderId parameter'
      });
    }

    // PhonePe API Configuration
    const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID || 'M22CKBZWGEK83'; // Replace with your merchant ID
    const PHONEPE_SALT_KEY = process.env.PHONEPE_SALT_KEY || 'ad27c6e3-f9f5-4c84-b7c1-3c3a5e5c5b5c'; // Replace with your salt key
    const PHONEPE_SALT_INDEX = process.env.PHONEPE_SALT_INDEX || '1'; // Replace with your salt index
    const PHONEPE_BASE_URL = process.env.PHONEPE_ENV === 'production'
      ? 'https://api.phonepe.com/apis/hermes'
      : 'https://api-preprod.phonepe.com/apis/hermes';

    console.log('🔍 Checking PhonePe status for merchant order:', merchantOrderId);

    // Create the check status API path
    const apiPath = `/pg/v1/status/${PHONEPE_MERCHANT_ID}/${merchantOrderId}`;

    // Create X-VERIFY header as per PhonePe documentation
    const saltKey = `${PHONEPE_SALT_KEY}###${PHONEPE_SALT_INDEX}`;
    const sha256Hash = crypto.createHash('sha256').update(apiPath + saltKey).digest('hex');
    const xVerifyHeader = `${sha256Hash}###${PHONEPE_SALT_INDEX}`;

    console.log('📊 PhonePe API Request:', {
      url: `${PHONEPE_BASE_URL}${apiPath}`,
      merchantId: PHONEPE_MERCHANT_ID,
      apiPath,
      hasValidHeaders: !!xVerifyHeader
    });

    // Make request to PhonePe Order Status API
    const response = await fetch(`${PHONEPE_BASE_URL}${apiPath}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerifyHeader,
        'X-MERCHANT-ID': PHONEPE_MERCHANT_ID
      }
    });

    const responseData = await response.json();

    console.log('📋 PhonePe API Response:', {
      status: response.status,
      ok: response.ok,
      success: responseData.success,
      code: responseData.code,
      message: responseData.message,
      hasData: !!responseData.data
    });

    if (!response.ok) {
      console.error('❌ PhonePe API request failed:', {
        status: response.status,
        statusText: response.statusText,
        response: responseData
      });

      return res.status(response.status).json({
        success: false,
        error: `PhonePe API error: ${responseData.message || response.statusText}`,
        code: responseData.code,
        originalResponse: responseData
      });
    }

    // Check if PhonePe API returned success
    if (!responseData.success) {
      console.warn('⚠️ PhonePe API returned unsuccessful response:', responseData);

      return res.status(400).json({
        success: false,
        error: responseData.message || 'PhonePe API returned unsuccessful response',
        code: responseData.code,
        originalResponse: responseData
      });
    }

    // Extract transaction data
    const transactionData = responseData.data;

    if (!transactionData) {
      console.error('❌ No transaction data in PhonePe response');
      return res.status(400).json({
        success: false,
        error: 'No transaction data found in PhonePe response'
      });
    }

    // Get transaction status
    const transactionStatus = transactionData.state; // PhonePe uses 'state' field
    const transactionAmount = transactionData.amount;
    const transactionId = transactionData.transactionId;
    const providerReferenceId = transactionData.providerReferenceId;

    console.log('✅ PhonePe Transaction Status:', {
      merchantOrderId,
      transactionId,
      state: transactionStatus,
      amount: transactionAmount,
      providerReferenceId
    });

    // Map PhonePe states to our internal status
    let mappedStatus;
    switch (transactionStatus) {
      case 'COMPLETED':
        mappedStatus = 'COMPLETED';
        break;
      case 'PENDING':
        mappedStatus = 'PENDING';
        break;
      case 'FAILED':
        mappedStatus = 'FAILED';
        break;
      case 'EXPIRED':
        mappedStatus = 'EXPIRED';
        break;
      default:
        console.warn('🔶 Unknown PhonePe transaction state:', transactionStatus);
        mappedStatus = 'PENDING'; // Default to pending for unknown states
    }

    // Return successful response
    return res.json({
      success: true,
      data: {
        merchant_order_id: merchantOrderId,
        transaction_status: mappedStatus,
        transaction_id: transactionId,
        amount: transactionAmount,
        provider_reference_id: providerReferenceId,
        phonepe_state: transactionStatus,
        last_checked: new Date().toISOString(),
        // Include full transaction data for debugging
        full_response: transactionData
      },
      transactionStatus: mappedStatus, // For backward compatibility
      message: `Transaction status: ${mappedStatus}`
    });

  } catch (error) {
    console.error('💥 Error checking PhonePe payment status:', error);

    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error while checking payment status',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}