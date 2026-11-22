/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { Eye, EyeOff, Lock, Send, User } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { AuthShell } from '@/components/auth-skin/AuthShell';
import { VersionBadge } from '@/components/auth-skin/VersionBadge';
import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

// 根据按钮文本识别OIDC提供商并返回对应的图标（逻辑与官方一致，只改了尺寸类名）
function getOIDCProviderIcon(buttonText: string) {
  const text = buttonText.toLowerCase();

  const providers = [
    { keywords: ['linuxdo'], icon: '/icons/linuxdo.png', alt: 'LinuxDo' },
    { keywords: ['github'], icon: '/icons/github.png', alt: 'GitHub' },
    { keywords: ['google'], icon: '/icons/google.png', alt: 'Google' },
    { keywords: ['microsoft', 'azure', 'entra'], icon: '/icons/microsoft.png', alt: 'Microsoft' },
    { keywords: ['gitlab'], icon: '/icons/gitlab.png', alt: 'GitLab' },
  ];

  for (const provider of providers) {
    if (provider.keywords.some(keyword => text.includes(keyword))) {
      return <img src={provider.icon} alt={provider.alt} width={18} height={18} />;
    }
  }

  // 默认图标
  return (
    <svg fill='currentColor' viewBox='0 0 20 20' aria-hidden='true'>
      <path fillRule='evenodd' d='M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z' clipRule='evenodd' />
    </svg>
  );
}

