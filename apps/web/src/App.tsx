import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { usePermissions } from './hooks/usePermissions';
import { SignIn } from './pages/SignIn';
import { SsoCallback } from './pages/SsoCallback';
import { PendingAccess } from './pages/PendingAccess';
import { AppShell, ComingSoon } from './pages/AppShell';
import { ChatLayout } from './pages/chat/ChatLayout';
import { SystemStatus } from './pages/SystemStatus';
import { RolesPermissions } from './pages/admin/RolesPermissions';
import { Users } from './pages/admin/Users';
import { AuditLog } from './pages/admin/AuditLog';
import { EmptyState } from './components/ui';

/** Requires a Tupo session, which requires MIS sign-in. */
const Protected: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  const { hasRole } = usePermissions();
  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/" replace />;
  // Authenticated but no role assigned — no permissions, so no app.
  if (!hasRole) return <PendingAccess />;
  return <>{children}</>;
};

/**
 * Route-level permission gate. Purely cosmetic: the API independently
 * authorises every request, so this only spares the user a page of 403s.
 */
const RequirePermission: React.FC<{ anyOf: string[]; children: React.ReactNode }> = ({ anyOf, children }) => {
  const { can } = usePermissions();
  if (!can(anyOf)) {
    return (
      <EmptyState
        title="You do not have access to this area"
        hint={`Requires one of: ${anyOf.join(', ')}. Ask an administrator if you need it.`}
      />
    );
  }
  return <>{children}</>;
};

export const App: React.FC = () => (
  <AuthProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SignIn />} />
        <Route path="/sso/callback" element={<SsoCallback />} />
        <Route path="/app" element={<Protected><AppShell /></Protected>}>
          <Route index element={<Navigate to="/app/chat" replace />} />
          <Route path="chat" element={<ChatLayout />} />
          <Route path="feed" element={<ComingSoon module="Feed" phase="Phase 4" />} />
          <Route path="files" element={<ComingSoon module="Files" phase="Phase 2" />} />
          <Route path="meet" element={<ComingSoon module="Meet" phase="Phase 3" />} />
          <Route path="mail" element={<ComingSoon module="Mail" phase="Phase 4" />} />

          <Route path="admin/users" element={
            <RequirePermission anyOf={['USERS_VIEW', 'USERS_MANAGE']}><Users /></RequirePermission>} />
          <Route path="admin/roles" element={
            <RequirePermission anyOf={['ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE']}><RolesPermissions /></RequirePermission>} />
          <Route path="admin/audit" element={
            <RequirePermission anyOf={['AUDIT_VIEW']}><AuditLog /></RequirePermission>} />
          <Route path="system" element={
            <RequirePermission anyOf={['SYSTEM_HEALTH_VIEW']}><SystemStatus /></RequirePermission>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </AuthProvider>
);
