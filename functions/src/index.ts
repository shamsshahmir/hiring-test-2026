import * as admin from 'firebase-admin';

// Initialize Firebase Admin
admin.initializeApp();

// Export all Cloud Functions
export { handleStripeWebhook } from './stripe/webhook';
export { createCheckoutSession, purchaseAddon, initiateDowngrade, cancelPendingDowngrade, removeStaffMember } from './stripe/checkout';
