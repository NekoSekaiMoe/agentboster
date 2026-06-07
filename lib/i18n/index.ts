export const locales = [
  'en-US',
  'en-GB',
  'zh-CN',
  'zh-TW',
  'zh-HK',
  'ja',
  'ko',
] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en-US';

export const localeLabels: Record<Locale, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣）',
  'zh-HK': '繁體中文（香港）',
  ja: '日本語',
  ko: '한국어',
};

const enUS = {
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
  'chat.accessDenied.delete': 'Delete conversation',
  'chat.accessDenied.description':
    'This external user is not allowed to use this bot.',
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

const enGB = {
  ...enUS,
  'appearance.language.description':
    'Choose the language used by navigation, settings and shared controls.',
  'config.sections.appearance.description':
    'Customise navigation style and display preferences.',
  'config.sections.models.description':
    'Set default models, provider endpoints and token limits.',
} satisfies Record<keyof typeof enUS, string>;

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
  'chat.accessDenied.delete': '删除会话',
  'chat.accessDenied.description': '此外部用户无权使用此 bot。',
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
} satisfies Record<keyof typeof enUS, string>;

const zhTW = {
  'appearance.language.description':
    '選擇導覽、設定和通用控制項使用的介面語言。',
  'appearance.language.label': '介面語言',
  'appearance.language.title': '語言',
  'appearance.title': '外觀',
  'auth.signOutError': '登出失敗，請再試一次。',
  'chat.configManagement': '設定管理',
  'chat.delete.cancel': '取消',
  'chat.delete.confirm': '刪除',
  'chat.delete.description': '確定要刪除對話「{title}」嗎？此操作無法復原。',
  'chat.delete.title': '確認刪除',
  'chat.deleteError': '刪除失敗',
  'chat.deleteSuccess': '對話已刪除',
  'chat.accessDenied.delete': '刪除對話',
  'chat.accessDenied.description': '此外部使用者無權使用此 bot。',
  'chat.newChat': '新增對話',
  'chat.newConversation': '新對話',
  'chat.noConversations': '尚無對話',
  'chat.settings': '設定',
  'chat.theme': '主題',
  'chatHeader.abort': '停止',
  'chatHeader.abortError': '停止對話失敗',
  'chatHeader.abortSession': '停止對話',
  'chatHeader.abortSuccess': '對話已停止',
  'chatHeader.aborted': '已停止',
  'chatHeader.agentdOfflineTitle':
    'Agent Daemon 離線 - 正在使用 Vercel Sandbox',
  'chatHeader.agentdOnlineTitle': 'Agent Daemon 線上 - 已啟用完整安全審查',
  'chatHeader.channel': '通道',
  'chatHeader.done': '完成',
  'chatHeader.externalThread': '外部對話',
  'chatHeader.newChat': '新增對話',
  'chatHeader.running': '執行中',
  'chatHeader.startNew': '開始新的智能體對話。',
  'chatHeader.tokens': 'Tokens {value}',
  'chatHeader.untitledSession': '未命名對話',
  'chatHeader.waiting': '等待中',
  'common.language': '語言',
  'common.openNavigation': '開啟導覽',
  'config.runtime.description':
    '在缺少的環境變數完成設定前，部分伺服器功能將以降級狀態執行。',
  'config.runtime.missing': '缺少：{vars}',
  'config.runtime.title': '執行環境前置條件需要處理',
  'config.saveConfig': '儲存設定',
  'config.sections.agentd.description':
    '管理遠端 Agent Daemon 連線、憑證和沙箱設定。',
  'config.sections.agentd.title': 'Agent Daemon',
  'config.sections.agents.description': '設定命名智能體、提示詞和模型覆寫。',
  'config.sections.agents.title': '智能體',
  'config.sections.appearance.description': '自訂導覽樣式和顯示偏好。',
  'config.sections.appearance.title': '外觀',
  'config.sections.auditLogs.description': '檢視安全稽核記錄並匯出資料。',
  'config.sections.auditLogs.title': '稽核記錄',
  'config.sections.autonomy.description': '控制智能體自主等級和最大步數。',
  'config.sections.autonomy.title': '自主模式',
  'config.sections.channels.description':
    '設定 Slack、Teams、Google Chat 和 Telegram。',
  'config.sections.channels.title': '通道',
  'config.sections.mcp.description': '管理 MCP 遠端伺服器和驗證標頭。',
  'config.sections.mcp.title': 'MCP',
  'config.sections.models.description':
    '設定預設模型、Provider 端點和 Token 限制。',
  'config.sections.models.title': '模型',
  'config.sections.monitoring.description':
    '檢視 Agent Daemon 狀態、節點健康度和沙箱使用情況。',
  'config.sections.monitoring.title': '儀表板',
  'config.sections.tools.description': '開關內建工具並提供個別工具設定。',
  'config.sections.tools.title': '工具',
  'login.firstLoginHint': '如果是第一次登入，請留意日誌輸出的預設密碼。',
  'login.failed': '登入失敗。',
  'login.hidePassword': '隱藏密碼',
  'login.language': '語言',
  'login.networkError': '網路錯誤，請再試一次。',
  'login.password': '密碼',
  'login.showPassword': '顯示密碼',
  'login.submit': '登入',
  'login.submitting': '登入中...',
  'login.title': 'AgentBoster WebUI Login',
  'login.useDarkMode': '切換深色模式',
  'login.useLightMode': '切換淺色模式',
  'login.username': '使用者名稱',
  'login.welcome': '歡迎使用',
  'menu.appearance': '外觀',
  'menu.backToChat': '返回聊天',
  'menu.current': '目前',
  'menu.documentation': '文件',
  'menu.github': 'GitHub',
  'menu.settings': '設定',
  'menu.signingOut': '正在登出...',
  'menu.signOut': '登出',
  'nav.agentDaemon': 'Agent Daemon',
  'nav.agents': '智能體',
  'nav.alerts': '提醒',
  'nav.auditLogs': '稽核記錄',
  'nav.bot': 'Bot',
  'nav.channels': '通道',
  'nav.chat': '聊天',
  'nav.config': '設定',
  'nav.dashboard': '儀表板',
  'nav.files': '檔案',
  'nav.memory': '記憶',
  'nav.modelProviders': '模型 Provider',
  'nav.notifications': '通知',
  'nav.operations': '維運',
  'nav.schedule': '排程',
  'nav.skills': '技能',
  'nav.tasks': '任務',
  'nav.users': '使用者',
  'nav.workspace': '工作區',
  'theme.dark': '深色',
  'theme.light': '淺色',
  'theme.system': '跟隨系統',
} satisfies Record<keyof typeof enUS, string>;

