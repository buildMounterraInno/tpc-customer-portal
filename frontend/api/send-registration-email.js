// Vercel Serverless Function for ZeptoMail
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

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {

    const { eventName, customerName, customerEmail, eventDate, eventAddress, paymentDetails, emailType = 'registration' } = req.body;

    // Validate required fields
    if (!eventName || !customerName || !customerEmail || !eventDate || !eventAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: eventName, customerName, customerEmail, eventDate, eventAddress'
      });
    }

    // ZeptoMail configuration
    const ZEPTO_API_KEY = 'Zoho-enczapikey PHtE6r1fR+Hs2mUv80AIs6C4FsChYIIrqL9uegROstpBCfIGTU1dq9orlmXj+Rt5VPRKQqbIzd9stemZ5+KGdz3pMm9PCWqyqK3sx/VYSPOZsbq6x00ftFgSd0LdVYDqetJv0CDTvtbdNA==';

    let emailPayload;

    if (emailType === 'payment' && paymentDetails) {
      // For payment confirmation emails, use regular email API with custom HTML
      const ZEPTO_API_URL = 'https://api.zeptomail.in/v1.1/email';

      const paymentDetailsHtml = `
        ${paymentDetails.orderId ? `<p style="margin: 5px 0;"><b>Order ID:</b> ${paymentDetails.orderId}</p>` : ''}
        ${paymentDetails.amount ? `<p style="margin: 5px 0;"><b>Amount:</b> ₹${paymentDetails.amount.toLocaleString()}</p>` : ''}
        ${paymentDetails.transactionId ? `<p style="margin: 5px 0;"><b>Transaction ID:</b> ${paymentDetails.transactionId}</p>` : ''}
        ${paymentDetails.utr ? `<p style="margin: 5px 0;"><b>UTR:</b> ${paymentDetails.utr}</p>` : ''}
        ${paymentDetails.paymentMode ? `<p style="margin: 5px 0;"><b>Payment Mode:</b> ${paymentDetails.paymentMode}</p>` : ''}
      `;

      emailPayload = {
        from: {
          address: "noreply@trippechalo.in",
          name: "TrippeChalo"
        },
        to: [{
          email_address: {
            address: customerEmail,
            name: customerName
          }
        }],
        subject: `Payment Confirmed - ${eventName}`,
        htmlbody: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1E63EF;">Payment Confirmed! 🎉</h2>
            <p>Dear <b>${customerName}</b>,</p>
            <p>Your payment has been successfully processed for:</p>

            <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin: 0 0 10px 0;">${eventName}</h3>
              <p style="margin: 5px 0;"><b>Date:</b> ${eventDate}</p>
              <p style="margin: 5px 0;"><b>Location:</b> ${eventAddress}</p>
              ${paymentDetailsHtml}
            </div>

            <p>Your booking is confirmed! We'll send you the event details shortly.</p>
            <p>Thank you for choosing Trip Pe Chalo!</p>

            <hr style="margin: 30px 0;">
            <p style="font-size: 12px; color: #666;">
              This is an automated email. Please do not reply to this message.
            </p>
          </div>
        `
      };
    } else {
      // For registration emails, use template API
      const ZEPTO_API_URL = 'https://api.zeptomail.in/v1.1/email/template';
      const TEMPLATE_ID = '2518b.623682b2828bdc79.k1.54307f80-9085-11f0-a4b7-d2cf08f4ca8c.19942703f78';

      emailPayload = {
        from: {
          address: "noreply@trippechalo.in",
          name: "TrippeChalo"
        },
        to: [{
          email_address: {
            address: customerEmail,
            name: customerName
          }
        }],
        template_key: TEMPLATE_ID,
        merge_info: {
          name: customerName,
          "event name": eventName,
          date: eventDate,
          address: eventAddress
        }
      };
    }

    // Choose the correct API URL based on email type
    const ZEPTO_API_URL = emailType === 'payment'
      ? 'https://api.zeptomail.in/v1.1/email'
      : 'https://api.zeptomail.in/v1.1/email/template';


    // Call ZeptoMail API
    const response = await fetch(ZEPTO_API_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': ZEPTO_API_KEY
      },
      body: JSON.stringify(emailPayload)
    });

    const result = await response.json();

    if (response.ok) {
      const messageId = result.data?.[0]?.additional_info?.[0]?.message_id;

      return res.json({
        success: true,
        messageId,
        data: result
      });
    } else {
      return res.status(400).json({
        success: false,
        error: result.message || result.error || 'Failed to send email'
      });
    }

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}