import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart, Share2 } from 'lucide-react';
import { Calendar, MapPin, Clock, Camera, User } from 'phosphor-react';
import { useWishlist } from '../contexts/WishlistContext';
import { useAuth } from '../contexts/AuthContext';
import { useCustomer } from '../contexts/CustomerContext';
import {
  NearbyApiService,
  DetailedEvent,
  DetailedExperience,
} from '../services/nearby-api';
import { BookingApiService } from '../services/booking-api';
import { ZeptoMailService } from '../services/zepto-mail';
import { supabase } from '../lib/supabase';
import LoginModal from '../components/LoginModal';
import { usePhonePeStatusPolling } from '../hooks/usePhonePeStatusPolling';

interface EventDetails {
  // Common fields
  id: string;
  event_name: string;
  description: string;
  primary_category: string;

  // Event-specific fields
  tagline?: string;
  short_description?: string;
  long_description?: string;
  date?: string;
  start_time?: string;
  duration?: number;
  address_city: string;
  address_venue: string;
  address_landmark?: string;
  address_full_address: string;
  address_google_map_link?: string;
  fixed_price?: number;
  pricing_type?: string;
  banner_image?: string;
  contact_name?: string;
  contact_number?: string;
  vendor_id?: string;

  // Experience-specific fields
  sub_category?: string;
  ticket_price?: number;
  time_slots?: Array<{ start: string; end: string }>;
  experience_photo_urls?: string[];
  emergency_contact_number?: string;

  // Registration flow fields
  is_screening_allowed?: boolean;
  custom_form?: Record<string, string>;

  // Content fields
  guidelines?: string;
  faqs?: Record<string, string>;

  // Formatted fields for display
  formattedPrice?: string;
  formattedDate?: string;
  formattedTime?: string;
  mainImage?: string;
  allImages?: string[];
}

