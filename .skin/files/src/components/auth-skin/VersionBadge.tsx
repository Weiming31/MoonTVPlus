/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { AlertCircle, CheckCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { CURRENT_VERSION } from '@/lib/version';
import { checkForUpdates, UpdateStatus } from '@/lib/version_check';

/**
 * 底部版本号 + 更新状态。
 *
 * 逻辑与官方 login/page.tsx 里的 VersionDisplay 完全一致（同一套
 * checkForUpdates / UpdateStatus），只是把外观换成了皮肤样式。
 * 放在 auth-skin 目录里是为了两个页面共用一份，不要在页面内重复实现。
 */
export function VersionBadge() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const status = await checkForUpdates();
        setUpdateStatus(status);
      } catch (_) {
        // do nothing
      } finally {
        setIsChecking(false);
      }
    };

    checkUpdate();
  }, []);

  return (
    <button
      type='button'
      onClick={() =>
        window.open('https://github.com/mtvpls/MoonTVPlus', '_blank')
      }
      className='auth-version'
    >
      <span className='auth-version-num'>v{CURRENT_VERSION}</span>
      {!isChecking && updateStatus !== UpdateStatus.FETCH_FAILED && (
        <span
          className={`auth-version-state ${
            updateStatus === UpdateStatus.HAS_UPDATE
              ? 'is-warn'
              : updateStatus === UpdateStatus.NO_UPDATE
                ? 'is-ok'
                : ''
          }`}
        >
          {updateStatus === UpdateStatus.HAS_UPDATE && (
            <>
              <AlertCircle />
              <span>有新版本</span>
            </>
          )}
          {updateStatus === UpdateStatus.NO_UPDATE && (
            <>
              <CheckCircle />
              <span>已是最新</span>
            </>
          )}
        </span>
      )}
    </button>
  );
}