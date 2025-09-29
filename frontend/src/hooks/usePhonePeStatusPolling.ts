import { useEffect, useRef, useCallback } from 'react';
import { phonePeStatusPoller, PollingConfig } from '../services/phonepe-status-polling';

interface UsePhonePeStatusPollingProps {
  merchantOrderId: string | null;
  enabled: boolean;
  onStatusUpdate: (status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED', details?: any) => void;
  onError?: (error: Error) => void;
  expireAfter?: number;
}

interface UsePhonePeStatusPollingReturn {
  isPolling: boolean;
  startPolling: () => void;
  stopPolling: () => void;
}

/**
 * Hook to manage PhonePe transaction status polling
 * Automatically starts polling when merchantOrderId and enabled are true
 * Follows PhonePe's recommended polling schedule
 */
export const usePhonePeStatusPolling = ({
  merchantOrderId,
  enabled,
  onStatusUpdate,
  onError,
  expireAfter
}: UsePhonePeStatusPollingProps): UsePhonePeStatusPollingReturn => {

  const configRef = useRef<PollingConfig | null>(null);

  // Create stable config object
  const createConfig = useCallback((): PollingConfig | null => {
    if (!merchantOrderId) return null;

    return {
      merchantOrderId,
      onStatusUpdate: (status, details) => {
        console.log(`[usePhonePeStatusPolling] Status update: ${status}`, details);
        onStatusUpdate(status, details);
      },
      onError: (error) => {
        console.error('[usePhonePeStatusPolling] Polling error:', error);
        if (onError) onError(error);
      },
      expireAfter
    };
  }, [merchantOrderId, onStatusUpdate, onError, expireAfter]);

  const startPolling = useCallback(() => {
    const config = createConfig();
    if (!config) {
      console.warn('[usePhonePeStatusPolling] Cannot start polling: no merchantOrderId');
      return;
    }

    configRef.current = config;
    phonePeStatusPoller.startPolling(config);
  }, [createConfig]);

  const stopPolling = useCallback(() => {
    phonePeStatusPoller.stopPolling();
    configRef.current = null;
  }, []);

  // Auto-start polling when conditions are met
  useEffect(() => {
    if (enabled && merchantOrderId && !phonePeStatusPoller.getPollingStatus()) {
      console.log('[usePhonePeStatusPolling] Auto-starting polling for:', merchantOrderId);
      startPolling();
    }

    // Cleanup on unmount or when disabled
    return () => {
      if (phonePeStatusPoller.getPollingStatus()) {
        console.log('[usePhonePeStatusPolling] Cleaning up polling on unmount/disable');
        stopPolling();
      }
    };
  }, [enabled, merchantOrderId, startPolling, stopPolling]);

  // Stop polling when merchantOrderId changes (new transaction)
  useEffect(() => {
    return () => {
      if (phonePeStatusPoller.getPollingStatus()) {
        console.log('[usePhonePeStatusPolling] Stopping polling due to merchantOrderId change');
        stopPolling();
      }
    };
  }, [merchantOrderId, stopPolling]);

  return {
    isPolling: phonePeStatusPoller.getPollingStatus(),
    startPolling,
    stopPolling
  };
};