function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shouldAskUsername, setShouldAskUsername] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileLoaded, setTurnstileLoaded] = useState(false);
  const [siteConfig, setSiteConfig] = useState<any>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<string>('');
  const [telegramLoginEnabled, setTelegramLoginEnabled] = useState(false);
  const [telegramLoginLoading, setTelegramLoginLoading] = useState(false);
  const [telegramLoginHint, setTelegramLoginHint] = useState<string | null>(null);

  const { siteName } = useSite();

  // 处理URL中的error参数
  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      setError(decodeURIComponent(errorParam));
    }
  }, [searchParams]);

  // 在客户端挂载后设置配置
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const runtimeConfig = (window as any).RUNTIME_CONFIG;
      const storageType = runtimeConfig?.STORAGE_TYPE;
      const shouldAsk = storageType && storageType !== 'localstorage';
      setShouldAskUsername(shouldAsk);

      // 设置背景图（支持多张随机选择）—— 交给 AuthShell 当海报层，视频再叠上去
      const loginBg = runtimeConfig?.LOGIN_BACKGROUND_IMAGE;
      if (loginBg) {
        const urls = loginBg
          .split('\n')
          .map((url: string) => url.trim())
          .filter((url: string) => url !== '');

        if (urls.length > 0) {
          const randomIndex = Math.floor(Math.random() * urls.length);
          setBackgroundImage(urls[randomIndex]);
        }
      }

      // 设置站点配置
      setSiteConfig({
        LoginRequireTurnstile: runtimeConfig?.LOGIN_REQUIRE_TURNSTILE || false,
        TurnstileSiteKey: runtimeConfig?.TURNSTILE_SITE_KEY || '',
        EnableRegistration: runtimeConfig?.ENABLE_REGISTRATION || false,
        EnableOIDCLogin: runtimeConfig?.ENABLE_OIDC_LOGIN || false,
        OIDCButtonText: runtimeConfig?.OIDC_BUTTON_TEXT || '',
      });
      setTelegramLoginEnabled(Boolean(runtimeConfig?.ENABLE_TELEGRAM_LOGIN));

      // 从localStorage读取记住的密码信息
      const rememberedCredentials = localStorage.getItem('rememberedCredentials');
      if (rememberedCredentials) {
        try {
          const credentials = JSON.parse(rememberedCredentials);
          if (credentials.password) {
            setPassword(credentials.password);
          }
          if (credentials.username && shouldAsk) {
            setUsername(credentials.username);
          }
          setRememberPassword(true);
        } catch (error) {
          // 清除无效的数据
          localStorage.removeItem('rememberedCredentials');
        }
      }
    }
  }, []);

  // 加载Cloudflare Turnstile脚本
  useEffect(() => {
    if (!siteConfig?.LoginRequireTurnstile || !siteConfig?.TurnstileSiteKey) {
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

    if (!password || (shouldAskUsername && !username)) return;

    // 检查Turnstile验证
    if (siteConfig?.LoginRequireTurnstile && !turnstileToken) {
      setError('请完成人机验证');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          ...(shouldAskUsername ? { username } : {}),
          ...(siteConfig?.LoginRequireTurnstile ? { turnstileToken } : {}),
        }),
      });

      if (res.ok) {
        // 处理记住密码逻辑
        if (rememberPassword) {
          const credentials: any = { password };
          // 如果需要用户名且有用户名，就保存用户名
          if (shouldAskUsername && username) {
            credentials.username = username;
          }
          localStorage.setItem('rememberedCredentials', JSON.stringify(credentials));
        } else {
          // 如果不记住密码，清除已存储的信息
          localStorage.removeItem('rememberedCredentials');
        }

        const redirect = searchParams.get('redirect') || '/';
        window.location.replace(redirect);
      } else {
        // 登录失败，重置Turnstile
        if (siteConfig?.LoginRequireTurnstile && turnstileWidgetId !== null && (window as any).turnstile) {
          (window as any).turnstile.reset(turnstileWidgetId);
          setTurnstileToken(null);
        }

        if (res.status === 401) {
          setError('密码错误');
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? '服务器错误');
        }
      }
    } catch (error) {
      // 网络错误，重置Turnstile
      if (siteConfig?.LoginRequireTurnstile && turnstileWidgetId !== null && (window as any).turnstile) {
        (window as any).turnstile.reset(turnstileWidgetId);
        setTurnstileToken(null);
      }
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const handleTelegramLogin = async () => {
    setError(null);
    setTelegramLoginHint(null);

    try {
      setTelegramLoginLoading(true);
      const createRes = await fetch('/api/telegram/login/create', { method: 'POST' });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        const configDetail = createData.config
          ? `（enabled=${String(createData.config.enabled)}, loginEnabled=${String(createData.config.loginEnabled)}, hasBotToken=${String(createData.config.hasBotToken)}, hasBotUsername=${String(createData.config.hasBotUsername)}, botUsername=${createData.config.botUsername || '-'}）`
          : `（HTTP ${createRes.status}）`;
        setError(`${createData.error || 'Telegram 登录接口不可用'}${configDetail}`);
        return;
      }

      setTelegramLoginHint('请在 Telegram 中确认登录');
      window.open(createData.deepLink, '_blank', 'noopener,noreferrer');

      const startedAt = Date.now();
      const timer = window.setInterval(async () => {
        if (Date.now() - startedAt > 5 * 60 * 1000) {
          window.clearInterval(timer);
          setTelegramLoginLoading(false);
          setTelegramLoginHint(null);
          setError('Telegram 登录已超时，请重试');
          return;
        }

        const statusRes = await fetch(`/api/telegram/login/status?token=${encodeURIComponent(createData.token)}`);
        const statusData = await statusRes.json().catch(() => ({}));
        if (statusData.status === 'confirmed') {
          window.clearInterval(timer);
          const redirect = searchParams.get('redirect') || '/';
          window.location.replace(redirect);
        } else if (statusData.status === 'denied') {
          window.clearInterval(timer);
          setTelegramLoginLoading(false);
          setTelegramLoginHint(null);
          setError('已拒绝 Telegram 登录');
        } else if (statusData.status === 'expired') {
          window.clearInterval(timer);
          setTelegramLoginLoading(false);
          setTelegramLoginHint(null);
          setError('Telegram 登录已过期');
        }
      }, 2000);
    } catch (error) {
      setError('Telegram 登录请求失败，请稍后重试');
      setTelegramLoginLoading(false);
      setTelegramLoginHint(null);
    }
  };

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

        <h1 className='auth-title'>登录</h1>
        <p className='auth-sub'>输入访问密码即可进入。</p>

        <form onSubmit={handleSubmit} noValidate>
          {shouldAskUsername && (
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
          )}

          <div className='auth-field'>
            <label htmlFor='password' className='auth-label'>
              访问密码
            </label>
            <div className='auth-input-wrap has-eye'>
              <span className='auth-input-icon' aria-hidden='true'>
                <Lock />
              </span>
              <input
                id='password'
                type={showPassword ? 'text' : 'password'}
                autoComplete='current-password'
                placeholder='输入访问密码'
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

          {/* Cloudflare Turnstile */}
          {siteConfig?.LoginRequireTurnstile && siteConfig?.TurnstileSiteKey && (
            <div id='turnstile-container' className='auth-field' style={{ display: 'flex', justifyContent: 'center' }} />
          )}

          {error && <p className='auth-error'>{error}</p>}

          <div className='auth-row'>
            <label className='auth-check' htmlFor='remember-password'>
              <input
                id='remember-password'
                type='checkbox'
                checked={rememberPassword}
                onChange={(e) => setRememberPassword(e.target.checked)}
              />
              <span>记住密码</span>
            </label>

            {siteConfig?.EnableRegistration && shouldAskUsername && (
              <button
                type='button'
                className='auth-alt-link'
                onClick={() => router.push('/register')}
              >
                立即注册
              </button>
            )}
          </div>

          <button
            type='submit'
            disabled={
              !password || loading || (shouldAskUsername && !username) ||
              (siteConfig?.LoginRequireTurnstile && !turnstileToken)
            }
            className='auth-submit'
          >
            {loading ? '登录中...' : '进入'}
          </button>
        </form>

        {/* 第三方登录区域 */}
        {shouldAskUsername && (telegramLoginEnabled || siteConfig?.EnableOIDCLogin) && (
          <>
            <div className='auth-divider'>
              <span>或</span>
            </div>
            <div className='auth-third'>
              {telegramLoginEnabled && (
                <button
                  type='button'
                  disabled={telegramLoginLoading}
                  onClick={handleTelegramLogin}
                  className='auth-third-btn'
                >
                  <Send />
                  {telegramLoginLoading ? '等待 Telegram 确认...' : '使用 Telegram 登录'}
                </button>
              )}
              {siteConfig?.EnableOIDCLogin && (
                <button
                  type='button'
                  onClick={() => window.location.href = '/api/auth/oidc/login'}
                  className='auth-third-btn'
                >
                  {getOIDCProviderIcon(siteConfig?.OIDCButtonText || '')}
                  {siteConfig?.OIDCButtonText || '使用 OIDC 登录'}
                </button>
              )}
            </div>
          </>
        )}

        {telegramLoginHint && <p className='auth-hint'>{telegramLoginHint}</p>}
      </div>

      {/* 右侧文案：桌面宽屏才显示，纯装饰 */}
      <aside className='auth-hero' aria-hidden='true'>
        <h2>
          把夜晚<em>留给屏幕</em>
          <br />
          把选择留给自己
        </h2>
        <p>
          <strong>{siteName}</strong>
          {' '}只是把这间放映室打开。选片、追剧、收藏，一切照旧 —— 只是今晚的界面安静一点。
        </p>
      </aside>

      <VersionBadge />
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LoginPageClient />
    </Suspense>
  );
}