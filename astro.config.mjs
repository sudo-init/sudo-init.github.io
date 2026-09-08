// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://sudo-init.github.io',
  integrations: [sitemap()],
  // 발행 후 slug 를 바꾼 글. 예전 주소로 들어와도 새 주소로 보낸다.
  redirects: {
    '/posts/jekyll-to-astro/': '/posts/blog-restart/',
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      wrap: false,
    },
  },
});