const BookingPage: React.FC = () => {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const [eventDetails, setEventDetails] = useState<EventDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);
  const [guests, setGuests] = useState(1);
  const { addItemToWishlist, removeItemFromWishlist, isInWishlist } =
    useWishlist();
  const { user } = useAuth();
  const { customer } = useCustomer();

  // Registration flow states
  const [showRegistrationModal, setShowRegistrationModal] = useState(false);
  const [registrationLoading, setRegistrationLoading] = useState(false);
  const [customFormData, setCustomFormData] = useState<Record<string, string>>(
    {}
  );
  const [personalDetails, setPersonalDetails] = useState({
    name: '',
    email: '',
    phone: '',
  });

  // Booking status states
  const [bookingStatus, setBookingStatus] = useState<
    'register' | 'registered' | 'approved' | 'rejected'
  >('register');
  const [bookingStatusLoading, setBookingStatusLoading] = useState(false);

  // Payment status states
  const [paymentStatus, setPaymentStatus] = useState<
    'idle' | 'pending' | 'completed' | 'failed' | 'expired'
  >('idle');
  const [paymentStatusLoading, setPaymentStatusLoading] = useState(false);
  const [merchantOrderId, setMerchantOrderId] = useState<string>('');
  const [paymentPollingInterval, setPaymentPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [paymentExpireTime, setPaymentExpireTime] = useState<Date | null>(null);
  const [paymentTimeoutTimer, setPaymentTimeoutTimer] = useState<NodeJS.Timeout | null>(null);
  const [frontendTimeoutTime, setFrontendTimeoutTime] = useState<Date | null>(null);

  // PhonePe Status Polling Hook
  const { isPolling } = usePhonePeStatusPolling({
    merchantOrderId: merchantOrderId || null,
    enabled: paymentStatus === 'pending' && !!merchantOrderId,
    onStatusUpdate: (status, details) => {
      console.log(`🔄 [PhonePe Polling] Status update received: ${status}`, details);

      switch (status) {
        case 'COMPLETED':
          setPaymentStatus('completed');
          savePaymentState(merchantOrderId, 'completed', details);
          // Clear any existing polling timers
          if (paymentPollingInterval) {
            clearInterval(paymentPollingInterval);
            setPaymentPollingInterval(null);
          }
          break;
        case 'FAILED':
          setPaymentStatus('failed');
          savePaymentState(merchantOrderId, 'failed', details);
          break;
        case 'EXPIRED':
          setPaymentStatus('expired');
          savePaymentState(merchantOrderId, 'expired', details);
          break;
        case 'PENDING':
          // Update payment details if available
          if (details) {
            setPaymentDetails(details);
            savePaymentState(merchantOrderId, 'pending', details);
          }
          break;
      }
    },
    onError: (error) => {
      console.error('🚫 [PhonePe Polling] Error:', error);
      // Don't change status on polling errors - keep trying
    },
    expireAfter: 30 * 60 * 1000 // 30 minutes
  });

  // Enhanced payment data states
  const [paymentDetails, setPaymentDetails] = useState<{
    orderId?: string;
    amount?: number;
    transactionId?: string;
    utr?: string;
    paymentMode?: string;
    timestamp?: number;
    // Additional transaction details
    accountHolderName?: string;
    maskedAccountNumber?: string;
    vpa?: string;
    upiTransactionId?: string;
    refundStatus?: string;
    refundAmount?: number | null;
    guests?: number;
  } | null>(null);

  // Payment status checking state
  const [initialPaymentCheckDone, setInitialPaymentCheckDone] = useState(false);

  // Key for localStorage to persist payment state per event
  const getPaymentStorageKey = () => `payment_${type}_${id}_${user?.id || 'anonymous'}`;

  // Utility function to format amount (last 2 digits as decimal)
  const formatAmountFromAPI = (amountInSmallestUnit: number): number => {
    return amountInSmallestUnit / 100;
  };

  // Load payment state from localStorage
  const loadPaymentState = () => {
    if (!id || !user) return null;

    try {
      const storageKey = getPaymentStorageKey();
      const savedState = localStorage.getItem(storageKey);

      if (savedState) {
        const { merchantOrderId: savedOrderId, paymentStatus: savedStatus, timestamp, paymentDetails: savedDetails } = JSON.parse(savedState);

        // Only load if the saved state is recent (within 24 hours)
        const isRecent = Date.now() - timestamp < 24 * 60 * 60 * 1000;

        if (isRecent && savedOrderId) {
          console.log('🔄 Loading payment state from localStorage:', { savedOrderId, savedStatus });
          setMerchantOrderId(savedOrderId);

          if (savedDetails) {
            setPaymentDetails(savedDetails);
          }

          // Return the saved order ID for checking
          return savedOrderId;
        } else if (!isRecent) {
          // Clear old payment states
          localStorage.removeItem(storageKey);
        }
      }
    } catch (error) {
      console.error('Error loading payment state:', error);
    }

    return null;
  };

  // Save payment state to localStorage
  const savePaymentState = (orderId: string, status: string, details?: any) => {
    if (!id || !user) return;

    try {
      const storageKey = getPaymentStorageKey();
      const stateToSave = {
        merchantOrderId: orderId,
        paymentStatus: status,
        paymentDetails: details ? { ...details, guests: !eventDetails?.is_screening_allowed ? guests : undefined } : undefined,
        timestamp: Date.now()
      };

      localStorage.setItem(storageKey, JSON.stringify(stateToSave));
      console.log('💾 Saved payment state to localStorage:', stateToSave);

      // Clear completed payments after some time
      if (status === 'completed') {
        setTimeout(() => {
          localStorage.removeItem(storageKey);
          console.log('🧹 Cleared completed payment state from localStorage');
        }, 10000); // Clear after 10 seconds
      }
    } catch (error) {
      console.error('Error saving payment state:', error);
    }
  };

  // Login modal state
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Long description expansion state
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);

  // Payment request loading state
  const [paymentLoading, setPaymentLoading] = useState(false);

  // Email testing state
  //const [setEmailTestLoading] = useState(false);

  const isWishlisted =
    eventDetails && id && type
      ? isInWishlist(id, type as 'event' | 'experience')
      : false;

  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && showRegistrationModal) {
        setShowRegistrationModal(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showRegistrationModal]);

  const handleWishlistToggle = async () => {
    if (!eventDetails || !id || !type || !user) {
      // Show login modal
      setShowLoginModal(true);
      return;
    }

    try {
      if (isWishlisted) {
        await removeItemFromWishlist(id, type as 'event' | 'experience');
      } else {
        await addItemToWishlist({
          item_type: type as 'event' | 'experience',
          item_id: id,
          item_name: eventDetails.event_name,
          item_image_url: eventDetails.mainImage,
          item_location: eventDetails.address_city,
        });
      }
    } catch (error) {
      console.error('Wishlist error:', error);
      alert('Failed to update wishlist. Please try again.');
    }
  };

  const handleShare = async () => {
    const shareData = {
      title: eventDetails?.event_name || 'Check out this event',
      text:
        eventDetails?.description ||
        eventDetails?.short_description ||
        'Amazing event you should check out!',
      url: window.location.href,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(window.location.href);
        alert('Link copied to clipboard!');
      }
    } catch (error) {
      // If all else fails, try to copy to clipboard
      try {
        await navigator.clipboard.writeText(window.location.href);
        alert('Link copied to clipboard!');
      } catch (clipboardError) {
        // Final fallback
        alert(
          'Unable to share. Please copy the link manually from your browser address bar.'
        );
      }
    }
  };

  const handleRegistrationClick = () => {
    if (!user) {
      setShowLoginModal(true);
      return;
    }

    // Pre-fill personal details if available
    setPersonalDetails({
      name: user.user_metadata?.full_name || '',
      email: user.email || '',
      phone: user.user_metadata?.phone || '',
    });

    setShowRegistrationModal(true);
  };

  const handleCustomFormChange = (question: string, answer: string) => {
    setCustomFormData((prev) => ({
      ...prev,
      [question]: answer,
    }));
  };

  const handlePersonalDetailsChange = (field: string, value: string) => {
    setPersonalDetails((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const validateRegistrationForm = (): boolean => {
    // Check custom form fields
    if (eventDetails?.custom_form) {
      for (const question of Object.keys(eventDetails.custom_form)) {
        if (!customFormData[question]?.trim()) {
          alert(`Please answer: ${question}`);
          return false;
        }
      }
    }

    // Check personal details
    if (!personalDetails.name.trim()) {
      alert('Please enter your name');
      return false;
    }
    if (!personalDetails.email.trim()) {
      alert('Please enter your email');
      return false;
    }
    if (!personalDetails.phone.trim()) {
      alert('Please enter your phone number');
      return false;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(personalDetails.email)) {
      alert('Please enter a valid email address');
      return false;
    }

    return true;
  };

  // Stop payment polling and timeout
  const stopPaymentPolling = () => {
    if (paymentPollingInterval) {
      clearInterval(paymentPollingInterval);
      setPaymentPollingInterval(null);
      console.log('🛑 Payment polling stopped');
    }
    if (paymentTimeoutTimer) {
      clearTimeout(paymentTimeoutTimer);
      setPaymentTimeoutTimer(null);
      console.log('⏰ Payment timeout timer cleared');
    }
  };

  // Check payment status with polling mechanism
  const checkPaymentStatus = async (merchantOrderId: string, isPolling = false) => {
    if (!merchantOrderId || !user) {
      console.log('⏭️ Skipping payment status check - missing requirements');
      return;
    }

    // Only show loading on initial check, not during polling
    if (!isPolling) {
      setPaymentStatusLoading(true);
    }

    try {
      // Get auth token
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.error('No auth token found');
        if (!isPolling) setPaymentStatusLoading(false);
        return;
      }

      const baseUrl = import.meta.env.VITE_VASTUSETU_API_BASE_URL || 'https://www.vastusetu.com';
      const response = await fetch(`${baseUrl}/api/payment/getOrderStatus`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          merchantOrderId: merchantOrderId
        }),
      });

      if (!response.ok) {
        throw new Error(`Payment status check failed: ${response.status}`);
      }

      const result = await response.json();
      console.log(`💳 Payment status result${isPolling ? ' (polling)' : ''}:`, result);

      if (result.success && result.data) {
        const orderState = result.data.state;
        const expireAt = result.data.expireAt;
        const orderData = result.data;

        // Extract payment details from API response
        const extractedDetails = {
          orderId: orderData.orderId,
          amount: orderData.amount ? formatAmountFromAPI(orderData.amount) : undefined,
          transactionId: orderData.paymentDetails?.[0]?.transactionId,
          utr: orderData.paymentDetails?.[0]?.splitInstruments?.[0]?.rail?.utr,
          paymentMode: orderData.paymentDetails?.[0]?.paymentMode,
          timestamp: orderData.paymentDetails?.[0]?.timestamp
        };

        // Update payment details state
        setPaymentDetails(extractedDetails);
        console.log('💳 Payment details extracted:', extractedDetails);

        // Store expireAt for timeout handling - update it each time we get a new value
        if (expireAt) {
          const expireDate = new Date(expireAt);
          const currentTime = new Date();

          // Always update the expiry time
          setPaymentExpireTime(expireDate);
          console.log('⏰ Payment expiry time updated:', {
            expireAt: expireDate.toISOString(),
            currentTime: currentTime.toISOString(),
            timeToExpiry: Math.round((expireDate.getTime() - currentTime.getTime()) / 1000) + ' seconds',
            isExpired: currentTime > expireDate
          });

          // Check if already expired
          if (currentTime > expireDate) {
            console.log('⏰ Payment already expired based on API response!');
            stopPaymentPolling();
            setPaymentStatus('expired');
            savePaymentState(merchantOrderId, 'expired', extractedDetails);
            return;
          }
        }

        if (orderState === 'COMPLETED') {
          console.log('✅ Payment COMPLETED - stopping polling');
          stopPaymentPolling();
          setPaymentStatus('completed');
          savePaymentState(merchantOrderId, 'completed', extractedDetails);

          // Send payment confirmation email via ZeptoMail
          try {
            console.log('📧 Sending payment confirmation email...');

            const customerName = personalDetails.name || customer?.first_name || user.user_metadata?.full_name || 'Customer';
            const customerEmail = personalDetails.email || customer?.email || user.email || '';


            // Use our Vercel function instead of direct ZeptoMail call to avoid CORS
            const paymentEmailPayload = {
              eventName: eventDetails?.event_name || 'Event Booking',
              customerName: customerName,
              customerEmail: customerEmail,
              eventDate: eventDetails?.formattedDate || 'Date to be announced',
              eventAddress: eventDetails?.address_full_address || 'Address to be announced',
              emailType: 'payment',
              paymentDetails: {
                orderId: extractedDetails.orderId || merchantOrderId,
                amount: extractedDetails.amount,
                transactionId: extractedDetails.transactionId,
                utr: extractedDetails.utr,
                paymentMode: extractedDetails.paymentMode
              }
            };

            const emailResponse = await fetch('/api/send-registration-email', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(paymentEmailPayload)
            });

            if (emailResponse.ok) {
              console.log('✅ Payment confirmation email sent successfully');
            } else {
              const emailError = await emailResponse.json();
              console.warn('⚠️ Payment confirmation email failed:', emailError);
            }
          } catch (emailError) {
            console.error('❌ Error sending payment confirmation email:', emailError);
          }

        } else if (orderState === 'FAILED') {
          console.log('❌ Payment FAILED - stopping polling');
          stopPaymentPolling();
          setPaymentStatus('failed');
          savePaymentState(merchantOrderId, 'failed', extractedDetails);

        } else if (orderState === 'PENDING') {
          console.log('⏳ Payment still PENDING');
          setPaymentStatus('pending');
          savePaymentState(merchantOrderId, 'pending', extractedDetails);

          // Check if payment has expired based on our 3-minute frontend timeout
          const currentTime = new Date();
          if (frontendTimeoutTime && currentTime > frontendTimeoutTime) {
            console.log('⏰ Frontend timeout expired during PENDING check:', {
              currentTime: currentTime.toISOString(),
              frontendTimeout: frontendTimeoutTime.toISOString(),
              expiredBy: Math.round((currentTime.getTime() - frontendTimeoutTime.getTime()) / 1000) + ' seconds'
            });
            stopPaymentPolling();
            setPaymentStatus('failed');
            return;
          }

          // Start polling if not already started and not expired
          if (!paymentPollingInterval && !isPolling) {
            console.log('🔄 Starting payment status polling (every 10 seconds)');

            const intervalId = setInterval(() => {
              // Check frontend timeout before each poll
              const currentTime = new Date();
              if (frontendTimeoutTime && currentTime > frontendTimeoutTime) {
                console.log('⏰ Frontend timeout expired during polling interval:', {
                  currentTime: currentTime.toISOString(),
                  frontendTimeout: frontendTimeoutTime.toISOString(),
                  expiredBy: Math.round((currentTime.getTime() - frontendTimeoutTime.getTime()) / 1000) + ' seconds'
                });
                clearInterval(intervalId);
                setPaymentPollingInterval(null);
                setPaymentStatus('failed');
                return;
              }

              console.log('🔄 Polling payment status... Frontend time remaining:',
                frontendTimeoutTime ? Math.round((frontendTimeoutTime.getTime() - currentTime.getTime()) / 1000) + ' seconds' : 'unknown'
              );
              checkPaymentStatus(merchantOrderId, true);
            }, 10000); // Poll every 10 seconds

            setPaymentPollingInterval(intervalId);
          }
        }
      }

    } catch (error) {
      console.error('Error checking payment status:', error);
      if (!isPolling) {
        setPaymentStatus('failed');
      }
    } finally {
      if (!isPolling) {
        setPaymentStatusLoading(false);
      }
    }
  };

  // Check if user has existing booking and get merchantOrderId
  const checkExistingBookingAndPayment = async () => {
    if (!user || !id) {
      console.log('⏭️ Skipping booking/payment check - no user or event ID');
      return;
    }

    console.log('🔍 Checking existing booking and payment status for event:', id);
    setBookingStatusLoading(true);

    try {
      // First, check if there's an existing booking
      const bookingResponse = await BookingApiService.checkBookingStatus(id);
      console.log('📋 Booking API response:', bookingResponse);

      // Handle booking status for screening events
      if (eventDetails?.is_screening_allowed) {
        const status = BookingApiService.getBookingState(bookingResponse);
        console.log('📝 Setting booking status:', status);
        setBookingStatus(status);
      }

      // Check if booking has payment transactions
      if (bookingResponse.success && bookingResponse.data) {
        const bookingData = bookingResponse.data as any;
        const existingMerchantOrderId = bookingData.merchantOrderId || bookingData.merchant_order_id;
        const transactions = bookingData.transactions || [];

        console.log('💳 [PAYMENT] Booking data found:', {
          merchantOrderId: existingMerchantOrderId,
          transactionsCount: transactions.length,
          bookingApproved: bookingData.is_approved
        });

        if (existingMerchantOrderId) {
          setMerchantOrderId(existingMerchantOrderId);

          // Process transactions to get payment status
          if (transactions.length > 0) {
            // Get the latest transaction (last in array)
            const latestTransaction = transactions[transactions.length - 1];
            const transactionStatus = latestTransaction.transaction_status;

            console.log('📊 [PAYMENT] Latest transaction status:', transactionStatus);

            // Parse transaction_message for detailed payment info
            let transactionDetails = null;
            try {
              if (latestTransaction.transaction_message) {
                transactionDetails = JSON.parse(latestTransaction.transaction_message);
              }
            } catch (error) {
              console.warn('[PAYMENT] Failed to parse transaction_message:', error);
            }

            // Extract comprehensive payment details
            const extractedDetails = {
              orderId: latestTransaction.order_id,
              amount: transactionDetails?.amount ? formatAmountFromAPI(transactionDetails.amount) : parseFloat(latestTransaction.amount),
              transactionId: latestTransaction.transaction_id,
              utr: latestTransaction.transaction_utr,
              paymentMode: latestTransaction.paymentMode,
              timestamp: transactionDetails?.paymentDetails?.[0]?.timestamp,
              accountHolderName: transactionDetails?.paymentDetails?.[0]?.splitInstruments?.[0]?.instrument?.accountHolderName,
              maskedAccountNumber: latestTransaction.transaction_maskedAccountNumber,
              vpa: latestTransaction.transaction_vpa,
              upiTransactionId: latestTransaction.transaction_upiTransactionId,
              refundStatus: latestTransaction.refund_status,
              refundAmount: latestTransaction.refund_amount ? parseFloat(latestTransaction.refund_amount) : null
            };

            setPaymentDetails(extractedDetails);

            // Set payment status based on transaction status
            let paymentState: 'idle' | 'pending' | 'completed' | 'failed' | 'expired' = 'idle';

            switch (transactionStatus) {
              case 'COMPLETED':
                paymentState = 'completed';
                break;
              case 'PENDING':
                paymentState = 'pending';
                break;
              case 'FAILED':
                paymentState = 'failed';
                break;
              case 'EXPIRED':
                paymentState = 'expired';
                break;
              default:
                paymentState = 'pending';
            }

            console.log('🎯 Setting payment status from transaction:', paymentState);
            setPaymentStatus(paymentState);
            savePaymentState(existingMerchantOrderId, paymentState, extractedDetails);

            // If payment is pending, start polling for updates
            if (paymentState === 'pending') {
              await checkPaymentStatus(existingMerchantOrderId, false);
            }
          } else {
            console.log('💭 MerchantOrderId exists but no transactions - payment initiated but not processed');
            setPaymentStatus('pending');
            savePaymentState(existingMerchantOrderId, 'pending');
            // Check current status via payment API
            await checkPaymentStatus(existingMerchantOrderId, false);
          }
        } else {
          console.log('💭 [PAYMENT] No merchantOrderId found in booking - no payment attempted yet');
          // Clear any old payment state
          const storageKey = getPaymentStorageKey();
          localStorage.removeItem(storageKey);
        }
      } else {
        console.log('📭 No existing booking found');
        // Try to load from localStorage as fallback
        const savedOrderId = loadPaymentState();
        if (savedOrderId) {
          await checkPaymentStatus(savedOrderId, false);
        }
      }

    } catch (error) {
      console.error('Error checking existing booking/payment:', error);

      // Fallback: try to load from localStorage
      const savedOrderId = loadPaymentState();
      if (savedOrderId) {
        await checkPaymentStatus(savedOrderId, false);
      }
    } finally {
      setBookingStatusLoading(false);
      setInitialPaymentCheckDone(true);
    }
  };


  const handleRegistrationSubmit = async () => {
    if (!validateRegistrationForm()) return;

    setRegistrationLoading(true);
    try {
      // Get the auth token from Supabase
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('No auth token found. Please login again.');
      }

      // Convert custom form questions to snake_case for API
      const customFormDataSnakeCase: Record<string, string> = {};
      Object.entries(customFormData).forEach(([question, answer]) => {
        const snakeCaseKey = question
          .toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^\w]/g, '');
        customFormDataSnakeCase[snakeCaseKey] = answer;
      });

      // Prepare API payload
      const payload = {
        event_id: id,
        name: personalDetails.name,
        phone_number: personalDetails.phone,
        email: personalDetails.email,
        custom_form_data: customFormDataSnakeCase,
      };

      // Get base URL from environment
      const baseUrl =
        import.meta.env.VITE_VASTUSETU_API_BASE_URL ||
        'https://www.vastusetu.com';

      // Make API call
      const response = await fetch(`${baseUrl}/api/bookings/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            errorData.error ||
            'Failed to submit registration'
        );
      }

      const result = await response.json();
      console.log('Registration successful:', result);

      // Send confirmation email via ZeptoMail
      try {
        console.log(
          '📧 Sending registration confirmation email with all fields...'
        );
        // Format date for email
        const eventDate = eventDetails?.date
          ? new Date(eventDetails.date).toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : 'Date to be announced';

        // Format full address for email
        const eventAddress =
          [
            eventDetails?.address_venue,
            eventDetails?.address_city,
            eventDetails?.address_landmark,
            eventDetails?.address_full_address,
          ]
            .filter(Boolean)
            .join(', ') || 'Address to be announced';

        const emailResult = await ZeptoMailService.sendRegistrationEmail({
          eventName: eventDetails?.event_name || 'Event Registration',
          customerName: personalDetails.name,
          customerEmail: personalDetails.email,
          eventDate,
          eventAddress,
        });

        if (emailResult.success) {
          console.log('✅ Registration confirmation email sent successfully');
        } else {
          console.warn(
            '⚠️ Email sending failed, but registration was successful:',
            emailResult.error
          );
        }
      } catch (emailError) {
        console.error(
          '❌ Error sending confirmation email (registration still successful):',
          emailError
        );
      }

      setBookingStatus('registered');
      setShowRegistrationModal(false);

      // Reset form data
      setCustomFormData({});
      setPersonalDetails({ name: '', email: '', phone: '' });
    } catch (error) {
      console.error('Registration error:', error);
      alert(
        `Registration failed: ${error instanceof Error ? error.message : 'Please try again.'}`
      );
    } finally {
      setRegistrationLoading(false);
    }
  };

  // Test email function (for development/testing)
  // const handleTestEmail = async () => {
  //   setEmailTestLoading(true);
  //   try {
  //     const result = await ZeptoMailService.sendTestEmail();
  //     if (result.success) {
  //       alert('✅ Test email sent successfully! Check rajvaidhyag@gmail.com');
  //     } else {
  //       alert(`❌ Test email failed: ${result.error}`);
  //     }
  //   } catch (error) {
  //     alert(`❌ Test email error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   } finally {
  //     setEmailTestLoading(false);
  //   }
  // };

  // PhonePe iframe state
  const [showPhonePeIframe, setShowPhonePeIframe] = useState(false);
  const [phonePeIframeData, setPhonePeIframeData] = useState<{tokenUrl: string, merchantOrderId: string} | null>(null);

  // Handle messages from PhonePe iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      console.log('📬 Message from PhonePe iframe:', event.data);

      if (event.data.type === 'PHONEPE_IFRAME_READY') {
        console.log('✅ PhonePe iframe is ready');
      } else if (event.data.type === 'PHONEPE_CALLBACK') {
        const { response, merchantOrderId } = event.data;
        console.log('🚨 ===== PHONEPE CALLBACK RECEIVED ===== 🚨');
        console.log('📞 Callback Response:', response);
        console.log('📞 Merchant Order ID:', merchantOrderId);

        if (response === 'USER_CANCEL') {
          console.log('❌ USER_CANCEL: Payment cancelled by user');
          setPaymentStatus('failed');
          setShowPhonePeIframe(false);
          alert('Payment was cancelled. You can try again if needed.');
        } else if (response === 'CONCLUDED') {
          console.log('✅ CONCLUDED: Payment process finished, starting status polling...');
          setPaymentStatus('pending');
          setShowPhonePeIframe(false);

          // Set frontend timeout to 4 minutes from now (ignore API's long expiry)
          const frontendExpiry = new Date(Date.now() + 4 * 60 * 1000); // 4 minutes
          setFrontendTimeoutTime(frontendExpiry);
          console.log('⏰ Frontend timeout set to:', frontendExpiry.toLocaleString());

          // Start 4-minute timeout timer
          const timeoutId = setTimeout(() => {
            console.log('⏰ 4-minute frontend timeout reached - stopping polling');
            stopPaymentPolling();
            setPaymentStatus('failed');
          }, 4 * 60 * 1000); // 4 minutes

          setPaymentTimeoutTimer(timeoutId);

          // Start checking payment status after callback (wait 2 seconds then start polling)
          setTimeout(() => {
            checkPaymentStatus(merchantOrderId);
          }, 2000);
        } else {
          console.log('⚠️ UNKNOWN RESPONSE:', response);
          alert(`Unknown callback received: ${response}`);
        }

        console.log('🚨 ===== END PHONEPE CALLBACK ===== 🚨');
      } else if (event.data.type === 'PHONEPE_ERROR') {
        console.error('❌ PhonePe iframe error:', event.data.error);
        setPaymentStatus('failed');
        setShowPhonePeIframe(false);
        alert('Payment gateway error. Please try again.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // PhonePe checkout function using separate iframe
  const openPhonePeCheckout = (tokenUrl: string, merchantOrderId: string) => {
    console.log('📱 Opening PhonePe iframe checkout:', tokenUrl);

    setPhonePeIframeData({ tokenUrl, merchantOrderId });
    setShowPhonePeIframe(true);
  };

  // Create payment request
  const handlePaymentRequest = async () => {
    console.log('💳 Payment request initiated:', {
      hasUser: !!user,
      hasCustomer: !!customer,
      hasEventDetails: !!eventDetails,
      hasId: !!id,
      eventType: type,
      isScreeningAllowed: eventDetails?.is_screening_allowed,
      bookingStatus
    });

    if (!user || !customer || !eventDetails || !id) {
      console.error('❌ Missing required data for payment:', {
        user: !!user,
        customer: !!customer,
        eventDetails: !!eventDetails,
        id: !!id
      });

      if (!user) {
        console.log('🔐 User not logged in, showing login modal');
        setShowLoginModal(true);
        return;
      }

      alert('Missing required information for payment. Please try again.');
      return;
    }

    // Validate required fields
    if (!eventDetails.vendor_id) {
      alert('Event vendor information not available. Please contact support.');
      return;
    }

    // Calculate total amount - different logic for screening vs non-screening events
    const basePrice = type === 'event'
      ? (eventDetails.fixed_price || 0)
      : (eventDetails.ticket_price || 0);

    if (!basePrice || basePrice <= 0) {
      alert('Event pricing information not available. Please contact support.');
      return;
    }

    // For screening events, always use single person price (no guest multiplication)
    // For non-screening events, multiply by guests
    const totalAmount = eventDetails.is_screening_allowed
      ? basePrice
      : basePrice * guests;

    setPaymentLoading(true);

    try {
      // Get auth token
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        alert('Authentication required. Please log in again.');
        return;
      }

      // Get booking ID if it exists (for screening events)
      let bookingId = null;
      if (eventDetails.is_screening_allowed && bookingStatus === 'approved') {
        try {
          const bookingResponse = await BookingApiService.checkBookingStatus(id);
          if (bookingResponse.success && bookingResponse.data) {
            bookingId = bookingResponse.data.id;
          }
        } catch (error) {
          console.warn('Could not fetch booking ID:', error);
        }
      }

      // Prepare API payload with new structure
      const paymentPayload = {
        amount: totalAmount,
        paymentMessage: "Payment Request for Event",
        paymentType: "PG_CHECKOUT",
        paymentRedirectUrl: `${window.location.origin}/booking/event/${id}`,
        metaInfo: {
          udf1: id, // event id
          udf2: eventDetails.vendor_id, // vendor id
          udf3: bookingId || "", // booking id (screening events only, empty for direct)
          udf4: "",
          udf5: ""
        }
      };

      // API Base URL
      const baseUrl = import.meta.env.VITE_VASTUSETU_API_BASE_URL || 'https://www.vastusetu.com';
      const apiUrl = `${baseUrl}/api/payment/createPaymentRequest`;

      // Log the request details
      console.log('🔄 [PAYMENT] Creating payment request:', {
        apiUrl,
        payload: paymentPayload,
        totalAmount,
        guests: eventDetails.is_screening_allowed ? 1 : guests, // Always 1 for screening events
        basePrice,
        eventId: id,
        customerId: customer.id,
        vendorId: eventDetails.vendor_id,
        bookingId,
        paymentMessage: "Payment Request for Event",
        paymentType: "PG_CHECKOUT",
        paymentRedirectUrl: `${window.location.origin}/booking/event/${id}`,
        hasToken: !!session.access_token,
        isScreeningEvent: eventDetails.is_screening_allowed
      });

      console.log('📤 Payment request cURL equivalent:', `
curl --location '${apiUrl}' \\
--header 'Content-Type: application/json' \\
--header 'Authorization: Bearer ${session.access_token.substring(0, 20)}...' \\
--data '${JSON.stringify(paymentPayload, null, 2)}'
      `);

      // Make API call
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(paymentPayload),
      });

      const responseData = await response.json();

      console.log('📊 Payment request API response:', {
        status: response.status,
        ok: response.ok,
        data: responseData
      });

      console.log('🔍 RAW API Response Data:', JSON.stringify(responseData, null, 2));

      if (!response.ok) {
        console.error('❌ Payment request failed:', responseData);
        alert(`Payment request failed: ${responseData.message || responseData.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Payment request successful!', responseData);

      // Check for redirectUrl in the new response structure
      if (responseData.success && responseData.data?.redirectUrl) {
        const tokenUrl = responseData.data.redirectUrl;
        const merchantOrderId = responseData.data?.merchantOrderId || '';

        console.log('🔗 Opening PhonePe iFrame with tokenUrl:', tokenUrl);
        console.log('🏪 Merchant Order ID from API response:', merchantOrderId);

        if (!merchantOrderId) {
          console.error('❌ No merchantOrderId in response:', responseData);
          alert('Payment setup failed. No merchant order ID received.');
          return;
        }

        // Store ONLY merchant order ID for status checking
        setMerchantOrderId(merchantOrderId);
        console.log('💾 Stored Merchant Order ID for tracking:', merchantOrderId);

        // Open PhonePe checkout in iFrame mode
        openPhonePeCheckout(tokenUrl, merchantOrderId);
      } else {
        console.error('❌ No redirect URL in response:', responseData);
        alert('Payment setup failed. No redirect URL received.');
      }

    } catch (error) {
      console.error('💥 Payment request error:', error);
      alert(`Payment request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setPaymentLoading(false);
    }
  };

  // Format date to human readable format
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      // Check if date is valid
      if (isNaN(date.getTime())) {
        return dateString;
      }
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kolkata',
      });
    } catch {
      return dateString;
    }
  };

  // Format time to 12-hour format - no timezone conversion
  const formatTime = (timeString: string) => {
    try {
      // Check if it's a timestamp or time string
      if (timeString.includes('T') || timeString.includes('-')) {
        // It's a timestamp like "2025-09-25T16:00:00Z", extract time part only
        const date = new Date(timeString);
        // Get UTC time components without timezone conversion
        const hours = date.getUTCHours();
        const minutes = date.getUTCMinutes();

        // Create a new date with just the time components
        const timeOnlyDate = new Date();
        timeOnlyDate.setHours(hours, minutes, 0, 0);

        return timeOnlyDate.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
      } else {
        // It's a time string like "14:30"
        const [hours, minutes] = timeString.split(':').map(Number);
        const date = new Date();
        date.setHours(hours, minutes);
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
      }
    } catch {
      return timeString;
    }
  };

  // Fetch real event data from API
  useEffect(() => {
    const fetchEventDetails = async () => {
      if (!type || !id) {
        setError('Missing event type or ID');
        setLoading(false);
        return;
      }

      // AGGRESSIVE DEBUGGING FOR VERCEL - removed unused debugData

      // Removed aggressive alert debugging

      try {
        setLoading(true);
        setError(null);

        // Debug info removed

        let apiData;
        if (type === 'event') {
          apiData = (await NearbyApiService.getEventDetails(
            id
          )) as DetailedEvent;
        } else if (type === 'experience') {
          apiData = (await NearbyApiService.getExperienceDetails(
            id
          )) as DetailedExperience;
        } else {
          throw new Error('Invalid event type');
        }

        // Debug info removed

        // Transform API data to EventDetails format
        const transformedData: EventDetails = {
          id: apiData.id,
          event_name: apiData.event_name,
          description:
            'description' in apiData
              ? apiData.description
              : apiData.short_description || '',
          primary_category: apiData.primary_category,

          // Event-specific fields
          tagline: 'tagline' in apiData ? apiData.tagline : undefined,
          short_description:
            'short_description' in apiData
              ? apiData.short_description
              : undefined,
          long_description:
            'long_description' in apiData
              ? apiData.long_description
              : undefined,
          date: 'date' in apiData ? apiData.date : undefined,
          start_time: 'start_time' in apiData ? apiData.start_time : undefined,
          duration: 'duration' in apiData ? apiData.duration : undefined,
          address_city: apiData.address_city,
          address_venue: apiData.address_venue,
          address_landmark:
            'address_landmark' in apiData
              ? apiData.address_landmark
              : undefined,
          address_full_address: apiData.address_full_address,
          address_google_map_link: (apiData as any).address_google_map_link,
          fixed_price:
            'fixed_price' in apiData ? apiData.fixed_price : undefined,
          pricing_type:
            'pricing_type' in apiData ? apiData.pricing_type : undefined,
          banner_image:
            'banner_image' in apiData ? apiData.banner_image : undefined,
          contact_name:
            'contact_name' in apiData ? apiData.contact_name : undefined,
          contact_number:
            'contact_number' in apiData ? apiData.contact_number : undefined,
          vendor_id: (apiData as any).vendor_id,

          // Experience-specific fields
          sub_category:
            'sub_category' in apiData ? apiData.sub_category : undefined,
          ticket_price:
            'ticket_price' in apiData ? apiData.ticket_price : undefined,
          time_slots: 'time_slots' in apiData ? apiData.time_slots : undefined,
          experience_photo_urls:
            'experience_photo_urls' in apiData
              ? apiData.experience_photo_urls
              : undefined,
          emergency_contact_number:
            'emergency_contact_number' in apiData
              ? apiData.emergency_contact_number
              : undefined,

          // Registration flow fields
          is_screening_allowed: (apiData as any).is_screening_allowed,
          custom_form: (apiData as any).custom_form,

          // Content fields
          guidelines: (apiData as any).guidelines,
          faqs: (apiData as any).faqs,

          // Formatted fields for display
          formattedPrice:
            type === 'event' && 'fixed_price' in apiData
              ? `₹${apiData.fixed_price.toLocaleString()}`
              : type === 'experience' && 'ticket_price' in apiData
                ? `₹${apiData.ticket_price.toLocaleString()}`
                : 'Price not available',
          formattedDate:
            'date' in apiData ? formatDate(apiData.date) : undefined,
          formattedTime:
            'start_time' in apiData
              ? formatTime(apiData.start_time)
              : undefined,
          mainImage:
            'banner_image' in apiData
              ? apiData.banner_image
              : 'experience_photo_urls' in apiData &&
                  apiData.experience_photo_urls.length > 0
                ? apiData.experience_photo_urls[0]
                : '/api/placeholder/800/600',
          allImages:
            'experience_photo_urls' in apiData &&
            apiData.experience_photo_urls.length > 0
              ? apiData.experience_photo_urls
              : 'banner_image' in apiData && apiData.banner_image
                ? [apiData.banner_image]
                : ['/api/placeholder/800/600'],
        };

        setEventDetails(transformedData);
      } catch (err) {
        console.error('Error fetching event details:', err);

        // Debug info removed

        setError(
          err instanceof Error ? err.message : 'Failed to load event details'
        );
      } finally {
        setLoading(false);
      }
    };

    fetchEventDetails();
  }, [type, id]);

  // Check booking and payment status when user logs in or event details are loaded
  useEffect(() => {
    console.log('🎣 useEffect triggered for booking/payment status check:', {
      hasEventDetails: !!eventDetails,
      hasUser: !!user,
      eventName: eventDetails?.event_name,
      initialCheckDone: initialPaymentCheckDone,
    });

    if (eventDetails && user && !initialPaymentCheckDone) {
      // Check both booking status and payment status
      checkExistingBookingAndPayment();
    }

    // Reset states when user logs out
    if (!user) {
      setBookingStatus('register');
      setPaymentStatus('idle');
      setMerchantOrderId('');
      setPaymentDetails(null);
      setInitialPaymentCheckDone(false);

      // Clear localStorage on logout
      try {
        const storageKey = getPaymentStorageKey();
        localStorage.removeItem(storageKey);
      } catch (error) {
        console.error('Error clearing localStorage on logout:', error);
      }
    }
  }, [eventDetails, user, initialPaymentCheckDone]);

  // Handle auth state changes (login/signup success)
  useEffect(() => {
    console.log('🔐 Auth state changed:', {
      hasUser: !!user,
      userEmail: user?.email,
    });

    // When user successfully logs in/signs up, close login modal
    if (user && showLoginModal) {
      console.log('✅ User logged in, closing login modal');
      setShowLoginModal(false);
    }
  }, [user, showLoginModal]);

  // Enhanced page load payment check - now handled by checkExistingBookingAndPayment
  useEffect(() => {
    // This is now redundant as checkExistingBookingAndPayment handles both booking and payment status
    // Keeping for backward compatibility but this should not trigger if initialPaymentCheckDone is true
    if (merchantOrderId && user && initialPaymentCheckDone) {
      console.log('🔄 Additional payment status check (should be rare):', merchantOrderId);
      checkPaymentStatus(merchantOrderId);
    }
  }, [merchantOrderId, user, initialPaymentCheckDone]);

  // Cleanup polling interval and timeout on component unmount
  useEffect(() => {
    return () => {
      if (paymentPollingInterval) {
        console.log('🧹 Cleaning up payment polling interval on component unmount');
        clearInterval(paymentPollingInterval);
      }
      if (paymentTimeoutTimer) {
        console.log('🧹 Cleaning up payment timeout timer on component unmount');
        clearTimeout(paymentTimeoutTimer);
      }
    };
  }, [paymentPollingInterval, paymentTimeoutTimer]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="animate-pulse text-xl font-medium text-gray-600">
          Loading...
        </div>
      </div>
    );
  }

  if (error || !eventDetails) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <h2 className="mb-4 text-2xl font-bold text-gray-800">
            Oops! Something went wrong
          </h2>
          <p className="mb-6 text-gray-600">{error || 'Event not found'}</p>
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 rounded-lg bg-black px-6 py-3 text-white transition-colors hover:bg-gray-800"
          >
            <ArrowLeft size={20} />
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero Section */}
      <section className="relative pt-16 md:pt-0">
        <div className="relative aspect-[4/3] overflow-hidden md:aspect-[16/9] lg:aspect-[21/9]">
          <img
            src={
              eventDetails.allImages?.[selectedImage] || eventDetails.mainImage
            }
            alt={eventDetails.event_name}
            className="h-full w-full object-cover"
          />

          {/* Black overlay with content */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 pb-4 md:items-end md:pb-8 lg:pb-12">
            <div className="mx-auto max-w-4xl px-4 text-center text-white md:px-6">
              <h1 className="mb-4 text-2xl font-bold drop-shadow-lg md:text-4xl lg:text-6xl">
                {eventDetails.event_name}
              </h1>
              {eventDetails.tagline && (
                <p className="mb-4 text-base font-light opacity-90 drop-shadow-md md:mb-6 md:text-xl lg:text-xl">
                  {eventDetails.tagline}
                </p>
              )}
              <div className="hidden flex-col items-center justify-center gap-2 text-sm sm:flex-row sm:gap-4 md:flex md:text-lg">
                <div className="flex items-center gap-2">
                  <MapPin size={20} weight="duotone" />
                  <span>{eventDetails.address_city}</span>
                </div>
                {eventDetails.formattedDate && (
                  <div className="flex items-center gap-2">
                    <Calendar size={20} weight="duotone" />
                    <span>{eventDetails.formattedDate}</span>
                  </div>
                )}
                {eventDetails.formattedTime && (
                  <div className="flex items-center gap-2">
                    <Clock size={20} weight="duotone" />
                    <span>{eventDetails.formattedTime}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Image selection buttons */}
        {eventDetails.allImages && eventDetails.allImages.length > 1 && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 transform gap-2">
            {eventDetails.allImages.map((_, index) => (
              <button
                key={index}
                onClick={() => setSelectedImage(index)}
                className={`h-3 w-3 rounded-full transition-all ${
                  selectedImage === index ? 'bg-white' : 'bg-white/50'
                }`}
              />
            ))}
          </div>
        )}
      </section>

      {/* Main Content */}
      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-12">
          {/* Left Content */}
          <div className="min-w-0 space-y-12 lg:col-span-2">
            {/* Image Gallery */}
            {eventDetails.allImages && eventDetails.allImages.length > 1 && (
              <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
                <div className="mb-8 flex items-center gap-3 border-b border-gray-100 pb-4">
                  <Camera
                    size={32}
                    weight="duotone"
                    className="text-gray-600"
                  />
                  <h2 className="text-3xl font-bold text-black">Gallery</h2>
                </div>
                <div className="grid grid-cols-2 gap-6 md:grid-cols-3">
                  {eventDetails.allImages.slice(1, 7).map((img, index) => (
                    <button
                      key={index + 1}
                      onClick={() => setSelectedImage(index + 1)}
                      className="aspect-video overflow-hidden rounded-xl shadow-md transition-all duration-300 hover:scale-105 hover:shadow-lg"
                    >
                      <img
                        src={img}
                        alt={`View ${index + 2}`}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* About Section */}
            <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
              <div className="mb-8 flex items-center gap-3 border-b border-gray-100 pb-4">
                <h2 className="text-3xl font-bold text-black">About</h2>
              </div>
              <div className="max-w-none">
                {eventDetails.short_description && (
                  <p className="mb-6 text-base leading-relaxed break-words text-gray-700">
                    {eventDetails.short_description}
                  </p>
                )}
                {eventDetails.long_description && (
                  <div className="space-y-4 text-base leading-relaxed text-gray-700">
                    {isDescriptionExpanded ? (
                      <>
                        {eventDetails.long_description
                          .split('\n')
                          .map((paragraph, index) => (
                            <p key={index} className="break-words">
                              {paragraph}
                            </p>
                          ))}
                        <button
                          onClick={() => setIsDescriptionExpanded(false)}
                          className="mt-4 inline-flex items-center rounded-lg border border-blue-200 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:border-blue-300 hover:text-blue-800"
                        >
                          Show Less
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="break-words">
                          {eventDetails.long_description.length > 200
                            ? `${eventDetails.long_description.substring(0, 200)}...`
                            : eventDetails.long_description}
                        </p>
                        {eventDetails.long_description.length > 200 && (
                          <button
                            onClick={() => setIsDescriptionExpanded(true)}
                            className="mt-4 inline-flex items-center rounded-lg border border-blue-200 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:border-blue-300 hover:text-blue-800"
                          >
                            Show More
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Event Details */}
            <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
              <h2 className="mb-8 border-b border-gray-100 pb-4 text-3xl font-bold text-black">
                Event Details
              </h2>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {eventDetails.formattedDate && (
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                    <h3 className="mb-2 text-sm font-semibold tracking-wide text-black text-gray-500 uppercase">
                      Date
                    </h3>
                    <p className="font-medium break-words text-gray-900">
                      {eventDetails.formattedDate}
                    </p>
                  </div>
                )}
                {eventDetails.formattedTime && (
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                    <h3 className="mb-2 text-sm font-semibold tracking-wide text-black text-gray-500 uppercase">
                      Time
                    </h3>
                    <p className="font-medium text-gray-900">
                      {eventDetails.formattedTime}
                    </p>
                  </div>
                )}
                {eventDetails.duration && (
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                    <h3 className="mb-2 text-sm font-semibold tracking-wide text-black text-gray-500 uppercase">
                      Duration
                    </h3>
                    <p className="font-medium text-gray-900">
                      {eventDetails.duration} hours
                    </p>
                  </div>
                )}
                {((type === 'event' && eventDetails.contact_number) ||
                  (type === 'experience' &&
                    eventDetails.emergency_contact_number)) && (
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                    <h3 className="mb-2 text-sm font-semibold tracking-wide text-black text-gray-500 uppercase">
                      {type === 'event'
                        ? 'Contact Number'
                        : 'Emergency Contact'}
                    </h3>
                    <p className="font-medium break-words text-gray-900">
                      {type === 'event'
                        ? eventDetails.contact_number
                        : eventDetails.emergency_contact_number}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Location */}
            <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
              <h2 className="mb-8 border-b border-gray-100 pb-4 text-3xl font-bold text-black">
                Location
              </h2>
              <div className="space-y-8">
                <div>
                  <h3 className="mb-6 text-xl font-semibold text-black">
                    Venue Details
                  </h3>
                  <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                      <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                        Venue
                      </span>
                      <p className="mt-2 font-medium break-words text-gray-900">
                        {eventDetails.address_venue}
                      </p>
                    </div>
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                      <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                        City
                      </span>
                      <p className="mt-2 font-medium break-words text-gray-900">
                        {eventDetails.address_city}
                      </p>
                    </div>
                    {eventDetails.address_landmark && (
                      <div className="rounded-xl border border-gray-100 bg-gray-50 p-6 md:col-span-2">
                        <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                          Landmark
                        </span>
                        <p className="mt-2 font-medium break-words text-gray-900">
                          {eventDetails.address_landmark}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <h3 className="mb-6 text-xl font-semibold text-black">
                    Full Address
                  </h3>
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                    <p className="leading-relaxed break-words text-gray-700">
                      {eventDetails.address_full_address}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Time Slots for Experiences */}
            {type === 'experience' &&
              eventDetails.time_slots &&
              eventDetails.time_slots.length > 0 && (
                <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
                  <h2 className="mb-8 border-b border-gray-100 pb-4 text-3xl font-bold text-black">
                    Available Times
                  </h2>
                  <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {eventDetails.time_slots.map((slot, index) => (
                      <div
                        key={index}
                        className="rounded-xl border border-gray-100 bg-gray-50 p-6 text-center"
                      >
                        <Clock
                          size={24}
                          weight="duotone"
                          className="mx-auto mb-3 text-gray-600"
                        />
                        <p className="font-semibold text-black">
                          {formatTime(slot.start)} - {formatTime(slot.end)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>

          {/* Right Sidebar - Booking */}
          <div className="order-first min-w-0 lg:order-last lg:col-span-1">
            <div
              id="booking-section"
              className="sticky top-4 max-w-full rounded-xl border border-blue-700 bg-blue-600 p-4 shadow-lg lg:top-6 lg:p-6"
            >
              {/* Pricing - Only show for approved bookings or non-screening events */}
              {(bookingStatus === 'approved' ||
                !eventDetails?.is_screening_allowed) && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="text-center">
                    <div className="mb-1 text-2xl font-bold break-words text-black lg:text-3xl">
                      {eventDetails.formattedPrice}
                    </div>
                    <div className="text-sm text-gray-600">per person</div>
                    {eventDetails.pricing_type && (
                      <div className="mt-2 inline-block rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
                        {eventDetails.pricing_type}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Guest Selection - Only show for non-screening events and when payment is not completed */}
              {!eventDetails?.is_screening_allowed && paymentStatus !== 'completed' && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-black">Guests</span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setGuests(Math.max(1, guests - 1))}
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 transition-colors hover:border-gray-400"
                        disabled={guests <= 1}
                      >
                        -
                      </button>
                      <span className="w-8 text-center font-medium">
                        {guests}
                      </span>
                      <button
                        onClick={() => setGuests(guests + 1)}
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 transition-colors hover:border-gray-400"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Total Price - Different logic for screening vs non-screening events */}
              {(bookingStatus === 'approved' || !eventDetails?.is_screening_allowed) && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="flex items-center justify-between text-xl font-bold text-black">
                    <span>Total</span>
                    <span>
                      {eventDetails?.is_screening_allowed
                        ? (
                          // For screening events (approved bookings), always show single person price
                          type === 'event'
                            ? eventDetails.fixed_price
                              ? `₹${eventDetails.fixed_price.toLocaleString()}`
                              : eventDetails.formattedPrice
                            : eventDetails.ticket_price
                              ? `₹${eventDetails.ticket_price.toLocaleString()}`
                              : eventDetails.formattedPrice
                        ) : (
                          // For non-screening events, multiply by guests
                          type === 'event'
                            ? eventDetails.fixed_price
                              ? `₹${(eventDetails.fixed_price * guests).toLocaleString()}`
                              : eventDetails.formattedPrice
                            : eventDetails.ticket_price
                              ? `₹${(eventDetails.ticket_price * guests).toLocaleString()}`
                              : eventDetails.formattedPrice
                        )
                      }
                    </span>
                  </div>
                  <div className="mt-1 text-right text-sm text-gray-500">
                    {eventDetails?.is_screening_allowed
                      ? 'per person (individual booking)'
                      : `for ${guests} guest${guests > 1 ? 's' : ''}`
                    }
                  </div>
                </div>
              )}

              {/* Payment Status Messages */}
              {paymentStatus === 'pending' && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
                    <div className="text-center">
                      <div className="mb-2 text-2xl">⏳</div>
                      <h3 className="mb-1 font-bold text-yellow-800">
                        Payment Processing
                      </h3>
                      <p className="text-sm text-yellow-700">
                        {isPolling
                          ? "Auto-checking payment status with smart polling. Please don't close this page."
                          : paymentPollingInterval
                          ? "We're checking your payment status every 10 seconds. Please don't close this page."
                          : "Your payment is being processed. Please wait..."
                        }
                      </p>
                      {frontendTimeoutTime && (
                        <div className="mt-2 space-y-1">
                          <p className="text-xs text-yellow-600">
                            We'll check your payment for: {Math.max(0, Math.round((frontendTimeoutTime.getTime() - new Date().getTime()) / 1000))} seconds
                          </p>
                          <p className="text-xs text-yellow-500">
                            (If it takes longer, please contact support)
                          </p>
                        </div>
                      )}
                      {(paymentStatusLoading || paymentPollingInterval) && (
                        <div className="mt-2 flex justify-center">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-yellow-600 border-t-transparent" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {paymentStatus === 'completed' && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                    <div className="text-center space-y-3">
                      <div className="text-2xl">🎉</div>
                      <h3 className="font-bold text-green-800">
                        Payment Successful!
                      </h3>
                      <p className="text-sm text-green-700">
                        Your booking is confirmed. Check your email for the ticket.
                        {!eventDetails?.is_screening_allowed && (
                          <span className="block mt-1 font-medium">
                            Guests: {paymentDetails?.guests || guests} person{(paymentDetails?.guests || guests) > 1 ? 's' : ''}
                          </span>
                        )}
                      </p>

                      {/* Payment Details */}
                      {paymentDetails && (
                        <div className="mt-4 p-3 bg-green-100 rounded-lg text-left">
                          <p className="text-xs font-semibold text-green-800 mb-2">Transaction Details:</p>
                          <div className="space-y-1 text-xs text-green-700">
                            {paymentDetails.orderId && (
                              <p><span className="font-medium">Order ID:</span> {paymentDetails.orderId}</p>
                            )}
                            {paymentDetails.amount && (
                              <p><span className="font-medium">Amount:</span> ₹{paymentDetails.amount.toLocaleString()}</p>
                            )}
                            {paymentDetails.paymentMode && (
                              <p><span className="font-medium">Payment Mode:</span> {paymentDetails.paymentMode}</p>
                            )}
                            {paymentDetails.utr && (
                              <p><span className="font-medium">UTR:</span> {paymentDetails.utr}</p>
                            )}
                            {paymentDetails.transactionId && (
                              <p><span className="font-medium">Transaction ID:</span> {paymentDetails.transactionId}</p>
                            )}
                            {/* Don't show sensitive details like account holder name in UI */}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {(paymentStatus === 'failed' || paymentStatus === 'expired') && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                    <div className="text-center space-y-3">
                      <div className="text-2xl">{paymentStatus === 'expired' ? '⏰' : '❌'}</div>
                      <h3 className="font-bold text-red-800">
                        {paymentStatus === 'expired' ? 'Payment Expired' : 'Payment Failed'}
                      </h3>
                      <p className="text-sm text-red-700">
                        {paymentStatus === 'expired'
                          ? "Your payment session has expired. Please try again."
                          : paymentTimeoutTimer === null && !paymentPollingInterval
                          ? "Payment took too long to process or failed. You can try again."
                          : paymentExpireTime && new Date() > paymentExpireTime
                          ? "Your payment session has expired. Please try again."
                          : "Your payment could not be processed. Please try again."
                        }
                      </p>

                      {/* Show failed transaction details if available */}
                      {paymentDetails && (paymentDetails.orderId || paymentDetails.transactionId) && (
                        <div className="mt-3 p-3 bg-red-100 rounded-lg text-left">
                          <p className="text-xs font-semibold text-red-800 mb-2">Failed Transaction Reference:</p>
                          <div className="space-y-1 text-xs text-red-700">
                            {paymentDetails.orderId && (
                              <p><span className="font-medium">Order ID:</span> {paymentDetails.orderId}</p>
                            )}
                            {paymentDetails.transactionId && (
                              <p><span className="font-medium">Transaction ID:</span> {paymentDetails.transactionId}</p>
                            )}
                            {paymentDetails.amount && (
                              <p><span className="font-medium">Amount:</span> ₹{paymentDetails.amount.toLocaleString()}</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Contact Information */}
                      <div className="mt-3 p-3 bg-red-100 rounded-lg">
                        <p className="text-xs font-semibold text-red-800 mb-2">Need Help? Reach out to us:</p>
                        <div className="space-y-1 text-xs text-red-700">
                          {(eventDetails.contact_number || eventDetails.emergency_contact_number) && (
                            <p>📞 Phone: {eventDetails.contact_number || eventDetails.emergency_contact_number}</p>
                          )}
                          <p>📧 Email: support@trippechalo.in</p>
                          <p className="mt-2 font-medium">We'll help you complete your booking!</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Registration Success Messages */}
              {bookingStatus === 'registered' && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                    <div className="text-center">
                      <div className="mb-2 text-2xl">🎉</div>
                      <h3 className="mb-1 font-bold text-green-800">
                        You have successfully registered
                      </h3>
                      <p className="text-sm text-green-700">
                        Please check your email for further details.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {bookingStatus === 'approved' && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                    <div className="text-center">
                      <div className="mb-2 text-2xl">✅</div>
                      <h3 className="mb-1 font-bold text-blue-800">
                        Congratulations!
                      </h3>
                      <p className="text-sm text-blue-700">
                        You have been approved for this event.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {bookingStatus === 'rejected' && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                    <div className="text-center">
                      <div className="mb-2 text-2xl">❌</div>
                      <h3 className="mb-1 font-bold text-red-800">
                        Not Selected
                      </h3>
                      <p className="text-sm text-red-700">
                        Unfortunately, you were not selected for this event.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Book/Register/Pay Button */}
              {paymentStatus === 'completed' ? (
                <button
                  disabled
                  className="mb-4 w-full rounded-xl bg-green-600 py-4 text-lg font-semibold text-white"
                >
                  ✅ Booking Confirmed
                </button>
              ) : bookingStatusLoading ? (
                <button
                  disabled
                  className="mb-4 flex w-full items-center justify-center rounded-xl bg-gray-400 py-4 text-lg font-semibold text-white"
                >
                  <div className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Loading...
                </button>
              ) : bookingStatus === 'register' ? (
                <button
                  onClick={
                    eventDetails?.is_screening_allowed === true
                      ? handleRegistrationClick
                      : handlePaymentRequest
                  }
                  disabled={paymentLoading || paymentStatus === 'pending'}
                  className="mb-4 w-full rounded-xl bg-black py-4 text-lg font-semibold text-white transition-colors hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {paymentLoading || paymentStatus === 'pending' ? (
                    <div className="flex items-center justify-center">
                      <div className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Processing...
                    </div>
                  ) : eventDetails?.is_screening_allowed === true
                    ? user
                      ? 'Complete Your Registration'
                      : 'Register Now'
                    : 'Book Now'}
                </button>
              ) : bookingStatus === 'approved' ? (
                <button
                  onClick={handlePaymentRequest}
                  disabled={paymentLoading || paymentStatus === 'pending'}
                  className="mb-4 w-full rounded-xl bg-green-600 py-4 text-lg font-semibold text-white transition-colors hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {paymentLoading || paymentStatus === 'pending' ? (
                    <div className="flex items-center justify-center">
                      <div className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Processing...
                    </div>
                  ) : (
                    'Pay Now'
                  )}
                </button>
              ) : bookingStatus === 'rejected' ? null : null}

              {/* Retry Payment Button for Failed/Expired Payments */}
              {(paymentStatus === 'failed' || paymentStatus === 'expired') && (
                <button
                  onClick={() => {
                    console.log(`🔄 Retrying payment from ${paymentStatus} - resetting status to idle`);
                    setPaymentStatus('idle');
                    setMerchantOrderId('');
                    setPaymentDetails(null);
                    setPaymentExpireTime(null);
                    setFrontendTimeoutTime(null);

                    // Clear localStorage
                    const storageKey = getPaymentStorageKey();
                    localStorage.removeItem(storageKey);

                    handlePaymentRequest();
                  }}
                  disabled={paymentLoading}
                  className="mb-4 w-full rounded-xl bg-blue-600 py-4 text-lg font-semibold text-white transition-colors hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {paymentLoading ? (
                    <div className="flex items-center justify-center">
                      <div className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Processing...
                    </div>
                  ) : (
                    `🔄 Try Payment Again ${paymentStatus === 'expired' ? '(Session Expired)' : ''}`
                  )}
                </button>
              )}

              {/* Show "You won't be charged yet" only for non-screening events or when not approved */}
              {(!eventDetails?.is_screening_allowed ||
                (eventDetails?.is_screening_allowed && bookingStatus !== 'approved' && bookingStatus !== 'rejected')) && (
                <div className="mb-6 rounded-xl bg-white p-4">
                  <p className="text-center text-sm text-gray-500">
                    {eventDetails?.is_screening_allowed
                      ? 'Complete registration first - no payment required yet'
                      : 'You won\'t be charged yet'
                    }
                  </p>
                </div>
              )}

              {/* Quick Info */}
              <div className="mb-6 rounded-xl bg-white p-4">
                <div className="space-y-3">
                  {eventDetails.formattedDate && (
                    <div className="flex items-center gap-2 rounded-lg bg-gray-50 p-3">
                      <Calendar
                        size={16}
                        weight="duotone"
                        className="flex-shrink-0 text-gray-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-gray-500">
                          Date
                        </div>
                        <div className="truncate text-sm font-medium text-black">
                          {eventDetails.formattedDate}
                        </div>
                      </div>
                    </div>
                  )}
                  {eventDetails.formattedTime && (
                    <div className="flex items-center gap-2 rounded-lg bg-gray-50 p-3">
                      <Clock
                        size={16}
                        weight="duotone"
                        className="flex-shrink-0 text-gray-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-gray-500">
                          Start Time
                        </div>
                        <div className="text-sm font-medium text-black">
                          {eventDetails.formattedTime}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2 rounded-lg bg-gray-50 p-3">
                    <MapPin
                      size={16}
                      weight="duotone"
                      className="mt-0.5 flex-shrink-0 text-gray-600"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-gray-500">
                        Location
                      </div>
                      {eventDetails.address_google_map_link ? (
                        <button
                          onClick={() =>
                            window.open(
                              eventDetails.address_google_map_link!,
                              '_blank'
                            )
                          }
                          className="text-left text-sm font-medium break-words text-blue-600 transition-colors hover:text-blue-800"
                        >
                          {eventDetails.address_full_address}
                        </button>
                      ) : (
                        <div className="text-sm font-medium break-words text-blue-600">
                          {eventDetails.address_full_address}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Organizer Info */}
              {eventDetails.contact_name && (
                <div className="rounded-xl bg-white p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <User
                      size={16}
                      weight="duotone"
                      className="text-gray-500"
                    />
                    <div className="text-sm text-gray-500">Organized by</div>
                  </div>
                  <div className="font-medium text-black">
                    {eventDetails.contact_name}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="mt-6 flex gap-3">
                <button
                  onClick={handleWishlistToggle}
                  className={`flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 font-medium transition-colors sm:w-auto ${
                    isWishlisted
                      ? 'border-red-300 bg-red-100 text-red-600'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-200 hover:text-gray-900'
                  }`}
                >
                  <Heart
                    size={18}
                    fill={isWishlisted ? 'currentColor' : 'none'}
                  />
                  <span className="hidden sm:inline">
                    {isWishlisted ? 'Wishlisted' : 'Add to Wishlist'}
                  </span>
                  <span className="sm:hidden">
                    {isWishlisted ? 'Wishlisted' : 'Wishlist'}
                  </span>
                </button>
                <button
                  onClick={handleShare}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900 sm:w-auto"
                >
                  <Share2 size={18} />
                  Share
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Guidelines and FAQs Section */}
      {(eventDetails.guidelines && eventDetails.guidelines.trim()) ||
      (eventDetails.faqs && Object.keys(eventDetails.faqs).length > 0) ? (
        <section className="mx-auto max-w-7xl border-t border-gray-200 px-4 py-12">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            {/* Guidelines */}
            {eventDetails.guidelines && eventDetails.guidelines.trim() && (
              <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
                <h3 className="mb-4 text-xl font-bold text-black">
                  Guidelines
                </h3>
                <div className="space-y-3 text-sm whitespace-pre-line text-gray-700">
                  {eventDetails.guidelines}
                </div>
              </div>
            )}

            {/* FAQs */}
            {eventDetails.faqs && Object.keys(eventDetails.faqs).length > 0 && (
              <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
                <h3 className="mb-4 text-xl font-bold text-black">FAQs</h3>
                <div className="space-y-4 text-sm">
                  {Object.entries(eventDetails.faqs).map(
                    ([question, answer], index) => (
                      <div key={index}>
                        <h4 className="mb-1 font-semibold text-black">
                          {question}
                        </h4>
                        <p className="whitespace-pre-line text-gray-700">
                          {answer}
                        </p>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* Registration Modal */}
      {showRegistrationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-r from-black/60 to-gray-800/60 p-2 backdrop-blur-md sm:p-4">
          <div className="flex max-h-[95vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white sm:max-h-[90vh] sm:rounded-2xl">
            {/* Modal Header */}
            <div className="flex-shrink-0 rounded-t-xl border-b border-gray-200 bg-white px-4 py-4 sm:rounded-t-2xl sm:px-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-black sm:text-2xl">
                  Register for Event
                </h2>
                <button
                  onClick={() => setShowRegistrationModal(false)}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-gray-100"
                >
                  <span className="text-2xl text-gray-500">×</span>
                </button>
              </div>
              <p className="mt-2 pr-8 text-sm break-words text-gray-600">
                {eventDetails?.event_name}
              </p>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:space-y-8 sm:p-6">
              {/* Custom Form Section */}
              {eventDetails?.custom_form &&
                Object.keys(eventDetails.custom_form).length > 0 && (
                  <div>
                    <h3 className="mb-4 text-xl font-semibold text-black">
                      Custom Form
                    </h3>
                    <div className="space-y-4">
                      {Object.entries(eventDetails.custom_form).map(
                        ([question, hint], index) => (
                          <div key={index}>
                            <label className="mb-2 block text-sm font-medium text-gray-700">
                              {question.charAt(0).toUpperCase() +
                                question.slice(1).replace(/_/g, ' ')}
                              <span className="ml-1 text-red-500">*</span>
                            </label>
                            {hint && (
                              <p className="mb-2 text-xs text-gray-500">
                                {hint}
                              </p>
                            )}
                            <textarea
                              value={customFormData[question] || ''}
                              onChange={(e) =>
                                handleCustomFormChange(question, e.target.value)
                              }
                              className="w-full resize-none rounded-lg border border-gray-300 px-4 py-3 focus:border-transparent focus:ring-2 focus:ring-blue-500"
                              rows={3}
                              placeholder={`Enter your answer for: ${question.replace(/_/g, ' ')}`}
                            />
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}

              {/* Personal Details Section */}
              <div>
                <h3 className="mb-4 text-xl font-semibold text-black">
                  Personal Details
                </h3>
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Full Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={personalDetails.name}
                      onChange={(e) =>
                        handlePersonalDetailsChange('name', e.target.value)
                      }
                      className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:border-transparent focus:ring-2 focus:ring-blue-500"
                      placeholder="Enter your full name"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Email Address <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={personalDetails.email}
                      onChange={(e) =>
                        handlePersonalDetailsChange('email', e.target.value)
                      }
                      className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:border-transparent focus:ring-2 focus:ring-blue-500"
                      placeholder="Enter your email address"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Phone Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      value={personalDetails.phone}
                      onChange={(e) =>
                        handlePersonalDetailsChange('phone', e.target.value)
                      }
                      className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:border-transparent focus:ring-2 focus:ring-blue-500"
                      placeholder="Enter your phone number"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex-shrink-0 rounded-b-xl border-t border-gray-200 bg-white px-4 py-4 sm:rounded-b-2xl sm:px-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={() => setShowRegistrationModal(false)}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:px-6 sm:text-base"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRegistrationSubmit}
                  disabled={registrationLoading}
                  className="flex flex-1 items-center justify-center rounded-lg bg-black px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:bg-gray-400 sm:px-6 sm:text-base"
                >
                  {registrationLoading ? (
                    <>
                      <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent sm:h-5 sm:w-5" />
                      Registering...
                    </>
                  ) : (
                    'Register'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Login Modal */}
      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
      />

      {/* PhonePe Payment Iframe Modal */}
      {showPhonePeIframe && phonePeIframeData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="relative w-full max-w-4xl h-[80vh] bg-white rounded-xl shadow-2xl overflow-hidden">
            {/* Close button */}
            <button
              onClick={() => {
                setShowPhonePeIframe(false);
                setPaymentStatus('failed');
                console.log('❌ PhonePe iframe closed by user');
              }}
              className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-lg hover:bg-gray-100 transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {/* PhonePe iframe */}
            <iframe
              src="/phonepe-iframe.html"
              className="w-full h-full border-0"
              title="PhonePe Payment"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
              onLoad={() => {
                console.log('🌐 PhonePe iframe loaded, sending init message');
                const iframe = document.querySelector('iframe[title="PhonePe Payment"]') as HTMLIFrameElement;
                if (iframe && iframe.contentWindow) {
                  iframe.contentWindow.postMessage({
                    type: 'INIT_PHONEPE_PAYMENT',
                    tokenUrl: phonePeIframeData.tokenUrl,
                    merchantOrderId: phonePeIframeData.merchantOrderId
                  }, '*');
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Removed debug panels that might cause Vercel 400 error */}
    </div>
  );
};

export default BookingPage;
