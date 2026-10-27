import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import './globals.css';
import { FONT_SIZE_BOOTSTRAP } from '@/lib/font-size';
import { SKIN_BOOTSTRAP } from '@/lib/skin';

/** 设为 `0` / `false` 可跳过加载（如 e2e/无外网 环境） */
const reactGrabDisabled =
  process.env.NEXT_PUBLIC_REACT_GRAB === '0' || process.env.NEXT_PUBLIC_REACT_GRAB === 'false';
const loadReactGrab =
  process.env.NODE_ENV === 'development' && !reactGrabDisabled;

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content' };

export const metadata: Metadata = {
  title: 'Agent Home',
  description: 'Raw Agent SDK 全能力控制台'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: FONT_SIZE_BOOTSTRAP }} />
        <script dangerouslySetInnerHTML={{ __html: SKIN_BOOTSTRAP }} />
        {loadReactGrab ? (
          <Script
            src="https://unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        ) : null}
        <meta name="color-scheme" content="dark light" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const theme = localStorage.getItem('theme') ||
                  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                document.documentElement.setAttribute('data-theme', theme);
              })();
            `,
          }}
        />
      </head>
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
