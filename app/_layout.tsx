// Polyfill WeakRef for Hermes (required by Zustand v5)
if (typeof globalThis.WeakRef === 'undefined') {
  // @ts-expect-error minimal polyfill
  globalThis.WeakRef = class WeakRef<T extends object> {
    private _target: T | undefined;
    constructor(target: T) {
      this._target = target;
    }
    deref(): T | undefined {
      return this._target;
    }
  };
}
if (typeof globalThis.FinalizationRegistry === 'undefined') {
  // @ts-expect-error minimal polyfill
  globalThis.FinalizationRegistry = class FinalizationRegistry {
    constructor() {}
    register() {}
    unregister() {}
  };
}

import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { initAuthListener, useAuthStore } from '@/store/authStore';
import { LoadingScreen } from '@/components/LoadingScreen';

export default function RootLayout() {
  const isLoading = useAuthStore((s) => s.isLoading);

  useEffect(() => {
    const unsubscribe = initAuthListener();
    return unsubscribe;
  }, []);

  if (isLoading) return <LoadingScreen />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