const zhHK = {
  ...zhTW,
  'appearance.language.description':
    '選擇導覽、設定及通用控制項使用的介面語言。',
  'auth.signOutError': '登出失敗，請再試。',
  'chat.delete.description': '確定要刪除對話「{title}」嗎？此操作無法復原。',
  'chat.noConversations': '暫無對話',
  'chatHeader.agentdOnlineTitle': 'Agent Daemon 在線 - 已啟用完整安全審查',
  'common.openNavigation': '開啟導覽選單',
  'config.runtime.description':
    '在缺少的環境變數完成設定前，部分伺服器功能會以降級狀態執行。',
  'config.sections.auditLogs.description': '查看安全審計記錄並匯出資料。',
  'config.sections.auditLogs.title': '審計記錄',
  'login.networkError': '網絡錯誤，請再試。',
  'login.username': '用戶名稱',
  'menu.current': '目前',
  'nav.auditLogs': '審計記錄',
  'nav.operations': '運維',
  'theme.system': '跟隨系統',
} satisfies Record<keyof typeof enUS, string>;

const ja = {
  'appearance.language.description':
    'ナビゲーション、設定、共通コントロールで使用する表示言語を選択します。',
  'appearance.language.label': '表示言語',
  'appearance.language.title': '言語',
  'appearance.title': '外観',
  'auth.signOutError': 'サインアウトできませんでした。もう一度お試しください。',
  'chat.configManagement': '設定管理',
  'chat.delete.cancel': 'キャンセル',
  'chat.delete.confirm': '削除',
  'chat.delete.description':
    '会話「{title}」を削除しますか？この操作は元に戻せません。',
  'chat.delete.title': '削除の確認',
  'chat.deleteError': '削除に失敗しました',
  'chat.deleteSuccess': '会話を削除しました',
  'chat.accessDenied.delete': '会話を削除',
  'chat.accessDenied.description':
    'この外部ユーザーはこの bot を使用できません。',
  'chat.newChat': '新規チャット',
  'chat.newConversation': '新しい会話',
  'chat.noConversations': '会話はまだありません',
  'chat.settings': '設定',
  'chat.theme': 'テーマ',
  'chatHeader.abort': '中止',
  'chatHeader.abortError': 'セッションを中止できませんでした',
  'chatHeader.abortSession': 'セッションを中止',
  'chatHeader.abortSuccess': 'セッションを中止しました',
  'chatHeader.aborted': '中止済み',
  'chatHeader.agentdOfflineTitle':
    'Agent Daemon はオフラインです - Vercel Sandbox を使用しています',
  'chatHeader.agentdOnlineTitle':
    'Agent Daemon はオンラインです - 完全なセキュリティレビューが有効です',
  'chatHeader.channel': 'チャンネル',
  'chatHeader.done': '完了',
  'chatHeader.externalThread': '外部スレッド',
  'chatHeader.newChat': '新規チャット',
  'chatHeader.running': '実行中',
  'chatHeader.startNew': '新しいエージェント会話を開始します。',
  'chatHeader.tokens': 'Tokens {value}',
  'chatHeader.untitledSession': '無題のセッション',
  'chatHeader.waiting': '待機中',
  'common.language': '言語',
  'common.openNavigation': 'ナビゲーションを開く',
  'config.runtime.description':
    '不足している環境変数が設定されるまで、一部のサーバー機能は縮退状態で実行されます。',
  'config.runtime.missing': '不足: {vars}',
  'config.runtime.title': '実行時の前提条件を確認してください',
  'config.saveConfig': '設定を保存',
  'config.sections.agentd.description':
    'リモート Agent Daemon 接続、証明書、サンドボックス設定を管理します。',
  'config.sections.agentd.title': 'Agent Daemon',
  'config.sections.agents.description':
    '名前付きエージェント、プロンプト、モデルの上書きを設定します。',
  'config.sections.agents.title': 'エージェント',
  'config.sections.appearance.description':
    'ナビゲーションスタイルと表示設定をカスタマイズします。',
  'config.sections.appearance.title': '外観',
  'config.sections.auditLogs.description':
    'セキュリティ監査ログを確認し、データをエクスポートします。',
  'config.sections.auditLogs.title': '監査ログ',
  'config.sections.autonomy.description':
    'エージェントの自律レベルと最大ステップ数を制御します。',
  'config.sections.autonomy.title': '自律性',
  'config.sections.channels.description':
    'Slack、Teams、Google Chat、Telegram を設定します。',
  'config.sections.channels.title': 'チャンネル',
  'config.sections.mcp.description':
    'MCP リモートサーバーと認証ヘッダーを管理します。',
  'config.sections.mcp.title': 'MCP',
  'config.sections.models.description':
    '既定モデル、Provider エンドポイント、Token 制限を設定します。',
  'config.sections.models.title': 'モデル',
  'config.sections.monitoring.description':
    'Agent Daemon の状態、ノードの健全性、サンドボックス使用状況を確認します。',
  'config.sections.monitoring.title': 'ダッシュボード',
  'config.sections.tools.description':
    '組み込みツールの有効化とツール別設定を行います。',
  'config.sections.tools.title': 'ツール',
  'login.firstLoginHint':
    '初回ログインの場合は、ログに出力された既定パスワードを確認してください。',
  'login.failed': 'ログインに失敗しました。',
  'login.hidePassword': 'パスワードを隠す',
  'login.language': '言語',
  'login.networkError': 'ネットワークエラーです。もう一度お試しください。',
  'login.password': 'パスワード',
  'login.showPassword': 'パスワードを表示',
  'login.submit': 'サインイン',
  'login.submitting': 'サインイン中...',
  'login.title': 'AgentBoster WebUI Login',
  'login.useDarkMode': 'ダークモードを使用',
  'login.useLightMode': 'ライトモードを使用',
  'login.username': 'ユーザー名',
  'login.welcome': 'ようこそ',
  'menu.appearance': '外観',
  'menu.backToChat': 'チャットに戻る',
  'menu.current': '現在',
  'menu.documentation': 'ドキュメント',
  'menu.github': 'GitHub',
  'menu.settings': '設定',
  'menu.signingOut': 'サインアウト中...',
  'menu.signOut': 'サインアウト',
  'nav.agentDaemon': 'Agent Daemon',
  'nav.agents': 'エージェント',
  'nav.alerts': 'アラート',
  'nav.auditLogs': '監査ログ',
  'nav.bot': 'Bot',
  'nav.channels': 'チャンネル',
  'nav.chat': 'チャット',
  'nav.config': '設定',
  'nav.dashboard': 'ダッシュボード',
  'nav.files': 'ファイル',
  'nav.memory': 'メモリ',
  'nav.modelProviders': 'モデル Provider',
  'nav.notifications': '通知',
  'nav.operations': '運用',
  'nav.schedule': 'スケジュール',
  'nav.skills': 'スキル',
  'nav.tasks': 'タスク',
  'nav.users': 'ユーザー',
  'nav.workspace': 'ワークスペース',
  'theme.dark': 'ダーク',
  'theme.light': 'ライト',
  'theme.system': 'システム設定',
} satisfies Record<keyof typeof enUS, string>;

