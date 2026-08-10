import { enUS } from './en-US';
import { zhTW } from './zh-TW';

export const zhHK = {
  ...zhTW,
  'appearance.language.description':
    '選擇導覽、設定及通用控制項使用的介面語言。',
  'auth.signOutError': '登出失敗，請再試。',
  'chat.delete.description': '確定要刪除對話「{title}」嗎？此操作無法復原。',
  'chat.noConversations': '暫無對話',
  'chat.searchSessions': '搜尋會話…',
  'chat.noSearchResults': '沒有符合的會話',
  'chatHeader.agentdOnlineTitle': 'Agent Daemon 在線 - 已啟用完整安全審查',
  'common.openNavigation': '開啟導覽選單',
  'common.cancel': '取消',
  'config.runtime.description':
    '在缺少的環境變數完成設定前，部分伺服器功能會以降級狀態執行。',
  'config.sections.auditLogs.description': '查看安全審計記錄並匯出資料。',
  'config.sections.auditLogs.title': '審計記錄',
  'config.sections.users.description': '管理用戶、角色、對話、檔案和記憶。',
  'config.sections.users.title': '用戶',
  'login.networkError': '網絡錯誤，請再試。',
  'login.username': '用戶名稱',
  'menu.current': '目前',
  'nav.auditLogs': '審計記錄',
  'nav.operations': '運維',
  'theme.system': '跟隨系統',
  'workspace.label': '工作區',
  'workspace.switch': '切換工作區',
  'workspace.createNew': '新建工作區',
  'workspace.defaultName': '新工作區',
  'workspace.createSuccess': '工作區已建立',
  'workspace.createError': '建立工作區失敗',
  'workspace.defaultWorkspaceName': '預設工作區',
  'workspace.manage': '管理工作區',
  'workspace.archiveConfirmDescription':
    '「{name}」將被封存。其對話與記憶會保留，但不再接受新任務。此操作不可還原。',
  'workspace.detail.basicInfo': '基本資料',
  'workspace.detail.statusActive': '使用中',
  'workspace.detail.failoverHistory': '故障轉移紀錄',
  'workspace.detail.noFailovers': '暫無故障轉移紀錄',
} satisfies Record<keyof typeof enUS, string>;
