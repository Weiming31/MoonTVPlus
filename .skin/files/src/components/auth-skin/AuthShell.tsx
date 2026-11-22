/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { ReactNode, useEffect, useRef } from 'react';

import './auth-skin.css';

/**
 * 登录 / 注册页的"外壳"。
 *
 * 只负责两件事：
 *   1. 铺背景层（LQIP → 海报帧 → 视频，三层依次淡入，全部惰性加载）
 *   2. 提供 .auth-stage 这个居中的定位上下文，供 .auth-card / .auth-toolbar 用
 *
 * 不含任何业务逻辑，也不碰任何表单状态 —— 换掉这个组件，页面的登录注册功能
 * 完全不受影响。想关掉视频只留静态海报，传 video={false} 即可。
 */

const TIER_BREAKPOINT = 860;

// 资源路径全部相对 public/。要换图/换视频，直接覆盖 public/skin/ 下的同名文件。
const ASSET = {
  poster: {
    1440: '/icons/skin/login-bg-poster-1440.webp',
    640: '/icons/skin/login-bg-poster-640.webp',
  },
  video: {
    1440: { av1: '/icons/skin/login-bg-1440.av1.mp4', h264: '/icons/skin/login-bg-1440.h264.mp4' },
    640: { av1: '/icons/skin/login-bg-640.av1.mp4', h264: '/icons/skin/login-bg-640.h264.mp4' },
  },
} as const;

type Tier = keyof typeof ASSET.poster;

function currentTier(): Tier {
  const conn = (navigator as any).connection || {};
  const small = window.matchMedia(`(max-width: ${TIER_BREAKPOINT}px)`).matches;
  const slow = /2g|3g/.test(conn.effectiveType || '');
  return small || slow ? 640 : 1440;
}

export function AuthShell({
  children,
  video = true,
  image,
}: {
  children: ReactNode;
  video?: boolean;
  /**
   * 后台配置的静态背景图（LOGIN_BACKGROUND_IMAGE / REGISTER_BACKGROUND_IMAGE）。
   * 给了它就用它当海报层，视频照旧叠在上面 —— 官方的这张图配置因此不会失效。
   */
  image?: string;
}) {
  const bgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = bgRef.current;
    if (!box) return;

    const poster = box.querySelector<HTMLElement>('.auth-poster');
    const v = box.querySelector<HTMLVideoElement>('video');
    if (!poster || !v) return;

    let started = false;
    let disposed = false;
    let tier: Tier = currentTier();
    let queue: string[] = [];
    let qi = 0;

    const showPoster = () => poster.classList.add('ready');

    // 后台配了背景图就用它，否则用皮肤自带的海报帧
    const posterSrc = (t: Tier) => image || ASSET.poster[t];

    // ---- 第 2 层：海报帧。视频还没影的时候先把画面撑起来 ----
    const img = new Image();
    img.onload = () => {
      if (img.decode) img.decode().then(showPoster, showPoster);
      else showPoster();
    };
    img.onerror = showPoster;
    img.src = posterSrc(tier);
    // 兜底：图迟迟不动（弱网 / webp 不支持）也只让 LQIP 继续垫着
    const posterTimer = window.setTimeout(showPoster, 3000);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = Boolean((navigator as any).connection?.saveData);

    if (!video || reduceMotion || saveData) {
      v.remove();
      poster.classList.add('ready');
      return () => {
        window.clearTimeout(posterTimer);
        img.onload = null;
        img.onerror = null;
      };
    }

    // ---- 第 3 层：视频。逐级回退 ----
    const probe = document.createElement('video');
    const av1Ok = Boolean(
      probe.canPlayType('video/mp4; codecs="av01.0.08M.08"') ||
        probe.canPlayType('video/mp4; codecs="av01.0.04M.08"')
    );
    const h26Ok = Boolean(probe.canPlayType('video/mp4; codecs="avc1.640033"'));

    const sourcesFor = (t: Tier): string[] => {
      const list: string[] = [];
      if (av1Ok) list.push(ASSET.video[t].av1);
      if (h26Ok) list.push(ASSET.video[t].h264);
      if (!list.length) list.push(ASSET.video[t].h264);
      return list;
    };

    const tryNext = () => {
      if (disposed) return;
      if (qi >= queue.length) {
        showPoster();
        return;
      }
      const src = queue[qi++];
      while (v.firstChild) v.removeChild(v.firstChild);
      const s = document.createElement('source');
      s.src = src;
      // type 只写 "video/mp4"，不写 codecs=。
      // 写错（比如 codecs=av01 少了完整字符串）浏览器会直接拒收整个源，
      // video 进入 NETWORK_NO_SOURCE，一个字节都不会下 —— 这条踩过，别改回去。
      s.type = 'video/mp4';
      v.appendChild(s);
      v.load();
    };

    const pick = () => {
      tier = currentTier();
      poster.style.backgroundImage = `url("${posterSrc(tier)}")`;
      queue = sourcesFor(tier);
      qi = 0;
      tryNext();
    };

    // 不能用 {once:true}：视口跨断点换档时 v.load() 会重新触发 canplay，
    // once 只在第一次生效，换档后就再也没人调 play()，画面会停在第一帧。
    const onCanPlay = () => {
      v.classList.add('ready');
      const p = v.play();
      if (p && p.catch) p.catch(showPoster);
    };

    const onError = () => {
      if (v.classList.contains('ready')) {
        showPoster();
        return;
      }
      tryNext();
    };

    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('error', onError);

    // 空闲时才起播：不抢 LCP、字体、首屏 JS 的带宽与主线程
    const start = () => {
      if (started || disposed) return;
      started = true;
      pick();
    };
    const startTimer = window.setTimeout(start, 1200);
    const ric = (window as any).requestIdleCallback;
    const ricId = ric ? ric(start, { timeout: 2500 }) : 0;

    // 后台暂停，回前台续播（省电、省流量）
    const onVisibility = () => {
      if (document.hidden) {
        v.pause();
        return;
      }
      if (v.classList.contains('ready')) {
        const p = v.play();
        if (p && p.catch) p.catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 视口跨断点时换档（手机横竖屏切换）
    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (started && currentTier() !== tier && !document.hidden) pick();
      }, 700);
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.clearTimeout(posterTimer);
      window.clearTimeout(startTimer);
      window.clearTimeout(resizeTimer);
      if (ric && (window as any).cancelIdleCallback) (window as any).cancelIdleCallback(ricId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('error', onError);
      img.onload = null;
      img.onerror = null;
    };
  }, [video, image]);

  return (
    <div className='auth-stage'>
      <div className='auth-bg' ref={bgRef} aria-hidden='true'>
        <div className='auth-lqip' />
        <div className='auth-poster' />
        <video muted loop playsInline preload='none' disablePictureInPicture tabIndex={-1} />
      </div>
      {children}
    </div>
  );
}