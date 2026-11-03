import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { ActivityRouterTracker } from './vendor/nga-activity/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MeetCallProvider } from './context/MeetCallContext';
import { NotificationProvider } from './context/NotificationContext';
import { MiniCall } from './components/meet/MiniCall';
import { ChatProvider } from './pages/chat/ChatProvider';
import { ChatDock } from './pages/chat/ChatDock';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NotificationBridge } from './context/NotificationBridge';
import { NotificationCenterProvider } from './context/NotificationCenterContext';
import { usePermissions } from './hooks/usePermissions';
import { SignIn } from './pages/SignIn';
import { SsoCallback } from './pages/SsoCallback';
import { PendingAccess } from './pages/PendingAccess';
import { Suspended } from './pages/Suspended';
import { NotFound } from './pages/NotFound';
import { AccessDenied } from './pages/AccessDenied';
import { MODULES, ADMIN } from './components/shell/navigation';
import { AppShell, ComingSoon } from './pages/AppShell';
import { FeedProvider } from './pages/feed/FeedProvider';
import { lazyNamed, registerPreload } from './lib/lazyPage';

/*
 * Every screen is its own chunk (P-01): the first visit downloads the shell and
 * the module the person lands on, not all of Tupo. The rail preloads the rest
 * on idle and on hover (see lib/lazyPage). The shell, the providers and the
 * chat dock stay in the main bundle: they are on every page.
 */
const Settings = lazyNamed(() => import('./pages/Settings'), 'Settings');
const ChatLayout = lazyNamed(() => import('./pages/chat/ChatLayout'), 'ChatLayout');
const ChatPermalink = lazyNamed(() => import('./pages/chat/ChatLinks'), 'ChatPermalink');
const ChatInvite = lazyNamed(() => import('./pages/chat/ChatLinks'), 'ChatInvite');
const ChannelsLayout = lazyNamed(() => import('./pages/channels/ChannelsLayout'), 'ChannelsLayout');
const MeetHome = lazyNamed(() => import('./pages/meet/MeetHome'), 'MeetHome');
const Scheduler = lazyNamed(() => import('./pages/meet/Scheduler'), 'Scheduler');
const MeetHistory = lazyNamed(() => import('./pages/meet/MeetHistory'), 'MeetHistory');
const MeetingRoom = lazyNamed(() => import('./pages/meet/MeetingRoom'), 'MeetingRoom');
const MeetingSummary = lazyNamed(() => import('./pages/meet/MeetingSummary'), 'MeetingSummary');
const GuestMeeting = lazyNamed(() => import('./pages/meet/GuestMeeting'), 'GuestMeeting');
const SystemStatus = lazyNamed(() => import('./pages/SystemStatus'), 'SystemStatus');
const RolesPermissions = lazyNamed(() => import('./pages/admin/RolesPermissions'), 'RolesPermissions');
const Users = lazyNamed(() => import('./pages/admin/Users'), 'Users');
const AuditLog = lazyNamed(() => import('./pages/admin/AuditLog'), 'AuditLog');
const Oversight = lazyNamed(() => import('./pages/admin/Oversight'), 'Oversight');
const Dashboard = lazyNamed(() => import('./pages/admin/Dashboard'), 'Dashboard');
const MailLayout = lazyNamed(() => import('./pages/mail/MailLayout'), 'MailLayout');
const MailTemplates = lazyNamed(() => import('./pages/mail/MailTemplates'), 'MailTemplates');
const MailLists = lazyNamed(() => import('./pages/mail/MailLists'), 'MailLists');
const MailCampaigns = lazyNamed(() => import('./pages/mail/MailCampaigns'), 'MailCampaigns');
const MailSettings = lazyNamed(() => import('./pages/mail/MailSettings'), 'MailSettings');
const FeedHome = lazyNamed(() => import('./pages/feed/FeedHome'), 'FeedHome');
const Reels = lazyNamed(() => import('./pages/feed/Reels'), 'Reels');
const PageProfile = lazyNamed(() => import('./pages/feed/PageScreens'), 'PageProfile');
const PageDirectory = lazyNamed(() => import('./pages/feed/PageScreens'), 'PageDirectory');
const PageInsights = lazyNamed(() => import('./pages/feed/PageScreens'), 'PageInsights');
const SavedPosts = lazyNamed(() => import('./pages/feed/Screens'), 'SavedPosts');
const PostPermalink = lazyNamed(() => import('./pages/feed/Screens'), 'PostPermalink');
const ModerationQueue = lazyNamed(() => import('./pages/feed/Screens'), 'ModerationQueue');

for (const [route, page] of [
  ['/app/feed', FeedHome], ['/app/chat', ChatLayout], ['/app/channels', ChannelsLayout],
  ['/app/meet', MeetHome], ['/app/mail', MailLayout], ['/app/settings', Settings],
  ['/app/admin/dashboard', Dashboard], ['/app/admin/users', Users], ['/app/admin/roles', RolesPermissions],
  ['/app/admin/audit', AuditLog], ['/app/admin/oversight', Oversight], ['/app/system', SystemStatus],
] as const) registerPreload(route, page.preload);

