import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Alert,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { useClinic } from '@/hooks/useClinic';
import { useSubscription } from '@/hooks/useSubscription';
import { getClinicMembers } from '@/services/firestore';
import { removeStaffMember } from '@/services/auth';
import { SeatUsageBar } from '@/components/SeatUsageBar';
import type { User } from '@/types/user';

export default function StaffScreen() {
  const { isOwner } = useAuth();
  const { clinic } = useClinic();
  const { seatsUsed, seatsMax, canAddStaff, isGracePeriod } = useSubscription();
  const [members, setMembers] = useState<User[]>([]);

  useEffect(() => {
    if (!clinic) return;
    getClinicMembers(clinic.id).then((all) =>
      setMembers(all.filter((u) => u.role === 'staff' || u.role === 'owner')),
    );
  }, [clinic?.id]);

  function handleInviteStaff() {
    if (!canAddStaff) {
      if (isGracePeriod) {
        Alert.alert('Billing issue', 'Your plan has a payment issue. Resolve billing before adding staff.');
      } else {
        Alert.alert('Seat limit reached', 'Upgrade your plan or purchase the Extra Seats add-on to add more staff.');
      }
      return;
    }
    // TODO [CHALLENGE]: Implement staff invitation.
    // Options: email invite link, direct email-based add, shareable clinic code.
    // Whatever you choose: the invite must create a user with role='staff' and clinicId set.
    // The server must check seat availability BEFORE creating the record (Firestore rules).
    // Document your approach in DECISIONS.md.
    Alert.alert('TODO', 'Implement staff invite flow (see StaffScreen TODO)');
  }

  function handleRemoveStaff(user: User) {
    Alert.alert(
      'Remove staff member',
      `Remove ${user.displayName} from the clinic? Their active session will also be invalidated.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            if (!clinic) return;
            try {
              await removeStaffMember(clinic.id, user.id);
              Alert.alert('Removed', `${user.displayName} has been removed and their session invalidated.`);
              // Refresh member list
              getClinicMembers(clinic.id).then((all) =>
                setMembers(all.filter((u) => u.role === 'staff' || u.role === 'owner')),
              );
            } catch (err: unknown) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to remove staff member');
            }
          },
        },
      ],
    );
  }

  function renderMember({ item }: { item: User }) {
    const isCurrentUserOwner = item.role === 'owner';
    return (
      <View style={styles.memberRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{item.displayName.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.memberInfo}>
          <Text style={styles.memberName}>{item.displayName}</Text>
          <Text style={styles.memberEmail}>{item.email}</Text>
        </View>
        <View style={styles.memberRight}>
          <View style={[styles.roleBadge, isCurrentUserOwner && styles.roleBadgeOwner]}>
            <Text style={[styles.roleText, isCurrentUserOwner && styles.roleTextOwner]}>
              {item.role}
            </Text>
          </View>
          {isOwner && !isCurrentUserOwner && (
            <TouchableOpacity onPress={() => handleRemoveStaff(item)}>
              <Text style={styles.removeButton}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SeatUsageBar used={seatsUsed} max={seatsMax} />
        {isOwner && (
          <TouchableOpacity
            style={[styles.inviteButton, !canAddStaff && styles.inviteButtonDisabled]}
            onPress={handleInviteStaff}
          >
            <Text style={styles.inviteText}>+ Invite staff</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={members}
        keyExtractor={(item) => item.id}
        renderItem={renderMember}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>No staff members yet.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    backgroundColor: '#fff',
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  inviteButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  inviteButtonDisabled: { backgroundColor: '#9ca3af' },
  inviteText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  list: { padding: 16, gap: 8 },
  memberRow: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#dbeafe',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: '#1e40af' },
  memberInfo: { flex: 1 },
  memberName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  memberEmail: { fontSize: 13, color: '#6b7280' },
  memberRight: { alignItems: 'flex-end', gap: 6 },
  roleBadge: {
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  roleBadgeOwner: { backgroundColor: '#fef3c7' },
  roleText: { fontSize: 11, fontWeight: '700', color: '#374151' },
  roleTextOwner: { color: '#92400e' },
  removeButton: { fontSize: 13, color: '#ef4444', fontWeight: '600' },
  empty: { fontSize: 14, color: '#9ca3af', textAlign: 'center', marginTop: 32 },
});
