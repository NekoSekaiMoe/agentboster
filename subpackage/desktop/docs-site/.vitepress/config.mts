import { defineConfig } from "vitepress";

const base = process.env.VITEPRESS_BASE ?? "/PiDeck/";

export default defineConfig({
  title: "PiDeck",
  description: "面向本地开发工作的 pi Agent 桌面工作台",
  lang: "zh-CN",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}icon.svg` }],
    ["meta", { property: "og:title", content: "PiDeck" }],
    ["meta", { property: "og:description", content: "在桌面端管理多个 pi 编码助手会话。" }],
    ["meta", { property: "og:type", content: "website" }],
  ],
  themeConfig: {
    logo: "/icon.svg",
    siteTitle: "PiDeck",
    nav: [
      { text: "首页", link: "/" },
      { text: "使用指南", link: "/guide/usage-guide" },
      { text: "功能", link: "/guide/features" },
      { text: "更新日志", link: "/changelog" },
      {
        text: "下载",
        link: "https://github.com/ayuayue/PiDeck/releases",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "使用指南",
          items: [
            { text: "完整使用指南（新手向）", link: "/guide/usage-guide" },
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "功能介绍", link: "/guide/features" },
            { text: "配置与 Skills", link: "/guide/settings" },
            { text: "开发与打包", link: "/guide/development" },
            { text: "贡献者", link: "/guide/contributors" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/ayuayue/PiDeck" },
    ],
    search: {
      provider: "local",
    },
    outline: {
      label: "本页目录",
      level: [2, 3],
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最近更新",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },
    editLink: {
      pattern: "https://github.com/ayuayue/PiDeck/edit/main/docs-site/:path",
      text: "在 GitHub 上编辑此页",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 ayuayue",
    },
  },
});
