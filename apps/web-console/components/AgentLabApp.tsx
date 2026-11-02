'use client';

import { UserPreferenceSync } from './UserPreferenceSync';
import { useState } from 'react';
import type { AuthUser } from '@/lib/auth';
import { AuthGate } from './AuthGate';
import { LabProvider } from './shell/LabProvider';
import { LabShell } from './shell/LabShell';

/** 入口：鉴权 → 共享数据（LabProvider）→ 布局壳（Rail + 各 section） */
export function AgentLabApp() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  return (
    <AuthGate onUser={setAuthUser}>
      <LabProvider>
        <UserPreferenceSync key={authUser?.id ?? "local"} />
        <LabShell authUser={authUser} />
      </LabProvider>
    </AuthGate>
  );
}
