import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MeetCallProvider } from './context/MeetCallContext';
import { NotificationProvider } from './context/NotificationContext';
import { MiniCall } from './components/meet/MiniCall';
import { ChatProvider } from './pages/chat/ChatProvider';
import { ChatDock } from './pages/chat/ChatDock';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ChatNotificationBridge } from './context/ChatNotificationBridge';
import { usePermissions } from './hooks/usePermissions';
import { SignIn } from './pages/SignIn';
import { SsoCallback } from './pages/SsoCallback';
import { PendingAccess } from './pages/PendingAccess';
import { AppShell, ComingSoon } from './pages/AppShell';
import { ChatLayout } from './pages/chat/ChatLayout';
import { MeetHome } from './pages/meet/MeetHome';
import { Scheduler } from './pages/meet/Scheduler';
import { MeetHistory } from './pages/meet/MeetHistory';
import { MeetingRoom } from './pages/meet/MeetingRoom';
import { MeetingSummary } from './pages/meet/MeetingSummary';
import { GuestMeeting } from './pages/meet/GuestMeeting';
import { SystemStatus } from './pages/SystemStatus';
import { RolesPermissions } from './pages/admin/RolesPermissions';
import { Users } from './pages/admin/Users';
import { AuditLog } from './pages/admin/AuditLog';
import { MailLayout } from './pages/mail/MailLayout';
import { MailTemplates } from './pages/mail/MailTemplates';
import { MailLists } from './pages/mail/MailLists';
import { MailCampaigns } from './pages/mail/MailCampaigns';
import { MailSettings } from './pages/mail/MailSettings';
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
      {/* Notifications wrap the call, not the other way round: the call raises
          them, and the toast stack must outlive any route that triggered it. */}
      <NotificationProvider>
      {/*
        The active call lives ABOVE <Routes>. React Router unmounts a route
        component when you leave it, and unmounting the meeting would close the
        peer connections — so someone who nipped into Chat would come back to a
        dead room. Holding it here lets the call outlive the route, and gives
        the floating mini-call something to render.
      */}
      <MeetCallProvider>
      {/*
        Chat state lives here rather than inside /app/chat, because the dock
        renders on every other page and both must read the same store. Two
        providers would mean two conversation lists and two unread counts that
        disagree. Every effect inside is guarded on `user`, so mounting it over
        the sign-in route costs nothing.
      */}
      <ChatProvider>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/sso/callback" element={<SsoCallback />} />
          {/* The one route a person with no NGA account can reach. */}
          <Route path="/meet/:idOrCode" element={<GuestMeeting />} />
          <Route path="/app" element={<Protected><AppShell /></Protected>}>
            <Route index element={<Navigate to="/app/chat" replace />} />
            <Route path="chat" element={<ChatLayout />} />
            <Route path="feed" element={<ComingSoon module="Feed" phase="Phase 4" />} />
            <Route path="files" element={<ComingSoon module="Files" phase="Phase 2" />} />
          {/* Meet. The room is its own full-height screen inside the shell;
              `new` is declared before `:idOrCode` so it is not read as a code. */}
            <Route path="meet" element={
              <RequirePermission anyOf={['MEET_JOIN']}><MeetHome /></RequirePermission>} />
            <Route path="meet/new" element={
              <RequirePermission anyOf={['MEET_SCHEDULE']}><Scheduler /></RequirePermission>} />
            {/* Above `meet/:id`, or "history" is read as a meeting id. */}
            <Route path="meet/history" element={
              <RequirePermission anyOf={['MEET_JOIN']}><MeetHistory /></RequirePermission>} />
            <Route path="meet/:id/summary" element={
              <RequirePermission anyOf={['MEET_JOIN']}><MeetingSummary /></RequirePermission>} />
            <Route path="meet/:idOrCode" element={
              <RequirePermission anyOf={['MEET_JOIN']}><MeetingRoom /></RequirePermission>} />
            {/* Mail. `t/:threadId` renders the same layout so a thread is a
                linkable URL; campaigns/lists/templates are permission-gated
                sub-screens. */}
            <Route path="mail" element={
              <RequirePermission anyOf={['MAIL_READ']}><MailLayout /></RequirePermission>} />
            <Route path="mail/t/:threadId" element={
              <RequirePermission anyOf={['MAIL_READ']}><MailLayout /></RequirePermission>} />
            <Route path="mail/campaigns" element={
              <RequirePermission anyOf={['MAIL_BULK_SEND', 'MAIL_APPROVE']}><MailCampaigns /></RequirePermission>} />
            <Route path="mail/lists" element={
              <RequirePermission anyOf={['MAIL_LIST_MANAGE']}><MailLists /></RequirePermission>} />
            <Route path="mail/templates" element={
              <RequirePermission anyOf={['MAIL_TEMPLATE_MANAGE']}><MailTemplates /></RequirePermission>} />
            <Route path="mail/settings" element={
              <RequirePermission anyOf={['MAIL_READ']}><MailSettings /></RequirePermission>} />

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

        {/* Rendered outside <Routes> on purpose: it must survive every
            navigation, and it portals to document.body so no page can clip it.

            Behind a boundary with a null fallback: a floating call widget is
            decoration relative to the rest of the app, and it must never be
            able to take the sidebar and the conversation down with it. */}
        <ErrorBoundary fallback={null}>
          <MiniCall />
        </ErrorBoundary>

        {/* Above <Routes> so a message reaches you while you are in Meet, Mail,
            or anywhere else — a notification that only fires on the page it
            came from is not a notification. */}
        <ErrorBoundary fallback={null}>
          <ChatNotificationBridge />
        </ErrorBoundary>

        {/* The launcher, on every page but chat itself and Meet. Inside the
            provider above, so it reads the same conversations and the same
            unread counts the chat page does. */}
        <ChatDock />
      </ChatProvider>
      </MeetCallProvider>
      </NotificationProvider>
    </BrowserRouter>
  </AuthProvider>
);