const ko = {
  'appearance.language.description':
    '내비게이션, 설정, 공통 컨트롤에 사용할 인터페이스 언어를 선택합니다.',
  'appearance.language.label': '인터페이스 언어',
  'appearance.language.title': '언어',
  'appearance.title': '외관',
  'auth.signOutError': '로그아웃하지 못했습니다. 다시 시도하세요.',
  'chat.configManagement': '설정 관리',
  'chat.delete.cancel': '취소',
  'chat.delete.confirm': '삭제',
  'chat.delete.description':
    '대화 "{title}"을(를) 삭제할까요? 이 작업은 되돌릴 수 없습니다.',
  'chat.delete.title': '삭제 확인',
  'chat.deleteError': '삭제 실패',
  'chat.deleteSuccess': '대화가 삭제되었습니다',
  'chat.accessDenied.delete': '대화 삭제',
  'chat.accessDenied.description':
    '이 외부 사용자는 이 bot을 사용할 권한이 없습니다.',
  'chat.newChat': '새 채팅',
  'chat.newConversation': '새 대화',
  'chat.noConversations': '아직 대화가 없습니다',
  'chat.settings': '설정',
  'chat.theme': '테마',
  'chatHeader.abort': '중지',
  'chatHeader.abortError': '세션을 중지하지 못했습니다',
  'chatHeader.abortSession': '세션 중지',
  'chatHeader.abortSuccess': '세션이 중지되었습니다',
  'chatHeader.aborted': '중지됨',
  'chatHeader.agentdOfflineTitle':
    'Agent Daemon 오프라인 - Vercel Sandbox를 사용 중입니다',
  'chatHeader.agentdOnlineTitle':
    'Agent Daemon 온라인 - 전체 보안 검토가 활성화되었습니다',
  'chatHeader.channel': '채널',
  'chatHeader.done': '완료',
  'chatHeader.externalThread': '외부 스레드',
  'chatHeader.newChat': '새 채팅',
  'chatHeader.running': '실행 중',
  'chatHeader.startNew': '새 에이전트 대화를 시작합니다.',
  'chatHeader.tokens': 'Tokens {value}',
  'chatHeader.untitledSession': '제목 없는 세션',
  'chatHeader.waiting': '대기 중',
  'common.language': '언어',
  'common.openNavigation': '내비게이션 열기',
  'config.runtime.description':
    '누락된 환경 변수가 설정될 때까지 일부 서버 기능은 제한된 상태로 실행됩니다.',
  'config.runtime.missing': '누락: {vars}',
  'config.runtime.title': '런타임 사전 조건을 확인해야 합니다',
  'config.saveConfig': '설정 저장',
  'config.sections.agentd.description':
    '원격 Agent Daemon 연결, 인증서, 샌드박스 설정을 관리합니다.',
  'config.sections.agentd.title': 'Agent Daemon',
  'config.sections.agents.description':
    '이름이 지정된 에이전트, 프롬프트, 모델 재정의를 설정합니다.',
  'config.sections.agents.title': '에이전트',
  'config.sections.appearance.description':
    '내비게이션 스타일과 표시 환경설정을 사용자화합니다.',
  'config.sections.appearance.title': '외관',
  'config.sections.auditLogs.description':
    '보안 감사 로그를 검토하고 데이터를 내보냅니다.',
  'config.sections.auditLogs.title': '감사 로그',
  'config.sections.autonomy.description':
    '에이전트 자율 수준과 최대 단계 수를 제어합니다.',
  'config.sections.autonomy.title': '자율성',
  'config.sections.channels.description':
    'Slack, Teams, Google Chat, Telegram을 설정합니다.',
  'config.sections.channels.title': '채널',
  'config.sections.mcp.description': 'MCP 원격 서버와 인증 헤더를 관리합니다.',
  'config.sections.mcp.title': 'MCP',
  'config.sections.models.description':
    '기본 모델, Provider 엔드포인트, Token 제한을 설정합니다.',
  'config.sections.models.title': '모델',
  'config.sections.monitoring.description':
    'Agent Daemon 상태, 노드 상태, 샌드박스 사용량을 확인합니다.',
  'config.sections.monitoring.title': '대시보드',
  'config.sections.tools.description':
    '내장 도구를 켜거나 끄고 도구별 설정을 제공합니다.',
  'config.sections.tools.title': '도구',
  'login.firstLoginHint':
    '처음 로그인하는 경우 로그에 출력된 기본 비밀번호를 확인하세요.',
  'login.failed': '로그인에 실패했습니다.',
  'login.hidePassword': '비밀번호 숨기기',
  'login.language': '언어',
  'login.networkError': '네트워크 오류입니다. 다시 시도하세요.',
  'login.password': '비밀번호',
  'login.showPassword': '비밀번호 표시',
  'login.submit': '로그인',
  'login.submitting': '로그인 중...',
  'login.title': 'AgentBoster WebUI Login',
  'login.useDarkMode': '다크 모드 사용',
  'login.useLightMode': '라이트 모드 사용',
  'login.username': '사용자 이름',
  'login.welcome': '환영합니다',
  'menu.appearance': '외관',
  'menu.backToChat': '채팅으로 돌아가기',
  'menu.current': '현재',
  'menu.documentation': '문서',
  'menu.github': 'GitHub',
  'menu.settings': '설정',
  'menu.signingOut': '로그아웃 중...',
  'menu.signOut': '로그아웃',
  'nav.agentDaemon': 'Agent Daemon',
  'nav.agents': '에이전트',
  'nav.alerts': '알림',
  'nav.auditLogs': '감사 로그',
  'nav.bot': 'Bot',
  'nav.channels': '채널',
  'nav.chat': '채팅',
  'nav.config': '설정',
  'nav.dashboard': '대시보드',
  'nav.files': '파일',
  'nav.memory': '메모리',
  'nav.modelProviders': '모델 Provider',
  'nav.notifications': '알림',
  'nav.operations': '운영',
  'nav.schedule': '일정',
  'nav.skills': '스킬',
  'nav.tasks': '작업',
  'nav.users': '사용자',
  'nav.workspace': '작업공간',
  'theme.dark': '다크',
  'theme.light': '라이트',
  'theme.system': '시스템',
} satisfies Record<keyof typeof enUS, string>;

