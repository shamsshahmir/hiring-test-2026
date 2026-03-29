import { Timestamp } from '@react-native-firebase/firestore';
import type { AddonType } from './subscription';

export type Discount = {
  id: string;
  code: string;
  percentOff: number; // 0-100
  appliesToBase: boolean; // applies to base plan price
  appliesToAddons: AddonType[] | 'all'; // which add-on types this discount applies to
  validUntil: Timestamp;
  usageLimit: number;
  usedCount: number;
};

// Whether a discount is currently valid for new applications
export function isDiscountValid(discount: Discount): boolean {
  const now = new Date();
  const expiry = discount.validUntil.toDate();
  return expiry > now && discount.usedCount < discount.usageLimit;
}

/**
 * Returns whether a discount applies to a given item type.
 */
export function discountAppliesTo(
  discount: Discount,
  itemType: 'base' | AddonType,
): boolean {
  if (itemType === 'base') {
    return discount.appliesToBase;
  }
  // Add-on item
  if (discount.appliesToAddons === 'all') return true;
  return Array.isArray(discount.appliesToAddons) && discount.appliesToAddons.includes(itemType);
}

/**
 * Calculates the discounted price for a line item.
 * Returns the original price if the discount doesn't apply or is invalid.
 *
 * Rules:
 *   - Expired discounts (validUntil < now) are rejected for new purchases
 *   - appliesToBase: false → discount does NOT apply to base plan
 *   - appliesToAddons: 'all' → applies to all add-ons
 *   - appliesToAddons: AddonType[] → only applies to listed addon types
 *   - Existing subscribers who applied the discount when valid: honored until renewal
 *     (see DECISIONS.md)
 */
export function calculateDiscountedPrice(
  basePrice: number,
  itemType: 'base' | AddonType,
  discount: Discount,
): number {
  // Must be valid (not expired, within usage limit)
  if (!isDiscountValid(discount)) return basePrice;

  // Must apply to this item type
  if (!discountAppliesTo(discount, itemType)) return basePrice;

  // Apply percentage discount
  const discountAmount = basePrice * (discount.percentOff / 100);
  return Math.round((basePrice - discountAmount) * 100) / 100;
}
