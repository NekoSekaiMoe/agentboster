import { enUS } from './en-US';
import { zhTW } from './zh-TW';

export const zhHK = {
  ...zhTW,
  'appearance.language.description':
    '選擇導覽、設定及通用控制項使用的介面語言。',
  'auth.signOutError': '登出失敗，請再試。',
  'chat.noConversations': '暫無對話',
  'chatHeader.agentdOnlineTitle': 'Agent Daemon 在線 - 已啟用完整安全審查',
  'common.openNavigation': '開啟導覽選單',
  'config.runtime.description':
    '在缺少的環境變數完成設定前，部分伺服器功能會以降級狀態執行。',
  'config.sections.auditLogs.description': '查看安全審計記錄並匯出資料。',
  'config.sections.auditLogs.title': '審計記錄',
  'config.sections.users.description': '管理用戶、角色、對話、檔案和記憶。',
  'config.sections.users.title': '用戶',
  'login.networkError': '網絡錯誤，請再試。',
  'login.username': '用戶名稱',
  'nav.auditLogs': '審計記錄',
  'nav.operations': '運維',
  'workspace.archiveConfirmDescription':
    '「{name}」將被封存。其對話與記憶會保留，但不再接受新任務。此操作不可還原。',
  'workspace.detail.basicInfo': '基本資料',
  'workspace.detail.statusActive': '使用中',
  'workspace.detail.failoverHistory': '故障轉移紀錄',
  'workspace.detail.noFailovers': '暫無故障轉移紀錄',
  'skill.approval.importSkillRepo':
    '模型請求從 Git 倉庫匯入技能：{gitURL}，是否允許？',
  'skill.approval.importSkillFromClawHub':
    '模型請求從 ClawHub 匯入技能 {slug}（版本 {version}），是否允許？',
  'skill.approval.upsertSkill':
    '模型請求建立/更新技能檔案 {name}（含 {fileCount} 個檔案：{fileList}），是否允許？',
  'skill.approval.updateSkillFile':
    '模型請求修改技能檔案 {name}/{filePath}（新內容 {contentLength} 字符），是否允許？',
  'skill.approval.deleteSkill':
    '模型請求刪除技能 {name}（含其全部檔案與元數據），是否允許？',
  'skill.approval.timeout': '審批請求超過 {hours} 小時未回應，已按拒絕處理。',
  'cmd.goal.noGoal': '尚未設定目標。請使用 `/goal set <text>` 來定義一個。',
  'cmd.goal.statusGoal': '**目標：** {goal}',
  'cmd.goal.statusHidden': '隱藏的續跑次數：{count} / {max}',
  'cmd.goal.statusNonProgress': '連續相同的無進展次數：{count} / {max}',
  'cmd.goal.statusEval': '最近一次評估：{reason}',
  'cmd.goal.usageSet': '用法：/goal set <text>',
  'cmd.goal.setRunActive':
    '執行進行中無法設定目標。請等待其完成或先執行 `/stop`。',
  'cmd.goal.tooLong': '目標過長（{length} > {max} 字元）。',
  'cmd.goal.setOk':
    '目標已設定。代理將自主朝著該目標推進，直至達成或斷路器觸發。\n\n{text}',
  'cmd.goal.clearRunActive':
    '執行進行中無法清除目標。請等待其完成或先執行 `/stop`。',
  'cmd.goal.clearOk': '目標已清除。代理將不再自主推進。',
  'cmd.goal.usage': '用法：/goal set <text> | /goal clear | /goal',
} satisfies Record<keyof typeof enUS, string>;
