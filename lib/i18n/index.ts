export const locales = ['en', 'zh-CN'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export const localeLabels: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

const en = {
  'appearance.language.description':
    'Choose the language used by navigation, settings, and shared controls.',
  'appearance.language.label': 'Interface language',
  'appearance.language.title': 'Language',
  'appearance.title': 'Appearance',
  'auth.signOutError': 'Failed to sign out. Please try again.',
  'chat.configManagement': 'Configuration',
  'chat.delete.cancel': 'Cancel',
  'chat.delete.confirm': 'Delete',
  'chat.delete.description':
    'Delete conversation "{title}"? This action cannot be undone.',
  'chat.delete.title': 'Confirm delete',
  'chat.deleteError': 'Delete failed',
  'chat.deleteSuccess': 'Conversation deleted',
  'chat.newChat': 'New Chat',
  'chat.newConversation': 'New conversation',
  'chat.noConversations': 'No conversations yet',
  'chat.settings': 'Settings',
  'chat.theme': 'Theme',
  'chatHeader.abort': 'Abort',
  'chatHeader.abortError': 'Failed to abort session',
  'chatHeader.abortSession': 'Abort Session',
  'chatHeader.abortSuccess': 'Session aborted',
  'chatHeader.aborted': 'Aborted',
  'chatHeader.agentdOfflineTitle':
    'Agent Daemon offline - using Vercel Sandbox',
  'chatHeader.agentdOnlineTitle':
    'Agent Daemon online - full security review active',
  'chatHeader.channel': 'Channel',
  'chatHeader.done': 'Done',
  'chatHeader.externalThread': 'External Thread',
  'chatHeader.newChat': 'New Chat',
  'chatHeader.running': 'Running',
  'chatHeader.startNew': 'Start a new agent conversation.',
  'chatHeader.tokens': 'Tokens {value}',
  'chatHeader.untitledSession': 'Untitled Session',
  'chatHeader.waiting': 'Waiting',
  'common.language': 'Language',
  'common.openNavigation': 'Open navigation',
  'config.runtime.description':
    'Some server features will run in a degraded state until the missing environment variables are configured.',
  'config.runtime.missing': 'Missing: {vars}',
  'config.runtime.title': 'Runtime prerequisites need attention',
  'config.saveConfig': 'Save config',
  'config.sections.agentd.description':
    'Manage remote Agent Daemon connections, certificates, and sandbox settings.',
  'config.sections.agentd.title': 'Agent Daemon',
  'config.sections.agents.description':
    'Configure named agents, prompts, and model overrides.',
  'config.sections.agents.title': 'Agents',
  'config.sections.appearance.description':
    'Customize navigation style and display preferences.',
  'config.sections.appearance.title': 'Appearance',
  'config.sections.auditLogs.description':
    'Review security audit logs and export data.',
  'config.sections.auditLogs.title': 'Audit Logs',
  'config.sections.autonomy.description':
    'Control agent autonomy level and maximum steps.',
  'config.sections.autonomy.title': 'Autonomy',
  'config.sections.channels.description':
    'Set up Slack, Teams, Google Chat, and Telegram.',
  'config.sections.channels.title': 'Channels',
  'config.sections.mcp.description':
    'Manage MCP remote servers and authentication headers.',
  'config.sections.mcp.title': 'MCP',
  'config.sections.models.description':
    'Set default models, provider endpoints, and token limits.',
  'config.sections.models.title': 'Models',
  'config.sections.monitoring.description':
    'View Agent Daemon status, node health, and sandbox usage.',
  'config.sections.monitoring.title': 'Dashboard',
  'config.sections.tools.description':
    'Toggle built-in tools and provide per-tool config.',
  'config.sections.tools.title': 'Tools',
  'login.firstLoginHint':
    'For first login, check the logs for the default password.',
  'login.failed': 'Login failed.',
  'login.hidePassword': 'Hide password',
  'login.language': 'Language',
  'login.networkError': 'Network error. Please try again.',
  'login.password': 'Password',
  'login.showPassword': 'Show password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in...',
  'login.title': 'AgentBoster WebUI Login',
  'login.useDarkMode': 'Use dark mode',
  'login.useLightMode': 'Use light mode',
  'login.username': 'Username',
  'login.welcome': 'Welcome',
  'menu.appearance': 'Appearance',
  'menu.backToChat': 'Back to Chat',
  'menu.current': 'Current',
  'menu.documentation': 'Documentation',
  'menu.github': 'GitHub',
  'menu.settings': 'Settings',
  'menu.signingOut': 'Signing out...',
  'menu.signOut': 'Sign out',
  'nav.agentDaemon': 'Agent Daemon',
  'nav.agents': 'Agents',
  'nav.alerts': 'Alerts',
  'nav.auditLogs': 'Audit Logs',
  'nav.bot': 'Bot',
  'nav.channels': 'Channels',
  'nav.chat': 'Chat',
  'nav.config': 'Config',
  'nav.dashboard': 'Dashboard',
  'nav.files': 'Files',
  'nav.memory': 'Memory',
  'nav.modelProviders': 'Model Providers',
  'nav.notifications': 'Notifications',
  'nav.operations': 'Operations',
  'nav.schedule': 'Schedule',
  'nav.skills': 'Skills',
  'nav.tasks': 'Tasks',
  'nav.users': 'Users',
  'nav.workspace': 'Workspace',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'theme.system': 'System',
} as const;

const zhCN = {
  'appearance.language.description': '选择导航、设置和通用控件使用的界面语言。',
  'appearance.language.label': '界面语言',
  'appearance.language.title': '语言',
  'appearance.title': '外观',
  'auth.signOutError': '退出登录失败，请重试。',
  'chat.configManagement': '配置管理',
  'chat.delete.cancel': '取消',
  'chat.delete.confirm': '删除',
  'chat.delete.description': '确定要删除会话“{title}”吗？此操作无法撤销。',
  'chat.delete.title': '确认删除',
  'chat.deleteError': '删除失败',
  'chat.deleteSuccess': '会话已删除',
  'chat.newChat': '新建对话',
  'chat.newConversation': '新对话',
  'chat.noConversations': '暂无对话',
  'chat.settings': '设置',
  'chat.theme': '主题',
  'chatHeader.abort': '停止',
  'chatHeader.abortError': '停止会话失败',
  'chatHeader.abortSession': '停止会话',
  'chatHeader.abortSuccess': '会话已停止',
  'chatHeader.aborted': '已停止',
  'chatHeader.agentdOfflineTitle':
    'Agent Daemon 离线 - 正在使用 Vercel Sandbox',
  'chatHeader.agentdOnlineTitle': 'Agent Daemon 在线 - 已启用完整安全审查',
  'chatHeader.channel': '渠道',
  'chatHeader.done': '完成',
  'chatHeader.externalThread': '外部会话',
  'chatHeader.newChat': '新建对话',
  'chatHeader.running': '运行中',
  'chatHeader.startNew': '开始新的智能体对话。',
  'chatHeader.tokens': 'Tokens {value}',
  'chatHeader.untitledSession': '未命名会话',
  'chatHeader.waiting': '等待中',
  'common.language': '语言',
  'common.openNavigation': '打开导航',
  'config.runtime.description':
    '在配置缺失的环境变量之前，部分服务器功能会以降级状态运行。',
  'config.runtime.missing': '缺失：{vars}',
  'config.runtime.title': '运行时前置条件需要处理',
  'config.saveConfig': '保存配置',
  'config.sections.agentd.description':
    '管理远程 Agent Daemon 连接、证书和沙箱设置。',
  'config.sections.agentd.title': 'Agent Daemon',
  'config.sections.agents.description': '配置命名智能体、提示词和模型覆盖。',
  'config.sections.agents.title': '智能体',
  'config.sections.appearance.description': '自定义导航样式和显示偏好。',
  'config.sections.appearance.title': '外观',
  'config.sections.auditLogs.description': '查看安全审计日志并导出数据。',
  'config.sections.auditLogs.title': '审计日志',
  'config.sections.autonomy.description': '控制智能体自主级别和最大步数。',
  'config.sections.autonomy.title': '自主模式',
  'config.sections.channels.description':
    '设置 Slack、Teams、Google Chat 和 Telegram。',
  'config.sections.channels.title': '渠道',
  'config.sections.mcp.description': '管理 MCP 远程服务器和鉴权请求头。',
  'config.sections.mcp.title': 'MCP',
  'config.sections.models.description':
    '设置默认模型、Provider 端点和 Token 限制。',
  'config.sections.models.title': '模型',
  'config.sections.monitoring.description':
    '查看 Agent Daemon 状态、节点健康和沙箱使用情况。',
  'config.sections.monitoring.title': '仪表板',
  'config.sections.tools.description': '开关内置工具并提供单工具配置。',
  'config.sections.tools.title': '工具',
  'login.firstLoginHint': '如果是第一次登录，请留意日志输出的默认密码。',
  'login.failed': '登录失败。',
  'login.hidePassword': '隐藏密码',
  'login.language': '语言',
  'login.networkError': '网络错误，请重试。',
  'login.password': '密码',
  'login.showPassword': '显示密码',
  'login.submit': '登录',
  'login.submitting': '登录中...',
  'login.title': 'AgentBoster WebUI Login',
  'login.useDarkMode': '切换深色模式',
  'login.useLightMode': '切换浅色模式',
  'login.username': '用户名',
  'login.welcome': '欢迎使用',
  'menu.appearance': '外观',
  'menu.backToChat': '返回聊天',
  'menu.current': '当前',
  'menu.documentation': '文档',
  'menu.github': 'GitHub',
  'menu.settings': '设置',
  'menu.signingOut': '正在退出...',
  'menu.signOut': '退出登录',
  'nav.agentDaemon': 'Agent Daemon',
  'nav.agents': '智能体',
  'nav.alerts': '提醒',
  'nav.auditLogs': '审计日志',
  'nav.bot': 'Bot',
  'nav.channels': '渠道',
  'nav.chat': '聊天',
  'nav.config': '配置',
  'nav.dashboard': '仪表板',
  'nav.files': '文件',
  'nav.memory': '记忆',
  'nav.modelProviders': '模型 Provider',
  'nav.notifications': '通知',
  'nav.operations': '运维',
  'nav.schedule': '计划',
  'nav.skills': '技能',
  'nav.tasks': '任务',
  'nav.users': '用户',
  'nav.workspace': '工作区',
  'theme.dark': '深色',
  'theme.light': '浅色',
  'theme.system': '跟随系统',
} satisfies Record<keyof typeof en, string>;

export const translations = {
  en,
  'zh-CN': zhCN,
} as const;

export type TranslationKey = keyof typeof en;

export type TranslationValues = Record<string, number | string>;

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) {
    return defaultLocale;
  }

  const normalized = value.toLowerCase();

  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return 'zh-CN';
  }

  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en';
  }

  return defaultLocale;
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  values?: TranslationValues,
): string {
  const template = translations[locale][key] ?? translations.en[key] ?? key;

  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = values[token];
    return value === undefined ? match : String(value);
  });
}
