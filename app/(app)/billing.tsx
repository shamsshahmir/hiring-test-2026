import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, Linking, Modal, TextInput,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { useClinic } from '@/hooks/useClinic';
import { useSubscription } from '@/hooks/useSubscription';
import { getClinicAddons, getClinicDiscounts } from '@/services/firestore';
import { createCheckoutSession, initiateDowngrade, cancelPendingDowngrade, purchaseAddon } from '@/services/stripe';
import { PlanBadge } from '@/components/PlanBadge';
import { SeatUsageBar } from '@/components/SeatUsageBar';
import { DiscountTag } from '@/components/DiscountTag';
import { PLAN_CONFIG, ADDON_CONFIG } from '@/types/subscription';
import type { Plan, Addon } from '@/types/subscription';
import type { Discount } from '@/types/discount';

export default function BillingScreen() {
  const { isOwner } = useAuth();
  const { clinic } = useClinic();
  const { plan, status, config, seatsUsed, seatsMax, pendingDowngrade, gracePeriodEnd } = useSubscription();
  const [addons, setAddons] = useState<Addon[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [showDowngradePicker, setShowDowngradePicker] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [downgrading, setDowngrading] = useState(false);
  const [addonModal, setAddonModal] = useState<string | null>(null);
  const [discountInput, setDiscountInput] = useState('');
  const [upgradeDiscountInput, setUpgradeDiscountInput] = useState('');
  const [purchasingAddon, setPurchasingAddon] = useState(false);

  useEffect(() => {
    if (!clinic) return;
    getClinicAddons(clinic.id).then(setAddons);
    getClinicDiscounts(clinic.id).then(setDiscounts);
  }, [clinic?.id]);

  if (!isOwner) {
    return (
      <View style={styles.restricted}>
        <Text style={styles.restrictedText}>Billing is only visible to clinic owners.</Text>
      </View>
    );
  }

  const upgradePlans = (['pro', 'premium', 'vip'] as const).filter(
    (p) => PLAN_CONFIG[p].price > PLAN_CONFIG[plan].price,
  );

  async function handleSelectPlan(targetPlan: 'pro' | 'premium' | 'vip') {
    if (!clinic) return;
    setUpgrading(true);
    setShowPlanPicker(false);
    const code = upgradeDiscountInput.trim();
    try {
      const { url } = await createCheckoutSession({
        clinicId: clinic.id,
        plan: targetPlan,
        ...(code ? { discountCode: code } : {}),
      });
      if (url) {
        await Linking.openURL(url);
      }
    } catch (err: unknown) {
      Alert.alert('Upgrade failed', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setUpgrading(false);
    }
  }

  function handleUpgrade() {
    setUpgradeDiscountInput('');
    setShowPlanPicker(true);
  }

  const downgradePlans = (['free', 'pro', 'premium'] as const).filter(
    (p) => PLAN_CONFIG[p].price < PLAN_CONFIG[plan].price,
  );

  async function handleSelectDowngrade(targetPlan: 'free' | 'pro' | 'premium') {
    if (!clinic) return;
    setDowngrading(true);
    setShowDowngradePicker(false);
    try {
      const result = await initiateDowngrade({
        clinicId: clinic.id,
        targetPlan,
      });
      if (result.strategy === 'immediate') {
        Alert.alert('Downgraded', `Your plan has been downgraded to ${PLAN_CONFIG[targetPlan].label}.`);
      } else {
        Alert.alert(
          'Downgrade scheduled',
          `You have ${result.conflictingSeats} more staff than ${PLAN_CONFIG[targetPlan].label} allows (${PLAN_CONFIG[targetPlan].seats} seats). ` +
          `Your downgrade is scheduled for ${new Date(result.effectiveDate!).toLocaleDateString()}. ` +
          `Please deactivate excess staff before then.`,
        );
      }
    } catch (err: unknown) {
      Alert.alert('Downgrade failed', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setDowngrading(false);
    }
  }

  function handleDowngrade() {
    setShowDowngradePicker(true);
  }

  async function handleCancelDowngrade() {
    if (!clinic) return;
    Alert.alert(
      'Cancel downgrade?',
      'Your plan will remain unchanged.',
      [
        { text: 'Keep downgrade', style: 'cancel' },
        {
          text: 'Cancel downgrade',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelPendingDowngrade(clinic.id);
              Alert.alert('Cancelled', 'Pending downgrade has been cancelled.');
            } catch (err: unknown) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to cancel downgrade');
            }
          },
        },
      ],
    );
  }

  function handlePurchaseAddon(addonType: string) {
    setDiscountInput('');
    setAddonModal(addonType);
  }

  async function confirmAddonPurchase() {
    if (!clinic || !addonModal) return;
    const addonType = addonModal as 'extra_storage' | 'extra_seats' | 'advanced_analytics';
    setPurchasingAddon(true);
    setAddonModal(null);
    try {
      await purchaseAddon({
        clinicId: clinic.id,
        addonType,
        ...(discountInput.trim() ? { discountCode: discountInput.trim() } : {}),
      });
      Alert.alert('Success', `${ADDON_CONFIG[addonType].label} has been added.`);
      getClinicAddons(clinic.id).then(setAddons);
    } catch (err: unknown) {
      Alert.alert('Purchase failed', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setPurchasingAddon(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Current plan */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Current plan</Text>
        <View style={styles.planRow}>
          <PlanBadge plan={plan} />
          <Text style={styles.planPrice}>
            {config.price === 0 ? 'Free' : `CHF ${config.price}/mo`}
          </Text>
        </View>
        <Text style={styles.planStatus}>
          Status: <Text style={status === 'active' ? styles.active : styles.inactive}>{status}</Text>
        </Text>
        {pendingDowngrade && (
          <View style={styles.downgradeBanner}>
            <Text style={styles.downgradeText}>
              Downgrade to {PLAN_CONFIG[pendingDowngrade.targetPlan].label} scheduled for{' '}
              {pendingDowngrade.effectiveDate?.toDate?.()
                ? pendingDowngrade.effectiveDate.toDate().toLocaleDateString()
                : 'end of billing period'}.
              {'\n'}Please deactivate {pendingDowngrade.conflictingSeats} staff member(s) before then.
            </Text>
            <TouchableOpacity style={styles.cancelDowngradeBtn} onPress={handleCancelDowngrade}>
              <Text style={styles.cancelDowngradeText}>Cancel downgrade</Text>
            </TouchableOpacity>
          </View>
        )}
        {status === 'grace_period' && (
          <View style={styles.warningBanner}>
            <Text style={styles.warningText}>
              Payment failed. Your plan will revert to Free
              {gracePeriodEnd?.toDate
                ? ` on ${gracePeriodEnd.toDate().toLocaleDateString()}`
                : ' after the grace period ends'}.
              {'\n\n'}During this time, existing features remain available but no new staff can be added.
              Please update your payment method to keep your plan.
            </Text>
          </View>
        )}
      </View>

      {/* Seat usage */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Seats</Text>
        <SeatUsageBar used={seatsUsed} max={seatsMax} />
      </View>

      {/* Active add-ons */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active add-ons</Text>
        {addons.length === 0 ? (
          <Text style={styles.empty}>No active add-ons.</Text>
        ) : (
          addons.map((addon) => (
            <View key={addon.id} style={styles.addonRow}>
              <View>
                <Text style={styles.addonName}>{ADDON_CONFIG[addon.type].label}</Text>
                <Text style={styles.addonDesc}>{ADDON_CONFIG[addon.type].description}</Text>
              </View>
              <Text style={styles.addonPrice}>CHF {addon.price}/mo</Text>
            </View>
          ))
        )}

        {/* Available add-ons to purchase */}
        <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Available add-ons</Text>
        {Object.entries(ADDON_CONFIG).map(([type, meta]) => {
          const alreadyActive = addons.some((a) => a.type === type);
          if (alreadyActive) return null;
          if (plan === 'free') return null; // Add-ons require a paid plan
          return (
            <TouchableOpacity
              key={type}
              style={styles.addonCard}
              onPress={() => handlePurchaseAddon(type)}
            >
              <View>
                <Text style={styles.addonName}>{meta.label}</Text>
                <Text style={styles.addonDesc}>{meta.description}</Text>
              </View>
              <View style={styles.addonCardRight}>
                <Text style={styles.addonPrice}>CHF {meta.price}/mo</Text>
                <Text style={styles.addButton}>Add</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        {plan === 'free' && (
          <Text style={styles.empty}>Upgrade to a paid plan to add add-ons.</Text>
        )}
      </View>

      {/* Active discounts */}
      {discounts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active discounts</Text>
          {discounts.map((d) => (
            <DiscountTag key={d.id} discount={d} />
          ))}
          {/* Scenario 5: DiscountTag handles expired/active/exhausted states */}
        </View>
      )}

      {/* Upgrade CTA */}
      {plan !== 'vip' && (
        <TouchableOpacity
          style={[styles.upgradeButton, upgrading && { opacity: 0.5 }]}
          onPress={handleUpgrade}
          disabled={upgrading}
        >
          <Text style={styles.upgradeText}>
            {upgrading ? 'Processing...' : 'Upgrade plan'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Downgrade CTA */}
      {plan !== 'free' && !pendingDowngrade && (
        <TouchableOpacity
          style={[styles.downgradeButton, downgrading && { opacity: 0.5 }]}
          onPress={handleDowngrade}
          disabled={downgrading}
        >
          <Text style={styles.downgradeButtonText}>
            {downgrading ? 'Processing...' : 'Downgrade plan'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Downgrade plan picker modal */}
      <Modal visible={showDowngradePicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Downgrade to</Text>
            {downgradePlans.map((p) => (
              <TouchableOpacity
                key={p}
                style={styles.planOption}
                onPress={() => handleSelectDowngrade(p)}
              >
                <View>
                  <Text style={styles.planOptionName}>{PLAN_CONFIG[p].label}</Text>
                  <Text style={styles.planOptionSeats}>
                    {PLAN_CONFIG[p].seats === Infinity ? 'Unlimited' : PLAN_CONFIG[p].seats} seats
                  </Text>
                </View>
                <Text style={[styles.planOptionPrice, { color: '#ef4444' }]}>
                  {PLAN_CONFIG[p].price === 0 ? 'Free' : `CHF ${PLAN_CONFIG[p].price}/mo`}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setShowDowngradePicker(false)}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Add-on purchase modal */}
      <Modal visible={addonModal !== null} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              Add {addonModal ? ADDON_CONFIG[addonModal as keyof typeof ADDON_CONFIG]?.label : ''}
            </Text>
            <Text style={{ fontSize: 14, color: '#6b7280', marginBottom: 4 }}>
              CHF {addonModal ? ADDON_CONFIG[addonModal as keyof typeof ADDON_CONFIG]?.price : 0}/mo
            </Text>
            <TextInput
              style={styles.discountInput}
              placeholder="Discount code (optional)"
              placeholderTextColor="#9ca3af"
              value={discountInput}
              onChangeText={setDiscountInput}
              autoCapitalize="characters"
            />
            <TouchableOpacity
              style={[styles.upgradeButton, purchasingAddon && { opacity: 0.5 }]}
              onPress={confirmAddonPurchase}
              disabled={purchasingAddon}
            >
              <Text style={styles.upgradeText}>
                {purchasingAddon ? 'Processing...' : 'Confirm purchase'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setAddonModal(null)}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Plan picker modal */}
      <Modal visible={showPlanPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Choose a plan</Text>
            <TextInput
              style={styles.discountInput}
              placeholder="Discount code (optional)"
              placeholderTextColor="#9ca3af"
              value={upgradeDiscountInput}
              onChangeText={setUpgradeDiscountInput}
              autoCapitalize="characters"
            />
            {upgradePlans.map((p) => (
              <TouchableOpacity
                key={p}
                style={styles.planOption}
                onPress={() => handleSelectPlan(p)}
              >
                <View>
                  <Text style={styles.planOptionName}>{PLAN_CONFIG[p].label}</Text>
                  <Text style={styles.planOptionSeats}>
                    {PLAN_CONFIG[p].seats === Infinity ? 'Unlimited' : PLAN_CONFIG[p].seats} seats
                  </Text>
                </View>
                <Text style={styles.planOptionPrice}>CHF {PLAN_CONFIG[p].price}/mo</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setShowPlanPicker(false)}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, gap: 4, paddingBottom: 40 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    gap: 10,
  },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  planRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planPrice: { fontSize: 20, fontWeight: '700', color: '#111827' },
  planStatus: { fontSize: 14, color: '#6b7280' },
  active: { color: '#059669', fontWeight: '600' },
  inactive: { color: '#ef4444', fontWeight: '600' },
  warningBanner: {
    backgroundColor: '#fef3c7',
    borderRadius: 6,
    padding: 12,
  },
  warningText: { fontSize: 13, color: '#92400e' },
  addonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  addonCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    marginBottom: 8,
  },
  addonCardRight: { alignItems: 'flex-end', gap: 4 },
  addonName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  addonDesc: { fontSize: 12, color: '#6b7280', maxWidth: 200 },
  addonPrice: { fontSize: 14, fontWeight: '700', color: '#111827' },
  addButton: { fontSize: 13, color: '#3b82f6', fontWeight: '600' },
  empty: { fontSize: 14, color: '#9ca3af' },
  upgradeButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  upgradeText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  restricted: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  restrictedText: { fontSize: 16, color: '#6b7280', textAlign: 'center' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
    gap: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 4 },
  planOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
  },
  planOptionName: { fontSize: 16, fontWeight: '600', color: '#111827' },
  planOptionSeats: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  planOptionPrice: { fontSize: 16, fontWeight: '700', color: '#3b82f6' },
  cancelButton: { alignItems: 'center', padding: 14, marginTop: 4 },
  cancelText: { fontSize: 16, color: '#6b7280', fontWeight: '600' },
  downgradeBanner: {
    backgroundColor: '#fef3c7',
    borderRadius: 6,
    padding: 12,
  },
  downgradeText: { fontSize: 13, color: '#92400e', lineHeight: 18 },
  discountInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#f9fafb',
  },
  cancelDowngradeBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d97706',
  },
  cancelDowngradeText: { fontSize: 13, fontWeight: '600', color: '#d97706' },
  downgradeButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  downgradeButtonText: { color: '#ef4444', fontSize: 16, fontWeight: '700' },
});
