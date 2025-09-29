import React, { useState, useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Calendar, MapPin, Clock, User, CheckCircle, XCircle, AlertCircle, CreditCard, DollarSign, Eye, Timer, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { BookingApiService, Booking } from '../services/booking-api';
import { NearbyApiService } from '../services/nearby-api';
import { usePhonePeStatusPolling } from '../hooks/usePhonePeStatusPolling';

interface BookingWithEventDetails extends Booking {
  eventDetails?: {
    event_name: string;
    tagline?: string;
    short_description?: string;
    date?: string;
    start_time?: string;
    address_city: string;
    address_venue: string;
    banner_image?: string;
    experience_photo_urls?: string[];
    fixed_price?: number;
    ticket_price?: number;
    primary_category: string;
    is_screening_allowed?: boolean;
  };
  eventType?: 'event' | 'experience';
  loadingDetails?: boolean;
  detailsError?: string;
  // Enhanced payment status from transactions
  paymentStatus?: 'idle' | 'pending' | 'completed' | 'failed' | 'expired';
  paymentAmount?: number;
  transactionId?: string;
  utr?: string;
}

const MyBookingsPage: React.FC = () => {
  const { user, loading: authLoading } = useAuth();
  const [bookings, setBookings] = useState<BookingWithEventDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Find pending transactions that need polling
  const pendingBookings = bookings.filter(booking =>
    booking.paymentStatus === 'pending' &&
    (booking as any).merchant_order_id
  );

  // Poll for the first pending booking (can be extended to poll multiple)
  const firstPendingBooking = pendingBookings[0];

  const { isPolling } = usePhonePeStatusPolling({
    merchantOrderId: firstPendingBooking ? (firstPendingBooking as any).merchant_order_id : null,
    enabled: !!firstPendingBooking,
    onStatusUpdate: (status, details) => {
      console.log(`🔄 [MyBookings Polling] Status update for ${firstPendingBooking?.id}: ${status}`, details);

      // Update the specific booking in the list
      setBookings(prevBookings =>
        prevBookings.map(booking => {
          if (booking.id === firstPendingBooking?.id) {
            return {
              ...booking,
              paymentStatus: status === 'COMPLETED' ? 'completed' :
                           status === 'FAILED' ? 'failed' :
                           status === 'EXPIRED' ? 'expired' : 'pending'
            };
          }
          return booking;
        })
      );
    },
    onError: (error) => {
      console.error('🚫 [MyBookings Polling] Error:', error);
    }
  });

  // Redirect to home if not authenticated
  if (!authLoading && !user) {
    return <Navigate to="/" replace />;
  }

  // Fetch bookings
  useEffect(() => {
    const fetchBookings = async () => {
      if (!user) return;

      setLoading(true);
      try {
        const response = await BookingApiService.getAllBookings();

        if (response.success && response.data) {
          // Convert bookings and start fetching event details
          const bookingsWithDetails: BookingWithEventDetails[] = response.data.map(booking => {
            // Extract payment information from transactions
            const transactions = (booking as any).transactions || [];
            let paymentStatus: 'idle' | 'pending' | 'completed' | 'failed' | 'expired' = 'idle';
            let paymentAmount: number | undefined;
            let transactionId: string | undefined;
            let utr: string | undefined;


            if (transactions.length > 0) {
              // Find the latest transaction with a valid status
              const latestTransaction = transactions[transactions.length - 1];
              const status = latestTransaction.transaction_status;


              switch (status) {
                case 'COMPLETED':
                  paymentStatus = 'completed';
                  break;
                case 'PENDING':
                  paymentStatus = 'pending';
                  break;
                case 'FAILED':
                  paymentStatus = 'failed';
                  break;
                case 'EXPIRED':
                  paymentStatus = 'expired';
                  break;
                default:
                  paymentStatus = 'pending';
              }

              paymentAmount = parseFloat(latestTransaction.amount);
              transactionId = latestTransaction.transaction_id;
              utr = latestTransaction.transaction_utr;
            }

            return {
              ...booking,
              loadingDetails: true,
              paymentStatus,
              paymentAmount,
              transactionId,
              utr
            };
          });

          setBookings(bookingsWithDetails);

          // Fetch event details for each booking
          const updatedBookings = await Promise.allSettled(
            bookingsWithDetails.map(async (booking) => {
              try {
                // Try to fetch as event first
                let eventDetails;
                let eventType: 'event' | 'experience' = 'event';

                try {
                  eventDetails = await NearbyApiService.getEventDetails(booking.event_id);
                } catch (eventError) {
                  // If event fetch fails, try as experience
                  try {
                    eventDetails = await NearbyApiService.getExperienceDetails(booking.event_id);
                    eventType = 'experience';
                  } catch (experienceError) {
                    throw new Error('Could not fetch event details');
                  }
                }

                return {
                  ...booking,
                  eventDetails: {
                    ...eventDetails,
                    is_screening_allowed: (eventDetails as any).is_screening_allowed
                  },
                  eventType,
                  loadingDetails: false
                };
              } catch (error) {
                return {
                  ...booking,
                  loadingDetails: false,
                  detailsError: error instanceof Error ? error.message : 'Failed to load event details'
                };
              }
            })
          );

          // Update bookings with results
          const finalBookings = updatedBookings.map((result, index) => {
            if (result.status === 'fulfilled') {
              return result.value;
            } else {
              return {
                ...bookingsWithDetails[index],
                loadingDetails: false,
                detailsError: 'Failed to load event details'
              };
            }
          });

          setBookings(finalBookings);
        } else {
          setError(response.error || 'Failed to fetch bookings');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch bookings');
      } finally {
        setLoading(false);
      }
    };

    fetchBookings();
  }, [user]);

  // Enhanced status system for screening vs direct events
  const getEventStatusInfo = (booking: BookingWithEventDetails) => {
    const isScreeningEvent = booking.eventDetails?.is_screening_allowed;
    const isApproved = booking.is_approved;
    const paymentStatus = booking.paymentStatus;



    if (isScreeningEvent) {
      // Multi-step booking flow
      if (isApproved === null) {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-amber-100 to-yellow-100 text-amber-800 border border-amber-200">
              <Timer size={12} />
              Pending Review
            </span>
          ),
          description: 'Your application is under review',
          actionText: 'View Application',
          color: 'amber'
        };
      }

      if (isApproved === false) {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-red-100 to-pink-100 text-red-800 border border-red-200">
              <XCircle size={12} />
              Not Selected
            </span>
          ),
          description: 'Application was not approved',
          actionText: 'View Details',
          color: 'red'
        };
      }

      // Approved - check payment status from transactions
      if (paymentStatus === 'completed') {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 border border-green-200">
              <Sparkles size={12} />
              Confirmed
            </span>
          ),
          description: 'Payment completed - booking confirmed!',
          actionText: 'View Ticket',
          color: 'green'
        };
      }

      if (paymentStatus === 'pending') {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-blue-100 to-cyan-100 text-blue-800 border border-blue-200">
              <CreditCard size={12} />
              Payment Pending
            </span>
          ),
          description: isPolling && booking.id === firstPendingBooking?.id
            ? 'Auto-checking payment status...'
            : 'Payment is being processed',
          actionText: 'Check Payment Status',
          color: 'blue'
        };
      }

      if (paymentStatus === 'failed' || paymentStatus === 'expired') {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-orange-100 to-red-100 text-orange-800 border border-orange-200">
              <AlertCircle size={12} />
              Payment Failed
            </span>
          ),
          description: 'Approved but payment failed - retry now',
          actionText: 'Retry Payment',
          color: 'orange'
        };
      }

      // Approved but no payment transaction exists - show "Pay Now"
      // This means the user is approved but hasn't made any payment attempt yet
      return {
        badge: (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 border border-green-200">
            <CheckCircle size={12} />
            Approved
          </span>
        ),
        description: 'Congratulations! You\'re selected',
        actionText: 'Pay Now',
        color: 'green'
      };
    } else {
      // Direct booking flow
      if (paymentStatus === 'completed') {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 border border-green-200">
              <Sparkles size={12} />
              Booked
            </span>
          ),
          description: 'Booking confirmed with payment',
          actionText: 'View Ticket',
          color: 'green'
        };
      }

      if (paymentStatus === 'pending') {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-blue-100 to-cyan-100 text-blue-800 border border-blue-200">
              <CreditCard size={12} />
              Payment Pending
            </span>
          ),
          description: isPolling && booking.id === firstPendingBooking?.id
            ? 'Auto-checking payment status...'
            : 'Payment is being processed',
          actionText: 'Check Status',
          color: 'blue'
        };
      }

      if (paymentStatus === 'failed' || paymentStatus === 'expired') {
        return {
          badge: (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-orange-100 to-red-100 text-orange-800 border border-orange-200">
              <AlertCircle size={12} />
              Payment Failed
            </span>
          ),
          description: 'Payment failed - complete booking',
          actionText: 'Retry Payment',
          color: 'orange'
        };
      }

      // No payment transaction exists - need to pay
      // For direct events, if no transactions exist, user needs to complete payment
      return {
        badge: (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-amber-100 to-orange-100 text-amber-800 border border-amber-200">
            <DollarSign size={12} />
            Payment Required
          </span>
        ),
        description: 'Complete payment to confirm booking',
        actionText: 'Pay Now',
        color: 'amber'
      };
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return dateString;
    }
  };

  const formatTime = (timeString: string) => {
    try {
      const [hours, minutes] = timeString.split(':').map(Number);
      const date = new Date();
      date.setHours(hours, minutes);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch {
      return timeString;
    }
  };

  // Show loading state
  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center pt-24">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-600 font-medium">Loading your bookings...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center pt-24">
        <div className="text-center max-w-md mx-auto px-6">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-8 h-8 text-red-600" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Unable to Load Bookings</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-cyan-50 pt-24 pb-12">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-12 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl mb-6">
            <Calendar className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-transparent mb-4">
            My Bookings
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Track your event registrations, payment status, and manage your upcoming experiences
          </p>
        </div>

        {/* Stats Overview */}
        {bookings.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-6 border border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Bookings</p>
                  <p className="text-2xl font-bold text-gray-900">{bookings.length}</p>
                </div>
                <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                  <Calendar className="w-6 h-6 text-blue-600" />
                </div>
              </div>
            </div>
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-6 border border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Confirmed</p>
                  <p className="text-2xl font-bold text-green-600">
                    {bookings.filter(b => b.paymentStatus === 'completed').length}
                  </p>
                </div>
                <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                  <CheckCircle className="w-6 h-6 text-green-600" />
                </div>
              </div>
            </div>
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-6 border border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Pending</p>
                  <p className="text-2xl font-bold text-amber-600">
                    {bookings.filter(b => b.is_approved === null || b.paymentStatus === 'pending').length}
                  </p>
                </div>
                <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center">
                  <Timer className="w-6 h-6 text-amber-600" />
                </div>
              </div>
            </div>
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-6 border border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Screening Events</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {bookings.filter(b => b.eventDetails?.is_screening_allowed).length}
                  </p>
                </div>
                <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
                  <Eye className="w-6 h-6 text-purple-600" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bookings List */}
        {bookings.length === 0 ? (
          <div className="text-center py-20">
            <div className="relative">
              <div className="w-24 h-24 bg-gradient-to-r from-blue-100 to-purple-100 rounded-3xl flex items-center justify-center mx-auto mb-8">
                <Calendar className="w-12 h-12 text-gray-400" />
              </div>
              <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-2 w-8 h-8 bg-gradient-to-r from-pink-500 to-purple-500 rounded-full opacity-20 animate-pulse"></div>
            </div>
            <h3 className="text-2xl font-bold text-gray-900 mb-3">No Bookings Yet</h3>
            <p className="text-gray-600 mb-8 max-w-md mx-auto">Start exploring amazing events and experiences. Your journey begins with the first booking!</p>
            <div className="inline-flex items-center bg-gradient-to-r from-blue-600 to-purple-600 text-white px-8 py-3 rounded-xl hover:from-blue-700 hover:to-purple-700 transition-all duration-200 font-semibold shadow-lg hover:shadow-xl transform hover:-translate-y-0.5">
              <Sparkles className="w-5 h-5 mr-2" />
              Explore Events
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {bookings.map((booking) => {
              const statusInfo = getEventStatusInfo(booking);

              return (
                <div
                  key={booking.id}
                  className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-gray-100/50 overflow-hidden hover:shadow-lg hover:border-gray-200/50 transition-all duration-300 group"
                >
                  <div className="flex flex-col lg:flex-row">
                    {/* Event Image */}
                    <div className="relative lg:w-64 h-48 lg:h-auto lg:min-h-[200px] overflow-hidden lg:flex-shrink-0">
                      {booking.loadingDetails ? (
                        <div className="w-full h-full bg-gradient-to-br from-gray-200 to-gray-300 animate-pulse"></div>
                      ) : booking.eventDetails?.banner_image || booking.eventDetails?.experience_photo_urls?.[0] ? (
                        <img
                          src={booking.eventDetails.banner_image || booking.eventDetails.experience_photo_urls?.[0]}
                          alt={booking.eventDetails.event_name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-blue-100 via-purple-100 to-pink-100 flex items-center justify-center">
                          <Calendar className="w-12 h-12 text-gray-400" />
                        </div>
                      )}
                    </div>

                    {/* Card Content */}
                    <div className="flex-1 p-6 flex flex-col">
                      {/* Header with Event Title and Status */}
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
                        <div className="flex-1 min-w-0">
                          {booking.loadingDetails ? (
                            <div className="space-y-2">
                              <div className="h-6 bg-gray-200 rounded animate-pulse w-3/4"></div>
                              <div className="h-4 bg-gray-200 rounded animate-pulse w-1/2"></div>
                            </div>
                          ) : booking.detailsError ? (
                            <div>
                              <h3 className="text-xl font-bold text-gray-900 mb-1">Event #{booking.event_id}</h3>
                              <p className="text-sm text-red-600">{booking.detailsError}</p>
                            </div>
                          ) : (
                            <div>
                              <h3 className="text-xl font-bold text-gray-900 mb-2 line-clamp-2 group-hover:text-blue-600 transition-colors">
                                {booking.eventDetails?.event_name || 'Unknown Event'}
                              </h3>
                              {booking.eventDetails?.tagline && (
                                <p className="text-gray-600 text-sm line-clamp-2">
                                  {booking.eventDetails.tagline}
                                </p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Status Badge */}
                        <div className="flex-shrink-0">
                          {statusInfo.badge}
                        </div>
                      </div>

                    {/* Status Description */}
                    <div className="mb-4 p-3 bg-gray-50/50 rounded-xl border border-gray-100">
                      <p className="text-sm text-gray-700 font-medium mb-1">{statusInfo.description}</p>
                      {booking.paymentAmount && (
                        <div className="flex items-center gap-1 text-xs text-gray-600">
                          <DollarSign size={12} />
                          <span>Amount: ₹{booking.paymentAmount.toLocaleString()}</span>
                        </div>
                      )}
                    </div>

                    {/* Event Meta Information */}
                    {!booking.loadingDetails && booking.eventDetails && (
                      <div className="grid grid-cols-1 gap-3 text-sm text-gray-600 mb-6">
                        {booking.eventDetails.date && (
                          <div className="flex items-center gap-2">
                            <Calendar size={14} className="text-blue-500" />
                            <span>{formatDate(booking.eventDetails.date)}</span>
                            {booking.eventDetails.start_time && (
                              <>
                                <span className="text-gray-400">•</span>
                                <Clock size={14} className="text-blue-500" />
                                <span>{formatTime(booking.eventDetails.start_time)}</span>
                              </>
                            )}
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <MapPin size={14} className="text-green-500" />
                          <span className="truncate">{booking.eventDetails.address_city}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <User size={14} className="text-purple-500" />
                          <span>Registered as: {booking.name}</span>
                        </div>
                      </div>
                    )}

                    {/* Payment Details for completed bookings */}
                    {booking.paymentStatus === 'completed' && (booking.transactionId || booking.utr) && (
                      <div className="mb-6 p-3 bg-green-50/50 rounded-xl border border-green-100">
                        <p className="text-xs font-semibold text-green-800 mb-2">Transaction Details</p>
                        <div className="space-y-1 text-xs text-green-700">
                          {booking.transactionId && (
                            <p><span className="font-medium">Transaction ID:</span> {booking.transactionId}</p>
                          )}
                          {booking.utr && (
                            <p><span className="font-medium">UTR:</span> {booking.utr}</p>
                          )}
                        </div>
                      </div>
                    )}

                      {/* Action Button */}
                      <div className="mt-auto pt-4">
                        {!booking.loadingDetails && !booking.detailsError && (
                          <Link
                            to={`/booking/${booking.eventType}/${booking.event_id}`}
                            className={`inline-flex items-center px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${
                              statusInfo.color === 'green' ? 'bg-green-600 text-white hover:bg-green-700' :
                              statusInfo.color === 'blue' ? 'bg-blue-600 text-white hover:bg-blue-700' :
                              statusInfo.color === 'orange' ? 'bg-orange-600 text-white hover:bg-orange-700' :
                              statusInfo.color === 'amber' ? 'bg-amber-600 text-white hover:bg-amber-700' :
                              statusInfo.color === 'red' ? 'bg-red-600 text-white hover:bg-red-700' :
                              'bg-gray-600 text-white hover:bg-gray-700'
                            }`}
                          >
                            {statusInfo.actionText}
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default MyBookingsPage;