const FeedProviderLayout: React.FC = () => (
  <FeedProvider><Outlet /></FeedProvider>
);

/** An unknown address outside /app: the 404 for someone signed in, sign-in otherwise. */
const OutsideNotFound: React.FC = () => {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return null;
  return isAuthenticated ? <NotFound /> : <Navigate to="/" replace />;
};

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
const RequirePermission: React.FC<{ anyOf: string[]; children: React.ReactNode; area?: string }> = ({ anyOf, children, area }) => {
  const { can } = usePermissions();
  if (!can(anyOf)) return <AccessDenied area={area} />;
  return <>{children}</>;
};

/**
 * `/app` lands on the first module this person can actually open (F-07) —
 * not always the feed, which a role without FEED_VIEW could only be refused.
 */
const FirstModule: React.FC = () => {
  const { can } = usePermissions();
  const first = [...MODULES.filter((m) => m.to !== '/app/files'), ...ADMIN].find((m) => can(m.perm));
  return first ? <Navigate to={first.to} replace /> : <AccessDenied />;
};

/** The last line of defence: a failure above every screen still leaves a way back (F-06). */
const RootFallback: React.FC = () => (
  <div role="alert" className="grid min-h-screen place-items-center bg-surface-light p-6 text-center dark:bg-background-dark">
    <div className="max-w-sm">
      <h1 className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">Tupo hit a problem</h1>
      <p className="mt-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">Nothing you sent was lost. Reloading usually fixes it.</p>
      <button onClick={() => window.location.reload()} className="mt-4 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Reload Tupo</button>
    </div>
  </div>
);

export const App: React.FC = () => (
  <ErrorBoundary fallback={<RootFallback />}>
  <AuthProvider>
    <BrowserRouter>
      {/* Usage analytics: one page view per route change, on every route --
          the public sign-in and guest-meeting pages as well as /app/*. Here,
          not in AppShell, so those public routes are covered. */}
      <ActivityRouterTracker />
      {/* Notifications wrap the call, not the other way round: the call raises
          them, and the toast stack must outlive any route that triggered it. */}
      <NotificationProvider>
      <NotificationCenterProvider>
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
        {/* Public routes (sign-in, guest meeting) load lazily too; inside /app the
            shell holds its own boundary so the rail stays up while a module loads. */}
        <React.Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/sso/callback" element={<SsoCallback />} />
          <Route path="/suspended" element={<Suspended />} />
          {/* The one route a person with no NGA account can reach. */}
          <Route path="/meet/:idOrCode" element={<GuestMeeting />} />
          <Route path="/app" element={<Protected><AppShell /></Protected>}>
            <Route index element={<FirstModule />} />
            <Route path="chat" element={<ChatLayout />} />
            {/* Links produced by notifications, "copy link" and invites. */}
            <Route path="chat/invite/:code" element={<ChatInvite />} />
            <Route path="chat/:conversationId/:messageId?" element={<ChatPermalink />} />
            <Route path="channels" element={<ChannelsLayout />} />
            <Route path="feed" element={
              <RequirePermission anyOf={['FEED_VIEW']}><FeedProviderLayout /></RequirePermission>}>
              <Route index element={<FeedHome />} />
              <Route path="reels/:reelId?" element={<Reels />} />
              <Route path="saved" element={<SavedPosts />} />
              <Route path="pages" element={<PageDirectory />} />
              <Route path="pages/:id/insights" element={<PageInsights />} />
              <Route path="p/:slug" element={<PageProfile />} />
              <Route path="post/:id" element={<PostPermalink />} />
              <Route path="moderation" element={
                <RequirePermission anyOf={['MODERATION_QUEUE_VIEW']}><ModerationQueue /></RequirePermission>} />
            </Route>
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
            <Route path="mail/campaigns/:campaignId?" element={
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
            <Route path="admin/oversight" element={
              <RequirePermission anyOf={['OVERSIGHT_VIEW_ALL', 'OVERSIGHT_MESSAGE_DELETE']}><Oversight /></RequirePermission>} />
            <Route path="admin/dashboard" element={
              <RequirePermission anyOf={['DASHBOARD_VIEW']}><Dashboard /></RequirePermission>} />
            {/* Everyone's own profile and settings (F-10): no permission needed. */}
            <Route path="settings" element={<Settings />} />
            <Route path="system" element={
              <RequirePermission anyOf={['SYSTEM_HEALTH_VIEW']}><SystemStatus /></RequirePermission>} />
            {/* Anything else under /app: a real "not found", inside the shell. */}
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="*" element={<OutsideNotFound />} />
        </Routes>
        </React.Suspense>

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
          <NotificationBridge />
        </ErrorBoundary>

        {/* The launcher, on every page but chat itself and Meet. Inside the
            provider above, so it reads the same conversations and the same
            unread counts the chat page does. */}
        <ChatDock />
      </ChatProvider>
      </MeetCallProvider>
      </NotificationCenterProvider>
      </NotificationProvider>
    </BrowserRouter>
  </AuthProvider>
  </ErrorBoundary>
);