export const translations = {
  'en-US': enUS,
  'en-GB': enGB,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  ja,
  ko,
} as const;

export type TranslationKey = keyof typeof enUS;

export type TranslationValues = Record<string, number | string>;

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) {
    return defaultLocale;
  }

  const normalized = value.toLowerCase().replaceAll('_', '-');

  if (normalized === 'en-gb' || normalized.startsWith('en-gb-')) {
    return 'en-GB';
  }

  if (
    normalized === 'en' ||
    normalized === 'en-us' ||
    normalized.startsWith('en-us-')
  ) {
    return 'en-US';
  }

  if (
    normalized === 'zh-hk' ||
    normalized.startsWith('zh-hk-') ||
    normalized.includes('-hk')
  ) {
    return 'zh-HK';
  }

  if (
    normalized === 'zh-tw' ||
    normalized.startsWith('zh-tw-') ||
    normalized === 'zh-hant' ||
    normalized.startsWith('zh-hant-') ||
    normalized.includes('-tw')
  ) {
    return 'zh-TW';
  }

  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized.startsWith('zh-cn-') ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-hans-') ||
    normalized.includes('-cn')
  ) {
    return 'zh-CN';
  }

  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return 'ja';
  }

  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return 'ko';
  }

  return defaultLocale;
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  values?: TranslationValues,
): string {
  const template =
    translations[locale][key] ?? translations[defaultLocale][key] ?? key;

  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = values[token];
    return value === undefined ? match : String(value);
  });
}
