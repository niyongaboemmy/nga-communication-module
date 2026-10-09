import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  ChevronUp, GripVertical, Maximize2, Mic, MicOff, MonitorUp, PhoneOff, Users,
  Video, VideoOff,
} from 'lucide-react';
import { Avatar } from '../ui';
import { useMeetCall } from '../../context/MeetCallContext';

/**
 * The floating call, shown while the user is somewhere else in Tupo.
 *
 * Design notes worth keeping:
 *
 *  - **It is a portal on `document.body`.** The app shell clips its panes, and
 *    a window that can be dragged anywhere must not be clipped by whichever
 *    page happens to be underneath it.
 *  - **Position is stored as a corner offset, not as x/y.** Anchoring to the
 *    nearest corner is what makes it survive a window resize: an absolute x of
 *    1400px is off-screen the moment someone narrows their browser.
 *  - **Pointer events, not mouse events.** Same code path handles a trackpad
 *    and a touchscreen, and pointer capture means a fast drag that leaves the
 *    element does not drop the window.
 *  - **It never renders its own `useMeetRoom`.** It reads the one call the
 *    provider owns, so mounting and unmounting it costs nothing and cannot
 *    interrupt the media.
 */

const MARGIN = 16;
/* Below md the shell shows a bottom tab bar (~64px incl. padding); a window
   docked to the bottom sits above it rather than over the tabs. */
const TAB_BAR_INSET = 72;
const bottomInset = () => (typeof window !== 'undefined' && window.innerWidth < 768 ? TAB_BAR_INSET : 0);
/* Fixed at 264 the window overhung a 320px phone once the 16px margins were
   counted. Measured against the viewport instead, so it is always the smaller
   of "the size we want" and "the size that fits". */
const PREFERRED_WIDTH = 264;
const MIN_WIDTH = 180;
const COLLAPSED_HEIGHT = 52;
const EXPANDED_HEIGHT = 196;
const STORAGE_KEY = 'tupo_minicall_position';

interface Corner { horizontal: 'left' | 'right'; vertical: 'top' | 'bottom'; dx: number; dy: number }

/** Bottom-right is the default: it is where every call app puts this. */
const DEFAULT_CORNER: Corner = { horizontal: 'right', vertical: 'bottom', dx: 0, dy: 0 };

function loadCorner(): Corner {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Corner | null;
    if (saved && 'horizontal' in saved && 'vertical' in saved) return saved;
  } catch { /* corrupt value; fall through to the default */ }
  return DEFAULT_CORNER;
}

