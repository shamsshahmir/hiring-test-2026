import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Discount } from '@/types/discount';
import { isDiscountValid } from '@/types/discount';

type Props = {
  discount: Discount;
};

export function DiscountTag({ discount }: Props) {
  const valid = isDiscountValid(discount);
  const expiry = discount.validUntil.toDate();
  const expiryStr = expiry.toLocaleDateString('en-CH', { day: 'numeric', month: 'short', year: 'numeric' });
  const isExpired = expiry <= new Date();
  const isUsageExhausted = discount.usedCount >= discount.usageLimit;

  // Build applicability description
  const appliesTo: string[] = [];
  if (discount.appliesToBase) appliesTo.push('base plan');
  if (discount.appliesToAddons === 'all') {
    appliesTo.push('all add-ons');
  } else if (Array.isArray(discount.appliesToAddons) && discount.appliesToAddons.length > 0) {
    appliesTo.push(discount.appliesToAddons.join(', '));
  }
  const appliesToStr = appliesTo.length > 0 ? appliesTo.join(' + ') : 'nothing';

  return (
    <View style={[styles.tag, !valid && styles.tagExpired]}>
      <View style={styles.headerRow}>
        <Text style={[styles.code, !valid && styles.expired]}>{discount.code}</Text>
        {valid ? (
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>Active</Text>
          </View>
        ) : (
          <View style={styles.expiredBadge}>
            <Text style={styles.expiredBadgeText}>
              {isExpired ? 'Expired' : 'Exhausted'}
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.detail, !valid && styles.expired]}>
        {discount.percentOff}% off {appliesToStr}
      </Text>
      {valid && (
        <Text style={styles.validUntil}>
          Valid until {expiryStr} ({discount.usageLimit - discount.usedCount} uses remaining)
        </Text>
      )}
      {isExpired && (
        <Text style={styles.expiredLabel}>
          Expired on {expiryStr}. New purchases cannot use this code.
          {'\n'}Existing subscriptions with this discount are honored until renewal.
        </Text>
      )}
      {!isExpired && isUsageExhausted && (
        <Text style={styles.expiredLabel}>
          Usage limit reached ({discount.usedCount}/{discount.usageLimit}).
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    backgroundColor: '#d1fae5',
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  tagExpired: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  code: {
    fontSize: 14,
    fontWeight: '700',
    color: '#065f46',
  },
  detail: {
    fontSize: 12,
    color: '#047857',
  },
  validUntil: {
    fontSize: 11,
    color: '#059669',
    marginTop: 2,
  },
  expired: {
    color: '#9ca3af',
  },
  activeBadge: {
    backgroundColor: '#059669',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  activeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  expiredBadge: {
    backgroundColor: '#ef4444',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  expiredBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  expiredLabel: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 4,
    lineHeight: 16,
  },
});
