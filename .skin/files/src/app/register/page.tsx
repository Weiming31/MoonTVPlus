/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { CheckCircle, Eye, EyeOff, Lock, Send, User } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { AuthShell } from '@/components/auth-skin/AuthShell';
import { VersionBadge } from '@/components/auth-skin/VersionBadge';
import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

function RegisterPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileLoaded, setTurnstileLoaded] = useState(false);
  const [siteConfig, setSiteConfig] = useState<any>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<string>('');
  const [registerSuccess, setRegisterSuccess] = useState(false);
  const [telegramBind, setTelegramBind] = useState<{ code: string; deepLink?: string } | null>(null);

  const { siteName } = useSite();

  // 在客户端挂载后设置配置
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const runtimeConfig = (window as any).RUNTIME_CONFIG;

      // 设置背景图（支持多张随机选择）—— 交给 AuthShell 当海报层
      const registerBg = runtimeConfig?.REGISTER_BACKGROUND_IMAGE;
      if (registerBg) {
        const urls = registerBg
          .split('\n')
          .map((url: string) => url.trim())
          .filter((url: string) => url !== '');

        if (urls.length > 0) {
          const randomIndex = Math.floor(Math.random() * urls.length);
          setBackgroundImage(urls[randomIndex]);
        }
      }

      // 设置站点配置
      const config = {
        EnableRegistration: runtimeConfig?.ENABLE_REGISTRATION || false,
        RequireRegistrationInviteCode: runtimeConfig?.REQUIRE_REGISTRATION_INVITE_CODE || false,
        RegistrationRequireTurnstile: runtimeConfig?.REGISTRATION_REQUIRE_TURNSTILE || false,
        TurnstileSiteKey: runtimeConfig?.TURNSTILE_SITE_KEY || '',
      };
      setSiteConfig(config);

      // 如果未开启注册，重定向到登录页
      if (!config.EnableRegistration) {
        router.replace('/login');
      }
    }
  }, [router]);

  // 加载Cloudflare Turnstile脚本
  useEffect(() => {
    if (!siteConfig?.RegistrationRequireTurnstile || !siteConfig?.TurnstileSiteKey) {
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      setTurnstileLoaded(true);
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, [siteConfig]);

  // 渲染Turnstile组件
  useEffect(() => {
    if (!turnstileLoaded || !siteConfig?.TurnstileSiteKey) {
      return;
    }

    const container = document.getElementById('turnstile-container');
    if (container && (window as any).turnstile) {
      const widgetId = (window as any).turnstile.render('#turnstile-container', {
        sitekey: siteConfig.TurnstileSiteKey,
        callback: (token: string) => {
          setTurnstileToken(token);
        },
      });
      setTurnstileWidgetId(widgetId);
    }
  }, [turnstileLoaded, siteConfig]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!username || !password || !confirmPassword) {
      setError('请填写所有字段');
      return;
    }

    if (siteConfig?.RequireRegistrationInviteCode && !inviteCode.trim()) {
      setError('请输入邀请码');
      return;
    }

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    if (password.length < 6) {
      setError('密码长度至少为6位');
      return;
    }

    // 检查Turnstile验证
    if (siteConfig?.RegistrationRequireTurnstile && !turnstileToken) {
      setError('请完成人机验证');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          inviteCode: siteConfig?.RequireRegistrationInviteCode ? inviteCode.trim() : undefined,
          turnstileToken: siteConfig?.RegistrationRequireTurnstile ? turnstileToken : undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.telegramBind?.code) {
          setTelegramBind({
            code: data.telegramBind.code,
            deepLink: data.telegramBind.deepLink || '',
          });
          setRegisterSuccess(true);
          return;
        }

        // 注册成功，跳转到登录页
        const redirect = searchParams.get('redirect') || '/login';
        router.replace(redirect);
      } else {
        // 注册失败，重置Turnstile
        if (siteConfig?.RegistrationRequireTurnstile && turnstileWidgetId !== null && (window as any).turnstile) {
          (window as any).turnstile.reset(turnstileWidgetId);
          setTurnstileToken(null);
        }

        if (res.status === 400) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || '注册失败');
        } else if (res.status === 409) {
          setError('用户名已存在');
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? '服务器错误');
        }
      }
    } catch (error) {
      // 网络错误，重置Turnstile
      if (siteConfig?.RegistrationRequireTurnstile && turnstileWidgetId !== null && (window as any).turnstile) {
        (window as any).turnstile.reset(turnstileWidgetId);
        setTurnstileToken(null);
      }
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // 如果配置未加载或未开启注册，显示加载中
  if (!siteConfig) {
    return (
      <AuthShell image={backgroundImage || undefined}>
        <div className='auth-card'>
          <div className='auth-brand'>
            <span className='auth-brand-dot' aria-hidden='true' />
            <span className='auth-brand-name'>{siteName}</span>
          </div>
          <p className='auth-sub' style={{ marginBottom: 0 }}>加载中…</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell image={backgroundImage || undefined}>
      <div className='auth-toolbar'>
        <ThemeToggle />
      </div>

      <div className='auth-card'>
        <div className='auth-brand'>
          <span className='auth-brand-dot' aria-hidden='true' />
          <span className='auth-brand-name'>{siteName}</span>
        </div>

        <h1 className='auth-title'>创建账号</h1>
        <p className='auth-sub'>填好这几项就能开播。</p>

        {registerSuccess ? (
          <>
            <div className='auth-note auth-note--ok' style={{ marginBottom: 14 }}>
              <div className='auth-note-title'>
                <CheckCircle />
                注册成功
              </div>
              <p style={{ margin: 0 }}>
                账号已创建。你可以现在绑定 Telegram，用于接收通知和后续快捷登录。
              </p>
            </div>

            {telegramBind && (
              <div className='auth-note auth-note--info' style={{ marginBottom: 14 }}>
                <div className='auth-note-title'>
                  <Send />
                  Telegram 绑定
                </div>
                <p style={{ margin: 0 }}>在 Bot 中发送：</p>
                <div className='auth-bind-code'>/bind {telegramBind.code}</div>
                {telegramBind.deepLink && (
                  <button
                    type='button'
                    onClick={() => window.open(telegramBind.deepLink, '_blank', 'noopener,noreferrer')}
                    className='auth-third-btn'
                    style={{ marginTop: 4 }}
                  >
                    打开 Telegram
                  </button>
                )}
                <p className='auth-note-foot'>绑定码 10 分钟内有效，也可稍后登录后在通知设置中重新生成。</p>
              </div>
            )}

            <button
              type='button'
              onClick={() => router.replace(searchParams.get('redirect') || '/login')}
              className='auth-submit'
            >
              前往登录
            </button>
          </>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <div className='auth-field'>
              <label htmlFor='username' className='auth-label'>
                用户名
              </label>
              <div className='auth-input-wrap'>
                <span className='auth-input-icon' aria-hidden='true'>
                  <User />
                </span>
                <input
                  id='username'
                  type='text'
                  autoComplete='username'
                  placeholder='输入用户名'
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>

            <div className='auth-field'>
              <label htmlFor='password' className='auth-label'>
                密码
              </label>
              <div className='auth-input-wrap has-eye'>
                <span className='auth-input-icon' aria-hidden='true'>
                  <Lock />
                </span>
                <input
                  id='password'
                  type={showPassword ? 'text' : 'password'}
                  autoComplete='new-password'
                  placeholder='输入密码（至少6位）'
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type='button'
                  className='auth-eye'
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </div>

            <div className='auth-field'>
              <label htmlFor='confirmPassword' className='auth-label'>
                确认密码
              </label>
              <div className='auth-input-wrap has-eye'>
                <span className='auth-input-icon' aria-hidden='true'>
                  <Lock />
                </span>
                <input
                  id='confirmPassword'
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete='new-password'
                  placeholder='再次输入密码'
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <button
                  type='button'
                  className='auth-eye'
                  aria-label={showConfirmPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </div>

            {siteConfig?.RequireRegistrationInviteCode && (
              <div className='auth-field'>
                <label htmlFor='inviteCode' className='auth-label'>
                  邀请码
                </label>
                <div className='auth-input-wrap'>
                  <span className='auth-input-icon' aria-hidden='true'>
                    <User />
                  </span>
                  <input
                    id='inviteCode'
                    type='text'
                    placeholder='输入邀请码'
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Cloudflare Turnstile */}
            {siteConfig?.RegistrationRequireTurnstile && siteConfig?.TurnstileSiteKey && (
              <div id='turnstile-container' className='auth-field' style={{ display: 'flex', justifyContent: 'center' }} />
            )}

            {error && <p className='auth-error'>{error}</p>}

            <button
              type='submit'
              disabled={
                !username || !password || !confirmPassword || loading ||
                (siteConfig?.RequireRegistrationInviteCode && !inviteCode.trim()) ||
                (siteConfig?.RegistrationRequireTurnstile && !turnstileToken)
              }
              className='auth-submit'
            >
              {loading ? '注册中...' : '创建账号'}
            </button>

            <p className='auth-alt'>
              已有账号？
              <button type='button' onClick={() => router.push('/login')}>
                返回登录
              </button>
            </p>
          </form>
        )}
      </div>

      <aside className='auth-hero' aria-hidden='true'>
        <h2>
          一个新的<em>位置</em>
          <br />
          留给接下来的片单
        </h2>
        <p>
          注册只是登记一下名字。之后你看到的每一条线路、每一次播放记录，都只留在
          <strong> {siteName} </strong>里。
        </p>
      </aside>

      <VersionBadge />
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <RegisterPageClient />
    </Suspense>
  );
}