export const MiniCall: React.FC = () => {
  const { call, room, shouldShowMini, endCall } = useMeetCall();
  const navigate = useNavigate();

  const [corner, setCorner] = useState<Corner>(loadCorner);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const nodeRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragOrigin = useRef<{ x: number; y: number; rect: DOMRect } | null>(null);

  /* Track the viewport so the window is re-fitted on rotate and on resize.
     A phone turned from portrait to landscape is the common case, and a window
     pinned to a corner that no longer exists is stranded off-screen. */
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const width = Math.max(MIN_WIDTH, Math.min(PREFERRED_WIDTH, viewport.width - MARGIN * 2));
  const height = collapsed ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT;

  /* ---- who to show ---- */

  // The presenter first — if someone is sharing, that is what you navigated
  // away from and still want to keep half an eye on. Otherwise the speaker.
  const featured = useMemo(() => {
    if (!room) return null;
    const byId = (id: string | null) => room.participants.find((p) => p.id === id) ?? null;
    return byId(room.presenterId)
      ?? byId(room.activeSpeakerId)
      ?? room.participants.find((p) => p.id !== room.you?.id)
      ?? room.you
      ?? null;
  }, [room]);

  const featuredMedia = featured ? room?.media.get(featured.id) : undefined;
  const isSelf = !!featured && featured.id === room?.you?.id;
  const featuredStream = featured?.id === room?.presenterId
    ? featuredMedia?.screenStream ?? featuredMedia?.stream ?? null
    : isSelf ? room?.localStream ?? null : featuredMedia?.stream ?? null;

  const showVideo = !collapsed && !!featuredStream &&
    (featured?.id === room?.presenterId || featured?.videoEnabled);

  /**
   * Attach on mount as well as on change.
   *
   * The video element only exists while the mini is on screen, which is *after*
   * the stream is already known — so an effect keyed on the stream alone runs
   * once with a null ref, bails, and never runs again. A callback ref binds the
   * moment the element appears, whenever that is.
   */
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (!el) return;
    el.srcObject = showVideo ? featuredStream : null;
    if (showVideo && featuredStream) void el.play().catch(() => {});
  }, [showVideo, featuredStream]);

  // And keep it in step when the featured participant changes underneath us.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const next = showVideo ? featuredStream : null;
    if (el.srcObject === next) return;
    el.srcObject = next;
    if (next) void el.play().catch(() => {});
  }, [featuredStream, showVideo]);

  /* ---- dragging ---- */

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // The title bar is the drag surface, but the controls sitting on it are
    // not: capturing the pointer for a drag swallows their click entirely, so
    // expand and collapse simply stopped working.
    if (target.closest('button')) return;
    if (!target.closest('[data-drag-handle]')) return;
    const node = nodeRef.current;
    if (!node) return;
    node.setPointerCapture(e.pointerId);
    dragOrigin.current = { x: e.clientX, y: e.clientY, rect: node.getBoundingClientRect() };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const origin = dragOrigin.current;
    const node = nodeRef.current;
    if (!origin || !node) return;

    const left = origin.rect.left + (e.clientX - origin.x);
    const top = origin.rect.top + (e.clientY - origin.y);
    // Applied directly during the drag: going through React state here would
    // put a re-render between the pointer and the pixels.
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const node = nodeRef.current;
    if (!dragOrigin.current || !node) return;
    node.releasePointerCapture(e.pointerId);
    dragOrigin.current = null;
    setDragging(false);

    // Snap to the nearest corner and store the offset from it, so the window
    // stays where the user put it even after the viewport changes size.
    const rect = node.getBoundingClientRect();
    const horizontal: Corner['horizontal'] =
      rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
    const vertical: Corner['vertical'] =
      rect.top + rect.height / 2 < window.innerHeight / 2 ? 'top' : 'bottom';

    const dx = Math.max(0, horizontal === 'left'
      ? rect.left - MARGIN
      : window.innerWidth - rect.right - MARGIN);
    const dy = Math.max(0, vertical === 'top'
      ? rect.top - MARGIN
      : window.innerHeight - rect.bottom - MARGIN - bottomInset());

    const next: Corner = { horizontal, vertical, dx, dy };
    setCorner(next);
    node.style.left = ''; node.style.top = ''; node.style.right = ''; node.style.bottom = '';
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }, []);

  if (!shouldShowMini || !call || !room) return null;

  const style: React.CSSProperties = {
    width,
    height,
    [corner.horizontal]: MARGIN + corner.dx,
    [corner.vertical]: MARGIN + corner.dy + (corner.vertical === 'bottom' ? bottomInset() : 0),
  };

  return createPortal(
    <div
      ref={nodeRef}
      role="complementary"
      aria-label={`${call.title} — meeting in progress`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={
        'tupo-glass tupo-sheen fixed z-90 flex flex-col overflow-hidden rounded-2xl ' +
        (dragging
          ? 'cursor-grabbing select-none'
          : 'animate-mini-in transition-[top,bottom,left,right] duration-200')
      }
    >
      {/* Title bar — also the drag handle */}
      <div
        data-drag-handle
        className="flex shrink-0 cursor-grab items-center gap-1.5 border-b border-white/10 px-2 py-1.5 active:cursor-grabbing"
      >
        <GripVertical size={13} className="shrink-0 text-white/30" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/90">
          {call.title}
        </span>
        {room.recording && (
          <span className="animate-rec-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-label="Recording" />
        )}
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-white/40">
          <Users size={10} />{room.participants.length}
        </span>
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand the mini window' : 'Collapse to a bar'}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white"
        >
          <ChevronUp size={12} className={collapsed ? '' : 'rotate-180'} />
        </button>
        <button
          onClick={() => navigate(`/app/meet/${call.meetingId}`)}
          aria-label="Return to the meeting"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white"
        >
          <Maximize2 size={11} />
        </button>
      </div>

      {!collapsed && (
        <button
          onClick={() => navigate(`/app/meet/${call.meetingId}`)}
          className="group relative min-h-0 flex-1 bg-slate-950"
          aria-label="Return to the meeting"
        >
          {showVideo ? (
            <video
              ref={attachVideo}
              autoPlay
              playsInline
              muted
              className={`h-full w-full ${
                // A shared screen is letterboxed, never cropped — cropping a
                // slide cuts off exactly the bit being pointed at.
                featured?.id === room.presenterId ? 'object-contain' : 'object-cover'
              } ${isSelf && featured?.id !== room.presenterId ? 'scale-x-[-1]' : ''}`}
            />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <Avatar name={featured?.name ?? call.title} src={featured?.avatarUrl ?? undefined} size={44} />
            </span>
          )}

          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
            {room.presenterId && (
              <MonitorUp size={10} className="shrink-0 text-blue-400" />
            )}
            <span className="truncate text-[10px] font-medium text-white">
              {room.presenterId ? `${room.presenterName} is presenting` : featured?.name}
            </span>
          </span>
        </button>
      )}

      {/* Controls stay available: the point is to keep taking part. */}
      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-white/10 px-2 py-1.5">
        <MiniButton
          label={room.micEnabled ? 'Mute' : 'Unmute'}
          danger={!room.micEnabled}
          onClick={room.toggleMic}
        >
          {room.micEnabled ? <Mic size={13} /> : <MicOff size={13} />}
        </MiniButton>
        <MiniButton
          label={room.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          danger={!room.cameraEnabled}
          onClick={room.toggleCamera}
        >
          {room.cameraEnabled ? <Video size={13} /> : <VideoOff size={13} />}
        </MiniButton>
        <MiniButton
          label={room.screenSharing ? 'Stop presenting' : 'Present'}
          active={room.screenSharing}
          onClick={() => void room.toggleScreenShare()}
        >
          <MonitorUp size={13} />
        </MiniButton>
        <MiniButton label="Leave the meeting" danger solid onClick={() => void endCall()}>
          <PhoneOff size={13} />
        </MiniButton>
      </div>
    </div>,
    document.body,
  );
};

const MiniButton: React.FC<{
  label: string; danger?: boolean; solid?: boolean; active?: boolean;
  onClick: () => void; children: React.ReactNode;
}> = ({ label, danger, solid, active, onClick, children }) => (
  <button
    onClick={onClick}
    title={label}
    aria-label={label}
    className={
      'grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors duration-150 ' +
      (solid && danger ? 'bg-red-600 text-white hover:bg-red-700'
        : danger ? 'bg-red-600/20 text-red-300 hover:bg-red-600/30'
        : active ? 'bg-blue-600 text-white hover:bg-blue-500'
        : 'text-white/70 hover:bg-white/10 hover:text-white')
    }
  >
    {children}
  </button>
);
