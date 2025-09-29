interface PollingConfig {
  merchantOrderId: string;
  onStatusUpdate: (status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED', details?: any) => void;
  onError?: (error: Error) => void;
  expireAfter?: number; // milliseconds, default 30 minutes
}

interface PollingSchedule {
  interval: number; // milliseconds
  duration: number; // milliseconds
}

class PhonePeStatusPoller {
  private isPolling = false;
  private timeoutId: NodeJS.Timeout | null = null;
  private startTime = 0;
  private config: PollingConfig | null = null;

  // PhonePe recommended polling schedule
  private readonly POLLING_SCHEDULE: PollingSchedule[] = [
    { interval: 3000, duration: 30000 },   // Every 3s for 30s
    { interval: 6000, duration: 60000 },   // Every 6s for 60s
    { interval: 10000, duration: 60000 },  // Every 10s for 60s
    { interval: 30000, duration: 60000 },  // Every 30s for 60s
    { interval: 60000, duration: Infinity } // Every 1min until terminal status
  ];

  private readonly INITIAL_DELAY = 22500; // 22.5 seconds (20-25s range)
  private readonly DEFAULT_EXPIRE_AFTER = 30 * 60 * 1000; // 30 minutes

  /**
   * Start polling for transaction status
   */
  public startPolling(config: PollingConfig): void {
    if (this.isPolling) {
      console.warn('[PhonePe Polling] Already polling. Stop current polling first.');
      return;
    }

    this.config = config;
    this.isPolling = true;
    this.startTime = Date.now();

    console.log(`[PhonePe Polling] Starting status polling for merchant order: ${config.merchantOrderId}`);

    // Initial delay of 20-25 seconds as per PhonePe recommendation
    this.timeoutId = setTimeout(() => {
      this.executePollingCycle();
    }, this.INITIAL_DELAY);
  }

  /**
   * Stop polling
   */
  public stopPolling(): void {
    if (!this.isPolling) return;

    console.log('[PhonePe Polling] Stopping status polling');

    this.isPolling = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.config = null;
  }

  /**
   * Check if currently polling
   */
  public getPollingStatus(): boolean {
    return this.isPolling;
  }

  /**
   * Execute the polling cycle with progressive intervals
   */
  private async executePollingCycle(): Promise<void> {
    if (!this.isPolling || !this.config) return;

    const elapsedTime = Date.now() - this.startTime;
    const expireAfter = this.config.expireAfter || this.DEFAULT_EXPIRE_AFTER;

    // Check if polling has expired
    if (elapsedTime >= expireAfter) {
      console.log('[PhonePe Polling] Polling expired after maximum time');
      this.config.onStatusUpdate('EXPIRED');
      this.stopPolling();
      return;
    }

    try {
      // Make API call to check status
      const status = await this.checkTransactionStatus(this.config.merchantOrderId);

      // Handle terminal statuses
      if (this.isTerminalStatus(status.transactionStatus)) {
        console.log(`[PhonePe Polling] Terminal status reached: ${status.transactionStatus}`);
        this.config.onStatusUpdate(status.transactionStatus, status.details);
        this.stopPolling();
        return;
      }

      // Continue polling for non-terminal statuses
      if (status.transactionStatus === 'PENDING') {
        this.config.onStatusUpdate('PENDING', status.details);
        this.scheduleNextPoll(elapsedTime);
      }

    } catch (error) {
      console.error('[PhonePe Polling] Error checking transaction status:', error);

      if (this.config.onError) {
        this.config.onError(error instanceof Error ? error : new Error('Unknown polling error'));
      }

      // Continue polling on error (network issues, temporary server problems)
      this.scheduleNextPoll(elapsedTime);
    }
  }

  /**
   * Schedule the next poll based on elapsed time and PhonePe schedule
   */
  private scheduleNextPoll(elapsedTime: number): void {
    if (!this.isPolling || !this.config) return;

    const interval = this.getCurrentInterval(elapsedTime);

    console.log(`[PhonePe Polling] Scheduling next poll in ${interval}ms`);

    this.timeoutId = setTimeout(() => {
      this.executePollingCycle();
    }, interval);
  }

  /**
   * Get current polling interval based on elapsed time
   */
  private getCurrentInterval(elapsedTime: number): number {
    let cumulativeTime = this.INITIAL_DELAY;

    for (const schedule of this.POLLING_SCHEDULE) {
      if (elapsedTime < cumulativeTime + schedule.duration) {
        return schedule.interval;
      }
      cumulativeTime += schedule.duration;
    }

    // Default to last interval (1 minute)
    return this.POLLING_SCHEDULE[this.POLLING_SCHEDULE.length - 1].interval;
  }

  /**
   * Check if status is terminal (polling should stop)
   */
  private isTerminalStatus(status: string): boolean {
    return ['COMPLETED', 'FAILED', 'EXPIRED'].includes(status);
  }

  /**
   * Make API call to check transaction status
   */
  private async checkTransactionStatus(merchantOrderId: string): Promise<{
    transactionStatus: 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
    details?: any;
  }> {
    // Use our Vercel serverless function to check PhonePe Order Status API
    const response = await fetch(`/api/check-payment-status?merchantOrderId=${encodeURIComponent(merchantOrderId)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    console.log('[PhonePe Polling] Status check response:', data);

    if (!data.success) {
      throw new Error(data.error || 'Failed to check transaction status');
    }

    // Extract status from response
    const transactionStatus = data.data?.transaction_status || data.transactionStatus || 'PENDING';

    return {
      transactionStatus: transactionStatus as 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED',
      details: data.data
    };
  }
}

// Singleton instance
export const phonePeStatusPoller = new PhonePeStatusPoller();

// Export types for use in components
export type { PollingConfig };